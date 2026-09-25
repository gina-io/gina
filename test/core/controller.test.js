var { describe, it, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.js');


// 01 — #B98 pure-logic replica: the routing-param `title` promotion + the
// route-name fallback, run against the REAL lib/merge. set()/parseDataObject
// below are the FROZEN pre-#P39-slice-2 implementation (retired 2026-08-27):
// kept as this suite's oracle because #B98 is about WHICH set() calls run, and
// the live set() is structure-equivalent for every primitive-path write —
// pinned by test/core/controller-set-path.test.js §02. §03 source-pins the
// #B98 call sites (not the setter), so this replica cannot mislead. The historical generic
// promotion loop (removed by #B98) is kept as a SUBTRACT control proving the
// defect: its dispatch sat after a `continue` that always fired, so it never
// called set() at all.
describe('01 - #B98 routing param.title promotion + route-name fallback (pure-logic replica, real lib/merge)', function() {

    var FW_B98 = require('../fw');
    var mergeB98 = require(path.join(FW_B98, 'lib/merge'));

    // FROZEN replicas of the retired parseDataObject + set (pre-#P39 slice 2) —
    // fresh closure state per call via makeSetter, mirroring the per-request
    // `local` closure. Deliberately NOT the live implementation: see the header.
    function makeSetter() {
        var local = { userData: {} };
        var parseDataObject = function(o, obj, override) {
            var keys = Object.keys(o);
            for (var ki = 0; ki < keys.length; ++ki) {
                var i = keys[ki];
                if ( o[i] !== null && typeof(o[i]) == 'object' || override && o[i] !== null && typeof(o[i]) == 'object' ) {
                    parseDataObject(o[i], obj);
                } else if (o[i] == '_content_'){
                    o[i] = obj
                }
            }
            return o
        };
        var set = function(name, value, override) {
            var _override = ( typeof(override) != 'undefined' ) ? override : false;
            if ( typeof(name) == 'string' && /\./.test(name) ) {
                var keys        = name.split(/\./g)
                    , newObj    = {}
                    , str       = '{'
                    , _count    = 0;
                for (let k = 0, len = keys.length; k<len; ++k) {
                    str +=  "\""+ keys.splice(0,1)[0] + "\":{";
                    ++_count;
                    if (k == len-1) {
                        str = str.substring(0, str.length-1);
                        str += "\"_content_\"";
                        for (let c = 0; c<_count; ++c) {
                            str += "}"
                        }
                    }
                }
                newObj = parseDataObject(JSON.parse(str), value, _override);
                local.userData = mergeB98(local.userData, newObj);
            } else if ( typeof(local.userData[name]) == 'undefined' ) {
                local.userData[name] = value.replace(/\\/g, '');
            }
        };
        return { local: local, set: set };
    }

    // Replica of the shipped #B98 sequence inside setOptions():
    // (1) the guarded param.title promotion (runs first),
    // (2) the route-name fallback write (runs later, inside the hasViews block).
    function runTitleSequence(param, rule, bundle, setter) {
        if ( typeof(param) != 'undefined' ) {
            var p = param;
            if ( typeof(p.title) == 'string' && p.title !== '' ) {
                setter.set('page.view.title', p.title);
            }
        }
        setter.set('page.view.title', rule.split('@' + bundle).join(''));
    }

    it('param.title lands on page.view.title and SURVIVES the route-name fallback (merge is target-wins)', function() {
        var s = makeSetter();
        runTitleSequence({ control: 'home', title: 'My Title' }, 'home@b', 'b', s);
        assert.equal(s.local.userData.page.view.title, 'My Title');
    });

    it('title-less rule → the route-name fallback fills page.view.title (back-compat preserved)', function() {
        var s = makeSetter();
        runTitleSequence({ control: 'home' }, 'home@b', 'b', s);
        assert.equal(s.local.userData.page.view.title, 'home');
    });

    it('the fallback strips the @bundle qualifier from the rule name', function() {
        var s = makeSetter();
        runTitleSequence(undefined, 'orders-list@shop', 'shop', s);
        assert.equal(s.local.userData.page.view.title, 'orders-list');
    });

    it('empty-string param.title is skipped → route-name fallback applies', function() {
        var s = makeSetter();
        runTitleSequence({ control: 'home', title: '' }, 'home@b', 'b', s);
        assert.equal(s.local.userData.page.view.title, 'home');
    });

    it('non-string param.title is skipped → route-name fallback applies', function() {
        var s = makeSetter();
        runTitleSequence({ control: 'home', title: 123 }, 'home@b', 'b', s);
        assert.equal(s.local.userData.page.view.title, 'home');
    });

    it('sibling page.view fills (file/namespace) gap-fill next to the promoted title', function() {
        var s = makeSetter();
        runTitleSequence({ control: 'home', title: 'My Title' }, 'home@b', 'b', s);
        s.set('page.view.file', 'index');
        s.set('page.view.namespace', 'default');
        assert.equal(s.local.userData.page.view.title, 'My Title');
        assert.equal(s.local.userData.page.view.file, 'index');
        assert.equal(s.local.userData.page.view.namespace, 'default');
    });

    it('controller data.page.view.title wins the render two-step merge over the rule title', function() {
        // render-swig: data = merge(userDataFromController, data) — target wins.
        var s = makeSetter();
        runTitleSequence({ control: 'home', title: 'From Rule' }, 'home@b', 'b', s);
        var controllerData = { page: { view: { title: 'From Controller' } } };
        var merged = mergeB98(controllerData, JSON.parse(JSON.stringify(s.local.userData)));
        assert.equal(merged.page.view.title, 'From Controller');
    });

    it('SUBTRACT — the historical promotion loop never called set() (the #B98 defect repro)', function() {
        // The pre-#B98 loop, verbatim: the dispatch sits INSIDE the inner
        // for..in AFTER a `continue` that fires for every own enumerable
        // property, so it is unreachable for any plain value.
        var setCalls = 0;
        var countingSet = function() { setCalls++; };
        (function deadLoop(p, req, set) {
            var strParts = ['page'];
            for (let key in p) {
                if ( p.hasOwnProperty(key) && !/^(control)$/.test(key) ) {
                    strParts.push(key);
                    let obj = p[key];
                    let valueParts = [];
                    for (let prop in obj) {
                        if (obj.hasOwnProperty(prop)) {
                            valueParts.push(obj[prop]);
                            continue;
                        }
                        let value = valueParts.join('');
                        if ( /^:/.test(value) ) {
                            strParts = ['page', 'view', 'params', key];
                            set(strParts.join('.'), req.params[value.substring(1)]);
                        } else if (/^(file|title)$/.test(key)) {
                            strParts = ['page', 'view', key];
                            set(strParts.join('.'), value);
                        } else {
                            set(strParts.join('.'), value)
                        }
                        strParts = ['page']
                    }
                }
            }
        })({ control: 'home', title: 'My Title', section: 'situation', id: ':id' }, { params: { id: '123' } }, countingSet);
        assert.equal(setCalls, 0, 'the historical loop was dead code — zero set() calls expected');
    });

});


// 02 — #B98 behavioral smoke: the title promotion executes inside the REAL
// setOptions() via createTestInstance. Positive evidence comes from a getter
// instrument on the rule's `param.title` (read-count > 0 ⟺ the promotion block
// ran — nothing else on the bare-instance path reads that property; the
// instrument can fail, so it is a real control). `local.userData` has no
// public read accessor, so value-level behaviour is locked by §01 (real
// lib/merge replica) + §03 (source pins), and end-to-end by the daemonless
// boot proof recorded in the #B98 close-out.
// Runtime test — needs the framework-globals bootstrap (see §36's note).
describe('02 - #B98 behavioral smoke: setOptions runs the title promotion (createTestInstance)', function() {

    var FW = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));              // injects _/getPath/requireJSON/setPath globals
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SOURCE);

    function makeInstance(param) {
        var routingEntry = ( typeof(param) != 'undefined' ) ? { param: param } : {};
        return SuperController.createTestInstance({
            // req.routing.param stays a SEPARATE plain object so the getter
            // instrument on the conf-side param is read by setOptions alone.
            req     : { url: '/', method: 'GET', routing: { rule: 'home@b', param: {} }, params: {}, get: {}, headers: {} },
            res     : { setHeader: function () {}, end: function () {} },
            options : { conf: { bundle: 'b', content: { routing: { home: routingEntry } } }, rule: 'home', control: 'home' }
        });
    }

    it('param.title is READ by the real setOptions (the promotion block executes)', function() {
        var titleReads = 0;
        var param = { control: 'home' };
        Object.defineProperty(param, 'title', {
            enumerable: true,
            get: function() { titleReads++; return 'My Title'; }
        });
        assert.equal(titleReads, 0, 'instrument baseline must start at zero');
        makeInstance(param);
        assert.ok(titleReads > 0, 'setOptions never read param.title — the #B98 promotion block did not execute');
    });

    it('title-less param → setOptions completes (fallback-only path, no crash)', function() {
        var inst = makeInstance({ control: 'home' });
        assert.ok(inst._isTestInstance);
    });

    it('non-string param.title → the guard skips it, setOptions completes', function() {
        var inst = makeInstance({ control: 'home', title: 123 });
        assert.ok(inst._isTestInstance);
    });

    it('rule without param → the promotion gate skips, setOptions completes', function() {
        var inst = makeInstance(undefined);
        assert.ok(inst._isTestInstance);
    });

});


// 03 — #B98 source structure: the dead promotion loop is gone; the guarded
// param.title promotion and its ordering ahead of the route-name FALLBACK
// write are pinned (set() merges target-wins, so the earlier write survives).
describe('03 - #B98 source structure: title promotion + route-name fallback ordering', function() {

    it('the guarded param.title promotion is present', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("set('page.view.title', p.title)") > -1,
            "expected `set('page.view.title', p.title)` — the #B98 promotion is missing"
        );
    });

    it('the promotion is gated on a non-empty string title', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("typeof(p.title) == 'string' && p.title !== ''") > -1,
            'expected the non-empty-string guard on the title promotion'
        );
    });

    it('source carries the #B98 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#B98') > -1, 'expected #B98 marker in source');
    });

    it('ORDERING — the promotion precedes the route-name fallback write', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var promoIdx    = src.indexOf("set('page.view.title', p.title)");
        var fallbackIdx = src.indexOf("set('page.view.title', rule.split(");
        assert.ok(promoIdx > -1, 'promotion write not found');
        assert.ok(fallbackIdx > -1, 'route-name fallback write not found');
        assert.ok(promoIdx < fallbackIdx, 'the param.title promotion must run BEFORE the route-name fallback (target-wins merge makes the earlier write survive)');
    });

    it('the route-name fallback write is still present (title-less rules keep the route-name title)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("set('page.view.title', rule.split('@' + options.conf.bundle).join(''))") > -1,
            'expected the route-name fallback write'
        );
    });

    it('NEGATIVE — the dead loop tokens are gone file-wide (strParts / valueParts)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('strParts') < 0, 'strParts must be gone — the dead promotion loop was removed by #B98');
        assert.ok(src.indexOf('valueParts') < 0, 'valueParts must be gone — the dead promotion loop was removed by #B98');
    });

    it('NEGATIVE — the dead inner dispatch shape is gone (for (let prop in obj))', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('for (let prop in obj)') < 0, 'the dead inner for..in dispatch must not return');
    });

});


// 04 — source structure: setEarlyHints (#EH1)
describe('04 - source structure: setEarlyHints (#EH1)', function() {

    it('setEarlyHints is defined in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('this.setEarlyHints = function(') > -1,
            'expected `this.setEarlyHints = function(` — #EH1 not applied'
        );
    });

    it('source contains #EH1 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#EH1') > -1, 'expected #EH1 marker in source');
    });

    it('HTTP/2 path uses stream.additionalHeaders with :status 103', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("':status': 103") > -1,
            "expected `':status': 103` — HTTP/2 early-hints header missing"
        );
        assert.ok(
            src.indexOf('additionalHeaders') > -1,
            'expected `additionalHeaders` call for HTTP/2 early hints'
        );
    });

    it('HTTP/1.1 path uses writeEarlyHints', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('writeEarlyHints') > -1,
            'expected `writeEarlyHints` — HTTP/1.1 early-hints path missing'
        );
    });

    it('implementation is guarded by headersSent check', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // find setEarlyHints block
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('headersSent') > -1,
            'expected headersSent guard inside setEarlyHints'
        );
    });

    it('implementation wraps in try/catch so errors are swallowed', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('try {') > -1, 'expected try/catch in setEarlyHints');
        assert.ok(block.indexOf('catch') > -1,  'expected catch in setEarlyHints');
    });

    it('implementation returns self for chaining', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('return self') > -1, 'expected `return self` for chaining');
    });

    it('render() auto-sends 103 from h2Links before delegating to render-swig', function() {
        var src         = fs.readFileSync(SOURCE, 'utf8');
        var renderStart = src.indexOf('this.render = function (userData');
        var renderEnd   = src.indexOf('\n    }', renderStart) + 6; // closing brace of render
        var block       = src.slice(renderStart, renderEnd);
        assert.ok(
            block.indexOf('_h2Links') > -1,
            'expected h2Links auto-hint block inside render()'
        );
        assert.ok(
            block.indexOf('setEarlyHints(_hints)') > -1,
            'expected self.setEarlyHints(_hints) call inside render()'
        );
    });

    it('render() auto-hint trims trailing comma from h2Links', function() {
        var src         = fs.readFileSync(SOURCE, 'utf8');
        var renderStart = src.indexOf('this.render = function (userData');
        var renderEnd   = src.indexOf('\n    }', renderStart) + 6;
        var block       = src.slice(renderStart, renderEnd);
        assert.ok(
            block.indexOf('.slice(0, -1)') > -1,
            'expected trailing comma trim (.slice(0, -1)) in render() auto-hint'
        );
    });

});


// 05 — setEarlyHints: pure logic
describe('05 - setEarlyHints: pure logic', function() {

    // Minimal replica of the setEarlyHints body for isolated testing
    function makeEarlyHintsEnv(opts) {
        opts = opts || {};
        var calls = { additionalHeaders: [], writeEarlyHints: [] };

        var stream = opts.streamHeadersSent
            ? { headersSent: true }
            : (opts.noStream ? null : {
                headersSent: false,
                additionalHeaders: function(h) { calls.additionalHeaders.push(h); }
            });

        var res = {
            stream: stream || undefined,
            headersSent: opts.resHeadersSent || false,
            writeEarlyHints: opts.noWriteEarlyHints ? undefined : function(h) { calls.writeEarlyHints.push(h); }
        };

        var self = {};

        function headersSent(_res) {
            _res = _res || res;
            if (typeof _res.stream !== 'undefined' && _res.stream && _res.stream.headersSent === true) return true;
            if (typeof _res.headersSent !== 'undefined') return _res.headersSent;
            return false;
        }

        function setEarlyHints(links) {
            if (!links) return self;
            var _link;
            if (Array.isArray(links)) { _link = links.filter(Boolean).join(', '); }
            else { _link = String(links).trim(); }
            if (!_link) return self;
            if (headersSent(res)) return self;
            try {
                if (res.stream && !res.stream.headersSent) {
                    res.stream.additionalHeaders({ ':status': 103, 'link': _link });
                } else if (typeof res.writeEarlyHints === 'function') {
                    res.writeEarlyHints({ 'link': _link });
                }
            } catch(e) {}
            return self;
        }

        return { calls: calls, res: res, self: self, setEarlyHints: setEarlyHints };
    }

    it('HTTP/2: calls stream.additionalHeaders with :status 103 and link', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.additionalHeaders.length, 1);
        assert.equal(env.calls.additionalHeaders[0][':status'], 103);
        assert.equal(env.calls.additionalHeaders[0]['link'], '</app.css>; rel=preload; as=style');
    });

    it('HTTP/2: does not call writeEarlyHints when stream is present', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('HTTP/1.1: calls writeEarlyHints when no stream', function() {
        var env = makeEarlyHintsEnv({ noStream: true });
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 1);
        assert.equal(env.calls.writeEarlyHints[0]['link'], '</app.css>; rel=preload; as=style');
    });

    it('HTTP/1.1: no-ops silently when writeEarlyHints is not a function', function() {
        var env = makeEarlyHintsEnv({ noStream: true, noWriteEarlyHints: true });
        assert.doesNotThrow(function() {
            env.setEarlyHints('</app.css>; rel=preload; as=style');
        });
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('array of links is joined with ", "', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints(['</app.css>; rel=preload; as=style', '</app.js>; rel=preload; as=script']);
        assert.equal(
            env.calls.additionalHeaders[0]['link'],
            '</app.css>; rel=preload; as=style, </app.js>; rel=preload; as=script'
        );
    });

    it('null input: no-ops and returns self', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints(null);
        assert.strictEqual(result, env.self);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('undefined input: no-ops and returns self', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints(undefined);
        assert.strictEqual(result, env.self);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('empty string: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('');
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('empty array: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints([]);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('array with only falsy entries: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints([null, '', undefined]);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('returns self for optional chaining', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints('</x>; rel=preload; as=style');
        assert.strictEqual(result, env.self);
    });

    it('no-ops when HTTP/2 stream.headersSent is true', function() {
        var env = makeEarlyHintsEnv({ streamHeadersSent: true });
        env.setEarlyHints('</x>; rel=preload; as=style');
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('no-ops when HTTP/1.1 res.headersSent is true', function() {
        var env = makeEarlyHintsEnv({ noStream: true, resHeadersSent: true });
        env.setEarlyHints('</x>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('swallows errors thrown by additionalHeaders (best-effort)', function() {
        var env = makeEarlyHintsEnv();
        env.res.stream.additionalHeaders = function() { throw new Error('stream closed'); };
        assert.doesNotThrow(function() {
            env.setEarlyHints('</x>; rel=preload; as=style');
        });
    });

    it('swallows errors thrown by writeEarlyHints (best-effort)', function() {
        var env = makeEarlyHintsEnv({ noStream: true });
        env.res.writeEarlyHints = function() { throw new Error('socket error'); };
        assert.doesNotThrow(function() {
            env.setEarlyHints('</x>; rel=preload; as=style');
        });
    });

});


// 06 — render() auto-hint from h2Links
describe('06 - render() auto-hint from h2Links (#EH1)', function() {

    // Minimal replica of the render() auto-hint block for isolated testing
    function simulateRenderAutoHint(h2Links, hintsSent) {
        var sent = [];

        function setEarlyHints(hints) { sent.push(hints); return {}; }
        function headersSent() { return false; }

        // replica of the auto-hint block
        var _h2Links = h2Links;
        if (_h2Links) {
            var _hints = /,$/.test(_h2Links) ? _h2Links.slice(0, -1) : _h2Links;
            if (_hints) setEarlyHints(_hints);
        }

        return sent;
    }

    it('sends 103 with h2Links when populated', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload,</js/app.js>; as=script; rel=preload,');
        assert.equal(sent.length, 1);
    });

    it('trims trailing comma from h2Links before sending', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload,');
        assert.equal(sent[0], '</css/app.css>; as=style; rel=preload');
    });

    it('passes through value without trailing comma unchanged', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload');
        assert.equal(sent[0], '</css/app.css>; as=style; rel=preload');
    });

    it('multiple links are passed through as a single string', function() {
        var sent = simulateRenderAutoHint('</a.css>; as=style; rel=preload,</b.js>; as=script; rel=preload,');
        assert.equal(sent[0], '</a.css>; as=style; rel=preload,</b.js>; as=script; rel=preload');
    });

    it('no-ops when h2Links is empty string', function() {
        var sent = simulateRenderAutoHint('');
        assert.equal(sent.length, 0);
    });

    it('no-ops when h2Links is null', function() {
        var sent = simulateRenderAutoHint(null);
        assert.equal(sent.length, 0);
    });

    it('no-ops when h2Links is undefined', function() {
        var sent = simulateRenderAutoHint(undefined);
        assert.equal(sent.length, 0);
    });

    it('trailing-comma-only string results in empty hint — no send', function() {
        // edge case: h2Links was set to just ',' (degenerate case)
        var sent = simulateRenderAutoHint(',');
        // after slice(0, -1) → '' → falsy → no send
        assert.equal(sent.length, 0);
    });

});


// ─── 07 — throwError: explicit 3-digit status code is preserved ───────────────

describe('07 - throwError: explicit 3-digit HTTP status code is preserved', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('source contains the /^\\d{3}$/ guard that preserves an explicit code', function() {
        // The fix: /^\d{3}$/.test(String(code)) before falling back to res.status || 500
        assert.ok(/\\d\{3\}/.test(src) && /String\(code\)/.test(src),
            'throwError must test String(code) against /^\\d{3}$/ before falling back to res.status');
    });

    it('a 3-digit number string passes the guard', function() {
        assert.ok(/^\d{3}$/.test(String(404)));
        assert.ok(/^\d{3}$/.test(String(400)));
        assert.ok(/^\d{3}$/.test(String(500)));
        assert.ok(/^\d{3}$/.test(String(201)));
    });

    it('non-numeric or short code does NOT pass the guard (falls back)', function() {
        assert.ok(!/^\d{3}$/.test(String(undefined)));
        assert.ok(!/^\d{3}$/.test(String(null)));
        assert.ok(!/^\d{3}$/.test(String('foo')));
        assert.ok(!/^\d{3}$/.test(String(50)));   // 2-digit
        assert.ok(!/^\d{3}$/.test(String(5000)));  // 4-digit
    });

    it('inline replica: throwError(res, 404, msg) preserves 404', function() {
        // Inline replica of the fixed code branch
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 200 };
        assert.equal(resolveCode(fakeRes, 404), 404, 'explicit 404 must not be overridden by res.status');
    });

    it('inline replica: throwError(res, undefined, msg) falls back to res.status', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 422 };
        assert.equal(resolveCode(fakeRes, undefined), 422, 'missing code falls back to res.status');
    });

    it('inline replica: throwError(res, undefined, msg) falls back to 500 when res.status absent', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        assert.equal(resolveCode({}, undefined), 500, 'missing code and missing res.status must default to 500');
    });

    it('inline replica: throwError(res, 400, msg) preserves 400', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 500 };
        assert.equal(resolveCode(fakeRes, 400), 400, 'explicit 400 must not be overridden by res.status=500');
    });
});


// ─── 08 — getConfig: proxy hostname override guard ───────────────────────────

describe('08 - getConfig: proxy hostname override guard', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure ─────────────────────────────────────────────────

    it('source contains the (per-request) proxy-hostname undefined guard in getConfig', function() {
        // The guard prevents overwriting a valid hostname with undefined when proxy
        // detection is a false positive (browser Origin header triggers isProxyHost
        // = true but no proxy hostname was ever set). #B66 S2b re-points it from the
        // bare worker-global onto the per-request _proxyHostname (which itself falls
        // back to process.gina.PROXY_HOSTNAME for req-less/Express callers), so the
        // guard now reads typeof(_proxyHostname) != 'undefined'. The intent is unchanged.
        var start = src.indexOf('this.getConfig = function(name)');
        assert.ok(start > -1, 'getConfig definition not found in source');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("typeof(_proxyHostname) != 'undefined'") > -1,
            'expected the per-request _proxyHostname undefined guard inside getConfig'
        );
    });

    it('source contains the isProxyHost context check in getConfig', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("getContext('isProxyHost')") > -1,
            "expected getContext('isProxyHost') inside getConfig"
        );
    });

    it('source contains the tmp.hostname existence check in getConfig', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("typeof(tmp.hostname) != 'undefined'") > -1,
            'expected tmp.hostname existence guard inside getConfig'
        );
    });

    it('proxy override assigns both hostname and host', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('tmp.hostname') > -1 && block.indexOf('tmp.host') > -1,
            'expected both tmp.hostname and tmp.host assignments inside getConfig'
        );
        assert.ok(
            block.indexOf('process.gina.PROXY_HOSTNAME') > -1
            && block.indexOf('process.gina.PROXY_HOST') > -1,
            'expected assignment from process.gina.PROXY_HOSTNAME and PROXY_HOST'
        );
    });

    it('getConfig uses JSON.clone for read-only copies', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('JSON.clone(local.options.conf.content[name])') > -1,
            'expected JSON.clone for named config lookup'
        );
        assert.ok(
            block.indexOf('JSON.clone(local.options.conf)') > -1,
            'expected JSON.clone for full config clone'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────
    //
    // Minimal replica of getConfig that mirrors the actual guard logic. We
    // cannot require the full controller module (it needs a running gina
    // server), so we test the logic in isolation.

    function makeGetConfigEnv(opts) {
        opts = opts || {};

        // Simulate JSON.clone as a deep copy (same contract as the polyfill)
        function clone(obj) {
            if (obj == null || typeof obj != 'object') return obj;
            return JSON.parse(JSON.stringify(obj));
        }

        var local = {
            options: {
                conf: opts.conf || {
                    hostname: 'app.example.com',
                    host: 'app.example.com:3100',
                    content: {
                        routing: { home: { url: '/' } },
                        settings: { port: 3100, host: 'app.example.com' }
                    }
                }
            }
        };

        var contextStore = {
            isProxyHost: opts.isProxyHost || false
        };

        var savedGina = null;

        function setup() {
            savedGina = process.gina;
            process.gina = process.gina ? clone(process.gina) : {};
            if (typeof opts.proxyHostname != 'undefined') {
                process.gina.PROXY_HOSTNAME = opts.proxyHostname;
            }
            if (typeof opts.proxyHost != 'undefined') {
                process.gina.PROXY_HOST = opts.proxyHost;
            }
        }

        function teardown() {
            process.gina = savedGina;
        }

        function getContext(key) {
            return contextStore[key];
        }

        function getConfig(name) {
            var tmp = null;
            if ( typeof(name) != 'undefined' ) {
                try {
                    tmp = clone(local.options.conf.content[name]);
                } catch (err) {
                    return undefined;
                }
            } else {
                tmp = clone(local.options.conf);
            }

            if (
                getContext('isProxyHost')
                && typeof(tmp.hostname) != 'undefined'
                && typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
            ) {
                tmp.hostname    = process.gina.PROXY_HOSTNAME;
                tmp.host        = process.gina.PROXY_HOST;
            }
            return tmp;
        }

        return {
            local: local,
            getConfig: getConfig,
            setup: setup,
            teardown: teardown
        };
    }

    it('normal return with no proxy: hostname unchanged', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'app.example.com',
                'hostname must be preserved when isProxyHost is false');
            assert.equal(conf.host, 'app.example.com:3100',
                'host must be preserved when isProxyHost is false');
        } finally {
            env.teardown();
        }
    });

    it('proxy override when PROXY_HOSTNAME is defined and isProxyHost is true', function() {
        var env = makeGetConfigEnv({
            isProxyHost: true,
            proxyHostname: 'proxy.example.com',
            proxyHost: 'proxy.example.com:8080'
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'proxy.example.com',
                'hostname must be overridden to PROXY_HOSTNAME');
            assert.equal(conf.host, 'proxy.example.com:8080',
                'host must be overridden to PROXY_HOST');
        } finally {
            env.teardown();
        }
    });

    it('guard: no override when PROXY_HOSTNAME is undefined even if isProxyHost is true', function() {
        // This is the bug fix scenario: browser Origin header triggers
        // isProxyHost = true, but PROXY_HOSTNAME was never set. Without the
        // guard, hostname would be overwritten with undefined.
        var env = makeGetConfigEnv({
            isProxyHost: true
            // proxyHostname intentionally omitted — stays undefined on process.gina
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'app.example.com',
                'hostname must be preserved when PROXY_HOSTNAME is undefined (bug fix)');
            assert.equal(conf.host, 'app.example.com:3100',
                'host must be preserved when PROXY_HOSTNAME is undefined (bug fix)');
        } finally {
            env.teardown();
        }
    });

    it('no override when tmp has no hostname property (e.g. named sub-config)', function() {
        var env = makeGetConfigEnv({
            isProxyHost: true,
            proxyHostname: 'proxy.example.com',
            proxyHost: 'proxy.example.com:8080'
        });
        env.setup();
        try {
            // 'routing' sub-config has no hostname property
            var conf = env.getConfig('routing');
            assert.ok(typeof conf.hostname == 'undefined',
                'routing sub-config should not have a hostname injected');
            assert.deepEqual(conf, { home: { url: '/' } },
                'named config must return content[name] unchanged');
        } finally {
            env.teardown();
        }
    });

    it('named config lookup returns content[name]', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var settings = env.getConfig('settings');
            assert.deepEqual(settings, { port: 3100, host: 'app.example.com' },
                'getConfig("settings") must return conf.content.settings');
        } finally {
            env.teardown();
        }
    });

    it('named config lookup returns undefined for missing key', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var result = env.getConfig('nonexistent');
            assert.equal(result, undefined,
                'getConfig for a missing key must return undefined');
        } finally {
            env.teardown();
        }
    });

    it('no-arg call returns full conf clone', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.ok(typeof conf.hostname != 'undefined', 'full conf must include hostname');
            assert.ok(typeof conf.content != 'undefined', 'full conf must include content');
        } finally {
            env.teardown();
        }
    });

    it('clone isolation: mutating returned object does not affect original', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf1 = env.getConfig();
            conf1.hostname = 'mutated.example.com';
            conf1.content.routing.injected = true;

            var conf2 = env.getConfig();
            assert.equal(conf2.hostname, 'app.example.com',
                'second call must return original hostname, not mutated value');
            assert.equal(typeof conf2.content.routing.injected, 'undefined',
                'second call must not see mutation from first call');
        } finally {
            env.teardown();
        }
    });

    it('clone isolation: named config mutation does not affect original', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var routing1 = env.getConfig('routing');
            routing1.home.url = '/mutated';

            var routing2 = env.getConfig('routing');
            assert.equal(routing2.home.url, '/',
                'second call must return original routing, not mutated value');
        } finally {
            env.teardown();
        }
    });

    it('all three guard conditions must be true for override to apply', function() {
        // Test matrix: only the (true, true, true) combination applies the override
        var cases = [
            { isProxy: false, hasHostname: true,  hasPH: true,  expect: 'app.example.com', label: 'F,T,T' },
            { isProxy: true,  hasHostname: true,  hasPH: false, expect: 'app.example.com', label: 'T,T,F' },
            { isProxy: true,  hasHostname: false, hasPH: true,  expect: undefined,          label: 'T,F,T' },
            { isProxy: true,  hasHostname: true,  hasPH: true,  expect: 'proxy.example.com', label: 'T,T,T' }
        ];

        cases.forEach(function(c) {
            var confObj = c.hasHostname
                ? { hostname: 'app.example.com', host: 'app.example.com:3100', content: {} }
                : { content: {} };
            var envOpts = {
                isProxyHost: c.isProxy,
                conf: confObj
            };
            if (c.hasPH) {
                envOpts.proxyHostname = 'proxy.example.com';
                envOpts.proxyHost = 'proxy.example.com:8080';
            }
            var env = makeGetConfigEnv(envOpts);
            env.setup();
            try {
                var result = env.getConfig();
                assert.equal(result.hostname, c.expect,
                    'case [' + c.label + ']: hostname mismatch');
            } finally {
                env.teardown();
            }
        });
    });

});


// ─── 09 — public webroot composition under reverse proxy ─────────────────────
//
// When a reverse proxy mounts the bundle on a sub-path (e.g. nginx
// `location /admin/ { proxy_pass http://upstream; }` with
// `proxy_set_header X-Forwarded-Prefix /admin;`), the bundle's internal
// `server.webroot` stays `/` (it doesn't know about the mount path), but the
// value templated into `gina.onload.min.js` (which becomes the browser-side
// `gina.config.webroot`) MUST include the prefix so that root-relative URLs
// the browser builds (`gina.config.webroot + '_gina/assets/routing.json'`,
// the `gina.min.css` link injection, etc.) target the correct upstream.
// PROXY_PREFIX is captured by server.isaac.js from the X-Forwarded-Prefix
// header (already normalised: leading slash, no trailing slash, dropped if
// empty or "/"). controller.js composes it with the bundle's internal
// webroot at the page.environment.webroot setter site.

describe('09 - public webroot composition under reverse proxy', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure ─────────────────────────────────────────────────

    it("source references local.req._ginaProxyPrefix in the page.environment.webroot setter region", function() {
        var anchor = src.indexOf("set('page.environment.webroot'");
        assert.ok(anchor > -1, "page.environment.webroot setter not found");
        // Look in a window above + below the setter for the per-request read
        var windowStart = Math.max(0, anchor - 1500);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        assert.ok(
            block.indexOf('local.req._ginaProxyPrefix') > -1,
            'expected local.req._ginaProxyPrefix read near the page.environment.webroot setter (per-request, not process-global)'
        );
    });

    it("source does NOT read process.gina.PROXY_PREFIX (the leaky process-global is removed)", function() {
        // Negative invariant: the previous process-global read at the webroot
        // setter is the bug surface this slice fixed. If it ever comes back,
        // the cross-request leak returns — once a sub-path-mounted request
        // poisons the global, every subsequent render in that worker (even
        // direct, non-proxied requests) gets the leaked prefix concatenated.
        var anchor = src.indexOf("set('page.environment.webroot'");
        var windowStart = Math.max(0, anchor - 1500);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        assert.ok(
            block.indexOf('process.gina.PROXY_PREFIX') === -1,
            'process.gina.PROXY_PREFIX must NOT be read by the webroot composition — use local.req._ginaProxyPrefix instead (cross-request leak protection)'
        );
    });

    it("source guards local.req._ginaProxyPrefix with typeof != 'undefined' before composing", function() {
        var anchor = src.indexOf("set('page.environment.webroot'");
        var windowStart = Math.max(0, anchor - 1500);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        assert.ok(
            block.indexOf("typeof(local.req._ginaProxyPrefix) != 'undefined'") > -1,
            'expected typeof guard around local.req._ginaProxyPrefix (back-compat: header absent)'
        );
    });

    it("source guards local.req existence before reading _ginaProxyPrefix", function() {
        // Defensive: setOptions sets local.req synchronously, but this read
        // sits in the larger setOptions body. A defensive `local.req &&` guard
        // protects against future code-paths that might reach this region
        // without local.req populated (e.g. createTestInstance with bare opts).
        var anchor = src.indexOf("set('page.environment.webroot'");
        var windowStart = Math.max(0, anchor - 1500);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        assert.ok(
            /local\.req\s*&&\s*typeof\(local\.req\._ginaProxyPrefix\)/.test(block),
            'expected `local.req && typeof(local.req._ginaProxyPrefix)` defensive guard'
        );
    });

    it("source still composes from options.conf.server.webroot as the base", function() {
        var anchor = src.indexOf("set('page.environment.webroot'");
        var windowStart = Math.max(0, anchor - 1500);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        assert.ok(
            block.indexOf('options.conf.server.webroot') > -1,
            'expected options.conf.server.webroot as the base webroot in composition'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────
    //
    // Replica of the composition logic in controller.js. Cannot require the
    // full controller module (needs a running gina server), so test in
    // isolation. The replica MUST stay byte-for-byte equivalent to the live
    // implementation; the source-structure tests above pin the live shape.

    function composeWebroot(internalWebroot, proxyPrefix) {
        var publicWebroot = internalWebroot;
        if ( typeof(proxyPrefix) != 'undefined' && proxyPrefix ) {
            var prefix = proxyPrefix;
            var wr     = publicWebroot.replace(/^\/+/, '');
            publicWebroot = prefix + '/' + wr;
            if ( !/\/$/.test(publicWebroot) ) {
                publicWebroot += '/';
            }
        }
        return publicWebroot;
    }

    it('back-compat: undefined PROXY_PREFIX leaves "/" unchanged', function() {
        assert.equal(composeWebroot('/', undefined), '/');
    });

    it('back-compat: undefined PROXY_PREFIX leaves "/admin/" unchanged', function() {
        assert.equal(composeWebroot('/admin/', undefined), '/admin/');
    });

    it('back-compat: empty PROXY_PREFIX is treated as absent', function() {
        // The truthy check (proxyPrefix && ...) drops empty strings even though
        // the typeof check passes. This mirrors server.isaac.js's drop of "" / "/".
        assert.equal(composeWebroot('/', ''), '/');
        assert.equal(composeWebroot('/admin/', ''), '/admin/');
    });

    it('prefix "/sub" + bundle "/" → "/sub/"', function() {
        assert.equal(composeWebroot('/', '/sub'), '/sub/');
    });

    it('prefix "/sub" + bundle "/admin/" → "/sub/admin/"', function() {
        assert.equal(composeWebroot('/admin/', '/sub'), '/sub/admin/');
    });

    it('prefix "/sub" + bundle "/admin" (missing trailing slash) → "/sub/admin/"', function() {
        // Trailing slash is appended so downstream `webroot + 'asset/path'`
        // concatenation never produces double slashes or a missing separator.
        assert.equal(composeWebroot('/admin', '/sub'), '/sub/admin/');
    });

    it('prefix "/sub" + bundle "//double-slash/" strips the leading slashes from the bundle', function() {
        // Defensive: the bundle's internal webroot should start with "/", but if
        // it accidentally has multiple leading slashes the composition still
        // produces a clean prefix + '/' + tail shape.
        assert.equal(composeWebroot('//double-slash/', '/sub'), '/sub/double-slash/');
    });

    it('multi-segment prefix "/admin/v2" + bundle "/" → "/admin/v2/"', function() {
        assert.equal(composeWebroot('/', '/admin/v2'), '/admin/v2/');
    });

    it('multi-segment prefix "/admin/v2" + bundle "/dashboard/" → "/admin/v2/dashboard/"', function() {
        assert.equal(composeWebroot('/dashboard/', '/admin/v2'), '/admin/v2/dashboard/');
    });

    it('result always ends with "/" so URL composition (webroot + leaf) is stable', function() {
        var combos = [
            ['/',         undefined],
            ['/admin/',   undefined],
            ['/',         '/sub'],
            ['/admin/',   '/sub'],
            ['/admin',    '/sub'],
            ['/',         '/admin/v2']
        ];
        combos.forEach(function(c) {
            var out = composeWebroot(c[0], c[1]);
            assert.ok(/\/$/.test(out),
                'composeWebroot(' + JSON.stringify(c[0]) + ', ' + JSON.stringify(c[1]) + ') = ' +
                JSON.stringify(out) + ' must end with "/"');
        });
    });

    it('repro of the cross-bundle leak shape: bundle "/" + prefix "/admin" yields "/admin/" (was "/")', function() {
        // The shipped bug: the bundle's internal server.webroot is "/", and
        // before this fix, that "/" was templated straight into
        // gina.config.webroot — the browser then built
        // "/" + "_gina/assets/routing.json" = "/_gina/assets/routing.json"
        // which the reverse proxy routed to whichever upstream answered the
        // root path (NOT this bundle). The composed value "/admin/" makes
        // the browser build "/admin/_gina/assets/routing.json" instead, which
        // the proxy routes back to this bundle's upstream.
        var before = '/';
        var after  = composeWebroot(before, '/admin');
        assert.notEqual(after, before, 'composition must change "/" when a prefix is set');
        assert.equal(after, '/admin/', 'composed webroot must include the proxy prefix');
    });

    // ── (c) per-request isolation — the cross-request leak shape ─────────────
    //
    // Before this slice, PROXY_PREFIX was a process-global (`process.gina.PROXY_PREFIX`)
    // set by server.isaac.js inside a `!isProxyHost && headers['x-forwarded-host']`
    // gated block. The block stops firing after the first proxied request
    // flips `isProxyHost` to globally true (`setContext('isProxyHost', true)`),
    // so subsequent requests never re-derive PROXY_PREFIX and the value stays
    // at the FIRST proxied request's prefix forever (until worker restart).
    //
    // This bites when the worker handles a mix of proxied + direct calls
    // (e.g. internal services hitting the bundle without going through the
    // proxy) — direct calls inherit the leaked prefix and render with the
    // wrong webroot. Less common but real: a bundle behind a proxy that
    // mounts it at multiple paths.
    //
    // The fix moves the value to per-request `req._ginaProxyPrefix` so each
    // request gets its own isolated state. The replica below simulates the
    // before/after by reading the prefix from a per-request object instead
    // of a shared global.

    function resolvePrefix(req) {
        return (req && typeof(req._ginaProxyPrefix) != 'undefined' && req._ginaProxyPrefix)
            ? req._ginaProxyPrefix
            : undefined;
    }

    it('per-request: req A has prefix → req A composition includes it', function() {
        var reqA = { _ginaProxyPrefix: '/admin' };
        var prefix = resolvePrefix(reqA);
        assert.equal(composeWebroot('/', prefix), '/admin/');
    });

    it('per-request isolation: req B (no header, after req A) does NOT inherit req A prefix', function() {
        // The pre-fix bug: req B would see the leaked PROXY_PREFIX from req A
        // because both shared process.gina.PROXY_PREFIX. With the per-request
        // shape, req B has its own _ginaProxyPrefix slot (undefined when no
        // X-Forwarded-Prefix header was present) → composition correctly
        // falls back to the bundle's internal webroot.
        var reqA = { _ginaProxyPrefix: '/admin' };
        var reqB = {}; // no x-forwarded-prefix header → slot never written
        // Simulate req A's render first (would write process.gina.PROXY_PREFIX in the old shape):
        var prefixA = resolvePrefix(reqA);
        assert.equal(composeWebroot('/', prefixA), '/admin/');
        // Then req B's render — must NOT see the prefix:
        var prefixB = resolvePrefix(reqB);
        assert.equal(prefixB, undefined, 'req B must not inherit req A\'s prefix');
        assert.equal(composeWebroot('/', prefixB), '/', 'req B webroot must be the bundle internal, not the leaked prefix');
    });

    it('per-request isolation: req C with a DIFFERENT prefix (after req A) gets its own value', function() {
        // Multi-mount proxy scenario: same bundle mounted on /admin and /staff.
        // Pre-fix: process.gina.PROXY_PREFIX would stay at whichever request
        // landed first. Per-request: each request gets its own value.
        var reqA = { _ginaProxyPrefix: '/admin' };
        var reqC = { _ginaProxyPrefix: '/staff' };
        assert.equal(composeWebroot('/', resolvePrefix(reqA)), '/admin/');
        assert.equal(composeWebroot('/', resolvePrefix(reqC)), '/staff/');
    });

    it('per-request: req with empty _ginaProxyPrefix slot is treated as absent (defensive)', function() {
        // The writer at server.isaac.js drops empty / "/" header values via
        // `_xfp.length > 0 && ...` so the slot never gets written when the
        // header is no-op. But if some downstream wrote `req._ginaProxyPrefix
        // = ''` defensively, the truthy check still falls back correctly.
        var reqEmpty = { _ginaProxyPrefix: '' };
        assert.equal(resolvePrefix(reqEmpty), undefined);
        assert.equal(composeWebroot('/', resolvePrefix(reqEmpty)), '/');
    });

    it('per-request: missing req object falls through (defensive — createTestInstance with no req)', function() {
        // controller.createTestInstance({}) sets local.req = {} (empty object).
        // The defensive `local.req && ...` guard in the production reader
        // protects against any code-path that might reach the composition
        // without local.req populated.
        assert.equal(resolvePrefix(undefined), undefined);
        assert.equal(resolvePrefix(null), undefined);
        assert.equal(composeWebroot('/', resolvePrefix(undefined)), '/');
    });

});


// ─── 10 — webroot handoff: server-composed → loader.js → core.js ─────────────
//
// Section 09 verified the SERVER-side webroot composition (PROXY_PREFIX +
// internal webroot). This section locks the BROWSER-side handoff: the public
// webroot must reach core.js's getDependencies BEFORE it composes the
// routing.json fetch URL.
//
// The race: gina.min.js's script-tag onload handler fires getDependencies()
// BEFORE window.onGinaLoaded(gina) has populated gina.config. At fetch time
// gina.config.webroot is undefined, so the URL would fall back to '/' and
// routing.json would be fetched root-relative — landing on the wrong upstream
// when the bundle is mounted on a sub-path under a reverse proxy.
//
// The fix:
//  - loader.js exposes window.__ginaWebroot SYNCHRONOUSLY (templated by
//    whisper from page.environment.webroot, served as gina.onload.min.js).
//  - core.js reads window.__ginaWebroot FIRST, falling back to
//    gina.config.webroot (post-onGinaLoaded re-entry) then '/'.
// gina.onload.min.js is injected into <head> BEFORE gina.min.js by every
// full-page render path in render-swig.js (see :1185-1194 dev,
// :1262-1271 prod), so the synchronous global is reliably available
// before getDependencies runs.

describe('10 - webroot handoff: loader sets __ginaWebroot, core reads it before fetch', function() {

    var FW         = require('../fw');
    var LOADER_SRC = path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/loader.js');
    var CORE_SRC   = path.join(FW, 'core/asset/plugin/src/vendor/gina/core.js');
    var loaderSrc  = fs.readFileSync(LOADER_SRC, 'utf8');
    var coreSrc    = fs.readFileSync(CORE_SRC,   'utf8');

    // ── (a) loader.js source structure ──────────────────────────────────────

    it("loader.js sets window['__ginaWebroot'] synchronously at module top level", function() {
        assert.ok(
            /window\['__ginaWebroot'\]\s*=\s*'\{\{ page\.environment\.webroot \}\}'/.test(loaderSrc),
            "loader.js must contain `window['__ginaWebroot'] = '{{ page.environment.webroot }}';` so the global is whisper-substituted at serve time"
        );
    });

    it("loader.js sets __ginaWebroot BEFORE the onGinaLoaded function definition", function() {
        var globalIdx = loaderSrc.indexOf("window['__ginaWebroot']");
        var fnIdx     = loaderSrc.indexOf("window['onGinaLoaded']");
        assert.ok(globalIdx > -1, '__ginaWebroot setter not found in loader.js');
        assert.ok(fnIdx     > -1, 'onGinaLoaded function not found in loader.js');
        assert.ok(
            globalIdx < fnIdx,
            '__ginaWebroot setter must come BEFORE onGinaLoaded so the global is set at parse time, not when onGinaLoaded is invoked'
        );
    });

    it("loader.js exposes __ginaWebroot via @js_externs so Closure does not rename it", function() {
        // Without @js_externs, ADVANCED_OPTIMIZATIONS would rename the property
        // and core.js (which is compiled separately) would read undefined.
        assert.ok(
            /@js_externs __ginaWebroot/.test(loaderSrc),
            'loader.js must annotate __ginaWebroot with @js_externs to survive Closure ADVANCED_OPTIMIZATIONS'
        );
    });

    // ── (b) core.js source structure ────────────────────────────────────────

    it("core.js reads window.__ginaWebroot FIRST in the _webroot fallback chain", function() {
        var anchor = coreSrc.indexOf('var _webroot');
        assert.ok(anchor > -1, '_webroot declaration not found in core.js');
        // Look in a window after the declaration for the fallback chain.
        var block = coreSrc.slice(anchor, anchor + 400);
        var winIdx     = block.indexOf('window.__ginaWebroot');
        var configIdx  = block.indexOf('gina.config.webroot');
        var fallbackIdx = block.indexOf("'/'");
        assert.ok(winIdx > -1,                        'expected window.__ginaWebroot read in _webroot fallback chain');
        assert.ok(configIdx > -1,                     'expected gina.config.webroot read in _webroot fallback chain (back-compat)');
        assert.ok(fallbackIdx > -1,                   "expected '/' default in _webroot fallback chain");
        assert.ok(winIdx < configIdx,                 'window.__ginaWebroot must come BEFORE gina.config.webroot in the fallback chain');
        assert.ok(configIdx < fallbackIdx,            "gina.config.webroot must come BEFORE the '/' default");
    });

    it("core.js guards window.__ginaWebroot with `typeof window !== 'undefined'`", function() {
        // Defensive for any node-side path that imports core.js (e.g. tests,
        // SSR experiments). Without the guard the read would throw ReferenceError.
        var anchor = coreSrc.indexOf('var _webroot');
        var block  = coreSrc.slice(anchor, anchor + 400);
        assert.ok(
            block.indexOf("typeof window !== 'undefined'") > -1,
            "expected typeof window guard around window.__ginaWebroot read in core.js"
        );
    });

    it("core.js still composes the routing.json URL via _webroot + '_gina/assets/routing.json'", function() {
        assert.ok(
            /_webroot\s*\+\s*'_gina\/assets\/routing\.json'/.test(coreSrc),
            "expected `_webroot + '_gina/assets/routing.json'` URL composition (the fetch site this fix protects)"
        );
    });

    // ── (c) pure logic — _webroot resolution chain replica ───────────────────
    //
    // Replica of the resolution logic in core.js. JSDOM-free; the source pins
    // above lock the live shape, this exercises the priority ordering.

    function resolveWebroot(globalWindow, gina) {
        return (typeof globalWindow !== 'undefined' && globalWindow && globalWindow.__ginaWebroot)
            || (gina && gina.config && gina.config.webroot)
            || '/';
    }

    it('priority 1: window.__ginaWebroot wins when set (the fix path)', function() {
        var win  = { __ginaWebroot: '/sub/' };
        var gina = { config: { webroot: '/should-not-be-used/' } };
        assert.equal(resolveWebroot(win, gina), '/sub/');
    });

    it('priority 2: falls through to gina.config.webroot when __ginaWebroot is absent (re-entry, post-onGinaLoaded)', function() {
        var win  = {}; // __ginaWebroot not set yet
        var gina = { config: { webroot: '/admin/' } };
        assert.equal(resolveWebroot(win, gina), '/admin/');
    });

    it("priority 3: falls through to '/' when both __ginaWebroot and gina.config.webroot are absent (the original race)", function() {
        var win  = {};
        var gina = { config: {} };
        assert.equal(resolveWebroot(win, gina), '/');
    });

    it("repro of the original race: pre-fix, _webroot was '/' under sub-path mount, producing '/_gina/assets/routing.json'", function() {
        // Before the fix, getDependencies only read gina.config.webroot. At the
        // moment the script-tag onload fires, onGinaLoaded has NOT YET run, so
        // gina.config is undefined. _webroot collapsed to '/', and the URL
        // collapsed to '/_gina/assets/routing.json' — the wrong upstream under
        // a reverse proxy with sub-path mount.
        var win  = {}; // __ginaWebroot would be set if we used the new loader
        var gina = {}; // pre-onGinaLoaded state
        var oldWebroot = (gina && gina.config && gina.config.webroot) || '/';
        assert.equal(oldWebroot + '_gina/assets/routing.json', '/_gina/assets/routing.json');
    });

    it("with the fix: pre-onGinaLoaded state, __ginaWebroot delivers the sub-path correctly", function() {
        // After the fix, loader.js sets window.__ginaWebroot SYNCHRONOUSLY at
        // script parse time (before gina.min.js even runs). So the same
        // pre-onGinaLoaded state now resolves to the actual public webroot.
        var win  = { __ginaWebroot: '/sub/' };
        var gina = {}; // still pre-onGinaLoaded
        var newWebroot = resolveWebroot(win, gina);
        assert.equal(newWebroot + '_gina/assets/routing.json', '/sub/_gina/assets/routing.json');
    });

    it('back-compat: empty string __ginaWebroot is treated as absent (truthy check), falls through', function() {
        // The truthy check (windowGlobal.__ginaWebroot && ...) drops empty
        // strings. Mirrors the existing back-compat shape on gina.config.webroot.
        var win  = { __ginaWebroot: '' };
        var gina = { config: { webroot: '/admin/' } };
        assert.equal(resolveWebroot(win, gina), '/admin/');
    });

    it('back-compat: typeof guard protects node-side imports of core.js', function() {
        // Pretend window is undefined (server-side require, test harness, etc.).
        // The typeof guard short-circuits; we fall through to gina.config.
        var gina = { config: { webroot: '/srv/' } };
        // We can't actually delete `window` from the global (Node has no
        // window), so simulate by passing undefined directly. The pure-logic
        // replica's typeof check on its parameter mirrors the production
        // typeof on the bare `window` identifier.
        assert.equal(resolveWebroot(undefined, gina), '/srv/');
    });

    // ── (d) dist-source equivalence — the build did not strip our changes ────

    it('dist gina.onload.min.js contains the __ginaWebroot template (post-build)', function() {
        var distOnload = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.onload.min.js');
        var content    = fs.readFileSync(distOnload, 'utf8');
        assert.ok(
            content.indexOf("__ginaWebroot='{{ page.environment.webroot }}'") > -1
            || content.indexOf('__ginaWebroot="{{ page.environment.webroot }}"') > -1,
            'dist gina.onload.min.js must contain __ginaWebroot=\'{{ page.environment.webroot }}\' for whisper to substitute it at serve time'
        );
    });

    it('dist gina.min.js contains the new __ginaWebroot read (post-build)', function() {
        var distCore = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
        var content  = fs.readFileSync(distCore, 'utf8');
        assert.ok(
            content.indexOf('__ginaWebroot') > -1,
            'dist gina.min.js must reference __ginaWebroot — Closure may have stripped the read if @js_externs is missing or if the source was rebuilt without our changes'
        );
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 11 — page.section auto-promotion from route.param.section
//
// A common route shape declares a `section` param to drive sub-section
// dispatch:
//
//     "<route-name>": {
//         "url":    "/foo/bar",
//         "method": "GET",
//         "param":  { "file": "index", "section": "alpha", "control": "get" }
//     }
//
// Templates compose include paths from page.section:
//
//     {% set t = './includes/' + page.section + '.html' %}
//     {% include t %}
//
// This parallels the existing param.file → page.view.file auto-promotion
// (sibling line). Without it, compose-from-section templates resolve to
// '…' + undefined + '…' which Swig coerces to an empty stem; the loader
// then throws ENOENT at compile-file time. Bundle-level template caching
// can mask the issue intermittently — a cached compiled output keeps
// working until the next bundle:build busts the cache.

describe('11 - page.section auto-promotion from route.param.section', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure ─────────────────────────────────────────────────

    it("source contains set('page.section', local.req.routing.param.section)", function() {
        assert.ok(
            src.indexOf("set('page.section', local.req.routing.param.section)") > -1,
            "expected `set('page.section', local.req.routing.param.section)` — the auto-promotion is missing"
        );
    });

    it("the page.section setter sits inside the page.view auto-promotion block", function() {
        var viewAnchor    = src.indexOf("set('page.view.namespace'");
        var sectionAnchor = src.indexOf("set('page.section'");
        assert.ok(viewAnchor > -1, "page.view.namespace setter not found");
        assert.ok(sectionAnchor > -1, "page.section setter not found");
        // Section setter must appear immediately after the view auto-promotion
        // block (within ~600 chars — comment + guard + setter).
        assert.ok(
            sectionAnchor > viewAnchor && sectionAnchor - viewAnchor < 600,
            'page.section setter must sit alongside the existing page.view.* auto-promotions'
        );
    });

    it("source guards local.req → local.req.routing → routing.param → param.section before the setter", function() {
        var anchor = src.indexOf("set('page.section'");
        var windowStart = Math.max(0, anchor - 400);
        var block = src.slice(windowStart, anchor);
        assert.ok(
            /local\.req\s*&&\s*local\.req\.routing\s*&&\s*local\.req\.routing\.param\s*&&\s*local\.req\.routing\.param\.section/.test(block),
            'expected `local.req && local.req.routing && local.req.routing.param && local.req.routing.param.section` defensive chain'
        );
    });

    it("comment uses framework-generic language (no consumer-app references)", function() {
        // The auto-promotion block must describe the pattern abstractly, never
        // a specific consuming app or its templates. This protects the no-
        // consumer-references rule from regressing through future edits.
        var anchor = src.indexOf("set('page.section'");
        var windowStart = Math.max(0, anchor - 600);
        var windowEnd   = Math.min(src.length, anchor + 200);
        var block = src.slice(windowStart, windowEnd);
        // The forbidden consumer token is reconstructed (not embedded as a literal)
        // so this guard file does not itself carry the token it forbids, per the
        // no-consumer-references rule; the regex still detects it in `block`.
        var _consumerToken = ['free', 'lancer'].join('');
        assert.ok(
            !(new RegExp(_consumerToken + '|FRAMEWORK PATCH \\(')).test(block),
            'page.section auto-promotion comment must not name a consumer app or use a "FRAMEWORK PATCH (consumer)" prefix'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────
    //
    // The guard + setter semantics, replicated standalone. Cannot require the
    // full controller module (needs a running gina server), so test the shape
    // in isolation. The source-structure tests above pin the live shape.

    function autoPromoteSection(local) {
        var page = {};
        var set = function(key, value) {
            // mimic the production set('page.section', value) — flat key write.
            page[key] = value;
        };
        if ( local && local.req && local.req.routing && local.req.routing.param && local.req.routing.param.section ) {
            set('page.section', local.req.routing.param.section);
        }
        return page;
    }

    it('positive: routing.param.section populated → page.section gets the value', function() {
        var local = { req: { routing: { param: { section: 'alpha' } } } };
        var page  = autoPromoteSection(local);
        assert.equal(page['page.section'], 'alpha');
    });

    it('positive: a different section value flows through unchanged', function() {
        var local = { req: { routing: { param: { section: 'billing' } } } };
        var page  = autoPromoteSection(local);
        assert.equal(page['page.section'], 'billing');
    });

    it('negative: routing.param without `section` → page.section never set', function() {
        var local = { req: { routing: { param: { file: 'index' } } } };
        var page  = autoPromoteSection(local);
        assert.ok(
            !Object.prototype.hasOwnProperty.call(page, 'page.section'),
            'page.section must not be assigned when route.param.section is absent'
        );
    });

    it('negative: routing without param → no page.section assignment', function() {
        var local = { req: { routing: {} } };
        var page  = autoPromoteSection(local);
        assert.ok(!Object.prototype.hasOwnProperty.call(page, 'page.section'));
    });

    it('negative: req without routing → no page.section assignment', function() {
        var local = { req: {} };
        var page  = autoPromoteSection(local);
        assert.ok(!Object.prototype.hasOwnProperty.call(page, 'page.section'));
    });

    it('negative: missing local.req → no crash, no page.section assignment', function() {
        // Defensive: createTestInstance + similar test paths can call into
        // setOptions with bare {req: {}, res: {}}; the guard on local.req
        // protects against the "object missing routing" shape.
        var local = {};
        var page  = autoPromoteSection(local);
        assert.ok(!Object.prototype.hasOwnProperty.call(page, 'page.section'));
    });

    it('negative: empty-string section is skipped (falsy guard)', function() {
        // `if (... && param.section)` is a truthy check, so '' falls through.
        // Mirrors the "absent" branch — page.section is never assigned to ''.
        var local = { req: { routing: { param: { section: '' } } } };
        var page  = autoPromoteSection(local);
        assert.ok(!Object.prototype.hasOwnProperty.call(page, 'page.section'));
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 12 — throwError: stack stripped from JSON wire outside local scope
// ─────────────────────────────────────────────────────────────────────────
//
// Server-side stack frames leak file paths, library versions, and internal
// function locations to API clients. The XHR/JSON branch of throwError must
// strip errorObject.stack on the wire for every scope except local (where
// the dev toolbar's data-xhr panel renders it via events.js:394 →
// ginaToolbar.update('data-xhr', XHRData)).
//
// Gate shape: `if (!_isLocalScope && errorObject && errorObject.stack)
//              delete errorObject.stack;`
// Placed after both construction paths converge (after the L5129-5137 fallback
// initializer) and before serialization at `var errOutput = null, output = ...`.

describe('12 - throwError: stack stripped from JSON wire outside local scope', function() {

    // ── (a) source structure ─────────────────────────────────────────────────

    it('source contains the fail-closed strip gate', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('!_isLocalScope && errorObject && errorObject.stack') > -1,
            'expected `!_isLocalScope && errorObject && errorObject.stack` guard'
        );
        assert.ok(
            src.indexOf('delete errorObject.stack;') > -1,
            'expected `delete errorObject.stack;` inside the guard body'
        );
    });

    it('strip gate sits after the L5129-5137 fallback initializer and before serialization', function() {
        var src         = fs.readFileSync(SOURCE, 'utf8');
        var fallbackIdx = src.indexOf('stack: msg.stack');
        var gateIdx     = src.indexOf('!_isLocalScope && errorObject && errorObject.stack');
        var serializeIdx = src.indexOf('var errOutput = null, output = errorObject.toString()');
        assert.ok(fallbackIdx > -1, 'fallback initializer literal `stack: msg.stack` not found');
        assert.ok(gateIdx > -1, 'strip gate not found');
        assert.ok(serializeIdx > -1, 'serialization site `var errOutput = null, output = errorObject.toString()` not found');
        assert.ok(
            fallbackIdx < gateIdx,
            'strip gate must be AFTER the fallback initializer so both construction paths converge first'
        );
        assert.ok(
            gateIdx < serializeIdx,
            'strip gate must be BEFORE serialization so JSON.stringify never sees the stack field'
        );
    });

    it('source uses the module-load cached _isLocalScope (not a per-request lookup)', function() {
        var src    = fs.readFileSync(SOURCE, 'utf8');
        var cached = src.match(/var _isLocalScope\s*=\s*process\.env\.NODE_SCOPE_IS_LOCAL/);
        assert.ok(cached, 'expected cached `var _isLocalScope = process.env.NODE_SCOPE_IS_LOCAL` per #P19');
        // Strip gate references the cached boolean, not process.env directly.
        var gateBlock = src.split('!_isLocalScope && errorObject && errorObject.stack')[1];
        assert.ok(gateBlock, 'gate block could not be extracted');
        // Within ~200 chars after the gate header, no per-request env lookup.
        var window200 = gateBlock.slice(0, 200);
        assert.ok(
            window200.indexOf('process.env.NODE_SCOPE_IS_LOCAL') < 0,
            'gate body must use cached _isLocalScope (#P19), not process.env.NODE_SCOPE_IS_LOCAL'
        );
    });

    it('JSDoc on throwError documents the scope-gated stack behaviour', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var jsdocStart = src.indexOf('Throw error — terminates the request');
        var fnDecl     = src.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(jsdocStart > -1, 'expected updated JSDoc description on throwError');
        assert.ok(fnDecl > -1, 'throwError function declaration not found');
        var jsdocBlock = src.slice(jsdocStart, fnDecl);
        assert.ok(
            jsdocBlock.indexOf('NODE_SCOPE_IS_LOCAL') > -1,
            'JSDoc must reference NODE_SCOPE_IS_LOCAL'
        );
        assert.ok(
            jsdocBlock.indexOf('strip') > -1 || jsdocBlock.indexOf('stripped') > -1,
            'JSDoc must mention that stack is stripped outside local scope'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────

    // Mirrors the gate + serialization shape in controller.js (~L5138-5150).
    // Takes an isLocalScope bool so both branches can be exercised without
    // mutating process.env or reloading the controller module.
    function buildErrOutput(errorObject, isLocalScope) {
        if (!isLocalScope && errorObject && errorObject.stack) {
            delete errorObject.stack;
        }
        var output = errorObject.toString();
        if (output == '[object Object]') {
            return JSON.parse(JSON.stringify(errorObject));
        }
        return JSON.parse(JSON.stringify({
            status : errorObject.status,
            error  : output,
            stack  : errorObject.stack || null
        }));
    }

    it('local scope: stack preserved on the wire (catch-all path)', function() {
        var errObj = {
            status  : 500,
            error   : 'boom',
            stack   : 'Error: boom\n    at /server/path/to/controller.js:42'
        };
        var out = buildErrOutput(errObj, true);
        assert.equal(out.stack, 'Error: boom\n    at /server/path/to/controller.js:42');
        assert.equal(out.status, 500);
    });

    it('production / beta / testing / unset: stack stripped (catch-all path)', function() {
        var errObj = {
            status  : 500,
            error   : 'boom',
            stack   : 'Error: boom\n    at /server/path/to/controller.js:42'
        };
        var out = buildErrOutput(errObj, false);
        assert.ok(!('stack' in out), 'stack field must be absent from JSON body');
        assert.equal(out.status, 500);
        assert.equal(out.error, 'boom');
    });

    it('non-local: covers the L5129-5137 fallback construction path', function() {
        // Mirrors the fallback initializer at L5129-5137 — built from msg.stack.
        var msg = { stack: 'Error: synth\n    at /server/lib/x.js:9' };
        var errObj = {
            status  : 500,
            error   : 'synth',
            message : 'synth',
            stack   : msg.stack
        };
        var out = buildErrOutput(errObj, false);
        assert.ok(!('stack' in out), 'fallback path must also strip stack outside local scope');
    });

    it('whitelist serialization path: stack becomes null when toString is custom', function() {
        // Mirrors the L5143-5149 branch where `output != "[object Object]"` —
        // the wire shape carries `stack: errorObject.stack || null`.
        var errObj = {
            status  : 500,
            error   : 'boom',
            stack   : 'Error: boom\n    at /server/path/x.js:1',
            toString: function() { return 'custom error toString'; }
        };
        var out = buildErrOutput(errObj, false);
        assert.equal(out.stack, null, 'stripped stack must serialize to null on the whitelist path');
        assert.equal(out.error, 'custom error toString');
    });

    it('whitelist serialization path: stack preserved on local scope', function() {
        var errObj = {
            status  : 500,
            error   : 'boom',
            stack   : 'Error: boom\n    at /server/path/x.js:1',
            toString: function() { return 'custom error toString'; }
        };
        var out = buildErrOutput(errObj, true);
        assert.equal(out.stack, 'Error: boom\n    at /server/path/x.js:1');
    });

    it('no-stack error: gate is a no-op (no crash on missing field)', function() {
        // Catch-all path (`output == '[object Object]'`) serializes errorObject
        // as-is — an absent stack stays absent (undefined). The whitelist path
        // explicitly emits `stack: null`. Both shapes are falsy and correct.
        var errObj = { status: 400, error: 'bad request' };
        var outLocal    = buildErrOutput(Object.assign({}, errObj), true);
        var outNonLocal = buildErrOutput(Object.assign({}, errObj), false);
        assert.ok(!outLocal.stack, 'absent stack must remain falsy under local scope');
        assert.ok(!outNonLocal.stack, 'absent stack must remain falsy under non-local scope');
    });

    it('falsy errorObject: gate is a no-op (defensive `errorObject &&` guard)', function() {
        // The guard's `errorObject &&` short-circuit guarantees no crash when
        // errorObject is null/undefined. This test mirrors that defensive shape.
        function gateOnly(errorObject, isLocalScope) {
            if (!isLocalScope && errorObject && errorObject.stack) {
                delete errorObject.stack;
            }
            return errorObject;
        }
        assert.equal(gateOnly(null, false), null);
        assert.equal(gateOnly(undefined, false), undefined);
        assert.equal(gateOnly(null, true), null);
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 13 — throwError HTML branch: <pre class="stack"> rendered only in local scope
// ─────────────────────────────────────────────────────────────────────────
//
// Symmetric to section 12 (JSON wire). The fallback HTML error page —
// produced inside the L5294+ `var msgString = '<h1 class="status">...'`
// construction block when no custom error template is configured — must
// gate its `<pre class="stack">` render on `_isLocalScope` so it doesn't
// leak server-side stack frames to non-local viewers.
//
// Two render sites:
//   (1) msg-shape   — `if (msg.stack && _isLocalScope) { ... msg.stack mangling + render ... }`
//   (2) generic-shape — `if (stack && _isLocalScope) { msgString += <pre class=...stack> }`
//
// Custom error templates dispatched via `renderCustomError` (L5266-5281)
// are consumer-owned and out of scope here.

describe('13 - throwError HTML branch: stack rendered only in local scope', function() {

    // ── (a) source structure ─────────────────────────────────────────────────

    it('source contains the msg-shape fail-closed gate', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('if (msg.stack && _isLocalScope)') > -1,
            'expected `if (msg.stack && _isLocalScope)` at the msg-shape site'
        );
    });

    it('source contains the generic-shape fail-closed gate', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('if (stack && _isLocalScope)') > -1,
            'expected `if (stack && _isLocalScope)` at the generic-shape site'
        );
    });

    it('both gates sit inside the fallback HTML msgString construction block', function() {
        var src              = fs.readFileSync(SOURCE, 'utf8');
        var msgStringIdx     = src.indexOf("var msgString = '<h1 class=\"status\">Error ");
        var msgGateIdx       = src.indexOf('if (msg.stack && _isLocalScope)');
        var genericGateIdx   = src.indexOf('if (stack && _isLocalScope)');
        assert.ok(msgStringIdx > -1, 'msgString anchor not found in source');
        assert.ok(msgGateIdx > -1, 'msg-shape gate not found');
        assert.ok(genericGateIdx > -1, 'generic-shape gate not found');
        assert.ok(msgGateIdx > msgStringIdx, 'msg-shape gate must sit AFTER the msgString anchor');
        assert.ok(genericGateIdx > msgStringIdx, 'generic-shape gate must sit AFTER the msgString anchor');
        // generic-shape sits after msg-shape (the if/else branches in source).
        assert.ok(genericGateIdx > msgGateIdx, 'generic-shape gate must sit AFTER the msg-shape gate');
    });

    it('source uses the cached _isLocalScope, not a per-request env lookup', function() {
        // Neither gate body should reach into process.env directly — the
        // _isLocalScope module cache (controller.js:69, #P19) is the only
        // valid source.
        var src = fs.readFileSync(SOURCE, 'utf8');
        var msgBlock = src.split('if (msg.stack && _isLocalScope)')[1] || '';
        var genBlock = src.split('if (stack && _isLocalScope)')[1] || '';
        assert.ok(
            msgBlock.slice(0, 400).indexOf('process.env.NODE_SCOPE_IS_LOCAL') < 0,
            'msg-shape gate body must not reference process.env.NODE_SCOPE_IS_LOCAL directly'
        );
        assert.ok(
            genBlock.slice(0, 200).indexOf('process.env.NODE_SCOPE_IS_LOCAL') < 0,
            'generic-shape gate body must not reference process.env.NODE_SCOPE_IS_LOCAL directly'
        );
    });

    it('JSDoc covers the HTML branch policy alongside the JSON branch', function() {
        var src        = fs.readFileSync(SOURCE, 'utf8');
        var jsdocStart = src.indexOf('Throw error — terminates the request');
        var fnDecl     = src.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(jsdocStart > -1 && fnDecl > -1, 'throwError JSDoc anchors not found');
        var jsdoc = src.slice(jsdocStart, fnDecl);
        assert.ok(
            jsdoc.indexOf('HTML') > -1 || jsdoc.indexOf('<pre class="stack">') > -1,
            'JSDoc must mention the HTML branch policy'
        );
    });

    // ── (b) pure logic — inline replicas mirror the controller.js shapes ─────

    // #B554 — mirrors the shipped `_escapeHtml` (controller.js, byte-identical
    // copies in server.js + render-nunjucks.js). The replicas below must carry
    // it because the shipped builder does: an unescaped replica would drift
    // from the bytes it claims to mirror, and every assertion here would keep
    // passing while the real page had changed. The escaping is transparent to
    // this section's own claims — each compares two renders of the SAME input
    // across scopes, which escaping leaves equal.
    function _escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Mirrors L5294-5323 (msg-shape branch).
    function renderMsgShape(msg, eCode, isLocalScope) {
        var msgString = '<h1 class="status">Error '+ (msg.status || 500) +'.</h1>';
        if (msg.title)   msgString += '<pre class="'+ eCode +' title">'+ _escapeHtml(msg.title) +'</pre>';
        if (msg.error)   msgString += '<pre class="'+ eCode +' message">'+ _escapeHtml(msg.error) +'</pre>';
        if (msg.message) msgString += '<pre class="'+ eCode +' message">'+ _escapeHtml(msg.message) +'</pre>';
        if (msg.stack && isLocalScope) {
            if (msg.error)   msg.stack = msg.stack.replace(msg.error, '');
            if (msg.message) msg.stack = msg.stack.replace(msg.message, '');
            msg.stack = msg.stack.replace('Error:', '').replace(' ', '');
            msgString += '<pre class="'+ eCode +' stack">'+ _escapeHtml(msg.stack) +'</pre>';
        }
        return msgString;
    }

    // Mirrors L5325-5352 (generic-shape branch).
    function renderGenericShape(errorObject, eCode, isLocalScope) {
        var msgString = '<h1 class="status">Error '+ (errorObject.status || 500) +'.</h1>';
        var title = null, message = null, stack = null;
        if (errorObject && typeof(errorObject.error)   != 'undefined') title   = errorObject.error;
        if (errorObject && typeof(errorObject.message) != 'undefined') message = errorObject.message;
        if (errorObject && typeof(errorObject.stack)   != 'undefined') stack   = errorObject.stack;
        if (title)   msgString += '<pre class="'+ eCode +' title">'+ _escapeHtml(title) +'</pre>';
        if (message) msgString += '<pre class="'+ eCode +' message">'+ _escapeHtml(message) +'</pre>';
        if (stack && isLocalScope) {
            msgString += '<pre class="'+ eCode +' stack">'+ _escapeHtml(stack) +'</pre>';
        }
        return msgString;
    }

    it('msg-shape local scope: stack <pre> rendered with frame content', function() {
        var msg = { status: 500, error: 'boom', stack: 'Error: boom\n    at /server/path/x.js:1' };
        var html = renderMsgShape(msg, '5xx', true);
        assert.ok(html.indexOf('<pre class="5xx stack">') > -1, 'stack pre must be present in local scope');
        assert.ok(html.indexOf('/server/path/x.js:1') > -1, 'frame content must be visible in local scope');
    });

    it('msg-shape non-local scope: stack <pre> absent, no frame content', function() {
        var msg = { status: 500, error: 'boom', stack: 'Error: boom\n    at /server/path/x.js:1' };
        var html = renderMsgShape(msg, '5xx', false);
        assert.ok(html.indexOf('<pre class="5xx stack">') < 0, 'stack pre must be absent outside local scope');
        assert.ok(html.indexOf('/server/path/x.js:1') < 0, 'frame content must not leak outside local scope');
    });

    it('generic-shape local scope: stack <pre> rendered with frame content', function() {
        var errObj = { status: 500, error: 'boom', stack: 'Error: boom\n    at /server/path/y.js:42' };
        var html = renderGenericShape(errObj, '5xx', true);
        assert.ok(html.indexOf('<pre class="5xx stack">') > -1, 'stack pre must be present in local scope');
        assert.ok(html.indexOf('/server/path/y.js:42') > -1, 'frame content must be visible in local scope');
    });

    it('generic-shape non-local scope: stack <pre> absent, no frame content', function() {
        var errObj = { status: 500, error: 'boom', stack: 'Error: boom\n    at /server/path/y.js:42' };
        var html = renderGenericShape(errObj, '5xx', false);
        assert.ok(html.indexOf('<pre class="5xx stack">') < 0, 'stack pre must be absent outside local scope');
        assert.ok(html.indexOf('/server/path/y.js:42') < 0, 'frame content must not leak outside local scope');
    });

    it('non-stack content (title, error, message) renders identically across scopes', function() {
        // The gate must only affect the stack <pre> — title/error/message
        // <pre> blocks render the same in any scope.
        var msg = { status: 500, title: 'Boom', error: 'failed', message: 'Internal' };
        var localHtml    = renderMsgShape(Object.assign({}, msg), '5xx', true);
        var nonLocalHtml = renderMsgShape(Object.assign({}, msg), '5xx', false);
        assert.equal(localHtml, nonLocalHtml, 'non-stack content must render identically in both scopes');
    });

    it('msg-shape with no stack: gate is a no-op (no crash)', function() {
        var msg = { status: 400, error: 'bad request' };
        var localHtml    = renderMsgShape(Object.assign({}, msg), '4xx', true);
        var nonLocalHtml = renderMsgShape(Object.assign({}, msg), '4xx', false);
        assert.equal(localHtml, nonLocalHtml, 'absent stack must render the same in both scopes');
        assert.ok(localHtml.indexOf('<pre class="4xx stack">') < 0, 'no stack pre when no stack field');
    });

    it('generic-shape with no stack: gate is a no-op (no crash)', function() {
        var errObj = { status: 400, error: 'bad request' };
        var localHtml    = renderGenericShape(Object.assign({}, errObj), '4xx', true);
        var nonLocalHtml = renderGenericShape(Object.assign({}, errObj), '4xx', false);
        assert.equal(localHtml, nonLocalHtml, 'absent stack must render the same in both scopes');
        assert.ok(localHtml.indexOf('<pre class="4xx stack">') < 0, 'no stack pre when no stack field');
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 14 — throwError 2-arg form: (statusCode, Error|string) preserves status
// ─────────────────────────────────────────────────────────────────────────
//
// The documented overloads in types/index.d.ts are 1-arg, 3-arg, and
// 1-arg-object. Consumers also reach for an undocumented 2-arg form
// `throwError(statusCode, ErrorInstance)`. Before the normalization shift,
// this form silently fell back to HTTP 500 because the L4998 if-branch's
// coercion at L5005-5007 inspects `code` (the Error/string) and `res.status`
// (the number's .status — undefined), never `res` itself as a number.
//
// Fix shape: a 2-arg normalization shift at the top of the function detects
// `typeof(res) == 'number' && arguments.length === 2` with the second arg
// being an Error or string, and shifts the locals to the canonical form
// (msg = arguments[1], code = res, res = local.res). Args then flow naturally
// through the existing L4998 IF branch with the explicit code preserved.
//
// The 2-arg errorObj form `throwError(statusCode, errorObj)` is NOT shifted —
// the existing `else if (arguments.length < 3)` branch at L5072 already
// handles it correctly (status reaches the explicit code via `code = res`).

describe('14 - throwError 2-arg form: (statusCode, Error|string) preserves status', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure ─────────────────────────────────────────────────

    it('source contains the 2-arg normalization shift signal strings', function() {
        assert.ok(src.indexOf("typeof(res) == 'number' && arguments.length === 2") > -1,
            "expected `typeof(res) == 'number' && arguments.length === 2` shift guard");
        assert.ok(src.indexOf('arguments[1] instanceof Error') > -1,
            'expected `arguments[1] instanceof Error` recognized shape');
        assert.ok(src.indexOf("typeof(arguments[1]) == 'string'") > -1,
            "expected `typeof(arguments[1]) == 'string'` recognized shape");
    });

    it('shift sits BEFORE the existing L4998 IF branch', function() {
        var shiftIdx = src.indexOf("typeof(res) == 'number' && arguments.length === 2");
        var ifIdx    = src.indexOf('arguments[0] instanceof Error');
        assert.ok(shiftIdx > -1, '2-arg shift not found in source');
        assert.ok(ifIdx > -1, 'L4998 IF branch anchor not found');
        assert.ok(shiftIdx < ifIdx, 'shift must run BEFORE the L4998 IF branch');
    });

    it('shift binds to length === 2 (regression guard against 1-arg / 3-arg call shapes)', function() {
        assert.ok(src.indexOf('arguments.length === 2') > -1,
            'expected strict `arguments.length === 2` to bind the shift to the 2-arg shape only');
    });

    it('JSDoc on throwError documents the 2-arg form', function() {
        var jsdocStart = src.indexOf('Throw error — terminates the request');
        var fnDecl     = src.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(jsdocStart > -1 && fnDecl > -1, 'throwError JSDoc anchors not found');
        var jsdoc = src.slice(jsdocStart, fnDecl);
        assert.ok(jsdoc.indexOf('throwError(code, err)') > -1,
            'JSDoc must list the `throwError(code, err)` 2-arg form');
    });

    it('types/index.d.ts declares the 2-arg overload', function() {
        var dtsPath = path.resolve(__dirname, '../../types/index.d.ts');
        var dts     = fs.readFileSync(dtsPath, 'utf8');
        assert.ok(
            dts.indexOf('throwError(code: number, err: Error | string)') > -1,
            'types/index.d.ts must declare `throwError(code: number, err: Error | string): void;`'
        );
    });

    // ── (b) pure logic — inline replica of normalization + downstream branches

    // Mirrors controller.js: the new shift block at function entry, then
    // either the L4998 IF branch (Error/string second args) or the L5072
    // `else if (arguments.length < 3)` branch. Returns the final locals
    // and constructed errorObject so tests can assert end-to-end shape.
    var statusCodes = {
        400: 'Bad Request',
        404: 'Not Found',
        412: 'Precondition Failed',
        500: 'Internal Server Error'
    };

    function normalizeAndCoerce(args, localRes) {
        var res  = args[0];
        var code = args[1];
        var msg  = args[2];

        // Mirrors the new shift block in controller.js verbatim.
        if ( typeof(res) == 'number' && args.length === 2 && (
            args[1] instanceof Error
            || typeof(args[1]) == 'string'
        )) {
            msg  = args[1];
            code = res;
            res  = localRes;
        }

        var errorObject = null;
        var standardErrorMessage = null;

        if (
            args[0] instanceof Error
            || args.length == 1 && typeof(res) == 'object'
            || args[args.length-1] instanceof Error
            || typeof(args[args.length-1]) == 'string' && !(args[0] instanceof Error)
        ) {
            // Mirror of L5005-5070 (status-coercion + Error/string extraction).
            msg  = ( !/^\d+$/.test(code) && typeof(msg) == 'undefined' ) ? code : msg;
            code = ( /^\d{3}$/.test(String(code)) ) ? code
                 : ( res && typeof(res.status) != 'undefined' ) ? res.status
                 : 500;
            standardErrorMessage = statusCodes[code] || null;
            errorObject = {
                status: code,
                error: (res && res.error) || (res && res.message) || standardErrorMessage
            };
            if (args[args.length-1] instanceof Error) {
                var _lastArg = args[args.length-1];
                if (_lastArg.message) errorObject.message = _lastArg.message;
                if (_lastArg.stack)   errorObject.stack   = _lastArg.stack;
                if (!errorObject.error) errorObject.error = _lastArg.message || standardErrorMessage;
            } else if (typeof(args[args.length-1]) == 'string') {
                errorObject.message = args[args.length-1];
            }
            res = localRes;
        } else if (args.length < 3) {
            // Mirror of L5072-5076 else branch + L5143-5151 fallback initializer.
            msg  = code || null;
            code = res || 500;
            res  = localRes;
            standardErrorMessage = statusCodes[code] || null;
            errorObject = {
                status:  code,
                error:   standardErrorMessage || (msg && msg.error) || msg,
                message: (msg && msg.message) || msg,
                stack:   msg && msg.stack
            };
        }

        return { res: res, code: code, msg: msg, errorObject: errorObject };
    }

    var FAKE_RES = { __isLocalRes: true, getHeaders: function() { return {}; } };

    it('throwError(404, new Error("not found")) — status preserved as 404', function() {
        var err = new Error('not found');
        var r = normalizeAndCoerce([404, err], FAKE_RES);
        assert.equal(r.code, 404, 'code must be the explicit 404, not the 500 fallback');
        assert.equal(r.errorObject.status, 404);
        assert.equal(r.errorObject.error, 'Not Found', 'standardErrorMessage for 404');
        assert.equal(r.errorObject.message, 'not found', 'Error.message preserved on errorObject');
        assert.equal(r.res, FAKE_RES, 'res shifted to local.res');
    });

    it('throwError(400, "Bad input") — status preserved as 400', function() {
        var r = normalizeAndCoerce([400, 'Bad input'], FAKE_RES);
        assert.equal(r.code, 400);
        assert.equal(r.errorObject.status, 400);
        assert.equal(r.errorObject.error, 'Bad Request');
        assert.equal(r.errorObject.message, 'Bad input');
    });

    it('throwError(412, errorObj) — NOT shifted, falls through to L5072 else (status 412)', function() {
        // Regression guard: the 2-arg errorObj form is intentionally NOT shifted.
        var errObj = { status: 412, fields: { name: 'Required' } };
        var r = normalizeAndCoerce([412, errObj], FAKE_RES);
        assert.equal(r.code, 412, 'code must be the explicit 412');
        assert.equal(r.errorObject.status, 412);
        assert.equal(r.msg, errObj, 'msg holds the errorObj after the L5072 reshuffle');
    });

    it('throwError(new Error("boom")) — 1-arg form unchanged (shift does NOT fire on length 1)', function() {
        var err = new Error('boom');
        var r = normalizeAndCoerce([err], FAKE_RES);
        assert.equal(r.code, 500, '1-arg Error with no status falls back to 500');
        assert.equal(r.errorObject.status, 500);
        assert.equal(r.errorObject.message, 'boom');
    });

    it('throwError(res, 500, new Error()) — 3-arg internal form unchanged (shift does NOT fire on length 3)', function() {
        var err = new Error('explicit 3-arg');
        var fakeRouterRes = { getHeaders: function() { return {}; } };
        var r = normalizeAndCoerce([fakeRouterRes, 500, err], FAKE_RES);
        assert.equal(r.code, 500, '3-arg with explicit 500 must remain 500');
        assert.equal(r.errorObject.status, 500);
        assert.equal(r.errorObject.message, 'explicit 3-arg');
    });

    it('throwError(404, null) — shift does NOT fire (null is not Error or string), falls to L5072 else', function() {
        var r = normalizeAndCoerce([404, null], FAKE_RES);
        assert.equal(r.code, 404, 'L5072 else picks up the explicit 404 via `code = res || 500`');
    });

    it('throwError(404, {}) — empty-object 2nd arg, shift does NOT fire, falls to L5072 else', function() {
        var r = normalizeAndCoerce([404, {}], FAKE_RES);
        assert.equal(r.code, 404, 'explicit 404 preserved via L5072 else');
    });

    it('shift guard: typeof(res) === "number" required (object first arg does NOT fire the shift)', function() {
        function shiftFires(args) {
            return typeof(args[0]) == 'number' && args.length === 2 && (
                args[1] instanceof Error
                || typeof(args[1]) == 'string'
            );
        }
        assert.equal(shiftFires([404, new Error()]), true, 'number + Error → shift fires');
        assert.equal(shiftFires([400, 'msg']), true, 'number + string → shift fires');
        assert.equal(shiftFires([{}, new Error()]), false, 'object first arg → shift does not fire');
        assert.equal(shiftFires([new Error()]), false, '1-arg Error → shift does not fire (length 1)');
        assert.equal(shiftFires([{ getHeaders: function(){} }, 500, new Error()]), false, '3-arg → shift does not fire (length 3)');
    });

});


// 15 — source structure: sendTrailers (#H10)
describe('15 - source structure: sendTrailers (#H10)', function() {

    it('sendTrailers is defined in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('this.sendTrailers = function(') > -1,
            'expected `this.sendTrailers = function(` — #H10 not applied'
        );
    });

    it('source contains #H10 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#H10') > -1, 'expected #H10 marker in source');
    });

    it('stashes registered trailers on local._trailers', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.sendTrailers = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('local._trailers') > -1, 'expected local._trailers assignment');
    });

    it('strips `:`-prefixed pseudo-header keys and returns self', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.sendTrailers = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf("charAt(0) === ':'") > -1, 'expected pseudo-header (`:`-prefixed) strip');
        assert.ok(block.indexOf('return self') > -1, 'expected `return self` for chaining');
    });
});


// 16 — sendTrailers: pure logic
describe('16 - sendTrailers: pure logic', function() {

    // Minimal replica of the sendTrailers body for isolated testing.
    function makeTrailerEnv() {
        var local = {};
        var self  = {};
        function sendTrailers(fields) {
            if (!fields || typeof(fields) !== 'object') return self;
            var _clean = {};
            var _has   = false;
            for (var k in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
                if (k.charAt(0) === ':') continue;
                _clean[k] = fields[k];
                _has = true;
            }
            local._trailers = _has ? _clean : null;
            return self;
        }
        return { local: local, self: self, sendTrailers: sendTrailers };
    }

    it('stashes a clean object on local._trailers', function() {
        var env = makeTrailerEnv();
        env.sendTrailers({ 'grpc-status': '0' });
        assert.deepEqual(env.local._trailers, { 'grpc-status': '0' });
    });

    it('strips `:`-prefixed pseudo-headers', function() {
        var env = makeTrailerEnv();
        env.sendTrailers({ ':status': '200', 'grpc-status': '0' });
        assert.deepEqual(env.local._trailers, { 'grpc-status': '0' });
    });

    it('sets local._trailers to null when only pseudo-headers are given', function() {
        var env = makeTrailerEnv();
        env.sendTrailers({ ':status': '200' });
        assert.strictEqual(env.local._trailers, null);
    });

    it('no-ops on a non-object argument and returns self', function() {
        var env = makeTrailerEnv();
        var r1 = env.sendTrailers('nope');
        var r2 = env.sendTrailers(null);
        var r3 = env.sendTrailers(undefined);
        assert.strictEqual(r1, env.self);
        assert.strictEqual(r2, env.self);
        assert.strictEqual(r3, env.self);
        assert.strictEqual(typeof env.local._trailers, 'undefined');
    });

    it('returns self for chaining on the success path', function() {
        var env = makeTrailerEnv();
        var r = env.sendTrailers({ 'x-foo': 'bar' });
        assert.strictEqual(r, env.self);
    });
});


// 17 — source structure: startJob / jobStatus (#AI6)
describe('17 - source structure: startJob / jobStatus (#AI6)', function() {

    it('startJob and jobStatus are defined in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('this.startJob = function(')  > -1, 'expected `this.startJob = function(` — #AI6 slice 2 not applied');
        assert.ok(src.indexOf('this.jobStatus = function(') > -1, 'expected `this.jobStatus = function(` — #AI6 slice 2 not applied');
    });

    it('source contains the #AI6 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#AI6') > -1, 'expected #AI6 marker in source');
    });

    it('startJob is a pass-through to lib.job.create that returns (the id)', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.startJob = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('lib.job.create') > -1, 'expected delegation to lib.job.create');
        assert.ok(block.indexOf('return') > -1,         'expected the job id to be returned');
    });

    it('startJob stashes NOTHING on local (the job outlives the request)', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.startJob = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('local.') === -1, 'startJob must not touch the per-request local closure (contrast with sendTrailers)');
    });

    it('jobStatus is a pass-through to lib.job.get', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.jobStatus = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('lib.job.get') > -1, 'expected delegation to lib.job.get');
    });
});


// 18 — startJob / jobStatus: pure logic
describe('18 - startJob / jobStatus: pure logic (#AI6)', function() {

    // Minimal replica mirroring the real method bodies, with lib.job faked.
    function makeJobEnv() {
        var calls   = { create: [], get: [] };
        var fakeJob = {
            create: function(fn, opts) { calls.create.push({ fn: fn, opts: opts }); return 'JOBID123'; },
            get:    function(id, cb)   { calls.get.push({ id: id, cb: cb }); cb(null, { id: id, state: 'completed', result: 42 }); }
        };
        var local = {};
        var self  = {};
        self.startJob  = function(fn, opts) { return fakeJob.create(fn, opts); };
        self.jobStatus = function(id, cb)   { fakeJob.get(id, cb); };
        return { calls: calls, local: local, self: self };
    }

    it('startJob returns the id from lib.job.create and forwards fn', function() {
        var env = makeJobEnv();
        var fn  = function() { return 1; };
        var id  = env.self.startJob(fn);
        assert.equal(id, 'JOBID123');
        assert.equal(env.calls.create.length, 1);
        assert.strictEqual(env.calls.create[0].fn, fn, 'fn forwarded by reference');
    });

    it('startJob forwards opts', function() {
        var env = makeJobEnv();
        env.self.startJob(function() {}, { meta: { kind: 'infer' }, callbackUrl: 'https://x/y' });
        assert.deepEqual(env.calls.create[0].opts, { meta: { kind: 'infer' }, callbackUrl: 'https://x/y' });
    });

    it('startJob does not stash anything on the per-request local closure', function() {
        var env = makeJobEnv();
        env.self.startJob(function() {});
        assert.equal(Object.keys(env.local).length, 0, 'local must remain untouched');
    });

    it('jobStatus forwards id + cb to lib.job.get', function() {
        var env = makeJobEnv();
        var got = null;
        env.self.jobStatus('abc', function(err, rec) { got = rec; });
        assert.equal(env.calls.get.length, 1);
        assert.equal(env.calls.get[0].id, 'abc');
        assert.deepEqual(got, { id: 'abc', state: 'completed', result: 42 });
    });
});


// 19 — source structure: inferAsync (#AI6)
describe('19 - source structure: inferAsync (#AI6)', function() {

    it('inferAsync is defined in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('this.inferAsync = function(') > -1, 'expected `this.inferAsync = function(` — #AI6 slice 4 not applied');
    });

    it('inferAsync composes getModel().infer() through self.startJob', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.inferAsync = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('self.startJob(') > -1, 'must defer through self.startJob');
        assert.ok(block.indexOf('getModel(')      > -1, 'must resolve the connector via getModel');
        assert.ok(block.indexOf('.infer(')        > -1, 'must call .infer on the connector');
    });

    it('inferAsync trims the result to content/model/usage (drops raw)', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.inferAsync = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('content:') > -1 && block.indexOf('model:') > -1 && block.indexOf('usage:') > -1,
            'must build a trimmed { content, model, usage } result');
        assert.ok(block.indexOf('raw') === -1, 'must NOT carry the raw provider response into the job result');
    });
});


// 20 — inferAsync: pure logic
describe('20 - inferAsync: pure logic (#AI6)', function() {

    // Replica mirroring the real inferAsync body, with getModel + startJob faked.
    function makeInferEnv() {
        var calls  = { startJob: [], getModel: [], infer: [] };
        var fakeAi = {
            infer: function(messages, options) {
                calls.infer.push({ messages: messages, options: options });
                return Promise.resolve({ content: 'hi', model: 'm', usage: { inputTokens: 1, outputTokens: 2 }, raw: { huge: true } });
            }
        };
        var getModel = function(name) { calls.getModel.push(name); return fakeAi; };
        var self = {};
        self.startJob  = function(fn, opts) { calls.startJob.push({ fn: fn, opts: opts }); return 'JID'; };
        self.inferAsync = function(messages, options, jobOpts) {
            options = options || {};
            var _connector = options.connector;
            return self.startJob(function() {
                return getModel(_connector).infer(messages, options).then(function(_r) {
                    return { content: _r.content, model: _r.model, usage: _r.usage };
                });
            }, jobOpts);
        };
        return { calls: calls, self: self };
    }

    it('returns the job id from startJob', function() {
        var env = makeInferEnv();
        var id  = env.self.inferAsync([{ role: 'user', content: 'x' }], { connector: 'myModel' });
        assert.equal(id, 'JID');
        assert.equal(env.calls.startJob.length, 1);
    });

    it('the deferred fn calls getModel(connector).infer(messages, options) and trims raw', async function() {
        var env  = makeInferEnv();
        var msgs = [{ role: 'user', content: 'hi' }];
        env.self.inferAsync(msgs, { connector: 'myModel', maxTokens: 9 });
        var fn     = env.calls.startJob[0].fn;
        var result = await fn();
        assert.deepEqual(env.calls.getModel, ['myModel'], 'getModel called with the connector name');
        assert.equal(env.calls.infer.length, 1);
        assert.strictEqual(env.calls.infer[0].messages, msgs, 'messages forwarded by reference');
        assert.equal(env.calls.infer[0].options.maxTokens, 9, 'infer options forwarded');
        assert.deepEqual(result, { content: 'hi', model: 'm', usage: { inputTokens: 1, outputTokens: 2 } });
        assert.ok(!('raw' in result), 'raw provider response dropped from the job result');
    });

    it('forwards jobOpts to startJob', function() {
        var env = makeInferEnv();
        env.self.inferAsync([{ role: 'user', content: 'x' }], { connector: 'c' }, { meta: { kind: 'summary' }, callbackUrl: 'https://x/y' });
        assert.deepEqual(env.calls.startJob[0].opts, { meta: { kind: 'summary' }, callbackUrl: 'https://x/y' });
    });
});


// self.setTemplate(file, ext) — runtime template override (commit a5f1faa3)
describe('self.setTemplate(file, ext) — runtime template override', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('declares this.setTemplate = function (file, ext)', function() {
        assert.ok(
            /this\.setTemplate\s*=\s*function\s*\(\s*file\s*,\s*ext\s*\)/.test(src),
            'expected `this.setTemplate = function (file, ext)` on BaseController — runtime override API was reverted'
        );
    });

    it('bails safely when setOptions has not run (no local.options)', function() {
        var fnMatch = src.match(/this\.setTemplate\s*=\s*function[\s\S]*?\n    \};/);
        assert.ok(fnMatch, 'setTemplate body not found');
        var body = fnMatch[0];
        assert.ok(
            /if\s*\(!local\.options\)\s*return/.test(body),
            'expected early-return guard `if (!local.options) return` — would crash when called before setOptions()'
        );
    });

    it('writes file/ext under local.options._templateOverride', function() {
        var fnMatch = src.match(/this\.setTemplate\s*=\s*function[\s\S]*?\n    \};/);
        var body = fnMatch[0];
        assert.ok(
            /local\.options\._templateOverride\.file\s*=\s*file/.test(body),
            'expected `local.options._templateOverride.file = file` assignment'
        );
        assert.ok(
            /local\.options\._templateOverride\.ext\s*=/.test(body),
            'expected `local.options._templateOverride.ext = ...` assignment'
        );
    });

    it('normalises ext to a leading-dot form', function() {
        var fnMatch = src.match(/this\.setTemplate\s*=\s*function[\s\S]*?\n    \};/);
        var body = fnMatch[0];
        assert.ok(
            /ext\.charAt\(0\)\s*===\s*'\.'/.test(body),
            'expected leading-dot normalisation `ext.charAt(0) === "."` — would cause double-dot or missing-dot paths'
        );
    });

    it('only accepts string arguments (ignores non-string file/ext)', function() {
        var fnMatch = src.match(/this\.setTemplate\s*=\s*function[\s\S]*?\n    \};/);
        var body = fnMatch[0];
        assert.ok(
            /typeof\s+file\s*===\s*'string'/.test(body),
            'expected `typeof file === "string"` guard'
        );
        assert.ok(
            /typeof\s+ext\s*===\s*'string'/.test(body),
            'expected `typeof ext === "string"` guard'
        );
    });

});


// 21 — gina-container bare-global fallbacks (GINA_PID / GINA_CULTURE)
// The Docker/K8s foreground launcher (bin/gina-container) bypasses the daemon and
// never defines the GINA_PID / GINA_CULTURE globals, so a bare read of either in
// setOptions threw `ReferenceError: <NAME> is not defined` (HTTP 500) on every
// view-rendering route. Both reads now go through getEnvVar() with a safe fallback,
// matching the siblings (render-json.js, inspector-window-emit.js) and the
// culture-default precedent (config.js / init.js).
describe('21 - gina-container bare-global fallbacks (GINA_PID / GINA_CULTURE)', function() {

    // ---- source structure ----

    it('reads GINA_PID via getEnvVar with a String(process.pid) fallback', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("getEnvVar('GINA_PID') || String(process.pid)") > -1,
            "expected `getEnvVar('GINA_PID') || String(process.pid)` — a bare GINA_PID read ReferenceErrors under gina-container"
        );
    });

    it('no longer reads a bare GINA_PID global in the page.environment setter', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("'page.environment.gina pid', GINA_PID)") === -1,
            'expected the bare `GINA_PID` read to be gone — it throws ReferenceError under the daemonless launcher'
        );
    });

    it('reads GINA_CULTURE via getEnvVar with an en_CM fallback', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("getEnvVar('GINA_CULTURE') || 'en_CM'") > -1,
            "expected `getEnvVar('GINA_CULTURE') || 'en_CM'` — a bare GINA_CULTURE read ReferenceErrors under gina-container"
        );
    });

    it('no longer reads a bare GINA_CULTURE global for acceptLanguage', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('var acceptLanguage = GINA_CULTURE;') === -1,
            'expected the bare `GINA_CULTURE` read to be gone — it throws ReferenceError under the daemonless launcher'
        );
    });

    // ---- pure logic: the getEnvVar() || fallback resolution ----

    // Replica of the reader-side resolution used at both sites: getEnvVar('X')
    // returns the daemon-set value when present, else undefined (the daemonless
    // launcher case), in which case the fallback wins.
    function resolve(getEnvVar, key, fallback) {
        return getEnvVar(key) || fallback;
    }

    it('GINA_PID: the daemon-set value wins over the fallback', function() {
        var getEnvVar = function(k) { return k === 'GINA_PID' ? '4242' : undefined; };
        assert.strictEqual(resolve(getEnvVar, 'GINA_PID', String(99)), '4242');
    });

    it('GINA_PID: falls back to String(process.pid) when unset (gina-container)', function() {
        var getEnvVar = function() { return undefined; };
        var resolved  = resolve(getEnvVar, 'GINA_PID', String(12345));
        assert.strictEqual(resolved, '12345');
        assert.strictEqual(typeof resolved, 'string', 'fallback must yield a string pid');
    });

    it('GINA_CULTURE: daemon value wins; unset falls back to en_CM (gina-container)', function() {
        var daemon  = function() { return 'fr_FR'; };
        var missing = function() { return undefined; };
        assert.strictEqual(resolve(daemon,  'GINA_CULTURE', 'en_CM'), 'fr_FR');
        assert.strictEqual(resolve(missing, 'GINA_CULTURE', 'en_CM'), 'en_CM');
    });

    it('a bare read of an undeclared global throws ReferenceError (the pre-fix failure mode)', function() {
        // getEnvVar() returns undefined for an unset key; a bare identifier read
        // of the same omitted name throws — which is exactly why the daemonless
        // launcher 500'd before the fix.
        assert.throws(function() {
            return GINA_PID_zzz_never_defined; // eslint-disable-line no-undef
        }, ReferenceError);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// 22 — late throwError / headersSent on a released response (#B31)
//
// Field sequence: a controller action redirects (301) — redirect() ends the
// response and releases local.req/res/next (the terminal-exit triplet) — then
// a late async continuation (entity/query callback, timer, catch handler)
// calls self.throwError(err) on the same request. Pre-fix, throwError
// normalized `res` to the released ref (null) and read typeof(res.getHeaders):
// `TypeError: Cannot read properties of null (reading 'getHeaders')` — an
// uncaughtException the process supervisor escalates to SIGTERM, killing the
// bundle and every in-flight request with it. headersSent() had the same
// exposure via its `typeof(_res.stream)` read (any second render*() call
// after a terminal exit). Both entry points must no-op on a released
// response: the response is gone, there is nothing left to write on.
// ─────────────────────────────────────────────────────────────────────────────

describe('22 - throwError / headersSent on a released response (#B31)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ---- source structure ----

    it('headersSent guards the released response before any deref', function() {
        var hsIdx = src.indexOf('var headersSent = function(res)');
        assert.ok(hsIdx > -1, 'expected the headersSent definition');
        var hsEnd = src.indexOf('return false;', hsIdx);
        assert.ok(hsEnd > hsIdx, 'expected the headersSent fall-through tail');
        var hsBlk = src.substring(hsIdx, hsEnd);

        var guardIdx  = hsBlk.indexOf('if ( !_res )');
        var streamIdx = hsBlk.indexOf('_res.stream');
        assert.ok(guardIdx > -1, 'expected the `if ( !_res )` released-response guard');
        assert.ok(streamIdx > -1, 'expected the `_res.stream` read');
        assert.ok(guardIdx < streamIdx, 'the null guard must precede the first `_res` deref');
        assert.match(
            hsBlk.substring(guardIdx, guardIdx + 100),
            /if \( !_res \)\s*\{\s*return true;/,
            'a released response must report as already-sent so callers no-op'
        );
    });

    it('throwError no-ops on a released response before the header snapshot', function() {
        var fnIdx = src.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(fnIdx > -1, 'expected the throwError definition');
        var endIdx = src.indexOf('responseHeaders = res.stream.sentHeader', fnIdx);
        assert.ok(endIdx > fnIdx, 'expected the header-snapshot block as end anchor');
        var blk = src.substring(fnIdx, endIdx);

        assert.match(
            blk,
            /if \( !res \) \{\s*res = local\.res;/,
            'expected the defensive `res = local.res` fallback before the released-response guard'
        );
        var warnIdx   = blk.indexOf('throwError() called after the response was released');
        var typeofIdx = blk.indexOf("typeof(res.getHeaders) == 'undefined'");
        assert.ok(warnIdx > -1, 'expected the late-error warn (the swallowed error must stay observable)');
        assert.ok(typeofIdx > -1, 'expected the getHeaders feature-test in the snapshot block');
        assert.ok(warnIdx < typeofIdx, 'the released-response guard must precede the getHeaders read');
        assert.match(
            blk.substring(warnIdx, warnIdx + 320),
            /return false;/,
            'the late call must return false (same contract as the renderingStack guard)'
        );
    });

    // ---- pure logic: replica of the normalized snapshot tail ----

    // Mirrors throwError after argument normalization (`res` already holds
    // local.res for every 1-/2-arg shape): fixed tail = fallback + guard +
    // snapshot; pre-fix tail = snapshot only.
    function fixedSnapshotTail(localRes) {
        var local = { res: localRes };
        var res   = local.res;
        if ( !res ) { res = local.res; }
        if ( !res ) { return false; }
        if ( typeof(res.getHeaders) == 'undefined' && typeof(res.stream) != 'undefined' ) {
            return res.stream.sentHeader;
        }
        return res.getHeaders() || local.res.getHeaders();
    }
    function preFixSnapshotTail(localRes) {
        var local = { res: localRes };
        var res   = local.res;
        if ( typeof(res.getHeaders) == 'undefined' && typeof(res.stream) != 'undefined' ) {
            return res.stream.sentHeader;
        }
        return res.getHeaders() || local.res.getHeaders();
    }

    it('released response: the fixed tail returns false and does not throw', function() {
        assert.strictEqual(fixedSnapshotTail(null), false);
    });

    it('live response: the fixed tail still snapshots headers (behaviour unchanged)', function() {
        var headers = { 'content-type': 'text/html' };
        var live = { getHeaders: function() { return headers; } };
        assert.deepStrictEqual(fixedSnapshotTail(live), headers);
    });

    it('subtract: the pre-fix tail throws the exact field TypeError on a released response', function() {
        assert.throws(function() {
            preFixSnapshotTail(null);
        }, function(err) {
            return err instanceof TypeError
                && /Cannot read properties of null \(reading 'getHeaders'\)/.test(err.message);
        }, 'the unguarded snapshot must reproduce the field crash');
    });

    // ---- pure logic: replica of headersSent ----

    function headersSentReplica(_res) {
        if ( !_res ) {
            return true;
        }
        if (
            typeof(_res.stream) != 'undefined'
            && typeof(_res.stream.headersSent) != 'undefined'
            && _res.stream.headersSent === true
        ) {
            return true;
        }
        if ( typeof(_res.headersSent) != 'undefined' ) {
            return _res.headersSent;
        }
        return false;
    }

    it('headersSent reports true on a released response (nothing left to write)', function() {
        assert.strictEqual(headersSentReplica(null), true);
        assert.strictEqual(headersSentReplica(undefined), true);
    });

    it('headersSent still honours a live response (behaviour unchanged)', function() {
        assert.strictEqual(headersSentReplica({ headersSent: false }), false);
        assert.strictEqual(headersSentReplica({ headersSent: true }), true);
        assert.strictEqual(headersSentReplica({ stream: { headersSent: true } }), true);
        assert.strictEqual(headersSentReplica({}), false);
    });

    it('subtract: the pre-fix headersSent shape throws reading `stream` on a released response', function() {
        function preFixHeadersSent(_res) {
            if ( typeof(_res.stream) != 'undefined' && _res.stream.headersSent === true ) {
                return true;
            }
            if ( typeof(_res.headersSent) != 'undefined' ) {
                return _res.headersSent;
            }
            return false;
        }
        assert.throws(function() {
            preFixHeadersSent(null);
        }, function(err) {
            return err instanceof TypeError
                && /Cannot read properties of null \(reading 'stream'\)/.test(err.message);
        }, 'the unguarded headersSent must reproduce the second-crash shape');
    });
});

describe('23 - query retry/response handlers on a released response (#B33)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ---- source structure ----

    // The negative pin is scoped to the two fixed function bodies — other functions
    // (redirect, isPopinContext, the render-path authority composition, the bundle-status
    // forwards) deliberately retain unguarded reads: they run on the live request
    // lifecycle, are NOT on the measured query/retry path, and are tracked as a
    // measure-first follow-up in the #B33 ledger entry. Do not widen this pin to the
    // whole file without measuring those sites first.
    it('query() and handleHTTP2ClientRequest carry no unguarded local.req.headers forward', function() {
        var qStart  = src.indexOf('this.query = function(options, data, callback)');
        var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
        var h2End   = src.indexOf('var getSession = function()');
        assert.ok(qStart > -1 && h2Start > qStart && h2End > h2Start, 'expected the structural anchors');
        var fixedBlocks = src.slice(qStart, h2End);
        var unguarded = fixedBlocks.match(/(?<!local\.req != null && )typeof\(local\.req\.headers\[/g) || [];
        assert.strictEqual(unguarded.length, 0,
            'every local.req.headers forward in query()/handleHTTP2ClientRequest must carry `local.req != null && `');
        var guarded = fixedBlocks.match(/local\.req != null && typeof\(local\.req\.headers\[/g) || [];
        assert.ok(guarded.length >= 7,
            'expected at least the 7 guarded forwards (5 in handleHTTP2ClientRequest + 2 in query)');
    });

    it('getSession returns null on a released request before any session deref', function() {
        assert.match(src,
            /var getSession = function\(\) \{[\s\S]{0,400}?if \( local\.req == null \) \{\s*return null;/,
            'getSession must early-return null when local.req was released');
    });

    it('the 3xx redirect intercept skips a released response (one intercept since the #B475 cleanup removed the emitter-mode twin)', function() {
        var count = src.split("local.res != null && data.status && /^3/.test(data.status)").length - 1;
        assert.strictEqual(count, 1,
            'the callback-mode 3xx intercept — the only one left — must be local.res-guarded');
    });

    // ---- pure-logic replicas (mirror the shipped guard shapes) ----

    function forwardReplica(req, options) {
        if ( req != null && typeof(req.headers['x-requested-with']) != 'undefined' ) {
            options.headers['x-requested-with'] = req.headers['x-requested-with'];
        }
        return options;
    }

    it('forward replica: released request skips the forward without throwing', function() {
        var options = { headers: {} };
        assert.doesNotThrow(function() { forwardReplica(null, options); });
        assert.strictEqual(typeof options.headers['x-requested-with'], 'undefined');
    });

    it('forward replica: live request still forwards (behaviour unchanged)', function() {
        var options = { headers: {} };
        forwardReplica({ headers: { 'x-requested-with': 'XMLHttpRequest' } }, options);
        assert.strictEqual(options.headers['x-requested-with'], 'XMLHttpRequest');
    });

    it('subtract: the pre-fix forward shape throws reading `headers` on a released request', function() {
        function preFixForward(req, options) {
            if ( typeof(req.headers['x-requested-with']) != 'undefined' ) {
                options.headers['x-requested-with'] = req.headers['x-requested-with'];
            }
        }
        assert.throws(function() {
            preFixForward(null, { headers: {} });
        }, function(err) {
            return err instanceof TypeError
                && /Cannot read properties of null \(reading 'headers'\)/.test(err.message);
        }, 'the unguarded forward must reproduce the retry-re-entry crash shape');
    });

    function getSessionReplica(req) {
        var session = null;
        if ( req == null ) {
            return null;
        }
        if ( typeof(req.session) != 'undefined') {
            session = req.session;
        }
        return session;
    }

    it('getSession replica: released request yields null; live request yields the session', function() {
        assert.strictEqual(getSessionReplica(null), null);
        var sess = { id: 'x1' };
        assert.strictEqual(getSessionReplica({ session: sess }), sess);
        assert.strictEqual(getSessionReplica({}), null);
    });

    it('subtract: the pre-fix getSession shape throws reading `session` on a released request', function() {
        function preFixGetSession(req) {
            var session = null;
            if ( typeof(req.session) != 'undefined') {
                session = req.session;
            }
            return session;
        }
        assert.throws(function() {
            preFixGetSession(null);
        }, function(err) {
            return err instanceof TypeError
                && /Cannot read properties of null \(reading 'session'\)/.test(err.message);
        }, 'the unguarded getSession must reproduce the isHaltedRequest crash shape');
    });

    function interceptReplica(res, data) {
        if (res != null && data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
            res.writeHead(data.status, data.headers);
            res.end();
            return 'intercepted';
        }
        return 'fell-through';
    }

    it('intercept replica: released response falls through instead of writing', function() {
        assert.strictEqual(
            interceptReplica(null, { status: 301, headers: { location: '/x' } }),
            'fell-through');
    });

    it('intercept replica: live response still intercepts the 3xx (behaviour unchanged)', function() {
        var wrote = [];
        var res = {
            writeHead: function(s, h) { wrote.push([s, h]); },
            end: function() { wrote.push('end'); }
        };
        assert.strictEqual(
            interceptReplica(res, { status: 301, headers: { location: '/x' } }),
            'intercepted');
        assert.strictEqual(wrote.length, 2);
        assert.strictEqual(wrote[0][0], 301);
    });

    it('subtract: the pre-fix intercept shape throws reading `writeHead` on a released response', function() {
        function preFixIntercept(res, data) {
            if (data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
                res.writeHead(data.status, data.headers);
                return res.end();
            }
        }
        assert.throws(function() {
            preFixIntercept(null, { status: 301, headers: { location: '/x' } });
        }, function(err) {
            return err instanceof TypeError
                && /Cannot read properties of null \(reading 'writeHead'\)/.test(err.message);
        }, 'the unguarded intercept must reproduce the emitter-mode crash shape');
    });
});

describe('24 - query: exhausted 502 retries surface a BAD_GATEWAY error, not success (#B34)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ---- source structure ----

    it('the exhausted-502 branch sits right after the 502 retry guard', function() {
        var retryGuard = src.indexOf('if (httpStatus === 502 && retryCount < HTTP2_MAX_RETRIES');
        var exhausted  = src.indexOf('} else if (httpStatus === 502) {');
        assert.ok(retryGuard > -1, 'the 502 retry guard must exist');
        assert.ok(exhausted > retryGuard,
            'the exhausted-502 else-if must follow the retry guard (so it only fires when retries are spent)');
    });

    it('the exhausted-502 branch builds a GinaHttp2Error with code BAD_GATEWAY and status 502', function() {
        var exhausted = src.indexOf('} else if (httpStatus === 502) {');
        var blk = src.slice(exhausted, src.indexOf('// 3. Exception filter', exhausted));
        assert.match(blk, /new GinaHttp2Error\(/, 'must construct a typed error');
        assert.match(blk, /code\s*:\s*'BAD_GATEWAY'/, 'code must be BAD_GATEWAY');
        assert.match(blk, /status\s*:\s*502/, 'status must be 502 (truthful upstream status)');
        assert.match(blk, /retryable\s*:\s*false/, 'exhausted error is not retryable');
    });

    it('the exhausted-502 branch dispatches through the callback — the per-call channel; its emitter arm is gone (#B475 cleanup)', function() {
        var exhausted = src.indexOf('} else if (httpStatus === 502) {');
        var blk = src.slice(exhausted, src.indexOf('// 3. Exception filter', exhausted));
        assert.match(blk, /if \(_swallowIfNonCritical\(_badGatewayErr\)\) return;/,
            'must respect the non-critical swallow, like the sibling exhaustion paths');
        assert.match(blk, /_ownAsyncCbRejection\(callback\(_badGatewayErr\)\)/, 'the callback surfaces the error to the caller, rejection-owned');
        // #B475 cleanup — query() always supplies a callback, so the block has no
        // emitter arm left (line-comment-stripped so a prose mention cannot trip it)
        var live = blk.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
        assert.equal(live.indexOf("self.emit('query#complete'"), -1, 'no emitter arm in the exhausted-502 block');
    });

    // ---- pure-logic replica (mirrors the onEnd 502 decision: retry guard, the new
    //      exhausted-502 branch, then the legacy fall-through success path) ----

    function onEnd502Replica(httpStatus, retryCount, MAX, body, mode) {
        // mode: 'fixed' (the current code: post-#B34, post-#P47 F6) | 'prefix' (pre-#B34:
        // no exhausted-502 branch, and the status-200 stamp that #P47 F6 removed)
        var out = { dispatch: null, payload: null };
        function callback(err, d) {
            out.dispatch = (err === false || err == null) ? 'success' : 'error';
            out.payload  = (err === false || err == null) ? d : err;
        }
        // shared retry guard
        if (httpStatus === 502 && retryCount < MAX) {
            out.dispatch = 'retry';
            return out;
        }
        // #B34 exhausted-502 branch (fixed only)
        if (mode === 'fixed' && httpStatus === 502) {
            callback({ code: 'BAD_GATEWAY', status: 502, retryable: false, retryCount: retryCount });
            return out;
        }
        // legacy fall-through (success path) — a JSON-shaped body is parsed; only the
        // older code (`prefix`) stamped `.status` 200 onto a body without one
        var data = body;
        if (typeof data === 'string' && /^(\{|%7B|\[{)|\[\]/.test(data)) {
            data = JSON.parse(data);
            if (mode === 'prefix' && typeof data.status === 'undefined') data.status = 200;
        }
        if (data && typeof data === 'object' && data.status && !/^2/.test(data.status)) {
            callback(data);            // genuine non-2xx in the body
        } else {
            callback(false, data);     // success
        }
        return out;
    }

    var JSON_502 = '{"error":"bad gateway"}';   // JSON-shaped, no `.status`
    var HTML_502 = '<html><head><title>502 Bad Gateway</title></head></html>';

    it('fixed: exhausted 502 (JSON body) surfaces an error with status 502 / BAD_GATEWAY', function() {
        var r = onEnd502Replica(502, 2, 2, JSON_502, 'fixed');
        assert.strictEqual(r.dispatch, 'error');
        assert.strictEqual(r.payload.status, 502);
        assert.strictEqual(r.payload.code, 'BAD_GATEWAY');
    });

    it('fixed: exhausted 502 (HTML body) surfaces an error with status 502', function() {
        var r = onEnd502Replica(502, 2, 2, HTML_502, 'fixed');
        assert.strictEqual(r.dispatch, 'error');
        assert.strictEqual(r.payload.status, 502);
    });

    it('fixed: a 502 with retries remaining still routes to retry (unchanged)', function() {
        var r = onEnd502Replica(502, 0, 2, JSON_502, 'fixed');
        assert.strictEqual(r.dispatch, 'retry');
    });

    it('fixed: a genuine 200 JSON body without status succeeds and is delivered without a status (#P47 F6)', function() {
        var r = onEnd502Replica(200, 0, 2, '{"ok":1}', 'fixed');
        assert.strictEqual(r.dispatch, 'success');
        assert.strictEqual(r.payload.status, undefined); // no status is added (#P47 F6)
        assert.strictEqual(r.payload.ok, 1);
    });

    it('subtract: pre-fix exhausted 502 (JSON body) was reported as SUCCESS with status forced to 200', function() {
        var r = onEnd502Replica(502, 2, 2, JSON_502, 'prefix');
        assert.strictEqual(r.dispatch, 'success', 'reproduces the defect: 502 surfaced as success');
        assert.strictEqual(r.payload.status, 200, 'the 502 body had status forced to 200');
    });

    it('subtract: pre-fix exhausted 502 (HTML body) was reported as SUCCESS carrying the 502 page', function() {
        var r = onEnd502Replica(502, 2, 2, HTML_502, 'prefix');
        assert.strictEqual(r.dispatch, 'success', 'reproduces the defect: 502 HTML surfaced as success');
        assert.strictEqual(r.payload, HTML_502, 'the caller received the raw 502 error page as "data"');
    });
});

describe('25 - released-response guards on synchronous controller APIs (#B35)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // Scope note: these are the 5 directly-callable SYNCHRONOUS controller APIs measured
    // (via a standalone harness: createTestInstance → renderTEXT() releases the triplet →
    // call) to throw an uncaughtException → SIGTERM bundle kill on a released request — the
    // same lethal class as #B31/#B33. The §23 comment lists isPopinContext among the
    // "deliberately unguarded" siblings; that predates this fix — isPopinContext is now
    // guarded here. The remaining siblings (redirect second-call, the async store /
    // downloadFromURL — which fail as a non-fatal unhandledRejection — and the render-path
    // inner functions setResources / getNodeRes) stay a documented measure-first follow-up.

    // ---- source structure: each guard sits at the top of its function, before the deref ----
    var GUARDED = [
        { name: 'isPopinContext',         sig: 'this.isPopinContext = function() {',                   ret: 'return false;',                    deref: "local.req.headers['x-gina-popin-id']" },
        { name: 'setRequestMethod',       sig: 'this.setRequestMethod = function(requestMethod, conf) {', ret: 'return null;',                  deref: 'local.req.method' },
        { name: 'setRequestMethodParams', sig: 'this.setRequestMethodParams = function(params) {',      ret: 'return;',                          deref: 'local.req[local.req.method' },
        { name: 'getRequestMethodParams', sig: 'this.getRequestMethodParams = function() {',            ret: 'return localRequestMethodParams;', deref: 'local.req[local.req.method' },
        { name: 'getFormsRules',          sig: 'this.getFormsRules = function () {',                    ret: 'return {};',                       deref: 'local.req.ginaHeaders' }
    ];

    GUARDED.forEach(function(g) {
        it(g.name + ' guards a released request before dereferencing local.req', function() {
            var start = src.indexOf(g.sig);
            assert.ok(start > -1, 'function ' + g.name + ' must exist');
            var body = src.slice(start, start + 700);
            var guardIdx = body.indexOf('if ( local.req == null )');
            var derefIdx = body.indexOf(g.deref);
            assert.ok(guardIdx > -1, g.name + ' must carry a `if ( local.req == null )` guard');
            assert.ok(derefIdx > -1, g.name + ' must still contain its local.req deref');
            assert.ok(guardIdx < derefIdx, g.name + ' guard must precede the local.req deref');
            var guardBlock = body.slice(guardIdx, derefIdx);
            assert.ok(guardBlock.indexOf(g.ret) > -1, g.name + ' guard must `' + g.ret + '` on a released request');
        });
    });

    // ---- pure-logic replicas (mirror each guard shape) ----

    function guardedReplica(req, derefFn, safeDefault) {
        if (req == null) return safeDefault;   // #B35 guard
        return derefFn(req);
    }

    it('replica: each guard returns its safe default on a released request, the real value when live', function() {
        // isPopinContext → false / real boolean
        var popin = function(r) { return typeof r.headers['x-gina-popin-id'] != 'undefined'; };
        assert.strictEqual(guardedReplica(null, popin, false), false);
        assert.strictEqual(guardedReplica({ headers: { 'x-gina-popin-id': '1' } }, popin, false), true);
        // getRequestMethodParams → cached value (here null) / real params
        var params = function(r) { return r[r.method.toLowerCase()]; };
        assert.strictEqual(guardedReplica(null, params, null), null);
        assert.deepStrictEqual(guardedReplica({ method: 'GET', get: { a: 1 } }, params, null), { a: 1 });
        // getFormsRules → {} / real ginaHeaders
        var forms = function(r) { return r.ginaHeaders; };
        assert.deepStrictEqual(guardedReplica(null, forms, {}), {});
        assert.deepStrictEqual(guardedReplica({ ginaHeaders: { form: { id: 'f' } } }, forms, {}), { form: { id: 'f' } });
    });

    it('subtract: the pre-fix unguarded reads throw the released-response TypeError', function() {
        assert.throws(function() { var r = null; return r.headers['x']; },
            /Cannot read properties of null \(reading 'headers'\)/);
        assert.throws(function() { var r = null; return r.method; },
            /Cannot read properties of null \(reading 'method'\)/);
        assert.throws(function() { var r = null; return r.ginaHeaders; },
            /Cannot read properties of null \(reading 'ginaHeaders'\)/);
        assert.throws(function() { var r = null; r.method = 'GET'; },
            /Cannot set properties of null \(setting 'method'\)/);
    });
});

describe('26 - released-response guard on redirect() (#B37)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // redirect() is SYNCHRONOUS and reads local.req/local.res throughout (the proxy block,
    // the originalMethod/method reads). A terminal exit (a prior redirect, or a render-error
    // path) nulls the triplet, so a second redirect on the released instance crashed the
    // bundle (uncaughtException → SIGTERM). Measured (standalone harness, getContext('gina')
    // .config.getRouting mocked): CONTROL (live) redirected, RELEASE (after renderTEXT) threw
    // `reading 'originalMethod'`. Fixed with a top-of-function guard.

    it('redirect() guards a released request at the top, before getConfig/getRouting', function() {
        var start = src.indexOf('this.redirect = async function(req, res, next) {');
        assert.ok(start > -1, 'redirect must exist');
        var head = src.slice(start, start + 700);
        var guardIdx = head.indexOf('if ( local.req == null )');
        var confIdx  = head.indexOf('var conf    = self.getConfig()');
        assert.ok(guardIdx > -1, 'redirect must carry a `if ( local.req == null )` guard');
        assert.ok(confIdx > guardIdx, 'guard must precede getConfig()/getRouting() and all local.req reads');
    });

    // ---- pure-logic replica (redirect reads local.req.originalMethod on the released path) ----
    function redirectHead(localReq, mode) {
        if (mode === 'fixed' && localReq == null) return 'no-op (released)';
        var originalMethod = localReq.originalMethod;   // representative crash site
        return 'redirected (' + originalMethod + ')';
    }

    it('replica: released request no-ops; live request proceeds', function() {
        assert.strictEqual(redirectHead(null, 'fixed'), 'no-op (released)');
        assert.strictEqual(redirectHead({ originalMethod: 'GET' }, 'fixed'), 'redirected (GET)');
    });

    it('subtract: the pre-fix redirect head throws reading a property on a released request', function() {
        assert.throws(function() { redirectHead(null, 'prefix'); },
            function(err) {
                return err instanceof TypeError
                    && /Cannot read properties of null \(reading 'originalMethod'\)/.test(err.message);
            },
            'the unguarded redirect head must reproduce the released-response crash');
    });
});

describe('27 - released-response guards on more synchronous controller APIs (#B38)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // Scope note: an exhaustive #B38 sweep of every SYNCHRONOUS controller surface found
    // FIVE more directly-callable / sync-reachable APIs that read the per-request refs
    // unguarded and crash a released request (uncaughtException -> SIGTERM) -- the same
    // lethal class as #B31/#B33/#B35/#B37. Each was runtime-measured (standalone harness:
    // createTestInstance -> renderTEXT() releases the triplet -> call -> positive crash,
    // then no-throw after the guard). The #B37 ledger had claimed the SIGTERM class CLOSED;
    // these were missed -- notably store's inner start() is reached SYNCHRONOUSLY through
    // the documented store(target).onComplete(cb) wrapper (the #B35 probe only tried
    // store('t'), which returns the wrapper WITHOUT calling start). renderStream's guard is
    // pinned in render-stream.test.js. The non-fatal async residuals (downloadFromURL; the
    // render-path inner fns setResources / getNodeRes, only ever called from the async
    // render delegates -> unhandledRejection) stay documented + skipped, mirroring #B36.

    // ---- source structure: each guard sits at the top of its function, before the deref ----
    var GUARDED = [
        { name: 'downloadFromLocal',   sig: 'this.downloadFromLocal = function(filename) {',       guardTok: 'if ( local.res == null )', ret: 'return;',      deref: 'local.res.setHeader' },
        { name: 'store (inner start)', sig: 'var start = function(target, files, cb) {',            guardTok: 'if ( local.req == null )', ret: '_releasedErr', deref: 'local.req.files' },
        { name: 'push',                sig: 'this.push = function(payload, option, callback) {',    guardTok: 'if ( local.req == null )', ret: 'return;',      deref: 'req.method' },
        { name: 'pauseRequest',        sig: 'this.pauseRequest = function(data, requestStorage) {', guardTok: 'if ( local.req == null )', ret: 'return;',      deref: 'req.url' },
        { name: 'resumeRequest',       sig: 'this.resumeRequest = function(requestStorage) {',      guardTok: 'if ( local.req == null )', ret: 'return;',      deref: 'req.session' }
    ];

    GUARDED.forEach(function(g) {
        it(g.name + ' guards a released request before dereferencing the per-request ref', function() {
            var start = src.indexOf(g.sig);
            assert.ok(start > -1, 'function ' + g.name + ' must exist');
            var body = src.slice(start, start + 1100);
            var guardIdx = body.indexOf(g.guardTok);
            var derefIdx = body.indexOf(g.deref);
            assert.ok(guardIdx > -1, g.name + ' must carry a `' + g.guardTok + '` guard');
            assert.ok(derefIdx > -1, g.name + ' must still contain its released-response deref');
            assert.ok(guardIdx < derefIdx, g.name + ' guard must precede the deref');
            var guardBlock = body.slice(guardIdx, derefIdx);
            assert.ok(guardBlock.indexOf(g.ret) > -1, g.name + ' guard must short-circuit (`' + g.ret + '`) on a released request');
        });
    });

    // ---- pure-logic replica (mirror the top-of-fn guard shape) ----
    function guardedReplica(ref, derefFn, safeDefault) {
        if (ref == null) return safeDefault;   // #B38 guard
        return derefFn(ref);
    }

    it('replica: each guard returns its safe default on a released request, the real value when live', function() {
        // downloadFromLocal -> no-op undefined / proceeds when res is live
        var setH = function(res) { res.setHeader('content-type', 'x'); return 'sent'; };
        assert.strictEqual(guardedReplica(null, setH, undefined), undefined);
        assert.strictEqual(guardedReplica({ setHeader: function() {} }, setH, undefined), 'sent');
        // store inner start -> notifies via the error channel (marker) / reads req.files when live
        var readFiles = function(req) { return req.files; };
        assert.strictEqual(guardedReplica(null, readFiles, 'released'), 'released');
        assert.deepStrictEqual(guardedReplica({ files: [1] }, readFiles, 'released'), [1]);
        // push / pauseRequest / resumeRequest -> no-op undefined / read the live request prop
        var readProp = function(req) { return req.method; };
        assert.strictEqual(guardedReplica(null, readProp, undefined), undefined);
        assert.strictEqual(guardedReplica({ method: 'GET' }, readProp, undefined), 'GET');
    });

    it('subtract: the pre-fix unguarded reads reproduce each released-response TypeError', function() {
        assert.throws(function() { var r = null; return r.setHeader; },
            /Cannot read properties of null \(reading 'setHeader'\)/);
        assert.throws(function() { var r = null; return r.files; },
            /Cannot read properties of null \(reading 'files'\)/);
        assert.throws(function() { var r = null; return r.method; },
            /Cannot read properties of null \(reading 'method'\)/);
        assert.throws(function() { var r = null; return r.url; },
            /Cannot read properties of null \(reading 'url'\)/);
        assert.throws(function() { var r = null; return r.session; },
            /Cannot read properties of null \(reading 'session'\)/);
    });
});

// 28 — early released-response guard for throwError's 2-arg/3-arg shapes (#B44)
//
// #B31 (§22) guarded the throwError header-snapshot tail, which catches the
// 1-arg `throwError(err)` shape: there `res` stays the truthy err object until
// it is reassigned to `local.res` at the end of the errorObject build, so the
// snapshot-tail guard sees the null and no-ops. But the 2-arg
// `throwError(code, Error|string)` and 3-arg `throwError(local.res, code, msg)`
// shapes resolve `res` to local.res (null on a released response) BEFORE that
// build — via the 2-arg shift, or by the caller passing the released local.res
// (downloadFromURL's async catch). Those then crash on the earlier derefs:
//   - HTTP/2 bundles → `res.stream` in the protocol branch (the :5440 read);
//   - every bundle   → `res.error` in the errorObject build (the :5475 read,
//     which HTTP/1.1 reaches because the :5440 read short-circuits off-h2).
// Guarding only :5440 (as first proposed) would merely relocate the HTTP/2
// crash to :5475 and do nothing on HTTP/1.1. The fix is an up-front guard,
// before any `res` deref, returning false with the same no-op contract.
// (Measured on the real throwError via the §14 harness: /tmp/b44-probe.js —
// pre-fix all 2-arg/3-arg released shapes crash at :5475 (http/1.1) / :5440
// (http/2.0); post-fix every shape no-ops on both protocols.)
// ─────────────────────────────────────────────────────────────────────────────

describe('28 - throwError early released-response guard on 2-arg/3-arg shapes (#B44)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ---- source structure ----

    it('the #B44 early guard precedes the protocol/stream read and the errorObject build', function() {
        var fnIdx = src.indexOf('this.throwError = function(res, code, msg)');
        assert.ok(fnIdx > -1, 'expected the throwError definition');

        var protocolIdx   = src.indexOf('getResponseProtocol(res)', fnIdx);    // the :5439 call
        var streamIdx     = src.indexOf('test(protocol) && res.stream', fnIdx); // the :5440 read
        var errorBuildIdx = src.indexOf('res.error || res.message', fnIdx);     // the :5475 build
        assert.ok(protocolIdx > fnIdx, 'expected the getResponseProtocol(res) call');
        assert.ok(streamIdx > fnIdx, 'expected the protocol-branch res.stream read');
        assert.ok(errorBuildIdx > fnIdx, 'expected the errorObject res.error build');

        var b44Idx   = src.indexOf('#B44', fnIdx);
        assert.ok(b44Idx > fnIdx, 'expected the #B44 guard comment');
        var guardIdx = src.indexOf('if ( !res ) {', b44Idx);
        var warnIdx  = src.indexOf('throwError() called after the response was released', b44Idx);
        var retIdx   = src.indexOf('return false;', guardIdx);
        assert.ok(guardIdx > b44Idx, 'expected the early `if ( !res )` guard under the #B44 comment');
        assert.ok(warnIdx > guardIdx, 'the early guard warns on the late error');
        assert.ok(retIdx > warnIdx, 'the early guard returns false after warning');

        // the whole guard sits BEFORE every res deref
        assert.ok(guardIdx < protocolIdx,   'guard must precede getResponseProtocol(res)');
        assert.ok(retIdx   < protocolIdx,   'guard must return before getResponseProtocol(res)');
        assert.ok(guardIdx < streamIdx,     'guard must precede the :5440 res.stream read');
        assert.ok(guardIdx < errorBuildIdx, 'guard must precede the :5475 res.error build');
    });

    it('the #B31 snapshot-tail guard is left intact (1-arg shape still covered there)', function() {
        // §22 covers the snapshot-tail guard; assert #B44 did not remove it.
        assert.match(src, /if \( !res \) \{\s*res = local\.res;/,
            'the #B31 `if ( !res ) { res = local.res; }` fallback must remain');
    });

    // ---- pure logic: replica of the throwError prologue (shift → guard → derefs) ----

    // Mirrors throwError from the 2-arg shift through the first `res` derefs:
    // the protocol-branch read (:5440 res.stream) and the errorObject build
    // (:5475 res.error). `protocol` is the value getResponseProtocol returns on
    // a released response — the configured bundle protocol (local.req is null).
    function prologue(args, localRes, protocol, withGuard) {
        var res = args[0], code = args[1], msg = args[2];
        // 2-arg shift (statusCode, Error|string)
        if ( typeof(res) == 'number' && args.length === 2 &&
             (args[1] instanceof Error || typeof(args[1]) == 'string') ) {
            msg = args[1]; code = res; res = localRes;
        }
        if ( withGuard && !res ) { return false; }                                   // #B44 early guard
        var stream = ( /http\/2/.test(protocol) && res.stream ) ? res.stream : null; // :5440
        var errorObject = { status: code, error: res.error || res.message || 'def' };// :5475
        return errorObject;
    }

    // For 2-arg shapes `res` comes from the shift (= localRes); for the 3-arg
    // shape `res` is the first arg, so it must carry the live/released value.
    function argsFor(shape, res) {
        if (shape === '2arg-Error')  return [500, new Error('boom')];
        if (shape === '2arg-string') return [500, 'boom'];
        return [res, 500, new Error('boom')]; // 3arg-Error: res is the first arg (downloadFromURL passes local.res)
    }
    var SHAPES    = ['2arg-Error', '2arg-string', '3arg-Error'];
    var PROTOCOLS = ['http/1.1', 'http/2.0'];

    it('released response: the guarded prologue returns false (no throw) for every shape/protocol', function() {
        SHAPES.forEach(function(shape) {
            PROTOCOLS.forEach(function(proto) {
                assert.strictEqual(
                    prologue(argsFor(shape, null), null, proto, true), false,
                    shape + ' (' + proto + ') released must no-op'
                );
            });
        });
    });

    it('live response: the guarded prologue still builds the errorObject (behaviour unchanged)', function() {
        var live = {}; // a live response object: no .stream / .error / .message
        SHAPES.forEach(function(shape) {
            PROTOCOLS.forEach(function(proto) {
                var out = prologue(argsFor(shape, live), live, proto, true);
                assert.ok(out && out.status === 500,
                    shape + ' (' + proto + ') live must still build the errorObject');
            });
        });
    });

    it('subtract: the unguarded prologue throws the exact field TypeError per protocol', function() {
        // HTTP/2 → the :5440 res.stream read fires first
        assert.throws(function() { prologue([500, new Error('x')], null, 'http/2.0', false); },
            /Cannot read properties of null \(reading 'stream'\)/,
            '2-arg on http/2.0 must crash at the res.stream read');
        // HTTP/1.1 → :5440 short-circuits off-h2, so the :5475 res.error read fires
        assert.throws(function() { prologue([500, new Error('x')], null, 'http/1.1', false); },
            /Cannot read properties of null \(reading 'error'\)/,
            '2-arg on http/1.1 must crash at the res.error build');
        // 3-arg released (passed null res) — same two sites
        assert.throws(function() { prologue([null, 500, new Error('x')], null, 'http/2.0', false); },
            /Cannot read properties of null \(reading 'stream'\)/,
            '3-arg on http/2.0 must crash at the res.stream read');
        assert.throws(function() { prologue([null, 500, new Error('x')], null, 'http/1.1', false); },
            /Cannot read properties of null \(reading 'error'\)/,
            '3-arg on http/1.1 must crash at the res.error build');
    });
});

describe('29 - query: settled HTTP/2 stream released at every non-retry terminal (#B52)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ---- source structure ----

    // #B613 (2026-09-24) — the helper used to end with a guarded `req.close()`. At the
    // `end` terminal `req.closed` is still false, so that close() put an RST_STREAM(NO_ERROR)
    // on the wire after EVERY completed response and nghttp2's own reset rate limit on the
    // target (1,000 burst, 33/s) GOAWAY'd the cached session with INTERNAL_ERROR after
    // ~1,000 calls. The release is the timeout cancel + the listener drop — a settled
    // stream closes itself within milliseconds (measured) — so the pins below assert the
    // two ops AND the ABSENCE of a live close() inside the helper. The helper's raw text
    // keeps the retired line as a `// replaced:` comment, so the absence is asserted on the
    // comment-stripped source with the raw text as the control that the strip is real.
    function stripLineComments(text) {
        return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }

    it('the #B52 _finalizeStream helper is defined inside _sendRequest with an idempotency guard + the two release ops, in order — and no close() (#B613)', function() {
        var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
        assert.ok(h2Start > -1, 'expected the handleHTTP2ClientRequest anchor');
        var helperIdx = src.indexOf('var _finalizeStream = function _finalizeStream()', h2Start);
        assert.ok(helperIdx > h2Start, 'expected the _finalizeStream helper inside handleHTTP2ClientRequest');

        var guardIdx   = src.indexOf('if (_finalized) { return; }', helperIdx);
        var flagIdx    = src.indexOf('_finalized = true;', guardIdx);
        var timeoutIdx = src.indexOf('req.setTimeout(0)', flagIdx);
        var listenIdx  = src.indexOf('req.removeAllListeners()', timeoutIdx);
        var endIdx     = src.indexOf('};', listenIdx);
        assert.ok(guardIdx   > helperIdx,  'helper early-returns when already finalized');
        assert.ok(flagIdx    > guardIdx,   'helper sets the _finalized flag before the release ops');
        assert.ok(timeoutIdx > flagIdx,    'helper cancels the stream timeout via setTimeout(0)');
        assert.ok(listenIdx  > timeoutIdx, 'helper removes the stream listeners');
        assert.ok(endIdx     > listenIdx,  'the helper body ends after the listener drop');

        var liveBody = stripLineComments(src.slice(helperIdx, endIdx));
        assert.equal(liveBody.indexOf('req.close('), -1,
            '#B613: no live req.close() inside the helper — it sent an RST_STREAM after every completed response');
        assert.ok(src.slice(helperIdx - 1200, endIdx).indexOf('req.close()') > -1,
            'control: the retired close() survives as a `// replaced:` comment above the helper, so the strip above is a real strip');
    });

    it('the helper releases defensively — each remaining op in try/catch', function() {
        var helperIdx = src.indexOf('var _finalizeStream = function _finalizeStream()');
        var body = src.slice(helperIdx, helperIdx + 400);
        assert.match(body, /try \{ req\.setTimeout\(0\); \} catch/,        'setTimeout(0) is try/caught');
        assert.match(body, /try \{ req\.removeAllListeners\(\); \} catch/, 'removeAllListeners() is try/caught');
    });

    it('_finalizeStream() is invoked at exactly the five non-retry terminals', function() {
        var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
        var h2End   = src.indexOf('var getSession = function()');
        assert.ok(h2Start > -1 && h2End > h2Start, 'expected the handleHTTP2ClientRequest structural bounds');
        var block = src.slice(h2Start, h2End);
        var calls = block.match(/_finalizeStream\(\);/g) || [];
        assert.strictEqual(calls.length, 5,
            'expected exactly 5 _finalizeStream() calls (timeout-exhausted / stream-error / premature-close / 502-exhausted / onEnd-success terminals)');
    });

    // The four TYPED-error terminals finalize the stream right before the
    // non-critical swallow, so cleanup happens on BOTH the swallow-return and the
    // callback/emit path. The 5th call is the onEnd success terminal, placed ahead
    // of the ALPN/parse path (no swallow follows it). The retry branches do NOT
    // finalize — they client.destroy() the whole session, tearing the stream down.
    // The two pre-flight PING swallow sites have no request stream yet, so they
    // correctly do not finalize. (That is why this pins the finalize->swallow
    // ORDERING count, not a raw swallow count: there are 7 _swallowIfNonCritical
    // tokens in the block — 1 comment + 4 terminals + 2 pre-flight.)
    it('each typed-error terminal finalizes the stream BEFORE its non-critical swallow', function() {
        var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
        var h2End   = src.indexOf('var getSession = function()');
        var block   = src.slice(h2Start, h2End);
        var ordered = block.match(/_finalizeStream\(\);[\s\S]{0,160}?_swallowIfNonCritical\(/g) || [];
        assert.strictEqual(ordered.length, 4,
            'all four typed-error terminals must finalize before the swallow (timeout / stream-error / premature-close / 502-exhausted)');
    });

    // ---- pure logic: idempotent, never-throwing finalize replica ----

    // Mirrors _finalizeStream: a one-shot release of a settled HTTP/2 stream —
    // timeout cancel + listener drop, and (since #B613) no close().
    function makeFinalizer(req) {
        var finalized = false;
        return function finalize() {
            if (finalized) { return; }
            finalized = true;
            try { req.setTimeout(0); } catch (e) {}
            try { req.removeAllListeners(); } catch (e) {}
        };
    }

    function makeReqSpy(state) {
        state = state || {};
        return {
            closed: !!state.closed,
            destroyed: !!state.destroyed,
            _timeout: null,
            _listenersCleared: 0,
            _closed: 0,
            setTimeout: function(ms) { this._timeout = ms; },
            removeAllListeners: function() { this._listenersCleared++; },
            close: function() { this._closed++; this.closed = true; }
        };
    }

    it('finalize replica: releases the stream once (cancels timeout, clears listeners) and never closes it (#B613)', function() {
        var req = makeReqSpy();
        makeFinalizer(req)();
        assert.strictEqual(req._timeout, 0,           'stream timeout cancelled via setTimeout(0)');
        assert.strictEqual(req._listenersCleared, 1,  'listeners removed once');
        assert.strictEqual(req._closed, 0,            '#B613: no close() — a close() at the end terminal sent an RST_STREAM the target counted as a rapid reset');
    });

    it('finalize replica: repeated invocations are a no-op (the _finalized idempotency guard)', function() {
        var req = makeReqSpy();
        var finalize = makeFinalizer(req);
        finalize(); finalize(); finalize();
        assert.strictEqual(req._listenersCleared, 1, 'listeners removed exactly once across repeated calls');
        assert.strictEqual(req._closed, 0,           'still no close() across repeated calls');
    });

    it('finalize replica: never throws even if a release op throws (cleanup must not break the response path)', function() {
        var req = makeReqSpy();
        req.removeAllListeners = function() { throw new Error('stream already torn down'); };
        assert.doesNotThrow(function() { makeFinalizer(req)(); });
        assert.strictEqual(req._timeout, 0, 'the timeout op ran before the throwing listener drop');
    });

    // ---- subtract: finalize at the terminal is what releases the stranding listeners ----

    // A non-retry terminal surfaces the typed error to the caller, optionally
    // finalizing the stream first (#B52). Without the finalize, the stream keeps
    // its listeners (onQueryError/onQueryClosed/onEnd capture `callback` -> `self`),
    // stranding the per-request controller + its router.js options.conf clone.
    function terminalReplica(req, finalize, callback) {
        var err = { code: 'TIMEOUT', status: 503 };
        if (finalize) { finalize(); }
        callback(err);
    }

    it('subtract: finalizing at the terminal releases the stream listeners; omitting it (pre-fix) retains them', function() {
        var reqA = makeReqSpy(), cbA = [];
        terminalReplica(reqA, makeFinalizer(reqA), function(e) { cbA.push(e); });
        assert.strictEqual(reqA._listenersCleared, 1, 'finalized terminal releases the stream listeners');
        assert.strictEqual(cbA.length, 1,             'the error still reaches the caller');

        var reqB = makeReqSpy(), cbB = [];
        terminalReplica(reqB, null, function(e) { cbB.push(e); });
        assert.strictEqual(reqB._listenersCleared, 0, 'pre-fix: listeners stay attached, stranding the controller + conf clone');
        assert.strictEqual(cbB.length, 1,             'pre-fix still delivered the error (the retention is silent)');
    });
});


// ─── #B65 caller-side X-Forwarded-Host forward: per-request slot, not the latch ──
// query() forwards the proxied host on an internal cross-bundle call. #B65 keys
// the forward on THIS request's per-request slot (request._ginaIsProxyHost /
// _ginaProxyHost) instead of the sticky worker-global latch + frozen global, so
// the internal call carries the host the triggering request actually arrived
// with — and falls back to the worker-global for req-less callers (released-
// response / ws-query paths).
describe('30 - #B65 caller-side X-Forwarded-Host forward source structure', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it("query() derives isProxyHost from the per-request slot first, then the global", function() {
        assert.ok(
            src.indexOf("( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false )") > -1,
            'expected the per-request-slot-preferred isProxyHost derivation in query()'
        );
    });

    it("forwards THIS request's proxied host (slot) with the worker-global as fallback", function() {
        assert.ok(
            src.indexOf("( local.req && local.req._ginaProxyHost ) ? local.req._ginaProxyHost : process.gina.PROXY_HOST") > -1,
            'expected the X-Forwarded-Host forward to prefer local.req._ginaProxyHost, falling back to process.gina.PROXY_HOST'
        );
    });

    it("keeps the worker-global fallbacks present (back-compat for req-less callers)", function() {
        // The forward block must retain getContext('isProxyHost') and
        // process.gina.PROXY_HOST as fallbacks — a req-less caller (released
        // response / ws-query, local.req null) still forwards the global value.
        var anchor = src.indexOf("options.headers['x-forwarded-host']");
        assert.ok(anchor > -1, 'x-forwarded-host forward site not found');
        var block = src.slice(anchor - 200, anchor + 200);
        assert.ok(block.indexOf('process.gina.PROXY_HOST') > -1,
            'the worker-global fallback must remain for req-less callers');
    });

});

describe('30b - #B65 caller-side forward decision: pure-logic replica', function() {

    // Pure-logic replica of the #B65 forward decision (controller.js query()):
    // prefer the per-request slot; fall back to the worker-global; forward only
    // when this request is proxied.
    function forwardDecision(localReq, globalIsProxy, globalProxyHost) {
        var isProxyHost = ( localReq && typeof(localReq._ginaIsProxyHost) != 'undefined' )
            ? localReq._ginaIsProxyHost
            : ( globalIsProxy || false );
        var headers = {};
        if (isProxyHost) {
            headers['x-forwarded-host'] = ( localReq && localReq._ginaProxyHost )
                ? localReq._ginaProxyHost
                : globalProxyHost;
        }
        return headers;
    }

    it('slot wins over a STALE/frozen worker-global (per-request freeze immunity on the caller side)', function() {
        var h = forwardDecision({ _ginaIsProxyHost: true, _ginaProxyHost: 'publichost' }, true, 'STALE-frozen-host');
        assert.equal(h['x-forwarded-host'], 'publichost',
            'the internal call must carry THIS request slot host, not the stale global');
    });

    it('a raw/direct triggering request (slot=false) forwards NOTHING even if the global latched true', function() {
        var h = forwardDecision({ _ginaIsProxyHost: false }, true, 'publichost');
        assert.equal(h['x-forwarded-host'], undefined,
            'a request that arrived raw must not forward a proxied host from the latched global');
    });

    it('req-less caller (local.req null) falls back to the worker-global (back-compat)', function() {
        var h = forwardDecision(null, true, 'publichost');
        assert.equal(h['x-forwarded-host'], 'publichost');
    });

    it('req-less caller + global not proxied → no forward', function() {
        var h = forwardDecision(null, false, undefined);
        assert.equal(h['x-forwarded-host'], undefined);
    });

    it('proxied slot but slot host missing → falls back to the global host', function() {
        var h = forwardDecision({ _ginaIsProxyHost: true }, true, 'publichost');
        assert.equal(h['x-forwarded-host'], 'publichost');
    });

});

describe('31 - #B66 client-only hostname whisper (proxied → public host-only) source structure', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('computes a client-only _publicHostname defaulting to the internal hostname', function() {
        assert.ok(src.indexOf('var _publicHostname = hostname;') > -1,
            'expected `var _publicHostname = hostname;` (defaults to the internal value)');
    });

    it('overrides _publicHostname with the per-request proxied host-only slot, strict === true', function() {
        assert.ok(
            src.indexOf("if ( local.req && local.req._ginaIsProxyHost === true && local.req._ginaProxyHostname ) {") > -1,
            'expected the strict === true gate on the per-request #B65 slot');
        assert.ok(src.indexOf('_publicHostname = local.req._ginaProxyHostname;') > -1,
            'expected the override to use local.req._ginaProxyHostname (host-only, forwarded scheme)');
    });

    it('whispers _publicHostname (NOT the internal hostname var) into page.environment.hostname', function() {
        assert.ok(src.indexOf("set('page.environment.hostname', _publicHostname);") > -1,
            'expected page.environment.hostname to be set from _publicHostname');
        assert.ok(src.indexOf("set('page.environment.hostname', hostname);") < 0,
            'the old whisper of the internal `hostname` var must be gone');
    });

    it('leaves the internal hostname var unchanged; _proxyHostname is now host-only per #B67 (supersedes the #B66 byte-identical note)', function() {
        // #B67 revisited the #B66 S1 "_proxyHostname byte-identical" decision: the internal
        // `hostname` var (host+webroot) still feeds the per-route routing clone, but
        // envConf._proxyHostname is now the host-only _config.hostname (a hostname must not
        // carry a webroot — see controller.test.js §33 + router.test.js §12).
        assert.ok(src.indexOf('var hostname    = _config.hostname + _config.server.webroot;') > -1,
            'the internal hostname var (feeds the per-route routing clone) must be unchanged');
        assert.ok(src.indexOf('ctx.config.envConf._proxyHostname = (isProxyHost) ? _config.hostname : null;') > -1,
            '_proxyHostname now derives from the host-only _config.hostname (#B67), not the host+webroot hostname var');
    });

    it('_publicHostname is confined to the whisper (declaration + override + set — exactly 3 refs)', function() {
        var n = (src.match(/_publicHostname/g) || []).length;
        assert.equal(n, 3,
            'expected _publicHostname only at its declaration, override, and the set() call — found ' + n);
    });

});

describe('31b - #B66 client-only hostname whisper: pure-logic replica (3-mode)', function() {

    // Pure-logic replica of the #B66 S1 decision (controller.js ~556): whisper the
    // per-request proxied host-only value when this request is proxied; otherwise the
    // bundle's internal hostname. Mirrors the strict === true gate on the #B65 slot.
    function publicHostname(localReq, internalHostname) {
        var out = internalHostname;
        if ( localReq && localReq._ginaIsProxyHost === true && localReq._ginaProxyHostname ) {
            out = localReq._ginaProxyHostname;
        }
        return out;
    }

    var INTERNAL = 'http://internal-a:5101/app/';   // scheme://host:port + webroot (leaks + can't flip the client self-check)

    it('mode 1 multi-hop (proxied, forwarded scheme) → the host-only public origin', function() {
        var h = publicHostname({ _ginaIsProxyHost: true, _ginaProxyHostname: 'https://public.example' }, INTERNAL);
        assert.equal(h, 'https://public.example');
    });

    it('mode 2 single-hop (proxied) → the host-only public origin', function() {
        var h = publicHostname({ _ginaIsProxyHost: true, _ginaProxyHostname: 'http://public.example' }, INTERNAL);
        assert.equal(h, 'http://public.example');
    });

    it('mode 3 RAW (direct host:port, slot false) → the internal value, byte-identical', function() {
        var h = publicHostname({ _ginaIsProxyHost: false }, INTERNAL);
        assert.equal(h, INTERNAL);
    });

    it('req-less / absent slot → the internal value (back-compat)', function() {
        assert.equal(publicHostname(null, INTERNAL), INTERNAL);
        assert.equal(publicHostname({}, INTERNAL), INTERNAL);
    });

    it('strict === true: a truthy-but-non-true slot does NOT flip to the proxied host', function() {
        var h = publicHostname({ _ginaIsProxyHost: 'true', _ginaProxyHostname: 'http://public.example' }, INTERNAL);
        assert.equal(h, INTERNAL, 'only a strict boolean true whispers the proxied host');
    });

    it('SUBTRACT: without the gate, the internal host is always whispered (the leak)', function() {
        function preB66(localReq, internalHostname) { return internalHostname; }
        assert.equal(preB66({ _ginaIsProxyHost: true, _ginaProxyHostname: 'https://public.example' }, INTERNAL), INTERNAL,
            'pre-fix, a proxied request still whispered the internal host — this is the disclosure #B66 closes');
    });

});

// ─── #B66 S2b — server-side serve-time host rewrites: per-request slot, not latch ─
// #B65 request-scoped the reverse-proxy host and un-froze the worker-global, but
// FOUR serve-time host rewrites in controller.js still read the sticky worker-global
// latch: (1) the setOptions routing-clone gate + the page.environment.proxyHost/
// Hostname whisper, (2) getNodeRes' proxied-hostname build, (3) redirect's target
// host, (4) getConfig's hostname/host override. On a mixed proxied+direct worker
// (or a concurrent request to a different public host, or a multi-tenant worker)
// these resolved the LAST-proxied global instead of the request in hand. S2b
// re-points each to THIS request's #B65 slot (local.req._ginaIsProxyHost /
// _ginaProxyHost / _ginaProxyHostname), keeping the worker-global as the MANDATORY
// fallback — the Express engine never sets the slots, and getConfig is reachable
// req-less (ws-query / released-response / async health probe). Left deliberately
// out of scope: the isSpecialCase PROXY_HOST comparisons (cross-bundle-link
// heuristic a stale global can't flip) and query()'s PROXY_SCHEME (boot-static,
// not a per-request freeze). The re-point was also verified live before/after on
// the REAL getConfig via a standalone createTestInstance harness driving the
// actual controller.js through a mixed proxied/direct interleave (2 fails → 5/5).
describe('32 - #B66 S2b server-side serve-time proxy-host rewrites source structure', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('site 1 (setOptions routing-clone) gate reads the per-request slot first', function() {
        assert.ok(
            src.indexOf("var isProxyHost = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false );") > -1,
            'expected the setOptions routing-clone gate to prefer local.req._ginaIsProxyHost'
        );
    });

    it('site 1 whisper (page.environment.proxyHost/Hostname) reads the per-request slot', function() {
        assert.ok(
            src.indexOf("set('page.environment.proxyHost', ( local.req && local.req._ginaProxyHost ) ? local.req._ginaProxyHost : process.gina.PROXY_HOST);") > -1,
            'expected the proxyHost whisper to prefer local.req._ginaProxyHost'
        );
        assert.ok(
            src.indexOf("set('page.environment.proxyHostname', ( local.req && local.req._ginaProxyHostname ) ? local.req._ginaProxyHostname : process.gina.PROXY_HOSTNAME);") > -1,
            'expected the proxyHostname whisper to prefer local.req._ginaProxyHostname'
        );
    });

    it('site 2 (getNodeRes) last-resort host fallback prefers the slot before the global', function() {
        assert.ok(
            src.indexOf("local.req.headers.host||local.req.headers[':host']||local.req._ginaProxyHost||process.gina.PROXY_HOST") > -1,
            'expected getNodeRes to prefer local.req._ginaProxyHost, falling back to process.gina.PROXY_HOST'
        );
    });

    it('site 3 (redirect) freeze-prone catch-all term prefers the slot, keeps the global fallback', function() {
        assert.ok(
            src.indexOf("( ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost === true : typeof(process.gina.PROXY_HOSTNAME) != 'undefined' )") > -1,
            'expected the redirect clause-E to prefer local.req._ginaIsProxyHost === true, falling back to the global existence check'
        );
        assert.ok(
            src.indexOf("? ( ( local.req && local.req._ginaProxyHostname ) ? local.req._ginaProxyHostname : process.gina.PROXY_HOSTNAME )") > -1,
            'expected the redirect target host to prefer local.req._ginaProxyHostname'
        );
    });

    it('site 4 (getConfig) derives isProxyHost + host/hostname from the slot with a global fallback', function() {
        assert.ok(
            src.indexOf("var _isProxyHost   = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false );") > -1,
            'expected getConfig to derive _isProxyHost from the slot first');
        assert.ok(src.indexOf('var _proxyHostname = ( local.req && local.req._ginaProxyHostname )') > -1,
            'expected getConfig to derive _proxyHostname from the slot');
        assert.ok(src.indexOf('var _proxyHost     = ( local.req && local.req._ginaProxyHost )') > -1,
            'expected getConfig to derive _proxyHost from the slot');
        assert.match(src, /tmp\.hostname\s*=\s*_proxyHostname;/,
            'getConfig must assign the per-request _proxyHostname, not the bare global');
        assert.match(src, /tmp\.host\s*=\s*_proxyHost;/,
            'getConfig must assign the per-request _proxyHost, not the bare global');
    });

    it('every re-pointed site retains the worker-global as fallback (Express + req-less back-compat)', function() {
        // The slot-with-fallback shape must keep getContext('isProxyHost') and the
        // process.gina.PROXY_* reads present — Express never sets the slots and
        // getConfig is reachable req-less; both degrade to the never-frozen global.
        assert.ok(src.indexOf("getContext('isProxyHost') || false") > -1,
            'the worker-global isProxyHost fallback must remain');
        assert.ok(src.indexOf('process.gina.PROXY_HOSTNAME') > -1 && src.indexOf('process.gina.PROXY_HOST') > -1,
            'the worker-global host fallbacks must remain');
    });

    it('the isSpecialCase PROXY_HOST comparisons are deliberately LEFT (cross-bundle heuristic, out of scope)', function() {
        // S2b does not touch the two isSpecialCase comparisons — a stale global
        // cannot flip them for a genuine direct call (a direct :host never equals
        // the public proxy host). They stay reading the global by design.
        assert.ok(src.indexOf("local.req.headers[':host'] != process.gina.PROXY_HOST") > -1,
            'the isSpecialCase :host != PROXY_HOST comparison(s) must remain unchanged');
    });

});

describe('32b - #B66 S2b serve-time host resolution: pure-logic replicas', function() {

    // The shared re-point decision (setOptions / getNodeRes / getConfig gate):
    // prefer THIS request's slot; fall back to the never-frozen worker-global.
    function classify(localReq, globalIsProxy) {
        return ( localReq && typeof(localReq._ginaIsProxyHost) != 'undefined' )
            ? localReq._ginaIsProxyHost
            : ( globalIsProxy || false );
    }

    // --- getConfig hostname/host override (site 4) -------------------------------
    function getConfigHost(localReq, globalIsProxy, globalProxyHostname, globalProxyHost, configHostname, configHost) {
        var isProxyHost   = classify(localReq, globalIsProxy);
        var proxyHostname = ( localReq && localReq._ginaProxyHostname ) ? localReq._ginaProxyHostname : globalProxyHostname;
        var proxyHost     = ( localReq && localReq._ginaProxyHost )     ? localReq._ginaProxyHost     : globalProxyHost;
        var out = { hostname: configHostname, host: configHost };
        if ( isProxyHost && typeof(configHostname) != 'undefined' && typeof(proxyHostname) != 'undefined' ) {
            out.hostname = proxyHostname;
            out.host     = proxyHost;
        }
        return out;
    }

    it('getConfig: proxied-to-B request resolves THIS request host B, not the stale global A', function() {
        var r = getConfigHost({ _ginaIsProxyHost: true, _ginaProxyHostname: 'https://public-b.example', _ginaProxyHost: 'public-b.example' },
            true, 'https://public-a.example', 'public-a.example', 'http://internal:5101', 'internal:5101');
        assert.equal(r.hostname, 'https://public-b.example');
        assert.equal(r.host, 'public-b.example');
    });

    it('getConfig: raw/direct request (slot=false) resolves the config host even when the global latched true', function() {
        var r = getConfigHost({ _ginaIsProxyHost: false }, true, 'https://public-a.example', 'public-a.example', 'http://internal:5101', 'internal:5101');
        assert.equal(r.hostname, 'http://internal:5101');
        assert.equal(r.host, 'internal:5101');
    });

    it('getConfig: req-less caller (local.req null) falls back to the worker-global (back-compat)', function() {
        var r = getConfigHost(null, true, 'https://public-a.example', 'public-a.example', 'http://internal:5101', 'internal:5101');
        assert.equal(r.hostname, 'https://public-a.example');
        assert.equal(r.host, 'public-a.example');
    });

    it('getConfig: pure-direct worker (never proxied) resolves the config host', function() {
        var r = getConfigHost({ _ginaIsProxyHost: false }, false, undefined, undefined, 'http://internal:5101', 'internal:5101');
        assert.equal(r.hostname, 'http://internal:5101');
    });

    it('getConfig SUBTRACT: the pre-S2b global read picks up the stale host on a raw request (the leak)', function() {
        function preS2b(globalIsProxy, globalProxyHostname, configHostname) {
            return ( globalIsProxy && typeof(configHostname) != 'undefined' && typeof(globalProxyHostname) != 'undefined' )
                ? globalProxyHostname : configHostname;
        }
        // raw request arrives on a worker whose global latched to public-a — pre-fix
        // getConfig returns the stale proxied host; S2b returns the config host.
        assert.equal(preS2b(true, 'https://public-a.example', 'http://internal:5101'), 'https://public-a.example',
            'pre-S2b, a direct request on a proxied worker leaked the stale global host — this is what S2b closes');
        var fixed = getConfigHost({ _ginaIsProxyHost: false }, true, 'https://public-a.example', 'public-a.example', 'http://internal:5101', 'internal:5101');
        assert.equal(fixed.hostname, 'http://internal:5101');
    });

    // --- redirect clause-E + target host (site 3) -------------------------------
    // isProxyHost = (clauses A-D from THIS request's headers) OR (re-pointed clause E).
    function redirectIsProxyHost(localReq, clausesAtoD, globalHostnameDefined) {
        var clauseE = ( localReq && typeof(localReq._ginaIsProxyHost) != 'undefined' )
            ? localReq._ginaIsProxyHost === true
            : globalHostnameDefined;
        return clausesAtoD || clauseE;
    }
    function redirectHostname(isProxyHost, localReq, globalProxyHostname, configHostname) {
        return isProxyHost
            ? ( ( localReq && localReq._ginaProxyHostname ) ? localReq._ginaProxyHostname : globalProxyHostname )
            : configHostname;
    }

    it('redirect: raw request (slot=false) on a proxied worker is NOT misclassified (clause E no longer fires)', function() {
        assert.equal(redirectIsProxyHost({ _ginaIsProxyHost: false }, false, true), false,
            'a raw request must not inherit "proxied" from the worker-global once slots exist');
    });

    it('redirect: proxied request (slot=true) → proxied, target = THIS request host B not stale A', function() {
        var isP = redirectIsProxyHost({ _ginaIsProxyHost: true }, false, true);
        assert.equal(isP, true);
        assert.equal(redirectHostname(isP, { _ginaIsProxyHost: true, _ginaProxyHostname: 'https://public-b.example' }, 'https://public-a.example', 'http://internal:5101'),
            'https://public-b.example');
    });

    it('redirect: clauses A-D still classify proxied per-request even when the slot is false', function() {
        // The header heuristics (e.g. x-nginx-proxy) are preserved — only clause E moved.
        assert.equal(redirectIsProxyHost({ _ginaIsProxyHost: false }, true, false), true,
            'a header-heuristic match must still classify the request proxied');
    });

    it('redirect: req-less/Express (slot undefined) falls back to the global existence check', function() {
        assert.equal(redirectIsProxyHost(null, false, true), true, 'worker saw a proxy → proxied (back-compat)');
        assert.equal(redirectIsProxyHost(null, false, false), false, 'no proxy ever → not proxied');
        assert.equal(redirectHostname(true, null, 'https://public-a.example', 'http://internal:5101'), 'https://public-a.example',
            'req-less target host falls back to the worker-global');
    });

    it('redirect SUBTRACT: pre-S2b clause E (global existence) misclassifies a raw request on a proxied worker', function() {
        function preS2bClauseE(clausesAtoD, globalHostnameDefined) { return clausesAtoD || globalHostnameDefined; }
        assert.equal(preS2bClauseE(false, true), true,
            'pre-S2b, a raw request was classified proxied merely because the worker had seen a proxy — the freeze/leak');
        assert.equal(redirectIsProxyHost({ _ginaIsProxyHost: false }, false, true), false,
            'S2b classifies it correctly from THIS request');
    });

    // --- getNodeRes last-resort host fallback (site 2) --------------------------
    function getNodeResHost(localReq, globalProxyHost) {
        return localReq.headers.host || localReq.headers[':host'] || localReq._ginaProxyHost || globalProxyHost;
    }

    it('getNodeRes: header host wins; no header + slot → slot; no header + no slot → global', function() {
        assert.equal(getNodeResHost({ headers: { host: 'req-host' }, _ginaProxyHost: 'slot-host' }, 'global-host'), 'req-host');
        assert.equal(getNodeResHost({ headers: {}, _ginaProxyHost: 'slot-host' }, 'global-host'), 'slot-host',
            'no request header → THIS request slot host, not the stale global');
        assert.equal(getNodeResHost({ headers: {} }, 'global-host'), 'global-host', 'req-less-ish → the worker-global fallback');
    });

    // --- setOptions whisper values (site 1) ------------------------------------
    function whisper(localReq, globalProxyHost, globalProxyHostname) {
        var isProxyHost = classify(localReq, false);
        var out = {};
        if ( /^true$/.test(isProxyHost) ) {
            out.proxyHost     = ( localReq && localReq._ginaProxyHost )     ? localReq._ginaProxyHost     : globalProxyHost;
            out.proxyHostname = ( localReq && localReq._ginaProxyHostname ) ? localReq._ginaProxyHostname : globalProxyHostname;
        }
        return out;
    }

    it('setOptions whisper: a proxied request whispers THIS request host, a raw request whispers nothing', function() {
        var p = whisper({ _ginaIsProxyHost: true, _ginaProxyHost: 'public-b.example', _ginaProxyHostname: 'https://public-b.example' }, 'public-a.example', 'https://public-a.example');
        assert.equal(p.proxyHost, 'public-b.example');
        assert.equal(p.proxyHostname, 'https://public-b.example');
        var r = whisper({ _ginaIsProxyHost: false }, 'public-a.example', 'https://public-a.example');
        assert.equal(r.proxyHost, undefined, 'a raw request whispers no proxy host');
    });

});

describe('33 - #B67 host-only envConf._proxyHostname (a hostname must not carry a webroot)', function() {

    var src  = fs.readFileSync(SOURCE, 'utf8');
    // Full-line comments stripped so the negative pin never trips on the file's own comments.
    var code = src.replace(/^\s*\/\/.*$/gm, '');

    // ── (a) source structure ──────────────────────────────────────────────────────

    it('carries the #B67 trace marker', function() {
        assert.ok(src.indexOf('#B67') > -1, 'expected the #B67 trace marker at the _proxyHostname write');
    });

    it('writes the host-only _config.hostname (NOT the host+webroot `hostname` var)', function() {
        assert.ok(
            src.indexOf('ctx.config.envConf._proxyHostname = (isProxyHost) ? _config.hostname : null;') > -1,
            'envConf._proxyHostname must be set to the host-only _config.hostname'
        );
        assert.ok(
            code.indexOf('ctx.config.envConf._proxyHostname = (isProxyHost) ? hostname : null;') < 0,
            'the old host+webroot write (? hostname : null) must be gone'
        );
    });

    it('change-detection compares the host-only value too (so it does not spuriously refire every request)', function() {
        assert.ok(
            src.indexOf('_config.hostname != ctx.config.envConf._proxyHostname') > -1,
            'the guard must compare _config.hostname, matching the written value'
        );
    });

    // ── (b) pure logic ────────────────────────────────────────────────────────────

    // mirrors controller.js:622 — envConf._proxyHostname = (isProxyHost) ? _config.hostname : null
    function proxyHostnameStore(isProxyHost, configHostname) {
        return (isProxyHost) ? configHostname : null;
    }
    // mirrors getRoute:1105 fallback + toUrl for a cross-bundle child route (webroot /c/, url /c/path)
    function fallbackToUrl(proxyHostname, childWebroot, childUrl) {
        var url = ( /\/$/.test(childUrl) && childUrl != '/' ) ? childUrl.substring(0, childUrl.length - 1) : childUrl;
        var finalUrl = ('' + url).replace(new RegExp('^(' + childWebroot + '|\\/$)'), childWebroot);
        return ('' + proxyHostname) + finalUrl;
    }

    it('a proxied request stores the host-only hostname (no trailing webroot slash)', function() {
        var stored = proxyHostnameStore(true, 'https://parent-internal:5127');
        assert.equal(stored, 'https://parent-internal:5127');
        assert.ok(!/\/$/.test(stored), 'a stored proxy hostname must not end in a webroot slash');
    });

    it('a raw request stores null', function() {
        assert.equal(proxyHostnameStore(false, 'https://parent-internal:5127'), null);
    });

    it('host-only stored value: the getRoute fallback yields NO double-webroot blend', function() {
        var stored = proxyHostnameStore(true, 'https://parent-internal:5127'); // post-fix (host-only)
        assert.equal(fallbackToUrl(stored, '/c/', '/c/path'), 'https://parent-internal:5127/c/path', 'host-only fallback → a single, clean webroot');
    });

    it('SUBTRACT — the pre-fix host+webroot value reproduces the blend in the same fallback', function() {
        var preFix = 'https://parent-internal:5127/p/'; // == _config.hostname + server.webroot (the old write)
        assert.equal(fallbackToUrl(preFix, '/c/', '/c/path'), 'https://parent-internal:5127/p//c/path', 'the old host+webroot store blends — proving host-only is load-bearing');
    });

});

describe('34 - redirect cache hardening: no-store folded into headInfos for dev OR proxied requests', function() {

    var src  = fs.readFileSync(SOURCE, 'utf8');
    // Full-line comments stripped so negative pins never trip on the file's own comments.
    var code = src.replace(/^\s*\/\/.*$/gm, '');

    // End-anchored body slice (structural, not a fixed char window): start = the redirect
    // signature, end = the next method's JSDoc title — insertions inside redirect cannot
    // silently drift the pins out of the slice.
    var startIdx = src.indexOf('this.redirect = async function(req, res, next) {');
    var endIdx   = src.indexOf('Move files to assets dir', startIdx);
    var body     = src.substring(startIdx, endIdx);

    // ── (a) source structure ─────────────────────────────────────────────────────

    it('body slice anchors resolve in order', function() {
        assert.ok(startIdx > -1, 'redirect signature anchor not found');
        assert.ok(endIdx > startIdx, 'end anchor (next method JSDoc) must follow the signature');
    });

    it('the cache gate is dev OR proxied', function() {
        assert.ok(
            body.indexOf('if (self.isCacheless() || isProxyHost) {') > -1,
            'expected the widened gate `self.isCacheless() || isProxyHost` in the redirect body'
        );
    });

    it('the no-store set is folded into headInfos BEFORE a single writeHead', function() {
        var hIdx = body.indexOf('var headInfos');
        var gIdx = body.indexOf('if (self.isCacheless() || isProxyHost) {');
        var tIdx = body.indexOf("'cache-control': 'no-cache, no-store, must-revalidate'");
        var wIdx = body.indexOf('res.writeHead(code, headInfos);');
        assert.ok(hIdx > -1, 'headInfos build not found');
        assert.ok(gIdx > hIdx, 'gate must follow the headInfos build');
        assert.ok(tIdx > gIdx, 'the no-store merge must sit inside the gate');
        assert.ok(wIdx > tIdx, 'the single writeHead must follow the conditional fold');
    });

    it('exactly one status write; the old trio-in-the-writeHead-call form is gone file-wide', function() {
        var writes = body.match(/res\.writeHead\(code, headInfos\);/g) || [];
        assert.equal(writes.length, 1, 'expected exactly one res.writeHead(code, headInfos);');
        assert.ok(code.indexOf('writeHead(code, merge(') < 0, 'the no-store set must ride in headInfos, never in the writeHead call');
    });

    it('the cross-bundle payload serializes headInfos AFTER the fold (the 3xx forward inherits the set)', function() {
        var tIdx = body.indexOf("'cache-control': 'no-cache, no-store, must-revalidate'");
        var pIdx = body.indexOf('JSON.stringify({ status: code, headers: headInfos })');
        assert.ok(pIdx > -1, 'redirectObject payload build not found');
        assert.ok(pIdx > tIdx, 'the payload must be built from headInfos after the conditional fold');
    });

    // ── (b) pure logic — gate matrix + forward inheritance ───────────────────────

    var NO_STORE = {
        'cache-control': 'no-cache, no-store, must-revalidate',
        'pragma': 'no-cache',
        'expires': '0'
    };
    // mirrors the redirect body: headInfos build + conditional fold (keys are disjoint,
    // so target-wins vs source-wins merge semantics cannot differ here)
    function buildRedirectHead(path, isCacheless, isProxyHost) {
        var headInfos = { 'location': path };
        if (isCacheless || isProxyHost) {
            for (var k in NO_STORE) {
                headInfos[k] = NO_STORE[k];
            }
        }
        return headInfos;
    }
    // mirrors the query() 3xx intercept: local.res.writeHead(data.status, data.headers) + end()
    function forwardReplica(redirectObjectJson) {
        var data = JSON.parse(redirectObjectJson);
        var wrote = [];
        if (data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
            wrote.push([data.status, data.headers]);
        }
        return wrote;
    }

    it('prod + raw: location only — byte-compatible with the previous behavior', function() {
        var h = buildRedirectHead('/target/', false, false);
        assert.deepEqual(h, { 'location': '/target/' });
    });

    it('prod + proxied: the no-store set rides with the Location', function() {
        var h = buildRedirectHead('https://public.example/target/', false, true);
        assert.equal(h['cache-control'], NO_STORE['cache-control']);
        assert.equal(h.pragma, 'no-cache');
        assert.equal(h.expires, '0');
        assert.equal(h.location, 'https://public.example/target/');
    });

    it('dev keeps the set with or without a proxy (unchanged dev contract)', function() {
        assert.equal(buildRedirectHead('/t/', true, false)['cache-control'], NO_STORE['cache-control']);
        assert.equal(buildRedirectHead('/t/', true, true)['cache-control'], NO_STORE['cache-control']);
    });

    it('forward inheritance: the intercept replays the folded headers verbatim', function() {
        var payload = JSON.stringify({ status: 301, headers: buildRedirectHead('https://public.example/t/', false, true) });
        var wrote = forwardReplica(payload);
        assert.equal(wrote.length, 1);
        assert.equal(wrote[0][0], 301);
        assert.equal(wrote[0][1]['cache-control'], NO_STORE['cache-control'], 'the forwarded copy must carry the no-store set');
    });

    it('SUBTRACT — the pre-fix shape (set only in the write call) loses it on the forward path', function() {
        // pre-fix: headInfos stayed { location } and the no-store set was merged into the
        // writeHead CALL argument only — the serialized payload therefore never carried it.
        var preFixHeadInfos = { 'location': 'https://public.example/t/' };
        var payload = JSON.stringify({ status: 301, headers: preFixHeadInfos });
        var wrote = forwardReplica(payload);
        assert.equal(typeof wrote[0][1]['cache-control'], 'undefined', 'pre-fix forward goes out bare — proving the fold is load-bearing');
    });

});

describe('35 - redirect XHR/popin JSON exits inherit the no-store hardening (#B75) + session-less guard', function() {

    var src  = fs.readFileSync(SOURCE, 'utf8');
    // Full-line comments stripped so negative pins never trip on the file's own comments.
    var code = src.replace(/^\s*\/\/.*$/gm, '');

    // End-anchored slice of the redirect body (same structural anchors as §34).
    var startIdx = src.indexOf('this.redirect = async function(req, res, next) {');
    var endIdx   = src.indexOf('Move files to assets dir', startIdx);
    var body     = src.substring(startIdx, endIdx);

    // ── (a) source structure ─────────────────────────────────────────────────────

    it('a no-store helper for the JSON redirect exits exists, gated on dev OR proxied', function() {
        var hIdx = body.indexOf('var _applyNoStoreToRedirectJSON = function()');
        assert.ok(hIdx > -1, 'expected the _applyNoStoreToRedirectJSON helper');
        var gIdx = body.indexOf('var _noStoreNeeded = ( self.isCacheless() || isProxyHost );', hIdx);
        assert.ok(gIdx > hIdx, 'the helper must gate on ( self.isCacheless() || isProxyHost )');
        // the trio, set on local.res (so render-json's HTTP/2 getHeaders() fold + HTTP/1.1 both carry it)
        assert.ok(body.indexOf("local.res.setHeader('cache-control', 'no-cache, no-store, must-revalidate')", gIdx) > gIdx, 'cache-control no-store');
        assert.ok(body.indexOf("local.res.setHeader('pragma', 'no-cache')", gIdx) > gIdx, 'pragma');
        assert.ok(body.indexOf("local.res.setHeader('expires', '0')", gIdx) > gIdx, 'expires');
    });

    it('the helper is invoked before BOTH renderJSON redirect exits', function() {
        // exit 1: the isXMLRequest()+params branch -> renderJSON(redirectObj)
        var callA = body.indexOf('_applyNoStoreToRedirectJSON();');
        var jsonA = body.indexOf('self.renderJSON(redirectObj);');
        assert.ok(callA > -1 && jsonA > callA, 'helper call must precede renderJSON(redirectObj)');
        // exit 2: the popin branch -> renderJSON({ isXhrRedirect ... popin })
        var popIdx = body.indexOf('// Popin redirect');
        var callB  = body.indexOf('_applyNoStoreToRedirectJSON();', popIdx);
        var jsonB  = body.indexOf('return self.renderJSON({', popIdx);
        assert.ok(callB > popIdx && jsonB > callB, 'helper call must precede the popin renderJSON');
    });

    it('exactly two JSON-exit invocations of the helper', function() {
        var calls = body.match(/_applyNoStoreToRedirectJSON\(\);/g) || [];
        assert.equal(calls.length, 2, 'expected exactly two helper call sites (the two renderJSON redirect exits)');
    });

    it('the #B68 writeHead gate literal stays unique (helper did not reuse it)', function() {
        var writeHeadGate = body.match(/if \(self\.isCacheless\(\) \|\| isProxyHost\) \{/g) || [];
        assert.equal(writeHeadGate.length, 1, 'the writeHead gate literal must remain unique to #B68 (§34 depends on it)');
    });

    it('the session-less guard replaces the unguarded req.session.user deref', function() {
        assert.ok(
            body.indexOf("var userSession = ( typeof(req.session) != 'undefined' && req.session )") > -1,
            'expected the guarded userSession form'
        );
        assert.ok(code.indexOf('var userSession = req.session.user || req.session;') < 0, 'the unguarded deref must be gone');
    });

    // ── (b) pure logic ───────────────────────────────────────────────────────────

    // mirrors the helper's setHeader trio under the gate
    function applyNoStore(isCacheless, isProxyHost) {
        var headers = {};
        if (isCacheless || isProxyHost) {
            headers['cache-control'] = 'no-cache, no-store, must-revalidate';
            headers['pragma'] = 'no-cache';
            headers['expires'] = '0';
        }
        return headers;
    }

    it('proxied prod: the JSON redirect gets no-store (the gap #B75 closes)', function() {
        var h = applyNoStore(false, true);
        assert.equal(h['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(h.pragma, 'no-cache');
        assert.equal(h.expires, '0');
    });

    it('direct prod: the JSON redirect stays header-free (byte-identical to pre-#B75)', function() {
        assert.deepEqual(applyNoStore(false, false), {});
    });

    it('dev keeps the set with or without a proxy', function() {
        assert.equal(applyNoStore(true, false)['cache-control'], 'no-cache, no-store, must-revalidate');
        assert.equal(applyNoStore(true, true)['cache-control'], 'no-cache, no-store, must-revalidate');
    });

    // mirrors the session-less guard
    function resolveUserSession(session) {
        return ( typeof(session) != 'undefined' && session ) ? (session.user || session) : null;
    }

    it('session-less guard: resolves to null instead of throwing', function() {
        assert.equal(resolveUserSession(undefined), null);
        assert.equal(resolveUserSession(null), null);
        var s = { user: { id: 1 } };
        assert.equal(resolveUserSession(s), s.user);
        var s2 = { id: 2 }; // a session with no .user
        assert.equal(resolveUserSession(s2), s2);
    });

    it('SUBTRACT — the pre-fix unguarded deref throws when no session is mounted', function() {
        function preFix(session) { return session.user || session; } // the old line
        assert.throws(function() { preFix(undefined); }, /Cannot read propert/);
    });

});


// 36 — behavioral: pauseRequest snapshots the live request into requestStorage.
// Runtime (require + createTestInstance) test — like §02, in this otherwise
// source-pin-only file. controller.js cannot be required cold — it needs the framework
// globals bootstrap (NODE_PATH + Module._initPaths + helpers + setPath('gina', ...)),
// mirroring the standalone repro harness in class.controller.md §14. Requiring it also
// installs JSON.clone (lib/merge) + Object.prototype.count (utils/prototypes) transitively.
describe('36 - pauseRequest snapshots the live request into requestStorage (behavioral)', function() {

    var FW = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));              // injects _/getPath/requireJSON/setPath globals
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SOURCE);

    function makeInstance(reqOverrides) {
        var req = Object.assign({
            url     : '/orders/42',
            method  : 'POST',
            routing : { rule: 'orders', namespace: 'default' },
            params  : {},
            get     : {},
            post    : {}
        }, reqOverrides || {});
        return SuperController.createTestInstance({
            req     : req,
            res     : { setHeader: function () {}, end: function () {} },
            options : { conf: { bundle: 'b', content: { routing: { orders: {} } } }, rule: 'orders', control: 'index' }
        });
    }

    it('populates requestStorage.haltedRequest with the {url, routing, method, data} snapshot', function() {
        var inst    = makeInstance();
        var storage = {};
        var out     = inst.pauseRequest({ qty: 2 }, storage);
        assert.strictEqual(out, storage, 'returns the same storage object it was given');
        assert.deepStrictEqual(storage.haltedRequest, {
            url     : '/orders/42',
            routing : { rule: 'orders', namespace: 'default' },
            method  : 'post',        // lowercased
            data    : { qty: 2 }     // JSON.clone of the passed data
        });
    });

    it('lowercases the method and deep-clones the data (not the same reference)', function() {
        var inst    = makeInstance({ method: 'PUT' });
        var storage = {};
        var payload = { nested: { a: 1 } };
        inst.pauseRequest(payload, storage);
        assert.equal(storage.haltedRequest.method, 'put');
        assert.deepStrictEqual(storage.haltedRequest.data, { nested: { a: 1 } });
        assert.notStrictEqual(storage.haltedRequest.data, payload, 'data is JSON.clone-d, not aliased');
        assert.notStrictEqual(storage.haltedRequest.data.nested, payload.nested, 'deep clone reaches nested objects');
    });

    it('captures positional url params beyond index 0 into haltedRequest.params', function() {
        // pauseRequest copies req.params but skips the first key (index 0 = the matched
        // path, set by the engine at request.params[0]); see controller.js ~5343.
        var inst    = makeInstance({ params: { 0: '/orders/42', id: '42', tab: 'items' } });
        var storage = {};
        inst.pauseRequest({}, storage);
        assert.deepStrictEqual(storage.haltedRequest.params, { id: '42', tab: 'items' });
    });

    it('defaults storage to req.session when requestStorage is omitted', function() {
        var session = {};
        var inst    = makeInstance({ session: session });
        var out     = inst.pauseRequest({ hello: 'world' });   // no explicit storage
        assert.strictEqual(out, session, 'returns req.session as the storage');
        assert.equal(session.haltedRequest.url, '/orders/42');
        assert.deepStrictEqual(session.haltedRequest.data, { hello: 'world' });
    });

});


// ---------------------------------------------------------------------------
// 37 — self.cache: the FIRING half of the cache.invalidateOnEvents contract
//
// A route declares which events evict it (`cache.invalidateOnEvents`) and the
// render delegates register the key against them — that half always worked.
// Nothing ever FIRED an invalidation, so the contract was inert end to end and
// the documented `self.cache.invalidateByEvent()` did not exist. Behavioral:
// drives the REAL SuperController via createTestInstance (the §14 harness).
// ---------------------------------------------------------------------------
describe('37 - self.cache fires cache.invalidateOnEvents (behavioral)', function() {

    var FW = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SOURCE);
    var RenderCache     = require(path.join(FW, 'lib/render-cache/src/main'));

    // A controller wired to `store` as the server's shared cache Map.
    function makeInstance(store) {
        var inst = SuperController.createTestInstance({
            req     : { url: '/x', method: 'GET', routing: { rule: 'r', namespace: 'default' }, params: {}, get: {} },
            res     : { setHeader: function () {}, end: function () {} },
            options : { conf: { bundle: 'b', content: { routing: { r: {} } } }, rule: 'r', control: 'index' }
        });
        if (typeof store !== 'undefined') {
            inst.serverInstance = { _cached: store };
            stores.push(store);
        }
        return inst;
    }

    // Seed the shared Map the way a render delegate does: cache the entry, then
    // register it against the route's invalidateOnEvents.
    //
    // Deliberately NO ttl: lib/cache.set() arms a setTimeout(ttl * 1000) per entry,
    // and any entry a test does not evict would keep that timer — and the event loop —
    // alive for the whole TTL, hanging the file (node --test waits for the loop to
    // drain; --test-force-exit would only mask it). Expiry is not what this section
    // tests; §04 of render-cache.test.js covers it.
    function seed(store, urls, events) {
        var rc = new RenderCache();
        rc.from(store);
        return urls.map(function (u) {
            var k = rc.buildKey('static', 'b', u);
            rc.set('memory', k, {}, { content: u });
            rc.setEvents(k, events);
            return k;
        });
    }

    // Belt-and-braces: drop every entry (and any timer it holds) after each test.
    var stores = [];
    afterEach(function () {
        stores.forEach(function (st) {
            try { new RenderCache().from(st).clear(); } catch (e) {}
        });
        stores = [];
    });

    it('exposes the documented invalidateByEvent + clear handles', function() {
        var inst = makeInstance(new Map());
        assert.equal(typeof inst.cache, 'object');
        assert.equal(typeof inst.cache.invalidateByEvent, 'function');
        assert.equal(typeof inst.cache.clear, 'function');
    });

    it('invalidateByEvent evicts every entry registered to the event and returns the count', function() {
        var store = new Map();
        var inst  = makeInstance(store);
        var keys  = seed(store, ['/a', '/b'], ['invoice#saved']);

        assert.equal(inst.cache.invalidateByEvent('invoice#saved'), 2);

        var probe = new RenderCache();
        probe.from(store);
        keys.forEach(function (k) {
            assert.equal(probe.has(k), false, 'entry must be evicted: ' + k);
        });
    });

    it('leaves entries registered to a DIFFERENT event alone', function() {
        var store = new Map();
        var inst  = makeInstance(store);
        var keys  = seed(store, ['/keep'], ['mine#evt']);

        assert.equal(inst.cache.invalidateByEvent('other#evt'), 0);

        var probe = new RenderCache();
        probe.from(store);
        assert.equal(probe.has(keys[0]), true, 'an unrelated event must not evict');
    });

    it('is safe to call before the server is wired — returns 0, never throws', function() {
        var inst = makeInstance();            // no serverInstance at all
        assert.doesNotThrow(function () {
            assert.equal(inst.cache.invalidateByEvent('x'), 0);
            assert.equal(inst.cache.clear(), 0);
        });
    });

    it('clear(bundle) flushes only that bundle', function() {
        var store = new Map();
        var inst  = makeInstance(store);
        var rc    = new RenderCache();
        rc.from(store);
        var mine  = rc.buildKey('static', 'b',     '/mine');
        var other = rc.buildKey('static', 'other', '/other');
        rc.set('memory', mine,  {}, { content: 'm' });
        rc.set('memory', other, {}, { content: 'o' });

        assert.equal(inst.cache.clear('b'), 1);

        var probe = new RenderCache();
        probe.from(store);
        assert.equal(probe.has(mine),  false, 'the named bundle is flushed');
        assert.equal(probe.has(other), true,  'other bundles are untouched');
    });
});


// ---------------------------------------------------------------------------
// 38 — #COMPLY2 self.audit(): the controller's audit-trail emit, driven
// BEHAVIORALLY through the REAL SuperController (createTestInstance, the §14
// harness / §36 bootstrap mould) AND the REAL lib/audit singleton writing to a
// real temp JSONL file — the correctness here is runtime VALUES (which req the
// record carries), which a source pin cannot see. The one contract a pin CAN
// lock is structural: the deliberate ABSENCE of the #B35 released-response
// early-return (degraded-record-over-dropped-record, the compliance-trail
// rationale), pinned against its #COMPLY sibling `hasRole`, which HAS one.
// ---------------------------------------------------------------------------
describe('38 - #COMPLY2 self.audit emits through the real lib/audit (behavioral)', function() {

    var os38 = require('os');
    var FW38 = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW38;
    require('module').Module._initPaths();
    require(path.join(FW38, 'helpers'));
    setPath('gina', { core: path.join(FW38, 'core') });
    var SuperController38 = require(SOURCE);
    // The SAME module instance controller.js's lib registry resolves:
    // lib/index.js `require('./audit')` -> lib/audit/package.json main ->
    // lib/audit/src/main.js — Node's cache keys on the resolved file.
    var audit38 = require(path.join(FW38, 'lib/audit/src/main'));

    var SRC38 = fs.readFileSync(SOURCE, 'utf8');

    // ---- source pins ----

    it('source pin — delegates to lib.audit.write, threading the live-or-released local.req', function() {
        var idx = SRC38.indexOf('this.audit = function(action, data, cb) {');
        assert.ok(idx > -1, 'the method');
        var end = SRC38.indexOf('this.isHaltedRequest', idx);
        assert.ok(end > idx, 'end anchor (the next controller method) — re-anchor if isHaltedRequest moves');
        var body = SRC38.slice(idx, end);
        assert.match(body, /return lib\.audit\.write\(action, \{/);
        assert.match(body, /req\s*:\s*\( local\.req != null \) \? local\.req : null,/);
    });

    it('source pin — DELIBERATELY no #B35 early-return: a released response degrades, never drops', function() {
        var hasRoleIdx = SRC38.indexOf('this.hasRole = function(role) {');
        var auditIdx   = SRC38.indexOf('this.audit = function(action, data, cb) {');
        assert.ok(hasRoleIdx > -1, 'the #COMPLY sibling');
        assert.ok(auditIdx > hasRoleIdx, 'the #COMPLY cluster: audit sits after hasRole');
        // hasRole HAS the guard (pinned in authz-gate.test.js §13); audit must NOT:
        var body = SRC38.slice(auditIdx, SRC38.indexOf('this.isHaltedRequest', auditIdx));
        assert.doesNotMatch(body, /if \( local\.req == null \)/,
            'the #B35 guard is deliberately ABSENT — buildRecord is null-safe, and a ' +
            'compliance trail prefers a degraded record over a dropped one');
    });

    it('the #DTO3b parity gate is satisfied: the types interface declares audit', function() {
        var typesSrc = fs.readFileSync(path.join(FW38, '../../types/index.d.ts'), 'utf8');
        assert.ok(typesSrc.indexOf('audit(action: string, data?: { resource?: any; meta?: object; actor?: { key?: any; roles?: string[] } }, cb?: (err: Error | null) => void): void;') > -1,
            'the parity gate diffs the SuperController interface against a real instance');
    });

    // ---- behavioral (real controller + real lib + real temp file) ----

    var tmp38 = [];
    function startTrail38() {
        var dir = fs.mkdtempSync(path.join(os38.tmpdir(), 'gina-ctrl-audit-'));
        tmp38.push(dir);
        var file = path.join(dir, 'audit.jsonl');
        audit38.start({ bundle: 'b', env: 'test', file: file });
        return file;
    }
    afterEach(function () {
        audit38._resetForTest();
        tmp38.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best-effort */ } });
        tmp38 = [];
    });

    function makeInstance38(reqOverrides) {
        var req = Object.assign({
            url        : '/invoices/42',
            method     : 'DELETE',
            _ginaReqId : 'rq-777',
            routing    : { rule: 'invoice-remove', namespace: 'default' },
            socket     : { remoteAddress: '::ffff:10.1.2.3' },
            session    : { user: { id: 'u9', email: 'x@y.z', roles: ['ops'] } },
            params     : {},
            get        : {},
            'delete'   : {}
        }, reqOverrides || {});
        var r = {
            statusCode  : 200,
            headersSent : false,
            _headers    : {},
            ended       : false,
            getHeaders  : function () { return this._headers; },
            getHeader   : function (k) { return this._headers[k]; },
            setHeader   : function (k, v) { this._headers[k] = v; },
            writeHead   : function () {},
            end         : function () { this.ended = true; }
        };
        var inst = SuperController38.createTestInstance({
            req     : req,
            res     : r,
            options : {
                conf    : { bundle: 'b', encoding: 'utf-8', content: { routing: { 'invoice-remove': {} } } },
                rule    : 'invoice-remove',
                control : 'index'
            }
        });
        return { inst: inst, req: req, res: r };
    }

    function auditP38(inst, action, data) {
        return new Promise(function (resolve) {
            inst.audit(action, data, function (err) { resolve(err || null); });
        });
    }
    function records38(file) {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    }
    /** renderTEXT logs its access line via console.info — keep the run quiet. */
    function quiet38(fn) {
        var prevInfo = console.info;
        console.info = function () {};
        try { return fn(); } finally { console.info = prevInfo; }
    }

    it('threads the live request into the record — requestId/ip/rule/method/actor all from THIS req', async function() {
        var file = startTrail38();
        var m    = makeInstance38();
        var err  = await auditP38(m.inst, 'invoice.delete', { resource: 'inv-42', meta: { why: 'gdpr' } });
        assert.equal(err, null);
        var rec = records38(file)[0];
        assert.equal(rec.action, 'invoice.delete');
        assert.equal(rec.resource, 'inv-42');
        assert.deepEqual(rec.meta, { why: 'gdpr' });
        assert.equal(rec.requestId, 'rq-777', 'the #COMPLY2 slice-1 correlation key rides the record');
        assert.equal(rec.ip, '10.1.2.3', '::ffff:-normalized socket address');
        assert.equal(rec.rule, 'invoice-remove');
        assert.equal(rec.method, 'DELETE');
        assert.deepEqual(rec.actor, { key: 'u9', roles: ['ops'] }, 'actorKey + a roles copy — never the whole user');
        assert.equal(rec.bundle, 'b');
        assert.equal(rec.env, 'test');
    });

    it('normalizes the 2-arg (action, cb) form', async function() {
        var file = startTrail38();
        var m    = makeInstance38();
        var err  = await new Promise(function (resolve) {
            m.inst.audit('config.readback', function (e) { resolve(e || null); });
        });
        assert.equal(err, null);
        var rec = records38(file)[0];
        assert.equal(rec.action, 'config.readback');
        assert.equal('resource' in rec, false, 'absent, not null — nothing was passed');
        assert.equal('meta' in rec, false);
        assert.equal(rec.requestId, 'rq-777', 'the req still threads');
    });

    it('a released response (post-renderTEXT terminal exit) yields a DEGRADED record — never a drop', async function() {
        var file = startTrail38();
        var m    = makeInstance38();
        quiet38(function () { m.inst.renderTEXT('bye'); });   // the lightest terminal exit — nulls local.req/res/next
        assert.equal(m.res.ended, true, 'positive evidence the terminal exit actually ran');

        var err = await auditP38(m.inst, 'late.audit', { resource: 'r-1' });
        assert.equal(err, null, 'the write still lands');
        var rec = records38(file)[0];
        assert.equal(rec.action, 'late.audit');
        assert.equal(rec.resource, 'r-1');
        assert.equal(rec.requestId, null, 'degraded: the req is gone');
        assert.equal(rec.ip, null);
        assert.equal(rec.rule, null);
        assert.equal(rec.method, null);
        assert.deepEqual(rec.actor, { key: null, roles: [] });
    });

    it('disabled (no start): cb(null), nothing thrown — application code never branches on config', async function() {
        var m   = makeInstance38();
        var err = await auditP38(m.inst, 'any.thing', {});
        assert.equal(err, null);
        assert.equal(audit38.isEnabled(), false);
    });
});


// ---------------------------------------------------------------------------
// 39 — behavioral: resumeRequest replays a halted GET request (the resume half
// of the pause/resume pair — §36 covers pauseRequest). Runtime test via the
// createTestInstance §14 harness / §36 bootstrap mould. The GET branch bottoms
// out in lib.routing.getRoute (a shared module singleton, not injectable via
// createTestInstance) + self.redirect — so it monkeypatches lib.routing.getRoute
// (restored in finally) and stubs inst.redirect with a spy. Covers the resume
// path documented in class.controller.md §15 (the inheritedData transport).
// ---------------------------------------------------------------------------
describe('39 - resumeRequest replays a halted GET request (behavioral)', function() {

    var FW39 = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW39;
    require('module').Module._initPaths();
    require(path.join(FW39, 'helpers'));
    setPath('gina', { core: path.join(FW39, 'core') });
    var SuperController39 = require(SOURCE);
    // The SAME lib.routing instance controller.js resolves: controller.js
    // `require('./../../lib')` and this both resolve <FW>/lib/index.js (one cache
    // entry), and `.routing` is a stable gen-0 instance — so patching its
    // getRoute is exactly what controller.js reads at the resume site (~:5739).
    var lib39 = require(path.join(FW39, 'lib'));

    function makeInstance39(reqOverrides) {
        var req = Object.assign({
            url     : '/login',
            method  : 'GET',
            headers : {},                                  // isPopinContext reads req.headers
            routing : { rule: 'login', namespace: 'default', param: {} },
            params  : {},
            get     : {},
            post    : {}
        }, reqOverrides || {});
        return SuperController39.createTestInstance({
            req     : req,
            res     : { setHeader: function () {}, end: function () {}, writeHead: function () {} },
            options : {
                conf : {
                    bundle : 'b',
                    // resumeRequest iterates this before resolving the route (~:5725)
                    server : { supportedRequestMethods: { get: 1, post: 1, put: 1, 'delete': 1 } },
                    content: { routing: { login: {} } }
                },
                rule    : 'login',
                control : 'index'
            }
        });
    }

    // A halted GET snapshot (same namespace as the live req → no requireController).
    function haltedGet(overrides) {
        return Object.assign({
            url     : '/orders/42',
            routing : { rule: 'orders', namespace: 'default', param: {} },
            method  : 'GET',
            data    : {},
            params  : { id: '42' }
        }, overrides || {});
    }

    // Monkeypatch the shared lib.routing.getRoute; restore in finally.
    function withStubbedRoute(url, fn) {
        var real  = lib39.routing.getRoute;
        var calls = [];
        lib39.routing.getRoute = function () {
            calls.push(Array.prototype.slice.call(arguments));
            return { url: url };
        };
        try { return fn(calls); }
        finally { lib39.routing.getRoute = real; }
    }

    it('GET branch: resolves the url via lib.routing.getRoute and redirects (url, true)', function() {
        withStubbedRoute('/resolved', function (routeCalls) {
            var inst = makeInstance39();
            var redirectCalls = [];
            inst.redirect = function () { redirectCalls.push(Array.prototype.slice.call(arguments)); };

            var storage = { haltedRequest: haltedGet() };
            inst.resumeRequest(storage);

            // resolved from the HALTED rule + params (not the live req's)
            assert.equal(routeCalls.length, 1, 'lib.routing.getRoute called once');
            assert.equal(routeCalls[0][0], 'orders', 'arg 1 = haltedRequest.routing.rule');
            assert.deepStrictEqual(routeCalls[0][1], { id: '42' }, 'arg 2 = haltedRequest.params');

            // the non-XHR GET path bottoms out in self.redirect(url, true)
            assert.equal(redirectCalls.length, 1, 'self.redirect called once');
            assert.deepStrictEqual(redirectCalls[0], ['/resolved', true]);

            // the resume marker is stamped and the snapshot is consumed (one-shot)
            assert.equal(storage.haltedRequestUrlResumed, '/resolved');
            assert.equal('haltedRequest' in storage, false, 'the halted snapshot is deleted');
        });
    });

    it('defaults storage to req.session when requestStorage is omitted', function() {
        withStubbedRoute('/resolved', function (routeCalls) {
            var session = { haltedRequest: haltedGet() };
            var inst    = makeInstance39({ session: session });
            var redirectCalls = [];
            inst.redirect = function () { redirectCalls.push(Array.prototype.slice.call(arguments)); };

            inst.resumeRequest();   // no explicit storage → reads req.session

            // #B215: with a live session the GET replay uses the byte-exact
            // haltedRequest.url — the recompose (stubbed here) is not consulted.
            assert.equal(routeCalls.length, 0, 'raw-URL branch: getRoute not called');
            assert.equal(session.haltedRequestUrlResumed, '/orders/42');
            assert.equal(redirectCalls.length, 1, 'redirected via the session-held snapshot');
        });
    });

    it('no haltedRequest: throwErrors (424) and resolves no route / issues no redirect', function() {
        withStubbedRoute('/resolved', function (routeCalls) {
            var inst = makeInstance39();
            var errs = [];
            inst.throwError = function (e) { errs.push(e); };
            var redirectCalls = [];
            inst.redirect = function () { redirectCalls.push(1); };

            inst.resumeRequest({});   // storage carries no haltedRequest

            assert.equal(errs.length, 1, 'throwError fired');
            assert.match(String(errs[0] && errs[0].message), /haltedRequest.*required/i,
                'the 424 guard message');
            assert.equal(routeCalls.length, 0, 'no route resolved on the guard path');
            assert.equal(redirectCalls.length, 0, 'no redirect on the guard path');
        });
    });

    it('already-resumed (local.haltedRequestUrlResumed): a second resume is a no-op', function() {
        withStubbedRoute('/resolved', function (routeCalls) {
            var inst = makeInstance39();
            inst.redirect = function () {};

            var storage = { haltedRequest: haltedGet() };
            inst.resumeRequest(storage);              // first resume (sets the local flag)
            assert.equal(routeCalls.length, 1);

            storage.haltedRequest = haltedGet();      // re-arm — so ONLY the flag can stop a 2nd resume
            inst.resumeRequest(storage);              // second: early-returns before getRoute
            assert.equal(routeCalls.length, 1, 'the local flag short-circuits before getRoute');
        });
    });
});



// 40 — #B399 (query delivery seams): every app-callback delivery in the query
// machinery owns an async callback's rejection. Pre-fix (measured on the
// shipped bytes, three tiers × both transports): a SYNC throw inside the app
// callback was caught only by the two success-delivery guards, while an
// `async` callback's rejected promise passed through every bare
// `callback(...)` / `cb(...)` delivery unowned — no response, the request hung
// to client/proxy timeout, the rejection floated to the process-level handler.
// Post-fix ONE constructor-scope `_ownAsyncCbRejection` helper wraps all 22
// delivery expressions (4 facade `cb` sites + 19 direct `callback` sites): a
// thenable return gets a `.catch` routing to the same throwError shape the
// sync-delivery catches build (flat 500); sync behaviour at every wrapped site
// is byte-unchanged. 40a pins the shipped text; 40b drives the REAL code
// (createTestInstance + real query() + real/dead local upstreams) — no
// replica, so there is nothing to drift.
describe('40a - #B399 query delivery seams own an async callback rejection: source pins', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');
    function countOf(hay, needle) { return hay.split(needle).length - 1; }
    // line-filter comment strip (the error-ref.test.js idiom) — the dead
    // commented-out query blocks carry the sync-catch message too
    function stripLineComments(text) {
        return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }

    it('exactly ONE constructor-scope helper, defined before this.query', function() {
        var DEF = 'var _ownAsyncCbRejection = function(result)';
        assert.equal(countOf(src, DEF), 1, 'a single shared definition (the facade-local copies are gone)');
        assert.ok(src.indexOf(DEF) < src.indexOf('this.query = function(options, data, callback)'),
            'defined above this.query so every delivery site reaches it');
        var b = src.slice(src.indexOf(DEF), src.indexOf('return result;', src.indexOf(DEF)));
        assert.ok(b.indexOf("if ( result && typeof(result.then) == 'function' )") > -1, 'thenable check — plain callbacks mint zero promises');
        assert.ok(b.indexOf('.catch(function(asyncErr)') > -1, 'rejection handler');
        assert.ok(b.indexOf('exception.status = 500;') > -1, 'flat 500');
        assert.ok(b.indexOf('self.throwError(exception);') > -1, 'routes to throwError');
    });

    it("the adapter's 3 cb sites and all 21 direct callback sites are wrapped", function() {
        // #B475 — the two per-transport facades collapsed into ONE per-call adapter
        assert.equal(countOf(src, '_ownAsyncCbRejection(cb(data))'), 1, 'adapter data-status branch');
        assert.equal(countOf(src, '_ownAsyncCbRejection(cb(err, data))'), 1, 'adapter success branch');
        assert.equal(countOf(src, '_ownAsyncCbRejection(callback('), 22, 'every direct delivery expression (query prep incl. the #B479 nested-render refusal and the two #B489 body refusals + both transport bodies + the #B612 pre-send session-gone terminal in _sendRequest)');
    });

    it('the ONE fluent delivery adapter registers the guard inside the sync-guard try (#B475: both per-transport facades are gone)', function() {
        var DEF = 'var _fluentDelivery = function(cb) {';
        assert.equal(countOf(src, DEF), 1, 'a single constructor-scope adapter replaces the two facades');
        assert.ok(src.indexOf(DEF) < src.indexOf('this.query = function(options, data, callback)'), 'defined above this.query');
        assert.equal(countOf(src, 'onComplete  : function(cb) {'), 0, 'the per-transport facades are gone');
        var live = stripLineComments(src);
        assert.equal(countOf(live, "self.once('query#complete'"), 0, 'no fluent listener on the shared instance emitter');
        assert.equal(countOf(live, "self.removeAllListeners('query#complete')"), 0, 'the destructive de-dup is gone');
        var block  = src.slice(src.indexOf(DEF), src.indexOf('} catch (e) {', src.indexOf(DEF)) + 1);
        var wrapAt = block.indexOf('err instanceof Error');
        var tryAt  = block.lastIndexOf('try {');
        var call1  = block.indexOf('_ownAsyncCbRejection(cb(data))');
        var call2  = block.indexOf('_ownAsyncCbRejection(cb(err, data))');
        assert.ok(wrapAt > -1 && tryAt > wrapAt, 'the sync-guard try opens after the {status, error} wrap');
        assert.ok(call1 > tryAt && call2 > call1, 'both wrapped calls sit inside the sync-guard try');
    });

    it('the async guard has ONE marker; the three live sync-delivery catches are untouched', function() {
        assert.equal(countOf(src, 'Controller Query Exception on async callback rejection.'), 1, 'the async marker lives only in the shared helper');
        var live = stripLineComments(src);
        assert.equal(countOf(live, 'Controller Query Exception while catching back.'), 3,
            '1 adapter (#B475) + 2 direct-delivery sync catches stay live (comment-stripped census)');
        // instrument control (can-fail): the UNstripped source also carries the
        // dead commented-out query blocks — the strip must be doing real work
        assert.ok(countOf(src, 'Controller Query Exception while catching back.') > 3,
            'control: the comment strip is load-bearing, not vacuous');
    });
});

describe('40b - #B399 query delivery seams: behavioral, real bytes', function() {

    // Same standalone bootstrap idiom as §39 — controller.js loads outside a
    // bundle. The context seeds cover what query()'s paths unconditionally
    // dereference (protocol/scheme fallback, credentials.ca, and the HTTP/1
    // error handler's gina.ports lookup); they are installed in before() so
    // earlier describes never see them.
    var before40 = require('node:test').before;
    var after40  = require('node:test').after;
    // #B475 — the fluent handle is a per-call channel now, so the facade arms
    // below drive REAL upstreams (one per transport, answering 200 {"ok":true})
    var srv40h1 = null, srv40h2 = null, port40h1 = 0, port40h2 = 0, sess40h2 = [];
    var http40  = require('http');
    var http240 = require('http2');
    var net40   = require('net');
    var FW40 = require('../fw');
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW40;
    require('module').Module._initPaths();
    require(path.join(FW40, 'helpers'));
    require(path.join(FW40, '..', '..', 'utils', 'prototypes'));
    setPath('gina', { core: path.join(FW40, 'core') });
    var SuperController40 = require(SOURCE);

    before40(async function() {
        srv40h1 = http40.createServer(function(q, r) { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}'); });
        await new Promise(function(res) { srv40h1.listen(0, '127.0.0.1', res); });
        port40h1 = srv40h1.address().port;
        srv40h2 = http240.createServer();
        srv40h2.on('session', function(sess) { sess40h2.push(sess); });
        srv40h2.on('stream', function(stream) { stream.respond({ ':status': 200, 'content-type': 'application/json' }); stream.end('{"ok":true}'); });
        await new Promise(function(res) { srv40h2.listen(0, '127.0.0.1', res); });
        port40h2 = srv40h2.address().port;
        setContext('bundle', 'tb40');
        setContext('env', 'dev');
        setContext('gina', {
            ports: { 'http/1.1': { http: {} }, 'http/2.0': { http: {} } },
            config: { envConf: { tb40: { dev: {
                server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65530 },
                host: '127.0.0.1', hostname: 'http://127.0.0.1:65530'
            } } } }
        });
    });
    after40(function() {
        try { if (typeof srv40h1.closeAllConnections === 'function') { srv40h1.closeAllConnections(); } } catch (e) {}
        try { srv40h1.close(); } catch (e) {}
        sess40h2.forEach(function(sess) { try { sess.destroy(); } catch (e) {} });
        try { srv40h2.close(); } catch (e) {}
    });

    function settle() { return new Promise(function(resolve) { setImmediate(resolve); }); }
    function gate() { var r; var p = new Promise(function(res) { r = res; }); return { p: p, resolve: r }; }
    function freePort() {
        return new Promise(function(resolve) {
            var srv = net40.createServer();
            srv.listen(0, '127.0.0.1', function() {
                var p = srv.address().port;
                srv.close(function() { resolve(p); });
            });
        });
    }

    // Deterministic teardown for the real-server arms: the framework caches
    // the HTTP/2 client session (serverInstance._cached) and node keeps h1
    // keep-alive sockets alive — on node 22 the lingering handles held the
    // file's event loop open past the 120s file timeout (all subtests green,
    // file not ok). Destroy both sides explicitly; harmless when nothing is
    // cached.
    function destroyClientHandles(h) {
        try { h.inst.serverInstance._cached.forEach(function(v) { if (v && typeof v.destroy === 'function') { v.destroy(); } }); } catch (e) {}
        try { (h.inst.serverInstance._http2Sessions || []).forEach(function(sess) { if (sess && typeof sess.destroy === 'function') { sess.destroy(); } }); } catch (e) {}
    }

    function makeInst40() {
        var inst = SuperController40.createTestInstance({
            req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r40', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
            res: { setHeader: function(){}, end: function(){}, writeHead: function(){}, getHeaders: function(){ return {}; }, statusCode: 200 },
            options: {
                conf: {
                    bundle: 'tb40', encoding: 'utf-8',
                    server: { protocol: 'http/1.1', scheme: 'http',
                              coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                              supportedRequestMethods: { get: 1 } },
                    content: { routing: { r40: {} } }
                },
                rule: 'r40', control: 'act', bundle: 'tb40', controller: '/controllers/t40.js'
            }
        });
        inst.serverInstance = { _cached: new Map(), _cachePath: '/tmp/gina-t40', _cacheIsEnabled: 'false', _http2Sessions: [] };
        var thrown = [];
        inst.throwError = function() {
            var a = arguments[0];
            thrown.push((a instanceof Error) ? { msg: a.message, status: a.status } : { msg: String(a && a.message || a), status: a && a.status });
        };
        return { inst: inst, thrown: thrown };
    }

    // Facade drive (#B475): the fluent handle is a per-call channel, so a bare
    // inst.emit no longer reaches it — every arm drives the REAL upstream and
    // resolves once the delivery reached the registered callback. The callback
    // is wrapped only to signal arrival; its return value and any throw pass
    // through untouched, so the guards under test see the real thing. Every
    // assertion still FILTERS the spy by its own marker instead of counting
    // totals (the HTTP/2 transport may call throwError on its own).
    function driveFacade(h, cb, proto) {
        var isH2 = proto === 'http/2.0';
        var port = isH2 ? port40h2 : port40h1;
        var handle = h.inst.query({
            protocol: proto || 'http/1.1', scheme: 'http',
            hostname: isH2 ? 'http://127.0.0.1:' + port : '127.0.0.1', host: '127.0.0.1',
            port: port, path: '/x', method: 'GET', requestTimeout: '2s',
            headers: { 'content-type': 'application/json' }
        }, {});
        assert.equal(typeof (handle && handle.onComplete), 'function', 'query() without a callback must return the {onComplete} handle');
        var g = gate();
        handle.onComplete(function() { g.resolve(); return cb.apply(this, arguments); });
        return g.p;
    }
    function ownMatches(thrown, re) {
        return thrown.filter(function(t) { return re.test(t.msg); });
    }

    it('facade baseline: a plain callback is invoked (false, data), no guard activity', async function() {
        var h = makeInst40(), got = [];
        await driveFacade(h, function(err, data) { got.push([err, data && data.ok]); });
        await settle();
        assert.deepStrictEqual(got, [[false, true]]);
        assert.equal(ownMatches(h.thrown, /Controller Query Exception/).length, 0);
    });

    it('facade regression: a SYNC callback throw still routes to the sync catch (throwError 500)', async function() {
        var h = makeInst40();
        await driveFacade(h, function() { throw new Error('t40-sync-boom'); });
        await settle();
        var m = ownMatches(h.thrown, /t40-sync-boom/);
        assert.equal(m.length, 1, 'the sync throw must reach throwError exactly once');
        assert.match(m[0].msg, /Controller Query Exception while catching back\./);
        assert.equal(m[0].status, 500);
    });

    it('facade: an async callback rejection is owned — throwError(500), async marker, nothing floats (HTTP/1)', async function() {
        var h = makeInst40();
        await driveFacade(h, async function() { throw new Error('t40-async-boom'); });
        await settle();
        var m = ownMatches(h.thrown, /t40-async-boom/);
        assert.equal(m.length, 1, 'the rejection must reach throwError (pre-fix measured: 0 + an unhandledRejection)');
        assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
        assert.equal(m[0].status, 500);
        // node:test fails the active test on any REAL unhandled rejection —
        // passing IS the nothing-floats assertion.
    });

    it('facade: an async callback rejection is owned through the HTTP/2 facade too', async function() {
        var h = makeInst40();
        await driveFacade(h, async function() { throw new Error('t40-h2-async-boom'); }, 'http/2.0');
        await settle();
        var m = ownMatches(h.thrown, /t40-h2-async-boom/);
        assert.equal(m.length, 1, 'the rejection must reach throwError through the HTTP/2 facade');
        assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
        assert.equal(m[0].status, 500);
        destroyClientHandles(h);
    });

    it('facade: an async callback that RESOLVES stays silent — no false positive', async function() {
        var h = makeInst40();
        await driveFacade(h, async function() { return 'fine'; });
        await settle();
        assert.equal(ownMatches(h.thrown, /Controller Query Exception/).length, 0, 'a resolving thenable must not trigger the guard');
    });

    it('a non-Error rejection reason is String()-coerced into the exception detail', async function() {
        var h = makeInst40();
        await driveFacade(h, function() { return Promise.reject(null); });
        await settle();
        var m = ownMatches(h.thrown, /Controller Query Exception on async callback rejection\./);
        assert.equal(m.length, 1, 'a plain function returning a rejected promise is a thenable result too');
        assert.ok(/null$/.test(m[0].msg), 'String(null) must close the detail');
        assert.equal(m[0].status, 500);
    });

    it('a callback that responded before rejecting still reaches throwError (the #B31 released-response seam decides the outcome)', async function() {
        // renderTEXT() is the lightest terminal exit — it releases
        // local.req/res/next. The async guard then builds its exception from
        // local.options (which survives release) and calls self.throwError;
        // on a live instance the real throwError absorbs the late call per
        // #B31 (§22 owns that pin) — the spy here proves the guard itself
        // still fires post-release.
        var h = makeInst40();
        await driveFacade(h, async function() {
            h.inst.renderTEXT('done');
            throw new Error('t40-late-boom');
        });
        await settle();
        var m = ownMatches(h.thrown, /t40-late-boom/);
        assert.equal(m.length, 1, 'the late rejection must still reach throwError');
        assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
    });

    it('DIRECT callback, HTTP/1, real upstream 200: an async rejection is owned (the documented form)', async function() {
        var srv = http40.createServer(function(q, r) { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}'); });
        await new Promise(function(res) { srv.listen(0, '127.0.0.1', res); });
        try {
            var port = srv.address().port;
            var h = makeInst40(), g = gate();
            h.inst.query({ protocol: 'http/1.1', scheme: 'http', hostname: '127.0.0.1', host: '127.0.0.1',
                           port: port, path: '/x', method: 'GET', requestTimeout: '2s',
                           headers: { 'content-type': 'application/json' } }, {},
                async function(err, data) { g.resolve([err, data && data.ok]); throw new Error('t40-h1-direct-boom'); });
            var inv = await g.p;
            await settle(); await settle();
            assert.deepStrictEqual(inv, [false, true], 'the success delivery must invoke the direct callback');
            var m = ownMatches(h.thrown, /t40-h1-direct-boom/);
            assert.equal(m.length, 1, 'the rejection must reach throwError (pre-fix measured: floated)');
            assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
            assert.equal(m[0].status, 500);
        } finally {
            destroyClientHandles(h);
            if (typeof srv.closeAllConnections === 'function') { srv.closeAllConnections(); }
            srv.close();
        }
    });

    it('DIRECT callback, HTTP/2, real upstream 200: an async rejection is owned', async function() {
        var srv = http240.createServer();
        var srvSessions = [];
        srv.on('session', function(sess) { srvSessions.push(sess); });
        srv.on('stream', function(stream) { stream.respond({ ':status': 200, 'content-type': 'application/json' }); stream.end('{"ok":true}'); });
        await new Promise(function(res) { srv.listen(0, '127.0.0.1', res); });
        try {
            var port = srv.address().port;
            var h = makeInst40(), g = gate();
            h.inst.query({ protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + port, host: '127.0.0.1',
                           port: port, path: '/x', method: 'GET', requestTimeout: '2s',
                           headers: { 'content-type': 'application/json' } }, {},
                async function(err, data) { g.resolve([err, data && data.ok]); throw new Error('t40-h2-direct-boom'); });
            var inv = await g.p;
            await settle(); await settle();
            assert.deepStrictEqual(inv, [false, true], 'the success delivery must invoke the direct callback');
            var m = ownMatches(h.thrown, /t40-h2-direct-boom/);
            assert.equal(m.length, 1, 'the rejection must reach throwError');
            assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
            assert.equal(m[0].status, 500);
        } finally {
            destroyClientHandles(h);
            srvSessions.forEach(function(sess) { try { sess.destroy(); } catch (e) {} });
            srv.close();
        }
    });

    it('DIRECT callback, HTTP/1, transport-error delivery (dead port): an async rejection is owned', async function() {
        var port = await freePort();
        var h = makeInst40(), g = gate();
        h.inst.query({ protocol: 'http/1.1', scheme: 'http', hostname: '127.0.0.1', host: '127.0.0.1',
                       port: port, path: '/x', method: 'GET', requestTimeout: '2s',
                       headers: { 'content-type': 'application/json' } }, {},
            async function(err) { g.resolve(!!err); throw new Error('t40-h1-errpath-boom'); });
        var gotErr = await g.p;
        await settle(); await settle();
        assert.equal(gotErr, true, 'the error delivery must hand the callback a truthy err');
        var m = ownMatches(h.thrown, /t40-h1-errpath-boom/);
        assert.equal(m.length, 1, 'the rejection must reach throwError (pre-fix measured: floated)');
        assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
        assert.equal(m[0].status, 500);
        destroyClientHandles(h);
    });

    it('DIRECT callback, HTTP/2, transport-error delivery (dead port): an async rejection is owned', async function() {
        var port = await freePort();
        var h = makeInst40(), g = gate();
        h.inst.query({ protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + port, host: '127.0.0.1',
                       port: port, path: '/x', method: 'GET', requestTimeout: '2s',
                       headers: { 'content-type': 'application/json' } }, {},
            async function(err) { g.resolve(!!err); throw new Error('t40-h2-errpath-boom'); });
        var gotErr = await g.p;
        await settle(); await settle();
        assert.equal(gotErr, true, 'the typed-error delivery must hand the callback a truthy err');
        var m = ownMatches(h.thrown, /t40-h2-errpath-boom/);
        assert.equal(m.length, 1, 'the rejection must reach throwError');
        assert.match(m[0].msg, /Controller Query Exception on async callback rejection\./);
        assert.equal(m[0].status, 500);
        destroyClientHandles(h);
    });

    it('SUBTRACT — the pre-fix bare dispatch discards the rejection (inline pre-fix listener shape)', async function() {
        // Pre-fix listener shape: bare `return cb(err, data)` inside a
        // sync-only try/catch — the pre-#B399-facade bytes. The promise is
        // pre-absorbed: node:test fails the active test on any REAL unhandled
        // rejection, so the floats-to-process half of the pre-fix behaviour
        // is carried by the measured probe record, not re-created here.
        var h = makeInst40();
        var p = Promise.reject(new Error('unowned'));
        p.catch(function() {});
        var cb = function() { return p; };
        h.inst.once('query#complete', function(err, data) {
            try { return cb(err, data); } catch (e) { h.inst.throwError(new Error('sync-only')); }
        });
        h.inst.emit('query#complete', false, { ok: true });
        await settle();
        assert.equal(ownMatches(h.thrown, /Controller Query Exception|unowned|sync-only/).length, 0,
            'bare dispatch: the rejection never reaches throwError — the pre-fix failure mode');
    });
});
