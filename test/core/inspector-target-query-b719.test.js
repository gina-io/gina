/**
 * #B719 — the Inspector and `gina inspector:open` drop a target's query string and fragment
 * before they append `/_gina/…` to it.
 *
 * The defect: the standalone Inspector appends `/_gina/<endpoint>` to its `?target=` value, and
 * the CLI passes a positional URL through as that value, stripping only trailing slashes. A
 * pasted page URL (`http://host/page?x=1`) therefore built `http://host/page?x=1/_gina/agent`:
 * the endpoint path landed in the query string, where the endpoints no longer look for it since
 * #B712, and outside dev the appended `?key=` became part of another parameter.
 *
 * The fix: one helper, `normaliseTarget()`, drops `?…` and `#…` and then trailing slashes where
 * the target is read — `resolveBundleBase()` (every per-bundle `/_gina/*` consumer), the agent
 * SSE builder `tryAgent()` and the WebSocket builder `tryAgentWS()` — and the CLI drops them
 * from a positional URL before its trailing-slash strip.
 *
 * Instrument: the functions are EXTRACTED from the served dist copy of the Inspector (the tests
 * read what the browser gets) and from the CLI source, then EXECUTED against stubs of the browser
 * globals they read; the EventSource and WebSocket stubs record the URL each builder opens. A
 * target without a query or fragment is the control on every site: it must behave as before.
 *
 * Red-first seams: GINA_INSPECTOR_JS (the Inspector file) and GINA_INSPECTOR_OPEN_SRC (the CLI
 * command) point the file at another tree's copies.
 *
 * Run standalone:
 *   node --test test/core/inspector-target-query-b719.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW           = require('../fw');
var INSPECTOR_JS = process.env.GINA_INSPECTOR_JS || path.join(FW, 'core/asset/plugin/dist/vendor/gina/inspector/inspector.js');
var OPEN_SRC     = process.env.GINA_INSPECTOR_OPEN_SRC || path.join(FW, 'lib/cmd/inspector/open.js');
var INSP         = fs.readFileSync(INSPECTOR_JS, 'utf8');
var OPEN         = fs.readFileSync(OPEN_SRC, 'utf8');


// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * The index of the `}` that closes the `{` at `open`, skipping strings, template literals,
 * comments and regex literals (a `/` after an operator or an opening token starts one).
 *
 * @param {string} src
 * @param {number} open - Index of an opening brace
 * @returns {number}
 */
function matchBrace(src, open) {
    var depth = 0, prev = '';
    for (var j = open; j < src.length; j++) {
        var c = src[j];
        if (c === '"' || c === "'" || c === '`') {
            for (j++; j < src.length && src[j] !== c; j++) { if (src[j] === '\\') { j++; } }
            prev = c; continue;
        }
        if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); prev = ''; continue; }
        if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; continue; }
        if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) > -1)) {
            var inClass = false;
            for (j++; j < src.length; j++) {
                if (src[j] === '\\') { j++; continue; }
                if (src[j] === '[') { inClass = true; } else if (src[j] === ']') { inClass = false; } else if (src[j] === '/' && !inClass) { break; }
            }
            prev = '/'; continue;
        }
        if (c === '{') { depth++; }
        if (c === '}') { depth--; if (depth === 0) { return j; } }
        if (!/\s/.test(c)) { prev = c; }
    }
    throw new Error('no closing brace for the block at ' + open);
}

/** The whole `function <name>(…) { … }` declaration, or null when the source has none. */
function functionText(src, name) {
    var decl = 'function ' + name + '(';
    var at = src.indexOf(decl);
    if (at < 0) { return null; }
    assert.equal(src.indexOf(decl, at + 1), -1, name + ': the declaration must be unique');
    return src.slice(at, matchBrace(src, src.indexOf('{', at)) + 1);
}

/**
 * The Inspector's target readers, compiled in a scope whose free names are the stubs passed in.
 * `normaliseTarget` is included when the source has it (the fixed tree); before the fix no reader
 * calls it.
 */
function inspectorScope(win, stubs) {
    var names = ['normaliseTarget', 'resolveBundleBase', 'tryAgent', 'tryAgentWS'];
    var text = names.map(function (n) {
        var t = functionText(INSP, n);
        if (!t && n !== 'normaliseTarget') { throw new Error('the Inspector has no ' + n + '()'); }
        return t || '';
    }).join('\n');
    var factory = new Function('window', 'URLSearchParams', 'EventSource', 'WebSocket', 'qs', 'source', 'document',
        text + '\nreturn { resolveBundleBase: resolveBundleBase, tryAgent: tryAgent, tryAgentWS: tryAgentWS };');
    return factory(win, URLSearchParams, stubs.EventSource, stubs.WebSocket, stubs.qs, undefined, { title: '' });
}

/** Browser stubs: a `window` with the given query string, and recording EventSource / WebSocket. */
function browser(search, opener) {
    var opened = { sse: [], ws: [] };
    function Recorder(list) {
        return function (url) { list.push(url); this.addEventListener = function () {}; };
    }
    var el = function () { return { className: '', textContent: '', classList: { add: function () {}, remove: function () {} } }; };
    var win = { location: { search: search, pathname: '/_gina/inspector/' }, opener: opener || null };
    return { win: win, opened: opened, stubs: { EventSource: Recorder(opened.sse), WebSocket: Recorder(opened.ws), qs: el } };
}

function withTarget(target, key) {
    return '?target=' + encodeURIComponent(target) + (key ? '&key=' + encodeURIComponent(key) : '');
}

/** The CLI's argv loop, run on a positional argument list; returns what it parsed. */
function cliParse(args) {
    var head = 'for (i = 3; i < process.argv.length; i++) {';
    var at = OPEN.indexOf(head);
    assert.ok(at > -1, 'the CLI argv loop was not found');
    assert.equal(OPEN.indexOf(head, at + 1), -1, 'the CLI argv loop must be unique');
    var loop = OPEN.slice(at, matchBrace(OPEN, at + head.length - 1) + 1);
    var run = new Function('process',
        'var browserOverride = null, portOverride = null, urlOverride = null, targetOverride = null, bundleName = null, i;\n'
        + loop + '\nreturn { targetOverride: targetOverride, urlOverride: urlOverride, bundleName: bundleName };');
    return run({ argv: ['node', 'cli', 'inspector:open'].concat(args) });
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('#B719 — the Inspector and inspector:open drop a target\'s query string and fragment', function () {

    // ── 01 resolveBundleBase — every per-bundle /_gina/* consumer ──────────

    it('01.1  resolveBundleBase drops a query string and a fragment from ?target= (pre-fix: kept them)', function () {
        var b = browser(withTarget('http://127.0.0.1:3100/web/page?x=1#top'));
        assert.equal(inspectorScope(b.win, b.stubs).resolveBundleBase(), 'http://127.0.0.1:3100/web/page');
        b = browser(withTarget('http://127.0.0.1:3100/web/?x=1'));
        assert.equal(inspectorScope(b.win, b.stubs).resolveBundleBase(), 'http://127.0.0.1:3100/web', 'the trailing slash before the query goes too');
    });

    it('01.2  control: a target without a query keeps its path, trailing slashes stripped', function () {
        var b = browser(withTarget('http://127.0.0.1:3100/web/'));
        assert.equal(inspectorScope(b.win, b.stubs).resolveBundleBase(), 'http://127.0.0.1:3100/web');
    });

    it('01.3  control: with no ?target=, the opener\'s pathname, then the Inspector\'s own path, are used as before', function () {
        var b = browser('', { location: { pathname: '/web/page/' } });
        assert.equal(inspectorScope(b.win, b.stubs).resolveBundleBase(), '/web/page');
        b = browser('');
        b.win.location.pathname = '/web/_gina/inspector/';
        assert.equal(inspectorScope(b.win, b.stubs).resolveBundleBase(), '/web');
    });

    // ── 02 tryAgent — the agent event stream ──────────────────────────────

    it('02.1  tryAgent opens {target}/_gina/agent without the target\'s query or fragment, then the key (pre-fix: after the query)', function () {
        var b = browser(withTarget('http://127.0.0.1:3100/page?x=1#top', 'k1'));
        assert.equal(inspectorScope(b.win, b.stubs).tryAgent(), true);
        assert.deepEqual(b.opened.sse, ['http://127.0.0.1:3100/page/_gina/agent?key=k1']);
    });

    it('02.2  control: a target without a query connects as before', function () {
        var b = browser(withTarget('http://127.0.0.1:3100/', 'k1'));
        assert.equal(inspectorScope(b.win, b.stubs).tryAgent(), true);
        assert.deepEqual(b.opened.sse, ['http://127.0.0.1:3100/_gina/agent?key=k1']);
    });

    it('02.3  a target that is only a query string opens nothing (pre-fix: opened `?x=1/_gina/agent`)', function () {
        var b = browser(withTarget('?x=1'));
        assert.equal(inspectorScope(b.win, b.stubs).tryAgent(), false);
        assert.deepEqual(b.opened.sse, []);
    });

    it('02.4  control: no ?target= opens nothing', function () {
        var b = browser('');
        assert.equal(inspectorScope(b.win, b.stubs).tryAgent(), false);
        assert.deepEqual(b.opened.sse, []);
    });

    // ── 03 tryAgentWS — the agent WebSocket ───────────────────────────────

    it('03.1  tryAgentWS opens ws(s)://…/_gina/agent without the target\'s query or fragment (pre-fix: after the query)', function () {
        var b = browser(withTarget('https://127.0.0.1:3100/web/page/?x=1#top', 'k 2'));
        assert.equal(inspectorScope(b.win, b.stubs).tryAgentWS(), true);
        assert.deepEqual(b.opened.ws, ['wss://127.0.0.1:3100/web/page/_gina/agent?key=k%202']);
    });

    it('03.2  control: a target without a query connects as before', function () {
        var b = browser(withTarget('http://127.0.0.1:3100'));
        assert.equal(inspectorScope(b.win, b.stubs).tryAgentWS(), true);
        assert.deepEqual(b.opened.ws, ['ws://127.0.0.1:3100/_gina/agent']);
    });

    // ── 04 gina inspector:open — the positional URL ───────────────────────

    it('04.1  inspector:open drops a positional URL\'s query string and fragment (pre-fix: kept them)', function () {
        assert.equal(cliParse(['http://127.0.0.1:3100/page?x=1']).targetOverride, 'http://127.0.0.1:3100/page');
        assert.equal(cliParse(['http://127.0.0.1:3100/web/#top']).targetOverride, 'http://127.0.0.1:3100/web');
    });

    it('04.2  control: a positional URL without a query keeps its path; --url= keeps its query; a bundle name is a bundle name', function () {
        var r = cliParse(['http://127.0.0.1:3100/web/', '--url=http://127.0.0.1:4101/inspector/?a=b', 'api']);
        assert.equal(r.targetOverride, 'http://127.0.0.1:3100/web');
        assert.equal(r.urlOverride, 'http://127.0.0.1:4101/inspector/?a=b', 'the Inspector base keeps its query (#INS8)');
        assert.equal(r.bundleName, 'api');
    });
});
