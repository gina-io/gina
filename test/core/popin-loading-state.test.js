/**
 * gh#76 §8 — the `preOpen` loading shell is an explicit state (`$popin.isLoading`)
 *
 * A `preOpen: true` popin shows its loading shell — a dialog born modal with a skeleton
 * inside — from the moment its XHR is issued until the content lands and popinOpen runs.
 * That window used to be a half-state the plugin could not name: the DOM said open,
 * `isOpen` said closed, and every path keyed on `isOpen` misfired —
 *   (i)   `loadContent()` on the popin threw `is not open !` for the whole round trip;
 *   (ii)  `close()` returned early on `!isOpen`, so the shell was un-closeable;
 *   (iii) a non-2xx load fired `error` and tore nothing down — a spinner nobody could dismiss;
 *   (iv)  the native `close` listener was bound only in popinOpen, so an Escape on the shell
 *         closed the dialog with the plugin's state stale, and the content landing afterwards
 *         ran popinOpen and RE-OPENED the dialog the user had just dismissed;
 *   (v)   popinClose's teardown keys on the `gina-popin-is-active` class, which a dialog
 *         shell never carries, so bypassing (ii) alone would still skip the teardown.
 *
 * The fix: `isLoading` (set where the shell is shown, cleared by popinOpen and by the loading
 * close), a per-popin load sequence plus the in-flight transport (`_loadSeq` / `_loadXhr`) so
 * that a close during the load is FINAL — the landing result is dropped, a transport still in
 * flight is aborted and its settle fires no `error` — `closeLoadingShell` (teardown by the
 * shell's own state, trigger release, `close.<id>`), the native close sync shared between the
 * shell and popinOpen (`bindNativeCloseSync`), and the failure rule: a failed load fires
 * `error` first, then closes the shell unless a listener loaded content into it.
 *
 * 01 executes the four new/changed functions extracted from the REAL source (brace-balanced
 *    extraction seam, jsdom realm, injected collaborators — no replica); 02 pins the wiring
 *    the seam cannot execute (popinLoad's transport handler, popinClose, popinDestroy,
 *    consumePreload, popinOpen); 03 pins the served bundle.
 *
 * Red-first lever: point the file at a pre-change copy of the source and it must go RED —
 *   GINA_POPIN_SRC=<path to `git show <rev>:framework/v<ver>/core/asset/plugin/src/vendor/gina/popin/main.js`> \
 *     node --test test/core/popin-loading-state.test.js
 * — every 01 arm fails at extraction (the functions do not exist there) and every 02 pin
 * fails, the one labelled CONTROL excepted: it is true on both revisions by design, so a run
 * in which it too went red would be reading the wrong file, not the wrong code.
 *
 * Usage: node --test test/core/popin-loading-state.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var FW = require('../fw');
var POPIN_SRC   = process.env.GINA_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_JS = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var _src, _distSrc, _distMinSrc;
function getSrc()        { return _src        || (_src        = fs.readFileSync(POPIN_SRC, 'utf8')); }
function getDistSrc()    { return _distSrc    || (_distSrc    = fs.readFileSync(DIST_JS, 'utf8')); }
function getDistMinSrc() { return _distMinSrc || (_distMinSrc = fs.readFileSync(DIST_MIN_JS, 'utf8')); }

/**
 * extract — the source text of ONE module-level inner function, by name: anchored on its
 * declaration line (`^[ \t]*function <name>(`, which must be unique) and sliced by brace
 * balance. The popin module carries no `// EO <name>` markers, so brace balance is the seam;
 * a declaration that is missing or not unique throws — the red a pre-change source produces.
 *
 * @param {string} name
 * @returns {string}
 */
function extract(name) {
    var src = getSrc();
    var re = new RegExp('^[ \\t]*function ' + name + '\\(', 'mg');
    var m = re.exec(src);
    if (!m) throw new Error('declaration missing: ' + name);
    if (re.exec(src)) throw new Error('declaration not unique: ' + name);
    var i = m.index, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    if (!started || depth !== 0) throw new Error('unbalanced braces: ' + name);
    return src.slice(m.index, i);
}

var SHELL = '<div class="gina-popin-skeleton" aria-hidden="true"></div>';

/**
 * scene — a jsdom realm plus the four functions under test, bound to injected collaborators.
 * The dialog scene is `<div id="c"><dialog id="p1"></dialog></div>` (the container and its
 * dialog); the non-dialog scene nests `<div id="p1">` in a `.gina-popins-overlay`, as
 * popinLoad builds it. The popin object carries the proto fields the functions read.
 *
 * @param {object} [opts] - { dialog: useDialogMode (default true), preOpen (default true) }
 * @returns {object} { w, d, $el, $popin, instance, log, fns }
 */
function scene(opts) {
    opts = opts || {};
    var dialogMode = opts.dialog !== false;
    var html = dialogMode
        ? '<!DOCTYPE html><html><body><div id="c"><dialog id="p1"></dialog></div><button id="t1">open</button></body></html>'
        : '<!DOCTYPE html><html><body><div id="c"><div id="ov" class="gina-popins-overlay"><div id="p1"></div></div></div><button id="t1">open</button></body></html>';
    var dom = new JSDOM(html, { runScripts: 'outside-only' });
    var w = dom.window, d = w.document;
    var $el = d.getElementById('p1');
    // jsdom implements neither showModal() nor close() on <dialog>: minimal stand-ins that
    // keep the `open` attribute honest and fire the native `close` event the plugin listens
    // to. They fire it SYNCHRONOUSLY where a real engine queues it — the harsher order for
    // the "state cleared before the native close" invariant, so it is the one exercised.
    if (dialogMode) {
        $el.showModal = function () { this.setAttribute('open', ''); };
        $el.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
    }
    var log = [];
    var instance = { activePopinId: null, target: d.getElementById('c') };
    var self = { options: { useDialogMode: dialogMode } };
    var $popin = {
        id: 'p1', name: 'P', openTrigger: 't1',
        options: { preOpen: opts.preOpen !== false },
        isOpen: false, isLoading: false, _loadSeq: 0, _loadXhr: null, isRedirecting: false,
        target: instance.target
    };
    instance.$popins = { p1: $popin };
    var late = {};
    var inj = {
        self: self, instance: instance, document: d, window: w, gina: {},
        GINA_DEFAULT_LOADING_SHELL: SHELL,
        releasePopinTrigger: function ($t) { log.push(['release', $t && $t.id]); },
        setActivePopinId: function (id) { instance.activePopinId = id; log.push(['active', id]); },
        triggerEvent: function (g, el, name) { log.push(['event', name]); return { defaultPrevented: false }; },
        popinClose: function (name) { log.push(['popinClose', name]); if (late.close) { late.close(name); } },
        popinOpen: function (name) { log.push(['popinOpen', name]); $popin.isOpen = true; $popin.isLoading = false; $popin.target = $el; },
        popinUnbind: function () { log.push(['unbind']); },
        popinBind: function () { log.push(['bind']); },
        refreshCSS: function () {},
        getActivePopin: function () { return null; }
    };
    var names = Object.keys(inj);
    var body = extract('bindNativeCloseSync') + '\n' + extract('closeLoadingShell') + '\n'
        + extract('showLoadingShell') + '\n' + extract('popinLoadContent')
        + '\nreturn { bindNativeCloseSync: bindNativeCloseSync, closeLoadingShell: closeLoadingShell,'
        + ' showLoadingShell: showLoadingShell, popinLoadContent: popinLoadContent };';
    var fns = new Function(names.join(','), body).apply(null, names.map(function (k) { return inj[k]; }));
    // the plugin's popinClose carries a loading branch that runs closeLoadingShell (pinned in
    // 02); the stub reproduces exactly that branch so the native-close route drives end to end
    late.close = function () { if ($popin.isLoading && !$popin.isOpen) { fns.closeLoadingShell($popin); } };
    return { w: w, d: d, $el: $el, $popin: $popin, instance: instance, log: log, fns: fns };
}

/** count — occurrences of a log entry kind (optionally with a given second field). */
function count(log, kind, second) {
    return log.filter(function (e) { return e[0] === kind && (typeof(second) == 'undefined' || e[1] === second); }).length;
}


// ── 01 — behaviour, through the extraction seam ──────────────────────────────

describe('01 - gh#76 §8: the loading shell enters, leaves and tears down an explicit state (real source, jsdom)', function () {

    it('showLoadingShell enters the state on a preOpen dialog and binds the native close sync once', function () {
        var s = scene();
        s.fns.showLoadingShell(s.$popin, s.$el);
        assert.equal(s.$popin.isLoading, true, 'isLoading is true while the shell shows');
        assert.equal(s.$popin.isOpen, false, 'isOpen stays false — the real open still runs when the content lands');
        assert.equal(s.$el.hasAttribute('open'), true, 'the shell is showing (born modal)');
        assert.equal(s.$el._ginaCloseSyncBound, true, 'the native close sync is bound at shell time');
        s.fns.showLoadingShell(s.$popin, s.$el);
        assert.equal(s.$popin.isLoading, true, 'the idempotent second call keeps the state');
        assert.equal(s.$el._ginaCloseSyncBound, true, 'and binds nothing twice');
    });

    it('CONTROL — a popin without preOpen never enters the state (its loading stays invisible, unchanged)', function () {
        var c = scene({ preOpen: false });
        c.fns.showLoadingShell(c.$popin, c.$el);
        assert.equal(c.$popin.isLoading, false, 'no state without a shell');
        assert.equal(c.$el.hasAttribute('open'), false, 'no shell');
        assert.notEqual(c.$el._ginaCloseSyncBound, true, 'no close sync bound (popinOpen binds it at the real open)');
    });

    it('a non-dialog shell enters the state too, and binds no native close (a <div> has no `close` event)', function () {
        var s = scene({ dialog: false });
        s.fns.showLoadingShell(s.$popin, s.$el);
        assert.equal(s.$popin.isLoading, true);
        assert.equal(s.$el.classList.contains('gina-popin-is-active'), true, 'the element is activated');
        assert.equal(s.d.getElementById('ov').classList.contains('gina-popin-is-active'), true, 'and the overlay with it');
        assert.notEqual(s.$el._ginaCloseSyncBound, true, 'gated on useDialogMode');
    });

    it('closeLoadingShell cancels the load, tears the dialog shell down by its own state, releases the trigger and fires close', function () {
        var s = scene();
        var aborted = 0;
        s.fns.showLoadingShell(s.$popin, s.$el);
        s.$el.setAttribute('data-gina-popin-loading', 'true');
        s.$popin.target.setAttribute('data-gina-popin-loading', 'true');
        s.$popin._loadXhr = { readyState: 1, abort: function () { aborted++; } };
        s.instance.activePopinId = 'p1';
        var seqBefore = s.$popin._loadSeq;

        s.fns.closeLoadingShell(s.$popin);

        assert.equal(s.$popin._loadSeq, seqBefore + 1, 'the load sequence is bumped — the landing result will be dropped');
        assert.equal(aborted, 1, 'the in-flight transport is aborted');
        assert.equal(s.$popin._loadXhr, null, 'and forgotten');
        assert.equal(s.$popin.isLoading, false, 'the state is left');
        assert.equal(s.$popin.isOpen, false, 'isOpen was never true');
        assert.equal(s.$el.hasAttribute('open'), false, 'the dialog is closed');
        assert.equal(s.$el.innerHTML, '', 'the skeleton is gone');
        assert.equal(s.$el.hasAttribute('data-gina-popin-loading'), false, 'the loading marker is cleared on the element');
        assert.equal(s.$popin.target.hasAttribute('data-gina-popin-loading'), false, 'and on the container');
        assert.equal(count(s.log, 'release', 't1'), 1, 'the trigger is released');
        assert.equal(s.instance.activePopinId, null, 'this popin is no longer the active one');
        assert.equal(count(s.log, 'event', 'close.p1'), 1, 'close.<id> fires exactly once');
        assert.equal(count(s.log, 'event', 'open.p1'), 0, 'open.<id> never fired');
    });

    it('closeLoadingShell tears a non-dialog shell down by its own state — the class the old teardown keyed on', function () {
        var s = scene({ dialog: false });
        s.fns.showLoadingShell(s.$popin, s.$el);
        s.fns.closeLoadingShell(s.$popin);
        assert.equal(s.$el.classList.contains('gina-popin-is-active'), false, 'the element is deactivated');
        assert.equal(s.d.getElementById('ov').classList.contains('gina-popin-is-active'), false, 'and the overlay');
        assert.equal(s.$popin.isLoading, false);
        assert.equal(count(s.log, 'event', 'close.p1'), 1);
    });

    it('closeLoadingShell leaves a settled transport and another popin\'s active id alone', function () {
        var s = scene();
        var aborted = 0;
        s.fns.showLoadingShell(s.$popin, s.$el);
        s.$popin._loadXhr = { readyState: 4, abort: function () { aborted++; } };
        s.instance.activePopinId = 'someone-else';
        s.fns.closeLoadingShell(s.$popin);
        assert.equal(aborted, 0, 'a transport at readyState 4 has nothing to abort');
        assert.equal(s.instance.activePopinId, 'someone-else', 'another popin\'s active id is not cleared');
        assert.equal(count(s.log, 'active'), 0, 'setActivePopinId not called');
    });

    it('a native close during the shell routes through popinClose to the loading close, and the plugin\'s own close does not re-enter', function () {
        var s = scene();
        s.fns.showLoadingShell(s.$popin, s.$el);
        s.$el.dispatchEvent(new s.w.Event('close'));         // the user agent closed it (Escape)
        assert.equal(count(s.log, 'popinClose', 'P'), 1, 'routed to popinClose while loading');
        assert.equal(s.$popin.isLoading, false, 'the loading close ran (through the stub\'s loading branch)');
        assert.equal(count(s.log, 'event', 'close.p1'), 1, 'close.<id> fired once');
        s.$el.dispatchEvent(new s.w.Event('close'));         // the queued native close after $el.close()
        assert.equal(count(s.log, 'popinClose', 'P'), 1, 'no second popinClose once the state is cleared (de-dup)');
        // the pre-existing contract survives: after a real open, a UA close still routes through popinClose
        s.$popin.isOpen = true;
        s.$el.dispatchEvent(new s.w.Event('close'));
        assert.equal(count(s.log, 'popinClose', 'P'), 2, 'an open popin\'s UA close still routes through popinClose');
    });

    it('popinLoadContent on a loading popin injects into the DIALOG and completes the open — no throw', function () {
        var s = scene();
        s.fns.showLoadingShell(s.$popin, s.$el);
        var threw = null;
        try { s.fns.popinLoadContent.call(s.$popin, '<p id="x">hi</p>'); } catch (e) { threw = e.message; }
        assert.equal(threw, null, 'loadContent() no longer throws during a load');
        assert.equal(!!s.d.querySelector('#p1 #x'), true, 'the content landed in the dialog element');
        assert.equal(s.instance.target.children.length, 1, 'not in the container `target` still names while loading');
        assert.equal(count(s.log, 'unbind'), 1, 'popinUnbind ran');
        assert.equal(count(s.log, 'bind'), 1, 'popinBind ran');
        assert.equal(count(s.log, 'popinOpen', 'P'), 1, 'the open is completed through popinOpen');
        assert.equal(count(s.log, 'event', 'open.p1'), 0, 'open.<id> is popinOpen\'s to fire, not loadContent\'s');
        assert.equal(s.$popin.isOpen, true);
        assert.equal(s.$popin.isLoading, false);
    });

    it('CONTROL — popinLoadContent on a popin neither open nor loading still throws (the published contract outside the window)', function () {
        var s = scene();
        var threw = null;
        try { s.fns.popinLoadContent.call(s.$popin, '<p>x</p>'); } catch (e) { threw = e.message; }
        assert.equal(threw, 'Popin `P` is not open !');
    });

    it('CONTROL — popinLoadContent on an OPEN popin takes the existing path (fires open itself, no popinOpen)', function () {
        var s = scene();
        s.$popin.isOpen = true;
        s.$popin.target = s.$el;
        s.fns.popinLoadContent.call(s.$popin, '<p id="y">y</p>');
        assert.equal(!!s.d.querySelector('#p1 #y'), true);
        assert.equal(count(s.log, 'popinOpen'), 0, 'an open popin is not re-opened');
        assert.equal(count(s.log, 'event', 'open.p1'), 1, 'the pre-existing open.<id> emit is untouched');
    });
});


// ── 02 — source pins for the wiring the seam cannot execute ──────────────────
//
// Access-prefix form throughout (`$popin.isLoading`, `$popin._loadSeq`), never a bare word a
// comment could reproduce. Each pin is false on the pre-change source (GINA_POPIN_SRC lever).

describe('02 - gh#76 §8: source pins', function () {

    it('the popin proto declares isLoading, _loadSeq and _loadXhr beside isOpen', function () {
        assert.match(getSrc(),
            /'isOpen'\s*:\s*false,[\s\S]{0,700}?'isLoading'\s*:\s*false,[\s\S]{0,700}?'_loadSeq'\s*:\s*0,[\s\S]{0,200}?'_loadXhr'\s*:\s*null,/,
            'expected the three new proto fields after isOpen');
    });

    it('showLoadingShell sets the state at its tail — after the preOpen gate and the idempotence guard — and binds the close sync', function () {
        var slice = extract('showLoadingShell');
        assert.match(slice, /\$popin\.isLoading\s*=\s*true;\s*\n\s*bindNativeCloseSync\(\$popin,\s*\$el\);/,
            'expected the state write followed by the close-sync bind');
        var guardIdx = slice.indexOf("hasAttribute('open')");
        var writeIdx = slice.indexOf('$popin.isLoading = true;');
        assert.ok(guardIdx > -1 && writeIdx > guardIdx, 'the write sits below the idempotence guard (a repeat call never re-enters)');
    });

    it('bindNativeCloseSync keeps the positive dialog gate and widens the listener guard to isOpen || isLoading', function () {
        var slice = extract('bindNativeCloseSync');
        assert.match(slice, /if\s*\(\s*self\.options\.useDialogMode\s*&&\s*\$el\s*&&\s*!\$el\._ginaCloseSyncBound\s*\)/,
            'the useDialogMode + once-guard gate');
        assert.match(slice, /\$el\._ginaCloseSyncBound\s*=\s*true;/, 'the once-bind flag');
        assert.match(slice,
            /addEventListener\(\s*['"]close['"][\s\S]{0,220}?if\s*\(\s*\$popin\.isOpen\s*\|\|\s*\$popin\.isLoading\s*\)[\s\S]{0,80}?popinClose\(\s*\$popin\.name\s*\)/,
            'the close handler guards on isOpen OR isLoading, then runs popinClose($popin.name)');
    });

    it('popinOpen binds the close sync through the helper (before isOpen = true) and no longer carries the inline block', function () {
        var slice = extract('popinOpen');
        var bindIdx = slice.indexOf('bindNativeCloseSync($popin, $el);');
        var openIdx = slice.indexOf('$popin.isOpen = true;');
        assert.ok(bindIdx > -1, 'popinOpen calls the helper');
        assert.ok(openIdx > -1 && bindIdx < openIdx, 'the close listener is bound before isOpen is set true');
        assert.doesNotMatch(slice, /\$el\.addEventListener\(\s*['"]close['"]/, 'the inline listener block is gone from popinOpen');
        assert.match(slice, /\$popin\.isOpen\s*=\s*true;\s*\n\s*\$popin\.isLoading\s*=\s*false;/,
            'the real open leaves the loading state');
    });

    it('closeLoadingShell: sequence bump, abort, state cleared BEFORE the native close, teardown by the shell\'s own state, release, active id, close event', function () {
        var slice = extract('closeLoadingShell');
        var seqIdx    = slice.search(/\$popin\._loadSeq\s*=\s*\(\s*\$popin\._loadSeq\s*\|\|\s*0\s*\)\s*\+\s*1;/);
        var abortIdx  = slice.indexOf('$popin._loadXhr.abort();');
        var stateIdx  = slice.indexOf('$popin.isLoading = false;');
        var closeIdx  = slice.indexOf('$el.close();');
        assert.ok(seqIdx > -1 && abortIdx > seqIdx, 'the sequence is bumped, then the transport aborted');
        assert.ok(stateIdx > abortIdx && closeIdx > stateIdx, 'isLoading is cleared before the dialog\'s close() — its queued close event must find no state');
        assert.match(slice, /\$el\.tagName\s*===\s*'DIALOG'/, 'teardown branches on the element kind, not on the active class');
        assert.match(slice, /classList\.remove\('gina-popin-is-active'\)/, 'the non-dialog branch deactivates the element');
        assert.match(slice, /releasePopinTrigger\(\$popinTrigger\);/, 'the trigger is released');
        assert.match(slice, /if\s*\(\s*\$popin\.id\s*===\s*instance\.activePopinId\s*\)\s*\{\s*\n\s*setActivePopinId\(null\);/,
            'the active id is cleared through the write-through helper, only when it names this popin');
        assert.match(slice, /triggerEvent\(gina,\s*\$popin\.target,\s*'close\.'\s*\+\s*\$popin\.id,\s*\$popin\);/, 'close.<id> fires');
    });

    it('popinLoad takes a sequence per load and stashes the transport before the handler is armed', function () {
        var slice = extract('popinLoad');
        assert.match(slice, /var seq\s*=\s*\$popin\._loadSeq\s*=\s*\(\s*\$popin\._loadSeq\s*\|\|\s*0\s*\)\s*\+\s*1;/,
            'the load sequence');
        var stashIdx   = slice.indexOf('$popin._loadXhr = xhr;');
        var handlerIdx = slice.indexOf('xhr.onreadystatechange = function');
        assert.ok(stashIdx > -1 && handlerIdx > stashIdx, 'the transport is stashed before its handler is armed');
    });

    it('popinLoad drops a cancelled or superseded result AFTER its release block and BEFORE the status dispatch', function () {
        var slice = extract('popinLoad');
        var seqIdx = slice.indexOf('if ( seq !== $popin._loadSeq ) {');
        assert.ok(seqIdx > -1, 'the sequence check');
        assert.match(slice.slice(seqIdx, seqIdx + 120), /if\s*\(\s*seq\s*!==\s*\$popin\._loadSeq\s*\)\s*\{\s*\n\s*return;/, 'a stale result returns');
        var disarmIdx = slice.lastIndexOf('loadingState.disarm($popinTrigger);', seqIdx);
        var forgetIdx = slice.indexOf('$popin._loadXhr = null;', seqIdx);
        var resultIdx = slice.indexOf('var result = null;', seqIdx);
        assert.ok(disarmIdx > -1 && disarmIdx < seqIdx, 'the trigger release precedes the check (a cancelled load still releases)');
        assert.ok(forgetIdx > seqIdx && resultIdx > forgetIdx, 'the transport is forgotten after the check, before the result is read');
    });

    it('popinLoad\'s failure rule: on a non-2xx answer, error.<id> fires FIRST, then the shell closes if still loading', function () {
        var slice = extract('popinLoad');
        assert.match(slice,
            /triggerEvent\(gina,\s*\$el,\s*'error\.'\s*\+\s*id,\s*result\)\s*\n(?:\s*\/\/[^\n]*\n)*\s*if\s*\(\s*\$popin\.isLoading\s*&&\s*!\$popin\.isOpen\s*\)\s*\{\s*\n\s*closeLoadingShell\(\$popin\);/,
            'the loading close follows the error emit, gated on still-loading');
        assert.equal((slice.match(/closeLoadingShell\(\$popin\);/g) || []).length, 1, 'exactly one loading-close site in popinLoad (the non-2xx branch)');
    });

    it('popinClose: the method form accepts a loading popin, and the loading branch precedes the !isOpen return', function () {
        var slice = extract('popinClose');
        assert.match(slice,
            /typeof\(name\)\s*==\s*'undefined'\s*&&\s*\(\s*\/\^true\$\/\.test\(this\.isOpen\)\s*\|\|\s*\/\^true\$\/\.test\(this\.isLoading\)\s*\)/,
            'the method form (`$popin.close()`) accepts isLoading');
        var branch = slice.search(/if\s*\(\s*!\$popin\.isOpen\s*&&\s*\$popin\.isLoading\s*\)\s*\{\s*\n\s*if\s*\(\s*\$popin\.isRedirecting\s*\)\s*\{\s*\n\s*return;\s*\n\s*\}\s*\n\s*closeLoadingShell\(\$popin\);\s*\n\s*return;/);
        var bareReturn = slice.search(/if\s*\(\s*!\$popin\.isOpen\s*\)\s*\n\s*return;/);
        assert.ok(branch > -1, 'the loading branch (redirect-guarded) runs the loading close');
        assert.ok(bareReturn > -1 && branch < bareReturn, 'and sits before the !isOpen early return');
    });

    it('popinLoadContent accepts a loading popin, injects into the dialog element, and completes the open through popinOpen', function () {
        var slice = extract('popinLoadContent');
        assert.match(slice, /var completingOpen\s*=\s*\(\s*!\$popin\.isOpen\s*&&\s*\$popin\.isLoading\s*\);/, 'the completing-open flag');
        assert.match(slice, /if\s*\(\s*!\$popin\.isOpen\s*&&\s*!completingOpen\s*\)\s*\n\s*throw new Error\('Popin `'\+\$popin\.name\+'` is not open !'\);/,
            'the throw is gated on neither open nor loading');
        assert.match(slice, /var \$el\s*=\s*\(\s*completingOpen\s*\)\s*\?\s*\(\s*document\.getElementById\(\$popin\.id\)\s*\|\|\s*\$popin\.target\s*\)\s*:\s*\$popin\.target;/,
            'while loading the content lands in the dialog element, not the container `target` still names');
        assert.match(slice, /if\s*\(\s*completingOpen\s*\)\s*\{[\s\S]{0,400}?popinOpen\(\$popin\.name\);\s*\n\s*\}\s*else if\s*\(\s*!\$popin\.isRedirecting\s*\)\s*\{\s*\n\s*triggerEvent\(gina,\s*instance\.target,\s*'open\.'\s*\+\s*\$popin\.id/,
            'the open is completed through popinOpen; the existing open.<id> emit stays on the else branch');
    });

    it('popinDestroy closes a loading popin first (the loading close cancels the load)', function () {
        assert.match(extract('popinDestroy'),
            /if\s*\(\s*\$popin\.isOpen\s*\|\|\s*\$popin\.isLoading\s*\)\s*\{\s*\n\s*\$popin\.isRedirecting\s*=\s*false;\s*\n\s*popinClose\(name\);/,
            'destroy closes on isOpen OR isLoading');
    });

    it('consumePreload: the adopted wait takes a sequence before the shell shows and drops a cancelled body after settling', function () {
        var slice = extract('consumePreload');
        var seqIdx   = slice.search(/var seq\s*=\s*\(\s*\$popin\s*\)\s*\?\s*\(\s*\$popin\._loadSeq\s*=\s*\(\s*\$popin\._loadSeq\s*\|\|\s*0\s*\)\s*\+\s*1\s*\)\s*:\s*null;/);
        var shellIdx = slice.indexOf('showLoadingShell($popin, ensurePopinDialog($popin));');
        assert.ok(seqIdx > -1 && shellIdx > seqIdx, 'the sequence is taken before the shell shows');
        assert.match(slice, /_settle\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*if\s*\(\s*seq\s*!==\s*null\s*&&\s*seq\s*!==\s*\$popin\._loadSeq\s*\)\s*\{\s*\n\s*return;/,
            'the waiter settles (release) first, then drops a cancelled body');
    });

    it('CONTROL — true on both revisions: showLoadingShell exists and injects the default shell', function () {
        assert.ok(extract('showLoadingShell').indexOf('GINA_DEFAULT_LOADING_SHELL') > -1);
    });
});


// ── 03 — dist freshness (the served bundle must carry the change) ─────────────

describe('03 - gh#76 §8: the built bundle carries the loading state', function () {

    it('dist gina.js carries the two new functions and the state write', function () {
        var dist = getDistSrc();
        assert.ok(dist.indexOf('function closeLoadingShell(') > -1, 'closeLoadingShell — rebuild the bundle from source');
        assert.ok(dist.indexOf('function bindNativeCloseSync(') > -1, 'bindNativeCloseSync — rebuild the bundle from source');
        assert.ok(dist.indexOf('$popin.isLoading = true;') > -1, 'the state write — rebuild the bundle from source');
    });

    it('served gina.min.js carries the minify-surviving property tokens (isLoading / _loadSeq / _loadXhr)', function () {
        var min = getDistMinSrc();
        assert.ok(min.indexOf('isLoading') > -1, 'isLoading — rebuild the bundle from source');
        assert.ok(min.indexOf('_loadSeq') > -1, '_loadSeq — rebuild the bundle from source');
        assert.ok(min.indexOf('_loadXhr') > -1, '_loadXhr — rebuild the bundle from source');
        assert.equal(min.indexOf('isLoadingZZZ'), -1, 'control: a bogus token is absent (the instrument can read a miss)');
    });
});
