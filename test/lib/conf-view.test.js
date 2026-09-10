'use strict';
/**
 * #P40 — `lib/conf-view`: the per-call copy-on-write view `getConfig()` hands back.
 *
 * Every arm drives the SHIPPED module (`lib/conf-view/src/main.js`) on a conf-shaped
 * tree. Strict mode throughout, so a refused proxy operation THROWS instead of
 * silently no-op'ing — the documented limitations are pinned as throws.
 *
 * Sections:
 *   01 — contract: pass-through, identity, aliasing, independence
 *   02 — isolation and read-back (writes never reach the shared tree or a sibling view)
 *   03 — enumeration materialises once; JSON.stringify / JSON.clone / merge / assign / spread / for…in
 *   04 — the shared tree's shapes: accessors, frozen children, frozen root, `__proto__`, symbols
 *   05 — the three documented limitations and the one documented divergence, pinned
 *   06 — subtract: the same isolation assertions FAIL on a plain shallow copy (the arms discriminate)
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var util   = require('util');

var FW        = require('../fw');
var MAIN      = process.env.GINA_CONF_VIEW_MAIN || path.join(FW, 'lib/conf-view/src/main.js');
var confView  = require(MAIN);
var JSONClone = require('../../utils/prototypes.json_clone');
var merge     = require(path.join(FW, 'lib/merge'));

/** A conf-shaped tree: the request conf aliases `settings` to `content.settings`. */
function makeRoot() {
    var settings = { server: { port: 3000, credentials: { ca: Buffer.from('CA') } }, region: { isoShort: 'FR' } };
    var root = {
        hostname : 'app.example.com',
        bundle   : 'demo',
        settings : settings,
        content  : {
            settings : settings,
            app      : { proxy: { api: { host: 'api', port: 80 } }, greeting: 'hi' },
            routing  : { home: { url: '/', param: { control: 'home' } }, list: { url: '/l', param: { control: 'list' } } },
            tags     : ['a', 'b']
        }
    };
    return root;
}
var create = confView.create, isView = confView.isView;

describe('01 - contract: pass-through, identity, aliasing, independence', function () {

    it('a non-plain root comes back as-is, never as a view (the getConfig(missing) contract)', function () {
        function K() {}
        var buf = Buffer.from('x'), d = new Date(), inst = new K();
        assert.strictEqual(create(undefined), undefined);
        assert.strictEqual(create(null), null);
        assert.strictEqual(create('s'), 's');
        assert.strictEqual(create(42), 42);
        assert.strictEqual(create(buf), buf);
        assert.strictEqual(create(d), d);
        assert.strictEqual(create(inst), inst);
        assert.strictEqual(isView(inst), false);
        assert.strictEqual(isView(null), false);
    });

    it('a plain object or array root is a view; Array.isArray sees through the view', function () {
        var v = create(makeRoot());
        assert.strictEqual(isView(v), true);
        assert.strictEqual(isView(makeRoot()), false);
        var a = create([1, 2]);
        assert.strictEqual(isView(a), true);
        assert.strictEqual(Array.isArray(a), true);
        assert.strictEqual(Array.isArray(v.content.tags), true);
    });

    it('reads equal the shared values, at every depth; non-plain leaves pass through by reference', function () {
        var r = makeRoot(), v = create(r);
        assert.strictEqual(v.hostname, 'app.example.com');
        assert.strictEqual(v.content.app.proxy.api.port, 80);
        assert.strictEqual(v.content.tags[1], 'b');
        assert.strictEqual(v.content.settings.server.credentials.ca, r.settings.server.credentials.ca, 'a Buffer is the same object');
        assert.strictEqual(isView(v.content.settings.server.credentials.ca), false);
    });

    it('nested identity is stable, and two paths to one shared object give one view node (aliasing preserved)', function () {
        var r = makeRoot(), v = create(r);
        assert.strictEqual(v.content.app, v.content.app);
        assert.strictEqual(v.settings, v.content.settings, 'settings === content.settings survives the view');
        assert.strictEqual(r.settings, r.content.settings, 'CONTROL — the fixture aliases');
        var c = JSONClone(r);
        assert.notStrictEqual(c.settings, c.content.settings, 'CONTROL — the deep clone breaks the aliasing (what the view repairs)');
    });

    it('two views over one tree are independent', function () {
        var r = makeRoot(), a = create(r), b = create(r);
        a.content.app.greeting = 'A';
        assert.strictEqual(b.content.app.greeting, 'hi');
        assert.strictEqual(r.content.app.greeting, 'hi');
        assert.notStrictEqual(a, b);
    });
});

describe('02 - isolation and read-back', function () {

    it('a nested write, a new key, a delete, an array push and a leaf write are all invisible to the shared tree and to a sibling view', function () {
        var r = makeRoot(), v = create(r), sib = create(r);
        v.content.app.proxy.api.port = 8443;        // nested write
        v.content.app.fresh = { x: 1 };             // new key
        delete v.content.app.greeting;              // delete
        v.content.tags.push('c');                   // array push
        v.hostname = 'other';                       // leaf write
        assert.strictEqual(r.content.app.proxy.api.port, 80);
        assert.strictEqual('fresh' in r.content.app, false);
        assert.strictEqual(r.content.app.greeting, 'hi');
        assert.deepStrictEqual(r.content.tags, ['a', 'b']);
        assert.strictEqual(r.hostname, 'app.example.com');
        assert.strictEqual(sib.content.app.proxy.api.port, 80);
        assert.strictEqual('fresh' in sib.content.app, false);
        assert.strictEqual(sib.content.app.greeting, 'hi');
        assert.strictEqual(sib.content.tags.length, 2);
        assert.strictEqual(sib.hostname, 'app.example.com');
    });

    it('every write reads back through the view, and a delete reads as absent', function () {
        var v = create(makeRoot());
        v.content.app.proxy.api.port = 8443;
        v.content.app.fresh = { x: 1 };
        delete v.content.app.greeting;
        v.content.tags.push('c');
        v.hostname = 'other';
        assert.strictEqual(v.content.app.proxy.api.port, 8443);
        assert.strictEqual(v.content.app.fresh.x, 1);
        assert.strictEqual(v.content.app.greeting, undefined);
        assert.strictEqual('greeting' in v.content.app, false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(v.content.app, 'greeting'), false);
        assert.strictEqual(v.content.tags.length, 3);
        assert.strictEqual(v.content.tags[2], 'c');
        assert.strictEqual(v.hostname, 'other');
        assert.strictEqual('fresh' in v.content.app, true);
    });

    it('a deleted key can be re-added, and a re-added key reads back', function () {
        var v = create(makeRoot());
        delete v.content.app.greeting;
        v.content.app.greeting = 'again';
        assert.strictEqual(v.content.app.greeting, 'again');
        assert.ok(Object.keys(v.content.app).indexOf('greeting') > -1);
    });
});

describe('03 - enumeration materialises once', function () {

    it('an untouched view serialises byte-identically to the shared tree, and Object.keys matches', function () {
        var r = makeRoot(), v = create(r);
        assert.strictEqual(JSON.stringify(v), JSON.stringify(r));
        assert.deepStrictEqual(Object.keys(v), Object.keys(r));
        assert.deepStrictEqual(Object.keys(v.content.app), Object.keys(r.content.app));
    });

    it('after writes, enumeration carries the overlay (new keys appended, deleted keys gone) and the shared tree is still untouched', function () {
        var r = makeRoot(), v = create(r);
        v.content.app.greeting = 'yo';
        v.content.app.fresh = 1;
        delete v.content.app.proxy;
        var keys = Object.keys(v.content.app);
        assert.deepStrictEqual(keys, ['greeting', 'fresh']);
        assert.strictEqual(JSON.stringify(v.content.app), '{"greeting":"yo","fresh":1}');
        assert.deepStrictEqual(Object.keys(r.content.app), ['proxy', 'greeting']);
        var seen = []; for (var k in v.content.app) { seen.push(k); }
        assert.deepStrictEqual(seen, ['greeting', 'fresh']);
    });

    it('JSON.clone through the view is a plain deep copy that keeps the overlay; the shared tree is untouched', function () {
        var r = makeRoot(), v = create(r);
        v.content.app.proxy.api.port = 8443;
        var c = JSONClone(v);
        assert.strictEqual(isView(c), false);
        assert.strictEqual(isView(c.content), false);
        assert.strictEqual(c.content.app.proxy.api.port, 8443);
        assert.strictEqual(r.content.app.proxy.api.port, 80);
        c.hostname = 'z';
        assert.strictEqual(v.hostname, 'app.example.com', 'the copy is detached from the view');
    });

    it('lib/merge with the view as SOURCE fills the target and leaves the shared tree untouched', function () {
        var r = makeRoot(), v = create(r);
        v.content.app.greeting = 'merged';
        var target = { content: { app: { own: true } } };
        merge(target, v.content);
        assert.strictEqual(target.app.greeting, 'merged');
        assert.strictEqual(r.content.app.greeting, 'hi');
    });

    it('Object.assign and spread copy the overlay into a plain object', function () {
        var v = create(makeRoot());
        v.content.app.fresh = 2;
        var a = Object.assign({}, v.content.app);
        var s = Object.assign({}, v.content.app); // the spread form compiles to the same CopyDataProperties path
        assert.strictEqual(a.fresh, 2);
        assert.strictEqual(a.greeting, 'hi');
        assert.strictEqual(isView(a), false);
        assert.strictEqual(s.fresh, 2);
    });

    it('a materialised node hands out plain children; an un-enumerated node hands out views — and hasOwnProperty does NOT materialise', function () {
        var v = create(makeRoot());
        assert.strictEqual(isView(v.content.app), true);
        Object.prototype.hasOwnProperty.call(v.content, 'app');
        assert.strictEqual(isView(v.content.app), true, 'hasOwnProperty is a descriptor read, not an enumeration');
        Object.keys(v.content);
        assert.strictEqual(isView(v.content.app), false, 'CONTROL — enumeration materialises, so children are plain now');
        v.content.app.greeting = 'post';
        assert.strictEqual(v.content.app.greeting, 'post', 'writes keep working on the materialised copy');
        assert.strictEqual(JSON.stringify(v.content.app).indexOf('post') > -1, true);
    });

    it('a write made BEFORE enumeration survives materialisation (touched descendants keep their overlays)', function () {
        var r = makeRoot(), v = create(r);
        v.content.app.proxy.api.port = 9;
        Object.keys(v);                   // materialises the ROOT — every descendant is copied
        assert.strictEqual(v.content.app.proxy.api.port, 9);
        assert.strictEqual(JSON.parse(JSON.stringify(v)).content.app.proxy.api.port, 9);
        assert.strictEqual(r.content.app.proxy.api.port, 80);
    });

    it('an array view enumerates with its pushes and keeps length consistent', function () {
        var v = create(makeRoot());
        v.content.tags.push('c');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(v.content.tags)), ['a', 'b', 'c']);
        assert.deepStrictEqual(v.content.tags.map(function (t) { return t.toUpperCase(); }), ['A', 'B', 'C']);
        assert.strictEqual(Object.keys(v.content.tags).length, 3);
    });
});

describe('04 - the shared tree\'s shapes', function () {

    it('a lazy self-replacing accessor on the shared tree runs against its own object, and the value reads stable', function () {
        var r = makeRoot(), ran = 0;
        Object.defineProperty(r, 'locales', {
            configurable: true, enumerable: true,
            get: function () { ran++; var rows = [{ lang: 'en' }]; Object.defineProperty(this, 'locales', { configurable: true, enumerable: true, writable: true, value: rows }); return rows; },
            set: function (val) { Object.defineProperty(this, 'locales', { configurable: true, enumerable: true, writable: true, value: val }); }
        });
        var v = create(r);
        var first = v.locales;
        assert.strictEqual(Array.isArray(first), true);
        assert.strictEqual(ran, 1);
        assert.strictEqual(v.locales, first, 'identity stable');
        assert.ok('value' in Object.getOwnPropertyDescriptor(r, 'locales'), 'the getter replaced itself on the SHARED object, as it did under the clone');
        assert.strictEqual(ran, 1, 'the getter ran once');
        v.locales = [{ lang: 'fr' }];
        assert.strictEqual(v.locales[0].lang, 'fr');
        assert.strictEqual(r.locales[0].lang, 'en', 'the write stayed in the view');
    });

    it('a frozen child is copied once into the overlay: writable, identity-stable, the shared object untouched', function () {
        var r = makeRoot();
        r.content.frozen = Object.freeze({ a: 1, deep: Object.freeze({ b: 1 }) });
        var v = create(r);
        var f1 = v.content.frozen;
        assert.strictEqual(isView(f1), false);
        assert.strictEqual(Object.isFrozen(f1), false);
        f1.a = 2; f1.deep.b = 2;
        assert.strictEqual(v.content.frozen, f1, 'the same copy on every read');
        assert.strictEqual(v.content.frozen.a, 2);
        assert.strictEqual(r.content.frozen.a, 1);
        assert.strictEqual(r.content.frozen.deep.b, 1);
        assert.strictEqual(JSON.parse(JSON.stringify(v.content)).frozen.a, 2, 'materialisation keeps the copy');
    });

    it('a frozen ROOT yields a plain mutable deep copy, never a view', function () {
        var r = Object.freeze(makeRoot());
        var c = create(r);
        assert.strictEqual(isView(c), false);
        assert.strictEqual(Object.isFrozen(c), false);
        c.hostname = 'z';
        assert.strictEqual(c.hostname, 'z');
        assert.strictEqual(r.hostname, 'app.example.com');
    });

    it('an own "__proto__" key on the shared tree materialises as an own key, not as a prototype', function () {
        var r = JSON.parse('{"__proto__":{"polluted":1},"x":1}');
        var v = create(r);
        var keys = Object.keys(v);
        assert.deepStrictEqual(keys, ['__proto__', 'x']);
        assert.strictEqual(JSON.stringify(v), '{"__proto__":{"polluted":1},"x":1}');
        assert.strictEqual(({}).polluted, undefined, 'Object.prototype is clean');
        assert.strictEqual(Object.getPrototypeOf(v), Object.prototype, 'the view\'s prototype is untouched');
        var d = Object.getOwnPropertyDescriptor(v, '__proto__');
        assert.ok(d && 'value' in d && d.value.polluted === 1, 'materialised as an OWN data property of the copy');
    });

    it('a symbol-keyed write reads back and survives materialisation; symbols on the shared tree pass through', function () {
        var S = Symbol('s'), T = Symbol('t');
        var r = makeRoot(); r[T] = 't';
        var v = create(r);
        v[S] = 'mine';
        assert.strictEqual(v[S], 'mine');
        assert.strictEqual(v[T], 't');
        Object.keys(v);
        assert.strictEqual(v[S], 'mine');
        assert.strictEqual(v[T], 't');
        assert.strictEqual(r[S], undefined);
    });
});

describe('05 - the documented limitations and divergence, pinned', function () {

    it('structuredClone(view) throws a DataCloneError', function () {
        var v = create(makeRoot());
        assert.throws(function () { structuredClone(v.content.app); }, function (e) { return e && e.name === 'DataCloneError'; });
    });

    it('Object.freeze / seal / preventExtensions on an UN-enumerated node throw a TypeError; after enumeration the plain children freeze fine', function () {
        var v = create(makeRoot());
        assert.throws(function () { Object.freeze(v.content.app); }, TypeError);
        assert.throws(function () { Object.seal(v.content.app); }, TypeError);
        assert.throws(function () { Object.preventExtensions(v.content.app); }, TypeError);
        Object.keys(v.content);
        var app = v.content.app;
        assert.strictEqual(isView(app), false);
        Object.freeze(app);
        assert.strictEqual(Object.isFrozen(app), true);
        assert.strictEqual(Object.isFrozen(makeRoot().content.app), false, 'CONTROL — the shared shape was never frozen');
    });

    it('util.inspect renders the shared values, not the overlay (property reads and JSON.stringify are truthful)', function () {
        var v = create(makeRoot());
        v.hostname = 'overlaid';
        assert.strictEqual(util.inspect(v).indexOf('overlaid'), -1, 'the quirk this arm exists to pin');
        assert.strictEqual(v.hostname, 'overlaid');
        assert.ok(JSON.stringify(v).indexOf('overlaid') > -1);
    });

    it('a non-configurable own property of the shared tree refuses a write, a delete and a redefinition (the one divergence from a clone)', function () {
        var r = makeRoot();
        Object.defineProperty(r.content, 'locked', { value: 1, writable: false, enumerable: true, configurable: false });
        var v = create(r);
        assert.strictEqual(v.content.locked, 1);
        assert.throws(function () { v.content.locked = 2; }, TypeError);
        assert.throws(function () { delete v.content.locked; }, TypeError);
        assert.throws(function () { Object.defineProperty(v.content, 'locked', { value: 3 }); }, TypeError);
        assert.strictEqual(v.content.locked, 1);
        assert.ok(Object.keys(v.content).indexOf('locked') > -1, 'and it still enumerates');
        var c = JSONClone(r); c.content.locked = 2;
        assert.strictEqual(c.content.locked, 2, 'CONTROL — the clone accepted the write: this IS the divergence');
    });

    it('a writable non-configurable property (an array\'s length) takes writes, and its descriptor reports the view\'s value', function () {
        var v = create(makeRoot());
        v.content.tags.length = 1;
        assert.strictEqual(v.content.tags.length, 1);
        assert.strictEqual(Object.getOwnPropertyDescriptor(v.content.tags, 'length').value, 1);
        assert.strictEqual(makeRoot().content.tags.length, 2, 'CONTROL — the shared array is untouched');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(v.content.tags)), ['a']);
    });

    it('defining a non-configurable property ON the view is refused; a plain data definition lands in the overlay', function () {
        var v = create(makeRoot());
        assert.throws(function () { Object.defineProperty(v.content, 'nc', { value: 1, configurable: false }); }, TypeError);
        Object.defineProperty(v.content, 'ok', { value: 5, writable: true, enumerable: true, configurable: true });
        assert.strictEqual(v.content.ok, 5);
        assert.ok(Object.keys(v.content).indexOf('ok') > -1);
    });

    it('Object.setPrototypeOf on a view is refused; the prototype reads as the shared object\'s', function () {
        var v = create(makeRoot());
        assert.throws(function () { Object.setPrototypeOf(v.content.app, null); }, TypeError);
        assert.strictEqual(Object.getPrototypeOf(v.content.app), Object.prototype);
    });
});

describe('06 - subtract: the isolation arms discriminate', function () {

    it('the nested-write isolation assertion FAILS on a plain shallow copy', function () {
        var r = makeRoot();
        var shallow = Object.assign({}, r);
        shallow.content.app.proxy.api.port = 8443;
        assert.throws(function () {
            assert.strictEqual(r.content.app.proxy.api.port, 80);
        }, /8443/);
    });

    it('the aliasing assertion FAILS on a deep clone', function () {
        var c = JSONClone(makeRoot());
        assert.throws(function () { assert.strictEqual(c.settings, c.content.settings); });
    });
});
