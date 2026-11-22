'use strict';
/**
 * Observable application-event inspection wiring (#EVTBUS)
 *
 * Exercises the REAL lib/inspector-events.emit() behaviour (gate, ALS push,
 * live frame, captureArgs metadata gating — §01) and source-pins the
 * cross-cutting wiring that carries an emitted event to the Inspector: the
 * per-request _devEventLog ALS buffer + self.emitEvent pass-through (controller,
 * §02), the captureArgs boot seed (gna.js, §03), the lib registration
 * (lib/index.js, §04), and the settings-template default (§05). The live
 * forwarders (server engines) + the user.events snapshot (render delegates) are
 * pinned in §06+ as those slices land.
 */
var { describe, it, before, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var FW     = require('../fw');
var { AsyncLocalStorage } = require('async_hooks');

var read = function(rel) { return fs.readFileSync(path.join(FW, rel), 'utf8'); };
var inspectorEvents = require(path.join(FW, 'lib/inspector-events/src/main.js'));
var commentStrip = require('../strip-comments');


// ─── 01 — emit(): real behaviour (gate, ALS push, live frame, captureArgs) ───
describe('01 - inspector-events.emit(): behaviour', function() {

    var savedGina, savedDev, frames;
    var onEvent = function(f) { frames.push(f); };

    beforeEach(function() {
        savedGina = process.gina;
        savedDev  = process.env.NODE_ENV_IS_DEV;
        frames    = [];
        process.on('inspector#event', onEvent);
        process.gina = {
            _queryALS                   : new AsyncLocalStorage(),
            _inspectorWindowUntil       : 0,
            _inspectorEventsCaptureArgs : false
        };
    });
    afterEach(function() {
        process.removeListener('inspector#event', onEvent);
        process.gina = savedGina;
        if (savedDev === undefined) { delete process.env.NODE_ENV_IS_DEV; }
        else { process.env.NODE_ENV_IS_DEV = savedDev; }
    });

    it('no-ops (false) when the gate is closed (no dev, no window)', function() {
        delete process.env.NODE_ENV_IS_DEV;
        var r = process.gina._queryALS.run({ _devEventLog: [] }, function() {
            return inspectorEvents.emit('x.y', { a: 1 });
        });
        assert.equal(r, false);
        assert.equal(frames.length, 0);
    });

    it('emits a LIVE frame (true) when gate open but outside a request context (no store)', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        // not inside .run() → getStore() is undefined → buffer push skipped, but the
        // live inspector#event frame still ships (Slice 2b lifecycle/background emit).
        assert.equal(inspectorEvents.emit('x.y', { a: 1 }), true);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].name, 'x.y');
        assert.equal(frames[0].source, 'app');
        assert.equal(frames[0].meta, undefined);   // captureArgs off in beforeEach
    });

    it('no-ops (false) on an invalid name', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            assert.equal(inspectorEvents.emit('', { a: 1 }), false);
            assert.equal(inspectorEvents.emit(null), false);
            assert.equal(inspectorEvents.emit(42), false);
        });
        assert.equal(frames.length, 0);
    });

    it('pushes a {type,id,name,t} entry and emits a live frame under the dev gate', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            var r = inspectorEvents.emit('order.created');
            assert.equal(r, true);
            assert.equal(store._devEventLog.length, 1);
            var e = store._devEventLog[0];
            assert.equal(e.type, 'event');
            assert.equal(e.name, 'order.created');
            assert.ok(typeof e.id === 'string' && e.id.indexOf('ev-') === 0);
            assert.equal(typeof e.t, 'number');
        });
        assert.equal(frames.length, 1);
        assert.equal(frames[0].name, 'order.created');
        assert.ok(frames[0].id && typeof frames[0].t === 'number');
    });

    it('captures under an open instrumentation window even when NOT in dev', function() {
        delete process.env.NODE_ENV_IS_DEV;
        process.gina._inspectorWindowUntil = Date.now() + 60000;
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            assert.equal(inspectorEvents.emit('payment.received'), true);
        });
        assert.equal(frames.length, 1);
    });

    it('captureArgs=false (default) keeps metadata VALUES off the entry AND the frame', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        process.gina._inspectorEventsCaptureArgs = false;
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('order.created', { orderId: 7, secret: 'sk_live_x' });
            assert.equal(store._devEventLog[0].meta, undefined);
        });
        assert.equal(frames[0].meta, undefined);
    });

    it('captureArgs=true rides metadata on the entry AND the frame', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        process.gina._inspectorEventsCaptureArgs = true;
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('order.created', { orderId: 7 });
            assert.deepEqual(store._devEventLog[0].meta, { orderId: 7 });
        });
        assert.deepEqual(frames[0].meta, { orderId: 7 });
    });

    it('gives each event a unique id within a request', function() {
        process.env.NODE_ENV_IS_DEV = 'true';
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('a');
            inspectorEvents.emit('b');
            assert.notEqual(store._devEventLog[0].id, store._devEventLog[1].id);
        });
    });
});


// ─── 02 — controller: _devEventLog buffer + self.emitEvent pass-through ──────
describe('02 - controller: _devEventLog buffer + self.emitEvent', function() {

    var src;
    before(function() { src = read('core/controller/controller.js'); });

    it('initialises req._devEventLog alongside the query/AI buffers', function() {
        assert.ok(/req\._devEventLog\s*=\s*\[\]/.test(src));
    });
    it('mirrors it onto local._eventLog', function() {
        assert.ok(/local\._eventLog\s*=\s*req\._devEventLog/.test(src));
    });
    it('threads it as a 3rd key through the SAME _queryALS store', function() {
        assert.ok(/enterWith\(\{\s*_devQueryLog:\s*req\._devQueryLog,\s*_devAiLog:\s*req\._devAiLog,\s*_devEventLog:\s*req\._devEventLog\s*\}\)/.test(src));
    });
    it('exposes self.emitEvent as a thin pass-through to lib.inspectorEvents.emit', function() {
        assert.ok(/this\.emitEvent\s*=\s*function\s*\(name,\s*metadata\)/.test(src));
        assert.ok(/lib\.inspectorEvents\.emit\(name,\s*metadata\)/.test(src));
    });
});


// ─── 03 — gna: inspector.events.captureArgs boot seed ────────────────────────
describe('03 - gna: inspector.events.captureArgs boot seed', function() {

    var src;
    before(function() { src = read('core/gna.js'); });

    it('reads settings.inspector.events and seeds process.gina._inspectorEventsCaptureArgs', function() {
        assert.ok(/inspector\.events\b/.test(src), 'reads the inspector.events settings block');
        assert.ok(/_inspectorEventsCaptureArgs\s*=\s*\(_evInspConf\.captureArgs === true\)/.test(src));
    });
    it('fail-closes to false on error', function() {
        assert.ok(/process\.gina\._inspectorEventsCaptureArgs\s*=\s*false/.test(src));
    });
});


// ─── 04 — lib/index: inspectorEvents registration ────────────────────────────
describe('04 - lib/index: inspectorEvents registration', function() {

    var src;
    before(function() { src = read('lib/index.js'); });

    it('registers inspectorEvents via _require (stateless, hot-reloadable)', function() {
        assert.ok(/inspectorEvents\s*:\s*_require\('\.\/inspector-events'\)/.test(src));
    });
});


// ─── 05 — settings template: inspector.events.captureArgs default off ────────
describe('05 - settings template: inspector.events.captureArgs default', function() {

    var conf;
    before(function() {
        var raw = read('core/template/conf/settings.json');
        // The template carries // and /* */ comments (requireJSON strips them at
        // load); mirror that here before JSON.parse.
        raw  = commentStrip.all(raw);
        conf = JSON.parse(raw);
    });

    it('declares inspector.events.captureArgs = false (opt-in, default off)', function() {
        assert.ok(conf.inspector && conf.inspector.events, 'inspector.events block exists');
        assert.equal(conf.inspector.events.captureArgs, false);
    });
});


// ─── 06 — server.isaac: SSE inspector#event forwarder ────────────────────────
describe('06 - server.isaac: SSE inspector#event forwarder', function() {

    var src;
    before(function() { src = read('core/server.isaac.js'); });

    it('defines _agEventListener writing an event: event SSE frame', function() {
        assert.ok(src.indexOf('var _agEventListener = function') > -1);
        assert.ok(src.indexOf('event: event') > -1, 'distinct SSE event name (not data/log/token)');
    });
    it('registers + deregisters on inspector#event', function() {
        assert.ok(src.indexOf("process.on('inspector#event', _agEventListener)") > -1);
        assert.ok(src.indexOf("process.removeListener('inspector#event', _agEventListener)") > -1);
    });
});


// ─── 07 — server.js: WS inspector#event forwarder ────────────────────────────
describe('07 - server.js: WS inspector#event forwarder', function() {

    var src;
    before(function() { src = read('core/server.js'); });

    it('defines _wsEventListener sending an event: event envelope', function() {
        assert.ok(src.indexOf('var _wsEventListener = function') > -1);
        assert.ok(src.indexOf("event: 'event', data: payload") > -1);
    });
    it('registers + deregisters on inspector#event', function() {
        assert.ok(src.indexOf("process.on('inspector#event', _wsEventListener)") > -1);
        assert.ok(src.indexOf("process.removeListener('inspector#event', _wsEventListener)") > -1);
    });
});


// ─── 08 — server.js: SSE agent carries data + log + token + event ────────────
describe('08 - server.js: SSE agent carries data + log + token + event', function() {

    var src;
    before(function() { src = read('core/server.js'); });

    // The genuine server.js HTTP/1 SSE /_gina/agent handler (distinct from the WS
    // transport above) now forwards all four frame types — inspector#data,
    // logger#default, inspector#token (#AISTREAM) and inspector#event (#EVTBUS) —
    // matching the isaac SSE and the server.js WS transport. token + event were a
    // shared parity gap, closed together in one slice.
    it('defines _agTokenListener + _agEventListener writing distinct SSE frames', function() {
        assert.ok(src.indexOf('var _agTokenListener = function') > -1, 'SSE token forwarder defined');
        assert.ok(src.indexOf('var _agEventListener = function') > -1, 'SSE event forwarder defined');
        assert.ok(src.indexOf("response.write('event: token") > -1, 'distinct SSE token frame');
        assert.ok(src.indexOf("response.write('event: event") > -1, 'distinct SSE event frame');
    });
    it('registers + deregisters the SSE token + event forwarders', function() {
        assert.ok(src.indexOf("process.on('inspector#data', _agDataListener)") > -1, 'SSE data forwarder present');
        assert.ok(src.indexOf("process.on('inspector#token', _agTokenListener)") > -1, 'registers token');
        assert.ok(src.indexOf("process.on('inspector#event', _agEventListener)") > -1, 'registers event');
        assert.ok(src.indexOf("process.removeListener('inspector#token', _agTokenListener)") > -1, 'deregisters token');
        assert.ok(src.indexOf("process.removeListener('inspector#event', _agEventListener)") > -1, 'deregisters event');
    });
});


// ─── 09 — render delegates + window emit: user.events snapshot ───────────────
describe('09 - render delegates + window emit: user.events snapshot', function() {

    it('render-json attaches _gdUser.events gated on local._eventLog.length', function() {
        var src = read('core/controller/controller.render-json.js');
        assert.ok(/if \(local\._eventLog && local\._eventLog\.length > 0\) \{\s*_gdUser\.events = local\._eventLog;/.test(src));
    });
    it('render-swig attaches data.page.events on BOTH cache paths', function() {
        var src = read('core/controller/controller.render-swig.js');
        var matches = src.match(/data\.page\.events = local\._eventLog;/g) || [];
        assert.equal(matches.length, 2, 'cache-hit + cache-miss');
    });
    it('render-nunjucks attaches data.page.events', function() {
        var src = read('core/controller/controller.render-nunjucks.js');
        assert.ok(/data\.page\.events = local\._eventLog;/.test(src));
    });
    it('inspector-window-emit attaches _gdUser.events (prod-window path)', function() {
        var src = read('core/controller/inspector-window-emit.js');
        assert.ok(/if \(local\._eventLog && local\._eventLog\.length > 0\) \{\s*_gdUser\.events = local\._eventLog;/.test(src));
    });
});


// ─── 10 — SPA: Event tab wiring (src) ────────────────────────────────────────
describe('10 - SPA: Event tab wiring (src)', function() {

    var js, html;
    before(function() {
        js   = read('core/asset/plugin/src/vendor/gina/inspector/js/inspector.js');
        html = read('core/asset/plugin/src/vendor/gina/inspector/html/index.html');
    });

    it('declares an accumulating _eventBuf with a cap (not single-slot like tokens)', function() {
        assert.ok(/var _eventBuf\s*=\s*\[\]/.test(js));
        assert.ok(/var EVENT_BUF_MAX/.test(js));
    });
    it('appendAppEvent accumulates and renders via textContent (never innerHTML)', function() {
        assert.ok(/function appendAppEvent\(frame\)/.test(js));
        assert.ok(/_eventBuf\.push\(frame\)/.test(js));
        assert.ok(/_eventBuf\.length > EVENT_BUF_MAX/.test(js), 'caps the rolling buffer');
        var s = js.indexOf('function appendAppEvent');
        var e = js.indexOf('function formatEventBuffer', s);
        assert.ok(s > -1 && e > s);
        var blk = js.substring(s, e);
        assert.ok(blk.indexOf('.textContent') > -1, 'renders via textContent');
        assert.ok(blk.indexOf('.innerHTML') < 0, 'must not use innerHTML (untrusted event text)');
    });
    it('renderTab has a case events rendering the snapshot/buffer', function() {
        assert.ok(/case 'events':/.test(js));
        assert.ok(/renderAppEvents\(treeEl, u\.events\)/.test(js));
    });
    it('renders the Event tab even before a snapshot (!ginaData guard)', function() {
        assert.ok(/if \(name === 'events'\) \{ renderAppEvents\(treeEl, null\); return; \}/.test(js));
    });
    it('wires events into all three TAB_LAYOUTS presets', function() {
        var s   = js.indexOf('var TAB_LAYOUTS');
        var lay = js.substring(s, js.indexOf('};', s) + 2);
        assert.equal((lay.match(/'events'/g) || []).length, 3);
    });
    it('subscribes to the event frame at the 3 agent receive sites', function() {
        assert.equal((js.match(/es\.addEventListener\('event',/g) || []).length, 2, 'SSE: tryAgent + tryAgentPassive');
        assert.ok(/frame\.event === 'event'/.test(js), 'WS branch');
    });
    it('index.html declares the Events tab button + panel', function() {
        assert.ok(/data-tab="events"/.test(html));
        assert.ok(/id="tab-events"/.test(html));
        assert.ok(/id="tree-events"/.test(html));
    });
});


// ─── 11 — SPA: Event tab propagated to dist ──────────────────────────────────
describe('11 - SPA: Event tab propagated to dist', function() {

    var js, html;
    before(function() {
        js   = read('core/asset/plugin/dist/vendor/gina/inspector/inspector.js');
        html = read('core/asset/plugin/dist/vendor/gina/inspector/index.html');
    });

    it('dist inspector.js carries appendAppEvent + case events + the event listener', function() {
        assert.ok(/function appendAppEvent\(frame\)/.test(js));
        assert.ok(/case 'events':/.test(js));
        assert.ok(/es\.addEventListener\('event',/.test(js));
    });
    it('dist index.html carries the Events tab button + panel', function() {
        assert.ok(/data-tab="events"/.test(html));
        assert.ok(/id="tree-events"/.test(html));
    });
});


// ─── 12 — inspector-events: source discriminator + matchTopics (Slice 2a) ────
describe('12 - inspector-events: source discriminator + matchTopics', function() {

    var savedGina, savedDev, frames;
    var onEvent = function(f) { frames.push(f); };

    beforeEach(function() {
        savedGina = process.gina;
        savedDev  = process.env.NODE_ENV_IS_DEV;
        frames    = [];
        process.env.NODE_ENV_IS_DEV = 'true';
        process.on('inspector#event', onEvent);
        process.gina = {
            _queryALS                   : new AsyncLocalStorage(),
            _inspectorWindowUntil       : 0,
            _inspectorEventsCaptureArgs : false
        };
    });
    afterEach(function() {
        process.removeListener('inspector#event', onEvent);
        process.gina = savedGina;
        if (savedDev === undefined) { delete process.env.NODE_ENV_IS_DEV; }
        else { process.env.NODE_ENV_IS_DEV = savedDev; }
    });

    it('defaults source to "app" on the entry AND the frame', function() {
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('order.created');
            assert.equal(store._devEventLog[0].source, 'app');
        });
        assert.equal(frames[0].source, 'app');
    });

    it('rides an explicit source ("framework") on the entry AND the frame', function() {
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('account#save', null, 'framework');
            assert.equal(store._devEventLog[0].source, 'framework');
        });
        assert.equal(frames[0].source, 'framework');
    });

    it('source always rides even when captureArgs is off (unlike metadata)', function() {
        process.gina._inspectorEventsCaptureArgs = false;
        process.gina._queryALS.run({ _devEventLog: [] }, function() {
            var store = process.gina._queryALS.getStore();
            inspectorEvents.emit('account#save', { secret: 'x' }, 'framework');
            assert.equal(store._devEventLog[0].source, 'framework');
            assert.equal(store._devEventLog[0].meta, undefined, 'metadata stays captureArgs-gated');
        });
        assert.equal(frames[0].source, 'framework');
        assert.equal(frames[0].meta, undefined);
    });

    it('matchTopics: exact / trailing-* / leading-* / bare-* / connector-prefix / miss / bad input', function() {
        var m = inspectorEvents.matchTopics;
        assert.equal(m('account#save',     ['account#save']), true,  'exact');
        assert.equal(m('account#save',     ['account#*']),    true,  'trailing-* prefix');
        assert.equal(m('order#insert',     ['*#insert']),     true,  'leading-* suffix');
        assert.equal(m('anything',         ['*']),            true,  'bare-* matches all');
        assert.equal(m('N1QL:Order#fetch', ['N1QL:*']),       true,  'connector prefix');
        assert.equal(m('cache.miss',       ['account#*']),    false, 'miss');
        assert.equal(m('account#save',     []),               false, 'empty list matches nothing');
        assert.equal(m('account#save',     'account#*'),      false, 'non-array topics -> false');
        assert.equal(m(42,                 ['*']),            false, 'non-string name -> false');
    });
});


// ─── 13 — entity.js: Slice 2a entity-event bridge ────────────────────────────
describe('13 - entity.js: Slice 2a entity-event bridge', function() {

    var src;
    before(function() { src = read('core/model/entity.js'); });

    it('bridges a matched non-error emit via lib/inspector-events tagged source framework', function() {
        assert.ok(src.indexOf("require('lib/inspector-events')") > -1, 'reaches the emit module via the bare-module resolver');
        assert.ok(/matchTopics\(type,\s*process\.gina\._inspectorEventTopics\)/.test(src), 'gates on the topics allow-list');
        assert.ok(/\.emit\(type,\s*\{\s*ok:\s*!_evErr/.test(src), 'ships a framework-controlled {ok,error} summary, never raw rows');
        assert.ok(/,\s*'framework'\)/.test(src), "tags the bridged event source 'framework'");
    });
    it('is inert by default: skips error + requires a non-empty topics allow-list', function() {
        assert.ok(/!doError[\s\S]{0,160}?_inspectorEventTopics\.length/.test(src));
    });
    it('wraps the bridge in try/catch so a bridge failure never breaks entity.emit', function() {
        var s = src.indexOf('#EVTBUS Slice 2a');
        assert.ok(s > -1, 'bridge block present');
        var tryIdx   = src.indexOf('try {', s);
        var catchIdx = src.indexOf('} catch (_evBridgeErr)', tryIdx);
        assert.ok(tryIdx > s && catchIdx > tryIdx, 'bridge fully guarded by try/catch');
    });

    // Pure-logic replica of the gate -> match -> emit decision (live entity
    // instantiation isn't unit-reachable; the replica mirrors the source exactly,
    // reusing the REAL matchTopics so the matching semantics can't drift).
    it('replica: emits only for a non-error type matching a non-empty allow-list', function() {
        var calls = [];
        var ie = {
            matchTopics : inspectorEvents.matchTopics,
            emit        : function(name, meta, source) { calls.push({ name: name, meta: meta, source: source }); }
        };
        var bridge = function(type, err, topics) {
            var doError = (type === 'error');
            if (!doError && topics && topics.length) {
                if (ie.matchTopics(type, topics)) {
                    ie.emit(type, { ok: !err, error: (err && err.message) || null }, 'framework');
                }
            }
        };
        bridge('account#save', false, []);                         // empty list -> skip
        bridge('error', new Error('x'), ['*']);                    // error -> skip
        bridge('cache.miss', false, ['account#*']);                // no match -> skip
        assert.equal(calls.length, 0);
        bridge('account#save', false, ['account#*']);              // match, success
        bridge('account#save', new Error('boom'), ['account#*']);  // match, failure
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], { name: 'account#save', meta: { ok: true,  error: null },   source: 'framework' });
        assert.deepEqual(calls[1], { name: 'account#save', meta: { ok: false, error: 'boom' }, source: 'framework' });
    });
});


// ─── 14 — gna seed + settings template: events.topics allow-list ─────────────
describe('14 - gna seed + settings: events.topics allow-list', function() {

    it('gna seeds process.gina._inspectorEventTopics from settings (fail-closed [])', function() {
        var src = read('core/gna.js');
        assert.ok(/_inspectorEventTopics\s*=\s*Array\.isArray\(_evInspConf\.topics\)\s*\?\s*_evInspConf\.topics\.slice\(\)\s*:\s*\[\]/.test(src), 'seeds from settings.inspector.events.topics, default []');
        assert.ok(/process\.gina\._inspectorEventTopics\s*=\s*\[\]/.test(src), 'fail-closes to [] in the catch');
    });

    it('settings template declares inspector.events.topics = [] (default: bridge nothing)', function() {
        var raw = read('core/template/conf/settings.json');
        raw  = commentStrip.all(raw);
        var conf = JSON.parse(raw);
        assert.ok(conf.inspector && conf.inspector.events, 'inspector.events block exists');
        assert.ok(Array.isArray(conf.inspector.events.topics), 'topics is an array');
        assert.equal(conf.inspector.events.topics.length, 0, 'default empty = bridge nothing');
    });
});


// ─── 15 — model/index: Slice 2b connector-lifecycle bridge ───────────────────
describe('15 - model/index: Slice 2b connector-lifecycle bridge', function() {

    var src;
    before(function() { src = read('core/model/index.js'); });

    it('attaches an additive connector.on(ready) lifecycle listener', function() {
        assert.ok(src.indexOf("connector.on('ready'") > -1, 'additive lifecycle listener');
        assert.ok(src.indexOf("require('lib/inspector-events')") > -1, 'reaches the emit module via the bare-module resolver');
    });
    it('builds a <connector>#ready name and gates on the topics allow-list', function() {
        assert.ok(/_evName\s*=\s*_connector\s*\+\s*'#ready'/.test(src), 'builds <connector>#ready from the connector name');
        assert.ok(/matchTopics\(_evName,\s*process\.gina\._inspectorEventTopics\)/.test(src), 'gates on the topics allow-list');
        assert.ok(/_inspectorEventTopics\s*&&\s*process\.gina\._inspectorEventTopics\.length/.test(src), 'requires a non-empty allow-list (inert by default)');
    });
    it('ships a framework-controlled {ok,error} summary tagged source framework', function() {
        assert.ok(/_ie\.emit\(_evName,\s*\{\s*ok:\s*!_evErr/.test(src), 'ships {ok,...} from the ready err arg, never connection internals');
        assert.ok(/error:\s*\(_evErr\s*&&\s*_evErr\.message\)\s*\|\|\s*null/.test(src), 'error summary from the ready err arg');
        assert.ok(/,\s*'framework'\)/.test(src), "tags the bridged event source 'framework'");
    });
    it('attaches once in the construct-once branch, before onReady (no per-reconnect accumulation)', function() {
        var guardIdx = src.indexOf("typeof(self.connectors[_connector]) == 'undefined'");
        var ncIdx    = src.indexOf('new Connector(');
        var onIdx    = src.indexOf("connector.on('ready'");
        var orIdx    = src.indexOf('connector.onReady(');
        assert.ok(guardIdx > -1 && onIdx > guardIdx, 'inside the cache-miss / construct-once branch');
        assert.ok(ncIdx > -1 && onIdx > ncIdx, 'after new Connector()');
        assert.ok(orIdx > onIdx, 'before onReady (so an early ready is never missed)');
    });
    it('wraps the bridge in try/catch so a bridge failure never breaks connector setup', function() {
        var s = src.indexOf('#EVTBUS Slice 2b');
        assert.ok(s > -1, 'bridge block present');
        var tryIdx   = src.indexOf('try {', s);
        var catchIdx = src.indexOf('} catch (_evBridgeErr)', tryIdx);
        assert.ok(tryIdx > s && catchIdx > tryIdx, 'bridge fully guarded by try/catch');
    });

    // Pure-logic replica of the gate -> match -> emit decision (a live connector
    // reconnect isn't unit-reachable; the replica mirrors the source exactly,
    // reusing the REAL matchTopics so the matching semantics can't drift). The
    // ready err arg is `false` on a successful (re)connect, an Error on a failed one.
    it('replica: emits <connector>#ready only for a non-empty matching allow-list', function() {
        var calls = [];
        var ie = {
            matchTopics : inspectorEvents.matchTopics,
            emit        : function(name, meta, source) { calls.push({ name: name, meta: meta, source: source }); }
        };
        var bridge = function(connectorName, evErr, topics) {
            try {
                if (topics && topics.length) {
                    var evName = connectorName + '#ready';
                    if (ie.matchTopics(evName, topics)) {
                        ie.emit(evName, { ok: !evErr, error: (evErr && evErr.message) || null }, 'framework');
                    }
                }
            } catch (_e) {}
        };
        bridge('couchbase', false, []);                                 // empty list -> skip
        bridge('couchbase', false, ['account#*']);                      // no match -> skip
        bridge('mysql',     false, ['couchbase#*']);                    // mysql#ready vs couchbase#* -> skip
        assert.equal(calls.length, 0);
        bridge('couchbase', false, ['couchbase#ready']);                // exact, (re)connect ok
        bridge('couchbase', new Error('econnrefused'), ['couchbase#*']);// match, (re)connect failed
        bridge('couchbase', false, ['*#ready']);                        // leading-* suffix, ok
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0], { name: 'couchbase#ready', meta: { ok: true,  error: null },          source: 'framework' });
        assert.deepEqual(calls[1], { name: 'couchbase#ready', meta: { ok: false, error: 'econnrefused' }, source: 'framework' });
        assert.deepEqual(calls[2], { name: 'couchbase#ready', meta: { ok: true,  error: null },          source: 'framework' });
    });
});
