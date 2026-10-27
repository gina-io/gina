'use strict';
/**
 * #B989 — every HTML render delegate builds the request's session block (`page.data.session`), and
 * the three delegates that inject gina's client bootstrap after the render fill its session
 * placeholders in the bootstrap string only, never in the rest of the page.
 *
 * Up to 0.7.5 only the swig delegate (and its unreachable legacy twin, render-v1) built the block:
 * the async swig delegate and both nunjucks delegates never did, so their templates read no session
 * value and the bootstrap reached the browser with `{{ page.data.session.id }}` as written. Since
 * 0.7.6 the five delegates call `core/controller/render-session.js`.
 *
 *   §01  sessionBlock(req): when a request has a block, and what it holds
 *   §02  addSessionBlock(data, req): where the block goes (the swig delegate's rule, kept)
 *   §03  the three post-render delegates' injectAssets(), extracted and run: the bootstrap's
 *        session placeholders get the block's values (escaped as swig escapes them) or nothing,
 *        and nothing else in the page is touched
 *   §04  the five callers: source pins on the comment-stripped delegates, incl. the page-wide
 *        whisper() pass that no longer receives the session keys
 *   §05  the three combine delegates: the session line, the combine and the merge-back are
 *        EXTRACTED from the shipped source and run for an object without `page`, one with its own
 *        `page.data` and one with its own `session` member: the block reaches `page.data.session`,
 *        the action's own keys stay, and the action's object is not written; without the
 *        merge-back (the control that shows the arm can fail) the two objects with their own
 *        member drop the block
 *
 * The booted twin is test/integration/container-boot-render-session-b989.test.js.
 *
 * Seam: `B989_FW=<framework dir>` reads the delegates and the helper from another tree. Against a
 * pre-fix tree §01–§04 fail (no helper, no calls, no fill) and §05's block arms fail (no session
 * line), while its controls pass.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = process.env.B989_FW || require('../fw');
var CONTROLLER = path.join(FW, 'core', 'controller');
var merge      = require(path.join(FW, 'lib', 'merge', 'src', 'main.js'));
var renderData = require(path.join(CONTROLLER, 'render-data.js'));
var df         = require(path.join(FW, 'helpers', 'dateFormat'))();
// gina's `Date.prototype.format`, which the block's `expiresAt` uses (installed as gina's helpers do)
if (typeof(Date.prototype.format) != 'function') {
    require(path.join(FW, 'helpers', 'prototypes'))({ dateFormat: df });
}

var renderSession = null, loadError = null;
try {
    renderSession = require(path.join(CONTROLLER, 'render-session.js'));
} catch (e) {
    loadError = e;
}

/**
 * The helper module, asserted loaded.
 *
 * @inner
 * @returns {object} `core/controller/render-session`
 */
function helper() {
    assert.ok(renderSession, 'core/controller/render-session.js loads (' + (loadError && loadError.message) + ')');
    return renderSession;
}


// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

/**
 * The keywords after which an expression starts, so a `/` that follows one opens a regex literal.
 *
 * @constant
 * @type {Array<string>}
 */
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Whether a `/` met after the code read so far opens a regex literal.
 *
 * @inner
 * @param {string} out - the code read so far, comments dropped
 * @returns {boolean} true for a regex literal
 */
function regexMayStart(out) {
    var j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) { j--; }
    if (j < 0) { return true; }
    if ('(,=:[!&|?{};+-*%<>~^'.indexOf(out[j]) > -1) { return true; }
    if (!/[A-Za-z0-9_$]/.test(out[j])) { return false; }
    var k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) { k--; }
    return REGEX_KEYWORDS.indexOf(out.slice(k + 1, j + 1)) > -1;
}

/**
 * Drops `//` and `/* *\/` comments outside string, template and regex literals (copied from
 * test/core/render-data-copy-b988.test.js), so a comment naming a pinned expression cannot satisfy
 * a pin and a commented-out brace cannot unbalance an extraction.
 *
 * @inner
 * @param {string} text - the source
 * @returns {string} the source without its comments
 */
function stripComments(text) {
    var out = '', i = 0, n = text.length, quote = null;
    while (i < n) {
        var c = text[i], d = text[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === quote) { quote = null; }
            i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { var e = text.indexOf('\n', i); if (e < 0) { e = n; } i = e; continue; }
        if (c === '/' && d === '*') { var f = text.indexOf('*/', i + 2); assert.ok(f > -1, 'unterminated block comment'); i = f + 2; continue; }
        if (c === '/' && regexMayStart(out)) {
            var inClass = false;
            out += c; i++;
            while (i < n) {
                var r = text[i];
                assert.ok(r !== '\n', 'unterminated regex literal');
                out += r;
                if (r === '\\') { out += text[i + 1]; i += 2; continue; }
                i++;
                if (r === '[') { inClass = true; }
                else if (r === ']') { inClass = false; }
                else if (r === '/' && !inClass) { break; }
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The text from `start` to the brace that closes the first `{` met from there, string and regex
 * literals skipped (a quote or a brace inside `/[<>"']/g` is not code). Asserts `start` is unique
 * and the braces balance.
 *
 * @inner
 * @param {string} src - comment-stripped source
 * @param {string} start - the unique text the slice begins with
 * @param {string} label - for the assertion messages
 * @returns {{ text: string, at: number }} the slice and where it starts
 */
function braceSlice(src, start, label) {
    var at = src.indexOf(start);
    assert.ok(at > -1, label + ': `' + start + '` is in the source');
    assert.equal(src.indexOf(start, at + 1), -1, label + ': `' + start + '` is unique');
    var depth = 0, started = false, quote = null, i = at;
    for (; i < src.length; i++) {
        var c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) { quote = null; }
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '/' && regexMayStart(src.slice(Math.max(0, i - 64), i))) {
            var inClass = false;
            for (i++; i < src.length; i++) {
                var r = src[i];
                if (r === '\\') { i++; continue; }
                if (r === '[') { inClass = true; }
                else if (r === ']') { inClass = false; }
                else if (r === '/' && !inClass) { break; }
            }
            continue;
        }
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) { i++; break; }
        }
    }
    assert.ok(started && depth === 0, label + ': the slice from `' + start + '` balances');
    return { text: src.slice(at, i), at: at };
}

var DELEGATES = {
    swig          : 'controller.render-swig.js',
    v1            : 'controller.render-v1.js',
    swigAsync     : 'controller.render-swig-async.js',
    nunjucks      : 'controller.render-nunjucks.js',
    nunjucksAsync : 'controller.render-nunjucks-async.js'
};
/** The three delegates whose combine assigns an action's members in place of gina's. */
var COMBINE_DELEGATES = ['swigAsync', 'nunjucks', 'nunjucksAsync'];

var STRIPPED = {};
Object.keys(DELEGATES).forEach(function (k) {
    STRIPPED[k] = stripComments(fs.readFileSync(path.join(CONTROLLER, DELEGATES[k]), 'utf8'));
});
var HELPER_FILE = path.join(CONTROLLER, 'render-session.js');
var HELPER_ST   = fs.existsSync(HELPER_FILE) ? stripComments(fs.readFileSync(HELPER_FILE, 'utf8')) : '';

/** The require every delegate makes. */
var REQUIRE_RE   = /require\(\s*'\.\/render-session'\s*\)/g;
/** The swig delegate's call, right after `data = getData();`. */
var SWIG_CALL    = 'renderSession.addSessionBlock(data, req);';
/** render-v1's call, right after `data = getData();`. */
var V1_CALL      = 'renderSession.addSessionBlock(data, local.req);';
/** The combine delegates' call, which keeps the block for the merge-back. */
var SESSION_LINE = 'var sessionBlock = renderSession.addSessionBlock(data, req);';
/** The #B988 copy line every delegate runs before its combine. */
var COPY_LINE    = 'userData = renderData.copyForRender(userData, data);';
/** The combine block of the async and nunjucks delegates. */
var NJ_ANCHOR    = "if (userData && typeof(userData) === 'object') {";
/** The merge-back that follows it. */
var BACK_ANCHOR  = 'if (sessionBlock) {';
var BACK_BODY    = 'data = merge(data, { page: { data: { session: sessionBlock } } });';
/** The page-wide bootstrap substitution, and the session keys it no longer receives. */
var WHISPER_LINE = 'html = whisper(ginaLoaderDic, html, /\\{{ ([a-zA-Z.]+) \\}}/g);';
var SESSION_DIC  = "ginaLoaderDic['page.data.session.'";
/** The fill inside injectAssets(), on the bootstrap string. */
var LOADER_FILL  = 'ginaLoader = ginaLoader.replace(/\\{\\{ page\\.data\\.session\\.([a-zA-Z]+) \\}\\}/g, function (s, key) {';


// ---------------------------------------------------------------------------
// §01 — sessionBlock(req)
// ---------------------------------------------------------------------------

describe('#B989 §01 — sessionBlock(req): when a request has a block, and what it holds', function () {

    it('01.1  no request, no session, a null session, a session without a cookie, or a cookie without a Date expiry: no block', function () {
        var h = helper();
        assert.equal(h.sessionBlock(undefined), null, 'no request');
        assert.equal(h.sessionBlock({}), null, 'no session');
        assert.equal(h.sessionBlock({ session: null }), null, 'a null session');
        assert.equal(h.sessionBlock({ session: { id: 's' } }), null, 'a session without a cookie');
        assert.equal(h.sessionBlock({ session: { id: 's', cookie: { _expires: null } } }), null, 'a browser-session cookie (null expiry)');
        assert.equal(h.sessionBlock({ session: { id: 's', cookie: {} } }), null, 'an undefined expiry');
        assert.equal(h.sessionBlock({ session: { id: 's', cookie: { _expires: '2026-10-27T00:00:00.000Z' } } }), null, 'a string expiry');
    });

    it('01.2  a session cookie with an expiry and no lastModified: the timeout runs from now', function () {
        var h = helper();
        var expiry = new Date(Date.now() + 600000);
        var before = Date.now();
        var b = h.sessionBlock({ session: { id: 'sid-1', cookie: { _expires: expiry } } });
        var after = Date.now();
        assert.ok(b, 'a block');
        assert.deepEqual(Object.keys(b), ['id', 'lastModified', 'createdAt', 'expiresAt', 'timeout']);
        assert.equal(b.id, 'sid-1');
        assert.equal(b.lastModified, undefined);
        assert.equal(b.createdAt, undefined);
        assert.equal(b.expiresAt, df.format(expiry, 'isoDateTime'), 'expiresAt is the expiry, formatted isoDateTime');
        assert.ok(b.timeout <= expiry - before && b.timeout >= expiry - after, 'timeout = expiry - now (got ' + b.timeout + ')');
    });

    it('01.3  with lastModified and createdAt: both pass through, and the timeout runs from lastModified', function () {
        var h = helper();
        var expiry = new Date('2026-10-27T01:10:00.000Z');
        var lm = '2026-10-27T01:00:00.000Z';
        var b = h.sessionBlock({ session: { id: 'sid-2', lastModified: lm, createdAt: '2026-10-27T00:00:00.000Z', cookie: { _expires: expiry } } });
        assert.equal(b.lastModified, lm);
        assert.equal(b.createdAt, '2026-10-27T00:00:00.000Z');
        assert.equal(b.timeout, 600000, 'expiry - lastModified');
    });

    it('01.4  each call returns a new object', function () {
        var h = helper();
        var req = { session: { id: 'sid-3', cookie: { _expires: new Date(Date.now() + 1000) } } };
        assert.notEqual(h.sessionBlock(req), h.sessionBlock(req));
    });
});


// ---------------------------------------------------------------------------
// §02 — addSessionBlock(data, req)
// ---------------------------------------------------------------------------

describe('#B989 §02 — addSessionBlock(data, req): where the block goes (the swig delegate\'s rule)', function () {

    function session(id) { return { session: { id: id, cookie: { _expires: new Date(Date.now() + 600000) } } }; }

    it('02.1  no session: nothing changes and the answer is null', function () {
        var h = helper();
        var data = { page: { view: {} } };
        assert.equal(h.addSessionBlock(data, {}), null);
        assert.equal(h.addSessionBlock(data, undefined), null);
        assert.deepEqual(data, { page: { view: {} } });
    });

    it('02.2  a session without an expiry: page.data is created, no block', function () {
        var h = helper();
        var data = { page: { view: {} } };
        assert.equal(h.addSessionBlock(data, { session: { id: 's', cookie: { _expires: null } } }), null);
        assert.deepEqual(data, { page: { view: {}, data: {} } });
    });

    it('02.3  a session with an expiry: page.data.session holds the block, and the block is returned', function () {
        var h = helper();
        var data = { page: { view: {}, data: { title: 'T' } } };
        var b = h.addSessionBlock(data, session('sid-A'));
        assert.ok(b, 'the block is returned');
        assert.equal(b.id, 'sid-A');
        assert.deepEqual(data.page.data.session, b, 'page.data.session carries the block');
        assert.equal(data.page.data.title, 'T', 'the rest of page.data stays');
    });

    it('02.4  a page.data.session already in the data keeps its id and lastModified (none here) and gets createdAt, expiresAt and timeout', function () {
        var h = helper();
        var data = { page: { data: { session: { user: 'x' } } } };
        var b = h.addSessionBlock(data, session('sid-A'));
        assert.deepEqual(Object.keys(data.page.data.session), ['user', 'createdAt', 'expiresAt', 'timeout']);
        assert.equal(data.page.data.session.expiresAt, b.expiresAt);
    });
});


// ---------------------------------------------------------------------------
// §03 — the bootstrap fill inside injectAssets()
// ---------------------------------------------------------------------------

/**
 * A delegate's `injectAssets()`, extracted from its shipped source the way
 * test/lib/render-engine-dispatch.test.js extracts it (up to the first `}` at the start of a line)
 * and compiled on its own, so the fill it holds can use nothing from the module.
 *
 * @inner
 * @param {string} key - a COMBINE_DELEGATES key
 * @returns {function} `injectAssets(html, data, localOptions, cspNonce)`
 */
function extractInjectAssets(key) {
    var src = fs.readFileSync(path.join(CONTROLLER, DELEGATES[key]), 'utf8');
    var m = src.match(/function\s+injectAssets\s*\([^\)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, DELEGATES[key] + ': injectAssets() is in the source');
    return new Function(m[0] + '\nreturn injectAssets;')();
}

/** A bootstrap string shaped as gina.onload.min.js uses the placeholders. */
var LOADER = '<script type="text/javascript">var s={id:\'{{ page.data.session.id }}\',originalTimeout:\'{{ page.data.session.timeout }}\','
           + 'createdAt:\'{{ page.data.session.createdAt }}\',lastModified:\'{{ page.data.session.lastModified }}\'},'
           + 'w=\'{{ page.environment.webroot }}\';window.onGinaLoaded=1;</script>';
var PAGE   = '<html><head><title>t</title></head><body><p>{{ page.data.session.id }}</p></body></html>';

function pageData(session) {
    var d = { page: { view: { file: 'home' }, data: { title: 't' } } };
    if (session) { d.page.data.session = session; }
    return d;
}

describe('#B989 §03 — injectAssets() fills the bootstrap\'s session placeholders, and only there', function () {

    COMBINE_DELEGATES.forEach(function (k) {

        it('03.1  ' + DELEGATES[k] + ': the block\'s values in the bootstrap; app text and other placeholders untouched', function () {
            var injectAssets = extractInjectAssets(k);
            var out = injectAssets(PAGE, pageData({ id: 'sid-A', timeout: 599000, lastModified: '2026-10-27T01:00:00.000Z' }), { template: { ginaLoader: LOADER } });
            assert.ok(out.indexOf("var s={id:'sid-A',originalTimeout:'599000',createdAt:'',lastModified:'2026-10-27T01:00:00.000Z'}") > -1, 'the bootstrap holds the block (got: ' + out.slice(0, 400) + ')');
            assert.ok(out.indexOf("w='{{ page.environment.webroot }}'") > -1, 'an environment placeholder is left for the page-wide pass');
            assert.ok(out.indexOf('<p>{{ page.data.session.id }}</p>') > -1, 'text in the page is not touched');
            assert.equal(LOADER.indexOf('sid-A'), -1, 'CONTROL: the cached bootstrap string is not changed');
        });

        it('03.2  ' + DELEGATES[k] + ': no session block: every session placeholder of the bootstrap is filled with nothing', function () {
            var injectAssets = extractInjectAssets(k);
            var out = injectAssets(PAGE, pageData(null), { template: { ginaLoader: LOADER } });
            assert.ok(out.indexOf("var s={id:'',originalTimeout:'',createdAt:'',lastModified:''}") > -1, 'empty values (got: ' + out.slice(0, 400) + ')');
            assert.ok(out.indexOf('<p>{{ page.data.session.id }}</p>') > -1, 'text in the page is not touched');
        });

        it('03.3  ' + DELEGATES[k] + ': a string value is escaped as swig\'s autoescape escapes it, a number is written as is', function () {
            var injectAssets = extractInjectAssets(k);
            var out = injectAssets(PAGE, pageData({ id: 'a\'b"c<d>&e&amp;', timeout: 0 }), { template: { ginaLoader: LOADER } });
            assert.ok(out.indexOf("id:'a&#39;b&quot;c&lt;d&gt;&amp;e&amp;'") > -1, 'escaped (got: ' + out.slice(0, 400) + ')');
            assert.ok(out.indexOf("originalTimeout:'0'") > -1, 'a falsy number is written');
        });
    });
});


// ---------------------------------------------------------------------------
// §04 — the five callers
// ---------------------------------------------------------------------------

describe('#B989 §04 — the five delegates call render-session.js, and the block lives there only', function () {

    Object.keys(DELEGATES).forEach(function (k) {
        it('04.1  ' + DELEGATES[k] + ': one require of ./render-session', function () {
            assert.equal((STRIPPED[k].match(REQUIRE_RE) || []).length, 1);
        });
    });

    it('04.2  render-swig.js and render-v1.js: the call follows `data = getData();` with nothing between', function () {
        [['swig', SWIG_CALL], ['v1', V1_CALL]].forEach(function (p) {
            var st = STRIPPED[p[0]];
            assert.equal(count(st, p[1]), 1, p[0] + ': one call');
            assert.ok(/data = getData\(\);\s*renderSession\.addSessionBlock\(data, (local\.)?req\);/.test(st), p[0] + ': right after data = getData();');
        });
    });

    COMBINE_DELEGATES.forEach(function (k) {
        it('04.3  ' + DELEGATES[k] + ': the session line comes before the copy, the merge-back after the combine, the fill in injectAssets(), none page-wide', function () {
            var st = STRIPPED[k];
            assert.equal(count(st, SESSION_LINE), 1, 'one session line');
            var sAt = st.indexOf(SESSION_LINE), cAt = st.indexOf(COPY_LINE);
            assert.ok(cAt > -1 && sAt > -1 && sAt < cAt, 'the block is built before copyForRender() aligns the action\'s object with it');
            var combine = braceSlice(st, NJ_ANCHOR, k), back = braceSlice(st, BACK_ANCHOR, k);
            assert.ok(back.at > combine.at + combine.text.length, 'the merge-back follows the combine block');
            assert.ok(back.text.indexOf(BACK_BODY) > -1, 'the merge-back merges the block into page.data.session');
            assert.equal(count(st, WHISPER_LINE), 1, 'one page-wide whisper() pass');
            assert.equal(count(st, SESSION_DIC), 0, 'the page-wide pass is not given the session keys');
            var inject = braceSlice(st, 'function injectAssets(', k);
            assert.equal(count(inject.text, LOADER_FILL), 1, 'injectAssets() fills the session placeholders of the bootstrap string');
        });
    });

    it('04.4  the `_expires instanceof Date` guard is in render-session.js and in none of the five delegates', function () {
        assert.ok(/req\.session\.cookie\._expires\s+instanceof\s+Date/.test(HELPER_ST), 'the guard is in the helper');
        Object.keys(DELEGATES).forEach(function (k) {
            assert.equal(/_expires\s+instanceof\s+Date/.test(STRIPPED[k]), false, DELEGATES[k] + ' keeps no copy of the block');
        });
    });

    it('04.5  the helper stays out of the browser bundle', function () {
        var build = fs.readFileSync(path.join(FW, 'core', 'asset', 'plugin', 'src', 'vendor', 'gina', 'build.json'), 'utf8');
        assert.ok(build.indexOf('"name"') > -1, 'CONTROL: build.json is the bundle manifest');
        assert.equal(build.indexOf('render-session'), -1);
    });
});


// ---------------------------------------------------------------------------
// §05 — the three combine delegates, run
// ---------------------------------------------------------------------------

/**
 * A delegate's session line, copy line, combine block and merge-back, from its shipped source,
 * compiled into a function of their free identifiers that returns the render data they leave. A
 * piece the source lacks is left out, so a pre-fix tree runs its combine without a block.
 *
 * @inner
 * @param {string} key - a COMBINE_DELEGATES key
 * @param {boolean} withBack - keep the merge-back
 * @returns {function} `(userData, req) => data`
 */
function compileRegion(key, withBack) {
    var st = STRIPPED[key];
    var body = (st.indexOf(SESSION_LINE) > -1 ? SESSION_LINE + '\n' : 'var sessionBlock = null;\n')
             + COPY_LINE + '\n'
             + braceSlice(st, NJ_ANCHOR, key).text + '\n';
    if (withBack && st.indexOf(BACK_ANCHOR) > -1) {
        body += braceSlice(st, BACK_ANCHOR, key).text + '\n';
    }
    var fn = new Function('userData', 'data', 'renderData', 'renderSession', 'merge', 'getData', 'req', body + 'return data;');
    return function (userData, req) {
        var getData = function () {
            return { page: { view: { file: 'home', url: '/app/home' }, environment: { webroot: '/app/' } }, gina: { csrfToken: 'tok' } };
        };
        return fn(userData, getData(), renderData, renderSession, merge, getData, req);
    };
}

// [label, the object an action passes, whether it has its own member in the block's place]
var SHAPES = [
    ['an object without `page`',         function () { return { title: 'T' }; },                       false],
    ['an object with its own `page.data`', function () { return { page: { data: { title: 'T' } } }; }, true],
    ['an object with its own `session`', function () { return { title: 'T', session: { user: 'app' } }; }, true]
];

describe('#B989 §05 — the three combine delegates keep the block through the combine', function () {

    function req(id) { return { session: { id: id, cookie: { _expires: new Date(Date.now() + 600000) } } }; }

    COMBINE_DELEGATES.forEach(function (k) {
        SHAPES.forEach(function (s, i) {
            it('05.' + (i + 1) + '  ' + DELEGATES[k] + ', ' + s[0] + ': page.data.session holds the request\'s id, and the object is not written', function () {
                var userData = s[1](), snapshot = JSON.stringify(userData);
                var data = compileRegion(k, true)(userData, req('sid-A'));
                assert.ok(data.page.data && data.page.data.session, 'page.data.session exists');
                assert.equal(data.page.data.session.id, 'sid-A', 'the request\'s session id');
                assert.ok(data.page.data.session.expiresAt && data.page.data.session.timeout > 0, 'expiresAt and timeout');
                if (userData.session) { assert.equal(data.page.data.session.user, 'app', 'the action\'s own session key stays'); }
                assert.equal(data.page.data.title, 'T', 'the action\'s title reaches page.data');
                assert.equal(JSON.stringify(userData), snapshot, 'the action\'s object is as it was');
                // a second request through the same object gets its own id
                var data2 = compileRegion(k, true)(userData, req('sid-B'));
                assert.equal(data2.page.data.session.id, 'sid-B', 'request 2\'s own id');
                assert.equal(JSON.stringify(userData), snapshot, 'still as it was');
            });
        });

        it('05.C  CONTROL — ' + DELEGATES[k] + ' without the merge-back: the two objects with their own member drop the block', function () {
            SHAPES.forEach(function (s) {
                var data = compileRegion(k, false)(s[1](), req('sid-A'));
                var id = data.page.data && data.page.data.session && data.page.data.session.id;
                if (s[2]) { assert.equal(id, undefined, s[0] + ': the combine replaced the block'); }
            });
        });

        it('05.N  ' + DELEGATES[k] + ', a request without a session: no block, nothing thrown', function () {
            var data = compileRegion(k, true)({ title: 'T' }, {});
            assert.equal(data.page.data.session, undefined);
            assert.equal(data.page.data.title, 'T');
        });
    });
});
