/**
 * #gh76 slice 2 (C2) — `data-gina-form-target` / `-swap` / `-select`, the `beforeswap` /
 * `afterswap` events, the richer `text/html` success payload, and the ONE tolerant parse of
 * the XHR hidden inputs (#B575).
 *
 * WHAT IT DRIVES (the shipped bytes, EXTRACTED and executed under jsdom — no replica):
 *  §01 `resolveSwapTarget` — the htmx `hx-target` grammar at submit time.
 *  §02 `parseXhrHtmlAnswer` (utils/events.js) — data/view when present, null when absent,
 *      the inputs stripped from the parsed document, a malformed value tolerated.
 *  §03 `applySwap` — every strategy, `select` (all matches, no match), a detached target,
 *      the cancelable `beforeswap` (preventDefault, `detail.content` rewrite), the region
 *      binding and its `deferFormId` on a self-replacing swap, `afterswap` ordering.
 *  §04 `refuseSend` — releases the submit and delivers the `targetError` shape.
 *  §05 `finalizeSelfReplacement` — retires the stale entry, binds an opted-in replacement.
 *  §09 `applyResponseOverrides` (gh#76 §6) — the server's last word: `X-Gina-Retarget` /
 *      `X-Gina-Reswap` / `X-Gina-Reselect` read at settle, the asymmetric invalid-value rule
 *      (a bad Retarget drops the target — no swap; a bad Reswap/Reselect is ignored, the
 *      declared value kept; either without a target is `noTarget`), the report shape.
 *  §11 the §6 SAME-ORIGIN gate — every override is honoured only from the page's own origin
 *      (`responseURL` against `location.origin`), fail-closed on a missing, empty or
 *      unparseable `responseURL` and on an opaque origin either side; a cross-origin Retarget
 *      refuses (no swap, `crossOrigin`), Reswap/Reselect are ignored and the declared values
 *      kept; plus a pin that the read sits after the all-null return and before the resolver.
 * WHAT IT PINS
 *  §06 the wiring: events registered, `sendCtx` shape, the capture placed after
 *      `listenToXhrEvents` and before the upload marker, the settle precedence (declared
 *      target before containment), both popin branches on the tolerant parse with no bare
 *      `.value` dereference left, the tail's `finalizeSelfReplacement`, the declarative
 *      `data-gina-form-event-on-swap` hook bound and unbound, `hFormIsRequired` including
 *      it, and the `on()` wrapper's `beforeswap.` exception.
 *  §13 `warnIfOldRuleRouted` — the containment dev warn (arm I of the issue's acceptance
 *      table), which the e2e harness cannot reach: it serves `envIsDev: 'false'`.
 *  §10 the gh#76 §6 wiring: the read sits inside the html branch, after the answer is known
 *      to be HTML and before the target fork (never on the JSON branch); the refused-Retarget
 *      branch precedes the fork; `beforeswap` and the payload carry the report only when set;
 *      the legacy path attaches it, the popin path never touches it.
 *
 * Red-first: every §01-§05 extraction control and every §06 pin FAILS on the pre-C2
 * sources (the seams below pointed at `git show <C1 sha>:<file>` copies).
 *
 * Usage: node --test test/core/validator-form-target.test.js
 */
'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { JSDOM } = require('jsdom');

var FW = require('../fw');
var VAL_SRC = process.env.GINA_VALIDATOR_SRC    || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var EVT_SRC = process.env.GINA_UTILS_EVENTS_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var valSrc = fs.readFileSync(VAL_SRC, 'utf8');
var evtSrc = fs.readFileSync(EVT_SRC, 'utf8');

function active(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/** Started-flag brace walk from a line-start declaration; exactly-once + balance controls. */
function extract(src, declRe, label) {
    var re = new RegExp(declRe, 'mg');
    var m = re.exec(src);
    assert.ok(m, label + ': declaration present (extraction control)');
    assert.equal(re.exec(src), null, label + ': declared exactly once');
    var i = m.index, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, label + ': balanced braces');
    // a `var x = function () {…}` slice needs its terminator before the `return` appended below
    return src.slice(m.index, i) + ';';
}
var srcResolve  = extract(valSrc, '^[ \\t]*var resolveSwapTarget = function\\(', 'resolveSwapTarget');
var srcRefuse   = extract(valSrc, '^[ \\t]*var refuseSend = function\\(', 'refuseSend');
var srcApply    = extract(valSrc, '^[ \\t]*var applySwap = function\\(', 'applySwap');
var srcFinalize = extract(valSrc, '^[ \\t]*var finalizeSelfReplacement = function\\(', 'finalizeSelfReplacement');
var srcParse    = extract(evtSrc, '^function parseXhrHtmlAnswer\\(', 'parseXhrHtmlAnswer');
var srcOob      = extract(evtSrc, '^function applyOobSwaps\\(', 'applyOobSwaps');
var srcWarnOob  = extract(valSrc, '^[ \\t]*var warnOobRefusals = function\\(', 'warnOobRefusals');
// gh#76 slice 1 — the containment dev warn. Lazily extracted like the §6/§7 seams below, so a
// pre-slice-1 source reds §13 alone rather than failing the file at load.
var srcWarnRouted = null;
try { srcWarnRouted = extract(valSrc, '^[ \\t]*var warnIfOldRuleRouted = function\\(', 'warnIfOldRuleRouted'); } catch (absent) { srcWarnRouted = null; }
var mStrategies = valSrc.match(/^[ \t]*var SWAP_STRATEGIES = (\[[^\]]+\]);/m);
// gh#76 §6 — extracted lazily so a pre-§6 source (the red-first lever) reds §09 alone, not the file
var srcOverrides = null;
try { srcOverrides = extract(valSrc, '^[ \\t]*var applyResponseOverrides = function\\(', 'applyResponseOverrides'); } catch (absent) { srcOverrides = null; }
// gh#76 §7 — same lazy shape: a pre-C3 source reds §11/§12 alone, not the whole file
var srcSync = null;
try {
    srcSync = {
        parse:      extract(valSrc, '^[ \\t]*var parseSync = function\\(', 'parseSync'),
        derive:     extract(valSrc, '^[ \\t]*var deriveSync = function\\(', 'deriveSync'),
        decide:     extract(valSrc, '^[ \\t]*var decideSync = function\\(', 'decideSync'),
        queue:      extract(valSrc, '^[ \\t]*var queueSyncSend = function\\(', 'queueSyncSend'),
        shift:      extract(valSrc, '^[ \\t]*var shiftSyncQueue = function\\(', 'shiftSyncQueue'),
        key:        extract(valSrc, '^[ \\t]*var resolveSyncKey = function\\(', 'resolveSyncKey'),
        elts:       extract(valSrc, '^[ \\t]*var resolveDisabledElts = function\\(', 'resolveDisabledElts'),
        disable:    extract(valSrc, '^[ \\t]*var disableForRequest = function\\(', 'disableForRequest'),
        release:    extract(valSrc, '^[ \\t]*var releaseDisabledElts = function\\(', 'releaseDisabledElts'),
        strategies: (valSrc.match(/^[ \t]*var SYNC_STRATEGIES = (\[[^\]]+\]);/m) || [])[1],
        replacing:  (valSrc.match(/^[ \t]*var REPLACING_SWAPS = (\[[^\]]+\]);/m) || [])[1],
        refs:       (valSrc.match(/^[ \t]*var disabledRefs = new WeakMap\(\);/m) || [])[0]
    };
    if ( !srcSync.strategies || !srcSync.replacing || !srcSync.refs ) { srcSync = null; }
} catch (absent) { srcSync = null; }

function win(html) {
    var dom = new JSDOM('<!DOCTYPE html><html><head><script src="http://localhost/js/gina.min.js"></script></head><body>' + (html || '') + '</body></html>', { url: 'http://localhost/page', runScripts: 'outside-only' });
    var w = dom.window;
    // a real dispatch, as triggerEvent does: cancelable CustomEvent, returned to the caller
    w.eval('window.__triggerEvent = function (target, el, name, args) { var evt = new CustomEvent(name, { detail: args, bubbles: true, cancelable: true }); el.dispatchEvent(evt); return evt; };');
    w.eval('window.__parseXhrHtmlAnswer = (function(){ ' + srcParse + ' return parseXhrHtmlAnswer; }());');
    w.eval('window.__resolveSwapTarget = (function(){ ' + srcResolve + ' return resolveSwapTarget; }());');
    return w;
}
/** jsdom-realm objects carry that realm's prototype: normalise before a strict deepEqual. */
function plain(v) { return JSON.parse(JSON.stringify(v)); }
var XHR_INPUTS = '<input type="hidden" id="gina-without-layout-xhr-data" value="%7B%22ok%22%3Atrue%7D"><input type="hidden" id="gina-without-layout-xhr-view" value="%7B%22v%22%3A1%7D">';

describe('§01 resolveSwapTarget — the hx-target grammar, extracted', function () {
    var w = win('<ul id="list"><li id="row" class="r"><form id="f"><span class="in">i</span></form></li><li id="other" class="r">o</li></ul><div id="far"></div>');
    var $f = w.document.getElementById('f');
    var r = function (v) { return w.__resolveSwapTarget($f, v); };

    it('this → the form', function () { assert.equal(r('this').target, $f); });
    it('closest <sel> → the closest ancestor OR the form itself', function () {
        assert.equal(r('closest li').target.id, 'row');
        assert.equal(r('closest form').target, $f, 'closest includes the element itself');
    });
    it('find <sel> → the first descendant', function () { assert.equal(r('find .in').target.className, 'in'); });
    it('<css selector> → the first document match', function () {
        assert.equal(r('#far').target.id, 'far');
        assert.equal(r('.r').target.id, 'row', 'first match in document order');
    });
    it('next / previous are reserved — refused, naming them', function () {
        assert.match(r('next').error, /`next` targeting is reserved/);
        assert.match(r('previous li').error, /`previous` targeting is reserved/);
    });
    it('no match, an empty value, a keyword without a selector, an invalid selector — all errors, never a throw', function () {
        assert.match(r('#nowhere').error, /no element matches `#nowhere`/);
        assert.match(r('   ').error, /empty/);
        assert.match(r('closest').error, /needs a selector/);
        assert.match(r('#[bad').error, /invalid selector/);
    });
});

describe('§02 parseXhrHtmlAnswer — the ONE tolerant parse (#B575), extracted', function () {
    it('reads data and view when present and STRIPS the inputs from the parsed document', function () {
        var w = win();
        var p = w.__parseXhrHtmlAnswer('<li id="r">x</li>' + XHR_INPUTS);
        assert.deepEqual(JSON.parse(JSON.stringify(p.data)), { ok: true });
        assert.deepEqual(JSON.parse(JSON.stringify(p.view)), { v: 1 });
        assert.equal(p.doc.getElementById('gina-without-layout-xhr-data'), null, 'stripped');
        assert.equal(p.doc.body.innerHTML, '<li id="r">x</li>');
    });
    it('reads null/null when the inputs are absent (outside dev mode) — the #B575 case', function () {
        var p = win().__parseXhrHtmlAnswer('<li id="r">x</li>');
        assert.equal(p.data, null); assert.equal(p.view, null);
        assert.equal(p.doc.body.innerHTML, '<li id="r">x</li>');
    });
    it('#B578 — table-context elements at the top level SURVIVE: a row answer keeps its <tr>, a lone <td> keeps its cell (parsed as a document they were foster-parented into bare text)', function () {
        var w = win();
        var p = w.__parseXhrHtmlAnswer('<tr id="row-42"><td>new</td></tr>' + XHR_INPUTS);
        assert.deepEqual(JSON.parse(JSON.stringify(p.data)), { ok: true }, 'the inputs are still read — in-body, not vacuously');
        assert.equal(p.doc.getElementById('gina-without-layout-xhr-data'), null, 'stripped');
        assert.equal(p.doc.body.innerHTML, '<tr id="row-42"><td>new</td></tr>');
        assert.equal(p.doc.querySelectorAll('tr').length, 1, 'a `select` on tr finds the row');
        assert.equal(w.__parseXhrHtmlAnswer('<td>cell</td>').doc.body.innerHTML, '<td>cell</td>');
        // a survivor is byte-identical under the new parse (control: the change is invisible where it was not needed)
        assert.equal(w.__parseXhrHtmlAnswer('<option value="1">one</option>').doc.body.innerHTML, '<option value="1">one</option>');
    });
    it('#B578 — a full-page answer (a layout render by mistake) drops its <head>, so no <title> lands in a swap', function () {
        var w = win();
        var p = w.__parseXhrHtmlAnswer('<html><head><title>t</title><meta charset="utf-8"></head><body><b>page</b></body></html>' + XHR_INPUTS);
        assert.equal(p.doc.body.innerHTML, '<b>page</b>');
        assert.deepEqual(JSON.parse(JSON.stringify(p.data)), { ok: true });
    });
    it('#B578 — the wrapper is not observable: no <template> is left behind, and an author-supplied <template> in the answer is kept as content', function () {
        var w = win();
        assert.equal(w.__parseXhrHtmlAnswer('<p>y</p>').doc.querySelectorAll('template').length, 0);
        var p = w.__parseXhrHtmlAnswer('<template><tr><td>x</td></tr></template><p>z</p>');
        assert.equal(p.doc.querySelectorAll('template').length, 1);
        assert.equal(p.doc.querySelector('template').content.querySelectorAll('tr').length, 1, 'its contents are intact');
        assert.equal(p.doc.body.innerHTML, '<template><tr><td>x</td></tr></template><p>z</p>');
    });
    it('tolerates a malformed value and a non-string body', function () {
        var p = win().__parseXhrHtmlAnswer('<input type="hidden" id="gina-without-layout-xhr-data" value="%7Bnope"><p>y</p>');
        assert.equal(p.data, null);
        assert.equal(p.doc.body.innerHTML, '<p>y</p>');
        assert.equal(win().__parseXhrHtmlAnswer(undefined).doc.body.innerHTML, '');
    });
});

describe('§03 applySwap — strategies, select, attached check, beforeswap, binding, afterswap (extracted)', function () {
    function scene(opts) {
        var w = win(opts.html || '<ul id="list"><li id="row">before</li><li id="row2">two</li></ul><form id="f"><button>s</button></form><div id="out"></div>');
        var binds = [], warns = [], events = [];
        w.console.warn = function (m) { warns.push(String(m)); };
        var bindRegion = function ($root, o) { binds.push({ id: $root.id || $root.tagName, defer: o && o.deferFormId }); };
        var mk = w.eval('(function (parseXhrHtmlAnswer, triggerEvent, bindRegion, envIsDev, gina, document, window) { ' + srcApply + ' return applySwap; })');
        var apply = mk(w.__parseXhrHtmlAnswer, w.__triggerEvent, bindRegion, true, {}, w.document, w);
        var $form = w.document.getElementById(opts.formId || 'f');
        ['beforeswap.f', 'afterswap.f', 'afterswap.f.hform'].forEach(function (n) {
            $form.addEventListener(n, function (e) { events.push(n); if (opts.onEvent) opts.onEvent(n, e); });
        });
        var ctx = { popin: null, target: w.document.querySelector(opts.target), swap: opts.swap || 'innerHTML', select: opts.select || null, targetAttr: opts.target, rebindSelf: false };
        var result = { contentType: 'text/html', content: opts.answer, status: 200 };
        var payload = apply(ctx, { eventData: {} }, $form, 'f', !!opts.hform, result);
        return { w: w, ctx: ctx, payload: payload, binds: binds, warns: warns, events: events };
    }

    it('innerHTML (default): swaps the target content, strips the hidden inputs, delivers the richer payload, binds the target, fires beforeswap then afterswap', function () {
        var s = scene({ target: '#row', answer: '<b>saved</b>' + XHR_INPUTS });
        assert.equal(s.w.document.getElementById('row').innerHTML, '<b>saved</b>');
        assert.equal(s.payload.swapped, true); assert.equal(s.payload.swap, 'innerHTML');
        assert.deepEqual(JSON.parse(JSON.stringify(s.payload.data)), { ok: true });
        assert.equal(s.payload.contentType, 'text/html'); assert.equal(s.payload.status, 200);
        assert.ok(/saved/.test(s.payload.content), 'content is the raw answer');
        assert.deepEqual(s.binds, [{ id: 'row', defer: null }]);
        assert.deepEqual(s.events, ['beforeswap.f', 'afterswap.f']);
        assert.equal(s.ctx.rebindSelf, false);
    });
    it('outerHTML / beforebegin / afterend bind the PARENT; afterbegin / beforeend bind the target; the positions are right', function () {
        var s = scene({ target: '#row', swap: 'outerHTML', answer: '<li id="row">new</li>' });
        assert.equal(s.w.document.getElementById('row').textContent, 'new'); assert.deepEqual(s.binds, [{ id: 'list', defer: null }]);
        s = scene({ target: '#row', swap: 'beforebegin', answer: '<li id="pre">p</li>' });
        assert.equal(s.w.document.getElementById('list').firstElementChild.id, 'pre'); assert.deepEqual(s.binds, [{ id: 'list', defer: null }]);
        s = scene({ target: '#row', swap: 'afterend', answer: '<li id="post">p</li>' });
        assert.equal(s.w.document.getElementById('row').nextElementSibling.id, 'post');
        s = scene({ target: '#row', swap: 'afterbegin', answer: '<i>a</i>' });
        assert.equal(s.w.document.getElementById('row').innerHTML, '<i>a</i>before'); assert.deepEqual(s.binds, [{ id: 'row', defer: null }]);
        s = scene({ target: '#row', swap: 'beforeend', answer: '<i>z</i>' });
        assert.equal(s.w.document.getElementById('row').innerHTML, 'before<i>z</i>');
    });
    it('textContent uses the RAW answer, delete removes the target, none writes nothing (swapped:false, no afterswap)', function () {
        var s = scene({ target: '#row', swap: 'textContent', answer: '<b>raw</b>' });
        assert.equal(s.w.document.getElementById('row').textContent, '<b>raw</b>'); assert.equal(s.binds.length, 0);
        s = scene({ target: '#row', swap: 'delete', answer: 'x' });
        assert.equal(s.w.document.getElementById('row'), null); assert.equal(s.payload.swapped, true);
        s = scene({ target: '#row', swap: 'none', answer: 'x' });
        assert.equal(s.w.document.getElementById('row').textContent, 'before');
        assert.equal(s.payload.swapped, false); assert.deepEqual(s.events, []);
    });
    it('select: every match in document order; no match → swapped:false, a dev warn, the payload delivered', function () {
        var s = scene({ target: '#out', select: '.pick', answer: '<p class="pick">1</p><p>noise</p><p class="pick">2</p>' });
        assert.equal(s.w.document.getElementById('out').innerHTML, '<p class="pick">1</p><p class="pick">2</p>');
        s = scene({ target: '#out', select: '.absent', answer: '<p>x</p>' });
        assert.equal(s.w.document.getElementById('out').innerHTML, '');
        assert.equal(s.payload.swapped, false);
        assert.ok(s.warns.some(function (m) { return /matched nothing/.test(m); }));
        assert.deepEqual(s.events, [], 'no swap events without a swap');
    });
    it('a target that left the document → swapped:false, delivered, no throw', function () {
        var s = scene({ target: '#row', answer: 'x', html: '<ul id="list"></ul><li id="row">detached</li><form id="f"></form>' });
        // detach after capture
        var w = s.w; var $row = w.document.getElementById('row'); $row.parentNode.removeChild($row);
        var mk = w.eval('(function (parseXhrHtmlAnswer, triggerEvent, bindRegion, envIsDev, gina, document, window) { ' + srcApply + ' return applySwap; })');
        var apply = mk(w.__parseXhrHtmlAnswer, w.__triggerEvent, function () {}, true, {}, w.document, w);
        var p = apply({ target: $row, swap: 'innerHTML', select: null, targetAttr: '#row' }, { eventData: {} }, w.document.getElementById('f'), 'f', false, { contentType: 'text/html', content: 'x', status: 200 });
        assert.equal(p.swapped, false);
    });
    it('beforeswap: preventDefault() cancels the swap; a rewritten detail.content is what lands', function () {
        var s = scene({ target: '#row', answer: 'x', onEvent: function (n, e) { if (n === 'beforeswap.f') e.preventDefault(); } });
        assert.equal(s.w.document.getElementById('row').textContent, 'before'); assert.equal(s.payload.swapped, false);
        assert.deepEqual(s.events, ['beforeswap.f']);
        s = scene({ target: '#row', answer: 'x', onEvent: function (n, e) { if (n === 'beforeswap.f') e.detail.content = '<u>rewritten</u>'; } });
        assert.equal(s.w.document.getElementById('row').innerHTML, '<u>rewritten</u>');
    });
    it('a swap replacing the submitting form defers its own id (deferFormId) and flags rebindSelf; afterswap.hform fires only when the channel is armed', function () {
        var s = scene({ target: '#f', swap: 'outerHTML', answer: '<form id="f"></form>', hform: true });
        assert.deepEqual(s.binds, [{ id: 'BODY', defer: 'f' }]);
        assert.equal(s.ctx.rebindSelf, true);
        assert.deepEqual(s.events, ['beforeswap.f', 'afterswap.f', 'afterswap.f.hform']);
        s = scene({ target: '#row', answer: 'x', hform: false });
        assert.deepEqual(s.events, ['beforeswap.f', 'afterswap.f']);
    });
});

describe('§04 refuseSend — releases the submit, delivers the targetError shape (extracted)', function () {
    it('resets isSending/sent on both handles, disarms the loading state, emits error.<id> (+ .hform when armed)', function () {
        var w = win('<form id="f"></form>');
        var disarmed = [], emitted = [];
        var mk = w.eval('(function (instance, disarmSubmitLoading, envIsDev, triggerEvent, gina, console) { ' + srcRefuse + ' return refuseSend; })');
        var instance = { $forms: { f: { isSending: true, sent: true } } };
        var refuse = mk(instance, function ($f) { disarmed.push($f); }, false, function (t, el, name, args) { emitted.push({ name: name, args: args }); }, {}, w.console);
        var $form = { isSending: true, sent: true, eventData: {} };
        refuse($form, w.document.getElementById('f'), 'f', true, 'data-gina-form-target', '#nowhere', 'no element matches `#nowhere`');
        assert.equal($form.isSending, false); assert.equal($form.sent, false);
        assert.equal(instance.$forms.f.isSending, false);
        assert.deepEqual(disarmed, [$form]);
        assert.deepEqual(emitted.map(function (e) { return e.name; }), ['error.f', 'error.f.hform']);
        // JSON round-trip: the payload is minted in the jsdom realm (its Object.prototype is not ours)
        assert.deepEqual(JSON.parse(JSON.stringify(emitted[0].args)), { status: 422, error: 'data-gina-form-target: no element matches `#nowhere`', reason: 'targetError', attribute: 'data-gina-form-target', value: '#nowhere', transportError: false });
        assert.equal($form.eventData.error, emitted[0].args);
        emitted.length = 0;
        refuse($form, w.document.getElementById('f'), 'f', false, 'data-gina-form-swap', 'bogus', 'unknown');
        assert.deepEqual(emitted.map(function (e) { return e.name; }), ['error.f'], 'no .hform when the channel is not armed');
    });

    it('a request still in flight KEEPS its loading state and isSending — the refusal only delivers the error (#B247 ownership)', function () {
        // `withRateLimit: false` lets a second attempt reach send() while the first is running.
        // `armSubmitLoading` is first-wins, so the refused attempt armed nothing of its own:
        // releasing here would clear the state the in-flight request still owns, exactly as
        // the validation-rejected path guards against.
        var w = win('<form id="f"></form>');
        var disarmed = [], emitted = [];
        var mk = w.eval('(function (instance, disarmSubmitLoading, envIsDev, triggerEvent, gina, console) { ' + srcRefuse + ' return refuseSend; })');
        var instance = { $forms: { f: { isSending: true, sent: true } } };
        var refuse = mk(instance, function ($f) { disarmed.push($f); }, false, function (t, el, name, args) { emitted.push({ name: name, args: args }); }, {}, w.console);
        var $form = { isSending: true, sent: true, eventData: {} };
        refuse($form, w.document.getElementById('f'), 'f', true, 'data-gina-form-target', '#nowhere', 'no element matches `#nowhere`', true);
        assert.deepEqual(disarmed, [], 'the in-flight request keeps the armed loading state');
        assert.equal($form.isSending, true, 'isSending still belongs to the request in flight');
        assert.equal($form.sent, true);
        assert.equal(instance.$forms.f.isSending, true, 'the registry handle is untouched too');
        // the refusal is still DELIVERED — it is the release that is withheld, never the error
        assert.deepEqual(emitted.map(function (e) { return e.name; }), ['error.f', 'error.f.hform']);
        assert.equal(JSON.parse(JSON.stringify(emitted[0].args)).reason, 'targetError');
        assert.equal($form.eventData.error, emitted[0].args);
    });
});

describe('§05 finalizeSelfReplacement (extracted)', function () {
    function run(html, optedIn) {
        var w = win(html);
        var destroyed = [], bound = [];
        var instance = { $forms: { f: {} } };
        var mk = w.eval('(function (document, destroy, instance, isFormOptedIn, local, validateFormById) { ' + srcFinalize + ' return finalizeSelfReplacement; })');
        var fin = mk(w.document, function (id) { destroyed.push(id); }, instance, function () { return optedIn; }, { rules: {} }, function (id) { bound.push({ self: this, id: id }); });
        var $old = w.document.getElementById('old') || w.document.getElementById('f');
        return { fin: fin, $old: $old, destroyed: destroyed, bound: bound, instance: instance, w: w };
    }
    it('old form gone + opted-in same-id replacement: destroy(id) then validateFormById.call(instance, id)', function () {
        var s = run('<form id="f"></form>', true);
        var $old = s.w.document.createElement('form'); // a detached "old" element
        s.fin($old, 'f');
        assert.deepEqual(s.destroyed, ['f']);
        assert.equal(s.bound.length, 1); assert.equal(s.bound[0].id, 'f'); assert.equal(s.bound[0].self, s.instance);
    });
    it('a replacement that does not opt in is not bound; an old form still attached is not destroyed', function () {
        var s = run('<form id="f"></form>', false);
        s.fin(s.w.document.createElement('form'), 'f');
        assert.deepEqual(s.destroyed, ['f']); assert.equal(s.bound.length, 0);
        var s2 = run('<form id="f"></form>', true);
        s2.fin(s2.w.document.getElementById('f'), 'f'); // same element, attached
        assert.deepEqual(s2.destroyed, []); assert.equal(s2.bound.length, 0);
    });
});

describe('§07 applyOobSwaps — the out-of-band grammar, extracted', function () {
    var PAGE = '<div id="totals">old</div><ul id="list"><li id="row">before</li></ul>'
             + '<form id="f"><button>s</button></form><p id="gone">g</p>';
    function scene(answer, opts) {
        opts = opts || {};
        var w = win(opts.html || PAGE);
        var binds = [], events = [];
        var bindRegion = function ($root, o) {
            binds.push({ id: ( $root && ( $root.id || $root.tagName ) ) || null, defer: ( o && o.deferFormId ) || null });
        };
        var oob = w.eval('(function (triggerEvent, bindRegion, document) { ' + srcOob + ' return applyOobSwaps; })')(w.__triggerEvent, bindRegion, w.document);
        var $form = w.document.getElementById('f');
        ['oobbeforeswap.f', 'oobafterswap.f', 'oobbeforeswap.f.hform', 'oobafterswap.f.hform'].forEach(function (n) {
            $form.addEventListener(n, function (e) { events.push(n); if (opts.onEvent) opts.onEvent(n, e); });
        });
        var parsed = w.__parseXhrHtmlAnswer(answer);
        var run = oob(parsed.doc, { $target: $form, id: 'f', hFormIsRequired: !!opts.hform, gina: {} });
        return { w: w, run: run, binds: binds, events: events, remainder: parsed.doc.body.innerHTML, doc: parsed.doc };
    }
    var $id = function (s, i) { return s.w.document.getElementById(i); };

    it('`true` and an empty value mean outerHTML: the page element is REPLACED, the attribute stripped, the element removed from the answer', function () {
        var s = scene('<p>main</p><div id="totals" data-gina-swap-oob="true">NEW</div>');
        assert.equal($id(s, 'totals').outerHTML, '<div id="totals">NEW</div>', 'replaced, attribute stripped on landing');
        assert.deepEqual(plain(s.run.list), [{ id: 'totals', strategy: 'outerHTML', swapped: true }]);
        assert.equal(s.remainder, '<p>main</p>', 'the main fragment is clean');
        var e = scene('<div id="totals" data-gina-swap-oob="">E</div>');
        assert.equal($id(e, 'totals').outerHTML, '<div id="totals">E</div>', 'an empty value is outerHTML too');
        assert.equal(e.remainder, '');
    });
    it('a strategy name uses the element CONTENT and strips the wrapper — innerHTML would otherwise nest a duplicate id', function () {
        var s = scene('<div id="totals" data-gina-swap-oob="innerHTML"><b>c</b></div>');
        assert.equal($id(s, 'totals').outerHTML, '<div id="totals"><b>c</b></div>', 'content only: no nested #totals');
        assert.equal(scene('<div id="totals" data-gina-swap-oob="textContent"><b>c</b></div>').w.document.getElementById('totals').textContent, 'c');
    });
    it('the insert positions land where htmx puts them, and every strategy binds the right region', function () {
        var s = scene('<li id="row" data-gina-swap-oob="beforebegin"><i id="pre">p</i></li>');
        assert.equal($id(s, 'list').firstElementChild.id, 'pre');
        assert.deepEqual(s.binds, [{ id: 'list', defer: null }], 'beforebegin binds the PARENT');
        s = scene('<li id="row" data-gina-swap-oob="afterend"><i id="post">p</i></li>');
        assert.equal($id(s, 'row').nextElementSibling.id, 'post');
        s = scene('<li id="row" data-gina-swap-oob="afterbegin"><i>a</i></li>');
        assert.equal($id(s, 'row').innerHTML, '<i>a</i>before');
        assert.deepEqual(s.binds, [{ id: 'row', defer: null }], 'afterbegin binds the TARGET');
        s = scene('<li id="row" data-gina-swap-oob="beforeend"><i>z</i></li>');
        assert.equal($id(s, 'row').innerHTML, 'before<i>z</i>');
        s = scene('<div id="totals" data-gina-swap-oob="true">N</div>');
        assert.deepEqual(s.binds, [{ id: 'BODY', defer: null }], 'outerHTML binds the PARENT');
        assert.equal(scene('<div id="totals" data-gina-swap-oob="textContent">t</div>').binds.length, 0, 'textContent binds nothing');
    });
    it('delete removes the page element; none writes nothing, fires no event, and STILL strips the element from the answer', function () {
        var s = scene('<p id="gone" data-gina-swap-oob="delete"></p>');
        assert.equal($id(s, 'gone'), null);
        assert.deepEqual(plain(s.run.list), [{ id: 'gone', strategy: 'delete', swapped: true }]);
        assert.equal(s.binds.length, 0, 'nothing to bind');
        var n = scene('<p>main</p><div id="totals" data-gina-swap-oob="none">X</div>');
        assert.equal($id(n, 'totals').textContent, 'old', 'untouched');
        assert.deepEqual(plain(n.run.list), [{ id: 'totals', strategy: 'none', swapped: false }]);
        assert.deepEqual(n.events, [], 'none is silent — a way to strip an element from the main content');
        assert.equal(n.remainder, '<p>main</p>', 'removed from the answer all the same');
    });
    it('every refusal removes the element, reports a reason and never throws: no id, no page match, a reserved value, an unknown one', function () {
        var s = scene('<p>main</p>'
            + '<div data-gina-swap-oob="true">A</div>'
            + '<div id="nowhere" data-gina-swap-oob="true">B</div>'
            + '<div id="totals" data-gina-swap-oob="innerHTML:.sel">C</div>'
            + '<div id="row" data-gina-swap-oob="sideways">D</div>');
        assert.deepEqual(plain(s.run.list), [
            { id: null,      strategy: 'outerHTML',        swapped: false, reason: 'noId' },
            { id: 'nowhere', strategy: 'outerHTML',        swapped: false, reason: 'noTarget' },
            { id: 'totals',  strategy: 'innerHTML:.sel',   swapped: false, reason: 'reserved' },
            { id: 'row',     strategy: 'sideways',         swapped: false, reason: 'unknownStrategy' }
        ]);
        assert.equal(s.remainder, '<p>main</p>', 'all four removed — the main fragment is always clean');
        assert.equal($id(s, 'totals').textContent, 'old'); assert.equal($id(s, 'row').textContent, 'before');
        assert.deepEqual(s.events, [], 'a refused element never reaches the events');
    });
    it('an out-of-band element nested in ANOTHER one travels with its ancestor: not processed on its own, attribute stripped, never left live in the page', function () {
        var s = scene('<div id="totals" data-gina-swap-oob="true">outer<span id="row" data-gina-swap-oob="true">inner</span></div>');
        assert.deepEqual(plain(s.run.list), [{ id: 'totals', strategy: 'outerHTML', swapped: true }], 'one swap, not two');
        assert.equal($id(s, 'totals').innerHTML, 'outer<span id="row">inner</span>', 'the nested attribute is stripped on landing');
        assert.equal($id(s, 'list').textContent, 'before', 'the page #row was NOT swapped — the id moved, it did not fire');
        // an element merely nested in a NON-oob wrapper IS processed and removed from it
        var d = scene('<section><div id="totals" data-gina-swap-oob="true">N</div>keep</section>');
        assert.deepEqual(plain(d.run.list), [{ id: 'totals', strategy: 'outerHTML', swapped: true }]);
        assert.equal(d.remainder, '<section>keep</section>');
    });
    it('an author-supplied <template> is honoured, and one emptied of its out-of-band elements is consumed with them — so an oob-only answer leaves NOTHING, wrapped or not', function () {
        // the canonical htmx shape: a table row, wrapped by an author who still writes the
        // <template> (#B578 made the wrapper unnecessary, never wrong)
        var TABLE = '<table><tbody id="tb"><tr id="trow"><td>old</td></tr></tbody></table><form id="f"><button>s</button></form>';
        var s = scene('<template><tr id="trow" data-gina-swap-oob="true"><td>new</td></tr></template>', { html: TABLE });
        assert.deepEqual(plain(s.run.list), [{ id: 'trow', strategy: 'outerHTML', swapped: true }], 'template contents are processed');
        assert.equal($id(s, 'tb').innerHTML, '<tr id="trow"><td>new</td></tr>', 'a real row, cells intact');
        assert.equal(s.remainder, '', 'the emptied wrapper went with it (a popin would be blanked by `<template></template>`)');
        // a template that still holds content is KEPT — the removal is not over-broad
        var k = scene('<template><div id="totals" data-gina-swap-oob="true">N</div><b>keep</b></template>');
        assert.equal(k.remainder, '<template><b>keep</b></template>');
        assert.equal($id(k, 'totals').textContent, 'N');
    });
    it('oobbeforeswap is per element, cancelable, and its detail.content is rewritable', function () {
        var s = scene('<div id="totals" data-gina-swap-oob="true">A</div><li id="row" data-gina-swap-oob="innerHTML">B</li>', {
            onEvent: function (n, e) { if (n === 'oobbeforeswap.f' && e.detail.oobId === 'totals') e.preventDefault(); }
        });
        assert.deepEqual(plain(s.run.list), [
            { id: 'totals', strategy: 'outerHTML', swapped: false, reason: 'cancelled' },
            { id: 'row',    strategy: 'innerHTML', swapped: true }
        ], 'one cancelled, the next still runs');
        assert.equal($id(s, 'totals').textContent, 'old', 'the cancelled one did not write');
        assert.equal($id(s, 'row').textContent, 'B');
        assert.deepEqual(s.events, ['oobbeforeswap.f', 'oobbeforeswap.f', 'oobafterswap.f'], 'no afterswap for the cancelled element');
        var r = scene('<div id="totals" data-gina-swap-oob="true">A</div>', {
            onEvent: function (n, e) { if (n === 'oobbeforeswap.f') e.detail.content = '<div id="totals">REWRITTEN</div>'; }
        });
        assert.equal($id(r, 'totals').textContent, 'REWRITTEN');
    });
    it('the events carry the element identity, and only oobafterswap has a `.hform` twin — a cancel is a decision, mirroring beforeswap', function () {
        var seen = [];
        var s = scene('<div id="totals" data-gina-swap-oob="innerHTML">N</div>', {
            hform: true, onEvent: function (n, e) { seen.push({ n: n, oob: e.detail.oob, oobId: e.detail.oobId, strategy: e.detail.strategy, target: e.detail.target && e.detail.target.id }); }
        });
        assert.deepEqual(s.events, ['oobbeforeswap.f', 'oobafterswap.f', 'oobafterswap.f.hform'],
            'armed: the afterswap twin fires, the beforeswap twin does NOT exist');
        assert.deepEqual(seen.map(function (x) { return [x.oob, x.oobId, x.strategy, x.target]; }),
            [[true, 'totals', 'innerHTML', 'totals'], [true, 'totals', 'innerHTML', 'totals'], [true, 'totals', 'innerHTML', 'totals']]);
        assert.equal(scene('<div id="totals" data-gina-swap-oob="innerHTML">N</div>').events.indexOf('oobafterswap.f.hform'), -1,
            'unarmed: no `.hform` at all');
    });
    it('a swap that replaces or removes the SUBMITTING form defers its binding and reports rebindSelf', function () {
        var page = '<div id="wrap"><form id="f"><button>s</button></form></div><div id="totals">old</div>';
        var s = scene('<form id="f" data-gina-swap-oob="true"><button>s2</button></form>', { html: page });
        assert.equal(s.run.rebindSelf, true);
        assert.deepEqual(s.binds, [{ id: 'wrap', defer: 'f' }], 'the submitting form is skipped — the caller binds the replacement after the events');
        var c = scene('<div id="wrap" data-gina-swap-oob="delete"></div>', { html: page });
        assert.equal(c.run.rebindSelf, true, 'a container that CONTAINS the form counts too');
        var o = scene('<div id="totals" data-gina-swap-oob="true">N</div>', { html: page });
        assert.equal(o.run.rebindSelf, false);
        assert.deepEqual(o.binds, [{ id: 'BODY', defer: null }], 'an unrelated swap does not defer');
    });
    it('a non-document argument is tolerated (no throw, empty report)', function () {
        var w = win(PAGE);
        var oob = w.eval('(function (triggerEvent, bindRegion, document) { ' + srcOob + ' return applyOobSwaps; })')(w.__triggerEvent, function () {}, w.document);
        assert.deepEqual(plain(oob(null, { $target: w.document.getElementById('f'), id: 'f' })), { list: [], rebindSelf: false });
        assert.deepEqual(plain(oob({}, { $target: w.document.getElementById('f'), id: 'f' })), { list: [], rebindSelf: false });
    });
});

describe('§08 applySwap + out-of-band — the target path, gated (extracted)', function () {
    function scene(opts) {
        var w = win(opts.html || '<div id="totals">old</div><ul id="list"><li id="row">before</li></ul><form id="f"><button>s</button></form>');
        var binds = [], warns = [], oobCalls = 0;
        w.console.warn = function (m) { warns.push(String(m)); };
        var bindRegion = function ($root, o) { binds.push({ id: ( $root && ( $root.id || $root.tagName ) ) || null, defer: ( o && o.deferFormId ) || null }); };
        var applyOobSwaps = w.eval('(function (triggerEvent, bindRegion, document) { ' + srcOob + ' return applyOobSwaps; })')(w.__triggerEvent, bindRegion, w.document);
        var spyOob = function (doc, ctx) { oobCalls++; return applyOobSwaps(doc, ctx); };
        var warnOobRefusals = w.eval('(function (envIsDev) { ' + srcWarnOob + ' return warnOobRefusals; })')(true);
        var mk = w.eval('(function (parseXhrHtmlAnswer, triggerEvent, bindRegion, envIsDev, gina, document, window, applyOobSwaps, warnOobRefusals) { ' + srcApply + ' return applySwap; })');
        var apply = mk(w.__parseXhrHtmlAnswer, w.__triggerEvent, bindRegion, true, {}, w.document, w, spyOob, warnOobRefusals);
        var $form = w.document.getElementById('f');
        var ctx = { popin: null, target: w.document.querySelector(opts.target), swap: opts.swap || 'innerHTML', select: opts.select || null, targetAttr: opts.target, rebindSelf: false };
        var payload = apply(ctx, { eventData: {} }, $form, 'f', false, { contentType: 'text/html', content: opts.answer, status: 200 });
        return { w: w, ctx: ctx, payload: payload, binds: binds, warns: warns, oobCalls: oobCalls };
    }

    it('below the gate nothing changes: an answer without the attribute never calls applyOobSwaps and carries neither key', function () {
        var s = scene({ target: '#row', answer: '<b>saved</b>' + XHR_INPUTS });
        assert.equal(s.oobCalls, 0, 'the string gate short-circuits — an oob-free answer pays nothing');
        assert.equal('oob' in s.payload, false);
        assert.equal('remainder' in s.payload, false);
        assert.equal(s.w.document.getElementById('row').innerHTML, '<b>saved</b>');
    });
    it('the out-of-band element lands in the page while the main answer goes to its own target; `content` stays RAW and `remainder` is what is left', function () {
        var s = scene({ target: '#row', answer: '<b>saved</b><div id="totals" data-gina-swap-oob="true">42</div>' });
        assert.equal(s.w.document.getElementById('totals').outerHTML, '<div id="totals">42</div>');
        assert.equal(s.w.document.getElementById('row').innerHTML, '<b>saved</b>', 'the main swap got the remainder, not the oob element');
        assert.deepEqual(plain(s.payload.oob), [{ id: 'totals', strategy: 'outerHTML', swapped: true }]);
        assert.equal(s.payload.remainder, '<b>saved</b>');
        assert.ok(/data-gina-swap-oob/.test(s.payload.content), '`content` is still the raw answer — its meaning does not fork by path');
    });
    it('out-of-band runs BEFORE `select`, so an element outside the selection still lands (htmx order)', function () {
        var s = scene({ target: '#row', select: '.pick', answer: '<i class="pick">p</i><div id="totals" data-gina-swap-oob="true">99</div>' });
        assert.equal(s.w.document.getElementById('totals').textContent, '99');
        assert.equal(s.w.document.getElementById('row').innerHTML, '<i class="pick">p</i>');
    });
    it('textContent renders the remainder, never the consumed out-of-band markup', function () {
        var s = scene({ target: '#row', swap: 'textContent', answer: '<b>raw</b><div id="totals" data-gina-swap-oob="true">7</div>' });
        assert.equal(s.w.document.getElementById('row').textContent, '<b>raw</b>', 'the transport is not rendered as visible text');
        assert.equal(s.w.document.getElementById('totals').textContent, '7');
    });
    it('a refusal warns in dev mode, naming the element and the reason; `none` carries no reason and is not reported', function () {
        var s = scene({ target: '#row', answer: '<b>x</b><div id="nowhere" data-gina-swap-oob="true">B</div>' });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /form `#f`: out-of-band element `nowhere` not swapped — noTarget/);
        var n = scene({ target: '#row', answer: '<b>x</b><div id="totals" data-gina-swap-oob="none">B</div>' });
        assert.deepEqual(n.warns, []);
    });
    it('an out-of-band swap that replaced the submitting form sets rebindSelf even though the MAIN swap did not', function () {
        var s = scene({
            html: '<div id="wrap"><form id="f"><button>s</button></form></div><ul id="list"><li id="row">before</li></ul>',
            target: '#row', answer: '<b>x</b><form id="f" data-gina-swap-oob="true"><button>s2</button></form>'
        });
        assert.equal(s.ctx.rebindSelf, true, 'the shared tail will bind the replacement after the success events');
    });
});

describe('§06 wiring pins', function () {
    var a = active(valSrc), ae = active(evtSrc);

    it('registers beforeswap/afterswap and their out-of-band twins, in position; SWAP_STRATEGIES carries the nine htmx values', function () {
        // the array lines carry trailing `// #gh76` comments, which active() keeps (it strips whole-line comments only)
        assert.ok(/'error',[^\n]*\n\s*'beforeswap',[^\n]*\n\s*'afterswap',[^\n]*\n\s*'oobbeforeswap',[^\n]*\n\s*'oobafterswap',[^\n]*\n\s*'progress',/.test(a),
            'the four swap events are registered, the slice-3 pair right after the slice-2 pair');
        assert.ok(mStrategies, 'SWAP_STRATEGIES declared');
        assert.deepEqual(JSON.parse(mStrategies[1].replace(/'/g, '"')), ['innerHTML', 'outerHTML', 'textContent', 'beforebegin', 'afterbegin', 'beforeend', 'afterend', 'delete', 'none']);
    });
    it('sendCtx carries target/swap/select/targetAttr/rebindSelf', function () {
        assert.ok(a.indexOf("var sendCtx = { popin: null, target: null, swap: 'innerHTML', select: null, targetAttr: null, rebindSelf: false };") > -1);
    });
    it('the capture sits after listenToXhrEvents and before the upload marker; hFormIsRequired includes the swap hook; each refusal returns', function () {
        var listen = a.indexOf('listenToXhrEvents($form);');
        var cap    = a.indexOf("var targetAttr = $target.getAttribute('data-gina-form-target');");
        var upload = a.indexOf('var isUploadXhr = /^gina\\-upload/i.test(id);');
        assert.ok(listen > -1 && cap > listen && upload > cap, 'listen < capture < upload marker');
        assert.ok(/hFormIsRequired = \( \$target\.getAttribute\('data-gina-form-event-on-submit-success'\) \|\| \$target\.getAttribute\('data-gina-form-event-on-submit-error'\) \|\| \$target\.getAttribute\('data-gina-form-event-on-swap'\) \) \? true : false;/.test(a));
        var block = a.slice(cap, upload);
        assert.equal((block.match(/refuseSend\(\$form, \$target, id, hFormIsRequired, 'data-gina-form-(target|swap)'/g) || []).length, 2);
        assert.equal((block.match(/\n\s*return;\n/g) || []).length, 2, 'both refusals return');
    });
    it('settle: a declared target is applied BEFORE the containment branch, both popin branches parse tolerantly, no bare .value dereference remains', function () {
        var apply = a.indexOf('if ( sendCtx.target ) {\n                                    result = applySwap(sendCtx, $form, $target, id, hFormIsRequired, result);');
        var popin = a.indexOf("else if ( typeof(gina.popin) != 'undefined' && gina.hasPopinHandler ) {");
        assert.ok(apply > -1 && popin > apply, 'declared target first');
        assert.ok(a.indexOf('var parsedAnswer = parseXhrHtmlAnswer(result.content);') > -1, 'validator popin branch');
        assert.ok(ae.indexOf('var _parsed = parseXhrHtmlAnswer(result.content);') > -1, 'handleXhr popin branch');
        assert.equal(a.indexOf(".getElementById('gina-without-layout-xhr-data');"), -1, 'validator: no bare read left');
        assert.equal(ae.indexOf(".getElementById('gina-without-layout-xhr-data');"), -1, 'events.js: no bare read left');
        // the parsed data is delivered VERBATIM in dev mode (injecting a `status` key would
        // change the payload every contained form already receives — the slice-1 contract
        // `validator-popin-form-target.spec.js` §05 pins), and an object carrying the status
        // outside dev mode where the transport inputs are absent
        assert.ok(a.indexOf('result = XHRData || { status: xhr.status };') > -1
            && ae.indexOf('result = XHRData || { status: xhr.status };') > -1,
            'an object outside dev mode, never null; the parsed data never mutated');
        // scoped to the popin branch: `result.status = xhr.status` is LEGITIMATE elsewhere
        // (events.js :444/:455 build the legacy `{contentType, content, status}` payload), so
        // a file-wide absence pin would fire on those and could never pass
        [[a, 'validator'], [ae, 'events.js']].forEach(function (pair) {
            var src = pair[0]
                // #gh76 slice 3: the validator now loads the oob REMAINDER, so the anchor is
                // the call itself — measured unique in both files (validator, events.js)
                , from = src.indexOf('$popin.loadContent(')
                , to   = src.indexOf("triggerEvent(gina, $target, 'success.' + id, result);", from)
                , branch = ( from > -1 && to > from ) ? src.slice(from, to) : ''
            ;
            // instrument control: a slice that failed to locate the branch must not pass vacuously
            assert.ok(branch.indexOf('result = XHRData ||') > -1,
                pair[1] + ': the popin branch slice must contain the payload assignment (slice control)');
            assert.equal(branch.indexOf('result.status = xhr.status'), -1,
                pair[1] + ': no status injected into the parsed data inside the popin branch');
        });
        assert.ok(/^function parseXhrHtmlAnswer\(content\) \{/m.test(evtSrc), 'the parser is a top-level global in utils/events.js');
    });
    it('the shared tail binds a same-id replacement AFTER the success events', function () {
        var hform = a.indexOf("triggerEvent(gina, $target, 'success.' + id + '.hform', result);\n\n                            if ( sendCtx.rebindSelf ) {\n                                finalizeSelfReplacement($target, id);");
        assert.ok(hform > -1);
    });
    it('the declarative hook: bound by listenToXhrEvents, removed by unbindForm', function () {
        assert.ok(a.indexOf("$form.on('afterswap.hform', window[htmlSwapEventCallback])") > -1);
        assert.ok(a.indexOf("removeListener(gina, $form, 'afterswap.' + _id + '.hform');") > -1);
    });
    it('out-of-band is reached from all THREE html paths, each behind the same string gate — below it every path is byte-identical', function () {
        // anchored on the gate EXPRESSION, not on the `if (` prefix: the legacy hook carries an
        // extra `!sendCtx.target` term first, so a prefix-anchored needle reads 2 and cannot fire
        assert.equal((a.match(/result\.content\.indexOf\('data-gina-swap-oob'\) > -1/g) || []).length, 3,
            'the target, popin and legacy paths, and nothing else');
        assert.equal((a.match(/typeof\(result\.content\) == 'string' && result\.content\.indexOf\('data-gina-swap-oob'\) > -1/g) || []).length, 3,
            'each gate guards the string type before indexing it');
        // each gate opens the block that actually calls the helper
        assert.equal((a.match(/applyOobSwaps\(/g) || []).length, 3, 'one call per path');
        assert.equal((a.match(/warnOobRefusals\(id, /g) || []).length, 3, 'each path reports its refusals');
        // the helper itself is a top-level global beside the parser, not a per-path copy
        assert.ok(/^function applyOobSwaps\(doc, ctx\) \{/m.test(evtSrc), 'a single implementation in utils/events.js');
        assert.equal((ae.match(/^function applyOobSwaps\(/mg) || []).length, 1);
        // the legacy path is the one WITHOUT a declared target
        assert.ok(a.indexOf("if ( !sendCtx.target && typeof(result.content) == 'string' && result.content.indexOf('data-gina-swap-oob') > -1 ) {") > -1,
            'the legacy hook is scoped to a target-less send');
    });
    it('the popin is left as it is when nothing was addressed to it — loading an empty remainder would blank the dialog and unbind its form', function () {
        var from = a.indexOf('var popinContent = result.content, oobRunPopin = null;');
        assert.ok(from > -1, 'the popin branch computes a remainder (slice control)');
        var to = a.indexOf("result = XHRData ||", from);
        assert.ok(to > from, 'the branch slice is located');
        var branch = a.slice(from, to);
        assert.ok(branch.indexOf("if ( oobRunPopin === null || popinContent.trim() !== '' ) {\n                                            $popin.loadContent(popinContent);") > -1,
            'loadContent is skipped on an empty remainder, and untouched when the gate never fired');
        assert.equal(branch.indexOf('$popin.loadContent(result.content)'), -1, 'the raw answer no longer reaches the popin once oob ran');
    });
    it('a self-replacing out-of-band swap is finalized on every path: the popin branch returns, so it binds the replacement itself', function () {
        // the target and legacy paths fall through to the shared tail; the popin branch does not
        assert.ok(a.indexOf("if ( sendCtx.rebindSelf ) {\n                                            finalizeSelfReplacement($target, id);\n                                        }\n                                        return;") > -1,
            'the popin branch binds before returning');
        assert.ok(a.indexOf('sendCtx.rebindSelf = sendCtx.rebindSelf || detachesForm;') > -1,
            'the main swap never clears a flag an out-of-band swap already set');
        assert.equal(a.indexOf('sendCtx.rebindSelf = detachesForm;'), -1, 'the plain assignment is gone');
    });
    it("on(): the wrapper skips cancelEvent for `beforeswap.` AND `oobbeforeswap.` only", function () {
        assert.ok(ae.indexOf("if ( !/^(oob)?beforeswap\\./.test(e.type) ) {\n                    cancelEvent(e);") > -1,
            'the exception is widened to the out-of-band twin');
        // the shipped regex itself, exercised: both decision points are exempt, nothing else is
        var m = ae.match(/if \( !\/(\^\(oob\)\?beforeswap\\\.)\/\.test\(e\.type\) \)/);
        assert.ok(m, 'the exception regex is readable from the source (instrument control)');
        var re = new RegExp(m[1]);
        assert.equal(re.test('beforeswap.f'), true, 'beforeswap is exempt');
        assert.equal(re.test('oobbeforeswap.f'), true, 'oobbeforeswap is exempt — the slice-3 cancel reaches its listener');
        assert.equal(re.test('afterswap.f'), false, 'afterswap is NOT exempt');
        assert.equal(re.test('oobafterswap.f'), false, 'oobafterswap is NOT exempt');
        assert.equal(re.test('success.f'), false, 'an ordinary event is NOT exempt');
    });
});


// ── gh#76 §6 — the server's last word: X-Gina-Retarget / X-Gina-Reswap / X-Gina-Reselect ──

describe('§09 applyResponseOverrides — the response-header overrides, extracted', function () {
    /**
     * A settled transport: header lookup is case-insensitive, as a real XMLHttpRequest's is.
     * It answers from the page's own origin (the jsdom page is `http://localhost/page`): the
     * gh#76 §6 same-origin gate reads `responseURL`, and a fake without one reads as
     * cross-origin — §11 builds its own transports for that.
     */
    function xhrWith(headers) {
        var map = {};
        Object.keys(headers || {}).forEach(function (k) { map[k.toLowerCase()] = headers[k]; });
        return { responseURL: 'http://localhost/x76/save', getResponseHeader: function (name) { var v = map[String(name).toLowerCase()]; return ( typeof(v) == 'undefined' ) ? null : v; } };
    }
    function scene(html) {
        var w = win(html || '<ul id="list"><li id="row" class="r"><form id="f"><span class="in">i</span></form></li></ul><div id="totals">t0</div>');
        assert.ok(srcOverrides, 'applyResponseOverrides is declared in the source (extraction control — red on a pre-§6 source)');
        w.eval('window.__applyResponseOverrides = (function(){ var envIsDev = false; var SWAP_STRATEGIES = ' + mStrategies[1] + '; ' + srcResolve + ' ' + srcOverrides + ' return applyResponseOverrides; }());');
        return { w: w, $f: w.document.getElementById('f') };
    }
    function ctx(over) {
        var c = { popin: null, target: null, swap: 'innerHTML', select: null, targetAttr: null, rebindSelf: false };
        Object.keys(over || {}).forEach(function (k) { c[k] = over[k]; });
        return c;
    }

    it('no header at all → null, and the capture is left exactly as it was (no `overrides` key)', function () {
        var s = scene(), c = ctx({ target: s.w.document.getElementById('row'), targetAttr: '#row', swap: 'beforeend', select: 'li' });
        var r = s.w.__applyResponseOverrides(xhrWith({}), c, s.$f, 'f');
        assert.equal(r, null);
        assert.equal(c.target.id, 'row'); assert.equal(c.targetAttr, '#row'); assert.equal(c.swap, 'beforeend'); assert.equal(c.select, 'li');
        assert.equal('overrides' in c, false, 'nothing recorded when nothing was sent');
    });
    it('X-Gina-Retarget creates a target where none was declared; the report names the header as the target attribute', function () {
        var s = scene(), c = ctx();
        var r = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Retarget': '#totals' }), c, s.$f, 'f');
        assert.equal(c.target.id, 'totals');
        assert.equal(c.targetAttr, 'X-Gina-Retarget');
        assert.deepEqual(plain(r), { retarget: { value: '#totals', applied: true } });
        assert.equal(c.overrides, r, 'stored on the capture');
    });
    it('X-Gina-Retarget takes the data-gina-form-target grammar through the same resolver (this / closest / find / selector)', function () {
        var s = scene();
        assert.equal(s.w.__applyResponseOverrides(xhrWith({ 'x-gina-retarget': 'this' }), ctx(), s.$f, 'f').retarget.applied, true);
        var c1 = ctx(); s.w.__applyResponseOverrides(xhrWith({ 'x-gina-retarget': 'this' }), c1, s.$f, 'f'); assert.equal(c1.target, s.$f, 'this → the form');
        var c2 = ctx(); s.w.__applyResponseOverrides(xhrWith({ 'x-gina-retarget': 'closest li' }), c2, s.$f, 'f'); assert.equal(c2.target.id, 'row');
        var c3 = ctx(); s.w.__applyResponseOverrides(xhrWith({ 'x-gina-retarget': 'find .in' }), c3, s.$f, 'f'); assert.equal(c3.target.className, 'in');
        var c4 = ctx(); var r4 = s.w.__applyResponseOverrides(xhrWith({ 'x-gina-retarget': 'next' }), c4, s.$f, 'f');
        assert.equal(r4.retarget.applied, false); assert.match(r4.retarget.reason, /reserved/);
    });
    it('X-Gina-Retarget replaces a DECLARED target', function () {
        var s = scene(), c = ctx({ target: s.w.document.getElementById('row'), targetAttr: '#row' });
        s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Retarget': '#totals' }), c, s.$f, 'f');
        assert.equal(c.target.id, 'totals'); assert.equal(c.targetAttr, 'X-Gina-Retarget');
    });
    it('a Retarget that cannot be resolved DROPS the target (no swap) and carries the reason; a Reswap in the same answer is then `noTarget`', function () {
        var s = scene(), c = ctx({ target: s.w.document.getElementById('row'), targetAttr: '#row', swap: 'innerHTML' });
        var r = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Retarget': '#nowhere', 'X-Gina-Reswap': 'beforeend' }), c, s.$f, 'f');
        assert.equal(c.target, null, 'the declared target is abandoned — the server meant somewhere else');
        assert.equal(c.targetAttr, 'X-Gina-Retarget');
        assert.equal(r.retarget.applied, false); assert.match(r.retarget.reason, /no element matches `#nowhere`/);
        assert.deepEqual(plain(r.reswap), { value: 'beforeend', applied: false, reason: 'noTarget' });
        assert.equal(c.swap, 'innerHTML', 'the declared strategy is untouched');
        var e = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Retarget': '' }), ctx(), s.$f, 'f');
        assert.equal(e.retarget.applied, false); assert.match(e.retarget.reason, /empty/);
    });
    it('X-Gina-Reswap: a known strategy replaces the declared one; an unknown one is IGNORED and the declared kept; without a target it is `noTarget`', function () {
        var s = scene();
        var ok = ctx({ target: s.w.document.getElementById('row'), swap: 'innerHTML' });
        assert.deepEqual(plain(s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reswap': 'beforeend' }), ok, s.$f, 'f')), { reswap: { value: 'beforeend', applied: true } });
        assert.equal(ok.swap, 'beforeend');
        var bad = ctx({ target: s.w.document.getElementById('row'), swap: 'afterend' });
        var rb = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reswap': 'sideways' }), bad, s.$f, 'f');
        assert.equal(rb.reswap.applied, false); assert.match(rb.reswap.reason, /unknown swap strategy `sideways`/);
        assert.equal(bad.swap, 'afterend', 'the declared strategy is kept');
        var none = ctx();
        assert.deepEqual(plain(s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reswap': 'beforeend' }), none, s.$f, 'f')), { reswap: { value: 'beforeend', applied: false, reason: 'noTarget' } });
        assert.equal(none.swap, 'innerHTML');
    });
    it('X-Gina-Reselect: a valid selector replaces the declared select; an invalid or empty one is IGNORED; without a target it is `noTarget`', function () {
        var s = scene();
        var ok = ctx({ target: s.w.document.getElementById('row'), select: null });
        assert.deepEqual(plain(s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reselect': 'li' }), ok, s.$f, 'f')), { reselect: { value: 'li', applied: true } });
        assert.equal(ok.select, 'li');
        var bad = ctx({ target: s.w.document.getElementById('row'), select: 'p' });
        var rb = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reselect': '#[bad' }), bad, s.$f, 'f');
        assert.equal(rb.reselect.applied, false); assert.match(rb.reselect.reason, /invalid selector/);
        assert.equal(bad.select, 'p', 'the declared select is kept');
        var empty = ctx({ target: s.w.document.getElementById('row') });
        assert.equal(s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reselect': '   ' }), empty, s.$f, 'f').reselect.applied, false);
        var none = ctx();
        assert.deepEqual(plain(s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Reselect': 'li' }), none, s.$f, 'f')), { reselect: { value: 'li', applied: false, reason: 'noTarget' } });
    });
    it('all three at once: Retarget resolves first, so Reswap and Reselect apply to the RETARGETED element', function () {
        var s = scene(), c = ctx();
        var r = s.w.__applyResponseOverrides(xhrWith({ 'X-Gina-Retarget': '#totals', 'X-Gina-Reswap': 'afterbegin', 'X-Gina-Reselect': 'li' }), c, s.$f, 'f');
        assert.equal(c.target.id, 'totals'); assert.equal(c.swap, 'afterbegin'); assert.equal(c.select, 'li');
        assert.deepEqual(plain(r), { retarget: { value: '#totals', applied: true }, reswap: { value: 'afterbegin', applied: true }, reselect: { value: 'li', applied: true } });
    });
    it('a transport whose getResponseHeader throws is read as "no header"', function () {
        var s = scene(), c = ctx();
        var r = s.w.__applyResponseOverrides({ getResponseHeader: function () { throw new Error('boom'); } }, c, s.$f, 'f');
        assert.equal(r, null);
    });
});

describe('§10 gh#76 §6 wiring pins', function () {
    var a = active(valSrc);

    it('the helper is declared once, beside the slice-2 helpers, ahead of applySwap', function () {
        assert.equal((a.match(/^[ \t]*var applyResponseOverrides = function\(xhr, sendCtx, \$target, id\) \{/mg) || []).length, 1);
        assert.ok(a.indexOf('var applyResponseOverrides = function(') < a.indexOf('var applySwap = function('));
    });
    it('the read sits inside the html branch — after the answer is known to be HTML, before the target fork — and never on the JSON branch', function () {
        var jsonGate = a.indexOf("if ( /\\/json/.test( contentType ) ) {");
        var htmlGate = a.indexOf("if ( /\\/html/.test( contentType ) ) {");
        var readIdx  = a.indexOf('applyResponseOverrides(xhr, sendCtx, $target, id);');
        var fork     = a.indexOf('else if ( sendCtx.target ) {');
        assert.ok(jsonGate > -1 && htmlGate > jsonGate, 'both content-type gates located, JSON first (slice control)');
        assert.ok(readIdx > htmlGate && readIdx < fork, 'html gate < read < target fork');
        assert.equal((a.match(/applyResponseOverrides\(xhr, sendCtx, \$target, id\);/g) || []).length, 1, 'exactly one call site');
        assert.equal(a.slice(jsonGate, htmlGate).indexOf('applyResponseOverrides('), -1, 'nothing between the JSON gate and the html gate reads the headers');
    });
    it('a refused Retarget takes its own branch AHEAD of the target fork: no swap, target null, reason retargetError, the report attached', function () {
        var refused = a.indexOf('if ( sendCtx.overrides && sendCtx.overrides.retarget && !sendCtx.overrides.retarget.applied ) {');
        var fork    = a.indexOf('else if ( sendCtx.target ) {');
        assert.ok(refused > -1 && fork > refused, 'refused branch precedes the fork');
        var block = a.slice(refused, fork);
        assert.ok(/target\s*:\s*null,/.test(block) && /swapped\s*:\s*false,/.test(block) && /reason\s*:\s*'retargetError',/.test(block) && /overrides\s*:\s*sendCtx\.overrides/.test(block),
            'the refused payload shape');
        assert.ok(block.indexOf('parseXhrHtmlAnswer(result.content)') > -1, 'still parsed once, so data/view reach the handler as on a swap');
        assert.equal((a.match(/else if \( sendCtx\.target \) \{/g) || []).length, 1, 'the declared-target fork is the else of that branch');
    });
    it('applySwap: beforeswap sees the report and the payload carries it — only when the server overrode something', function () {
        assert.ok(/var beforeDetail = \{ target: \$el, content: content, strategy: strategy, select: sendCtx\.select \};\s*\n\s*if \( sendCtx\.overrides \) \{\s*\n\s*beforeDetail\.overrides = sendCtx\.overrides;/.test(a),
            'the detail gains `overrides` when set');
        assert.ok(a.indexOf("triggerEvent(gina, $target, 'beforeswap.' + id, beforeDetail);") > -1, 'the emit uses the built detail');
        assert.ok(/if \( sendCtx\.overrides \) \{\s*\n\s*payload\.overrides = sendCtx\.overrides;/.test(a), 'the payload gains `overrides` when set');
        assert.equal((a.match(/overrides\s*:\s*/g) || []).length, 1, 'the only literal `overrides:` key is the refused payload — applySwap adds it conditionally, never unconditionally');
    });
    it('the legacy (target-less, popin-less) path attaches the report; the popin path never touches it', function () {
        var attach = a.indexOf("if ( !sendCtx.target && sendCtx.overrides && typeof(result.overrides) == 'undefined' ) {");
        var oobLegacy = a.indexOf("if ( !sendCtx.target && typeof(result.content) == 'string' && result.content.indexOf('data-gina-swap-oob') > -1 ) {");
        // the first success record AFTER the attach block (earlier branches record their own)
        var success = a.indexOf('$form.eventData.success = result;', attach);
        assert.ok(attach > -1 && oobLegacy > -1 && oobLegacy < attach && success > attach, 'after the legacy oob hook, before the success record');
        // the popin branch ends at its own finalize + return; a slice running to the shared
        // tail's success emit would cross the legacy attach block above and read its own needle
        var from = a.indexOf('$popin.loadContent('), to = a.indexOf('finalizeSelfReplacement($target, id);', from);
        var branch = ( from > -1 && to > from ) ? a.slice(from, to) : '';
        assert.ok(branch.indexOf('result = XHRData ||') > -1, 'the popin branch slice is located (slice control)');
        assert.equal(branch.indexOf('overrides'), -1, 'the parsed popin data is delivered verbatim — no report injected');
    });
});

describe('§11 gh#76 §7 request coordination — the decisions, extracted', function () {
    function scene(html) {
        var w = win(html || '<ul id="list"><li id="row"><form id="f"><fieldset id="fs"><input id="in"></fieldset></form></li><li id="other">o</li></ul><div id="totals">t0</div><button id="save">s</button>');
        assert.ok(srcSync, 'the coordination helpers are declared in the source (extraction control — red on a pre-C3 source)');
        w.eval('window.__sync = (function(){ var envIsDev = false;'
            + ' var SYNC_STRATEGIES = ' + (srcSync && srcSync.strategies) + ';'
            + ' var REPLACING_SWAPS = ' + (srcSync && srcSync.replacing) + '; '
            + srcSync.refs + ' ' + srcResolve + ' '
            + srcSync.parse + ' ' + srcSync.derive + ' ' + srcSync.decide + ' ' + srcSync.queue + ' ' + srcSync.shift + ' '
            + srcSync.key + ' ' + srcSync.elts + ' ' + srcSync.disable + ' ' + srcSync.release
            + ' return { parseSync: parseSync, deriveSync: deriveSync, decideSync: decideSync, queueSyncSend: queueSyncSend,'
            + ' shiftSyncQueue: shiftSyncQueue, resolveSyncKey: resolveSyncKey, resolveDisabledElts: resolveDisabledElts,'
            + ' disableForRequest: disableForRequest, releaseDisabledElts: releaseDisabledElts, refs: disabledRefs }; }());');
        return w;
    }
    /** the form, with the attributes an arm wants on it */
    function form(w, attrs) {
        var $f = w.document.getElementById('f'), k = null;
        for (k in (attrs || {})) { $f.setAttribute(k, attrs[k]); }
        return $f;
    }

    // ---------------------------------------------------------------- the derived default
    it('deriveSync: a REPLACING swap into a declared target coordinates on that target — with no attribute at all', function () {
        var w = scene(), s = w.__sync;
        ['innerHTML', 'outerHTML', 'textContent', 'delete'].forEach(function (swap) {
            var d = s.deriveSync(form(w, { 'data-gina-form-target': '#list', 'data-gina-form-swap': swap }));
            assert.ok(d, swap + ' coordinates');
            assert.equal(d.strategy, 'replace', swap + ': the newer answer wins');
            assert.equal(d.derived, true);
            assert.equal(d.key, w.document.getElementById('list'), 'keyed on the resolved target');
            assert.equal(d.swap, swap, 'and it reports which strategy derived it');
        });
        // the default swap is innerHTML, so a bare target coordinates too
        w.document.getElementById('f').removeAttribute('data-gina-form-swap');
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': '#list' })).swap, 'innerHTML',
            'no `data-gina-form-swap` means innerHTML, which replaces');
    });
    it('deriveSync: an INSERTING swap, or `none`, coordinates on nothing — both answers land, as they always have', function () {
        var w = scene(), s = w.__sync;
        ['beforebegin', 'afterbegin', 'beforeend', 'afterend', 'none'].forEach(function (swap) {
            assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': '#list', 'data-gina-form-swap': swap })), null,
                swap + ': nothing is overwritten, so there is no conflict to resolve');
        });
    });
    it('deriveSync: no declared target coordinates on nothing — the module-wide one-at-a-time rule is untouched', function () {
        var w = scene(), s = w.__sync;
        assert.equal(s.deriveSync(w.document.getElementById('f')), null);
        // and adding only a swap strategy changes nothing: the key is the TARGET
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-swap': 'outerHTML' })), null);
    });
    it('deriveSync: a target that does not resolve, or a swap the pre-flight would refuse, coordinates on nothing', function () {
        var w = scene(), s = w.__sync;
        // a submit already on its way to a refusal must never abort a running request first
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': '#nowhere' })), null, 'unresolvable target');
        form(w, { 'data-gina-form-target': '#list' });
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': 'next li' })), null, 'a reserved keyword');
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': '#list', 'data-gina-form-swap': 'INNERHTML' })), null,
            'the pre-flight compares case-sensitively and would refuse this — so it must not coordinate here');
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': '#list', 'data-gina-form-swap': 'replace' })), null,
            'not a swap strategy at all');
        // CONTROL: the same scene with a swap the pre-flight accepts DOES coordinate
        assert.ok(s.deriveSync(form(w, { 'data-gina-form-target': '#list', 'data-gina-form-swap': 'innerHTML' })));
    });
    it('deriveSync: the grammar is the target grammar, so `this` / `closest` / `find` all key correctly', function () {
        var w = scene(), s = w.__sync, $f = w.document.getElementById('f');
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': 'this' })).key, $f);
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': 'closest li' })).key.id, 'row');
        assert.equal(s.deriveSync(form(w, { 'data-gina-form-target': 'find fieldset' })).key.id, 'fs');
    });

    // ---------------------------------------------------------------- the explicit override
    it('parseSync: the three strategies, case and space tolerant', function () {
        var s = scene().__sync;
        assert.deepEqual(plain(s.parseSync('drop')),    { strategy: 'drop' });
        assert.deepEqual(plain(s.parseSync('replace')), { strategy: 'replace' });
        assert.deepEqual(plain(s.parseSync('queue')),   { strategy: 'queue' });
        assert.deepEqual(plain(s.parseSync('  QUEUE ')), { strategy: 'queue' });
    });
    it('parseSync: `abort` is REFUSED, and the message names both the reason and what to write instead', function () {
        var s = scene().__sync;
        ['abort', 'abort last', '  ABORT  '].forEach(function (v) {
            var e = s.parseSync(v).error;
            assert.ok(e, v + ' is refused');
            assert.match(e, /side effects/, 'the reason');
            assert.match(e, /`replace`/,    'the alternative');
            assert.match(e, /`drop`/,       'and the other one');
        });
        assert.equal(typeof(s.parseSync('abort').strategy), 'undefined');
    });
    it('parseSync: a `queue` modifier is REFUSED — one submit waits per region, the most recent', function () {
        var s = scene().__sync;
        ['queue first', 'queue last', 'queue all', 'drop first'].forEach(function (v) {
            var e = s.parseSync(v).error;
            assert.ok(e, v + ' is refused');
            assert.match(e, /takes no modifier/);
            assert.match(e, /most recent/, 'and says what happens instead');
        });
    });
    it('parseSync: `<selector>:<strategy>` is REFUSED — gina already knows the key', function () {
        var s = scene().__sync;
        assert.match(s.parseSync('#list:drop').error, /the key is the resolved `data-gina-form-target`/);
        assert.match(s.parseSync('closest form:replace').error, /nothing to name/);
        assert.equal(typeof(s.parseSync('#list:drop').strategy), 'undefined');
    });
    it('parseSync: an unknown strategy, an empty or non-string value all error', function () {
        var s = scene().__sync;
        assert.match(s.parseSync('replace-all').error, /unknown strategy/);
        assert.match(s.parseSync('   ').error, /empty value/);
        assert.match(s.parseSync(null).error, /empty value/);
        // the message enumerates what IS accepted
        assert.match(s.parseSync('nope').error, /drop, replace, queue/);
    });

    it('decideSync: with the key FREE every strategy proceeds', function () {
        var s = scene().__sync;
        ['drop', 'replace', 'queue'].forEach(function (strategy) {
            var d = s.decideSync({ strategy: strategy }, null);
            assert.equal(d.action, 'proceed', strategy + ' proceeds when nothing owns the key');
            assert.equal(!!d.abortPrevious, false);
        });
        assert.equal(s.decideSync({ strategy: 'drop' }, { xhr: null, queue: [] }).action, 'proceed', 'an entry with no xhr is not busy');
    });
    it('decideSync: with the key BUSY — drop yields, replace takes it, queue defers; the ARRIVING submit decides', function () {
        var s = scene().__sync, busy = { xhr: {}, queue: [] };
        assert.equal(s.decideSync({ strategy: 'drop' }, busy).action, 'drop');
        var r = s.decideSync({ strategy: 'replace' }, busy);
        assert.equal(r.action, 'proceed'); assert.equal(r.abortPrevious, true);
        assert.equal(s.decideSync({ strategy: 'queue' }, busy).action, 'queue');
        // the derived default is a `replace` like any other — nothing is carried on the entry
        var d = s.decideSync({ strategy: 'replace', derived: true }, busy);
        assert.equal(d.action, 'proceed'); assert.equal(d.abortPrevious, true);
    });

    it('queueSyncSend: exactly one submit waits per key — the most recent replaces the one waiting', function () {
        var s = scene().__sync, e = { xhr: {}, queue: [] };
        var a1 = function () {}, a2 = function () {};
        s.queueSyncSend(e, a1);
        assert.deepEqual([e.queue.length, e.queue[0]], [1, a1]);
        s.queueSyncSend(e, a2);
        assert.deepEqual([e.queue.length, e.queue[0]], [1, a2], 'what the user asked for last is what they meant');
        var fresh = { xhr: {} };
        s.queueSyncSend(fresh, a1);
        assert.deepEqual([fresh.queue.length, fresh.queue[0]], [1, a1], 'a queue-less entry gets one');
    });
    it('shiftSyncQueue: runs the waiting submit once the slot is free, and never while it is still owned', function () {
        var s = scene().__sync, ran = [];
        var e = { xhr: {}, queue: [function () { ran.push(1); }] };
        s.shiftSyncQueue(e);
        assert.deepEqual(ran, [], 'still owned — nothing shifts');
        e.xhr = null;
        s.shiftSyncQueue(e);
        assert.deepEqual(ran, [1]);
        assert.equal(e.queue.length, 0);
        s.shiftSyncQueue(e); assert.deepEqual(ran, [1], 'an empty queue is a no-op');
        s.shiftSyncQueue(null); s.shiftSyncQueue({});
    });
    it('shiftSyncQueue: a queued submit that throws is contained — the settle it runs in must not be derailed', function () {
        var s = scene().__sync, after = 0;
        var e = { xhr: null, queue: [function () { throw new Error('boom'); }] };
        s.shiftSyncQueue(e);
        after = 1;
        assert.equal(after, 1);
        assert.equal(e.queue.length, 0, 'and it is still consumed, never retried forever');
    });

    it('resolveSyncKey: the resolved swap target when one is declared, the FORM when none is — the explicit path`s key', function () {
        var w = scene(), s = w.__sync, $f = w.document.getElementById('f');
        assert.equal(s.resolveSyncKey($f), $f, 'no attribute → the form itself');
        $f.setAttribute('data-gina-form-target', '#list');
        assert.equal(s.resolveSyncKey($f), w.document.getElementById('list'));
        $f.setAttribute('data-gina-form-target', 'closest li');
        assert.equal(s.resolveSyncKey($f).id, 'row');
        $f.setAttribute('data-gina-form-target', '#nowhere');
        assert.equal(s.resolveSyncKey($f), $f, 'unresolvable → the form (that submit is refused a few lines later anyway)');
    });

    // ---------------------------------------------------------------- disabled-elt
    it('resolveDisabledElts: a comma list in the target grammar, de-duplicated, in order', function () {
        var w = scene(), s = w.__sync, $f = w.document.getElementById('f');
        var ids = function (r) { return plain(Array.prototype.map.call(r.elements, function (e) { return e.id; })); };
        assert.deepEqual(ids(s.resolveDisabledElts($f, 'closest li, #save , find #in')), ['row', 'save', 'in']);
        assert.deepEqual(ids(s.resolveDisabledElts($f, '#save, #save')), ['save'], 'named twice, held once');
        assert.equal(s.resolveDisabledElts($f, 'this').elements[0], $f);
    });
    it('resolveDisabledElts: an unresolvable part is an ERROR naming the part — never a silent skip (htmx skips)', function () {
        var w = scene(), s = w.__sync, $f = w.document.getElementById('f');
        assert.match(s.resolveDisabledElts($f, '#save, #nope').error, /`#nope`: no element matches/);
        assert.match(s.resolveDisabledElts($f, 'next li').error, /reserved/);
        assert.match(s.resolveDisabledElts($f, '#save, ').error, /empty part at position 2/);
        assert.match(s.resolveDisabledElts($f, '   ').error, /empty value/);
        assert.equal(typeof(s.resolveDisabledElts($f, '#nope').elements), 'undefined');
    });
    it('disableForRequest / releaseDisabledElts: refcounted, so overlapping requests naming one element release it once', function () {
        var w = scene(), s = w.__sync, $fs = w.document.getElementById('fs');
        assert.equal(s.disableForRequest($fs, 'a'), true);
        assert.equal($fs.getAttribute('disabled'), '');
        assert.equal($fs.getAttribute('data-gina-disabled-by'), 'a');
        assert.equal(s.disableForRequest($fs, 'b'), true, 'a second request holds it too');
        assert.equal($fs.getAttribute('data-gina-disabled-by'), 'a', 'provenance stays with the first holder');
        s.releaseDisabledElts([$fs]);
        assert.equal($fs.hasAttribute('disabled'), true, 'one holder left — still held');
        s.releaseDisabledElts([$fs]);
        assert.equal($fs.hasAttribute('disabled'), false);
        assert.equal($fs.hasAttribute('data-gina-disabled-by'), false);
    });
    it('disableForRequest: an element the PAGE disabled is left alone and never counted, so we can never clear a state we did not set', function () {
        var w = scene(), s = w.__sync, $save = w.document.getElementById('save');
        $save.setAttribute('disabled', 'disabled');
        assert.equal(s.disableForRequest($save, 'a'), false, 'not ours to hold');
        assert.equal(s.refs.has($save), false, 'and not counted');
        s.releaseDisabledElts([$save]);
        assert.equal($save.hasAttribute('disabled'), true, 'the page keeps its own disabled state');
    });
    it('releaseDisabledElts: nothing to release is a no-op, and a marker-less element is never stripped', function () {
        var w = scene(), s = w.__sync, $save = w.document.getElementById('save');
        s.releaseDisabledElts(null); s.releaseDisabledElts([]);
        $save.setAttribute('disabled', '');
        s.releaseDisabledElts([$save]);
        assert.equal($save.hasAttribute('disabled'), true, 'no `data-gina-disabled-by` ⇒ not ours');
    });
});

describe('§12 gh#76 §7 wiring pins', function () {
    var a = active(valSrc);

    it('`abort` is a registered event, placed so the slice-2/3 contiguous run stays intact; there is no declarative twin', function () {
        assert.ok(/'uploadProgress',[^\n]*\n\s*'abort',[^\n]*\n\s*'submit',/.test(a), '`abort` registered after uploadProgress');
        assert.equal((a.match(/'abort\.' \+ id/g) || []).length, 1, 'exactly one abort emit');
        assert.equal(a.indexOf("'abort.' + id + '.hform'"), -1,
            'a deliberate abort has NO declarative channel — it must never reach data-gina-form-event-on-submit-error');
    });
    it('every helper is declared exactly once, all of them ahead of send()', function () {
        var sendIdx = a.indexOf('var send = function(data, options) {');
        assert.ok(sendIdx > -1, 'send() located (slice control)');
        ['parseSync', 'deriveSync', 'decideSync', 'queueSyncSend', 'shiftSyncQueue', 'resolveSyncKey', 'resolveDisabledElts', 'disableForRequest', 'releaseDisabledElts', 'syncNotice'].forEach(function (name) {
            var re = new RegExp('^[ \\t]*var ' + name + ' = function\\(', 'mg');
            assert.equal((a.match(re) || []).length, 1, name + ' declared once');
            assert.ok(a.indexOf('var ' + name + ' = function(') < sendIdx, name + ' precedes send()');
        });
        assert.ok(/^[ \t]*var syncRegistry = new WeakMap\(\);/m.test(a) && /^[ \t]*var disabledRefs = new WeakMap\(\);/m.test(a), 'both registries are WeakMaps');
    });

    it('the DEFAULT is derived: no attribute falls through to deriveSync, and the derived key is used as-is', function () {
        assert.ok(/if \( syncAttr !== null \) \{\s*\n\s*syncParsed = parseSync\(syncAttr\);\s*\n\s*\} else \{\s*\n\s*syncParsed = deriveSync\(\$target\);\s*\n\s*\}/.test(a),
            'the explicit attribute is the override; its absence derives');
        assert.equal((a.match(/syncParsed = deriveSync\(\$target\);/g) || []).length, 1);
        assert.ok(/var syncKey\s+= syncParsed\.key \|\| resolveSyncKey\(\$target\);/.test(a),
            'the derived path carries its already-resolved key — the explicit one resolves its own');
    });
    it('the derived default classifies on REPLACING_SWAPS only — the four that overwrite, never the insertions', function () {
        assert.ok(/^[ \t]*var REPLACING_SWAPS = \['innerHTML', 'outerHTML', 'textContent', 'delete'\];/m.test(a));
        // every replacing name is one the pre-flight also accepts — a value it would refuse
        // must never reach the registry
        var swaps = (a.match(/^[ \t]*var SWAP_STRATEGIES = \[([^\]]+)\];/m) || [])[1];
        assert.ok(swaps, 'SWAP_STRATEGIES located (slice control)');
        ['innerHTML', 'outerHTML', 'textContent', 'delete'].forEach(function (s) {
            assert.ok(swaps.indexOf("'" + s + "'") > -1, s + ' is a real swap strategy');
        });
        assert.ok(/REPLACING_SWAPS\.indexOf\(strategy\) < 0/.test(a), 'and the classification is a membership test, not a regex');
    });
    it('the trimmed vocabulary: three strategies, and the three htmx spellings are refused by name', function () {
        assert.ok(/^[ \t]*var SYNC_STRATEGIES = \['drop', 'replace', 'queue'\];/m.test(a), 'no `abort`');
        assert.equal(a.indexOf("'first', 'last', 'all'"), -1, 'no queue modifiers');
        assert.ok(/\/\^abort\\b\/\.test\(v\)/.test(a), '`abort` is refused explicitly, not by falling through to "unknown"');
        assert.ok(/v\.indexOf\(':'\) > -1/.test(a), '`<selector>:<strategy>` is refused');
        assert.ok(/takes no modifier/.test(a), 'a modifier is refused');
        // each refusal names an alternative, not just a complaint
        assert.ok(/use `replace` to let the newer submit take over, or `drop` to yield/.test(a));
        assert.ok(/the key is the resolved `data-gina-form-target`/.test(a));
    });
    it('the module-wide rate-limit gate YIELDS when the form declares its own coordination', function () {
        assert.ok(/if \(\s*syncAttr === null\s*&& \(\s*\/\^true\$\/i\.test\(options\.withRateLimit\)/.test(a),
            'the gate is conditioned on the attribute being absent');
        assert.equal((a.match(/var syncAttr = \$target\.getAttribute\('data-gina-form-sync'\);/g) || []).length, 1);
        assert.ok(a.indexOf("var syncAttr = $target.getAttribute('data-gina-form-sync');") < a.indexOf('/^true$/i.test(options.withRateLimit)'),
            'read before the gate consults it');
        // and the DERIVED default runs AFTER that gate, so a form that declares nothing keeps
        // the one-at-a-time rule it has always had for its own re-submits
        assert.ok(a.indexOf('/^true$/i.test(options.withRateLimit)') < a.indexOf('syncParsed = deriveSync($target);'),
            'derivation is downstream of the rate limit, never a replacement for it');
    });
    it('the decision runs BEFORE `isSending` is claimed — a `replace` abort settles synchronously and would clear the new cycle', function () {
        var hForm    = a.indexOf("hFormIsRequired = ( $target.getAttribute('data-gina-form-event-on-submit-success')");
        var decision = a.indexOf('var syncDecision = decideSync(syncParsed, syncRegistry.get(syncKey));');
        var owned    = a.indexOf('var ownedByEarlierSend = ');
        var claim    = a.indexOf('instance.$forms[id].isSending = true;');
        assert.ok(hForm > -1 && decision > hForm, 'hFormIsRequired is decided first, so the gate below can read it');
        assert.ok(decision < owned && owned < claim, 'decision < ownedByEarlierSend < the claim');
        assert.ok(a.indexOf('syncEntry.xhr.abort();') < claim, 'the abort is inside the decision, above the claim');
        assert.ok(a.indexOf('armSubmitLoading(instance.$forms[id], $submitTrigger);') > a.indexOf('syncEntry.xhr.abort();'),
            'the replacing send takes the loading state over, after the abort released it');
    });
    it('exactly ONE submit is ever turned away, and it releases the loading state it owns — a queued one keeps it', function () {
        // #B247 ownership, re-derived for a target key. `drop` is now the only turn-away:
        // `queue` always waits, `replace` always proceeds.
        assert.equal((a.match(/if \( !\( \/\^true\$\/i\.test\(instance\.\$forms\[id\]\.isSending\) \|\| \/\^true\$\/i\.test\(\$form\.isSending\) \) \) \{\s*\n\s*disarmSubmitLoading\(\$form\);\s*\n\s*\}/g) || []).length, 1,
            'the `drop` turn-away releases, gated on ownership');
        var queued = a.indexOf("syncNotice(id, 'submit queued");
        var retrn  = a.indexOf('return;', queued);
        assert.ok(queued > -1 && retrn > queued);
        assert.equal(a.slice(queued, retrn).indexOf('disarmSubmitLoading'), -1, 'a queued submit keeps its loading state');
    });
    it('the sendCtx literal is UNCHANGED — every slice-4 field is assigned lazily', function () {
        assert.ok(a.indexOf("var sendCtx = { popin: null, target: null, swap: 'innerHTML', select: null, targetAttr: null, rebindSelf: false };") > -1);
        ['sync', 'syncDerived', 'syncKey', 'superseded', 'disabledElts'].forEach(function (k) {
            assert.ok(a.indexOf('sendCtx.' + k) > -1, 'sendCtx.' + k + ' is set outside the literal');
        });
        assert.equal(a.indexOf('syncAbortable'), -1, '`abortable` and its single reader are gone with `abort`');
        assert.equal(a.indexOf('claimed.abortable'), -1);
    });
    it('`data-gina-form-disabled-elt` resolves OUTSIDE the slice-2 refusal window and before any xhr.open', function () {
        var cap    = a.indexOf("var targetAttr = $target.getAttribute('data-gina-form-target');");
        var upload = a.indexOf('var isUploadXhr = /^gina\\-upload/i.test(id);');
        var dis    = a.indexOf("var disabledAttr = $target.getAttribute('data-gina-form-disabled-elt');");
        var open   = a.indexOf('xhr.open(options.method, options.url');
        assert.ok(cap > -1 && upload > cap && dis > upload, 'after the upload marker — the §06 return-count window is untouched');
        assert.equal(a.slice(cap, upload).indexOf('data-gina-form-disabled-elt'), -1);
        assert.ok(open > dis, 'and before the request is opened, so a refusal can never strand a disabled control');
        assert.ok(/refuseSend\(\$form, \$target, id, hFormIsRequired, 'data-gina-form-disabled-elt', disabledAttr, resolvedDisabled\.error, ownedByEarlierSend\);/.test(a),
            'an unresolvable part refuses the submit through the shared refusal');
    });
    it('an unreadable sync value is DEFERRED to the pre-flight, where the declared error callback is bound', function () {
        var listen = a.indexOf('listenToXhrEvents($form);');
        var upload = a.indexOf('var isUploadXhr = /^gina\\-upload/i.test(id);');
        var refuse = a.indexOf("refuseSend($form, $target, id, hFormIsRequired, 'data-gina-form-sync', syncAttr, syncParsed.error, ownedByEarlierSend);");
        var decide = a.indexOf('var syncDecision = decideSync(syncParsed, syncRegistry.get(syncKey));');
        assert.ok(listen > -1 && refuse > listen, 'delivered only once the declared channels are bound');
        assert.ok(refuse > upload, 'and outside the `-target`/`-swap` refusal window');
        assert.ok(decide > -1 && decide < listen, 'while the DECISION still runs up top, before isSending');
        assert.ok(/if \( syncParsed && !syncParsed\.error \) \{/.test(a), 'an unreadable value decides nothing');
        assert.equal((a.match(/'data-gina-form-sync', syncAttr, syncParsed\.error/g) || []).length, 1, 'exactly one sync refusal');
        // the gate has already yielded on the attribute being PRESENT, so an unreadable value
        // can never be swallowed by the rate limit before reaching that refusal
        assert.ok(/if \(\s*syncAttr === null\s*&& \(/.test(a));
        // a DERIVED result never carries an error — deriveSync returns a decision or nothing
        assert.ok(/return \{ strategy: 'replace', derived: true, key: resolved\.target, swap: strategy \};/.test(a));
    });
    it('the slot is claimed on the line AFTER each xhr.send — never before, or a request that never leaves wedges the key', function () {
        assert.equal((a.match(/claimSyncSlot\(\);/g) || []).length, 3, 'one per xhr.send site inside send()');
        assert.equal((a.match(/xhr\.send\([^)]*\)[;]?\s*\n\s*claimSyncSlot\(\);/g) || []).length, 3, 'each immediately follows its send');
        assert.ok(/var claimSyncSlot = function\(\) \{/.test(a));
        assert.ok(a.indexOf('var claimSyncSlot = function() {') < a.indexOf('claimSyncSlot();'), 'declared before it is called');
    });
    it('the settle chokepoint releases, frees the slot on XHR identity, and does NOT shift a superseded queue', function () {
        assert.equal((a.match(/releaseDisabledElts\(sendCtx\.disabledElts\);/g) || []).length, 2,
            'the loadend chokepoint AND the one other exit after the pre-flight (the binary branch error)');
        assert.ok(/if \( settledEntry && settledEntry\.xhr === xhr \) \{/.test(a), 'a late settle can never evict a newer request');
        assert.ok(/if \( !sendCtx\.superseded \) \{\s*\n\s*shiftSyncQueue\(settledEntry\);/.test(a),
            'a superseded settle leaves the queue to the request that replaced it');
        var loadend = a.indexOf("xhr.addEventListener('loadend', function onSendSettled() {");
        var release = a.indexOf('releaseSubmitA11y($form, $submitTrigger);', loadend);
        assert.ok(loadend > -1 && release > loadend && a.indexOf('releaseDisabledElts(sendCtx.disabledElts);', release) > release,
            'inside the fail-safe, after the existing releases');
    });
    it('a superseded request runs its RELEASE arms and skips its DISPATCH arms — the #B447 false 408 must not fire', function () {
        assert.ok(/xhr\.onreadystatechange = function onValidationCallback\(event\) \{\s*if \( !sendCtx\.superseded \) \{\s*\$form\.isSubmitting = false;\s*\}/.test(a),
            'the handler-top latch clear is guarded (#B332 class)');
        assert.equal((a.match(/releaseSubmitA11y\(\$form, \$submitTrigger\);/g) || []).length, 2, 'both release sites located (slice control)');
        var rel2  = a.lastIndexOf('releaseSubmitA11y($form, $submitTrigger);');
        var guard = a.indexOf('if ( sendCtx.superseded ) {', rel2);
        var ctype = a.indexOf('var contentType     = xhr.getResponseHeader("Content-Type");');
        assert.ok(guard > rel2 && ctype > guard, 'release block < the superseded guard < the contentType read');
        var block = a.slice(guard, ctype);
        assert.ok(/status  : 0,/.test(block) && /reason  : 'superseded',/.test(block) && /sync    : sendCtx\.sync \|\| null,/.test(block), 'the abort payload shape');
        assert.ok(/derived : !!sendCtx\.syncDerived/.test(block),
            'and it says whether the rule was declared or derived — a page may find nothing in its own markup that asked for this');
        assert.ok(/\n\s*return;\n/.test(block), 'and it returns before any status dispatch');
        var transport = a.indexOf("'transportError': true,");
        assert.ok(transport > guard, 'the #B447 transport arm it must never reach is below');
    });
});

describe('§11 applyResponseOverrides — the same-origin gate (gh#76 §6), extracted', function () {
    /** A settled transport at a chosen `responseURL`; `undefined` leaves the property ABSENT. */
    function xhrAt(responseURL, headers) {
        var map = {};
        Object.keys(headers || {}).forEach(function (k) { map[k.toLowerCase()] = headers[k]; });
        var x = { getResponseHeader: function (name) { var v = map[String(name).toLowerCase()]; return ( typeof(v) == 'undefined' ) ? null : v; } };
        if ( typeof(responseURL) != 'undefined' ) { x.responseURL = responseURL; }
        return x;
    }
    var HTML = '<ul id="list"><li id="row" class="r"><form id="f"><span class="in">i</span></form></li></ul><div id="totals">t0</div>';
    function build(w) {
        assert.ok(srcOverrides, 'applyResponseOverrides is declared in the source (extraction control)');
        w.eval('window.__applyResponseOverrides = (function(){ var envIsDev = false; var SWAP_STRATEGIES = ' + mStrategies[1] + '; ' + srcResolve + ' ' + srcOverrides + ' return applyResponseOverrides; }());');
        return { w: w, $f: w.document.getElementById('f') };
    }
    function scene() { return build(win(HTML)); }
    /** A document with an OPAQUE origin — jsdom's default `about:blank` page. */
    function opaqueScene() {
        var dom = new JSDOM('<!DOCTYPE html><html><body>' + HTML + '</body></html>', { runScripts: 'outside-only' });
        assert.equal(dom.window.location.origin, 'null', 'control: the document origin is opaque');
        return build(dom.window);
    }
    function ctx(over) {
        var c = { popin: null, target: null, swap: 'innerHTML', select: null, targetAttr: null, rebindSelf: false };
        Object.keys(over || {}).forEach(function (k) { c[k] = over[k]; });
        return c;
    }
    var ALL = { 'X-Gina-Retarget': '#totals', 'X-Gina-Reswap': 'beforeend', 'X-Gina-Reselect': 'li' };
    function refusedAll(r) {
        assert.deepEqual(plain(r), {
            retarget: { value: '#totals',   applied: false, reason: 'crossOrigin' },
            reswap:   { value: 'beforeend', applied: false, reason: 'crossOrigin' },
            reselect: { value: 'li',        applied: false, reason: 'crossOrigin' }
        });
    }

    it('CONTROL — a same-origin answer (the jsdom page is http://localhost) applies all three', function () {
        var s = scene(), c = ctx({ target: s.w.document.getElementById('row'), targetAttr: '#row' });
        var r = s.w.__applyResponseOverrides(xhrAt('http://localhost/x76/save', ALL), c, s.$f, 'f');
        assert.deepEqual(plain(r), { retarget: { value: '#totals', applied: true }, reswap: { value: 'beforeend', applied: true }, reselect: { value: 'li', applied: true } });
        assert.equal(c.target.id, 'totals'); assert.equal(c.swap, 'beforeend'); assert.equal(c.select, 'li');
    });
    it('a cross-origin answer carrying all three: every one refused as crossOrigin — the Retarget drops the target (no swap), Reswap/Reselect keep the declared values', function () {
        var s = scene(), c = ctx({ target: s.w.document.getElementById('row'), targetAttr: '#row', swap: 'outerHTML', select: '.r' });
        var r = s.w.__applyResponseOverrides(xhrAt('http://127.0.0.1/x76/save', ALL), c, s.$f, 'f');
        refusedAll(r);
        assert.equal(c.target, null, 'the target is dropped — the refused-Retarget branch at settle keys on applied:false');
        assert.equal(c.targetAttr, 'X-Gina-Retarget', 'and the header is named as the attribute that failed');
        assert.equal(c.swap, 'outerHTML'); assert.equal(c.select, '.r');
        assert.equal(c.overrides, r, 'stored on the capture');
    });
    it('a cross-origin answer carrying ONLY Reswap/Reselect: ignored as crossOrigin, the declared target and values stand — no retarget entry, so the settle fork proceeds', function () {
        var s = scene(), row = s.w.document.getElementById('row'), c = ctx({ target: row, targetAttr: '#row', select: 'li' });
        var r = s.w.__applyResponseOverrides(xhrAt('http://127.0.0.1/x76/save', { 'X-Gina-Reswap': 'delete', 'X-Gina-Reselect': '.in' }), c, s.$f, 'f');
        assert.deepEqual(plain(r), { reswap: { value: 'delete', applied: false, reason: 'crossOrigin' }, reselect: { value: '.in', applied: false, reason: 'crossOrigin' } });
        assert.equal(c.target, row); assert.equal(c.swap, 'innerHTML'); assert.equal(c.select, 'li');
        assert.equal('retarget' in r, false);
    });
    it('a different scheme or port is another origin (https://localhost, http://localhost:8080) — and a redirect target is what responseURL reports', function () {
        var s = scene();
        assert.equal(s.w.__applyResponseOverrides(xhrAt('https://localhost/x76/save', ALL), ctx(), s.$f, 'f').retarget.reason, 'crossOrigin', 'scheme');
        assert.equal(s.w.__applyResponseOverrides(xhrAt('http://localhost:8080/x76/save', ALL), ctx(), s.$f, 'f').retarget.reason, 'crossOrigin', 'port');
        assert.equal(s.w.__applyResponseOverrides(xhrAt('http://localhost/elsewhere?after=redirect', ALL), ctx(), s.$f, 'f').retarget.applied, true, 'a same-origin redirect target still applies');
    });
    it('FAIL-CLOSED — a transport with NO responseURL refuses: the gate cannot place the answer', function () {
        var s = scene(), c = ctx();
        var r = s.w.__applyResponseOverrides(xhrAt(undefined, ALL), c, s.$f, 'f');
        refusedAll(r); assert.equal(c.target, null);
    });
    it('FAIL-CLOSED — an empty responseURL refuses', function () {
        var s = scene(); refusedAll(s.w.__applyResponseOverrides(xhrAt('', ALL), ctx(), s.$f, 'f'));
    });
    it('FAIL-CLOSED — an unparseable or non-string responseURL refuses without throwing', function () {
        var s = scene();
        refusedAll(s.w.__applyResponseOverrides(xhrAt('nonsense://[', ALL), ctx(), s.$f, 'f'));
        refusedAll(s.w.__applyResponseOverrides(xhrAt(123, ALL), ctx(), s.$f, 'f'));
    });
    it('FAIL-CLOSED — an answer whose URL has an opaque origin (about:blank) is not same-origin with an http page', function () {
        var s = scene(); refusedAll(s.w.__applyResponseOverrides(xhrAt('about:blank', ALL), ctx(), s.$f, 'f'));
    });
    it('FAIL-CLOSED — an OPAQUE document (origin "null") never reads an override, even from an answer whose origin is also "null"', function () {
        var s = opaqueScene();
        var r = s.w.__applyResponseOverrides(xhrAt('about:blank', { 'X-Gina-Retarget': '#totals' }), ctx(), s.$f, 'f');
        assert.equal(r.retarget.reason, 'crossOrigin', "'null' === 'null' is not same-origin");
    });
    it('CONTROL — no header at all returns null BEFORE the origin is consulted: a transport that throws on getResponseHeader and has no responseURL still reads as "no header"', function () {
        var s = scene(), c = ctx();
        assert.equal(s.w.__applyResponseOverrides({ getResponseHeader: function () { throw new Error('boom'); } }, c, s.$f, 'f'), null);
        assert.equal('overrides' in c, false);
    });
    it('PIN — the origin read sits after the all-null early return and before any resolveSwapTarget call, and every header present reads crossOrigin', function () {
        var a = active(valSrc);
        var fn      = a.indexOf('var applyResponseOverrides = function(');
        var early   = a.indexOf('if ( retarget === null && reswap === null && reselect === null ) {', fn);
        var origin  = a.indexOf('xhr.responseURL', fn);
        var resolve = a.indexOf('resolveSwapTarget($target, retarget)', fn);
        assert.ok(fn > -1 && early > fn && origin > early && resolve > origin, 'early return < responseURL read < resolver');
        var block = a.slice(origin, resolve);
        assert.equal((block.match(/reason: 'crossOrigin'/g) || []).length, 3, 'one crossOrigin entry per header');
        assert.ok(/docOrigin !== 'null'/.test(block), 'the opaque-document clause');
        assert.ok(/new URL\(resURL, window\.location\.href\)\.origin/.test(block), 'resolved against the page URL');
        assert.ok(/sendCtx\.target\s*=\s*null;/.test(block), 'a refused Retarget drops the target');
    });
});

/**
 * §13 `warnIfOldRuleRouted` — the containment dev warn (gh#76 slice 1).
 *
 * This is arm I of the issue's acceptance table: "attribute absent, not in a popin, a popin
 * active → legacy payload (raw HTML), nothing inserted, dev warn". The first two halves are
 * driven end-to-end by the sibling popin runtime spec (its §02 open / §03 loading); the warn
 * is not, and CANNOT be there — the e2e harness serves `page.environment.envIsDev: 'false'`
 * (test/e2e/runtime-server.js) and that spec's §18 depends on the non-dev scene. So the warn
 * is pinned here, with `envIsDev` injected, exactly as §08 pins `warnOobRefusals`.
 *
 * Both message branches are driven, because the two differ in what they tell the reader the
 * OLD routing rule would have done — replaced the popin's content, or raised a false 422.
 */
describe('§13 warnIfOldRuleRouted — the containment dev warn, extracted', function () {
    function scene(opts) {
        var o = opts || {};
        var w = win('<form id="f"><button>s</button></form>');
        var warns = [];
        w.console.warn = function (m) { warns.push(String(m)); };
        var gina = { popin: o.noPopinPlugin ? null : {
            getActivePopin: function () { return o.active || null; },
            $popins:        o.$popins || {},
            activePopinId:  o.activePopinId || null
        } };
        var fn = w.eval('(function (envIsDev, gina) { ' + srcWarnRouted + ' return warnIfOldRuleRouted; })')(
            ('envIsDev' in o) ? o.envIsDev : true, gina
        );
        fn(o.captured || null, o.routed || null, w.document.getElementById('f'), o.what || 'answer');
        return { warns: warns };
    }

    it('a page form answered while a popin is OPEN: the warn names the form, the popin, and what the old rule would have done', function () {
        var s = scene({ active: { name: 'x76', isOpen: true } });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /\[FormValidator\]\[popin\] the HTML answer of form `#f` is delivered to its own handler/);
        assert.match(s.warns[0], /not inside popin `x76`/);
        assert.match(s.warns[0], /open \(the former routing rule would have replaced its content\)/);
    });

    it('the LOADING branch is reached through `activePopinId` when getActivePopin() is empty, and names the false 422', function () {
        var s = scene({ active: null, $popins: { x76: { name: 'x76', isOpen: false } }, activePopinId: 'x76' });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /loading, not open \(the former routing rule would have raised a false 422 error\)/);
    });

    it('`what` is carried, so the redirect call site reads as a redirect and not as an answer', function () {
        var s = scene({ active: { name: 'x76', isOpen: true }, what: 'redirect' });
        assert.equal(s.warns.length, 1);
        assert.match(s.warns[0], /the HTML redirect of form `#f`/);
    });

    it('CONTROLS — silent outside dev mode, when the answer WAS routed, when a popin WAS captured, with no popin in any state, and with no popin plugin', function () {
        var open = { name: 'x76', isOpen: true };
        assert.deepEqual(scene({ active: open, envIsDev: false }).warns, [], 'the dev-mode gate');
        assert.deepEqual(scene({ active: open, routed: { name: 'x76' } }).warns, [], 'the answer went to a popin — the old rule agreed');
        assert.deepEqual(scene({ active: open, captured: { name: 'x76' } }).warns, [], 'the form was captured inside a popin');
        assert.deepEqual(scene({ active: null }).warns, [], 'no popin in any state');
        assert.deepEqual(scene({ active: open, noPopinPlugin: true }).warns, [], 'no popin plugin on the page');
    });
});
