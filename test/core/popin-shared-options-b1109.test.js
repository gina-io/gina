'use strict';
/**
 * #B1109 — popinLoad copies the options it is given: unit arms on the REAL source.
 *
 * `popinLoad(name, url, options)` made the popin's options the very object it merged into:
 * with no options, the instance's `xhrOptions` defaults; with options, the caller's object.
 * `lib/merge` mutates and returns its target, and `$popin.options = merge(options,
 * $popin.options)` then adopted that object as the popin's options. Two popins loaded that
 * way through one instance (`gina.popin.load(a, url)` then `gina.popin.load(b, url)`, or one
 * options object passed to both loads) therefore shared ONE options object: the second took
 * the first's `name`, `preOpen` (its loading shell showed), `class` and `loadTimeout`. The fix
 * copies both: the defaults in the no-options branch, and a caller's object in the other one,
 * except the popin's own options, which the in-tree callers pass back and which keep their
 * identity. The browser behaviour is test/e2e/popin-shared-options-b1109.spec.js's.
 *
 * 01 executes popinLoad with the functions it calls on that path (registerPopin,
 *    getPopinByName, setActivePopinId, showLoadingShell, resolveLoadTimeout, armLoadTimer,
 *    clearLoadTimer) and the xhrOptions / self.options literals, all extracted from the
 *    source (brace-balanced, each slice checked to compile), with the real lib/merge and
 *    lib/domain; the DOM, the XHR and the timer are stubs that record what the real code
 *    hands them. 02 pins the source; 03 pins the served bundle.
 *
 * Red-first lever: point the file at the pre-change source and every arm but the CONTROLs
 * goes red —
 *   GINA_POPIN_SRC=<path to `git show <rev>:framework/v<ver>/core/asset/plugin/src/vendor/gina/popin/main.js`> \
 *     node --test test/core/popin-shared-options-b1109.test.js
 * (the dist arms read the built bundle, not that file; to see them red, point them at a
 * directory holding a pre-change gina.js and gina.min.js —
 *   GINA_POPIN_DIST_DIR=<dir> node --test test/core/popin-shared-options-b1109.test.js).
 *
 * Usage: node --test test/core/popin-shared-options-b1109.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC   = process.env.GINA_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
// GINA_POPIN_DIST_DIR: a directory holding the gina.js and gina.min.js to read instead of the built ones
var DIST_DIR    = process.env.GINA_POPIN_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');
var DIST_JS     = path.join(DIST_DIR, 'gina.js');
var DIST_MIN_JS = path.join(DIST_DIR, 'gina.min.js');
var merge  = require(path.join(FW, 'lib/merge'));
var Domain = require(path.join(FW, 'lib/domain'));

var _src;
function getSrc() { return _src || (_src = fs.readFileSync(POPIN_SRC, 'utf8')); }

/**
 * balancedEnd — the index just past the `}` that closes the first `{` at or after `from`.
 *
 * @param {string} src
 * @param {number} from
 * @returns {number}
 */
function balancedEnd(src, from) {
    var i = src.indexOf('{', from), depth = 0, started = false;
    if (i < 0) throw new Error('no brace after ' + from);
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { return i + 1; } }
    }
    throw new Error('unbalanced braces from ' + from);
}

/**
 * extract — the text of ONE inner function, by name, declared as `function NAME(` or
 * `var NAME = function(`: anchored on its unique declaration line, sliced by brace balance,
 * and checked to compile (a mis-balanced slice does not).
 *
 * @param {string} name
 * @param {string} [src]
 * @returns {string}
 */
function extract(name, src) {
    src = src || getSrc();
    var re = new RegExp('^[ \\t]*(?:function ' + name + '\\(|var ' + name + ' = function\\s*\\()', 'mg');
    var m = re.exec(src);
    if (!m) throw new Error('declaration missing: ' + name);
    if (re.exec(src)) throw new Error('declaration not unique: ' + name);
    var text = src.slice(m.index, balancedEnd(src, m.index));
    if (/^\s*var /.test(text)) { text += ';'; }
    new Function(text);
    return text;
}

/**
 * extractLiteral — an object literal, by a unique anchor (and an optional inner anchor
 * after it), sliced by brace balance and checked to evaluate.
 *
 * @param {string} anchor
 * @param {string} [inner]
 * @returns {string}
 */
function extractLiteral(anchor, inner) {
    var src = getSrc();
    var at = src.indexOf(anchor);
    if (at < 0 || src.indexOf(anchor, at + 1) > -1) throw new Error('anchor missing or not unique: ' + anchor);
    var open = src.indexOf('{', inner ? src.indexOf(inner, at) : at);
    var text = src.slice(open, balancedEnd(src, open));
    new Function('return ' + text + ';');
    return text;
}

/**
 * stripComments — `code` without its `//` and block comments; strings are kept as they
 * are, so a `'//'` inside one stays. The result must still compile (checked by callers that
 * need it), so a stripper that ate code cannot pass a pin silently.
 *
 * @param {string} code
 * @returns {string}
 */
function stripComments(code) {
    var out = '', i = 0, q = null;
    while (i < code.length) {
        var c = code[i], n = code[i + 1];
        if (q) {
            out += c;
            if (c === '\\') { out += n; i += 2; continue; }
            if (c === q) { q = null; }
            i++; continue;
        }
        if (c === "'" || c === '"' || c === '`') { q = c; out += c; i++; continue; }
        if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') { i++; } continue; }
        if (c === '/' && n === '*') { var e = code.indexOf('*/', i + 2); i = (e < 0) ? code.length : e + 2; continue; }
        out += c; i++;
    }
    return out;
}

/**
 * makeEl — a stub element: records attributes, `innerHTML` and `showModal()` calls.
 *
 * @param {string} id
 * @returns {object}
 */
function makeEl(id) {
    return {
        id: id, attrs: {}, innerHTML: '', tagName: 'DIALOG', showModalCalls: 0,
        setAttribute: function (k, v) { this.attrs[k] = String(v); },
        getAttribute: function (k) { return (k in this.attrs) ? this.attrs[k] : null; },
        hasAttribute: function (k) { return k in this.attrs; },
        classList: { contains: function () { return false; }, add: function () {} },
        showModal: function () { this.attrs.open = ''; this.showModalCalls++; },
        firstChild: { appendChild: function () {} },
        appendChild: function () {}
    };
}

/**
 * scene — one popin instance built from the extracted source, and the stubs it runs on.
 * `load($popin, args, viaMethod)` calls popinLoad the way `gina.popin.load(...)` does (on
 * the instance) or the way `getPopinByName(x).load(...)` does (on the popin), and returns
 * what the real code handed the stubs for that load.
 *
 * @param {object} [location] - `window.location` (default: http://localhost:3000)
 * @returns {object}
 */
function scene(location) {
    var els = {}, xhrs = [], timers = {}, nextTimer = 1;
    function FakeXHR() { this.readyState = 0; this.withCredentials = false; this.sent = false; xhrs.push(this); }
    FakeXHR.prototype.open = function (m, u) { this.method = m; this.url = u; this.readyState = 1; };
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.send = function () { this.sent = true; };
    FakeXHR.prototype.abort = function () {};
    var document = {
        getElementById: function (id) {
            return ( typeof(id) == 'string' && /^gina-popin-/.test(id) ) ? ( els[id] || (els[id] = makeEl(id)) ) : null;
        },
        getElementsByTagName: function () { return []; },
        createElement: function () { throw new Error('the element-creation branch was not expected'); }
    };
    var window = { XMLHttpRequest: FakeXHR, location: location || { protocol: 'http:', host: 'localhost:3000', hostname: 'localhost' } };
    var gina = { popin: { activePopinId: null }, config: { popin: {}, envIsDev: false, hostname: 'http://localhost:3000' } };
    var instance = { id: 'gina-popins-gp-1', $popins: {}, target: makeEl('instance-target'), eventData: {}, activePopinId: null };
    var setTimeoutStub = function (fn, ms) { var id = nextTimer++; timers[id] = ms; return id; };
    var noop = function () {};
    var names = ['merge', 'document', 'window', 'XMLHttpRequest', 'gina', 'instance', 'setTimeout', 'clearTimeout',
                 'domainInstance', 'GINA_ENV_IS_DEV', 'GINA_DEFAULT_LOADING_SHELL', 'bindOpen', 'bindNativeCloseSync',
                 'armPopinTrigger', 'triggerEvent', 'addListener', 'updateToolbar', 'popinLoadContent', 'popinOpen',
                 'popinClose', 'popinBind', 'closeLoadingShell'];
    var body = [
        'var xhrOptions = ' + extractLiteral('var xhrOptions = {') + ';',
        "var self = { 'options' : " + extractLiteral('var self = { // local use only', "'options' : {") + ' };',
        'var registeredPopins = [];',
        'var $validatorInstance = null;',
        extract('setActivePopinId'), extract('getPopinByName'), extract('resolveLoadTimeout'),
        extract('armLoadTimer'), extract('clearLoadTimer'), extract('showLoadingShell'),
        extract('popinLoad'), extract('registerPopin'),
        'return { xhrOptions: xhrOptions, registerPopin: registerPopin, popinLoad: popinLoad };'
    ].join('\n');
    var api = new Function(names.join(','), body)(merge, document, window, FakeXHR, gina, instance, setTimeoutStub, noop,
        new Domain(), false, 'GINA_DEFAULT_SHELL', noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop);
    instance.load = api.popinLoad;
    gina.popin = instance; // the published object IS the boot instance (#B90)
    return {
        api: api,
        register: function (opts) { var $p = {}; api.registerPopin($p, opts); return $p; },
        load: function ($popin, args, viaMethod) {
            var before = xhrs.length;
            var handle = viaMethod ? $popin.load.apply($popin, args) : api.popinLoad.apply(instance, args);
            var xhr = xhrs[before], el = els[$popin.id];
            return {
                sent: !!(xhr && xhr.sent),
                returnsOpen: !!(handle && typeof(handle.open) == 'function'),
                limit: ( xhr && xhr._ginaLoadTimer ) ? timers[xhr._ginaLoadTimer] : 0,
                shell: !!(el && el.showModalCalls > 0),
                withCredentials: xhr ? xhr.withCredentials : null
            };
        }
    };
}

/** alpha: a pre-opened popin with its own limit and class */
function alphaOptions() { return { name: 'alpha', preOpen: true, loadTimeout: 5000, 'class': 'alpha-cls' }; }

/** what a popin's options read */
function read($popin) {
    var o = $popin.options;
    return { name: o.name, preOpen: o.preOpen, cls: o['class'], loadTimeout: o.loadTimeout };
}

var BETA_OWN = { name: 'beta', preOpen: false, cls: 'gina-popin-container gina-popin-default', loadTimeout: null };

describe('01 - two popins, one instance (extracted source)', function () {

    it('two loads without options through the instance: each popin keeps its own options', function () {
        var s = scene();
        var a = s.register(alphaOptions()), b = s.register({ name: 'beta' });
        var la = s.load(a, ['alpha', '/a']), lb = s.load(b, ['beta', '/b']);
        assert.ok(la.sent && lb.sent && la.returnsOpen && lb.returnsOpen, 'both loads ran to send()');
        assert.ok(a.options !== b.options, 'the two popins hold different options objects');
        assert.ok(b.options !== s.api.xhrOptions, "a popin's options are not the instance defaults");
        assert.deepEqual(read(b), BETA_OWN, "beta reads its own name, preOpen, class and loadTimeout");
        assert.equal(lb.limit, 0, "beta's load arms no limit (it has none)");
        assert.equal(lb.shell, false, "beta's load shows no loading shell (preOpen is false)");
        assert.equal(la.limit, 5000, "alpha's load arms its own limit");
        assert.equal(la.shell, true, "alpha's load shows its loading shell");
    });

    it('the same through the popin method, getPopinByName(x).load(x, url)', function () {
        var s = scene();
        var a = s.register(alphaOptions()), b = s.register({ name: 'beta' });
        var la = s.load(a, ['alpha', '/a'], true), lb = s.load(b, ['beta', '/b'], true);
        assert.ok(la.sent && lb.sent, 'both loads ran to send()');
        assert.ok(a.options !== b.options, 'the two popins hold different options objects');
        assert.deepEqual(read(b), BETA_OWN);
        assert.equal(lb.limit, 0);
        assert.equal(lb.shell, false);
    });

    it("the other direction: a second popin's limit never reaches the first one's next load", function () {
        var s = scene();
        var a = s.register({ name: 'alpha' }), b = s.register({ name: 'beta', loadTimeout: 30000 });
        var l1 = s.load(a, ['alpha', '/a']), l2 = s.load(b, ['beta', '/b']);
        var l3 = s.load(a, ['alpha', '/a']);
        assert.ok(l1.sent && l2.sent && l3.sent, 'the three loads ran to send()');
        assert.equal(l2.limit, 30000, "beta's load arms its own limit");
        assert.equal(a.options.loadTimeout, null, "alpha's options keep no limit");
        assert.equal(l3.limit, 0, "alpha's next load arms none");
    });

    it("one options object passed to two loads: each popin keeps its own options, and the caller's object is left as it was", function () {
        var s = scene();
        var a = s.register(alphaOptions()), b = s.register({ name: 'beta' });
        var o = {};
        var la = s.load(a, ['alpha', '/a', o]), lb = s.load(b, ['beta', '/b', o]);
        assert.ok(la.sent && lb.sent, 'both loads ran to send()');
        assert.ok(a.options !== b.options, 'the two popins hold different options objects');
        assert.ok(a.options !== o && b.options !== o, "neither popin adopted the caller's object");
        assert.deepEqual(Object.keys(o), [], "the caller's object gained no key");
        assert.deepEqual(read(b), BETA_OWN);
        assert.equal(lb.limit, 0);
        assert.equal(lb.shell, false);
    });

    it("a cross-origin load without options leaves the defaults' withCredentials alone (the real lib/domain decides the root domain)", function () {
        var s = scene({ protocol: 'https:', host: 'app.example.com', hostname: 'app.example.com' });
        var a = s.register({ name: 'alpha' }), b = s.register({ name: 'beta' });
        var la = s.load(a, ['alpha', 'https://cdn.other-example.org/x']);
        assert.ok(la.sent, 'the cross-origin load ran to send()');
        assert.equal(la.withCredentials, false, 'a load to another root domain goes without credentials');
        assert.equal(s.api.xhrOptions.withCredentials, true, 'the defaults keep withCredentials: true');
        var lb = s.load(b, ['beta', 'https://api.example.com/b', {}]);
        assert.ok(lb.sent, 'the same-root load ran to send()');
        assert.equal(lb.withCredentials, true, 'a later load to the same root domain still sends credentials');
    });

    it('CONTROL — a fresh options object per load (the declarative click passes one) keeps each popin\'s own options (true before and after #B1109)', function () {
        var s = scene();
        var a = s.register(alphaOptions()), b = s.register({ name: 'beta' });
        var la = s.load(a, ['alpha', '/a', {}]), lb = s.load(b, ['beta', '/b', {}]);
        assert.ok(la.sent && lb.sent, 'both loads ran to send()');
        assert.ok(a.options !== b.options);
        assert.deepEqual(read(b), BETA_OWN);
        assert.equal(lb.limit, 0);
        assert.equal(la.limit, 5000);
        assert.equal(la.shell, true);
    });

    it('CONTROL — one popin loaded alone without options reads its own options (true before and after #B1109)', function () {
        var s = scene();
        var b = s.register({ name: 'beta' });
        var lb = s.load(b, ['beta', '/b']);
        assert.ok(lb.sent, 'the load ran to send()');
        assert.deepEqual(read(b), BETA_OWN);
        assert.equal(lb.limit, 0);
        assert.equal(lb.shell, false);
    });

    it("CONTROL — the popin's own options passed back (the validator redirect, a link inside the popin, the reload-open) keep their identity (true before and after #B1109)", function () {
        var s = scene();
        var a = s.register(alphaOptions()), b = s.register({ name: 'beta' });
        var oa = a.options, ob = b.options;
        var la = s.load(a, ['alpha', '/a', a.options]), lb = s.load(b, ['beta', '/b', b.options]);
        assert.ok(la.sent && lb.sent, 'both loads ran to send()');
        assert.ok(a.options === oa && b.options === ob, 'each popin keeps its own options object');
        assert.deepEqual(read(b), BETA_OWN);
        assert.equal(la.limit, 5000);
        assert.equal(lb.limit, 0);
    });
});

describe('02 - the source', function () {

    it('popinLoad copies the defaults when it is given no options', function () {
        var raw = extract('popinLoad');
        var code = stripComments(raw);
        new Function(code);
        assert.ok(code.indexOf('options = merge({}, xhrOptions);') > -1, 'the no-options branch copies the defaults');
        assert.equal(code.indexOf('options = xhrOptions;'), -1, 'no code line aliases the defaults any more');
        // the stripper is checked against the raw text, which still names the replaced line
        assert.ok(raw.indexOf('options = xhrOptions;') > -1, 'the raw text keeps the replaced line in a comment');
    });

    it("popinLoad copies a caller's object, except the popin's own options, before the defaults merge", function () {
        var code = stripComments(extract('popinLoad'));
        assert.match(code, /if\s*\(\s*options\s*!==\s*\$popin\.options\s*\)\s*\{\s*options\s*=\s*merge\(\s*\{\}\s*,\s*options\s*\);\s*\}\s*options\s*=\s*merge\(\s*options\s*,\s*xhrOptions\s*\);/);
    });

    it('CONTROL — the declarative click still hands popinLoad a fresh loadOptions object (true before and after #B1109)', function () {
        assert.match(getSrc(), /var loadOptions = merge\(\{ isSynchrone: false, withCredentials: false \}, existing\.options\);/);
    });
});

describe('03 - the served bundle', function () {

    /**
     * the `gina/popin` module's text in gina.js
     *
     * @returns {string}
     */
    function popinModule() {
        var dist = fs.readFileSync(DIST_JS, 'utf8');
        var at = dist.indexOf("define('gina/popin',");
        assert.ok(at > -1, 'gina.js carries the gina/popin module');
        var next = dist.indexOf('\ndefine(', at + 1);
        return dist.slice(at, ( next < 0 ) ? dist.length : next);
    }

    it('gina.js: the popin module copies the defaults and no longer aliases them', function () {
        var code = stripComments(popinModule());
        assert.ok(code.indexOf('options = merge({}, xhrOptions);') > -1, 'rebuild the plugin bundle');
        assert.equal(code.indexOf('options = xhrOptions;'), -1, 'rebuild the plugin bundle');
    });

    /**
     * the `gina/popin` module's text in gina.min.js (Closure writes `define('gina/popin',`)
     *
     * @returns {string}
     */
    function popinMinModule() {
        var dist = fs.readFileSync(DIST_MIN_JS, 'utf8');
        var at = dist.indexOf("define('gina/popin',");
        assert.ok(at > -1, 'gina.min.js carries the gina/popin module');
        var next = dist.slice(at + 1).search(/define\(['"]/);
        return dist.slice(at, ( next < 0 ) ? dist.length : at + 1 + next);
    }

    /**
     * tokens — a RegExp from a compact pattern in which each space stands for optional
     * whitespace: Closure wraps gina.min.js at about 500 characters, between any two tokens.
     *
     * @param {string} pattern - regex source, its tokens separated by single spaces
     * @returns {RegExp}
     */
    function tokens(pattern) { return new RegExp(pattern.split(' ').join('\\s*')); }

    /**
     * minPopin — the minified popin module and the escaped name Closure gave the xhrOptions
     * defaults, read from their literal (in the bundle before and after #B1109)
     *
     * @returns {{mod: string, D: string}}
     */
    function minPopin() {
        var mod = popinMinModule();
        var lit = tokens(String.raw`([\w$]+) = \{ url : '' , method : 'GET' , isSynchrone : !1 , withCredentials : !0 ,`).exec(mod);
        assert.ok(lit, 'the module holds the xhrOptions literal');
        return { mod: mod, D: lit[1].replace(/\$/g, '\\$') };
    }

    it('gina.min.js: the popin module no longer aliases the defaults', function () {
        var m = minPopin();
        // was: typeof z=='undefined'?z=Cb:(p=Cb.withCredentials,z=U(z,Cb),z.withCredentials=p)
        assert.doesNotMatch(m.mod, tokens(String.raw`typeof\s+([\w$]+) == 'undefined' \? \1 = ${m.D} :`), 'rebuild the plugin bundle: the defaults are still aliased');
    });

    it("gina.min.js: the popin module copies the defaults, and a caller's object unless it is the popin's own options", function () {
        var m = minPopin();
        assert.match(m.mod, tokens(String.raw`typeof\s+([\w$]+) == 'undefined' \? \1 = ([\w$]+) \( \{ \} , ${m.D} \) : \( ([\w$]+) = ${m.D} \. withCredentials , \1 !== [\w$]+ \. options && \( \1 = \2 \( \{ \} , \1 \) \) , \1 = \2 \( \1 , ${m.D} \)`), 'rebuild the plugin bundle: no copy of the options');
    });
});
