/**
 * #B974 + #B975 — a popin closes after, and during, a load that a link inside it started
 *
 * A plain link in popin content loads its page into the same popin: its click sets
 * `$popin.isRedirecting`, and `popinClose()` returns while that flag is set — the guard the
 * validator's redirect-in-place relies on (it sets the flag, calls a deliberately no-op
 * `close()`, then reloads the popin). Nothing cleared the flag once the load had landed or
 * failed, and an HTML landing re-set it, so:
 *
 *   #B974 — after such a load, Escape on a modal popin closed the `<dialog>` while the popin
 *           stayed `isOpen` (no `close.<id>`, the trigger could not show it again); the
 *           non-modal Escape shim, `gina.popin.close(name)`, a form's `close()` and a client
 *           navigation's close did nothing. A reload of an open popin, a partial-target link
 *           load, a link with a `target` and the validator's redirect-in-place left the same flag.
 *   #B975 — `popinClose()` never cancelled a load in flight, so the late landing filled — or,
 *           on a declarative popin, re-opened — the popin the user had just closed.
 *
 * The fix: the native close sync and the Escape shim clear the flag before they close (a user's
 * close wins); the flag ends when the redirect's load settles (after the sequence check) and
 * after popinLoadContent's dispatch; a link that opened another window clears it; and
 * popinClose cancels a load in flight (sequence bump + abort) BELOW its redirect guard, so the
 * validator's no-op close still cancels nothing.
 *
 * The live behaviour is exercised by `test/e2e/popin-close-after-link-b974.spec.js` (15 arms,
 * a real engine, real XHRs); this file drives the lifted close sync and Escape shim in jsdom and
 * pins the source, `gina.js` and the served `gina.min.js`.
 *
 * Red-first levers:
 *   GINA_POPIN_SRC=<pre-fix popin/main.js>   node --test test/core/popin-close-after-link-b974.test.js
 *     → every 01 and 02 arm goes red except the two labelled CONTROL
 *   GINA_POPIN_DIST_JS=<pre-fix gina.js> GINA_POPIN_DIST_MIN=<pre-fix gina.min.js> …
 *     → every 03 arm goes red
 *
 * Usage: node --test test/core/popin-close-after-link-b974.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var FW = require('../fw');
var POPIN_SRC     = process.env.GINA_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var VALIDATOR_SRC = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_JS       = process.env.GINA_POPIN_DIST_JS || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_JS   = process.env.GINA_POPIN_DIST_MIN || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var _src, _distSrc, _distMinSrc;
function getSrc()        { return _src        || (_src        = fs.readFileSync(POPIN_SRC, 'utf8')); }
function getDistSrc()    { return _distSrc    || (_distSrc    = fs.readFileSync(DIST_JS, 'utf8')); }
// Closure wraps its output at arbitrary points (a wrap fell between `isRedirecting=` and `!1`
// at one site, measured): the min shapes are matched with the newlines taken out
function getDistMinSrc() { return _distMinSrc || (_distMinSrc = fs.readFileSync(DIST_MIN_JS, 'utf8').replace(/\n/g, '')); }

/**
 * extract — the source text of ONE inner function of the popin module, by name: anchored on its
 * declaration line (`^[ \t]*function <name>(`, which must be unique) and sliced by brace balance
 * (the same seam as popin-loading-state.test.js).
 *
 * @param {string} name
 * @param {string} [src] - the text to search; the popin source by default
 * @returns {string}
 */
function extract(name, src) {
    src = src || getSrc();
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

/**
 * scene — a jsdom realm with `<div id="c"><dialog id="p1"></dialog></div>`, and the two close
 * paths under test lifted from the REAL source (bindNativeCloseSync, applyNonModalShims), bound
 * to injected collaborators. The stubbed popinClose records the flag it finds, which is the
 * observable the fix changes.
 *
 * @param {object} popinState - fields merged over the popin object
 * @returns {object} { w, d, $el, $popin, calls, fns }
 */
function scene(popinState) {
    var dom = new JSDOM('<!DOCTYPE html><html><body><div id="c"><dialog id="p1"></dialog></div><p id="sib">page</p></body></html>', { runScripts: 'outside-only' });
    var w = dom.window, d = w.document;
    var $el = d.getElementById('p1');
    var $popin = Object.assign({ id: 'p1', name: 'P', isOpen: true, isLoading: false, isRedirecting: false }, popinState || {});
    var calls = [];
    var inj = {
        self: { options: { useDialogMode: true } },
        instance: { target: d.getElementById('c') },
        document: d,
        popinClose: function (name) { calls.push({ name: name, isRedirecting: $popin.isRedirecting }); }
    };
    var names = Object.keys(inj);
    var body = extract('bindNativeCloseSync') + '\n' + extract('applyNonModalShims')
        + '\nreturn { bindNativeCloseSync: bindNativeCloseSync, applyNonModalShims: applyNonModalShims };';
    var fns = new Function(names.join(','), body).apply(null, names.map(function (k) { return inj[k]; }));
    return { w: w, d: d, $el: $el, $popin: $popin, calls: calls, fns: fns };
}


// ── 01 — behaviour, through the extraction seam ──────────────────────────────

describe('01 - #B974: a user\'s close wins over a redirect in progress (real source, jsdom)', function () {

    it('a native close (Escape, method="dialog") of a popin flagged redirecting clears the flag, then runs popinClose', function () {
        var s = scene({ isRedirecting: true });
        s.fns.bindNativeCloseSync(s.$popin, s.$el);
        s.$el.dispatchEvent(new s.w.Event('close'));
        assert.equal(s.calls.length, 1, 'popinClose ran once');
        assert.equal(s.calls[0].name, 'P');
        assert.equal(s.calls[0].isRedirecting, false, 'the flag was cleared BEFORE popinClose, so its guard lets the close run');
    });

    it('the same for a popin whose loading shell shows (isLoading)', function () {
        var s = scene({ isOpen: false, isLoading: true, isRedirecting: true });
        s.fns.bindNativeCloseSync(s.$popin, s.$el);
        s.$el.dispatchEvent(new s.w.Event('close'));
        assert.equal(s.calls.length, 1);
        assert.equal(s.calls[0].isRedirecting, false);
    });

    it('CONTROL — the queued close after the plugin\'s own close (neither open nor loading) runs nothing and leaves the flag alone', function () {
        var s = scene({ isOpen: false, isLoading: false, isRedirecting: true });
        s.fns.bindNativeCloseSync(s.$popin, s.$el);
        s.$el.dispatchEvent(new s.w.Event('close'));
        assert.equal(s.calls.length, 0, 'no popinClose');
        assert.equal(s.$popin.isRedirecting, true, 'the flag is untouched');
    });

    it('the non-modal Escape shim clears the flag, then runs popinClose', function () {
        var s = scene({ isRedirecting: true });
        s.fns.applyNonModalShims(s.$popin, s.$el);
        var ev = new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        s.$el.dispatchEvent(ev);
        assert.equal(ev.defaultPrevented, true, 'the Escape is consumed');
        assert.equal(s.calls.length, 1, 'popinClose ran once');
        assert.equal(s.calls[0].isRedirecting, false, 'the flag was cleared BEFORE popinClose');
    });

    it('CONTROL — another key leaves the popin and the flag alone', function () {
        var s = scene({ isRedirecting: true });
        s.fns.applyNonModalShims(s.$popin, s.$el);
        s.$el.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        assert.equal(s.calls.length, 0);
        assert.equal(s.$popin.isRedirecting, true);
    });
});


// ── 02 — the wiring the seam cannot execute, pinned on code ──────────────────

// Each pin is anchored on statements, never on comment text, and allows comment lines between
// them; `idx()` returns -1 rather than throwing so a missing statement reads as a failed order.
function idx(s, needle, from) { return s.indexOf(needle, from || 0); }

/** The pins of 02, as functions of a source text, so 03 runs the same ones on gina.js. */
var PINS = {
    'popinClose cancels a load in flight right BELOW its redirect guard, and before it closes the dialog': function (src) {
        var s = extract('popinClose', src);
        // the open-path guard: `if ( $popin.isRedirecting )` then `return;` on the next line
        // (the loading branch's guard opens a block instead)
        var g = s.search(/if\s*\(\s*\$popin\.isRedirecting\s*\)\s*\n\s*return;/);
        var bump = idx(s, '$popin._loadSeq = ( $popin._loadSeq || 0 ) + 1;', g);
        var abort = idx(s, '$popin._loadXhr.abort();', bump);
        var forget = idx(s, '$popin._loadXhr = null;', abort);
        var close = idx(s, '$el.close();', forget);
        assert.ok(g > -1, 'the redirect guard');
        assert.ok(bump > g, 'the sequence bump follows the guard (the validator\'s no-op close cancels nothing)');
        assert.ok(abort > bump && forget > abort, 'then the abort, then the transport is forgotten');
        assert.match(s.slice(bump, forget), /if\s*\(\s*\$popin\._loadXhr\s*&&\s*\$popin\._loadXhr\.readyState\s*!==\s*4\s*\)/, 'only a transport still in flight is aborted');
        assert.ok(close > forget, 'all of it before the dialog closes');
    },
    'popinLoad clears the flag once the load has settled: after the sequence check, before the status dispatch': function (src) {
        var s = extract('popinLoad', src);
        var check = s.search(/if\s*\(\s*seq\s*!==\s*\$popin\._loadSeq\s*\)\s*\{\s*\n\s*return;\s*\n\s*\}\s*\n\s*\$popin\._loadXhr = null;/);
        assert.ok(check > -1, 'the sequence check, then the transport forgotten');
        var tail = s.slice(check);
        assert.match(tail, /\$popin\._loadXhr = null;\s*\n(?:\s*\/\/[^\n]*\n)*\s*\$popin\.isRedirecting = false;/, 'the flag is cleared right after');
        assert.ok(tail.indexOf('$popin.isRedirecting = false;') < tail.indexOf('if ( /^2/.test(xhr.status) )'), 'before the status dispatch (landed, failed and JSON alike)');
    },
    'popinLoadContent clears the flag after its dispatch: the flag only chose loaded.<id> over open.<id>': function (src) {
        var s = extract('popinLoadContent', src);
        assert.match(s, /triggerEvent\(gina,\s*instance\.target,\s*'loaded\.'\s*\+\s*\$popin\.id,\s*\$popin\);\s*\n\s*\}\s*\n(?:\s*\/\/[^\n]*\n)*\s*\$popin\.isRedirecting = false;/,
            'the clear follows the dispatch chain');
        assert.ok(s.lastIndexOf('$popin.isRedirecting = false;') < s.indexOf('ginaToolbar'), 'before the toolbar update');
    },
    'a link that opened another window clears the flag right after window.open': function (src) {
        // popinBind's braces do not balance (braces inside its strings and comments), so the
        // extraction seam cannot slice it; the statement is unique in the module instead
        assert.equal(src.split('window.open(linkHref, linkTarget);').length - 1, 1, 'one link window.open site');
        assert.match(src, /window\.open\(linkHref,\s*linkTarget\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*\$popin\.isRedirecting = false;/);
    }
};

describe('02 - #B974/#B975: the source wiring', function () {
    Object.keys(PINS).forEach(function (title) {
        it(title, function () { PINS[title](getSrc()); });
    });

    it('CONTROL — the validator\'s redirect-in-place still marks the popin and calls its (no-op) close before reloading it', function () {
        var v = fs.readFileSync(VALIDATOR_SRC, 'utf8');
        var mark = v.search(/popinName = \$popin\.name;[^\n]*\n\s*\$popin\.isRedirecting = true;/);
        var d = v.indexOf("console.debug('Validator::Popin now redirecting [1-d]');", mark);
        var close = v.indexOf('$popin.close();', d);
        var load = v.indexOf('_popinLoadHandle = $popin.load($popin.name, popinUrl, $popin.options);', close);
        assert.ok(mark > -1 && d > mark && close > d && load > close, 'mark, [1-d], close, then load — the shape the guard and the fix keep intact');
    });
});


// ── 03 — the served bundles ──────────────────────────────────────────────────

describe('03 - #B974/#B975: gina.js and the served gina.min.js carry the fix (rebuild the bundle from source)', function () {

    it('gina.js — the close sync and the Escape shim clear the flag before popinClose', function () {
        var js = getDistSrc();
        assert.match(js, /if\s*\(\s*\$popin\.isOpen\s*\|\|\s*\$popin\.isLoading\s*\)\s*\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*\$popin\.isRedirecting = false;\s*\n\s*popinClose\(\$popin\.name\);/, 'the close sync');
        assert.match(js, /e\.preventDefault\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*\$popin\.isRedirecting = false;\s*\n\s*popinClose\(\$popin\.name\);/, 'the Escape shim');
    });

    Object.keys(PINS).forEach(function (title) {
        it('gina.js — ' + title, function () { PINS[title](getDistSrc()); });
    });

    it('gina.min.js — the close sync clears the flag before it closes', function () {
        assert.match(getDistMinSrc(), /addEventListener\('close',function\(\)\{if\((\w+)\.isOpen\|\|\1\.isLoading\)\1\.isRedirecting=!1,\w+\(\1\.name\)/);
    });

    it('gina.min.js — the Escape shim clears the flag before it closes', function () {
        assert.match(getDistMinSrc(), /\.key==='Escape'\|\|\w+\.keyCode===27\)\w+\.preventDefault\(\),(\w+)\.isRedirecting=!1,\w+\(\1\.name\)/);
    });

    it('gina.min.js — popinClose bumps the sequence and aborts a transport in flight after its redirect guard', function () {
        assert.match(getDistMinSrc(), /!(\w+)\.isRedirecting\)\{\1\._loadSeq=\(\1\._loadSeq\|\|0\)\+1;if\(\1\._loadXhr&&\1\._loadXhr\.readyState!==4\)try\{\1\._loadXhr\.abort\(\)\}catch\(\w+\)\{\}\1\._loadXhr=null;/);
    });

    it('gina.min.js — popinLoad clears the flag right after the sequence check', function () {
        assert.match(getDistMinSrc(), /===(\w+)\._loadSeq\)\)if\(\1\._loadXhr=null,\1\.isRedirecting=!1,/);
    });

    it('gina.min.js — popinLoadContent clears the flag after its open/loaded dispatch', function () {
        assert.match(getDistMinSrc(), /'open\.'\+(\w+)\.id,\1\);\1\.isRedirecting=!1;/);
    });

    it('gina.min.js — a link that opened another window clears the flag', function () {
        assert.match(getDistMinSrc(), /\(window\.open\(\w+,\w+\),\w+\.isRedirecting=!1\)/);
    });
});
