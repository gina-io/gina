'use strict';
/**
 * #P40 — `getConfig()` returns a per-call copy-on-write view (`lib/conf-view`), with
 * `settings.json > controller.getConfig.mode: "clone"` as the deep-clone opt-out.
 *
 * Sections:
 *   01 — source pins on the comment-stripped getConfig block (the extraction boundary is a control).
 *   02 — behavioural arms over the SHIPPED bytes: the getConfig region is sliced out of the
 *        source and compiled under `new Function` with its free identifiers (`local`, `lib`,
 *        `getContext`) injected — `lib` carries the REAL `lib/conf-view`.
 *   03 — the same through a real instance (`createTestInstance`), which exercises the registry
 *        wiring end-to-end (lib/index.js → lib.confView).
 *
 * Red-first: `GINA_CONTROLLER_SRC=<pre-#P40 blob> node --test <this file>` — every arm that pins
 * the change goes red; the arms labelled CONTROL pin behaviour the change kept and stay green.
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');
var confView = require(path.join(FW, 'lib/conf-view/src/main.js'));
// The compiled region's clone branch calls the helpers-installed global; install the same
// bytes here (§03's bootstrap installs it too, but §02 runs first).
if ( typeof(JSON.clone) !== 'function' ) { JSON.clone = require('../../utils/prototypes.json_clone'); }

var DECL = 'this.getConfig = function(name) {';
var END  = '\n    /**\n     * Resolve the locale-DB fallback language';

function region() {
    var a = SRC.indexOf(DECL);
    assert.ok(a > -1, 'the getConfig declaration anchor must be present');
    var b = SRC.indexOf(END, a);
    assert.ok(b > a, 'the getConfig region must end at the locale-fallback docblock');
    return SRC.slice(a, b);
}
function stripComments(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
/** The block the historical §08 pins read: from the declaration to the FIRST 4-space close. */
function block() {
    var a = SRC.indexOf(DECL);
    var b = SRC.indexOf('\n    }', a) + 6;
    return SRC.slice(a, b);
}

// ── 01 — source pins ────────────────────────────────────────────────────────

describe('01 - #P40 source pins on getConfig()', function () {
    var live;
    before(function () { live = stripComments(block()); });

    it('the extraction boundary is intact: the first 4-space close after the declaration ends the function (A7)', function () {
        assert.ok(/return tmp;\n    \}$/.test(block()), 'an inner block closing at 4-space indent would truncate every pin on this function');
    });

    it('the bare form hands back a view over the per-request conf', function () {
        assert.ok(live.indexOf('lib.confView.create(local.options.conf)') > -1);
    });

    it('the named form hands back a view over that config\'s content', function () {
        assert.ok(live.indexOf('lib.confView.create(local.options.conf.content[name])') > -1);
    });

    it('the clone opt-out is read from settings.json > controller.getConfig.mode', function () {
        assert.ok(live.indexOf("_cSettings.controller.getConfig.mode == 'clone'") > -1);
    });

    it('CONTROL — both deep-clone literals remain (the opt-out branch keeps the historical pins honest)', function () {
        assert.ok(live.indexOf('JSON.clone(local.options.conf.content[name])') > -1);
        assert.ok(live.indexOf('JSON.clone(local.options.conf)') > -1);
    });

    it('the unconditional deep-clone statement of the bare form is gone', function () {
        assert.strictEqual(live.indexOf('tmp = JSON.clone(local.options.conf);'), -1);
    });

    it('the strip is load-bearing: the raw block names #P40 in a comment and the stripped copy does not', function () {
        assert.ok(block().indexOf('#P40') > -1);
        assert.strictEqual(live.indexOf('#P40'), -1);
    });
});

// ── 02 — behavioural arms over the SHIPPED bytes ────────────────────────────

describe('02 - #P40 behaviour, getConfig() compiled from the source', function () {

    function makeConf(over) {
        var settings = { server: { port: 3000 }, region: { isoShort: 'FR' } };
        var conf = {
            hostname : 'app.example.com',
            host     : 'app.example.com:3000',
            bundle   : 'demo',
            env      : 'dev',
            settings : settings,
            content  : {
                settings : settings,
                app      : { proxy: { api: { host: 'api', port: 80 } }, greeting: 'hi' },
                routing  : { home: { url: '/', param: { control: 'home' } } }
            }
        };
        return Object.assign(conf, over || {});
    }
    function fakes(conf, req) {
        var local = { options: { conf: conf }, req: req || null };
        var lib   = { confView: confView };
        var getContext = function (k) { return ( k === 'isProxyHost' ) ? false : {}; };
        return { local: local, lib: lib, getContext: getContext };
    }
    function build(f) {
        process.gina = process.gina || {};
        var src = region().replace('this.getConfig = function', 'var getConfig = function');
        return new Function('local', 'lib', 'getContext', src + '\nreturn getConfig;')(f.local, f.lib, f.getContext);
    }
    function cloneMode(conf) {
        conf.content.settings.controller = { getConfig: { mode: 'clone' } };
        return conf;
    }

    it('the bare form returns a view, and each call returns a distinct one', function () {
        var g = build(fakes(makeConf()));
        var c1 = g(), c2 = g();
        assert.strictEqual(confView.isView(c1), true);
        assert.strictEqual(confView.isView(c2), true);
        assert.notStrictEqual(c1, c2);
    });

    it('the named form returns a view over that config', function () {
        var g = build(fakes(makeConf()));
        var app = g('app');
        assert.strictEqual(confView.isView(app), true);
        assert.strictEqual(app.greeting, 'hi');
    });

    it('CONTROL — an unknown name returns undefined', function () {
        var g = build(fakes(makeConf()));
        assert.strictEqual(g('nope'), undefined);
    });

    it('CONTROL — writes through the result never reach the request conf nor a second call (view mode)', function () {
        var conf = makeConf(), g = build(fakes(conf));
        var c1 = g();
        c1.hostname = 'mutated';
        c1.content.app.proxy.api.port = 8443;
        var c2 = g();
        assert.strictEqual(conf.hostname, 'app.example.com');
        assert.strictEqual(conf.content.app.proxy.api.port, 80);
        assert.strictEqual(c2.hostname, 'app.example.com');
        assert.strictEqual(c2.content.app.proxy.api.port, 80);
        var app = g('app'); app.greeting = 'x';
        assert.strictEqual(conf.content.app.greeting, 'hi');
        assert.strictEqual(g('app').greeting, 'hi');
    });

    it('CONTROL — writes through the result never reach the request conf nor a second call (clone mode)', function () {
        var conf = cloneMode(makeConf()), g = build(fakes(conf));
        var c1 = g();
        c1.hostname = 'mutated';
        c1.content.app.proxy.api.port = 8443;
        assert.strictEqual(conf.hostname, 'app.example.com');
        assert.strictEqual(conf.content.app.proxy.api.port, 80);
        assert.strictEqual(g().content.app.proxy.api.port, 80);
    });

    it('writes read back through the view', function () {
        var g = build(fakes(makeConf()));
        var c = g();
        c.content.app.proxy.api.port = 8443;
        c.fresh = 1;
        assert.strictEqual(c.content.app.proxy.api.port, 8443);
        assert.strictEqual(c.fresh, 1);
        assert.strictEqual(confView.isView(c), true, 'this arm reads the view, not a clone');
    });

    it('the conf\'s settings / content.settings aliasing is preserved by the view', function () {
        var conf = makeConf(), g = build(fakes(conf));
        assert.strictEqual(conf.settings, conf.content.settings, 'CONTROL — the fixture aliases');
        var c = g();
        assert.strictEqual(c.settings, c.content.settings);
    });

    it('CONTROL — clone mode returns a deep copy, not a view', function () {
        var conf = cloneMode(makeConf()), g = build(fakes(conf));
        var c = g();
        assert.strictEqual(confView.isView(c), false);
        assert.notStrictEqual(c.content.app, conf.content.app);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(c.content.app)), conf.content.app);
        assert.strictEqual(confView.isView(g('app')), false);
    });

    it('CONTROL — an untouched view serialises exactly as the clone does', function () {
        var viewConf = makeConf(), cloneConf = cloneMode(makeConf());
        var v = build(fakes(viewConf))(), c = build(fakes(cloneConf))();
        var vj = JSON.parse(JSON.stringify(v)), cj = JSON.parse(JSON.stringify(c));
        delete cj.content.settings.controller; delete cj.settings.controller;
        assert.deepStrictEqual(vj, cj);
    });

    it('CONTROL — the #B66 proxy host rewrite lands on the result, never on the request conf (both modes)', function () {
        [makeConf(), cloneMode(makeConf())].forEach(function (conf) {
            var req = { _ginaIsProxyHost: true, _ginaProxyHostname: 'pub.example.org', _ginaProxyHost: 'pub.example.org:443' };
            var c = build(fakes(conf, req))();
            assert.strictEqual(c.hostname, 'pub.example.org');
            assert.strictEqual(c.host, 'pub.example.org:443');
            assert.strictEqual(conf.hostname, 'app.example.com');
            assert.strictEqual(conf.host, 'app.example.com:3000');
        });
    });

    it('CONTROL — without a slot, the worker-global fallback still applies', function () {
        var conf = makeConf();
        var f = fakes(conf, null);
        f.getContext = function (k) { return ( k === 'isProxyHost' ) ? true : {}; };
        process.gina = process.gina || {};
        var saved = { h: process.gina.PROXY_HOSTNAME, H: process.gina.PROXY_HOST };
        process.gina.PROXY_HOSTNAME = 'g.example.org'; process.gina.PROXY_HOST = 'g.example.org:8443';
        try {
            var c = build(f)();
            assert.strictEqual(c.hostname, 'g.example.org');
            assert.strictEqual(conf.hostname, 'app.example.com');
        } finally {
            process.gina.PROXY_HOSTNAME = saved.h; process.gina.PROXY_HOST = saved.H;
        }
    });

    it('the three documented limitations hold on what getConfig() returns', function () {
        var g = build(fakes(makeConf()));
        var c = g();
        assert.throws(function () { structuredClone(g('app')); }, function (e) { return e && e.name === 'DataCloneError'; });
        assert.throws(function () { Object.freeze(c.content.app); }, TypeError);
        Object.keys(c.content);
        Object.freeze(c.content.app);
        assert.strictEqual(Object.isFrozen(c.content.app), true);
        assert.strictEqual(require('util').inspect(g()).indexOf('app.example.com') > -1, true, 'inspect shows the shared values');
    });

    it('CONTROL — before setOptions, the named form returns undefined and the bare form throws', function () {
        var f = fakes(makeConf()); f.local = {};
        var g = build(f);
        assert.strictEqual(g('app'), undefined);
        assert.throws(function () { g(); }, TypeError);
    });
});

// ── 03 — a real instance ────────────────────────────────────────────────────

describe('03 - #P40 on a real instance (createTestInstance — the registry wiring end-to-end)', function () {
    var SuperController;
    before(function () {
        process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
        require('module').Module._initPaths();
        require(path.join(FW, 'helpers'));
        require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));
        process.gina = process.gina || {};
        setPath('gina', { core: path.join(FW, 'core') });
        SuperController = require(SOURCE);
    });

    function mk() {
        var settings = { server: { port: 3000 } };
        return SuperController.createTestInstance({
            req  : { method: 'GET', url: '/', headers: {}, routing: { param: {} } },
            res  : { statusCode: 200, headersSent: false, getHeaders: function () { return {}; },
                     getHeader: function () {}, setHeader: function () {}, writeHead: function () {}, end: function () {} },
            next : function () {},
            options: { rule: '_p40', controller: '/app/controllers/index.js', control: 'act', bundle: 'test',
                       conf: { bundle: 'test', server: { protocol: 'http/1.1', coreConfiguration: { mime: {}, statusCodes: {} } },
                               encoding: 'utf-8', settings: settings,
                               content: { routing: { _p40: {} }, settings: settings, app: { greeting: 'hi', proxy: { api: { port: 80 } } } } } }
        });
    }

    it('getConfig() and getConfig(name) return views through the registered lib', function () {
        var inst = mk();
        assert.strictEqual(confView.isView(inst.getConfig()), true);
        assert.strictEqual(confView.isView(inst.getConfig('app')), true);
    });

    it('CONTROL — values read through and the named form reads that config', function () {
        var inst = mk();
        assert.strictEqual(inst.getConfig('app').greeting, 'hi');
        assert.strictEqual(inst.getConfig().content.app.proxy.api.port, 80);
    });

    it('CONTROL — a write through one call is invisible to the next', function () {
        var inst = mk();
        var a = inst.getConfig('app'); a.greeting = 'changed'; a.proxy.api.port = 1;
        assert.strictEqual(inst.getConfig('app').greeting, 'hi');
        assert.strictEqual(inst.getConfig().content.app.proxy.api.port, 80);
    });

    it('the settings aliasing survives on a real instance', function () {
        var c = mk().getConfig();
        assert.strictEqual(c.settings, c.content.settings);
    });
});
