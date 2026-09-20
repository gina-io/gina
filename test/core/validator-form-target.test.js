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
 * WHAT IT PINS
 *  §06 the wiring: events registered, `sendCtx` shape, the capture placed after
 *      `listenToXhrEvents` and before the upload marker, the settle precedence (declared
 *      target before containment), both popin branches on the tolerant parse with no bare
 *      `.value` dereference left, the tail's `finalizeSelfReplacement`, the declarative
 *      `data-gina-form-event-on-swap` hook bound and unbound, `hFormIsRequired` including
 *      it, and the `on()` wrapper's `beforeswap.` exception.
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
var mStrategies = valSrc.match(/^[ \t]*var SWAP_STRATEGIES = (\[[^\]]+\]);/m);

function win(html) {
    var dom = new JSDOM('<!DOCTYPE html><html><head><script src="http://localhost/js/gina.min.js"></script></head><body>' + (html || '') + '</body></html>', { url: 'http://localhost/page', runScripts: 'outside-only' });
    var w = dom.window;
    // a real dispatch, as triggerEvent does: cancelable CustomEvent, returned to the caller
    w.eval('window.__triggerEvent = function (target, el, name, args) { var evt = new CustomEvent(name, { detail: args, bubbles: true, cancelable: true }); el.dispatchEvent(evt); return evt; };');
    w.eval('window.__parseXhrHtmlAnswer = (function(){ ' + srcParse + ' return parseXhrHtmlAnswer; }());');
    w.eval('window.__resolveSwapTarget = (function(){ ' + srcResolve + ' return resolveSwapTarget; }());');
    return w;
}
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

describe('§06 wiring pins', function () {
    var a = active(valSrc), ae = active(evtSrc);

    it('registers beforeswap and afterswap; SWAP_STRATEGIES carries the nine htmx values', function () {
        // the array lines carry trailing `// #gh76` comments, which active() keeps (it strips whole-line comments only)
        assert.ok(/'error',[^\n]*\n\s*'beforeswap',[^\n]*\n\s*'afterswap',[^\n]*\n\s*'progress',/.test(a));
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
                , from = src.indexOf('$popin.loadContent(result.content);')
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
    it("on(): the wrapper skips cancelEvent for `beforeswap.` events only", function () {
        assert.ok(ae.indexOf("if ( !/^beforeswap\\./.test(e.type) ) {\n                    cancelEvent(e);") > -1);
    });
});
