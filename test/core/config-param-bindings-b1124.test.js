/**
 * #B1124 — the boot warning for a route `param` binding under a key gina reads as configuration.
 *
 * A URL binding is declared as `"<key>": ":<key>"` in a route's `param` block. The `param` object
 * (`req.routing.param`) keeps the placeholder text for every key the matcher does not fill, so a
 * binding under a key gina reads as configuration hands gina the literal text: `"section": ":section"`
 * makes `page.section` `":section"`. core/config.param-bindings.js lists such bindings; core/config.js
 * warns ONCE per bundle, on the bundles the #B360 warning judges, and never rewrites a value.
 *
 *   01  the predicate: each of the 24 warned keys with a whole placeholder (whatever its name), and
 *       nothing else — not the 9 exempt keys, not a plain binding name, not a static value, not a
 *       placeholder inside a longer value, not a non-string, not an Object.prototype member name.
 *   02  findConfigKeyBindings lists them in table order and leaves the table untouched.
 *   03  formatConfigKeyBindingWarning: one line naming the bundle and every binding.
 *   04  config.js wiring: required once; called after setRouting (so the #B360 block keeps its single
 *       warning), inside the same `_requirementsApply` gate; one warning; nothing assigned to the table.
 *   05  the census pin, both ways: every `param` key read in the framework's core/ and lib/ code
 *       (comments removed) is either warned or exempt, and every listed key is read. A new read of a
 *       `param.<key>` fails here until the key is classified in core/config.param-bindings.js. The
 *       comment stripper is a small tokenizer, checked first on inputs a regex strip gets wrong.
 *
 * The warning shares #B360's boot path (console.warn in loadBundleConfig), whose booted arm is
 * test/integration/container-boot-swig-autoescape.test.js §07.
 *
 * Run standalone:
 *   node --test test/core/config-param-bindings-b1124.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
var bindings = require(path.join(FW, 'core/config.param-bindings.js'));
var CONFIG_SRC = fs.readFileSync(process.env.GINA_CONFIG_SRC || path.join(FW, 'core/config.js'), 'utf8');

/** The characters after which a `/` opens a regex literal rather than a division. */
var REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^';
/** The keywords after which a `/` opens a regex literal. */
var REGEX_AFTER_WORD = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Removes the comments of a JavaScript source and keeps everything else, stepping over strings,
 * template literals (with their `${…}` code) and regex literals, so a `//` or `/*` inside one of
 * them never opens a comment, and a `/*` inside a line comment never opens a block comment. A
 * comment becomes a space (a block comment keeps its line breaks).
 *
 * @param {string} src - A JavaScript source
 * @returns {string} The source without its comments
 *
 * @example
 *   stripJsComments("a // x /_gina/* y\nb");   // 'a \nb'
 */
function stripJsComments(src) {
    var out = [], i = 0, n = src.length, state = 'code', braces = [];
    function before() {
        var k = out.length - 1;
        while (k >= 0 && /\s/.test(out[k])) { k--; }
        if (k < 0) { return { ch: '', word: '' }; }
        if (!/[\w$]/.test(out[k])) { return { ch: out[k], word: '' }; }
        var end = k;
        while (k >= 0 && /[\w$]/.test(out[k])) { k--; }
        return { ch: out[end], word: out.slice(k + 1, end + 1).join('') };
    }
    while (i < n) {
        var c = src[i], d = src[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') {
                while (i < n && src[i] !== '\n') { i++; }
                out.push(' ');
                continue;
            }
            if (c === '/' && d === '*') {
                var end = src.indexOf('*/', i + 2);
                var stop = end < 0 ? n : end + 2;
                out.push(' ');
                for (var j = i; j < stop; j++) { if (src[j] === '\n') { out.push('\n'); } }
                i = stop;
                continue;
            }
            if (c === "'" || c === '"') { state = c; out.push(c); i++; continue; }
            if (c === '`') { state = 'tpl'; out.push(c); i++; continue; }
            if (c === '/') {
                var b = before();
                if (b.ch === '' || REGEX_AFTER_CHAR.indexOf(b.ch) > -1 || (b.word && REGEX_AFTER_WORD.indexOf(b.word) > -1)) {
                    state = 're'; out.push(c); i++; continue;
                }
            }
            if (c === '{') { braces.push('{'); }
            else if (c === '}' && braces.pop() === '${') { state = 'tpl'; }
            out.push(c); i++;
            continue;
        }
        if (state === "'" || state === '"' || state === 'tpl') {
            out.push(c);
            if (c === '\\') { if (i + 1 < n) { out.push(src[i + 1]); } i += 2; continue; }
            if (state === 'tpl') {
                if (c === '`') { state = 'code'; }
                else if (c === '$' && d === '{') { out.push('{'); braces.push('${'); state = 'code'; i += 2; continue; }
            } else if (c === state || c === '\n') {
                state = 'code';
            }
            i++;
            continue;
        }
        // a regex literal, or a character class inside one
        out.push(c);
        if (c === '\\') { if (i + 1 < n) { out.push(src[i + 1]); } i += 2; continue; }
        if (state === 're') {
            if (c === '[') { state = 'reclass'; }
            else if (c === '/' || c === '\n') { state = 'code'; }
        } else if (c === ']') {
            state = 're';
        }
        i++;
    }
    return out.join('');
}

/** The `param.<key>` and `param['<key>']` names read in a source (comments removed first). */
function paramKeysRead(src, into) {
    var code = stripJsComments(src), m;
    var dotted = /\bparam\.([A-Za-z_$][\w$]*)/g, bracket = /\bparam\[\s*(['"])([^'"]+)\1\s*\]/g;
    while ((m = dotted.exec(code))) { into[m[1]] = (into[m[1]] || 0) + 1; }
    while ((m = bracket.exec(code))) { into[m[2]] = (into[m[2]] || 0) + 1; }
    return into;
}

/** The framework's server-side .js files under core/ and lib/ (no dist, vendor, test or browser plugin tree). */
function frameworkFiles() {
    var skip = { node_modules: true, dist: true, vendor: true, test: true };
    var browser = path.join('core', 'asset', 'plugin');
    function walk(dir, out) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
            var p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (skip[e.name] || path.relative(FW, p) === browser) { return; }
                walk(p, out);
            } else if (e.isFile() && /\.js$/.test(e.name)) {
                out.push(p);
            }
        });
        return out;
    }
    return walk(path.join(FW, 'core'), []).concat(walk(path.join(FW, 'lib'), []));
}

/** The names of `read` that neither list classifies. */
function unclassified(read) {
    var known = bindings.CONFIG_KEYS.concat(bindings.EXEMPT_KEYS);
    return Object.keys(read).filter(function (k) { return known.indexOf(k) === -1; }).sort();
}

describe('#B1124 — route param bindings under a key gina reads as configuration', function () {

    describe('01 - isConfigKeyBinding', function () {
        bindings.CONFIG_KEYS.forEach(function (k) {
            it('warned: ' + k + ' bound to ":' + k + '" and to another placeholder name', function () {
                assert.equal(bindings.isConfigKeyBinding(k, ':' + k), true);
                assert.equal(bindings.isConfigKeyBinding(k, ':other_name-2'), true);
            });
        });
        it('CONTROL — the 9 exempt keys and plain binding names are never warned', function () {
            bindings.EXEMPT_KEYS.concat(['id', 'slug', 'topic', 'itemCode', 'tab']).forEach(function (k) {
                assert.equal(bindings.isConfigKeyBinding(k, ':' + k), false, k);
            });
        });
        it('CONTROL — a static value, a placeholder inside a longer value and a non-string are not bindings', function () {
            [301, '301', true, false, null, undefined, 0, 'billing', 'home@shop', 'https://example.com:8443/x',
             '/item/:id', 'tab-:tab', 'a:b', ':', '', ' :x', ':x ', ':x/y', ':x.y', [':x'], { v: ':x' }].forEach(function (v) {
                assert.equal(bindings.isConfigKeyBinding('section', v), false, JSON.stringify(v));
            });
        });
        it('CONTROL — an Object.prototype member name is not a warned key', function () {
            ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'].forEach(function (k) {
                assert.equal(bindings.isConfigKeyBinding(k, ':x'), false, k);
            });
        });
        it('the lists: 24 warned and 9 exempt keys, disjoint, frozen', function () {
            assert.equal(bindings.CONFIG_KEYS.length, 24);
            assert.equal(bindings.EXEMPT_KEYS.length, 9);
            assert.equal(bindings.CONFIG_KEYS.filter(function (k) { return bindings.EXEMPT_KEYS.indexOf(k) > -1; }).length, 0);
            assert.equal(new Set(bindings.CONFIG_KEYS.concat(bindings.EXEMPT_KEYS)).size, 33);
            assert.equal(Object.isFrozen(bindings.CONFIG_KEYS), true);
            assert.equal(Object.isFrozen(bindings.EXEMPT_KEYS), true);
        });
    });

    describe('02 - findConfigKeyBindings', function () {
        function table() {
            return {
                '$schema'       : 'https://example.com/routing.json',
                'item@shop'     : { url: '/item/:section', param: { control: 'item', section: ':section' } },
                'plain@shop'    : { url: '/plain/:id', param: { control: 'plain', id: ':id', title: 'Item :id' } },
                'redirect@shop' : { url: '/old/:code', param: { control: 'redirect', path: '/new', code: ':code', 'keep-params': ':keep' } },
                'static@shop'   : { url: '/static', param: { control: 'page', section: 'billing', code: 302 } },
                'noparam@shop'  : { url: '/none' },
                'oddparam@shop' : { url: '/odd', param: 'not an object' },
                'null@shop'     : null
            };
        }
        it('lists every binding under a warned key, in table order, with rule, key and value', function () {
            assert.deepEqual(bindings.findConfigKeyBindings(table()), [
                { rule: 'item@shop', key: 'section', value: ':section' },
                { rule: 'redirect@shop', key: 'code', value: ':code' },
                { rule: 'redirect@shop', key: 'keep-params', value: ':keep' }
            ]);
        });
        it('reads only: the table and each param object are left untouched', function () {
            var t = table(), before = JSON.stringify(t);
            Object.keys(t).forEach(function (r) { if (t[r] && typeof(t[r]) === 'object') { Object.freeze(t[r]); if (t[r].param && typeof(t[r].param) === 'object') { Object.freeze(t[r].param); } } });
            Object.freeze(t);
            bindings.findConfigKeyBindings(t);
            assert.equal(JSON.stringify(t), before);
        });
        it('an empty, missing or non-object table lists nothing', function () {
            assert.deepEqual(bindings.findConfigKeyBindings({}), []);
            assert.deepEqual(bindings.findConfigKeyBindings(undefined), []);
            assert.deepEqual(bindings.findConfigKeyBindings(null), []);
            assert.deepEqual(bindings.findConfigKeyBindings('routing'), []);
        });
    });

    describe('03 - formatConfigKeyBindingWarning', function () {
        it('one binding: singular wording, the bundle, the binding and the guide link, on one line', function () {
            var s = bindings.formatConfigKeyBindingWarning('shop', [ { rule: 'item@shop', key: 'section', value: ':section' } ]);
            assert.ok(s.indexOf('[CONFIG][loadBundleConfig] [ shop ] 1 route param binding uses a key gina reads as configuration') === 0, s);
            assert.ok(s.indexOf('so gina reads its placeholder text, not the URL value: item@shop { section: ":section" }.') > -1, s);
            assert.ok(s.indexOf('Bind the URL segment under another name') > -1, s);
            assert.ok(s.indexOf('https://gina.io/docs/guides/routing#parameterized-url') > -1, s);
            assert.equal(s.indexOf('\n'), -1);
        });
        it('several: plural wording and every binding', function () {
            var s = bindings.formatConfigKeyBindingWarning('shop', [
                { rule: 'item@shop', key: 'section', value: ':section' },
                { rule: 'popup@shop', key: 'isPopinContext', value: ':isPopinContext' }
            ]);
            assert.ok(s.indexOf('[ shop ] 2 route param bindings use a key gina reads as configuration, so gina reads their placeholder text') > -1, s);
            assert.ok(s.indexOf('item@shop { section: ":section" }, popup@shop { isPopinContext: ":isPopinContext" }.') > -1, s);
            assert.ok(s.indexOf('Bind each URL segment under another name') > -1, s);
        });
    });

    describe('04 - core/config.js wiring', function () {
        var CODE = stripJsComments(CONFIG_SRC);
        var gate = CODE.indexOf('var _requirementsApply = ');
        var setRouting = CODE.indexOf('self.setRouting(bundle, env, scope, routing);', gate);
        var call = CODE.indexOf('paramBindings.findConfigKeyBindings(routing)');
        var open = CODE.lastIndexOf('if ( _requirementsApply ) {', call);
        var close = CODE.indexOf('\n        }\n', call);
        var block = (open > -1 && close > -1) ? CODE.slice(open, close) : '';

        it('the module is required once', function () {
            assert.equal(CODE.split("require('./config.param-bindings')").length - 1, 1);
        });
        it('called after setRouting, inside the #B360 gate, which is assigned once', function () {
            assert.ok(gate > -1 && setRouting > gate, 'the #B360 gate and setRouting are present');
            assert.ok(call > setRouting, 'the bindings are listed after setRouting');
            assert.ok(open > setRouting && open < call, 'inside an `if ( _requirementsApply )` block opened after setRouting');
            assert.equal(CODE.match(/_requirementsApply\s*=[^=]/g).length, 1, 'the gate is assigned only where it is declared');
        });
        it('one warning, built by formatConfigKeyBindingWarning', function () {
            assert.equal(block.split('console.warn(').length - 1, 1, block);
            assert.ok(block.indexOf('paramBindings.formatConfigKeyBindingWarning(bundle, _configKeyBindings)') > -1, block);
        });
        it('nothing in the block assigns to the routing table', function () {
            assert.ok(block.length > 0, 'the block was found (anti-vacuity)');
            assert.equal(/routing\s*(\[[^\]]*\]|\.[\w$]+)*\s*=[^=]/.test(block), false, block);
        });
    });

    describe('05 - the census pin: every param key gina reads is warned or exempt', function () {
        it('CONTROL — the comment stripper steps over strings, templates and regex literals', function () {
            var src = [
                "var a = 1; // a line comment naming param.zzLine and /_gina/* (no block opens here)",
                "var b = x.replace(/\\/*$/, '/'); var c = route.param.keptAfterRegex;",
                "var d = '/* in a string */' + \"// also a string\" + route.param.keptAfterStrings;",
                "/* a block comment naming param.zzBlock */ var e = route.param.keptAfterBlock; // param.zzTrailing",
                "var f = `text /* not a comment */ ${ route.param.keptInTemplate } // still text`;",
                "var g = (h + i) / 2 / route.param.keptAfterDivision;",
                "return /[/]/.test(route.param.keptInRegexContext);"
            ].join('\n');
            var read = paramKeysRead(src, {});
            assert.deepEqual(Object.keys(read).sort(), ['keptAfterBlock', 'keptAfterDivision', 'keptAfterRegex', 'keptAfterStrings', 'keptInRegexContext', 'keptInTemplate']);
        });
        it('CONTROL — the classification reports a key neither list holds', function () {
            assert.deepEqual(unclassified({ section: 1, zzNewKey: 1, id: 1 }), ['id', 'zzNewKey']);
            assert.deepEqual(unclassified({ section: 1, path: 2 }), []);
        });
        var files = frameworkFiles();
        var read = {};
        files.forEach(function (f) { paramKeysRead(fs.readFileSync(f, 'utf8'), read); });
        it('CONTROL — the scan reads known keys, including server.js reads a regex strip loses', function () {
            assert.ok(files.length > 100, 'the framework files were found (' + files.length + ')');
            assert.ok(read['keep-params'] > 0, 'the bracket read of keep-params');
            assert.ok(read.wsOptions > 0 && read.wsHandler > 0, 'the WebSocket reads in core/server.js');
            assert.equal(read.zzNotAKey, undefined);
        });
        it('every param key read in core/ and lib/ is warned or exempt', function () {
            assert.deepEqual(unclassified(read), [],
                'add each key to CONFIG_KEYS (gina reads it as configuration) or EXEMPT_KEYS (filled from the URL, read from req.params, written by gina, or unread) in core/config.param-bindings.js');
        });
        it('every warned or exempt key is read somewhere in core/ or lib/', function () {
            var unread = bindings.CONFIG_KEYS.concat(bindings.EXEMPT_KEYS).filter(function (k) { return !(read[k] > 0); });
            assert.deepEqual(unread, []);
        });
    });
});
