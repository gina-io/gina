'use strict';
/**
 * #P40 S3b — the router's per-request conf copies the routing MAP and the MATCHED RULE
 * shallowly instead of deep-cloning the whole routing map on every matched request.
 *
 * The only per-request write is the `[rule].param` replacement on the matched rule, and the
 * middleware array `processMiddlewares` splices is already the request's own copy from the
 * matcher — so every other rule can stay shared by reference. This file drives the SHIPPED
 * bytes: the conf-construction region is sliced out of `router.js` and compiled under
 * `new Function('options', 'conf', 'params', …)`.
 *
 * Red-first: `GINA_ROUTER_SRC=<pre-S3b blob> node --test <this file>` — the pins and the
 * shared-rule arm go red; the arms labelled CONTROL pin what the change kept and stay green.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');
// The pre-change region calls the helpers-installed global; install the same bytes here.
if ( typeof(JSON.clone) !== 'function' ) { JSON.clone = require('../../utils/prototypes.json_clone'); }

var START = '        options.conf = Object.assign({}, conf);';
var END   = '        delete options.middleware;';

function region() {
    var a = SRC.indexOf(START);
    assert.ok(a > -1, 'the per-request conf construction anchor must be present');
    assert.strictEqual(SRC.indexOf(START, a + 1), -1, 'the anchor must be unique');
    var b = SRC.indexOf(END, a);
    assert.ok(b > a, 'the region must end at the options.middleware delete');
    return SRC.slice(a, b);
}
function stripComments(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

describe('01 - #P40 S3b source pins on the per-request conf construction', function () {
    var live = stripComments(region());

    it('the routing map is copied shallowly', function () {
        assert.ok(live.indexOf('options.conf.content.routing = Object.assign({}, conf.content.routing);') > -1);
    });

    it('the matched rule is copied shallowly', function () {
        assert.ok(live.indexOf('options.conf.content.routing[options.rule] = Object.assign({}, conf.content.routing[options.rule]);') > -1);
    });

    it('the deep clone of the whole routing map is gone from the live code', function () {
        assert.strictEqual(live.indexOf('options.conf.content.routing = JSON.clone(conf.content.routing);'), -1);
    });

    it('the per-rule copy precedes the [rule].param write, which is unchanged', function () {
        var copyIdx  = live.indexOf('options.conf.content.routing[options.rule] = Object.assign({}, conf.content.routing[options.rule]);');
        var writeIdx = live.indexOf('options.conf.content.routing[options.rule].param = params.param;');
        assert.ok(copyIdx > -1 && writeIdx > -1);
        assert.ok(writeIdx > copyIdx);
    });

    it('CONTROL — the top-level and content shallow copies are unchanged', function () {
        assert.ok(live.indexOf('options.conf = Object.assign({}, conf);') > -1);
        assert.ok(live.indexOf('options.conf.content = Object.assign({}, conf.content);') > -1);
    });

    it('the strip is load-bearing: the raw region names #P40 in a comment and the stripped copy does not', function () {
        assert.ok(region().indexOf('#P40') > -1);
        assert.strictEqual(live.indexOf('#P40'), -1);
    });
});

describe('02 - #P40 S3b behaviour, the construction compiled from the source', function () {

    function makeConf() {
        return {
            server  : { coreConfiguration: { mime: {} } },
            content : {
                templates : { _common: { ginaLoader: '/loader.js' } },
                settings  : { region: { isoShort: 'FR' } },
                routing   : {
                    home : { url: '/',      param: { control: 'home' } },
                    list : { url: '/l',     param: { control: 'list' } },
                    item : { url: '/i/:id', param: { control: 'item', id: ':id' } }
                }
            }
        };
    }
    function run(conf, rule, params) {
        var options = { rule: rule, template: {} };
        new Function('options', 'conf', 'params', region())(options, conf, params);
        return options;
    }

    it('the routing map and the matched rule are fresh objects; the OTHER rules stay shared by reference', function () {
        var conf = makeConf();
        var o = run(conf, 'home', { param: { control: 'home' } });
        assert.notStrictEqual(o.conf, conf);
        assert.notStrictEqual(o.conf.content, conf.content);
        assert.notStrictEqual(o.conf.content.routing, conf.content.routing, 'a fresh map');
        assert.notStrictEqual(o.conf.content.routing.home, conf.content.routing.home, 'a fresh matched rule');
        assert.strictEqual(o.conf.content.routing.list, conf.content.routing.list, 'an unmatched rule is the shared object');
        assert.strictEqual(o.conf.content.routing.item, conf.content.routing.item, 'an unmatched rule is the shared object');
    });

    it('CONTROL — the matched rule carries this request\'s param and the shared rule keeps its own', function () {
        var conf = makeConf();
        var params = { param: { control: 'item', id: '42' } };
        var o = run(conf, 'item', params);
        assert.strictEqual(o.conf.content.routing.item.param, params.param, 'the matcher\'s fresh param is installed');
        assert.strictEqual(o.conf.content.routing.item.url, '/i/:id', 'the rest of the rule reads through');
        assert.strictEqual(conf.content.routing.item.param.id, ':id', 'the shared declaration is untouched');
    });

    it('CONTROL — a write on the request\'s matched rule never reaches the shared rule', function () {
        var conf = makeConf();
        var o = run(conf, 'home', { param: { control: 'home' } });
        o.conf.content.routing.home.url = '/mutated';
        o.conf.content.routing.home.param.injected = 'X';
        assert.strictEqual(conf.content.routing.home.url, '/');
        assert.strictEqual(conf.content.routing.home.param.injected, undefined);
    });

    it('CONTROL — two concurrent requests on the same rule do not bleed through content.routing', function () {
        var conf = makeConf();
        var a = run(conf, 'home', { param: { control: 'home', reqId: 'A' } });
        var b = run(conf, 'home', { param: { control: 'home', reqId: 'B' } });
        assert.strictEqual(a.conf.content.routing.home.param.reqId, 'A');
        assert.strictEqual(b.conf.content.routing.home.param.reqId, 'B');
        assert.strictEqual(conf.content.routing.home.param.reqId, undefined);
    });

    it('CONTROL — the large immutable subtrees stay shared, and the template loader is inherited from _common', function () {
        var conf = makeConf();
        var o = run(conf, 'home', { param: { control: 'home' } });
        assert.strictEqual(o.conf.server, conf.server);
        assert.strictEqual(o.conf.content.templates, conf.content.templates);
        assert.strictEqual(o.conf.content.settings, conf.content.settings);
        assert.strictEqual(o.template.ginaLoader, '/loader.js');
    });

    it('subtract — the deep clone the change removed WOULD have kept every rule private (the shared-rule arm discriminates)', function () {
        var conf = makeConf();
        var routing = JSON.clone(conf.content.routing);
        assert.notStrictEqual(routing.list, conf.content.routing.list, 'a deep clone separates the unmatched rule too');
    });
});
