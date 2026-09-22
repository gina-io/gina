'use strict';
/**
 * #B554 - the inline fallback error page reflected caller text as HTML.
 *
 * `throwError`'s built-in page (the one every bundle without `errorFiles` gets)
 * concatenated `title` / `error` / `message` / `stack` straight into
 * `<pre class="... message">...</pre>`. `redirect()` hands a request-supplied
 * `?error=<value>` to `throwError` verbatim (controller.js ~:3540), so a GET to
 * any redirecting route carrying `?error=<img src=x onerror=...>` answered a 500
 * whose body executed the payload - reflected XSS, in every scope (only the
 * `stack` block was scope-gated), on every published version.
 *
 * The same builder shape lives in two more files: the engine-attached
 * `throwError` twin in `core/server.js` (`'<pre>'+ msg + ...`, fed `req.url` /
 * `:path` by its 404/403/500 callers - browser-safe only because browsers
 * percent-encode `<` in a URL, raw for any other client) and the three
 * error-document fallbacks in `controller.render-nunjucks.js`. All are escaped
 * now, by one byte-identical `_escapeHtml` per file (the `_mintErrorRef`
 * discipline: controller.js is evicted per request in dev, so a shared home
 * would churn; the helper is six lines).
 *
 * Arms:
 *   §00 instrument validation - tokens fire, the comment strip neither no-ops
 *                               nor guts the file, the old shapes survive in RAW
 *                               text (the replace-code convention keeps them as
 *                               `// was:` lines) so the live negatives can fail
 *   §01 source pins           - every emission site escapes; the two stack gates
 *                               are untouched; the three helper copies are
 *                               byte-identical and escape exactly & < > " '
 *   §02 behaviour, real bytes - the controller's page is driven through
 *                               `createTestInstance` for the three call shapes
 *                               that reach the builder; the payload comes out
 *                               entity-encoded, plain text comes out verbatim
 *
 * Red-first on the pre-fix bytes: §01 red (no helper, raw sites), §02 red (raw
 * tags in the body), §00 green.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

// The stack blocks render only in local scope; `_isLocalScope` is read ONCE at
// module load, so this must be set before controller.js is required (§02).
process.env.NODE_SCOPE_IS_LOCAL = 'true';

var FW      = require('../fw');
var SRC_CTL = path.join(FW, 'core/controller/controller.js');
var SRC_SRV = path.join(FW, 'core/server.js');
var SRC_NJK = path.join(FW, 'core/controller/controller.render-nunjucks.js');

var rawCtl = fs.readFileSync(SRC_CTL, 'utf8');
var rawSrv = fs.readFileSync(SRC_SRV, 'utf8');
var rawNjk = fs.readFileSync(SRC_NJK, 'utf8');

/**
 * Drop comment lines so a pin cannot be satisfied by the `// was:` line the
 * replace-code convention leaves beside each fixed site.
 *
 * @inner
 * @param {string} source
 * @returns {string} the live lines only
 */
function stripComments(source) {
    return source.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}
var liveCtl = stripComments(rawCtl);
var liveSrv = stripComments(rawSrv);
var liveNjk = stripComments(rawNjk);

/** @inner @param {string} hay @param {string} needle @returns {number} */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

// The exact emission shapes AFTER the fix (controller.js).
var CTL_SITES = [
    "' title\">'+ _escapeHtml(msg.title) +'</pre>'",
    "' message\">'+ _escapeHtml(msg.error) +'</pre>'",
    "' message\">'+ _escapeHtml(msg.message) +'</pre>'",
    "' stack\">'+ _escapeHtml(msg.stack) +'</pre>'",
    "' title\">'+ _escapeHtml(title) +'</pre>'",
    "' message\">'+ _escapeHtml(message) +'</pre>'",
    "' stack\">'+ _escapeHtml(stack) +'</pre>'"
];
// ...and the shapes BEFORE it, which must survive only as comments.
var CTL_RAW_SITES = [
    "' title\">'+ msg.title +'</pre>'",
    "' message\">'+ msg.error +'</pre>'",
    "' message\">'+ msg.message +'</pre>'",
    "' stack\">'+ msg.stack +'</pre>'",
    "' title\">'+ title +'</pre>'",
    "' message\">'+ message +'</pre>'",
    "' stack\">'+ stack +'</pre>'"
];
var SRV_SITE     = "'<h1>Error '+ code +'.</h1><pre>'+ _escapeHtml(msg) + '\\n\\nref '+ ref +'</pre>'";
// The pre-fix fragment, scoped to the part that CHANGED. The full old literal
// cannot be the needle: its `\n\nref '+ ref +'` tail is unchanged by this fix and
// `error-ref.test.js` counts that tail over RAW source expecting exactly two
// occurrences, so the `// was:` comments deliberately elide it.
var SRV_RAW_SITE = "<pre>'+ msg +";
var NJK_SITES = [
    "_escapeHtml(_absErrTemplate || '(unset)')",
    "_escapeHtml(readErr.message || readErr)",
    "_escapeHtml(renderErr.message || renderErr)"
];
var NJK_TITLE     = "<title>Error ' + _escapeHtml(_errStatusCode) + '</title>";
var NJK_RAW_TITLE = "<title>Error ' + _errStatusCode + '</title>";

/**
 * Extract the `_escapeHtml` helper's source from a file - the declaration plus
 * its body up to the first `};` - so the three copies can be compared and one
 * of them executed as shipped bytes.
 *
 * @inner
 * @param {string} live - comment-stripped source
 * @returns {string|null} the helper text, or null when absent
 */
function extractHelper(live) {
    var decl = 'var _escapeHtml = function(value) {';
    var i = live.indexOf(decl);
    if (i < 0) { return null; }
    var j = live.indexOf('};', i);
    if (j < 0) { return null; }
    if (live.indexOf(decl, i + 1) > -1) { return 'DUPLICATE'; }
    return live.slice(i, j + 2);
}


describe('#B554 §00 - instrument validation', function () {

    it('finds a token known to exist in each file and rejects a bogus one', function () {
        assert.ok(rawCtl.indexOf("var msgString = '<h1 class=\"status\">Error ") > -1, 'controller anchor must fire');
        assert.ok(rawSrv.indexOf('a11yErrorDocument(code,') > -1, 'server anchor must fire');
        assert.ok(rawNjk.indexOf('error template not found: ') > -1, 'nunjucks anchor must fire');
        assert.equal(rawCtl.indexOf('zz-b554-bogus-token'), -1);
    });

    it('the comment strip removes lines without gutting any of the three files', function () {
        [[rawCtl, liveCtl], [rawSrv, liveSrv], [rawNjk, liveNjk]].forEach(function (pair) {
            assert.ok(pair[1].length < pair[0].length, 'the strip must remove something');
            assert.ok(pair[1].length > pair[0].length * 0.3, 'the strip must not gut the source');
        });
        assert.ok(liveCtl.indexOf("var msgString = '<h1 class=\"status\">Error ") > -1, 'live code survives the strip');
    });

    it('the pre-fix shapes are still locatable in RAW text (as `// was:` lines) - the negatives below can fail', function () {
        CTL_RAW_SITES.forEach(function (s) {
            assert.ok(countOf(rawCtl, s) > 0, 'raw controller source must still carry: ' + s);
        });
        assert.ok(countOf(rawSrv, SRV_RAW_SITE) > 0, 'raw server source must still carry the old builder');
        assert.ok(countOf(rawNjk, NJK_RAW_TITLE) > 0, 'raw nunjucks source must still carry the old title');
    });
});


describe('#B554 §01 - source pins', function () {

    it('controller.js: each of the seven emission sites escapes its value (live code)', function () {
        CTL_SITES.forEach(function (s) {
            assert.equal(countOf(liveCtl, s), 1, '#B554: expected exactly one live site ' + s);
        });
    });

    it('controller.js: no live emission site concatenates a raw value', function () {
        CTL_RAW_SITES.forEach(function (s) {
            assert.equal(countOf(liveCtl, s), 0, '#B554: a raw (unescaped) site survives in live code: ' + s);
        });
    });

    it('controller.js: the two stack gates are untouched (fail-closed outside local scope)', function () {
        assert.equal(countOf(liveCtl, 'if (msg.stack && _isLocalScope)'), 1);
        assert.equal(countOf(liveCtl, 'if (stack && _isLocalScope)'), 1);
    });

    it('server.js: both transports of the engine-attached twin escape `msg`', function () {
        assert.equal(countOf(liveSrv, SRV_SITE), 2, '#B554: the h2 and h1 builders must both escape');
        assert.equal(countOf(liveSrv, SRV_RAW_SITE), 0, '#B554: a raw twin builder survives in live code');
    });

    it('render-nunjucks.js: the three fallback documents escape their text and their status', function () {
        NJK_SITES.forEach(function (s) {
            assert.equal(countOf(liveNjk, s), 1, '#B554: expected exactly one live site ' + s);
        });
        assert.equal(countOf(liveNjk, NJK_TITLE), 3, '#B554: the three <title> literals must carry the escaped status');
        assert.equal(countOf(liveNjk, NJK_RAW_TITLE), 0, '#B554: a raw <title> status survives in live code');
    });

    it('the three `_escapeHtml` copies exist exactly once each and are byte-identical', function () {
        var a = extractHelper(liveCtl), b = extractHelper(liveSrv), c = extractHelper(liveNjk);
        assert.ok(a && a !== 'DUPLICATE', 'controller.js must carry exactly one _escapeHtml');
        assert.ok(b && b !== 'DUPLICATE', 'server.js must carry exactly one _escapeHtml');
        assert.ok(c && c !== 'DUPLICATE', 'render-nunjucks.js must carry exactly one _escapeHtml');
        assert.equal(a, b, 'controller/server copies drifted');
        assert.equal(a, c, 'controller/nunjucks copies drifted');
    });

    it('the shipped helper escapes exactly & < > " \' and maps null/undefined to the empty string', function () {
        var helperSrc = extractHelper(liveCtl);
        assert.ok(helperSrc && helperSrc !== 'DUPLICATE', 'helper must be extractable');
        var fn = new Function('return (' + helperSrc.replace(/^var _escapeHtml = /, '').replace(/;$/, '') + ');')();
        assert.equal(fn('<img src="x" onerror=\'alert(1)\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;');
        assert.equal(fn('plain text 123'), 'plain text 123', 'plain text must pass through');
        assert.equal(fn(null), '');
        assert.equal(fn(undefined), '');
        assert.equal(fn(42), '42', 'non-strings are stringified first');
    });
});


/**
 * Drive the REAL controller `throwError` into its inline HTML fallback and
 * capture the document handed to `res.end`.
 *
 * The four disjuncts at controller.js ~:8682 select the JSON/XHR path; the HTML
 * page is what remains when ALL of them are false. Two option sets do that:
 * (a) `hasViews()` true + `isUsingTemplate` true - the production GET shape, and
 * (b) `hasViews()` FALSE + method `DELETE` + `isUsingTemplate` true.
 * This harness uses (b) deliberately. (a) makes `setOptions` enter its
 * `if (hasViews())` block, which reads `getContext('gina').version`,
 * `.middleware` and a `config.envConf[bundle][NODE_ENV]` routing tree - seeding
 * all of that would couple this file to `setOptions`' internals for no gain,
 * since the builder under test is downstream of both and identical either way.
 * Shape (a)'s reachability is covered where it belongs, by the live drive on a
 * booted bundle (`GET /<slug>?error=<payload>` -> 500 text/html), recorded with
 * the fix; this file locks the ESCAPING.
 *
 * Remaining preconditions, measured: not an XHR, no `errorFiles` configured,
 * and a URL with no extension (so `isHtmlContent` is true).
 *
 * @inner
 * @returns {function(...*): string} drive(...throwErrorArgs) -> the HTML body
 */
function makeDriver() {
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SRC_CTL);
    var STATUS_CODES = { '200': 'OK', '404': 'Not Found', '500': 'Internal Server Error' };

    return function drive() {
        var body = null;
        var res = {
            statusCode: 200, headersSent: false,
            setHeader: function () {}, getHeader: function () {},
            getHeaders: function () { return {}; },
            writeHead: function () {},
            end: function (chunk) { body = (chunk == null) ? '' : String(chunk); }
        };
        var req = {
            url: '/x', method: 'DELETE',
            routing: { rule: 'r@b', param: { control: 'action' } },
            params: {}, get: {}, headers: { 'user-agent': 'node-test', 'accept-language': 'en' }
        };
        var options = {
            rule: 'r', control: 'action', encoding: 'utf8',
            isXMLRequest: false, isUsingTemplate: true,
            conf: {
                bundle: 'b', encoding: 'utf8',
                server: { coreConfiguration: {
                    statusCodes: STATUS_CODES,
                    mime: { json: 'application/json', html: 'text/html' }
                } },
                content: { routing: {}, templates: { _common: {} } }
            }
        };
        var inst = SuperController.createTestInstance({
            req: req, res: res, next: function () {}, options: options
        });
        inst.throwError.apply(inst, Array.prototype.slice.call(arguments));
        assert.equal(typeof body, 'string', 'harness fault: the HTML branch never reached res.end');
        assert.ok(body.indexOf('<h1 class="status">Error ') > -1, 'harness fault: not the inline fallback page: ' + body.slice(0, 200));
        return body;
    };
}

var PAYLOAD = '<img src=x onerror=alert(1)>';
var ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';


describe('#B554 §02 - behaviour over real bytes', function () {

    var drive = makeDriver();

    it('control - plain text reaches the page verbatim', function () {
        var html = drive('SENTINEL_VALUE_9f3');
        assert.ok(html.indexOf('<pre class="5xx message">SENTINEL_VALUE_9f3</pre>') > -1,
            'harness fault: the string form did not land in the message block: ' + html.slice(0, 400));
    });

    it('the `?error=` shape (a lone string) is entity-encoded, never reflected as markup', function () {
        var html = drive(PAYLOAD);
        assert.equal(html.indexOf('<img'), -1, '#B554: the payload was reflected raw');
        assert.ok(html.indexOf(ESCAPED) > -1, '#B554: the payload must be present, escaped');
    });

    it('the object shape: title, error and message are each escaped', function () {
        var html = drive({ status: 500, error: '<i>E</i>', message: '<u>M</u>', title: '<b>T</b>' });
        assert.equal(html.indexOf('<i>E</i>'), -1, '#B554: `error` reflected raw');
        assert.equal(html.indexOf('<u>M</u>'), -1, '#B554: `message` reflected raw');
        assert.equal(html.indexOf('<b>T</b>'), -1, '#B554: `title` reflected raw');
        assert.ok(html.indexOf('&lt;i&gt;E&lt;/i&gt;') > -1 || html.indexOf('&lt;u&gt;M&lt;/u&gt;') > -1,
            '#B554: at least one escaped field must be present (the branch rendered nothing?)');
    });

    it('the Error shape: the message is escaped; a stack rendered in local scope is escaped too', function () {
        var err = new Error('<script>alert(2)</script>');
        err.stack = 'Error: <script>alert(2)</script>\n    at <s>S</s> (/server/path/x.js:1)';
        var html = drive(500, err);
        assert.equal(html.indexOf('<script>'), -1, '#B554: an Error message reflected raw');
        assert.ok(html.indexOf('&lt;script&gt;alert(2)&lt;/script&gt;') > -1, '#B554: escaped message must be present');
        assert.equal(html.indexOf('<s>S</s>'), -1, '#B554: a local-scope stack reflected raw');
        assert.ok(html.indexOf('<pre class="5xx stack">') > -1, 'control: the stack block renders in local scope');
        assert.ok(html.indexOf('/server/path/x.js:1') > -1, 'control: plain frame text survives escaping');
    });
});
