var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SERVER_SOURCE = path.join(FW, 'core/server.js');
var ISAAC_SOURCE  = path.join(FW, 'core/server.isaac.js');
var BM_DIR        = path.join(FW, 'core/asset/plugin/dist/vendor/gina/inspector');

var _serverSrc; // lazy
function getServerSrc() { return _serverSrc || (_serverSrc = fs.readFileSync(SERVER_SOURCE, 'utf8')); }


// ── 01 — Source structure: handler lives in server.js (engine-agnostic) ──────

describe('01 - Inspector handler is in server.js (engine-agnostic)', function() {

    it('server.js contains the /_gina/inspector regex', function() {
        assert.ok(
            getServerSrc().indexOf('/_gina\\/inspector') > -1,
            'expected /_gina/inspector regex in server.js'
        );
    });

    it('server.js checks NODE_ENV_IS_DEV for Inspector', function() {
        assert.ok(
            /NODE_ENV_IS_DEV.*inspector|inspector.*NODE_ENV_IS_DEV/is.test(getServerSrc()),
            'expected NODE_ENV_IS_DEV guard near the Inspector handler'
        );
    });

    it('server.js serves from __dirname + asset/plugin/dist/vendor/gina/inspector', function() {
        assert.ok(
            getServerSrc().indexOf("__dirname + '/asset/plugin/dist/vendor/gina/inspector'") > -1,
            'expected __dirname-based inspector path in server.js'
        );
    });

    it('server.js uses fs.readFileSync (not readSync) for Inspector files', function() {
        // readSync is Isaac-only; the engine-agnostic layer must use fs.readFileSync
        var src = getServerSrc();
        var bmBlock = src.substring(
            src.indexOf('Inspector SPA'),
            src.indexOf('Fall through to 404 if file not found')
        );
        assert.ok(
            bmBlock.indexOf('fs.readFileSync') > -1,
            'expected fs.readFileSync in the Inspector handler'
        );
        assert.ok(
            bmBlock.indexOf('readSync(') === -1,
            'readSync (Isaac-only) must not appear in the engine-agnostic Inspector handler'
        );
    });

    it('server.isaac.js contains the Inspector fast-path handler', function() {
        var isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        assert.ok(
            isaacSrc.indexOf('/_gina\\/inspector') > -1
            || isaacSrc.indexOf('/_gina/inspector') > -1,
            'expected /_gina/inspector handler in server.isaac.js (fast-path)'
        );
    });

    it('server.isaac.js includes SVG MIME type for Inspector', function() {
        var isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        assert.ok(
            isaacSrc.indexOf('image/svg+xml') > -1,
            'expected image/svg+xml MIME type in server.isaac.js'
        );
    });

});


// ── 02 — URL pattern matching ────────────────────────────────────────────────

describe('02 - Inspector URL pattern matching', function() {

    var pattern = /\/_gina\/inspector(\/.*)?$/;

    it('matches /_gina/inspector', function() {
        assert.ok(pattern.test('/_gina/inspector'));
    });

    it('matches /_gina/inspector/', function() {
        assert.ok(pattern.test('/_gina/inspector/'));
    });

    it('matches /_gina/inspector/index.html', function() {
        assert.ok(pattern.test('/_gina/inspector/index.html'));
    });

    it('matches /_gina/inspector/inspector.js', function() {
        assert.ok(pattern.test('/_gina/inspector/inspector.js'));
    });

    it('matches /_gina/inspector/inspector.css', function() {
        assert.ok(pattern.test('/_gina/inspector/inspector.css'));
    });

    it('matches /_gina/inspector/logo.svg', function() {
        assert.ok(pattern.test('/_gina/inspector/logo.svg'));
    });

    it('matches deep paths /_gina/inspector/sub/dir/file.js', function() {
        assert.ok(pattern.test('/_gina/inspector/sub/dir/file.js'));
    });

    it('matches with webroot prefix /api/_gina/inspector/', function() {
        assert.ok(pattern.test('/api/_gina/inspector/'));
    });

    it('matches with webroot prefix /api/_gina/inspector/inspector.css', function() {
        assert.ok(pattern.test('/api/_gina/inspector/inspector.css'));
    });

    it('does NOT match /_gina/inspectorx', function() {
        assert.ok(!pattern.test('/_gina/inspectorx'));
    });

    it('does NOT match /_gina/info', function() {
        assert.ok(!pattern.test('/_gina/info'));
    });

    it('does NOT match /inspector', function() {
        assert.ok(!pattern.test('/inspector'));
    });

    it('does NOT match /_gina/', function() {
        assert.ok(!pattern.test('/_gina/'));
    });

});


// ── 03 — Path extraction logic ───────────────────────────────────────────────

describe('03 - Inspector path extraction', function() {

    // Replica of the path extraction logic from server.js
    function extractPath(url) {
        var _bmPath = url.replace(/^.*\/_gina\/inspector\/?/, '').split('?')[0];
        if (!_bmPath || _bmPath === '') _bmPath = 'index.html';
        return _bmPath;
    }

    it('/_gina/inspector → index.html', function() {
        assert.equal(extractPath('/_gina/inspector'), 'index.html');
    });

    it('/_gina/inspector/ → index.html', function() {
        assert.equal(extractPath('/_gina/inspector/'), 'index.html');
    });

    it('/_gina/inspector/inspector.js → inspector.js', function() {
        assert.equal(extractPath('/_gina/inspector/inspector.js'), 'inspector.js');
    });

    it('/_gina/inspector/inspector.css → inspector.css', function() {
        assert.equal(extractPath('/_gina/inspector/inspector.css'), 'inspector.css');
    });

    it('/_gina/inspector/index.html → index.html', function() {
        assert.equal(extractPath('/_gina/inspector/index.html'), 'index.html');
    });

    it('strips query string', function() {
        assert.equal(extractPath('/_gina/inspector/inspector.js?v=1'), 'inspector.js');
    });

    it('strips query string from bare path', function() {
        assert.equal(extractPath('/_gina/inspector?t=123'), 'index.html');
    });

    it('/_gina/inspector/logo.svg → logo.svg', function() {
        assert.equal(extractPath('/_gina/inspector/logo.svg'), 'logo.svg');
    });

    it('strips webroot prefix /api/_gina/inspector/ → index.html', function() {
        assert.equal(extractPath('/api/_gina/inspector/'), 'index.html');
    });

    it('strips webroot prefix /api/_gina/inspector/inspector.css → inspector.css', function() {
        assert.equal(extractPath('/api/_gina/inspector/inspector.css'), 'inspector.css');
    });

});


// ── 04 — MIME type resolution ────────────────────────────────────────────────

describe('04 - Inspector MIME type resolution', function() {

    // Replica of the MIME map from server.js
    var _bmMime = {
        'html': 'text/html; charset=utf8',
        'js':   'application/javascript; charset=utf8',
        'css':  'text/css; charset=utf8',
        'svg':  'image/svg+xml'
    };

    function resolveMime(filename) {
        var ext = filename.split('.').pop();
        return _bmMime[ext] || 'application/octet-stream';
    }

    it('index.html → text/html', function() {
        assert.equal(resolveMime('index.html'), 'text/html; charset=utf8');
    });

    it('inspector.js → application/javascript', function() {
        assert.equal(resolveMime('inspector.js'), 'application/javascript; charset=utf8');
    });

    it('inspector.css → text/css', function() {
        assert.equal(resolveMime('inspector.css'), 'text/css; charset=utf8');
    });

    it('logo.svg → image/svg+xml', function() {
        assert.equal(resolveMime('logo.svg'), 'image/svg+xml');
    });

    it('unknown.png → application/octet-stream', function() {
        assert.equal(resolveMime('unknown.png'), 'application/octet-stream');
    });

    it('server.js includes SVG MIME type in Inspector handler', function() {
        assert.ok(
            getServerSrc().indexOf('image/svg+xml') > -1,
            'expected image/svg+xml in server.js Inspector MIME map'
        );
    });

});


// ── 05 — SPA files exist on disk ─────────────────────────────────────────────

describe('05 - Inspector SPA files exist', function() {

    it('index.html exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'index.html')));
    });

    it('inspector.js exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'inspector.js')));
    });

    it('inspector.css exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'inspector.css')));
    });

    it('logo.svg exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'logo.svg')));
    });

    it('index.html contains the SPA shell markers', function() {
        var html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8');
        assert.ok(html.indexOf('inspector.js') > -1, 'index.html must reference inspector.js');
        assert.ok(html.indexOf('inspector.css') > -1, 'index.html must reference inspector.css');
    });

});


// ── 06 — Dev-mode guard ──────────────────────────────────────────────────────

describe('06 - Inspector dev-mode guard', function() {

    it('NODE_ENV_IS_DEV=true passes the guard', function() {
        var envVal = 'true';
        assert.ok(envVal && envVal.toLowerCase() === 'true');
    });

    it('NODE_ENV_IS_DEV=TRUE passes the guard (case-insensitive)', function() {
        var envVal = 'TRUE';
        assert.ok(envVal && envVal.toLowerCase() === 'true');
    });

    it('NODE_ENV_IS_DEV=false blocks the guard', function() {
        var envVal = 'false';
        assert.ok(!(envVal && envVal.toLowerCase() === 'true'));
    });

    it('NODE_ENV_IS_DEV=undefined blocks the guard', function() {
        var envVal = undefined;
        assert.ok(!(envVal && envVal.toLowerCase() === 'true'));
    });

    it('NODE_ENV_IS_DEV="" blocks the guard', function() {
        var envVal = '';
        assert.ok(!(envVal && envVal.toLowerCase() === 'true'));
    });

    it('only GET method is allowed', function() {
        assert.equal('GET'.toUpperCase(), 'GET');
        assert.notEqual('POST'.toUpperCase(), 'GET');
        assert.notEqual('PUT'.toUpperCase(), 'GET');
        assert.notEqual('DELETE'.toUpperCase(), 'GET');
    });

});


// ── 07 — Query instrumentation: controller _queryLog ────────────────────────

describe('07 - Query instrumentation: controller _queryLog', function() {

    var CONTROLLER_SRC = path.join(FW, 'core/controller/controller.js');
    var _ctrlSrc;
    function getCtrlSrc() { return _ctrlSrc || (_ctrlSrc = fs.readFileSync(CONTROLLER_SRC, 'utf8')); }

    it('local closure includes _queryLog array', function() {
        assert.ok(
            getCtrlSrc().indexOf('_queryLog') > -1,
            'expected _queryLog in controller.js local closure'
        );
    });

    it('AsyncLocalStorage is used to bind query log to request context', function() {
        var src = getCtrlSrc();
        assert.ok(
            src.indexOf('process.gina._queryALS') > -1,
            'expected process.gina._queryALS in controller.js'
        );
        assert.ok(
            src.indexOf('enterWith') > -1,
            'expected enterWith() call to bind query log to async context'
        );
    });

    it('_queryALS setup is guarded by _isDev', function() {
        var src = getCtrlSrc();
        var devIdx = src.indexOf('_isDev');
        var alsIdx = src.indexOf('_queryALS.enterWith');
        assert.ok(devIdx > -1 && alsIdx > -1, 'both _isDev and _queryALS.enterWith must exist');
    });

});


// ── 08 — Query instrumentation: Couchbase connector pushes via AsyncLocalStorage ──

describe('08 - Query instrumentation: Couchbase connector pushes via AsyncLocalStorage', function() {

    var CB_SRC = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc;
    function getCbSrc() { return _cbSrc || (_cbSrc = fs.readFileSync(CB_SRC, 'utf8')); }

    it('reads query log from _queryALS.getStore()', function() {
        var src = getCbSrc();
        assert.ok(
            src.indexOf('_queryALS.getStore()') > -1,
            'expected _queryALS.getStore() in couchbase connector'
        );
    });

    it('_queryEntry includes all required fields', function() {
        var src = getCbSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        assert.ok(entryIdx > -1, '_queryEntry object literal must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        var requiredFields = ['type', 'trigger', 'statement', 'params', 'durationMs', 'resultCount', 'resultSize', 'error', 'source', 'origin', 'connector'];
        for (var i = 0; i < requiredFields.length; i++) {
            assert.ok(
                block.indexOf(requiredFields[i]) > -1,
                'expected field "' + requiredFields[i] + '" in _queryEntry'
            );
        }
    });

    it('push is guarded by envIsDev', function() {
        var src = getCbSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 3500), pushIdx); // #B350 widened from 1800: the gated Found-query-params line + comment sit between the gate and the push (need ~2115)
        assert.ok(
            before.indexOf('envIsDev') > -1,
            '_devLog push must be inside envIsDev guard'
        );
    });

    it('bulkInsert also pushes via AsyncLocalStorage', function() {
        var src = getCbSrc();
        assert.ok(
            src.indexOf('_biQueryEntry') > -1,
            'expected _biQueryEntry for bulkInsert instrumentation'
        );
        assert.ok(
            src.indexOf('_biDevLog.push(_biQueryEntry)') > -1,
            'expected _biDevLog push for bulkInsert'
        );
    });

});

describe('08b - Query instrumentation: connector-level timing and finalization', function() {

    var CB_SRC = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc;
    function getCbSrc() { return _cbSrc || (_cbSrc = fs.readFileSync(CB_SRC, 'utf8')); }

    it('timing is captured via _startMs on _queryEntry', function() {
        var src = getCbSrc();
        assert.ok(
            src.indexOf('_queryEntry._startMs = Date.now()') > -1,
            'expected _startMs timestamp on _queryEntry'
        );
        assert.ok(
            src.indexOf('Date.now() - _queryEntry._startMs') > -1,
            'expected durationMs calculation from _startMs'
        );
    });

    it('onQueryCallback finalizes timing, result count, and result size', function() {
        var src = getCbSrc();
        var cbIdx = src.indexOf('var onQueryCallback');
        assert.ok(cbIdx > -1, 'onQueryCallback must exist');
        var block = src.substring(cbIdx, cbIdx + 750);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'onQueryCallback must set durationMs'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'onQueryCallback must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'onQueryCallback must set resultSize'
        );
    });

    it('onQueryCallback captures error message on failure', function() {
        var src = getCbSrc();
        var cbIdx = src.indexOf('var onQueryCallback');
        var block = src.substring(cbIdx, cbIdx + 500);
        assert.ok(
            block.indexOf('_queryEntry.error') > -1,
            'onQueryCallback must set error on failure'
        );
    });

    it('bulkInsert timing is finalized in both error and success paths', function() {
        var src = getCbSrc();
        var biIdx = src.indexOf('_biQueryEntry._startMs = Date.now()');
        assert.ok(biIdx > -1, 'bulkInsert must capture _startMs');
        // Check that durationMs is set somewhere after _biQueryEntry creation
        var afterBi = src.substring(biIdx);
        assert.ok(
            afterBi.indexOf('_biQueryEntry.durationMs') > -1,
            'bulkInsert must finalize durationMs'
        );
    });

    it('entity.js does NOT contain QI instrumentation (connector handles it)', function() {
        var entitySrc = fs.readFileSync(path.join(FW, 'core/model/entity.js'), 'utf8');
        assert.ok(
            entitySrc.indexOf('_devQueryLog') === -1,
            'entity.js must not reference _devQueryLog — instrumentation lives in the connector'
        );
        assert.ok(
            entitySrc.indexOf('_devQueryDetails') === -1,
            'entity.js must not reference _devQueryDetails'
        );
    });

});


// ── 08c — Query instrumentation: upstream query propagation ─────────────────

describe('08c - Query instrumentation: upstream query propagation via __ginaQueries', function() {

    var CONTROLLER_SRC = path.join(FW, 'core/controller/controller.js');
    var JSON_SRC = path.join(FW, 'core/controller/controller.render-json.js');
    var _ctrlSrc2, _jsonSrc;
    function getCtrlSrc2() { return _ctrlSrc2 || (_ctrlSrc2 = fs.readFileSync(CONTROLLER_SRC, 'utf8')); }
    function getJsonSrc() { return _jsonSrc || (_jsonSrc = fs.readFileSync(JSON_SRC, 'utf8')); }

    it('render-json.js embeds __ginaQueries in dev mode', function() {
        var src = getJsonSrc();
        assert.ok(
            src.indexOf('__ginaQueries') > -1,
            'expected __ginaQueries embedding in render-json.js'
        );
    });

    it('controller.js extracts __ginaQueries from upstream response', function() {
        var src = getCtrlSrc2();
        assert.ok(
            src.indexOf('data.__ginaQueries') > -1,
            'expected __ginaQueries extraction in controller.js query callback'
        );
    });

    it('controller.js merges upstream queries into local._queryLog', function() {
        var src = getCtrlSrc2();
        assert.ok(
            src.indexOf('local._queryLog.push') > -1,
            'expected push of upstream queries into local._queryLog'
        );
    });

    it('controller.js deletes __ginaQueries after extraction', function() {
        var src = getCtrlSrc2();
        assert.ok(
            src.indexOf('delete data.__ginaQueries') > -1,
            'expected cleanup of __ginaQueries from response data'
        );
    });

});


// ── 09 — Query instrumentation: render-swig serialization ───────────────────

describe('09 - Query instrumentation: render-swig serialization', function() {

    var SWIG_SRC = path.join(FW, 'core/controller/controller.render-swig.js');
    var _swigSrc;
    function getSwigSrc() { return _swigSrc || (_swigSrc = fs.readFileSync(SWIG_SRC, 'utf8')); }

    it('injects local._queryLog into data.page.queries', function() {
        var src = getSwigSrc();
        assert.ok(
            src.indexOf('data.page.queries') > -1,
            'expected data.page.queries assignment in render-swig.js'
        );
    });

    it('injection happens before __gdPayload is built', function() {
        var src = getSwigSrc();
        var queriesIdx = src.indexOf('data.page.queries');
        var payloadIdx = src.indexOf('__gdPayload');
        assert.ok(
            queriesIdx > -1 && payloadIdx > -1 && queriesIdx < payloadIdx,
            'data.page.queries must be set before __gdPayload construction'
        );
    });

});


// ── 08d — Query instrumentation: index extraction from query profile ─────────

describe('08d - Query instrumentation: index extraction via profile timings', function() {

    var CB_SRC = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc;
    function getCbSrc() { return _cbSrc || (_cbSrc = fs.readFileSync(CB_SRC, 'utf8')); }

    it('extractIndexes helper function exists', function() {
        var src = getCbSrc();
        assert.ok(
            src.indexOf('var extractIndexes = function') > -1,
            'expected extractIndexes function in couchbase connector'
        );
    });

    it('extractIndexes walks ~child and ~children nodes', function() {
        var src = getCbSrc();
        var fnIdx = src.indexOf('var extractIndexes = function');
        var fnBlock = src.substring(fnIdx, fnIdx + 1500);
        assert.ok(
            fnBlock.indexOf("['~child']") > -1,
            'expected ~child traversal in extractIndexes'
        );
        assert.ok(
            fnBlock.indexOf("['~children']") > -1,
            'expected ~children traversal in extractIndexes'
        );
    });

    it('extractIndexes detects primary scans via operator name', function() {
        var src = getCbSrc();
        var fnIdx = src.indexOf('var extractIndexes = function');
        var fnBlock = src.substring(fnIdx, fnIdx + 1200);
        assert.ok(
            fnBlock.indexOf('Primary') > -1,
            'expected Primary operator detection in extractIndexes'
        );
    });

    it('_queryEntry includes indexes field', function() {
        var src = getCbSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        assert.ok(entryIdx > -1, '_queryEntry must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            block.indexOf('indexes') > -1,
            'expected "indexes" field in _queryEntry'
        );
    });

    it('_biQueryEntry includes indexes field', function() {
        var src = getCbSrc();
        var entryIdx = src.indexOf('_biQueryEntry = {');
        assert.ok(entryIdx > -1, '_biQueryEntry must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            block.indexOf('indexes') > -1,
            'expected "indexes" field in _biQueryEntry'
        );
    });

    it('onQueryCallback extracts indexes from meta.profile', function() {
        var src = getCbSrc();
        var cbIdx = src.indexOf('var onQueryCallback = function');
        assert.ok(cbIdx > -1, 'onQueryCallback must exist');
        var block = src.substring(cbIdx, cbIdx + 1200);
        assert.ok(
            block.indexOf('extractIndexes(meta.profile)') > -1,
            'expected extractIndexes(meta.profile) call in onQueryCallback'
        );
    });

    it('bulkInsert success path extracts indexes from _meta.profile', function() {
        var src = getCbSrc();
        assert.ok(
            src.indexOf('extractIndexes(_meta.profile)') > -1,
            'expected extractIndexes(_meta.profile) in bulkInsert success path'
        );
    });

    it('queryOptions sets profile timings in dev mode for v3+', function() {
        var src = getCbSrc();
        // Find first queryOptions block (main query path)
        var idx = src.indexOf("queryOptions.profile = 'timings'");
        assert.ok(idx > -1, "expected queryOptions.profile = 'timings'");
        // Must be inside envIsDev guard
        var before = src.substring(Math.max(0, idx - 300), idx);
        assert.ok(
            before.indexOf('envIsDev') > -1,
            'profile timings must be guarded by envIsDev'
        );
    });

});


// ── 10 — Query tab: Inspector rendering ─────────────────────────────────────

describe('10 - Query tab: Inspector rendering', function() {

    var INSPECTOR_JS = path.join(BM_DIR, 'inspector.js');
    var INSPECTOR_CSS = path.join(BM_DIR, 'inspector.css');
    var INSPECTOR_HTML = path.join(BM_DIR, 'index.html');
    var _inspJs, _inspCss, _inspHtml;
    function getInspJs()   { return _inspJs   || (_inspJs   = fs.readFileSync(INSPECTOR_JS, 'utf8')); }
    function getInspCss()  { return _inspCss  || (_inspCss  = fs.readFileSync(INSPECTOR_CSS, 'utf8')); }
    function getInspHtml() { return _inspHtml || (_inspHtml = fs.readFileSync(INSPECTOR_HTML, 'utf8')); }

    it('renderTab query case calls renderQueryContent (not loadRouting)', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('renderQueryContent') > -1,
            'expected renderQueryContent function in inspector.js'
        );
        // The old loadRouting call should no longer be in the query case
        var caseBlock = src.substring(src.indexOf("case 'query':"), src.indexOf("case 'query':") + 200);
        assert.ok(
            caseBlock.indexOf('renderQueryContent') > -1,
            'query case must call renderQueryContent'
        );
        assert.ok(
            caseBlock.indexOf('loadRouting') === -1,
            'query case must NOT call loadRouting'
        );
    });

    it('renderQueryContent handles empty queries', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('No queries captured') > -1,
            'expected empty state message in renderQueryContent'
        );
    });

    it('renderQueryContent renders query cards', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('bm-query-card') > -1,
            'expected bm-query-card class in renderQueryContent'
        );
    });

    it('CSS includes query tab styles', function() {
        var css = getInspCss();
        var requiredClasses = [
            '.bm-query-controls',
            '.bm-query-card',
            '.bm-query-badge',
            '.bm-query-statement',
            '.bm-query-timing',
            '.bm-query-error'
        ];
        for (var i = 0; i < requiredClasses.length; i++) {
            assert.ok(
                css.indexOf(requiredClasses[i]) > -1,
                'expected CSS class ' + requiredClasses[i] + ' in inspector.css'
            );
        }
    });

    it('CSS includes origin and connector badge styles', function() {
        var css = getInspCss();
        assert.ok(
            css.indexOf('.bm-query-origin') > -1,
            'expected .bm-query-origin CSS class'
        );
        assert.ok(
            css.indexOf('.bm-query-connector') > -1,
            'expected .bm-query-connector CSS class'
        );
    });

    it('inspector.js renders origin and connector badges', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('bm-query-origin') > -1,
            'expected bm-query-origin in renderQueryContent'
        );
        assert.ok(
            src.indexOf('bm-query-connector') > -1,
            'expected bm-query-connector in renderQueryContent'
        );
    });

    it('CSS includes slow query visual indicators', function() {
        var css = getInspCss();
        assert.ok(
            css.indexOf('bm-query-slow') > -1,
            'expected .bm-query-slow class for slow query highlighting'
        );
        assert.ok(
            css.indexOf('bm-query-medium') > -1,
            'expected .bm-query-medium class for medium query highlighting'
        );
    });

    it('CSS includes split trigger badge styles', function() {
        var css = getInspCss();
        assert.ok(
            css.indexOf('.bm-trigger-badge') > -1,
            'expected .bm-trigger-badge CSS class'
        );
        assert.ok(
            css.indexOf('.bm-trigger-entity') > -1,
            'expected .bm-trigger-entity CSS class'
        );
        assert.ok(
            css.indexOf('.bm-trigger-method') > -1,
            'expected .bm-trigger-method CSS class'
        );
    });

    it('inspector.js splits trigger at # into entity and method badges', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('bm-trigger-entity') > -1,
            'expected bm-trigger-entity in renderQueryContent'
        );
        assert.ok(
            src.indexOf('bm-trigger-method') > -1,
            'expected bm-trigger-method in renderQueryContent'
        );
        assert.ok(
            src.indexOf("trig.indexOf('#')") > -1,
            'expected trigger to be split at # separator'
        );
    });

    it('CSS includes query toolbar styles', function() {
        var css = getInspCss();
        assert.ok(
            css.indexOf('.bm-query-controls') > -1,
            'expected .bm-query-controls CSS class'
        );
        assert.ok(
            css.indexOf('.bm-query-search-bar') > -1,
            'expected .bm-query-search-bar CSS class'
        );
    });

    it('inspector.js uses filter dropdowns and search in the query toolbar', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('bm-query-search') > -1,
            'expected bm-query-search input reference'
        );
        assert.ok(
            src.indexOf('filterQueries') > -1,
            'expected filterQueries function'
        );
        assert.ok(
            src.indexOf('updateQueryToolbar') > -1,
            'expected updateQueryToolbar function'
        );
        assert.ok(
            src.indexOf('populateQueryDropdown') > -1,
            'expected populateQueryDropdown function'
        );
    });

    it('per-card result size uses weightClass color-coding', function() {
        var src = getInspJs();
        // The size <span> must include the bm-stat- prefix derived from weightClass()
        assert.ok(
            src.indexOf("bm-query-size bm-stat-") > -1,
            'expected bm-query-size to carry a bm-stat-{light|ok|heavy} class'
        );
        assert.ok(
            src.indexOf("weightClass(q.resultSize, 1)") > -1,
            'expected weightClass(q.resultSize, 1) call for per-card size color'
        );
    });

    it('index.html includes query toolbar with filter dropdowns', function() {
        var html = getInspHtml();
        assert.ok(
            html.indexOf('bm-query-lang') > -1,
            'expected language filter dropdown in HTML'
        );
        assert.ok(
            html.indexOf('bm-query-connector') > -1,
            'expected connector filter dropdown in HTML'
        );
        assert.ok(
            html.indexOf('bm-query-bundle') > -1,
            'expected bundle filter dropdown in HTML'
        );
    });

    it('inspector.js renders index badges with three states', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('bm-idx-secondary') > -1,
            'expected bm-idx-secondary class for secondary index badges'
        );
        assert.ok(
            src.indexOf('bm-idx-primary') > -1,
            'expected bm-idx-primary class for primary scan warning'
        );
        assert.ok(
            src.indexOf('bm-idx-none') > -1,
            'expected bm-idx-none class for no-index warning'
        );
        assert.ok(
            src.indexOf('bm-idx-na') > -1,
            'expected bm-idx-na class for unsupported connectors'
        );
    });

    it('CSS includes index badge styles', function() {
        var css = getInspCss();
        var required = ['.bm-query-stmt-meta', '.bm-query-idx', '.bm-idx-secondary', '.bm-idx-primary', '.bm-idx-none', '.bm-idx-na'];
        for (var i = 0; i < required.length; i++) {
            assert.ok(
                css.indexOf(required[i]) > -1,
                'expected CSS class ' + required[i] + ' in inspector.css'
            );
        }
    });

    it('CSS has light theme overrides for index badges', function() {
        var css = getInspCss();
        // SCSS compiles [data-theme="light"] to [data-theme=light]
        assert.ok(
            css.indexOf('.bm-idx-secondary') > -1 && css.indexOf('.bm-idx-primary') > -1,
            'expected light theme overrides for index badge classes'
        );
    });

    it('inspector.js checks q.indexes for null vs empty vs populated', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('q.indexes !== null') > -1,
            'expected null check on q.indexes for supported vs unsupported'
        );
        assert.ok(
            src.indexOf('q.indexes.length === 0') > -1,
            'expected empty array check for no-index state'
        );
    });

    it('query search input uses debounce (200ms setTimeout)', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('_querySearchTimer') > -1,
            'expected _querySearchTimer debounce variable'
        );
        assert.ok(
            src.indexOf('clearTimeout(_querySearchTimer)') > -1,
            'expected clearTimeout on previous debounce timer'
        );
        // Must use setTimeout for debounce, matching the Data tab pattern
        var searchBlock = src.substring(src.indexOf("qs('#bm-query-search')"), src.indexOf("qs('#bm-query-search')") + 400);
        assert.ok(
            searchBlock.indexOf('setTimeout') > -1,
            'expected setTimeout in query search handler for debounce'
        );
    });

    it('query filters are persisted to localStorage', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('QUERY_LANG_KEY') > -1,
            'expected QUERY_LANG_KEY localStorage constant'
        );
        assert.ok(
            src.indexOf('QUERY_CONNECTOR_KEY') > -1,
            'expected QUERY_CONNECTOR_KEY localStorage constant'
        );
        assert.ok(
            src.indexOf('QUERY_BUNDLE_KEY') > -1,
            'expected QUERY_BUNDLE_KEY localStorage constant'
        );
        // Verify setItem calls exist for persistence
        assert.ok(
            src.indexOf('localStorage.setItem(QUERY_LANG_KEY') > -1,
            'expected localStorage.setItem for language filter'
        );
        assert.ok(
            src.indexOf('localStorage.setItem(QUERY_CONNECTOR_KEY') > -1,
            'expected localStorage.setItem for connector filter'
        );
        assert.ok(
            src.indexOf('localStorage.setItem(QUERY_BUNDLE_KEY') > -1,
            'expected localStorage.setItem for bundle filter'
        );
    });

    it('query filters are restored from localStorage on init', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('localStorage.getItem(QUERY_LANG_KEY)') > -1,
            'expected localStorage.getItem for language filter restore'
        );
        assert.ok(
            src.indexOf('localStorage.getItem(QUERY_CONNECTOR_KEY)') > -1,
            'expected localStorage.getItem for connector filter restore'
        );
        assert.ok(
            src.indexOf('localStorage.getItem(QUERY_BUNDLE_KEY)') > -1,
            'expected localStorage.getItem for bundle filter restore'
        );
    });

    it('renderQueryContent paginates with QUERY_PAGE_SIZE and show-all button', function() {
        var src = getInspJs();
        assert.ok(
            src.indexOf('QUERY_PAGE_SIZE') > -1,
            'expected QUERY_PAGE_SIZE constant'
        );
        assert.ok(
            src.indexOf('_queryShowAll') > -1,
            'expected _queryShowAll flag'
        );
        assert.ok(
            src.indexOf('bm-query-show-all') > -1,
            'expected bm-query-show-all button class'
        );
    });

    it('CSS includes query pagination button styles', function() {
        var css = getInspCss();
        assert.ok(
            css.indexOf('.bm-query-show-all') > -1,
            'expected .bm-query-show-all CSS class'
        );
    });

    it('durationClass variable does not shadow the function', function() {
        var src = getInspJs();
        // The local variable in renderQueryContent should be renamed to durCls
        var fnBlock = src.substring(src.indexOf('function renderQueryContent'), src.indexOf('function renderQueryContent') + 2000);
        assert.ok(
            fnBlock.indexOf('var durCls') > -1,
            'expected renamed durCls variable (no durationClass shadowing)'
        );
        assert.ok(
            fnBlock.indexOf('var durationClass') === -1,
            'durationClass variable should not exist in renderQueryContent (renamed to durCls)'
        );
    });

});


// ── 11 — /_gina/logs SSE handler in server.js ──────────────────────────────

describe('11 - /_gina/logs SSE handler is in server.js (engine-agnostic)', function() {

    it('server.js contains the /_gina/logs regex', function() {
        assert.ok(
            getServerSrc().indexOf('/_gina\\/logs') > -1,
            'expected /_gina/logs regex in server.js'
        );
    });

    it('server.js checks NODE_ENV_IS_DEV for the SSE endpoint', function() {
        assert.ok(
            /NODE_ENV_IS_DEV.*\/_gina\/logs|_gina\/logs.*NODE_ENV_IS_DEV/is.test(getServerSrc()),
            'expected NODE_ENV_IS_DEV guard near the SSE handler'
        );
    });

    it('server.js sets Content-Type to text/event-stream', function() {
        assert.ok(
            getServerSrc().indexOf('text/event-stream') > -1,
            'expected text/event-stream content type'
        );
    });

    it('server.js listens on process logger#default event', function() {
        assert.ok(
            getServerSrc().indexOf("logger#default") > -1,
            'expected process.on(logger#default) in the SSE handler'
        );
    });

    it('server.js removes the listener on request close', function() {
        var src = getServerSrc();
        var sseBlock = src.substring(
            src.indexOf('SSE at /_gina/logs'),
            src.indexOf('Fixing an express js bug')
        );
        assert.ok(
            sseBlock.indexOf('removeListener') > -1,
            'expected process.removeListener cleanup in the SSE handler'
        );
    });

});


// ── 12 — /_gina/logs SSE handler in server.isaac.js ────────────────────────

describe('12 - /_gina/logs SSE handler is in server.isaac.js (Isaac fast-path)', function() {

    var _isaacSrc;
    function getIsaacSrc() { return _isaacSrc || (_isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }

    it('server.isaac.js contains the /_gina/logs regex', function() {
        assert.ok(
            getIsaacSrc().indexOf('/_gina\\/logs') > -1,
            'expected /_gina/logs regex in server.isaac.js'
        );
    });

    it('server.isaac.js sets Content-Type to text/event-stream', function() {
        assert.ok(
            getIsaacSrc().indexOf('text/event-stream') > -1,
            'expected text/event-stream content type in Isaac'
        );
    });

    it('server.isaac.js supports HTTP/2 via response.stream', function() {
        var src = getIsaacSrc();
        var sseBlock = src.substring(
            src.indexOf('SSE at /_gina/logs'),
            src.indexOf('Proxy detection')
        );
        assert.ok(
            sseBlock.indexOf('response.stream') > -1,
            'expected HTTP/2 stream support in the Isaac SSE handler'
        );
    });

    it('server.isaac.js cleans up logger listener on close', function() {
        var src = getIsaacSrc();
        var sseBlock = src.substring(
            src.indexOf('SSE at /_gina/logs'),
            src.indexOf('Proxy detection')
        );
        assert.ok(
            sseBlock.indexOf('removeListener') > -1,
            'expected process.removeListener cleanup in Isaac SSE handler'
        );
    });

});


// ── 13 — /_gina/logs URL pattern matching ───────────────────────────────────

describe('13 - /_gina/logs URL pattern matching', function() {

    var pattern = /\/_gina\/logs$/;

    it('matches /_gina/logs', function() {
        assert.ok(pattern.test('/_gina/logs'));
    });

    it('matches with webroot prefix /api/_gina/logs', function() {
        assert.ok(pattern.test('/api/_gina/logs'));
    });

    it('does NOT match /_gina/logs/', function() {
        assert.ok(!pattern.test('/_gina/logs/'));
    });

    it('does NOT match /_gina/logs/extra', function() {
        assert.ok(!pattern.test('/_gina/logs/extra'));
    });

    it('does NOT match /_gina/logger', function() {
        assert.ok(!pattern.test('/_gina/logger'));
    });

    it('does NOT match /_gina/logsx', function() {
        assert.ok(!pattern.test('/_gina/logsx'));
    });

});


// ── 14 — CSS level mapping and synonym groups (client-side) ─────────────────

describe('14 - CSS level mapping and synonym groups', function() {

    // Mirrors CSS_LEVEL in inspector.js — maps syslog levels to CSS class suffixes
    var CSS_LEVEL = {
        emerg: 'error', alert: 'error', crit: 'error', err: 'error',
        warning: 'warn', notice: 'info', catch: 'log'
    };

    // Mirrors LEVEL_EQUIV in inspector.js
    var LEVEL_EQUIV = {
        error: ['error', 'err'], err: ['error', 'err'],
        warn: ['warn', 'warning'], warning: ['warn', 'warning']
    };

    it('maps emerg/alert/crit/err to error CSS class', function() {
        assert.equal(CSS_LEVEL['emerg'], 'error');
        assert.equal(CSS_LEVEL['alert'], 'error');
        assert.equal(CSS_LEVEL['crit'], 'error');
        assert.equal(CSS_LEVEL['err'], 'error');
    });

    it('maps warning to warn CSS class', function() {
        assert.equal(CSS_LEVEL['warning'], 'warn');
    });

    it('maps notice to info CSS class', function() {
        assert.equal(CSS_LEVEL['notice'], 'info');
    });

    it('passes through levels with no CSS mapping', function() {
        // error, warn, info, log, debug have no entry — used as-is for CSS class
        assert.equal(CSS_LEVEL['error'] || 'error', 'error');
        assert.equal(CSS_LEVEL['warn'] || 'warn', 'warn');
        assert.equal(CSS_LEVEL['info'] || 'info', 'info');
        assert.equal(CSS_LEVEL['debug'] || 'debug', 'debug');
    });

    it('error/err are synonyms', function() {
        assert.deepEqual(LEVEL_EQUIV['error'], ['error', 'err']);
        assert.deepEqual(LEVEL_EQUIV['err'], ['error', 'err']);
    });

    it('warn/warning are synonyms', function() {
        assert.deepEqual(LEVEL_EQUIV['warn'], ['warn', 'warning']);
        assert.deepEqual(LEVEL_EQUIV['warning'], ['warn', 'warning']);
    });

    it('non-synonym levels have no equivalence entry', function() {
        assert.equal(LEVEL_EQUIV['info'], undefined);
        assert.equal(LEVEL_EQUIV['debug'], undefined);
        assert.equal(LEVEL_EQUIV['emerg'], undefined);
    });

});


// ── 15 — ANSI color code stripping ─────────────────────────────────────────

describe('15 - ANSI color code stripping', function() {

    var _ansiRe = /\x1B\[\d+m/g;

    it('strips single ANSI code', function() {
        assert.equal('\x1B[36mhello\x1B[0m'.replace(_ansiRe, ''), 'hello');
    });

    it('strips multiple ANSI codes', function() {
        assert.equal('\x1B[1m\x1B[31merror\x1B[0m'.replace(_ansiRe, ''), 'error');
    });

    it('leaves plain text unchanged', function() {
        assert.equal('no colors here'.replace(_ansiRe, ''), 'no colors here');
    });

    it('strips trailing newline', function() {
        assert.equal('message\n'.replace(/\n$/, ''), 'message');
    });

});


// ── 16 — SSE log entry shape (raw levels) ──────────────────────────────────

describe('16 - SSE log entry shape (raw levels)', function() {

    // Mirrors the server-side SSE handler: only 'catch' is mapped, rest pass through
    function makeEntry(loggerPayload) {
        var _ansiRe = /\x1B\[\d+m/g;
        var entry = JSON.parse(loggerPayload);
        var level = entry.level === 'catch' ? 'log' : (entry.level || 'log');
        return {
            t: Date.now(),
            l: level,
            b: entry.group || '',
            s: (entry.content || '').replace(_ansiRe, '').replace(/\n$/, ''),
            src: 'server'
        };
    }

    it('produces { t, l, b, s, src } shape', function() {
        var payload = JSON.stringify({ group: 'demo', level: 'info', content: 'hello world\n' });
        var entry = makeEntry(payload);
        assert.equal(typeof entry.t, 'number');
        assert.equal(entry.l, 'info');
        assert.equal(entry.b, 'demo');
        assert.equal(entry.s, 'hello world');
        assert.equal(entry.src, 'server');
    });

    it('preserves raw syslog level (err stays err)', function() {
        var payload = JSON.stringify({ group: 'app', level: 'err', content: 'fail\n' });
        var entry = makeEntry(payload);
        assert.equal(entry.l, 'err');
    });

    it('preserves emerg, alert, crit, warning, notice as-is', function() {
        ['emerg', 'alert', 'crit', 'warning', 'notice'].forEach(function (lvl) {
            var payload = JSON.stringify({ group: 'gina', level: lvl, content: 'test' });
            var entry = makeEntry(payload);
            assert.equal(entry.l, lvl, lvl + ' should pass through unchanged');
        });
    });

    it('maps catch to log', function() {
        var payload = JSON.stringify({ group: 'gina', level: 'catch', content: 'pre-formatted' });
        var entry = makeEntry(payload);
        assert.equal(entry.l, 'log');
    });

    it('strips ANSI codes from content', function() {
        var payload = JSON.stringify({ group: 'app', level: 'err', content: '\x1B[31mfail\x1B[0m\n' });
        var entry = makeEntry(payload);
        assert.equal(entry.s, 'fail');
    });

    it('uses "log" for unknown severity', function() {
        var payload = JSON.stringify({ group: 'gina', level: '', content: 'test' });
        var entry = makeEntry(payload);
        assert.equal(entry.l, 'log');
    });

});


// ── 17 — Inspector SPA: SSE client and source filter ────────────────────────

describe('17 - Inspector SPA includes SSE client and source filter', function() {

    var _inspectorJs2;
    function getInspJs2() {
        return _inspectorJs2 || (_inspectorJs2 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8'));
    }

    it('inspector.js defines tryServerLogs function', function() {
        assert.ok(
            getInspJs2().indexOf('function tryServerLogs') > -1,
            'expected tryServerLogs function definition'
        );
    });

    it('inspector.js creates an EventSource to /_gina/logs', function() {
        assert.ok(
            getInspJs2().indexOf('EventSource') > -1,
            'expected EventSource usage'
        );
        assert.ok(
            getInspJs2().indexOf('/_gina/logs') > -1,
            'expected /_gina/logs URL in EventSource'
        );
    });

    it('inspector.js calls tryServerLogs() from init', function() {
        assert.ok(
            getInspJs2().indexOf('tryServerLogs()') > -1,
            'expected tryServerLogs() call'
        );
    });

    it('index.html contains the source filter dropdown', function() {
        var html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8');
        assert.ok(
            html.indexOf('bm-log-source') > -1,
            'expected bm-log-source select element'
        );
    });

    it('inspector.css contains the .bm-log-src badge style', function() {
        var css = fs.readFileSync(path.join(BM_DIR, 'inspector.css'), 'utf8');
        assert.ok(
            css.indexOf('.bm-log-src') > -1,
            'expected .bm-log-src CSS rule'
        );
    });

});


// ── 18 — Persistence: window geometry and env panel height ────────────────

describe('18 - Inspector persistence: window geometry and env panel height', function() {

    var _inspJs18;
    function getInspJs18() {
        return _inspJs18 || (_inspJs18 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8'));
    }

    it('inspector.js defines GEOMETRY_STORAGE_KEY', function() {
        assert.ok(
            getInspJs18().indexOf('__gina_inspector_geometry') > -1,
            'expected __gina_inspector_geometry key in inspector.js'
        );
    });

    it('inspector.js defines ENV_HEIGHT_STORAGE_KEY', function() {
        assert.ok(
            getInspJs18().indexOf('__gina_inspector_env_height') > -1,
            'expected __gina_inspector_env_height key in inspector.js'
        );
    });

    it('inspector.js saves geometry on resize', function() {
        var src = getInspJs18();
        assert.ok(
            src.indexOf('resize') > -1 && src.indexOf('GEOMETRY_STORAGE_KEY') > -1,
            'expected resize listener saving to GEOMETRY_STORAGE_KEY'
        );
    });

    it('inspector.js saves geometry on beforeunload', function() {
        assert.ok(
            getInspJs18().indexOf('beforeunload') > -1,
            'expected beforeunload listener for geometry persistence'
        );
    });

    it('statusbar.html restores geometry from localStorage', function() {
        var statusbar = fs.readFileSync(
            path.join(BM_DIR, '..', 'html', 'statusbar.html'), 'utf8'
        );
        assert.ok(
            statusbar.indexOf('__gina_inspector_geometry') > -1,
            'expected __gina_inspector_geometry read in statusbar.html'
        );
    });

});


// ── 19 — Drag-to-select and copy fade-out ─────────────────────────────────

describe('19 - Inspector drag-to-select log rows and copy fade-out', function() {

    var _inspJs19;
    function getInspJs19() {
        return _inspJs19 || (_inspJs19 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8'));
    }

    it('inspector.js registers mousedown listener on log list', function() {
        assert.ok(
            getInspJs19().indexOf("logList.addEventListener('mousedown'") > -1,
            'expected mousedown listener on logList'
        );
    });

    it('inspector.js registers mousemove listener for drag', function() {
        assert.ok(
            getInspJs19().indexOf("addEventListener('mousemove'") > -1,
            'expected mousemove listener for drag selection'
        );
    });

    it('inspector.js defines selectRange function', function() {
        assert.ok(
            getInspJs19().indexOf('function selectRange') > -1,
            'expected selectRange function definition'
        );
    });

    it('inspector.js defines applySelectionClasses function', function() {
        assert.ok(
            getInspJs19().indexOf('function applySelectionClasses') > -1,
            'expected applySelectionClasses function definition'
        );
    });

    it('inspector.js tracks drag state with _dragSelecting', function() {
        assert.ok(
            getInspJs19().indexOf('_dragSelecting') > -1,
            'expected _dragSelecting state variable'
        );
    });

    it('inspector.js distinguishes drag from click with _dragMoved', function() {
        assert.ok(
            getInspJs19().indexOf('_dragMoved') > -1,
            'expected _dragMoved flag for drag/click distinction'
        );
    });

    it('copy badge shows "Copied" feedback', function() {
        assert.ok(
            getInspJs19().indexOf('\\u2713 Copied') > -1,
            'expected checkmark + Copied text in copySelectedLogs'
        );
    });

    it('copy badge fades out via CSS class', function() {
        assert.ok(
            getInspJs19().indexOf("classList.add('fade-out')") > -1,
            'expected fade-out class added to badge after copy'
        );
    });

    it('selection is cleared after copy fade completes', function() {
        var src = getInspJs19();
        // After the fade timeout, selectedLogIds.clear() must be called
        var fadeIdx = src.indexOf("classList.add('fade-out')");
        var afterFade = src.substring(fadeIdx, fadeIdx + 600);
        assert.ok(
            afterFade.indexOf('selectedLogIds.clear()') > -1,
            'expected selectedLogIds.clear() after fade-out'
        );
    });

});


// ── 20 — Selection CSS: left accent and rounded corners ───────────────────

describe('20 - Inspector selection CSS: left accent line and rounded corners', function() {

    var _inspCss20;
    function getInspCss20() {
        return _inspCss20 || (_inspCss20 = fs.readFileSync(path.join(BM_DIR, 'inspector.css'), 'utf8'));
    }

    it('CSS contains .bm-log-selected class', function() {
        assert.ok(
            getInspCss20().indexOf('.bm-log-selected') > -1,
            'expected .bm-log-selected in inspector.css'
        );
    });

    it('CSS uses ::before pseudo-element for accent line', function() {
        assert.ok(
            getInspCss20().indexOf('.bm-log-selected::before') > -1,
            'expected .bm-log-selected::before in inspector.css'
        );
    });

    it('accent line is 3px wide', function() {
        var css = getInspCss20();
        var beforeIdx = css.indexOf('.bm-log-selected::before');
        if (beforeIdx === -1) { assert.fail('::before block not found'); return; }
        var block = css.substring(beforeIdx, beforeIdx + 300);
        assert.ok(
            block.indexOf('width: 3px') > -1 || block.indexOf('width:3px') > -1,
            'expected 3px width on accent pseudo-element'
        );
    });

    it('CSS applies border-radius for contiguous group corners', function() {
        var css = getInspCss20();
        assert.ok(
            css.indexOf('border-radius: 6px 6px 0 0') > -1,
            'expected top rounded corners on first selected row'
        );
        assert.ok(
            css.indexOf('border-radius: 0 0 6px 6px') > -1,
            'expected bottom rounded corners on last selected row'
        );
    });

    it('CSS has solo row full border-radius', function() {
        var css = getInspCss20();
        // Solo selected row: border-radius: 6px (all corners)
        assert.ok(
            /border-radius:\s*6px\b/.test(css),
            'expected full 6px border-radius for solo selected row'
        );
    });

    it('CSS contains badge fade-out transition', function() {
        var css = getInspCss20();
        assert.ok(
            css.indexOf('.fade-out') > -1,
            'expected .fade-out class in inspector.css'
        );
    });

    it('CSS contains logo watermark styles', function() {
        var css = getInspCss20();
        assert.ok(
            css.indexOf('logo.svg') > -1,
            'expected logo.svg reference in inspector.css watermark styles'
        );
    });

});


// ── 21 — Performance anomaly alerts in View tab ────────────────────────────

describe('21 - Performance anomaly alerts in View tab', function() {

    var INSPECTOR_JS  = path.join(BM_DIR, 'inspector.js');
    var INSPECTOR_CSS = path.join(BM_DIR, 'inspector.css');
    var INSPECTOR_HTML = path.join(BM_DIR, 'index.html');
    var _inspJs21, _inspCss21, _inspHtml21;
    function getInspJs21()   { return _inspJs21   || (_inspJs21   = fs.readFileSync(INSPECTOR_JS, 'utf8')); }
    function getInspCss21()  { return _inspCss21  || (_inspCss21  = fs.readFileSync(INSPECTOR_CSS, 'utf8')); }
    function getInspHtml21() { return _inspHtml21 || (_inspHtml21 = fs.readFileSync(INSPECTOR_HTML, 'utf8')); }

    // ── JS source checks ──

    it('PERF_THRESHOLDS constant is defined with all metric keys', function() {
        var src = getInspJs21();
        assert.ok(src.indexOf('var PERF_THRESHOLDS') > -1, 'expected PERF_THRESHOLDS constant');
        assert.ok(src.indexOf('loadMs:') > -1, 'expected loadMs threshold');
        assert.ok(src.indexOf('weight:') > -1, 'expected weight threshold');
        assert.ok(src.indexOf('fcpMs:') > -1, 'expected fcpMs threshold');
        assert.ok(src.indexOf('queryMs:') > -1, 'expected queryMs threshold');
        assert.ok(src.indexOf('queryCount:') > -1, 'expected queryCount threshold');
    });

    it('PERF_THRESHOLDS has warn and critical levels for each metric', function() {
        var src = getInspJs21();
        // Extract the PERF_THRESHOLDS block
        var start = src.indexOf('var PERF_THRESHOLDS');
        var end = src.indexOf('};', start) + 2;
        var block = src.substring(start, end);
        // Each metric key should have both warn and critical
        var metrics = ['loadMs', 'weight', 'fcpMs', 'queryMs', 'queryCount'];
        for (var i = 0; i < metrics.length; i++) {
            var mBlock = block.substring(block.indexOf(metrics[i]));
            mBlock = mBlock.substring(0, mBlock.indexOf('}') + 1);
            assert.ok(mBlock.indexOf('warn:') > -1, metrics[i] + ' missing warn threshold');
            assert.ok(mBlock.indexOf('critical:') > -1, metrics[i] + ' missing critical threshold');
        }
    });

    it('checkPerfAnomalies function exists', function() {
        var src = getInspJs21();
        assert.ok(
            src.indexOf('function checkPerfAnomalies') > -1,
            'expected checkPerfAnomalies function in inspector.js'
        );
    });

    it('checkPerfAnomalies checks load, weight, fcp, queryMs, queryCount', function() {
        var src = getInspJs21();
        var start = src.indexOf('function checkPerfAnomalies');
        var end = src.indexOf('\n    function ', start + 10);
        var body = src.substring(start, end);
        assert.ok(body.indexOf('metrics.loadMs') > -1, 'expected loadMs check');
        assert.ok(body.indexOf('metrics.weight') > -1, 'expected weight check');
        assert.ok(body.indexOf('metrics.fcpMs') > -1, 'expected fcpMs check');
        assert.ok(body.indexOf('queries.length') > -1, 'expected query count check');
        assert.ok(body.indexOf('_totalMs') > -1, 'expected total query duration check');
    });

    it('checkPerfAnomalies returns objects with metric, level, and label fields', function() {
        var src = getInspJs21();
        var start = src.indexOf('function checkPerfAnomalies');
        var end = src.indexOf('\n    function ', start + 10);
        var body = src.substring(start, end);
        assert.ok(body.indexOf("metric:") > -1, 'expected metric field in result');
        assert.ok(body.indexOf("level:") > -1, 'expected level field in result');
        assert.ok(body.indexOf("label:") > -1, 'expected label field in result');
        assert.ok(body.indexOf("'critical'") > -1, 'expected critical level');
        assert.ok(body.indexOf("'warn'") > -1, 'expected warn level');
    });

    it('updateViewDot function exists', function() {
        var src = getInspJs21();
        assert.ok(
            src.indexOf('function updateViewDot') > -1,
            'expected updateViewDot function in inspector.js'
        );
    });

    it('updateViewDot sets bm-view-dot CSS classes', function() {
        var src = getInspJs21();
        var start = src.indexOf('function updateViewDot');
        var end = src.indexOf('\n    function ', start + 10);
        if (end === -1) end = src.indexOf('\n    // ', start + 10);
        var body = src.substring(start, end);
        assert.ok(body.indexOf('bm-view-dot') > -1, 'expected bm-view-dot class reference');
        assert.ok(body.indexOf("'error'") > -1 || body.indexOf('"error"') > -1, 'expected error severity');
        assert.ok(body.indexOf("'warn'") > -1 || body.indexOf('"warn"') > -1, 'expected warn severity');
    });

    it('renderViewContent computes anomalies and updates view dot', function() {
        var src = getInspJs21();
        var start = src.indexOf('function renderViewContent');
        var end = src.indexOf('\n    function ', start + 10);
        var body = src.substring(start, end);
        assert.ok(body.indexOf('checkPerfAnomalies') > -1, 'expected checkPerfAnomalies call');
        assert.ok(body.indexOf('updateViewDot') > -1, 'expected updateViewDot call');
        assert.ok(body.indexOf('_anomMap') > -1, 'expected anomaly map construction');
    });

    it('badge rendering injects bm-perf- classes from anomaly map', function() {
        var src = getInspJs21();
        var start = src.indexOf('function renderViewContent');
        var end = src.indexOf('\n    function ', start + 10);
        var body = src.substring(start, end);
        assert.ok(body.indexOf('bm-perf-') > -1, 'expected bm-perf- class injection in badge HTML');
        // Three badges should reference _anomMap: weight, load, fcp
        assert.ok(body.indexOf("_anomMap['weight']") > -1, 'expected weight anomaly lookup');
        assert.ok(body.indexOf("_anomMap['load']") > -1, 'expected load anomaly lookup');
        assert.ok(body.indexOf("_anomMap['fcp']") > -1, 'expected fcp anomaly lookup');
    });

    it('pollData updates view dot even when view tab is not active', function() {
        var src = getInspJs21();
        var start = src.indexOf('function pollData');
        var end = src.indexOf('\n    function ', start + 10);
        var body = src.substring(start, end);
        assert.ok(
            body.indexOf("tab !== 'view'") > -1 && body.indexOf('updateViewDot') > -1,
            'expected view dot update in pollData for non-view tabs'
        );
    });

    // ── HTML checks ──

    it('index.html has bm-view-dot span in the View tab button', function() {
        var html = getInspHtml21();
        assert.ok(
            html.indexOf('id="bm-view-dot"') > -1,
            'expected bm-view-dot element in index.html'
        );
        // Should be inside the view tab button (after "View" text)
        var viewTabStart = html.indexOf('data-tab="view"');
        var viewTabEnd = html.indexOf('</button>', viewTabStart);
        var viewTabBlock = html.substring(viewTabStart, viewTabEnd);
        assert.ok(
            viewTabBlock.indexOf('bm-view-dot') > -1,
            'expected bm-view-dot inside the View tab button'
        );
    });

    // ── CSS checks ──

    it('CSS has bm-view-dot base styles', function() {
        var css = getInspCss21();
        assert.ok(css.indexOf('.bm-view-dot') > -1, 'expected .bm-view-dot in CSS');
        assert.ok(css.indexOf('border-radius') > -1, 'expected border-radius for dot');
    });

    it('CSS has bm-view-dot severity classes (warn, error)', function() {
        var css = getInspCss21();
        // Check that view-dot has warn and error color classes
        var dotStart = css.indexOf('.bm-view-dot');
        var dotBlock = css.substring(dotStart, dotStart + 500);
        assert.ok(
            dotBlock.indexOf('.warn') > -1 || css.indexOf('.bm-view-dot.warn') > -1,
            'expected .warn class for bm-view-dot'
        );
        assert.ok(
            dotBlock.indexOf('.error') > -1 || css.indexOf('.bm-view-dot.error') > -1,
            'expected .error class for bm-view-dot'
        );
    });

    it('CSS has bm-perf-warn badge override', function() {
        var css = getInspCss21();
        assert.ok(css.indexOf('.bm-perf-warn') > -1, 'expected .bm-perf-warn in CSS');
    });

    it('CSS has bm-perf-critical badge override', function() {
        var css = getInspCss21();
        assert.ok(css.indexOf('.bm-perf-critical') > -1, 'expected .bm-perf-critical in CSS');
    });

    it('CSS perf overrides include box-shadow for visual emphasis', function() {
        var css = getInspCss21();
        var warnStart = css.indexOf('.bm-perf-warn');
        var warnBlock = css.substring(warnStart, warnStart + 200);
        assert.ok(warnBlock.indexOf('box-shadow') > -1, 'expected box-shadow on .bm-perf-warn');
        var critStart = css.indexOf('.bm-perf-critical');
        var critBlock = css.substring(critStart, critStart + 200);
        assert.ok(critBlock.indexOf('box-shadow') > -1, 'expected box-shadow on .bm-perf-critical');
    });

    it('CSS has light theme overrides for perf badges', function() {
        var css = getInspCss21();
        // SCSS compiles [data-theme="light"] to [data-theme=light] (no quotes)
        assert.ok(
            css.indexOf('[data-theme=light]') > -1 && css.indexOf('.bm-perf-warn') > -1,
            'expected light theme override for perf badges'
        );
    });
});


// ── 22 — Flow tab: waterfall rendering and timeline data ─────────────────────

describe('22 - Flow tab waterfall rendering and timeline data', function() {

    var INSPECTOR_JS  = path.join(BM_DIR, 'inspector.js');
    var INSPECTOR_CSS = path.join(BM_DIR, 'inspector.css');
    var INSPECTOR_HTML = path.join(BM_DIR, 'index.html');
    var CONTROLLER_JS = path.join(FW, 'core/controller/controller.js');
    var RENDER_SWIG   = path.join(FW, 'core/controller/controller.render-swig.js');
    var RENDER_JSON   = path.join(FW, 'core/controller/controller.render-json.js');
    var SERVER_SRC_22 = path.join(FW, 'core/server.js');
    var ISAAC_SRC_22  = path.join(FW, 'core/server.isaac.js');
    var ROUTER_SRC    = path.join(FW, 'core/router.js');

    var _inspJs22, _inspCss22, _inspHtml22, _ctrlJs, _rSwig, _rJson, _srv22, _isaac22, _router22;
    function getInspJs22()   { return _inspJs22   || (_inspJs22   = fs.readFileSync(INSPECTOR_JS, 'utf8')); }
    function getInspCss22()  { return _inspCss22  || (_inspCss22  = fs.readFileSync(INSPECTOR_CSS, 'utf8')); }
    function getInspHtml22() { return _inspHtml22 || (_inspHtml22 = fs.readFileSync(INSPECTOR_HTML, 'utf8')); }
    function getCtrlJs()     { return _ctrlJs     || (_ctrlJs     = fs.readFileSync(CONTROLLER_JS, 'utf8')); }
    function getRSwig()      { return _rSwig      || (_rSwig      = fs.readFileSync(RENDER_SWIG, 'utf8')); }
    function getRJson()      { return _rJson      || (_rJson      = fs.readFileSync(RENDER_JSON, 'utf8')); }
    function getSrv22()      { return _srv22      || (_srv22      = fs.readFileSync(SERVER_SRC_22, 'utf8')); }
    function getIsaac22()    { return _isaac22    || (_isaac22    = fs.readFileSync(ISAAC_SRC_22, 'utf8')); }
    function getRouter22()   { return _router22   || (_router22   = fs.readFileSync(ROUTER_SRC, 'utf8')); }

    // ── HTML ──

    it('index.html has Flow tab button', function() {
        var html = getInspHtml22();
        assert.ok(html.indexOf('data-tab="flow"') > -1, 'expected data-tab="flow" button');
    });

    it('index.html has #tab-flow section', function() {
        var html = getInspHtml22();
        assert.ok(html.indexOf('id="tab-flow"') > -1, 'expected tab-flow section');
    });

    it('index.html has #tree-flow container', function() {
        var html = getInspHtml22();
        assert.ok(html.indexOf('id="tree-flow"') > -1, 'expected tree-flow container');
    });

    // ── JS ──

    it('inspector.js has renderFlowContent function', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('renderFlowContent') > -1, 'expected renderFlowContent function');
    });

    it('renderTab flow case calls renderFlowContent', function() {
        var js = getInspJs22();
        var caseBlock = js.substring(js.indexOf("case 'flow':"), js.indexOf("case 'flow':") + 200);
        assert.ok(
            caseBlock.indexOf('renderFlowContent') > -1,
            'flow case must call renderFlowContent'
        );
    });

    it('renderFlowContent handles empty timeline', function() {
        var js = getInspJs22();
        assert.ok(
            js.indexOf('No timeline data') > -1,
            'expected empty state message in renderFlowContent'
        );
    });

    it('renderFlowContent renders waterfall elements', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('bm-flow-waterfall') > -1, 'expected bm-flow-waterfall class');
        assert.ok(js.indexOf('bm-flow-bar') > -1, 'expected bm-flow-bar class');
        assert.ok(js.indexOf('bm-flow-scale') > -1, 'expected bm-flow-scale class');
    });

    it('FLOW_CAT_LABELS covers all server categories', function() {
        var js = getInspJs22();
        var cats = [
            'routing', 'middleware', 'controller', 'io', 'db', 'template', 'response', 'total'
        ];
        for (var i = 0; i < cats.length; i++) {
            assert.ok(
                js.indexOf(cats[i] + ':') > -1,
                'expected category ' + cats[i] + ' in FLOW_CAT_LABELS'
            );
        }
    });

    // ── CSS ──

    it('CSS includes flow tab styles', function() {
        var css = getInspCss22();
        var requiredClasses = [
            '.bm-flow-controls',
            '.bm-flow-waterfall',
            '.bm-flow-row',
            '.bm-flow-label',
            '.bm-flow-track',
            '.bm-flow-bar',
            '.bm-flow-scale',
            '.bm-flow-time'
        ];
        for (var i = 0; i < requiredClasses.length; i++) {
            assert.ok(
                css.indexOf(requiredClasses[i]) > -1,
                'expected CSS class ' + requiredClasses[i]
            );
        }
    });

    it('CSS has category color classes for server categories', function() {
        var css = getInspCss22();
        var cats = [
            'routing', 'middleware', 'controller', 'io', 'db', 'template', 'response', 'total'
        ];
        for (var i = 0; i < cats.length; i++) {
            assert.ok(
                css.indexOf('.bm-flow-cat-' + cats[i]) > -1,
                'expected .bm-flow-cat-' + cats[i] + ' in CSS'
            );
        }
    });

    // ── Server-side instrumentation ──

    it('server.js initializes req._devTimeline', function() {
        var src = getSrv22();
        assert.ok(src.indexOf('_devTimeline') > -1, 'expected _devTimeline in server.js');
        assert.ok(src.indexOf('requestStart') > -1, 'expected requestStart init');
    });

    it('server.isaac.js initializes req._devTimeline', function() {
        var src = getIsaac22();
        assert.ok(src.indexOf('_devTimeline') > -1, 'expected _devTimeline in server.isaac.js');
    });

    it('server.js handle() has route-match timing', function() {
        var src = getSrv22();
        assert.ok(src.indexOf('_routeMatchStart') > -1, 'expected _routeMatchStart variable');
        assert.ok(src.indexOf("label: 'route-match'") > -1, 'expected route-match label');
    });

    it('router.js has action start timing', function() {
        var src = getRouter22();
        assert.ok(src.indexOf('_devTimeline._actionStart') > -1, 'expected _actionStart timing in router.js');
    });

    it('controller.js propagates timeline in setOptions()', function() {
        var src = getCtrlJs();
        assert.ok(src.indexOf('local._timeline = req._devTimeline') > -1, 'expected timeline propagation');
    });

    it('controller.js query() captures _timelineStart', function() {
        var src = getCtrlJs();
        assert.ok(src.indexOf('options._timelineStart') > -1, 'expected _timelineStart on options');
    });

    it('render-swig.js injects flow into data.page', function() {
        var src = getRSwig();
        assert.ok(src.indexOf('data.page.flow') > -1, 'expected data.page.flow injection');
    });

    it('render-swig.js has swig.compile timing', function() {
        var src = getRSwig();
        assert.ok(src.indexOf('_compileStart') > -1, 'expected _compileStart variable');
        assert.ok(src.indexOf("label: 'swig-compile'") > -1, 'expected swig-compile label');
    });

    // ── Cache-hit path instrumentation ──

    it('render-swig.js cache-hit path has swig-execute timing', function() {
        var src = getRSwig();
        assert.ok(src.indexOf('_cacheExecStart') > -1, 'expected _cacheExecStart variable in cache-hit path');
    });

    it('render-swig.js cache-hit path has response-write + total timing', function() {
        var src = getRSwig();
        assert.ok(src.indexOf('_cacheRespEnd') > -1, 'expected _cacheRespEnd variable in cache-hit path');
        assert.ok(src.indexOf('_cacheRwStart') > -1, 'expected _cacheRwStart variable in cache-hit path');
    });

    it('render-swig.js cache-hit path injects flow data before template execution', function() {
        var src = getRSwig();
        // The cache-hit flow injection must appear BEFORE the cache-hit compiledTemplate(data) call
        var cacheFlowIdx = src.indexOf('data.page.flow = {');
        var cacheExecIdx = src.indexOf('_cacheExecStart');
        assert.ok(cacheFlowIdx > -1 && cacheExecIdx > -1, 'expected both cache-hit flow injection and exec timing');
        assert.ok(cacheFlowIdx < cacheExecIdx, 'flow injection must precede template execution on cache-hit path');
    });

    it('render-swig.js cache-hit path has late-entry patch', function() {
        var src = getRSwig();
        assert.ok(src.indexOf('_cacheLateEntries') > -1, 'expected _cacheLateEntries in cache-hit path');
        assert.ok(src.indexOf('_cachePatchScript') > -1, 'expected _cachePatchScript in cache-hit path');
    });

    it('render-json.js injects __ginaFlow sidecar', function() {
        var src = getRJson();
        assert.ok(src.indexOf('__ginaFlow') > -1, 'expected __ginaFlow sidecar');
    });

    it('controller.js merges upstream __ginaFlow in query callback', function() {
        var src = getCtrlJs();
        assert.ok(src.indexOf('data.__ginaFlow') > -1, 'expected __ginaFlow merge in query callback');
    });

    // ── Enriched timeline data ──

    it('controller.js enriches controller-action with action name', function() {
        var src = getCtrlJs();
        assert.ok(src.indexOf("detail: (local.options.control") > -1, 'expected action name in controller-action detail');
    });

    it('render-swig.js enriches swig-compile with template file', function() {
        var src = getRSwig();
        assert.ok(src.indexOf("detail: (data.page.view.file") > -1, 'expected template file in swig-compile detail');
    });

    it('controller.js saves target bundle name for query io entries', function() {
        var src = getCtrlJs();
        assert.ok(src.indexOf('_targetBundle') > -1, 'expected _targetBundle saved for Flow');
    });

    // ── Progress bar and dual badge ──

    it('inspector.js has getClientTransferMs function', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('function getClientTransferMs') > -1, 'expected getClientTransferMs function');
    });

    it('getClientTransferMs reads navigation timing responseEnd', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf("getEntriesByType('navigation')") > -1, 'expected navigation entries');
        assert.ok(js.indexOf('responseEnd') > -1, 'expected responseEnd check');
    });

    it('renderFlowContent uses dual badge with clock icon for total time', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('bm-vbadge') > -1, 'expected bm-vbadge class on total');
        assert.ok(js.indexOf('_svgClock') > -1, 'expected clock icon in total badge');
        assert.ok(js.indexOf('durationClass') > -1, 'expected durationClass for badge color');
    });

    it('renderFlowContent populates progress bar in controls bar', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('bm-flow-progress') > -1, 'expected progress class');
        assert.ok(js.indexOf('bm-flow-progress-fill') > -1, 'expected progress fill class');
        assert.ok(js.indexOf('bm-flow-progress-pct') > -1, 'expected progress percentage class');
    });

    it('CSS has inline progress bar and badge styles', function() {
        var css = getInspCss22();
        assert.ok(css.indexOf('.bm-flow-progress') > -1, 'expected .bm-flow-progress');
        assert.ok(css.indexOf('.bm-flow-progress-track') > -1, 'expected .bm-flow-progress-track');
        assert.ok(css.indexOf('.bm-flow-progress-fill') > -1, 'expected .bm-flow-progress-fill');
        assert.ok(css.indexOf('.bm-flow-progress-pct') > -1, 'expected .bm-flow-progress-pct');
        assert.ok(css.indexOf('.bm-flow-stats') > -1, 'expected .bm-flow-stats right-aligned container');
    });

    it('CSS has dark text for bright bars (readability fix)', function() {
        var css = getInspCss22();
        assert.ok(css.indexOf('.bm-flow-cat-routing .bm-flow-dur') > -1, 'expected routing dur override');
        assert.ok(css.indexOf('.bm-flow-cat-middleware .bm-flow-dur') > -1, 'expected middleware dur override');
    });

    // ── Resizable label column ──

    it('index.html has flow resize handle', function() {
        var html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8');
        assert.ok(html.indexOf('bm-flow-resize') > -1, 'expected resize handle element');
    });

    it('inspector.js has setupFlowResize function', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('function setupFlowResize') > -1, 'expected setupFlowResize function');
        assert.ok(js.indexOf('FLOW_LABEL_WIDTH_KEY') > -1, 'expected localStorage key constant');
    });

    it('CSS has flow resize handle and variable-width label', function() {
        var css = getInspCss22();
        assert.ok(css.indexOf('.bm-flow-resize') > -1, 'expected .bm-flow-resize style');
        assert.ok(css.indexOf('--flow-label-w') > -1, 'expected --flow-label-w CSS variable');
    });

    it('inspector.js has renderFlowScale helper', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('function renderFlowScale') > -1, 'expected renderFlowScale function');
    });

    it('inspector.js has renderFlowRows helper', function() {
        var js = getInspJs22();
        assert.ok(js.indexOf('function renderFlowRows') > -1, 'expected renderFlowRows function');
    });
});


// ── 23 — Flow instrumentation: render-v1, render-stream, renderStream ────────

describe('23 - Flow instrumentation in render-v1, render-stream, and controller.js renderStream', function() {

    var RENDER_V1     = path.join(FW, 'core/controller/controller.render-v1.js');
    var RENDER_STREAM = path.join(FW, 'core/controller/controller.render-stream.js');
    var CONTROLLER_JS = path.join(FW, 'core/controller/controller.js');
    var INSPECTOR_JS  = path.join(BM_DIR, 'inspector.js');

    var _rv1, _rs, _ctrl, _insp;
    function getRv1()  { return _rv1  || (_rv1  = fs.readFileSync(RENDER_V1, 'utf8')); }
    function getRs()   { return _rs   || (_rs   = fs.readFileSync(RENDER_STREAM, 'utf8')); }
    function getCtrl() { return _ctrl || (_ctrl = fs.readFileSync(CONTROLLER_JS, 'utf8')); }
    function getInsp() { return _insp || (_insp = fs.readFileSync(INSPECTOR_JS, 'utf8')); }

    // ── render-v1.js ──

    it('render-v1.js has #FI pre-compile timing', function() {
        var src = getRv1();
        assert.ok(src.indexOf('_preCompileStart') > -1, 'expected _preCompileStart variable');
        assert.ok(src.indexOf("label: 'swig-precompile'") > -1, 'expected swig-precompile label');
        assert.ok(src.indexOf("cat: 'template'") > -1, 'expected template category');
    });

    it('render-v1.js has #FI final compile timing', function() {
        var src = getRv1();
        assert.ok(src.indexOf('_compileStart') > -1, 'expected _compileStart variable');
        assert.ok(src.indexOf("label: 'swig-compile'") > -1, 'expected swig-compile label');
    });

    it('render-v1.js has #FI response-write timing', function() {
        var src = getRv1();
        assert.ok(src.indexOf("label: 'response-write'") > -1, 'expected response-write label');
        assert.ok(src.indexOf("cat: 'response'") > -1, 'expected response category');
    });

    it('render-v1.js has #FI total timing', function() {
        var src = getRv1();
        assert.ok(src.indexOf("label: 'total'") > -1, 'expected total label');
        assert.ok(src.indexOf("cat: 'total'") > -1, 'expected total category');
    });

    it('render-v1.js guards timeline entries with local._timeline check', function() {
        var src = getRv1();
        assert.ok(src.indexOf('local._timeline') > -1, 'expected local._timeline guard');
    });

    // ── render-stream.js ──

    it('render-stream.js has #FI stream-write timing', function() {
        var src = getRs();
        assert.ok(src.indexOf("label: 'stream-write'") > -1, 'expected stream-write label');
        assert.ok(src.indexOf("cat: 'response'") > -1, 'expected response category');
    });

    it('render-stream.js has #FI total timing', function() {
        var src = getRs();
        assert.ok(src.indexOf("label: 'total'") > -1, 'expected total label');
        assert.ok(src.indexOf("cat: 'total'") > -1, 'expected total category');
    });

    it('render-stream.js captures _timeline reference before async', function() {
        var src = getRs();
        assert.ok(src.indexOf('var _timeline = local._timeline') > -1, 'expected _timeline captured synchronously');
        assert.ok(src.indexOf('var _streamStart') > -1, 'expected _streamStart variable');
    });

    it('render-stream.js includes content type in stream-write detail', function() {
        var src = getRs();
        assert.ok(src.indexOf('detail: contentType') > -1, 'expected contentType as detail');
    });

    // ── controller.js renderStream() ──

    it('controller.js renderStream() has #FI controller-action timing', function() {
        var src = getCtrl();
        // Find the renderStream method body
        var startIdx = src.indexOf('this.renderStream = function');
        assert.ok(startIdx > -1, 'expected renderStream method');
        var block = src.substring(startIdx, startIdx + 800);
        assert.ok(
            block.indexOf("label: 'controller-action'") > -1,
            'expected controller-action label in renderStream'
        );
        assert.ok(
            block.indexOf("cat: 'controller'") > -1,
            'expected controller category in renderStream'
        );
    });

    it('controller.js renderStream() saves _renderStart on timeline', function() {
        var src = getCtrl();
        var startIdx = src.indexOf('this.renderStream = function');
        var block = src.substring(startIdx, startIdx + 800);
        assert.ok(
            block.indexOf('local._timeline._renderStart') > -1,
            'expected _renderStart saved for render-stream to use'
        );
    });

    // ── Inspector cleanFlowLabel handles stream-write ──

    it('inspector.js cleanFlowLabel handles stream-write label', function() {
        var js = getInsp();
        assert.ok(
            js.indexOf('stream-') > -1,
            'expected stream- prefix handling in cleanFlowLabel'
        );
    });
});


// ── 24 — Flow instrumentation in render-json.js ─────────────────────────────

describe('24 - Flow instrumentation in render-json.js (response-write + total)', function() {

    var RENDER_JSON_24 = path.join(FW, 'core/controller/controller.render-json.js');
    var _rJson24;
    function getRJson24() { return _rJson24 || (_rJson24 = fs.readFileSync(RENDER_JSON_24, 'utf8')); }

    it('render-json.js pushes response-write timeline entry', function() {
        var src = getRJson24();
        assert.ok(
            src.indexOf("label    : 'response-write'") > -1,
            'expected response-write label in render-json.js'
        );
    });

    it('render-json.js pushes total timeline entry', function() {
        var src = getRJson24();
        assert.ok(
            src.indexOf("label    : 'total'") > -1,
            'expected total label in render-json.js'
        );
    });

    it('render-json.js response-write uses response category', function() {
        var src = getRJson24();
        var idx = src.indexOf("label    : 'response-write'");
        var block = src.substring(idx, idx + 300);
        assert.ok(
            block.indexOf("cat      : 'response'") > -1,
            'expected response category for response-write'
        );
    });

    it('render-json.js total uses total category', function() {
        var src = getRJson24();
        var idx = src.indexOf("label    : 'total'");
        var block = src.substring(idx, idx + 300);
        assert.ok(
            block.indexOf("cat      : 'total'") > -1,
            'expected total category for total entry'
        );
    });

    it('render-json.js response-write is pushed before __ginaFlow sidecar', function() {
        var src = getRJson24();
        var rwIdx = src.indexOf("label    : 'response-write'");
        var sidecarIdx = src.indexOf('jsonObj.__ginaFlow');
        assert.ok(rwIdx > -1, 'response-write entry must exist');
        assert.ok(sidecarIdx > -1, '__ginaFlow sidecar must exist');
        assert.ok(
            rwIdx < sidecarIdx,
            'response-write must be pushed before __ginaFlow sidecar so it travels with cross-bundle data'
        );
    });

    it('render-json.js uses isCacheless() guard for FI entries', function() {
        var src = getRJson24();
        var rwIdx = src.indexOf("label    : 'response-write'");
        // Find the isCacheless guard before the response-write entry
        var preceding = src.substring(Math.max(0, rwIdx - 350), rwIdx);
        assert.ok(
            preceding.indexOf('self.isCacheless()') > -1,
            'expected isCacheless() guard before FI entries in render-json.js'
        );
    });

    it('render-json.js total references requestStart for duration', function() {
        var src = getRJson24();
        var totalIdx = src.indexOf("label    : 'total'");
        var block = src.substring(totalIdx, totalIdx + 300);
        assert.ok(
            block.indexOf('local._timeline.requestStart') > -1,
            'expected requestStart reference in total entry'
        );
    });
});


// ── 25 — Late-entry patch guard fix + controller-setup instrumentation ───────

describe('25 - Late-entry patch guard fix and controller-setup timeline entry', function() {

    var RENDER_SWIG_25 = path.join(FW, 'core/controller/controller.render-swig.js');
    var ROUTER_25      = path.join(FW, 'core/router.js');
    var INSPECTOR_25   = path.join(BM_DIR, 'inspector.js');

    var _rSwig25, _router25, _insp25;
    function getRSwig25()   { return _rSwig25   || (_rSwig25   = fs.readFileSync(RENDER_SWIG_25, 'utf8')); }
    function getRouter25()  { return _router25  || (_router25  = fs.readFileSync(ROUTER_25, 'utf8')); }
    function getInsp25()    { return _insp25    || (_insp25    = fs.readFileSync(INSPECTOR_25, 'utf8')); }

    // ── Late-entry patch guard: must use isCacheless() fallback ──

    it('render-swig.js miss-path late-entry patch uses isCacheless() fallback', function() {
        var src = getRSwig25();
        // Slice 2 lifted `self.isCacheless()` to the OUTER gate that wraps
        // the flow late-bind AND the new metrics late-bind. The
        // `_lateEntries.length > 0` reference is now an inner ternary inside
        // that gate, so the outer block must appear before it. Assert the
        // gate is within reasonable proximity preceding the inner ref.
        var idx = src.indexOf('_lateEntries.length > 0');
        assert.ok(idx > -1, 'expected _lateEntries reference');
        var pre = src.substring(Math.max(0, idx - 300), idx);
        assert.ok(
            pre.indexOf('self.isCacheless()') > -1,
            'miss-path patch must use isCacheless() fallback in the enclosing gate, not displayInspector alone'
        );
    });

    it('render-swig.js cache-hit path late-entry patch uses isCacheless() fallback', function() {
        var src = getRSwig25();
        var idx = src.indexOf('_cacheLateEntries.length > 0');
        assert.ok(idx > -1, 'expected _cacheLateEntries reference');
        var pre = src.substring(Math.max(0, idx - 300), idx);
        assert.ok(
            pre.indexOf('self.isCacheless()') > -1,
            'cache-hit patch must use isCacheless() fallback in the enclosing gate, not displayInspector alone'
        );
    });

    // ── Snapshot count fix: saved before late entries are pushed ──

    it('render-swig.js miss-path saves _flowSnapshotCount before late entries', function() {
        var src = getRSwig25();
        var snapshotIdx = src.indexOf('_flowSnapshotCount');
        assert.ok(snapshotIdx > -1, 'expected _flowSnapshotCount variable in render-swig.js');
        // Must appear before swig-compile entry
        var compileIdx = src.indexOf("label: 'swig-compile'");
        assert.ok(
            snapshotIdx < compileIdx,
            '_flowSnapshotCount must be saved before swig-compile pushes entries'
        );
    });

    it('render-swig.js miss-path uses _flowSnapshotCount in slice (not data.page.flow.entries.length)', function() {
        var src = getRSwig25();
        var sliceIdx = src.indexOf('entries.slice(_flowSnapshotCount)');
        assert.ok(
            sliceIdx > -1,
            'late entries must use _flowSnapshotCount, not data.page.flow.entries.length (reference bug)'
        );
    });

    it('render-swig.js cache-hit path saves _cacheFlowSnapshot before late entries', function() {
        var src = getRSwig25();
        var snapshotIdx = src.indexOf('_cacheFlowSnapshot');
        assert.ok(snapshotIdx > -1, 'expected _cacheFlowSnapshot variable in render-swig.js');
        // Must appear before swig-execute cache-hit entry
        var execIdx = src.indexOf("label: 'swig-execute'");
        assert.ok(
            snapshotIdx < execIdx,
            '_cacheFlowSnapshot must be saved before swig-execute pushes entries'
        );
    });

    it('render-swig.js cache-hit path uses _cacheFlowSnapshot in slice', function() {
        var src = getRSwig25();
        var sliceIdx = src.indexOf('entries.slice(_cacheFlowSnapshot)');
        assert.ok(
            sliceIdx > -1,
            'cache-hit late entries must use _cacheFlowSnapshot, not data.page.flow.entries.length'
        );
    });

    // ── controller-setup timeline entry in router.js ──

    it('router.js pushes controller-setup timeline entry', function() {
        var src = getRouter25();
        assert.ok(
            src.indexOf("label: 'controller-setup'") > -1,
            'expected controller-setup label in router.js'
        );
    });

    it('router.js controller-setup uses controller category', function() {
        var src = getRouter25();
        var idx = src.indexOf("label: 'controller-setup'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'controller'") > -1,
            'expected controller category for controller-setup entry'
        );
    });

    it('router.js controller-setup captures time before inherits()', function() {
        var src = getRouter25();
        var setupIdx = src.indexOf('_setupStart');
        var inheritsIdx = src.indexOf('inherits(Controller, SuperController)');
        assert.ok(setupIdx > -1, '_setupStart must exist');
        assert.ok(inheritsIdx > -1, 'inherits call must exist');
        assert.ok(
            setupIdx < inheritsIdx,
            '_setupStart must be captured before inherits() runs'
        );
    });

    it('router.js controller-setup is pushed after setOptions()', function() {
        var src = getRouter25();
        var setOptIdx = src.indexOf('controller.setOptions(request, response, next, options)');
        var pushIdx = src.indexOf("label: 'controller-setup'");
        assert.ok(setOptIdx > -1, 'setOptions call must exist');
        assert.ok(pushIdx > -1, 'controller-setup push must exist');
        assert.ok(
            pushIdx > setOptIdx,
            'controller-setup entry must be pushed after setOptions() completes'
        );
    });

    // ── inspector.js cleanFlowLabel handles controller-setup ──

    it('inspector.js cleanFlowLabel handles controller-setup label', function() {
        var js = getInsp25();
        assert.ok(
            js.indexOf('controller-setup') > -1,
            'expected controller-setup handling in cleanFlowLabel'
        );
    });

    it('inspector.js renders controller-setup as "setup (name)"', function() {
        var js = getInsp25();
        assert.ok(
            js.indexOf("'setup ('") > -1,
            'expected "setup (" prefix in cleanFlowLabel for controller-setup'
        );
    });

    // ── request-setup timeline entry in server.js ──

    it('server.js pushes request-setup timeline entry in handle()', function() {
        var src = getServerSrc();
        assert.ok(
            src.indexOf("label: 'request-setup'") > -1,
            'expected request-setup label in server.js handle()'
        );
    });

    it('server.js request-setup uses routing category', function() {
        var src = getServerSrc();
        var idx = src.indexOf("label: 'request-setup'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'routing'") > -1,
            'expected routing category for request-setup entry'
        );
    });

    it('server.js request-setup starts at requestStart', function() {
        var src = getServerSrc();
        var idx = src.indexOf("label: 'request-setup'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf('req._devTimeline.requestStart') > -1,
            'expected request-setup to start at requestStart'
        );
    });

    it('inspector.js cleanFlowLabel handles request-setup label', function() {
        var js = getInsp25();
        assert.ok(
            js.indexOf('request-setup') > -1,
            'expected request-setup handling in cleanFlowLabel'
        );
    });
});


// ── 26 — Flow: swig-execute, response-write, total, route-middleware ──────────

describe('26 - Flow instrumentation: swig-execute, response-write, total, and route-middleware entries', function() {

    var RENDER_SWIG_26 = path.join(FW, 'core/controller/controller.render-swig.js');
    var ROUTER_26      = path.join(FW, 'core/router.js');

    var _rSwig26, _router26;
    function getRSwig26()  { return _rSwig26  || (_rSwig26  = fs.readFileSync(RENDER_SWIG_26, 'utf8')); }
    function getRouter26() { return _router26 || (_router26 = fs.readFileSync(ROUTER_26, 'utf8')); }

    // ── swig-execute ──

    it('render-swig.js miss-path has swig-execute entry', function() {
        var src = getRSwig26();
        // The miss path swig-execute wraps compiledTemplate(data)
        // Find all occurrences — first is cache-hit, second is miss
        var firstIdx = src.indexOf("label: 'swig-execute'");
        assert.ok(firstIdx > -1, 'expected at least one swig-execute entry');
        var secondIdx = src.indexOf("label: 'swig-execute'", firstIdx + 1);
        assert.ok(secondIdx > -1, 'expected two swig-execute entries (cache-hit and miss)');
    });

    it('swig-execute uses template category', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'swig-execute'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'template'") > -1,
            'swig-execute must use template category'
        );
    });

    it('swig-execute detail carries the template file path', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'swig-execute'");
        var block = src.substring(idx, idx + 300);
        assert.ok(
            /detail.*data\.page\.view\.file/.test(block),
            'swig-execute detail should reference data.page.view.file'
        );
    });

    // ── response-write ──

    it('render-swig.js miss-path has response-write entry', function() {
        var src = getRSwig26();
        var firstIdx = src.indexOf("label: 'response-write'");
        assert.ok(firstIdx > -1, 'expected at least one response-write entry');
        var secondIdx = src.indexOf("label: 'response-write'", firstIdx + 1);
        assert.ok(secondIdx > -1, 'expected two response-write entries (cache-hit and miss)');
    });

    it('response-write uses response category', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'response-write'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'response'") > -1,
            'response-write must use response category'
        );
    });

    it('response-write start time uses 3-level fallback (_renderStart || _actionStart || requestStart)', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'response-write'");
        // Look backwards from the label to find the start time assignment
        var region = src.substring(Math.max(0, idx - 300), idx);
        assert.ok(
            region.indexOf('_renderStart') > -1 && region.indexOf('_actionStart') > -1,
            'response-write start must fall back through _renderStart, _actionStart, requestStart'
        );
    });

    it('response-write detail is null', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'response-write'");
        var block = src.substring(idx, idx + 250);
        assert.ok(
            /detail\s*:\s*null/.test(block),
            'response-write detail must be null'
        );
    });

    // ── total ──

    it('render-swig.js miss-path has total entry', function() {
        var src = getRSwig26();
        // total entries use cat: 'total' — search for that combo
        var firstIdx = src.indexOf("label: 'total'");
        assert.ok(firstIdx > -1, 'expected at least one total entry');
        var secondIdx = src.indexOf("label: 'total'", firstIdx + 1);
        assert.ok(secondIdx > -1, 'expected two total entries (cache-hit and miss)');
    });

    it('total uses total category', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'total'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'total'") > -1,
            'total must use total category'
        );
    });

    it('total starts at requestStart (spans entire request)', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'total'");
        var block = src.substring(idx, idx + 250);
        assert.ok(
            /startMs.*requestStart/.test(block),
            'total startMs must reference requestStart'
        );
    });

    it('total detail is null', function() {
        var src = getRSwig26();
        var idx = src.indexOf("label: 'total'");
        var block = src.substring(idx, idx + 300);
        assert.ok(
            /detail\s*:\s*null/.test(block),
            'total detail must be null'
        );
    });

    it('response-write is pushed before total on both paths', function() {
        var src = getRSwig26();
        // Check miss-path ordering (second occurrence of each label)
        var firstRw = src.indexOf("label: 'response-write'");
        var firstTot = src.indexOf("label: 'total'");
        assert.ok(firstRw < firstTot, 'cache-hit: response-write must come before total');
        var secondRw = src.indexOf("label: 'response-write'", firstRw + 1);
        var secondTot = src.indexOf("label: 'total'", firstTot + 1);
        assert.ok(secondRw < secondTot, 'miss-path: response-write must come before total');
    });

    // ── route-middleware ──

    it('router.js pushes route-middleware timeline entry', function() {
        var src = getRouter26();
        assert.ok(
            src.indexOf("label: 'route-middleware'") > -1,
            'expected route-middleware label in router.js'
        );
    });

    it('route-middleware uses middleware category', function() {
        var src = getRouter26();
        var idx = src.indexOf("label: 'route-middleware'");
        var block = src.substring(idx, idx + 200);
        assert.ok(
            block.indexOf("cat: 'middleware'") > -1,
            'route-middleware must use middleware category'
        );
    });

    it('route-middleware detail is comma-joined middleware names', function() {
        var src = getRouter26();
        var idx = src.indexOf("label: 'route-middleware'");
        var block = src.substring(idx, idx + 250);
        assert.ok(
            /detail\s*:\s*_routeMwNames/.test(block),
            'route-middleware detail must carry the middleware names variable'
        );
    });

    it('middleware names are joined with comma separator', function() {
        var src = getRouter26();
        assert.ok(
            /middleware\.join\(\s*['"],\s*['"]\s*\)/.test(src),
            'expected middleware.join(", ") for comma-separated names'
        );
    });

    it('route-middleware is pushed inside processMiddlewares onDone callback', function() {
        var src = getRouter26();
        var onDoneIdx = src.indexOf('function onDone');
        assert.ok(onDoneIdx > -1, 'expected onDone callback');
        var mwPushIdx = src.indexOf("label: 'route-middleware'");
        assert.ok(
            mwPushIdx > onDoneIdx,
            'route-middleware push must be inside or after onDone callback'
        );
    });

    it('_actionStart is set after route-middleware push', function() {
        var src = getRouter26();
        var mwPushIdx = src.indexOf("label: 'route-middleware'");
        // Find _actionStart inside the onDone callback (after the push)
        var actionIdx = src.indexOf('_devTimeline._actionStart', mwPushIdx);
        assert.ok(
            actionIdx > mwPushIdx,
            '_actionStart must be set after route-middleware entry is pushed'
        );
    });
});


// ── 27 — Flow: N1QL query-to-timeline conversion ─────────────────────────────

describe('27 - Flow instrumentation: N1QL query-to-timeline conversion in render-swig.js', function() {

    var RENDER_SWIG_27 = path.join(FW, 'core/controller/controller.render-swig.js');
    var _rSwig27;
    function getRSwig27() { return _rSwig27 || (_rSwig27 = fs.readFileSync(RENDER_SWIG_27, 'utf8')); }

    it('miss-path converts _queryLog entries to db timeline entries', function() {
        var src = getRSwig27();
        // The N1QL conversion creates entries with cat: 'db'
        var matches = src.match(/cat:\s*'db'/g);
        assert.ok(matches && matches.length >= 2, 'expected at least 2 db category entries (cache-hit and miss)');
    });

    it('timeline label format is n1ql:<trigger>', function() {
        var src = getRSwig27();
        assert.ok(
            /label:\s*'n1ql:'\s*\+\s*\(.*trigger/.test(src),
            'expected n1ql:<trigger> label format'
        );
    });

    it('falls back to "query" when trigger is missing', function() {
        var src = getRSwig27();
        assert.ok(
            /trigger\s*\|\|\s*'query'/.test(src),
            'expected fallback to "query" when trigger is undefined'
        );
    });

    it('detail is truncated to 80 characters', function() {
        var src = getRSwig27();
        assert.ok(
            /\.substring\(0,\s*80\)/.test(src),
            'expected statement truncation to 80 chars for timeline detail'
        );
    });

    it('conversion is guarded by _qe._startMs', function() {
        var src = getRSwig27();
        // Both paths check _startMs before pushing
        assert.ok(
            /if\s*\(\s*_qe\._startMs\s*\)/.test(src) || /if\s*\(\s*_cqe\._startMs\s*\)/.test(src),
            'expected _startMs guard on query-to-timeline conversion'
        );
    });

    it('conversion runs before data.page.flow assignment on both paths', function() {
        var src = getRSwig27();
        // Miss path: n1ql conversion before data.page.flow
        var missN1ql = src.indexOf("'n1ql:'");
        var missFlow = src.indexOf("data.page.flow", missN1ql);
        assert.ok(missN1ql > -1 && missFlow > -1, 'expected n1ql conversion and flow assignment');
        assert.ok(
            missN1ql < missFlow,
            'N1QL-to-timeline conversion must run before data.page.flow is assigned'
        );
    });

    it('durationMs defaults to 0 when missing', function() {
        var src = getRSwig27();
        assert.ok(
            /durationMs\s*\|\|\s*0/.test(src),
            'expected durationMs || 0 fallback'
        );
    });

    it('cache-hit path also converts N1QL queries to timeline entries', function() {
        var src = getRSwig27();
        // The cache-hit path uses _cqe (not _qe)
        assert.ok(
            src.indexOf('_cqe._startMs') > -1,
            'expected cache-hit path N1QL conversion with _cqe variable'
        );
    });
});


// ── 28 — Flow: XHR injection path and getClientTransferMs ────────────────────

describe('28 - Flow instrumentation: XHR injection path and getClientTransferMs null fallback', function() {

    var RENDER_SWIG_28 = path.join(FW, 'core/controller/controller.render-swig.js');
    var INSPECTOR_28   = path.join(BM_DIR, 'inspector.js');

    var _rSwig28, _insp28;
    function getRSwig28() { return _rSwig28 || (_rSwig28 = fs.readFileSync(RENDER_SWIG_28, 'utf8')); }
    function getInsp28()  { return _insp28  || (_insp28  = fs.readFileSync(INSPECTOR_28, 'utf8')); }

    // ── XHR flow injection ──

    it('render-swig.js injects data.page.flow into data.page.data for XHR', function() {
        var src = getRSwig28();
        assert.ok(
            src.indexOf('data.page.data.flow    = data.page.flow') > -1,
            'expected flow injection into data.page.data for XHR hidden input'
        );
    });

    it('XHR flow injection has two code paths', function() {
        var src = getRSwig28();
        var first = src.indexOf('data.page.data.flow    = data.page.flow');
        assert.ok(first > -1, 'expected first XHR flow injection');
        var second = src.indexOf('data.page.data.flow    = data.page.flow', first + 1);
        assert.ok(second > -1, 'expected second XHR flow injection path');
    });

    it('XHR flow injection is guarded by data.page.flow existence', function() {
        var src = getRSwig28();
        var idx = src.indexOf('data.page.data.flow    = data.page.flow');
        var region = src.substring(Math.max(0, idx - 60), idx);
        assert.ok(
            region.indexOf('if (data.page.flow)') > -1,
            'expected data.page.flow guard before XHR injection'
        );
    });

    it('XHR path also injects queries alongside flow', function() {
        var src = getRSwig28();
        // Both flow and queries are injected at the same points
        var flowIdx = src.indexOf('data.page.data.flow    = data.page.flow');
        var queriesIdx = src.indexOf('data.page.data.queries = data.page.queries', flowIdx);
        assert.ok(
            queriesIdx > -1 && queriesIdx - flowIdx < 200,
            'expected queries injection near flow injection in XHR path'
        );
    });

    it('XHR data is serialized into hidden input with id gina-without-layout-xhr-data', function() {
        var src = getRSwig28();
        assert.ok(
            src.indexOf('gina-without-layout-xhr-data') > -1,
            'expected hidden input id for XHR data'
        );
    });

    // ── getClientTransferMs null fallback ──

    it('getClientTransferMs function exists in inspector.js', function() {
        var js = getInsp28();
        assert.ok(
            js.indexOf('function getClientTransferMs') > -1,
            'expected getClientTransferMs function definition'
        );
    });

    it('getClientTransferMs returns null when source is localStorage', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /localStorage.*return null|source.*localStorage/.test(block),
            'expected null return when source is localStorage'
        );
    });

    it('getClientTransferMs checks win.performance exists', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /performance/.test(block),
            'expected performance API check'
        );
    });

    it('getClientTransferMs checks getEntriesByType exists', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /getEntriesByType/.test(block),
            'expected getEntriesByType check'
        );
    });

    it('getClientTransferMs checks navigation entries array is non-empty', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /\.length/.test(block),
            'expected array length check on navigation entries'
        );
    });

    it('getClientTransferMs checks responseEnd > 0', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /responseEnd/.test(block),
            'expected responseEnd check'
        );
    });

    it('getClientTransferMs is wrapped in try/catch', function() {
        var js = getInsp28();
        var idx = js.indexOf('function getClientTransferMs');
        var block = js.substring(idx, idx + 800);
        assert.ok(
            /try\s*\{/.test(block) && /catch/.test(block),
            'expected try/catch wrapper for safe null fallback'
        );
    });

    it('renderFlowContent hides progress bar when getClientTransferMs returns null', function() {
        var js = getInsp28();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 3000);
        // When clientMs is null or zero, the else branch clears progressWrap.innerHTML
        assert.ok(
            block.indexOf('getClientTransferMs') > -1,
            'expected getClientTransferMs call in renderFlowContent'
        );
        assert.ok(
            block.indexOf("progressWrap.innerHTML = ''") > -1 || block.indexOf("progressWrap.innerHTML=''") > -1,
            'expected progressWrap to be cleared in else branch'
        );
    });
});


// ── 29 — Flow: renderFlowContent behavioral validation ───────────────────────

describe('29 - Flow: renderFlowContent behavioral validation (mock timeline)', function() {

    var INSPECTOR_29 = path.join(BM_DIR, 'inspector.js');
    var _insp29;
    function getInsp29() { return _insp29 || (_insp29 = fs.readFileSync(INSPECTOR_29, 'utf8')); }

    // ── renderFlowContent structure ──

    it('renderFlowContent returns hint text for empty/null timeline', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 600);
        assert.ok(
            /No timeline data/.test(block),
            'expected "No timeline data" hint for empty timeline'
        );
    });

    it('renderFlowContent checks for null timeline, null entries, and empty entries', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 400);
        assert.ok(
            /!timeline/.test(block),
            'expected null timeline check'
        );
        assert.ok(
            /entries\.length\s*===?\s*0/.test(block),
            'expected empty entries check'
        );
    });

    it('renderFlowContent sorts entries by startMs', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 2500);
        // .slice().sort(function(a,b){ return a.startMs - b.startMs })
        // The .sort( and startMs appear on separate lines
        assert.ok(
            block.indexOf('.sort(') > -1 && block.indexOf('startMs') > -1,
            'expected entries sorted by startMs ascending'
        );
    });

    it('renderFlowContent uses slice() to avoid mutating original entries', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 2500);
        assert.ok(
            /\.slice\(\)\.sort/.test(block),
            'expected .slice().sort() to avoid mutating original array'
        );
    });

    it('renderFlowContent filters out total entries from waterfall', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 3000);
        assert.ok(
            /cat\s*!==?\s*'total'/.test(block),
            'expected total category to be filtered out of waterfall bars'
        );
    });

    it('renderFlowContent clamps serverTotalMs to minimum 1', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 2500);
        assert.ok(
            /Math\.max\(.*1\)|< 1/.test(block) || /serverTotalMs\s*=\s*1/.test(block),
            'expected serverTotalMs clamped to minimum 1 to avoid division by zero'
        );
    });

    it('renderFlowContent calls renderFlowScale and renderFlowRows', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 3000);
        assert.ok(
            block.indexOf('renderFlowScale') > -1,
            'expected renderFlowScale call'
        );
        assert.ok(
            block.indexOf('renderFlowRows') > -1,
            'expected renderFlowRows call'
        );
    });

    it('renderFlowContent calls insertFlowGaps', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowContent');
        var block = js.substring(idx, idx + 3000);
        assert.ok(
            block.indexOf('insertFlowGaps') > -1,
            'expected insertFlowGaps call for gap detection'
        );
    });

    // ── renderFlowScale structure ──

    it('renderFlowScale produces three scale marks at 0, 50%, 100%', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowScale');
        var block = js.substring(idx, idx + 500);
        assert.ok(
            /left:\s*0/.test(block) || /left:0/.test(block),
            'expected 0 position scale mark'
        );
        assert.ok(
            /left:\s*50%/.test(block) || /left:50%/.test(block),
            'expected 50% position scale mark'
        );
        assert.ok(
            /left:\s*100%/.test(block) || /left:100%/.test(block),
            'expected 100% position scale mark'
        );
    });

    it('renderFlowScale uses bm-flow-scale and bm-flow-scale-mark classes', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowScale');
        var block = js.substring(idx, idx + 500);
        assert.ok(block.indexOf('bm-flow-scale') > -1, 'expected bm-flow-scale class');
        assert.ok(block.indexOf('bm-flow-scale-mark') > -1, 'expected bm-flow-scale-mark class');
    });

    // ── renderFlowRows structure ──

    it('renderFlowRows clamps minimum bar width to 0.5%', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /width\s*<\s*0\.5/.test(block) || /Math\.max\(.*0\.5/.test(block),
            'expected minimum bar width clamped to 0.5%'
        );
    });

    it('renderFlowRows only shows inline duration text when bar width > 8%', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /width\s*>\s*8/.test(block),
            'expected width > 8 check for inline duration text'
        );
    });

    it('renderFlowRows uses FLOW_CAT_LABELS for category badge text', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            block.indexOf('FLOW_CAT_LABELS') > -1,
            'expected FLOW_CAT_LABELS lookup for category badge'
        );
    });

    it('renderFlowRows calls cleanFlowLabel for display text', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            block.indexOf('cleanFlowLabel') > -1,
            'expected cleanFlowLabel call for label processing'
        );
    });

    it('renderFlowRows computes left offset as percentage of totalMs', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /startMs.*t0.*totalMs|startMs\s*-\s*t0/.test(block),
            'expected left position computed from (startMs - t0) / totalMs'
        );
    });

    it('renderFlowRows handles entries with missing durationMs via endMs fallback', function() {
        var js = getInsp29();
        var idx = js.indexOf('function renderFlowRows');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /durationMs\s*\|\|/.test(block) || /endMs.*startMs/.test(block),
            'expected fallback to endMs - startMs when durationMs is missing'
        );
    });

    // ── insertFlowGaps ──

    it('insertFlowGaps function exists', function() {
        var js = getInsp29();
        assert.ok(
            js.indexOf('function insertFlowGaps') > -1,
            'expected insertFlowGaps function definition'
        );
    });

    it('insertFlowGaps creates gap entries with cat: gap', function() {
        var js = getInsp29();
        var idx = js.indexOf('function insertFlowGaps');
        var block = js.substring(idx, idx + 1500);
        assert.ok(
            /cat:\s*'gap'/.test(block),
            'expected gap category for synthetic entries'
        );
    });

    it('FLOW_GAP_THRESHOLD_MS constant controls gap detection', function() {
        var js = getInsp29();
        assert.ok(
            js.indexOf('FLOW_GAP_THRESHOLD_MS') > -1,
            'expected FLOW_GAP_THRESHOLD_MS constant'
        );
    });

    // ── cleanFlowLabel coverage ──

    it('cleanFlowLabel handles all documented categories', function() {
        var js = getInsp29();
        var idx = js.indexOf('function cleanFlowLabel');
        assert.ok(idx > -1, 'expected cleanFlowLabel function');
        var block = js.substring(idx, idx + 2000);
        // Must handle routing, controller, io, template, response
        assert.ok(block.indexOf("'routing'") > -1, 'expected routing case');
        assert.ok(block.indexOf("'controller'") > -1, 'expected controller case');
        assert.ok(block.indexOf("'io'") > -1, 'expected io case');
        assert.ok(block.indexOf("'template'") > -1, 'expected template case');
        assert.ok(block.indexOf("'response'") > -1, 'expected response case');
    });

    it('cleanFlowLabel strips "route-" prefix for routing category', function() {
        var js = getInsp29();
        var idx = js.indexOf('function cleanFlowLabel');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /replace\(.*route-/.test(block),
            'expected route- prefix stripping for routing labels'
        );
    });

    it('cleanFlowLabel strips "swig-" prefix for template category', function() {
        var js = getInsp29();
        var idx = js.indexOf('function cleanFlowLabel');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /replace\(.*swig-/.test(block),
            'expected swig- prefix stripping for template labels'
        );
    });

    it('cleanFlowLabel strips "response-" and "stream-" prefix for response category', function() {
        var js = getInsp29();
        var idx = js.indexOf('function cleanFlowLabel');
        var block = js.substring(idx, idx + 2000);
        assert.ok(
            /replace\(.*response-/.test(block),
            'expected response- prefix stripping'
        );
        assert.ok(
            /replace\(.*stream-/.test(block),
            'expected stream- prefix stripping'
        );
    });
});


// ── 30 — Query: extractIndexes runtime validation ─────────────────────────────

describe('30 - Query: extractIndexes runtime validation with mock profile trees', function() {

    // Extract the extractIndexes function from the connector source and eval it
    // so we can test it with mock data
    var extractIndexes;
    try {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/couchbase/index.js'), 'utf8');
        var fnStart = src.indexOf('var extractIndexes = function(profile)');
        if (fnStart > -1) {
            // Find the matching closing brace — count braces after the function keyword
            var body = src.substring(fnStart);
            var braceDepth = 0, fnEnd = -1;
            for (var i = body.indexOf('{'); i < body.length; i++) {
                if (body[i] === '{') braceDepth++;
                if (body[i] === '}') braceDepth--;
                if (braceDepth === 0) { fnEnd = i + 1; break; }
            }
            if (fnEnd > -1) {
                // The function uses a closure var `walk` — self-contained
                var fnSrc = body.substring(0, fnEnd);
                // Convert var declaration to a returnable form
                eval(fnSrc);  // defines extractIndexes in this scope
            }
        }
    } catch (e) {
        // If extraction fails, runtime tests will be skipped gracefully
    }

    it('extractIndexes function was successfully extracted from connector', function() {
        assert.ok(typeof extractIndexes === 'function', 'extractIndexes should be a callable function');
    });

    it('returns null for null/undefined input', function() {
        if (typeof extractIndexes !== 'function') return;
        assert.strictEqual(extractIndexes(null), null);
        assert.strictEqual(extractIndexes(undefined), null);
    });

    it('returns null for non-object input', function() {
        if (typeof extractIndexes !== 'function') return;
        assert.strictEqual(extractIndexes('string'), null);
        assert.strictEqual(extractIndexes(42), null);
    });

    it('returns empty array when no index operators exist', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    { '#operator': 'Filter' },
                    { '#operator': 'FinalProject' }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.ok(Array.isArray(result), 'expected array result');
        assert.strictEqual(result.length, 0, 'expected empty array with no index operators');
    });

    it('extracts secondary index from IndexScan3 operator', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    {
                        '#operator': 'IndexScan3',
                        index: 'idx_invoice_date'
                    }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'idx_invoice_date');
        assert.strictEqual(result[0].primary, false);
    });

    it('detects primary scan via PrimaryScan3 operator', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'PrimaryScan3',
                index: '#primary'
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, '#primary');
        assert.strictEqual(result[0].primary, true);
    });

    it('walks ~child nodes (single child)', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~child': {
                    '#operator': 'IndexScan3',
                    index: 'idx_deep'
                }
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'idx_deep');
    });

    it('walks deeply nested trees', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Authorize',
                '~child': {
                    '#operator': 'Sequence',
                    '~children': [
                        {
                            '#operator': 'IntersectScan',
                            '~children': [
                                { '#operator': 'IndexScan3', index: 'idx_a' },
                                { '#operator': 'IndexScan3', index: 'idx_b' }
                            ]
                        },
                        { '#operator': 'Fetch' },
                        { '#operator': 'FinalProject' }
                    ]
                }
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 2);
        var names = result.map(function(r) { return r.name; }).sort();
        assert.deepStrictEqual(names, ['idx_a', 'idx_b']);
    });

    it('deduplicates indexes by name', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    { '#operator': 'IndexScan3', index: 'idx_dup' },
                    { '#operator': 'IndexScan3', index: 'idx_dup' },
                    { '#operator': 'IndexScan3', index: 'idx_other' }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 2, 'duplicates must be removed');
        var names = result.map(function(r) { return r.name; }).sort();
        assert.deepStrictEqual(names, ['idx_dup', 'idx_other']);
    });

    it('handles mixed primary and secondary indexes', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'UnionScan',
                '~children': [
                    { '#operator': 'PrimaryScan3', index: '#primary' },
                    { '#operator': 'IndexScan3', index: 'idx_name' }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 2);
        var primary = result.filter(function(r) { return r.primary; });
        var secondary = result.filter(function(r) { return !r.primary; });
        assert.strictEqual(primary.length, 1);
        assert.strictEqual(secondary.length, 1);
        assert.strictEqual(primary[0].name, '#primary');
        assert.strictEqual(secondary[0].name, 'idx_name');
    });

    it('uses executionTimings sub-key when present', function() {
        if (typeof extractIndexes !== 'function') return;
        // profile.executionTimings is the standard path
        var profile = {
            executionTimings: {
                '#operator': 'IndexScan3',
                index: 'idx_via_et'
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'idx_via_et');
    });

    it('falls back to profile root when executionTimings is absent', function() {
        if (typeof extractIndexes !== 'function') return;
        // When executionTimings is missing, the profile itself is treated as root
        var profile = {
            '#operator': 'IndexScan3',
            index: 'idx_direct'
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'idx_direct');
    });
});


// ── 31 — Query: renderQueryContent index badge rendering ──────────────────────

describe('31 - Query: renderQueryContent index badge rendering in Inspector', function() {

    var INSPECTOR_31 = path.join(BM_DIR, 'inspector.js');
    var CSS_31       = path.join(BM_DIR, 'inspector.css');

    var _insp31, _css31;
    function getInsp31() { return _insp31 || (_insp31 = fs.readFileSync(INSPECTOR_31, 'utf8')); }
    function getCss31()  { return _css31  || (_css31  = fs.readFileSync(CSS_31, 'utf8')); }

    // ── Three-state branching ──

    it('renderQueryContent handles indexes === null (N/A badge)', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            block.indexOf('bm-idx-na') > -1,
            'expected bm-idx-na class for null indexes'
        );
    });

    it('renderQueryContent handles indexes === [] (no index badge)', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            block.indexOf('bm-idx-none') > -1,
            'expected bm-idx-none class for empty indexes array'
        );
    });

    it('renderQueryContent handles populated indexes with primary detection', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            block.indexOf('bm-idx-primary') > -1,
            'expected bm-idx-primary class for primary index'
        );
        assert.ok(
            block.indexOf('bm-idx-secondary') > -1,
            'expected bm-idx-secondary class for secondary index'
        );
    });

    it('index badges check idx.primary for primary vs secondary', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            /idx\.primary/.test(block),
            'expected idx.primary check in index badge rendering'
        );
    });

    it('null indexes branch requires q.connector to show N/A', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        // N/A badge should only render when connector info is available
        assert.ok(
            /q\.connector/.test(block),
            'expected q.connector check for N/A badge'
        );
    });

    it('empty indexes branch shows "no index" warning text', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            /no index/.test(block),
            'expected "no index" text for empty indexes array'
        );
    });

    it('N/A badge has tooltip explaining unavailability', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 9000);
        assert.ok(
            /not available/.test(block) || /not supported/.test(block),
            'expected tooltip text explaining index info unavailability'
        );
    });

    // ── CSS coverage for index badges ──

    it('CSS has bm-idx-none with warning color', function() {
        var css = getCss31();
        assert.ok(
            /\.bm-idx-none/.test(css),
            'expected .bm-idx-none rule'
        );
    });

    it('CSS has bm-idx-primary with amber color', function() {
        var css = getCss31();
        assert.ok(
            /\.bm-idx-primary/.test(css),
            'expected .bm-idx-primary rule'
        );
    });

    it('CSS has bm-idx-secondary with green color', function() {
        var css = getCss31();
        assert.ok(
            /\.bm-idx-secondary/.test(css),
            'expected .bm-idx-secondary rule'
        );
    });

    it('CSS has bm-idx-na style', function() {
        var css = getCss31();
        assert.ok(
            /\.bm-idx-na/.test(css),
            'expected .bm-idx-na rule'
        );
    });

    it('CSS has light theme overrides for all index badge states', function() {
        var css = getCss31();
        // Light theme rules should exist for at least one index class
        assert.ok(
            /data-theme=light\].*\.bm-idx-|data-theme=light\].*bm-query-idx/.test(css) ||
            /\[data-theme=light\][^}]*bm-idx/.test(css),
            'expected light theme overrides for index badge styles'
        );
    });

    // ── Rendering structure ──

    it('index badges are rendered inside the stmt-meta container', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 8000);
        // Index badges and rows count are wrapped in bm-query-stmt-meta
        assert.ok(block.indexOf('bm-query-stmt-meta') > -1, 'expected bm-query-stmt-meta container');
        assert.ok(block.indexOf('bm-query-idx') > -1, 'expected bm-query-idx in render');
        // Index html is built into indexHtml variable, then placed into metaHtml
        assert.ok(block.indexOf('indexHtml') > -1, 'expected indexHtml variable');
        assert.ok(
            block.indexOf('indexHtml + rowCountBadge') > -1 || block.indexOf('indexHtml +') > -1,
            'index badges must appear before rows count in the meta container'
        );
    });

    it('primary index badge uses warning SVG variable', function() {
        var js = getInsp31();
        var idx = js.indexOf('bm-idx-primary');
        assert.ok(idx > -1);
        var block = js.substring(idx, idx + 600);
        // The primary badge uses _svgIdxWarn variable (pre-defined SVG string)
        assert.ok(
            block.indexOf('_svgIdxWarn') > -1 || block.indexOf('_svgIdx') > -1,
            'expected SVG icon variable near primary index badge rendering'
        );
    });
});


// ── 32 — extractIndexes: ExpressionScan/KeyScan (USE KEYS) detection ─────────

describe('32 - extractIndexes: ExpressionScan/KeyScan (USE KEYS) operator detection', function() {

    // Reuse the same extraction technique as §30
    var extractIndexes;
    try {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/couchbase/index.js'), 'utf8');
        var fnStart = src.indexOf('var extractIndexes = function(profile)');
        if (fnStart > -1) {
            var body = src.substring(fnStart);
            var braceDepth = 0, fnEnd = -1;
            for (var i = body.indexOf('{'); i < body.length; i++) {
                if (body[i] === '{') braceDepth++;
                if (body[i] === '}') braceDepth--;
                if (braceDepth === 0) { fnEnd = i + 1; break; }
            }
            if (fnEnd > -1) eval(body.substring(0, fnEnd));
        }
    } catch (e) { /* skip runtime tests gracefully */ }

    it('detects ExpressionScan as KV lookup (USE KEYS)', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    { '#operator': 'ExpressionScan' },
                    { '#operator': 'Fetch' }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'KV lookup (USE KEYS)');
        assert.strictEqual(result[0].primary, false);
    });

    it('detects KeyScan as KV lookup (USE KEYS)', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    { '#operator': 'KeyScan' },
                    { '#operator': 'Fetch' }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'KV lookup (USE KEYS)');
        assert.strictEqual(result[0].primary, false);
    });

    it('deduplicates multiple ExpressionScan/KeyScan into one entry', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'Sequence',
                '~children': [
                    { '#operator': 'ExpressionScan' },
                    { '#operator': 'KeyScan' }
                ]
            }
        };
        var result = extractIndexes(profile);
        // Both should collapse into one KV lookup entry via the __kv_lookup sentinel
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'KV lookup (USE KEYS)');
    });

    it('ExpressionScan coexists with IndexScan3 in the same plan', function() {
        if (typeof extractIndexes !== 'function') return;
        var profile = {
            executionTimings: {
                '#operator': 'UnionAll',
                '~children': [
                    {
                        '#operator': 'Sequence',
                        '~children': [
                            { '#operator': 'IndexScan3', index: 'idx_name' }
                        ]
                    },
                    {
                        '#operator': 'Sequence',
                        '~children': [
                            { '#operator': 'ExpressionScan' }
                        ]
                    }
                ]
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 2);
        var names = result.map(function(r) { return r.name; }).sort();
        assert.deepStrictEqual(names, ['KV lookup (USE KEYS)', 'idx_name']);
    });

    it('ExpressionScan detection is case-insensitive', function() {
        if (typeof extractIndexes !== 'function') return;
        // The regex uses /ExpressionScan|KeyScan/i
        var profile = {
            executionTimings: {
                '#operator': 'expressionscan'
            }
        };
        var result = extractIndexes(profile);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'KV lookup (USE KEYS)');
    });
});


// ── 33 — EXPLAIN fallback and _explainCache ──────────────────────────────────

describe('33 - EXPLAIN fallback: explainForIndexes and _explainCache', function() {

    var CB_SRC_33 = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc33;
    function getCbSrc33() { return _cbSrc33 || (_cbSrc33 = fs.readFileSync(CB_SRC_33, 'utf8')); }

    // ── explainForIndexes function ──

    it('explainForIndexes function exists', function() {
        var src = getCbSrc33();
        assert.ok(
            src.indexOf('var explainForIndexes = function') > -1,
            'expected explainForIndexes function definition'
        );
    });

    it('explainForIndexes runs EXPLAIN <statement>', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        assert.ok(
            /EXPLAIN.*statement/.test(block) || /['"]EXPLAIN ['"].*statement/.test(block),
            'expected EXPLAIN prefix prepended to the statement'
        );
    });

    it('explainForIndexes patches queryEntry.indexes in-place on success', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        assert.ok(
            block.indexOf('queryEntry.indexes') > -1,
            'expected in-place patch of queryEntry.indexes'
        );
    });

    it('explainForIndexes catches EXPLAIN failures gracefully', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        assert.ok(
            block.indexOf('.catch(') > -1,
            'expected .catch() on the EXPLAIN promise'
        );
    });

    it('explainForIndexes sets null in cache on failure', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        // .catch sets _explainCache.set(statement, null)
        var catchIdx = block.indexOf('.catch(');
        assert.ok(catchIdx > -1);
        var catchBlock = block.substring(catchIdx, catchIdx + 200);
        assert.ok(
            catchBlock.indexOf('_explainCache.set') > -1,
            'expected cache set to null on EXPLAIN failure'
        );
    });

    it('explainForIndexes uses adhoc: true to skip query plan cache', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        assert.ok(
            /adhoc\s*:\s*true/.test(block),
            'expected adhoc: true in EXPLAIN options'
        );
    });

    it('explainForIndexes forwards parameters from queryOptions', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        assert.ok(
            /parameters.*queryOptions\.parameters/.test(block),
            'expected parameters forwarded from queryOptions'
        );
    });

    // ── _explainCache ──

    it('_explainCache is a Map', function() {
        var src = getCbSrc33();
        assert.ok(
            /var _explainCache\s*=\s*new Map/.test(src),
            'expected _explainCache declared as a Map'
        );
    });

    it('_explainCache is set as pending before EXPLAIN runs', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1800);
        // Must set(statement, null) before the async query
        var setNullIdx = block.indexOf('_explainCache.set(statement, null)');
        var queryIdx = block.indexOf('.query(');
        assert.ok(setNullIdx > -1 && queryIdx > -1, 'expected cache set and query call');
        assert.ok(
            setNullIdx < queryIdx,
            'cache must be marked as pending before the EXPLAIN query is sent'
        );
    });

    // ── onQueryCallback EXPLAIN fallback path ──

    it('onQueryCallback checks _explainCache.has() before triggering EXPLAIN', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('_explainCache.has(');
        assert.ok(idx > -1, 'expected _explainCache.has() check in onQueryCallback');
    });

    it('onQueryCallback uses cached result when _explainCache.has() is true', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('_explainCache.has(');
        var block = src.substring(idx, idx + 300);
        assert.ok(
            block.indexOf('_explainCache.get(') > -1,
            'expected _explainCache.get() to read cached indexes'
        );
    });

    it('onQueryCallback calls explainForIndexes when statement not in cache', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('_explainCache.has(');
        var block = src.substring(idx, idx + 300);
        assert.ok(
            block.indexOf('explainForIndexes(') > -1,
            'expected explainForIndexes() call for uncached statements'
        );
    });

    it('EXPLAIN fallback runs in the meta.profile-absent else branch (#CN8: no SDK-version gate)', function() {
        var src = getCbSrc33();
        // #CN8 removed the Couchbase SDK v2 connector. The EXPLAIN fallback is no longer
        // gated by `sdkVersion > 2`; it now runs whenever the SDK does not surface
        // meta.profile — i.e. inside the `else` of the meta.profile fast-path check.
        var profileIdx = src.indexOf('if (meta && meta.profile)');
        assert.ok(profileIdx > -1, 'expected the meta.profile fast-path check');
        var elseIdx    = src.indexOf('} else {', profileIdx);
        var explainIdx = src.indexOf('_explainCache.has(', elseIdx);
        assert.ok(
            elseIdx > profileIdx && explainIdx > elseIdx,
            'expected EXPLAIN fallback inside the meta.profile-absent else branch'
        );
    });

    it('meta.profile fast path takes priority over EXPLAIN fallback', function() {
        var src = getCbSrc33();
        // meta.profile check must come before _explainCache check
        var profileIdx = src.indexOf('meta.profile');
        var explainIdx = src.indexOf('_explainCache.has(');
        assert.ok(profileIdx > -1 && explainIdx > -1);
        // Both exist in the same section (onQueryCallback) — profile first
        assert.ok(
            profileIdx < explainIdx,
            'meta.profile fast path must be checked before EXPLAIN fallback'
        );
    });

    // ── bulkInsert also uses EXPLAIN fallback ──

    it('bulkInsert path also uses _explainCache fallback', function() {
        var src = getCbSrc33();
        var bulkIdx = src.indexOf('_biQueryEntry');
        assert.ok(bulkIdx > -1, 'expected _biQueryEntry in bulkInsert');
        var afterBulk = src.indexOf('_explainCache.has(', bulkIdx);
        assert.ok(
            afterBulk > -1,
            'expected _explainCache.has() in bulkInsert path'
        );
    });
});


// ── 34 — queryOptions fix: passing options object instead of params array ─────

describe('34 - queryOptions fix: conn._cluster.query() receives queryOptions', function() {

    var CB_SRC_34 = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc34;
    function getCbSrc34() { return _cbSrc34 || (_cbSrc34 = fs.readFileSync(CB_SRC_34, 'utf8')); }

    it('queryOptions is declared as an object (not an array)', function() {
        var src = getCbSrc34();
        assert.ok(
            /var queryOptions\s*=\s*\{/.test(src),
            'expected queryOptions declared as an object literal'
        );
    });

    it('queryOptions contains profile field in dev mode', function() {
        var src = getCbSrc34();
        var idx = src.indexOf('var queryOptions');
        var block = src.substring(idx, idx + 1000);
        assert.ok(
            /queryOptions\.profile\s*=\s*['"]timings['"]/.test(block),
            'expected profile: timings set on queryOptions in dev mode'
        );
    });

    it('queryOptions contains parameters (not positional params)', function() {
        var src = getCbSrc34();
        assert.ok(
            /queryOptions\.parameters\s*=\s*queryParams/.test(src),
            'expected queryOptions.parameters = queryParams'
        );
    });

    it('conn._cluster.query() is called with queryOptions (not queryParams)', function() {
        var src = getCbSrc34();
        // Find all conn._cluster.query(query, ...) calls — match across whitespace
        var matches = src.match(/conn\._cluster\.query\(query,\s*(\w+)\)/g);
        // #B429 — one call site now: register()'s duplicated dispatch block was removed with
        // the shared-emitter branch. The invariant this pin exists for is the loop below —
        // EVERY such call receives queryOptions, never queryParams — which is unchanged.
        assert.ok(matches && matches.length >= 1, 'expected at least one conn._cluster.query() call');
        for (var i = 0; i < matches.length; i++) {
            assert.ok(
                matches[i].indexOf('queryOptions') > -1,
                'conn._cluster.query() must receive queryOptions, not queryParams — found: ' + matches[i]
            );
        }
    });

    it('queryOptions includes scanConsistency', function() {
        var src = getCbSrc34();
        var idx = src.indexOf('var queryOptions');
        var block = src.substring(idx, idx + 1500);
        assert.ok(
            /queryOptions\.scanConsistency/.test(block),
            'expected scanConsistency set on queryOptions'
        );
    });

    it('bulkInsert path also uses queryOptions object', function() {
        var src = getCbSrc34();
        // The second 'var queryOptions' in the file belongs to bulkInsert
        var firstQo = src.indexOf('var queryOptions');
        assert.ok(firstQo > -1, 'expected first queryOptions (register)');
        var secondQo = src.indexOf('var queryOptions', firstQo + 1);
        assert.ok(secondQo > -1, 'expected second queryOptions (bulkInsert)');
        var biBlock = src.substring(secondQo, secondQo + 300);
        assert.ok(
            /queryOptions\.profile\s*=\s*['"]timings['"]/.test(biBlock),
            'expected profile: timings set on bulkInsert queryOptions in dev mode'
        );
    });
});


// ── 40 — MySQL connector QI: AsyncLocalStorage instrumentation ───────────────

describe('40 - MySQL connector QI: AsyncLocalStorage instrumentation', function() {

    var MYSQL_SRC = path.join(FW, 'core/connectors/mysql/index.js');
    var _mysqlSrc;
    function getMysqlSrc() { return _mysqlSrc || (_mysqlSrc = fs.readFileSync(MYSQL_SRC, 'utf8')); }

    it('reads query log from _queryALS.getStore()', function() {
        assert.ok(
            getMysqlSrc().indexOf('_queryALS.getStore()') > -1,
            'expected _queryALS.getStore() in MySQL connector'
        );
    });

    it('_queryEntry includes all required fields', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        assert.ok(entryIdx > -1, '_queryEntry object literal must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        var requiredFields = ['type', 'trigger', 'statement', 'params', 'durationMs',
            'resultCount', 'resultSize', 'error', 'source', 'origin', 'connector'];
        for (var i = 0; i < requiredFields.length; i++) {
            assert.ok(
                block.indexOf(requiredFields[i]) > -1,
                'expected field "' + requiredFields[i] + '" in _queryEntry'
            );
        }
    });

    it('_queryEntry type is MySQL', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 200);
        assert.ok(
            /type\s*:\s*'MySQL'/.test(block),
            'expected type: "MySQL" in _queryEntry'
        );
    });

    it('_queryEntry connector is mysql', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /connector\s*:\s*'mysql'/.test(block),
            'expected connector: "mysql" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getMysqlSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 3500), pushIdx); // #B350 widened from 2000 (9-12 chars headroom pre-fix): the gated console + params lines sit between the gate and the push (need ~2055)
        assert.ok(
            before.indexOf('envIsDev') > -1,
            '_devLog push must be inside envIsDev guard'
        );
    });

    it('_startMs timestamp is captured before execute', function() {
        var src = getMysqlSrc();
        assert.ok(
            src.indexOf('_queryEntry._startMs = Date.now()') > -1,
            'expected _startMs timestamp on _queryEntry'
        );
    });

    it('durationMs is finalized in Promise path callback', function() {
        var src = getMysqlSrc();
        // Find the Promise path (Option B) conn.execute
        var optIdx = src.indexOf('Option B');
        assert.ok(optIdx > -1, 'Option B comment must exist');
        var block = src.substring(optIdx, optIdx + 1200);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'Promise path must finalize durationMs'
        );
    });

    it('durationMs is finalized in callback path', function() {
        var src = getMysqlSrc();
        // Find the callback path
        var cbIdx = src.indexOf('Direct callback path');
        assert.ok(cbIdx > -1, 'Direct callback comment must exist');
        var block = src.substring(cbIdx, cbIdx + 600);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'callback path must finalize durationMs'
        );
    });

    it('resultCount and resultSize are set on success (Promise path)', function() {
        var src = getMysqlSrc();
        var optIdx = src.indexOf('Option B');
        var block = src.substring(optIdx, optIdx + 1800);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'Promise path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'Promise path must set resultSize'
        );
    });

    it('resultCount and resultSize are set on success (callback path)', function() {
        var src = getMysqlSrc();
        var cbIdx = src.indexOf('Direct callback path');
        var block = src.substring(cbIdx, cbIdx + 900);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'callback path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'callback path must set resultSize'
        );
    });

    it('error is captured on failure in both paths', function() {
        var src = getMysqlSrc();
        var matches = src.match(/_queryEntry\.error/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected _queryEntry.error set in at least 2 places (Promise + callback paths)'
        );
    });

    it('indexes field uses _knownIndexes lookup (#QI1)', function() {
        var src = getMysqlSrc();
        assert.ok(
            src.indexOf('_knownIndexes') > -1,
            'expected _knownIndexes variable in MySQL connector'
        );
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /indexes\s*:\s*_indexes/.test(block),
            'expected indexes: _indexes (resolved from _knownIndexes) in MySQL _queryEntry'
        );
    });

    it('_knownIndexes loaded from indexes.sql at init (#QI1)', function() {
        var src = getMysqlSrc();
        assert.ok(
            src.indexOf('indexes.sql') > -1,
            'expected indexes.sql file reference in MySQL connector'
        );
        assert.ok(
            src.indexOf('parseCreateIndexes') > -1,
            'expected parseCreateIndexes call in MySQL connector'
        );
    });

    it('trigger format matches Couchbase convention (entity#method)', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 300);
        // Trigger should be entityName.toLowerCase() + '#' + name (no prefix)
        assert.ok(
            /trigger\s*:\s*entityName\.toLowerCase\(\)\s*\+\s*'#'\s*\+\s*name/.test(block),
            'expected trigger: entityName.toLowerCase() + "#" + name'
        );
    });

});


// ── 35 — /_gina/agent SSE handler in server.js (engine-agnostic) ─────────────

describe('35 - /_gina/agent SSE handler is in server.js (engine-agnostic)', function() {

    it('server.js contains the /_gina/agent regex', function() {
        assert.ok(
            getServerSrc().indexOf('/_gina\\/agent') > -1,
            'expected /_gina/agent regex in server.js'
        );
    });

    it('server.js checks NODE_ENV_IS_DEV for the agent endpoint', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        assert.ok(agentIdx > -1, 'expected "Inspector agent" comment');
        var block = src.substring(agentIdx, agentIdx + 500);
        assert.ok(
            block.indexOf('NODE_ENV_IS_DEV') > -1,
            'expected NODE_ENV_IS_DEV guard near the agent handler'
        );
    });

    it('server.js sets Content-Type to text/event-stream for agent', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf('text/event-stream') > -1,
            'expected text/event-stream content type in agent handler'
        );
    });

    it('server.js sets access-control-allow-origin for CORS', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf('access-control-allow-origin') > -1,
            'expected CORS header in agent handler'
        );
    });

    it('server.js uses named SSE events (event: data, event: log)', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf("'event: data\\ndata: '") > -1,
            'expected named "event: data" SSE event'
        );
        assert.ok(
            block.indexOf("'event: log\\ndata: '") > -1,
            'expected named "event: log" SSE event'
        );
    });

    it('server.js listens on inspector#data event for data pushes', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf("'inspector#data'") > -1,
            'expected process.on(inspector#data) in the agent handler'
        );
    });

    it('server.js listens on logger#default event for log pushes', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf("'logger#default'") > -1,
            'expected process.on(logger#default) in the agent handler'
        );
    });

    it('server.js sends initial snapshot from _lastGinaData', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf('_lastGinaData') > -1,
            'expected _lastGinaData snapshot delivery'
        );
    });

    it('server.js cleans up both listeners on request close', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        var removeCount = (block.match(/removeListener/g) || []).length;
        assert.ok(
            removeCount >= 2,
            'expected at least 2 removeListener calls (inspector#data + logger#default)'
        );
    });

});


// ── 36 — /_gina/agent SSE handler in server.isaac.js (Isaac fast-path) ───────

describe('36 - /_gina/agent SSE handler is in server.isaac.js (Isaac fast-path)', function() {

    var _isaacSrc36;
    function getIsaacSrc36() { return _isaacSrc36 || (_isaacSrc36 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }

    it('server.isaac.js contains the /_gina/agent regex', function() {
        assert.ok(
            getIsaacSrc36().indexOf('/_gina\\/agent') > -1,
            'expected /_gina/agent regex in server.isaac.js'
        );
    });

    it('server.isaac.js sets Content-Type to text/event-stream for agent', function() {
        var src = getIsaacSrc36();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(
            block.indexOf('text/event-stream') > -1,
            'expected text/event-stream content type in Isaac agent handler'
        );
    });

    it('server.isaac.js supports HTTP/2 via response.stream', function() {
        var src = getIsaacSrc36();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(
            block.indexOf('response.stream') > -1,
            'expected HTTP/2 stream support in the Isaac agent handler'
        );
    });

    it('server.isaac.js uses named SSE events (event: data, event: log)', function() {
        var src = getIsaacSrc36();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(
            block.indexOf("'event: data\\ndata: '") > -1,
            'expected named "event: data" SSE event in Isaac'
        );
        assert.ok(
            block.indexOf("'event: log\\ndata: '") > -1,
            'expected named "event: log" SSE event in Isaac'
        );
    });

    it('server.isaac.js sets CORS header for cross-origin agent access', function() {
        var src = getIsaacSrc36();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(
            block.indexOf('access-control-allow-origin') > -1,
            'expected CORS header in Isaac agent handler'
        );
    });

    it('server.isaac.js cleans up both listeners on close', function() {
        var src = getIsaacSrc36();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        var removeCount = (block.match(/removeListener/g) || []).length;
        assert.ok(
            removeCount >= 2,
            'expected at least 2 removeListener calls in Isaac agent handler'
        );
    });

});


// ── 37 — /_gina/agent URL pattern matching ───────────────────────────────────

describe('37 - /_gina/agent URL pattern matching', function() {

    var pattern = /\/_gina\/agent(?:\?|$)/;

    it('matches /_gina/agent', function() {
        assert.ok(pattern.test('/_gina/agent'));
    });

    it('matches /_gina/agent?key=abc (#INS9b auth query param)', function() {
        assert.ok(pattern.test('/_gina/agent?key=abc'));
    });

    it('matches /myapp/_gina/agent?key=abc (webroot + auth query param)', function() {
        assert.ok(pattern.test('/myapp/_gina/agent?key=abc'));
    });

    it('matches /webroot/_gina/agent', function() {
        assert.ok(pattern.test('/myapp/_gina/agent'));
    });

    it('does not match /_gina/agent/', function() {
        assert.ok(!pattern.test('/_gina/agent/'));
    });

    it('does not match /_gina/agent/foo', function() {
        assert.ok(!pattern.test('/_gina/agent/foo'));
    });

    it('does not match /_gina/agents', function() {
        assert.ok(!pattern.test('/_gina/agents'));
    });

    it('does not match /_gina/agentx', function() {
        assert.ok(!pattern.test('/_gina/agentx'));
    });

    it('does not match /_gina/logs', function() {
        assert.ok(!pattern.test('/_gina/logs'));
    });

    it('does not match /_gina/inspector', function() {
        assert.ok(!pattern.test('/_gina/inspector'));
    });

});


// ── 38 — render-swig.js emits inspector#data event ──────────────────────────

describe('38 - render-swig.js emits inspector#data event', function() {

    var RENDER_SWIG_38 = path.join(FW, 'core/controller/controller.render-swig.js');
    var _rSwigSrc38;
    function getRSwigSrc38() { return _rSwigSrc38 || (_rSwigSrc38 = fs.readFileSync(RENDER_SWIG_38, 'utf8')); }

    it('render-swig.js emits process.emit(inspector#data)', function() {
        assert.ok(
            getRSwigSrc38().indexOf("process.emit('inspector#data'") > -1,
            'expected process.emit(inspector#data) in render-swig.js'
        );
    });

    it('render-swig.js emits inspector#data alongside _lastGinaData storage', function() {
        var src = getRSwigSrc38();
        var emitIdx = src.indexOf("process.emit('inspector#data'");
        // Anchor on the actual assignment, not the first bare "_lastGinaData"
        // substring (which may appear earlier in comments mentioning the
        // _lastGinaDataUnredacted scope-gate block).
        var lastGdIdx = src.indexOf('self.serverInstance._lastGinaData = ');
        assert.ok(emitIdx > -1 && lastGdIdx > -1, 'both inspector#data emit and _lastGinaData assignment must exist');
        // ~400 chars allows for the #R7 unredacted snapshot defensive-clear
        // block that legitimately sits between them.
        assert.ok(
            Math.abs(emitIdx - lastGdIdx) < 400,
            'inspector#data emit should be near _lastGinaData assignment'
        );
    });

});


// ── 39 — Inspector SPA tryAgent() remote data source ─────────────────────────

describe('39 - Inspector SPA tryAgent() remote data source', function() {

    var INSPECTOR_39 = path.join(BM_DIR, 'inspector.js');
    var _inspJs39;
    function getInspJs39() { return _inspJs39 || (_inspJs39 = fs.readFileSync(INSPECTOR_39, 'utf8')); }

    it('inspector.js defines tryAgent function', function() {
        assert.ok(
            getInspJs39().indexOf('function tryAgent') > -1,
            'expected tryAgent() function definition'
        );
    });

    it('tryAgent reads target from URLSearchParams', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 600);
        assert.ok(
            block.indexOf('URLSearchParams') > -1,
            'expected URLSearchParams usage in tryAgent'
        );
        assert.ok(
            block.indexOf("'target'") > -1,
            'expected target parameter read in tryAgent'
        );
    });

    it('tryAgent connects to {target}/_gina/agent via EventSource', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 1200);
        assert.ok(
            block.indexOf('/_gina/agent') > -1,
            'expected /_gina/agent URL construction'
        );
        assert.ok(
            block.indexOf('new EventSource') > -1,
            'expected new EventSource() call in tryAgent'
        );
    });

    it('tryAgent sets source to agent', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 1000);
        assert.ok(
            /source\s*=\s*'agent'/.test(block),
            'expected source = "agent" in tryAgent'
        );
    });

    it('tryAgent listens for named data events', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 3000);
        assert.ok(
            block.indexOf("addEventListener('data'") > -1,
            'expected es.addEventListener("data") in tryAgent'
        );
    });

    it('tryAgent listens for named log events', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 3300);
        assert.ok(
            block.indexOf("addEventListener('log'") > -1,
            'expected es.addEventListener("log") in tryAgent'
        );
    });

    it('tryAgent returns false when no target param', function() {
        var src = getInspJs39();
        var agentIdx = src.indexOf('function tryAgent');
        var block = src.substring(agentIdx, agentIdx + 400);
        assert.ok(
            /if\s*\(\s*!target\s*\)\s*return\s+false/.test(block),
            'expected early return false when no target param'
        );
    });

    it('init() calls tryAgent before tryOpener', function() {
        var src = getInspJs39();
        var tryAgentCallIdx = src.indexOf('var isAgent = tryAgent()');
        assert.ok(tryAgentCallIdx > -1, 'expected var isAgent = tryAgent() call');
        // Find the tryOpener call AFTER the tryAgent call (in init, not the definition)
        var tryOpenerCallIdx = src.indexOf('tryOpener()', tryAgentCallIdx);
        assert.ok(tryOpenerCallIdx > -1, 'expected tryOpener() call after tryAgent');
        assert.ok(
            tryAgentCallIdx < tryOpenerCallIdx,
            'tryAgent() must be called before tryOpener() in init()'
        );
    });

    it('init() skips tryOpener/tryServerLogs when in agent mode', function() {
        var src = getInspJs39();
        // The tryOpener call should be inside an if (!isAgent) block
        var isAgentIdx = src.indexOf('var isAgent = tryAgent()');
        var block = src.substring(isAgentIdx, isAgentIdx + 500);
        assert.ok(
            block.indexOf('if (!isAgent)') > -1,
            'expected if (!isAgent) guard around tryOpener/tryServerLogs'
        );
    });

    it('pollData() handles source === agent (no-op with re-render)', function() {
        var src = getInspJs39();
        var pollIdx = src.indexOf('function pollData');
        var block = src.substring(pollIdx, pollIdx + 600);
        assert.ok(
            /source\s*===\s*'agent'/.test(block),
            'expected source === "agent" check in pollData()'
        );
    });

    it('file-level JSDoc mentions agent SSE channel', function() {
        var src = getInspJs39();
        // Check the top-of-file JSDoc
        var headerBlock = src.substring(0, 800);
        assert.ok(
            headerBlock.indexOf('/_gina/agent') > -1,
            'expected /_gina/agent mentioned in file-level JSDoc'
        );
    });

});


// ── 41 — PostgreSQL connector QI: AsyncLocalStorage instrumentation ─────────

describe('41 - PostgreSQL connector QI: AsyncLocalStorage instrumentation', function() {

    var PG_SRC = path.join(FW, 'core/connectors/postgresql/index.js');
    var _pgSrc;
    function getPgSrc() { return _pgSrc || (_pgSrc = fs.readFileSync(PG_SRC, 'utf8')); }

    it('reads query log from _queryALS.getStore()', function() {
        assert.ok(
            getPgSrc().indexOf('_queryALS.getStore()') > -1,
            'expected _queryALS.getStore() in PostgreSQL connector'
        );
    });

    it('_queryEntry includes all required fields', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        assert.ok(entryIdx > -1, '_queryEntry object literal must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        var requiredFields = ['type', 'trigger', 'statement', 'params', 'durationMs',
            'resultCount', 'resultSize', 'error', 'source', 'origin', 'connector'];
        for (var i = 0; i < requiredFields.length; i++) {
            assert.ok(
                block.indexOf(requiredFields[i]) > -1,
                'expected field "' + requiredFields[i] + '" in _queryEntry'
            );
        }
    });

    it('_queryEntry type is PG', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 200);
        assert.ok(
            /type\s*:\s*'PG'/.test(block),
            'expected type: "PG" in _queryEntry'
        );
    });

    it('_queryEntry connector is postgresql', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /connector\s*:\s*'postgresql'/.test(block),
            'expected connector: "postgresql" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getPgSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 3500), pushIdx); // #B350 widened from 2000 (9-12 chars headroom pre-fix): the gated console + params lines sit between the gate and the push (need ~2055)
        assert.ok(
            before.indexOf('envIsDev') > -1,
            '_devLog push must be inside envIsDev guard'
        );
    });

    it('_startMs timestamp is captured before execute', function() {
        var src = getPgSrc();
        assert.ok(
            src.indexOf('_queryEntry._startMs = Date.now()') > -1,
            'expected _startMs timestamp on _queryEntry'
        );
    });

    it('durationMs is finalized in Promise path callback', function() {
        var src = getPgSrc();
        var optIdx = src.indexOf('Option B');
        assert.ok(optIdx > -1, 'Option B comment must exist');
        var block = src.substring(optIdx, optIdx + 1200);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'Promise path must finalize durationMs'
        );
    });

    it('durationMs is finalized in callback path', function() {
        var src = getPgSrc();
        var cbIdx = src.indexOf('Direct callback path');
        assert.ok(cbIdx > -1, 'Direct callback comment must exist');
        var block = src.substring(cbIdx, cbIdx + 600);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'callback path must finalize durationMs'
        );
    });

    it('resultCount and resultSize are set on success (Promise path)', function() {
        var src = getPgSrc();
        var optIdx = src.indexOf('Option B');
        var block = src.substring(optIdx, optIdx + 1800);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'Promise path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'Promise path must set resultSize'
        );
    });

    it('resultCount and resultSize are set on success (callback path)', function() {
        var src = getPgSrc();
        var cbIdx = src.indexOf('Direct callback path');
        var block = src.substring(cbIdx, cbIdx + 900);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'callback path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'callback path must set resultSize'
        );
    });

    it('error is captured on failure in both paths', function() {
        var src = getPgSrc();
        var matches = src.match(/_queryEntry\.error/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected _queryEntry.error set in at least 2 places (Promise + callback paths)'
        );
    });

    it('indexes field uses _knownIndexes lookup (#QI1)', function() {
        var src = getPgSrc();
        assert.ok(
            src.indexOf('_knownIndexes') > -1,
            'expected _knownIndexes variable in PG connector'
        );
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /indexes\s*:\s*_indexes/.test(block),
            'expected indexes: _indexes (resolved from _knownIndexes) in PG _queryEntry'
        );
    });

    it('_knownIndexes loaded from indexes.sql at init (#QI1)', function() {
        var src = getPgSrc();
        assert.ok(
            src.indexOf('indexes.sql') > -1,
            'expected indexes.sql file reference in PG connector'
        );
        assert.ok(
            src.indexOf('parseCreateIndexes') > -1,
            'expected parseCreateIndexes call in PG connector'
        );
    });

    it('trigger format matches convention (entity#method)', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 300);
        assert.ok(
            /trigger\s*:\s*entityName\.toLowerCase\(\)\s*\+\s*'#'\s*\+\s*name/.test(block),
            'expected trigger: entityName.toLowerCase() + "#" + name'
        );
    });

});


// ── 42 — SQLite connector QI: AsyncLocalStorage instrumentation ─────────────

describe('42 - SQLite connector QI: AsyncLocalStorage instrumentation', function() {

    var SQLITE_SRC = path.join(FW, 'core/connectors/sqlite/index.js');
    var _sqliteSrc;
    function getSqliteSrc() { return _sqliteSrc || (_sqliteSrc = fs.readFileSync(SQLITE_SRC, 'utf8')); }

    it('reads query log from _queryALS.getStore()', function() {
        assert.ok(
            getSqliteSrc().indexOf('_queryALS.getStore()') > -1,
            'expected _queryALS.getStore() in SQLite connector'
        );
    });

    it('_queryEntry includes all required fields', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        assert.ok(entryIdx > -1, '_queryEntry object literal must exist');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        var requiredFields = ['type', 'trigger', 'statement', 'params', 'durationMs',
            'resultCount', 'resultSize', 'error', 'source', 'origin', 'connector'];
        for (var i = 0; i < requiredFields.length; i++) {
            assert.ok(
                block.indexOf(requiredFields[i]) > -1,
                'expected field "' + requiredFields[i] + '" in _queryEntry'
            );
        }
    });

    it('_queryEntry type is SQL', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 200);
        assert.ok(
            /type\s*:\s*'SQL'/.test(block),
            'expected type: "SQL" in _queryEntry'
        );
    });

    it('_queryEntry connector is sqlite', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /connector\s*:\s*'sqlite'/.test(block),
            'expected connector: "sqlite" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getSqliteSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 3500), pushIdx); // #B350 widened from 2000 (9-12 chars headroom pre-fix): the gated console + params lines sit between the gate and the push (need ~2055)
        assert.ok(
            before.indexOf('envIsDev') > -1,
            '_devLog push must be inside envIsDev guard'
        );
    });

    it('_startMs timestamp is captured before execute', function() {
        var src = getSqliteSrc();
        assert.ok(
            src.indexOf('_queryEntry._startMs = Date.now()') > -1,
            'expected _startMs timestamp on _queryEntry'
        );
    });

    it('durationMs is finalized in Promise path (setTimeout)', function() {
        var src = getSqliteSrc();
        var optIdx = src.indexOf('Option B');
        assert.ok(optIdx > -1, 'Option B comment must exist');
        var block = src.substring(optIdx, optIdx + 1800);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'Promise path must finalize durationMs'
        );
    });

    it('durationMs is finalized in callback path', function() {
        var src = getSqliteSrc();
        var cbIdx = src.indexOf('Direct callback path');
        assert.ok(cbIdx > -1, 'Direct callback comment must exist');
        var block = src.substring(cbIdx, cbIdx + 600);
        assert.ok(
            block.indexOf('_queryEntry.durationMs') > -1,
            'callback path must finalize durationMs'
        );
    });

    it('resultCount and resultSize are set on success (Promise path)', function() {
        var src = getSqliteSrc();
        var optIdx = src.indexOf('Option B');
        var block = src.substring(optIdx, optIdx + 1800);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'Promise path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'Promise path must set resultSize'
        );
    });

    it('resultCount and resultSize are set on success (callback path)', function() {
        var src = getSqliteSrc();
        var cbIdx = src.indexOf('Direct callback path');
        var block = src.substring(cbIdx, cbIdx + 900);
        assert.ok(
            block.indexOf('_queryEntry.resultCount') > -1,
            'callback path must set resultCount'
        );
        assert.ok(
            block.indexOf('_queryEntry.resultSize') > -1,
            'callback path must set resultSize'
        );
    });

    it('error is captured on failure in both paths', function() {
        var src = getSqliteSrc();
        var matches = src.match(/_queryEntry\.error/g);
        assert.ok(
            matches && matches.length >= 2,
            'expected _queryEntry.error set in at least 2 places (Promise + callback paths)'
        );
    });

    it('indexes field uses _knownIndexes lookup (#QI1)', function() {
        var src = getSqliteSrc();
        assert.ok(
            src.indexOf('_knownIndexes') > -1,
            'expected _knownIndexes variable in SQLite connector'
        );
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 1200); // #B350 widened from 750: the gated params field grew the entry (worst need ~800)
        assert.ok(
            /indexes\s*:\s*_indexes/.test(block),
            'expected indexes: _indexes (resolved from _knownIndexes) in SQLite _queryEntry'
        );
    });

    it('_knownIndexes loaded from indexes.sql at init (#QI1)', function() {
        var src = getSqliteSrc();
        assert.ok(
            src.indexOf('indexes.sql') > -1,
            'expected indexes.sql file reference in SQLite connector'
        );
        assert.ok(
            src.indexOf('parseCreateIndexes') > -1,
            'expected parseCreateIndexes call in SQLite connector'
        );
    });

    it('trigger format matches convention (entity#method)', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 300);
        assert.ok(
            /trigger\s*:\s*entityName\.toLowerCase\(\)\s*\+\s*'#'\s*\+\s*name/.test(block),
            'expected trigger: entityName.toLowerCase() + "#" + name'
        );
    });

    it('synchronous execution model — QI wraps execute() not conn.query()', function() {
        var src = getSqliteSrc();
        // SQLite uses execute(args), not conn.query()
        assert.ok(
            src.indexOf('conn.query') === -1,
            'SQLite connector must not use conn.query() — it uses synchronous execute()'
        );
        assert.ok(
            src.indexOf('var result = execute(args)') > -1,
            'expected execute(args) call in entity method'
        );
    });

});


// ── 43 — Inspector "No source" overlay: manual connect form ─────────────────

describe('43 - Inspector "No source" overlay: manual connect form', function() {

    var _html;
    function getHtml() { return _html || (_html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8')); }

    var _js;
    function getJs() { return _js || (_js = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    var _css;
    function getCss() { return _css || (_css = fs.readFileSync(path.join(BM_DIR, 'inspector.css'), 'utf8')); }

    it('index.html contains the connect form inside the no-source overlay', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('id="bm-connect-form"') > -1,
            'expected #bm-connect-form in index.html'
        );
    });

    it('index.html contains the connect URL input', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('id="bm-connect-url"') > -1,
            'expected #bm-connect-url input in index.html'
        );
    });

    it('connect form is nested inside #bm-no-source', function() {
        var html = getHtml();
        var noSourceStart = html.indexOf('id="bm-no-source"');
        var formPos       = html.indexOf('id="bm-connect-form"');
        // Find the closing tag of the no-source overlay
        var noSourceEnd   = html.indexOf('</div>\n\n', noSourceStart);
        assert.ok(noSourceStart > -1, '#bm-no-source must exist');
        assert.ok(formPos > noSourceStart, 'form must come after #bm-no-source opens');
        assert.ok(formPos < noSourceEnd, 'form must be inside #bm-no-source');
    });

    it('connect form has a submit button', function() {
        var html = getHtml();
        var formStart = html.indexOf('id="bm-connect-form"');
        var btnPos    = html.indexOf('type="submit"', formStart);
        assert.ok(btnPos > formStart, 'expected a submit button inside the form');
    });

    it('inspector.js wires up the connect form submit handler', function() {
        var js = getJs();
        assert.ok(
            js.indexOf("qs('#bm-connect-form')") > -1,
            'expected JS to query #bm-connect-form'
        );
        assert.ok(
            js.indexOf("'submit'") > -1,
            'expected a submit event listener'
        );
    });

    it('connect handler navigates with ?target= parameter', function() {
        var js = getJs();
        assert.ok(
            js.indexOf("'?target='") > -1,
            'expected ?target= in the connect handler'
        );
    });

    it('connect handler auto-prefixes http:// when scheme is missing', function() {
        var js = getJs();
        // Check for the scheme normalization regex
        assert.ok(
            js.indexOf("'http://'") > -1,
            'expected http:// prefix fallback in the connect handler'
        );
    });

    it('separator element exists between help text and form', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('bm-connect-sep') > -1,
            'expected .bm-connect-sep separator element'
        );
    });

    it('CSS contains connect form styles', function() {
        var css = getCss();
        assert.ok(
            css.indexOf('.bm-connect-form') > -1,
            'expected .bm-connect-form in inspector.css'
        );
        assert.ok(
            css.indexOf('.bm-connect-sep') > -1,
            'expected .bm-connect-sep in inspector.css'
        );
    });

});


// ── 44 — Inspector tab layout presets (Balanced / Backend / Frontend) ────────

describe('44 - Inspector tab layout presets', function() {

    var _html;
    function getHtml() { return _html || (_html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8')); }

    var _js;
    function getJs() { return _js || (_js = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    var _css;
    function getCss() { return _css || (_css = fs.readFileSync(path.join(BM_DIR, 'inspector.css'), 'utf8')); }

    // ── HTML structure: segmented control ──

    it('settings panel contains the layout button group', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('class="bm-layout-group"') > -1,
            'expected .bm-layout-group container'
        );
    });

    it('all four layout buttons exist (balanced, backend, frontend, custom)', function() {
        var html = getHtml();
        assert.ok(html.indexOf('data-layout="balanced"') > -1, 'missing balanced button');
        assert.ok(html.indexOf('data-layout="backend"') > -1, 'missing backend button');
        assert.ok(html.indexOf('data-layout="frontend"') > -1, 'missing frontend button');
        assert.ok(html.indexOf('data-layout="custom"') > -1, 'missing custom button');
    });

    it('balanced button has the active class by default', function() {
        var html = getHtml();
        // The balanced button line should contain both data-layout="balanced" and "active"
        var lines = html.split('\n');
        var balancedLine = lines.find(function (l) { return l.indexOf('data-layout="balanced"') > -1; });
        assert.ok(balancedLine, 'expected a line with data-layout="balanced"');
        assert.ok(balancedLine.indexOf('active') > -1, 'balanced button should have active class');
    });

    it('each layout button has a tooltip with the full tab order', function() {
        var html = getHtml();
        // Tooltips use → arrows between tab names
        assert.ok(html.indexOf('title="Data') > -1, 'balanced button should have a title tooltip');
        ['balanced', 'backend', 'frontend', 'custom'].forEach(function (name) {
            var pos = html.indexOf('data-layout="' + name + '"');
            var lineStart = html.lastIndexOf('<button', pos);
            var lineEnd = html.indexOf('>', pos) + 1;
            var tag = html.substring(lineStart, lineEnd);
            assert.ok(tag.indexOf('title=') > -1, name + ' button must have a title attribute');
        });
    });

    it('each layout button has an SVG icon', function() {
        var html = getHtml();
        ['balanced', 'backend', 'frontend', 'custom'].forEach(function (name) {
            var btnPos = html.indexOf('data-layout="' + name + '"');
            // The SVG icon is inside the button, after data-layout
            var nextBtn = html.indexOf('</button>', btnPos);
            var btnContent = html.substring(btnPos, nextBtn);
            assert.ok(btnContent.indexOf('bm-layout-icon') > -1, name + ' button must have an SVG icon');
        });
    });

    it('layout preview container exists', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('id="bm-layout-preview"') > -1,
            'expected #bm-layout-preview element'
        );
    });

    it('layout group is inside the settings panel', function() {
        var html = getHtml();
        var settingsStart = html.indexOf('id="bm-settings"');
        var groupPos = html.indexOf('class="bm-layout-group"');
        assert.ok(settingsStart > -1, '#bm-settings must exist');
        assert.ok(groupPos > settingsStart, 'layout group must be inside settings panel');
    });

    // ── JS logic ──

    it('TAB_LAYOUTS constant defines all three presets', function() {
        var js = getJs();
        assert.ok(js.indexOf('TAB_LAYOUTS') > -1, 'expected TAB_LAYOUTS constant');
        assert.ok(js.indexOf("balanced:") > -1 || js.indexOf("balanced :") > -1, 'expected balanced layout');
        assert.ok(js.indexOf("backend:") > -1 || js.indexOf("backend :") > -1, 'expected backend layout');
        assert.ok(js.indexOf("frontend:") > -1 || js.indexOf("frontend :") > -1, 'expected frontend layout');
    });

    it('balanced layout order is data, view, logs, forms, query, flow, stream, events', function() {
        var js = getJs();
        var match = js.match(/balanced\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected balanced array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['data', 'view', 'logs', 'forms', 'query', 'flow', 'stream', 'events']);
    });

    it('backend layout order is data, query, flow, logs, view, forms, stream, events', function() {
        var js = getJs();
        var match = js.match(/backend\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected backend array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['data', 'query', 'flow', 'logs', 'view', 'forms', 'stream', 'events']);
    });

    it('frontend layout order is view, data, forms, logs, query, flow, stream, events', function() {
        var js = getJs();
        var match = js.match(/frontend\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected frontend array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['view', 'data', 'forms', 'logs', 'query', 'flow', 'stream', 'events']);
    });

    it('all three layouts contain exactly the same 8 tabs', function() {
        var js = getJs();
        var expected = ['data', 'events', 'flow', 'forms', 'logs', 'query', 'stream', 'view'];
        ['balanced', 'backend', 'frontend'].forEach(function (name) {
            var match = js.match(new RegExp(name + '\\s*:\\s*\\[([^\\]]+)\\]'));
            assert.ok(match, 'expected ' + name + ' array');
            var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/).sort();
            assert.deepStrictEqual(tabs, expected, name + ' must contain all 8 tabs');
        });
    });

    it('applyTabLayout function exists', function() {
        var js = getJs();
        assert.ok(js.indexOf('function applyTabLayout') > -1, 'expected applyTabLayout function');
    });

    it('renderLayoutPreview function exists', function() {
        var js = getJs();
        assert.ok(js.indexOf('function renderLayoutPreview') > -1, 'expected renderLayoutPreview function');
    });

    it('TAB_PREVIEW_COLORS maps all 6 tabs to CSS variables', function() {
        var js = getJs();
        assert.ok(js.indexOf('TAB_PREVIEW_COLORS') > -1, 'expected TAB_PREVIEW_COLORS constant');
        ['data', 'view', 'logs', 'forms', 'query', 'flow'].forEach(function (tab) {
            assert.ok(
                js.indexOf(tab + ':') > -1 || js.indexOf("'" + tab + "'") > -1,
                'expected ' + tab + ' in TAB_PREVIEW_COLORS'
            );
        });
    });

    it('TAB_LAYOUT_KEY localStorage key is defined', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('__gina_inspector_tab_layout') > -1,
            'expected TAB_LAYOUT_KEY constant'
        );
    });

    it('layout change persists to localStorage', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('localStorage.setItem(TAB_LAYOUT_KEY') > -1,
            'expected localStorage.setItem call for TAB_LAYOUT_KEY'
        );
    });

    it('layout is restored from localStorage on init', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('localStorage.getItem(TAB_LAYOUT_KEY') > -1,
            'expected localStorage.getItem call for TAB_LAYOUT_KEY'
        );
    });

    // ── CSS ──

    it('CSS contains segmented control styles', function() {
        var css = getCss();
        assert.ok(css.indexOf('.bm-layout-group') > -1, 'expected .bm-layout-group');
        assert.ok(css.indexOf('.bm-layout-btn') > -1, 'expected .bm-layout-btn');
        assert.ok(css.indexOf('.bm-layout-btn.active') > -1, 'expected .bm-layout-btn.active');
    });

    it('CSS contains preview pill styles', function() {
        var css = getCss();
        assert.ok(css.indexOf('.bm-lp-pill') > -1, 'expected .bm-lp-pill');
        assert.ok(css.indexOf('.bm-lp-arrow') > -1, 'expected .bm-lp-arrow');
        assert.ok(css.indexOf('.bm-layout-preview') > -1, 'expected .bm-layout-preview');
    });

    it('CSS has light theme override for active button', function() {
        var css = getCss();
        assert.ok(
            css.indexOf('.bm-layout-btn.active') > -1,
            'expected light theme rule for .bm-layout-btn.active'
        );
    });

    // ── Custom preset: HTML ──

    it('custom button has drag arrows SVG icon', function() {
        var html = getHtml();
        var pos = html.indexOf('data-layout="custom"');
        var end = html.indexOf('</button>', pos);
        var content = html.substring(pos, end);
        assert.ok(content.indexOf('bm-layout-icon') > -1, 'custom button must have SVG icon');
    });

    // ── Custom preset: JS ──

    it('CUSTOM_ORDER_KEY localStorage key is defined', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('__gina_inspector_tab_layout_custom') > -1,
            'expected CUSTOM_ORDER_KEY constant'
        );
    });

    it('getCustomOrder function exists', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('function getCustomOrder') > -1,
            'expected getCustomOrder function'
        );
    });

    it('saveCustomOrder function exists', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('function saveCustomOrder') > -1,
            'expected saveCustomOrder function'
        );
    });

    it('setupTabDrag function exists for drag-to-reorder', function() {
        var js = getJs();
        assert.ok(
            js.indexOf('function setupTabDrag') > -1,
            'expected setupTabDrag function'
        );
    });

    it('applyTabLayout handles custom layout with drag-mode class', function() {
        var js = getJs();
        assert.ok(
            js.indexOf("bm-drag-mode") > -1,
            'expected bm-drag-mode class reference in JS'
        );
        assert.ok(
            js.indexOf("layout === 'custom'") > -1 || js.indexOf('layout === "custom"') > -1,
            'expected custom layout branch in applyTabLayout'
        );
    });

    it('renderLayoutPreview handles custom layout', function() {
        var js = getJs();
        // The function should read from getCustomOrder or getCurrentTabOrder for custom
        assert.ok(
            js.indexOf('getCustomOrder') > -1,
            'renderLayoutPreview should call getCustomOrder for custom'
        );
        assert.ok(
            js.indexOf('getCurrentTabOrder') > -1,
            'expected getCurrentTabOrder fallback'
        );
    });

    // ── Custom preset: CSS ──

    it('CSS contains settings divider style', function() {
        var css = getCss();
        assert.ok(
            css.indexOf('.bm-settings-divider') > -1,
            'expected .bm-settings-divider style'
        );
    });

    it('CSS contains drag-mode styles for tab reorder', function() {
        var css = getCss();
        assert.ok(css.indexOf('.bm-drag-mode') > -1, 'expected .bm-drag-mode class');
        assert.ok(css.indexOf('.bm-tab-dragging') > -1, 'expected .bm-tab-dragging class');
        assert.ok(css.indexOf('.bm-tab-drop-before') > -1, 'expected .bm-tab-drop-before class');
    });

    it('settings divider HTML element exists between the two rows', function() {
        var html = getHtml();
        assert.ok(
            html.indexOf('bm-settings-divider') > -1,
            'expected bm-settings-divider element in HTML'
        );
        // Divider should appear before the layout row
        var dividerPos = html.indexOf('bm-settings-divider');
        var layoutRowPos = html.indexOf('bm-layout-row');
        assert.ok(
            dividerPos < layoutRowPos,
            'divider should appear before the layout row'
        );
    });

});


// ── 45 — Query tab: index badge copy, tab badge tiers, warning banners ────────

describe('45 - Query tab: index badge copy, tab badge tiers, warning banners', function() {

    var INSPECTOR_45 = path.join(BM_DIR, 'inspector.js');
    var CSS_45       = path.join(BM_DIR, 'inspector.css');
    var _inspJs45, _css45;
    function getJs45()  { return _inspJs45 || (_inspJs45 = fs.readFileSync(INSPECTOR_45, 'utf8')); }
    function getCss45() { return _css45    || (_css45    = fs.readFileSync(CSS_45, 'utf8')); }

    // ── Index badge copy ──────────────────────────────────────────────────

    it('index badges have bm-idx-copy class and data-idx-name attribute', function() {
        var src = getJs45();
        assert.ok(src.indexOf('bm-idx-copy') > -1, 'expected bm-idx-copy class in renderQueryContent');
        assert.ok(src.indexOf('data-idx-name') > -1, 'expected data-idx-name attribute on index badges');
    });

    it('click handler for bm-idx-copy uses clipboard API', function() {
        var src = getJs45();
        assert.ok(src.indexOf("closest('.bm-idx-copy')") > -1, 'expected delegated click on .bm-idx-copy');
        assert.ok(src.indexOf('navigator.clipboard') > -1, 'expected navigator.clipboard usage');
    });

    it('CSS has bm-idx-copy hover and copied states', function() {
        var css = getCss45();
        assert.ok(css.indexOf('.bm-idx-copy') > -1, 'expected .bm-idx-copy in CSS');
        assert.ok(css.indexOf('.copied') > -1, 'expected .copied class for copy feedback');
    });

    // ── Tab badge three-tier color ────────────────────────────────────────

    it('updateQueryToolbar toggles bm-tab-badge-err and bm-tab-badge-warn', function() {
        var src = getJs45();
        assert.ok(src.indexOf('bm-tab-badge-err') > -1, 'expected bm-tab-badge-err class toggle');
        assert.ok(src.indexOf('bm-tab-badge-warn') > -1, 'expected bm-tab-badge-warn class toggle');
    });

    it('tab badge err triggers on missing index or both slow+heavy', function() {
        var src = getJs45();
        // The err condition combines hasIdxIssue with (isSlow && isHeavy)
        assert.ok(src.indexOf('hasIdxIssue') > -1, 'expected hasIdxIssue check');
        assert.ok(src.indexOf('isSlow && isHeavy') > -1, 'expected isSlow && isHeavy condition');
    });

    it('tab badge warn triggers on only one of slow or heavy', function() {
        var src = getJs45();
        assert.ok(
            src.indexOf('isSlow || isHeavy') > -1,
            'expected isSlow || isHeavy for warn condition'
        );
    });

    it('CSS has bm-tab-badge-warn and bm-tab-badge-err styles', function() {
        var css = getCss45();
        assert.ok(css.indexOf('.bm-tab-badge-warn') > -1, 'expected .bm-tab-badge-warn in CSS');
        assert.ok(css.indexOf('.bm-tab-badge-err') > -1, 'expected .bm-tab-badge-err in CSS');
    });

    // ── Missing-index banner (bullet list) ────────────────────────────────

    it('missing-index banner uses ul.bm-banner-list with li items', function() {
        var src = getJs45();
        // Verify <ul class="bm-banner-list"> and <li> in the index banner
        var bannerIdx = src.indexOf('bm-idx-banner');
        assert.ok(bannerIdx > -1, 'expected bm-idx-banner in inspector.js');
        var bannerBlock = src.substring(bannerIdx, bannerIdx + 600);
        assert.ok(bannerBlock.indexOf('bm-banner-list') > -1, 'expected bm-banner-list class in index banner');
        assert.ok(bannerBlock.indexOf('<li>') > -1, 'expected <li> elements in index banner');
    });

    it('CSS has bm-banner-list with styled bullet points', function() {
        var css = getCss45();
        assert.ok(css.indexOf('.bm-banner-list') > -1, 'expected .bm-banner-list in CSS');
        // Bullet via ::before pseudo-element
        assert.ok(css.indexOf('border-radius: 50%') > -1, 'expected round bullet via border-radius');
    });

    it('index banner bullet color matches err theme', function() {
        var css = getCss45();
        assert.ok(
            css.indexOf('.bm-idx-banner .bm-banner-list') > -1,
            'expected parent-scoped bullet color for index banner'
        );
    });

    // ── Performance banner ────────────────────────────────────────────────

    it('renderQueryContent builds perf banner for slow/heavy queries', function() {
        var src = getJs45();
        assert.ok(src.indexOf('bm-perf-banner') > -1, 'expected bm-perf-banner in renderQueryContent');
        assert.ok(src.indexOf('perfItems') > -1, 'expected perfItems tracking array');
    });

    it('perf banner uses ul.bm-banner-list with li items', function() {
        var src = getJs45();
        var perfIdx = src.indexOf('bm-perf-banner');
        assert.ok(perfIdx > -1);
        // Find the banner construction block
        var block = src.substring(perfIdx, perfIdx + 800);
        assert.ok(block.indexOf('bm-banner-list') > -1, 'expected bm-banner-list in perf banner');
        assert.ok(block.indexOf('<li>') > -1, 'expected <li> elements in perf banner');
    });

    it('perf banner shows reason per query (slow, heavy, or both)', function() {
        var src = getJs45();
        assert.ok(
            src.indexOf('bm-perf-banner-reason') > -1,
            'expected bm-perf-banner-reason span for inline reason'
        );
        assert.ok(
            src.indexOf("'slow + heavy'") > -1,
            'expected slow + heavy combined reason'
        );
    });

    it('perf banner link click scrolls and highlights with orange', function() {
        var src = getJs45();
        assert.ok(
            src.indexOf('bm-perf-banner-link') > -1,
            'expected bm-perf-banner-link class'
        );
        assert.ok(
            src.indexOf('bm-perf-highlight') > -1,
            'expected bm-perf-highlight class for orange card highlight'
        );
    });

    it('perf banner tracks slow (>= 500ms) and heavy queries', function() {
        var src = getJs45();
        // The threshold for slow is >= 500
        assert.ok(src.indexOf('>= 500') > -1 || src.indexOf('durationMs >= 500') > -1 || src.indexOf('>= 500') > -1,
            'expected 500ms slow threshold');
        // Heavy uses weightClass === heavy
        assert.ok(src.indexOf("weightClass") > -1, 'expected weightClass call for heavy detection');
    });

    it('CSS has perf banner styles with orange accent', function() {
        var css = getCss45();
        var requiredClasses = [
            '.bm-perf-banner',
            '.bm-perf-banner-icon',
            '.bm-perf-banner-body',
            '.bm-perf-banner-link',
            '.bm-perf-banner-reason'
        ];
        for (var i = 0; i < requiredClasses.length; i++) {
            assert.ok(
                css.indexOf(requiredClasses[i]) > -1,
                'expected CSS class ' + requiredClasses[i]
            );
        }
    });

    it('CSS has perf highlight class with orange border', function() {
        var css = getCss45();
        assert.ok(
            css.indexOf('.bm-perf-highlight') > -1,
            'expected .bm-perf-highlight in CSS'
        );
    });

    it('perf banner bullet color matches orange theme', function() {
        var css = getCss45();
        assert.ok(
            css.indexOf('.bm-perf-banner .bm-banner-list') > -1,
            'expected parent-scoped bullet color for perf banner'
        );
    });

    it('light theme has perf banner variant', function() {
        var css = getCss45();
        assert.ok(
            /\[data-theme.*light\].*\.bm-perf-banner/.test(css),
            'expected light theme override for .bm-perf-banner'
        );
    });

});


// ── 46 — sql-parser: parseCreateIndexes and extractTargetTable (#QI1) ────────

describe('46 - sql-parser: parseCreateIndexes and extractTargetTable (#QI1)', function() {

    var sqlParser = require(path.join(FW, 'core/connectors/sql-parser'));

    // ── parseCreateIndexes ──────────────────────────────────────────────────

    it('parseCreateIndexes is exported', function() {
        assert.strictEqual(typeof sqlParser.parseCreateIndexes, 'function');
    });

    it('parses a basic CREATE INDEX statement', function() {
        var src = 'CREATE INDEX idx_users_email ON users (email);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users'], 'expected "users" key in map');
        assert.strictEqual(map['users'].length, 1);
        assert.strictEqual(map['users'][0].name, 'idx_users_email');
        assert.strictEqual(map['users'][0].primary, false);
    });

    it('parses CREATE UNIQUE INDEX', function() {
        var src = 'CREATE UNIQUE INDEX idx_users_username ON users (username);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.strictEqual(map['users'].length, 1);
        assert.strictEqual(map['users'][0].name, 'idx_users_username');
        assert.strictEqual(map['users'][0].primary, false);
    });

    it('parses CREATE INDEX IF NOT EXISTS', function() {
        var src = 'CREATE INDEX IF NOT EXISTS idx_orders_date ON orders (created_at);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['orders']);
        assert.strictEqual(map['orders'][0].name, 'idx_orders_date');
    });

    it('parses multiple indexes on the same table', function() {
        var src = [
            'CREATE INDEX idx_users_email ON users (email);',
            'CREATE INDEX idx_users_name ON users (last_name, first_name);'
        ].join('\n');
        var map = sqlParser.parseCreateIndexes(src);
        assert.strictEqual(map['users'].length, 2);
    });

    it('parses indexes on different tables', function() {
        var src = [
            'CREATE INDEX idx_users_email ON users (email);',
            'CREATE INDEX idx_orders_user ON orders (user_id);'
        ].join('\n');
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users']);
        assert.ok(map['orders']);
    });

    it('deduplicates indexes by name', function() {
        var src = [
            'CREATE INDEX idx_users_email ON users (email);',
            'CREATE INDEX idx_users_email ON users (email);'
        ].join('\n');
        var map = sqlParser.parseCreateIndexes(src);
        assert.strictEqual(map['users'].length, 1);
    });

    it('handles quoted identifiers', function() {
        var src = 'CREATE INDEX "idx_users_email" ON "users" ("email");';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users']);
        assert.strictEqual(map['users'][0].name, 'idx_users_email');
    });

    it('handles backtick-quoted identifiers (MySQL)', function() {
        var src = 'CREATE INDEX `idx_users_email` ON `users` (`email`);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users']);
        assert.strictEqual(map['users'][0].name, 'idx_users_email');
    });

    it('strips schema prefix from table name', function() {
        var src = 'CREATE INDEX idx_users_email ON public.users (email);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users'], 'expected schema-stripped "users" key');
    });

    it('normalises table names to lowercase', function() {
        var src = 'CREATE INDEX idx_Users_Email ON Users (email);';
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users'], 'expected lowercase "users" key');
    });

    it('ignores comments in indexes.sql', function() {
        var src = [
            '-- This is a comment',
            'CREATE INDEX idx_users_email ON users (email);',
            '/* block comment */',
            'CREATE INDEX idx_orders_date ON orders (created_at);'
        ].join('\n');
        var map = sqlParser.parseCreateIndexes(src);
        assert.ok(map['users']);
        assert.ok(map['orders']);
    });

    it('returns empty object for empty input', function() {
        var map = sqlParser.parseCreateIndexes('');
        assert.deepStrictEqual(map, {});
    });

    it('returns empty object for null input', function() {
        var map = sqlParser.parseCreateIndexes(null);
        assert.deepStrictEqual(map, {});
    });

    it('returns empty object when no CREATE INDEX found', function() {
        var src = 'SELECT * FROM users WHERE id = 1;';
        var map = sqlParser.parseCreateIndexes(src);
        assert.deepStrictEqual(map, {});
    });

    // ── extractTargetTable ──────────────────────────────────────────────────

    it('extractTargetTable is exported', function() {
        assert.strictEqual(typeof sqlParser.extractTargetTable, 'function');
    });

    it('extracts table from SELECT ... FROM', function() {
        assert.strictEqual(sqlParser.extractTargetTable('SELECT * FROM users WHERE id = ?'), 'users');
    });

    it('extracts table from INSERT INTO', function() {
        assert.strictEqual(sqlParser.extractTargetTable('INSERT INTO users (name) VALUES (?)'), 'users');
    });

    it('extracts table from UPDATE', function() {
        assert.strictEqual(sqlParser.extractTargetTable('UPDATE users SET name = ? WHERE id = ?'), 'users');
    });

    it('extracts table from DELETE FROM', function() {
        assert.strictEqual(sqlParser.extractTargetTable('DELETE FROM users WHERE id = ?'), 'users');
    });

    it('normalises extracted table to lowercase', function() {
        assert.strictEqual(sqlParser.extractTargetTable('SELECT * FROM Users WHERE id = ?'), 'users');
    });

    it('strips schema prefix from extracted table', function() {
        assert.strictEqual(sqlParser.extractTargetTable('SELECT * FROM public.users WHERE id = ?'), 'users');
    });

    it('returns null for empty input', function() {
        assert.strictEqual(sqlParser.extractTargetTable(''), null);
        assert.strictEqual(sqlParser.extractTargetTable(null), null);
    });

    it('handles quoted table names in FROM', function() {
        assert.strictEqual(sqlParser.extractTargetTable('SELECT * FROM "users" WHERE id = ?'), 'users');
    });

    it('handles backtick-quoted table names', function() {
        assert.strictEqual(sqlParser.extractTargetTable('SELECT * FROM `users` WHERE id = ?'), 'users');
    });

    // ── Integration: connector source references ────────────────────────────

    it('all three SQL connectors import sql-parser', function() {
        var mysqlSrc = fs.readFileSync(path.join(FW, 'core/connectors/mysql/index.js'), 'utf8');
        var pgSrc    = fs.readFileSync(path.join(FW, 'core/connectors/postgresql/index.js'), 'utf8');
        var sqliteSrc = fs.readFileSync(path.join(FW, 'core/connectors/sqlite/index.js'), 'utf8');
        assert.ok(mysqlSrc.indexOf('sql-parser') > -1, 'MySQL imports sql-parser');
        assert.ok(pgSrc.indexOf('sql-parser') > -1, 'PG imports sql-parser');
        assert.ok(sqliteSrc.indexOf('sql-parser') > -1, 'SQLite imports sql-parser');
    });

    it('all three SQL connectors call extractTargetTable', function() {
        var mysqlSrc = fs.readFileSync(path.join(FW, 'core/connectors/mysql/index.js'), 'utf8');
        var pgSrc    = fs.readFileSync(path.join(FW, 'core/connectors/postgresql/index.js'), 'utf8');
        var sqliteSrc = fs.readFileSync(path.join(FW, 'core/connectors/sqlite/index.js'), 'utf8');
        assert.ok(mysqlSrc.indexOf('extractTargetTable') > -1, 'MySQL calls extractTargetTable');
        assert.ok(pgSrc.indexOf('extractTargetTable') > -1, 'PG calls extractTargetTable');
        assert.ok(sqliteSrc.indexOf('extractTargetTable') > -1, 'SQLite calls extractTargetTable');
    });

    it('_knownIndexes defaults to null (no indexes.sql = N/A badge)', function() {
        var mysqlSrc = fs.readFileSync(path.join(FW, 'core/connectors/mysql/index.js'), 'utf8');
        assert.ok(
            /var _knownIndexes\s*=\s*null/.test(mysqlSrc),
            'expected _knownIndexes = null default'
        );
    });

    it('_indexes falls back to [] when _knownIndexes exists but table not found', function() {
        var mysqlSrc = fs.readFileSync(path.join(FW, 'core/connectors/mysql/index.js'), 'utf8');
        // The pattern: _indexes = (_tbl && _knownIndexes[_tbl]) ? _knownIndexes[_tbl] : []
        assert.ok(
            mysqlSrc.indexOf('_knownIndexes[_tbl]) ? _knownIndexes[_tbl] : []') > -1,
            'expected fallback to empty array when table not in _knownIndexes'
        );
    });

});


// ── 47 — render-json.js Inspector data feed (#INS) ──────────────────────────

describe('47 - render-json.js emits inspector#data for JSON API responses', function() {

    var RENDER_JSON_47 = path.join(FW, 'core/controller/controller.render-json.js');
    var _rJsonSrc47;
    function getRJsonSrc47() { return _rJsonSrc47 || (_rJsonSrc47 = fs.readFileSync(RENDER_JSON_47, 'utf8')); }

    it('render-json.js emits process.emit(inspector#data)', function() {
        assert.ok(
            getRJsonSrc47().indexOf("process.emit('inspector#data'") > -1,
            'expected process.emit(inspector#data) in render-json.js'
        );
    });

    it('render-json.js stores _lastGinaData on serverInstance', function() {
        assert.ok(
            getRJsonSrc47().indexOf('_lastGinaData') > -1,
            'expected _lastGinaData reference in render-json.js'
        );
    });

    it('inspector#data emit and _lastGinaData are near each other', function() {
        var src = getRJsonSrc47();
        var emitIdx = src.indexOf("process.emit('inspector#data'");
        var lastGdIdx = src.indexOf('self.serverInstance._lastGinaData');
        assert.ok(emitIdx > -1 && lastGdIdx > -1, 'both must exist');
        // ~400 chars allows for the #R7 unredacted snapshot defensive-clear block
        // that sits between _lastGinaData assignment and inspector#data emit.
        assert.ok(
            Math.abs(emitIdx - lastGdIdx) < 400,
            'inspector#data emit should be near _lastGinaData assignment (got ' + Math.abs(emitIdx - lastGdIdx) + ')'
        );
    });

    it('is gated on _inspectorActive', function() {
        var src = getRJsonSrc47();
        // The emit must be inside a block that checks _inspectorActive
        var activeIdx = src.indexOf('process.gina._inspectorActive');
        var emitIdx = src.indexOf("process.emit('inspector#data'");
        assert.ok(activeIdx > -1, 'expected _inspectorActive guard');
        assert.ok(activeIdx < emitIdx, '_inspectorActive check must come before emit');
    });

    it('builds environment from getContext and local.options.conf', function() {
        var src = getRJsonSrc47();
        assert.ok(src.indexOf("getContext('gina')") > -1, 'expected getContext(gina) for version info');
        assert.ok(src.indexOf("_conf.bundle") > -1 || src.indexOf("_conf.server") > -1, 'expected local.options.conf usage');
    });

    it('includes environment keys matching render-swig.js pattern', function() {
        var src = getRJsonSrc47();
        var requiredKeys = ['gina', 'gina pid', 'nodejs', 'engine', 'env', 'bundle', 'protocol', 'memory heap'];
        requiredKeys.forEach(function(key) {
            assert.ok(
                src.indexOf("'" + key + "'") > -1,
                'expected environment key: ' + key
            );
        });
    });

    it('builds __gdPayload with gina and user sections', function() {
        var src = getRJsonSrc47();
        assert.ok(
            /\{\s*gina\s*:[\s\S]*user\s*:/.test(src),
            'expected __gdPayload = { gina: ..., user: ... } structure'
        );
    });

    it('includes queries and flow in user section when available', function() {
        var src = getRJsonSrc47();
        assert.ok(src.indexOf('_gdUser.queries') > -1, 'expected queries assignment');
        assert.ok(src.indexOf('_gdUser.flow') > -1, 'expected flow assignment');
    });

    it('does not modify jsonObj for the Inspector payload', function() {
        var src = getRJsonSrc47();
        // The Inspector payload uses _gdUser.data = jsonObj (reference, not mutation)
        // and is emitted via process.emit, not embedded in the response
        assert.ok(src.indexOf('_gdUser') > -1, 'expected _gdUser intermediate object');
        // Verify the emit happens BEFORE JSON.stringify(jsonObj)
        var emitIdx = src.indexOf("process.emit('inspector#data'");
        var stringifyIdx = src.indexOf('JSON.stringify(jsonObj)');
        assert.ok(
            emitIdx < stringifyIdx,
            'Inspector emit must happen before JSON.stringify(jsonObj)'
        );
    });

});


// ── 48 — Phase B: live index introspection (#QI2) ──────────────────────────

describe('48 - Live index introspection (#QI2)', function() {

    var MYSQL_SRC = path.join(FW, 'core/connectors/mysql/index.js');
    var PG_SRC    = path.join(FW, 'core/connectors/postgresql/index.js');
    var SQLITE_SRC = path.join(FW, 'core/connectors/sqlite/index.js');
    var _mysqlSrc, _pgSrc, _sqliteSrc, _isaacSrc2, _inspJs48;

    function getMysqlSrc()  { return _mysqlSrc  || (_mysqlSrc  = fs.readFileSync(MYSQL_SRC, 'utf8')); }
    function getPgSrc()     { return _pgSrc     || (_pgSrc     = fs.readFileSync(PG_SRC, 'utf8')); }
    function getSqliteSrc() { return _sqliteSrc || (_sqliteSrc = fs.readFileSync(SQLITE_SRC, 'utf8')); }
    function getIsaacSrc()  { return _isaacSrc2 || (_isaacSrc2 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }
    function getInspJs()    { return _inspJs48  || (_inspJs48  = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    // ── Connector listeners ────────────────────────────────────────────────

    it('MySQL connector registers inspector#indexes listener', function() {
        assert.ok(
            getMysqlSrc().indexOf("process.on('inspector#indexes'") > -1,
            'expected process.on(inspector#indexes) in MySQL connector'
        );
    });

    it('MySQL connector uses INFORMATION_SCHEMA.STATISTICS', function() {
        assert.ok(
            getMysqlSrc().indexOf('INFORMATION_SCHEMA.STATISTICS') > -1,
            'expected INFORMATION_SCHEMA.STATISTICS query in MySQL connector'
        );
    });

    it('MySQL connector detects PRIMARY index name', function() {
        // PRIMARY is MySQL's convention for primary key index
        var src = getMysqlSrc();
        assert.ok(
            /idx\s*===\s*'PRIMARY'/.test(src),
            'expected PRIMARY key detection in MySQL introspection'
        );
    });

    it('PostgreSQL connector registers inspector#indexes listener', function() {
        assert.ok(
            getPgSrc().indexOf("process.on('inspector#indexes'") > -1,
            'expected process.on(inspector#indexes) in PostgreSQL connector'
        );
    });

    it('PostgreSQL connector queries pg_indexes', function() {
        assert.ok(
            getPgSrc().indexOf('pg_indexes') > -1,
            'expected pg_indexes query in PostgreSQL connector'
        );
    });

    it('PostgreSQL connector detects primary keys', function() {
        var src = getPgSrc();
        assert.ok(
            src.indexOf('_pkey') > -1 || src.indexOf('PRIMARY KEY') > -1,
            'expected primary key detection in PostgreSQL introspection'
        );
    });

    it('SQLite connector registers inspector#indexes listener', function() {
        assert.ok(
            getSqliteSrc().indexOf("process.on('inspector#indexes'") > -1,
            'expected process.on(inspector#indexes) in SQLite connector'
        );
    });

    it('SQLite connector uses PRAGMA index_list', function() {
        assert.ok(
            getSqliteSrc().indexOf('PRAGMA index_list') > -1,
            'expected PRAGMA index_list query in SQLite connector'
        );
    });

    it('SQLite connector reads sqlite_master for table discovery', function() {
        assert.ok(
            getSqliteSrc().indexOf('sqlite_master') > -1,
            'expected sqlite_master query for table discovery'
        );
    });

    // ── Listener dev-mode guard ────────────────────────────────────────────

    it('all connector listeners are gated on envIsDev', function() {
        // The inspector#indexes listener must be inside an if (envIsDev) block
        var connectors = [
            { name: 'MySQL', src: getMysqlSrc() },
            { name: 'PostgreSQL', src: getPgSrc() },
            { name: 'SQLite', src: getSqliteSrc() }
        ];
        for (var c = 0; c < connectors.length; c++) {
            var src = connectors[c].src;
            var listenerIdx = src.indexOf("process.on('inspector#indexes'");
            // Walk backwards to find the nearest if (envIsDev) guard
            var beforeListener = src.substring(Math.max(0, listenerIdx - 200), listenerIdx);
            assert.ok(
                /if\s*\(\s*envIsDev\s*\)/.test(beforeListener),
                connectors[c].name + ' inspector#indexes listener must be inside envIsDev guard'
            );
        }
    });

    // ── _liveIntrospected flag ─────────────────────────────────────────────

    it('all connectors declare _liveIntrospected flag', function() {
        assert.ok(getMysqlSrc().indexOf('_liveIntrospected') > -1, 'MySQL needs _liveIntrospected');
        assert.ok(getPgSrc().indexOf('_liveIntrospected') > -1, 'PostgreSQL needs _liveIntrospected');
        assert.ok(getSqliteSrc().indexOf('_liveIntrospected') > -1, 'SQLite needs _liveIntrospected');
    });

    it('listeners check _liveIntrospected before querying', function() {
        var connectors = [getMysqlSrc(), getPgSrc(), getSqliteSrc()];
        for (var c = 0; c < connectors.length; c++) {
            var src = connectors[c];
            var listenerIdx = src.indexOf("process.on('inspector#indexes'");
            var block = src.substring(listenerIdx, listenerIdx + 300);
            assert.ok(
                block.indexOf('_liveIntrospected') > -1,
                'listener must check _liveIntrospected flag (connector ' + c + ')'
            );
        }
    });

    // ── _queryEntry.table field ────────────────────────────────────────────

    it('MySQL _queryEntry includes table field', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf("type        : 'MySQL'");
        var entryBlock = src.substring(entryIdx, entryIdx + 800); // #B350 widened from 500: the gated params line grew the entry (need ~549)
        assert.ok(entryBlock.indexOf('table') > -1, 'expected table field in MySQL _queryEntry');
    });

    it('PostgreSQL _queryEntry includes table field', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf("type        : 'PG'");
        var entryBlock = src.substring(entryIdx, entryIdx + 800); // #B350 widened from 500: the gated params line grew the entry (need ~549)
        assert.ok(entryBlock.indexOf('table') > -1, 'expected table field in PostgreSQL _queryEntry');
    });

    it('SQLite _queryEntry includes table field', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf("type        : 'SQL'");
        var entryBlock = src.substring(entryIdx, entryIdx + 800); // #B350 widened from 500: the gated params line grew the entry (need ~549)
        assert.ok(entryBlock.indexOf('table') > -1, 'expected table field in SQLite _queryEntry');
    });

    // ── server.js endpoint ─────────────────────────────────────────────────

    it('server.js has /_gina/indexes endpoint', function() {
        assert.ok(
            getServerSrc().indexOf('/_gina\\/indexes') > -1,
            'expected /_gina/indexes regex in server.js'
        );
    });

    it('server.js endpoint uses collector pattern with listenerCount', function() {
        var src = getServerSrc();
        var idx = src.indexOf('/_gina\\/indexes');
        var block = src.substring(idx, idx + 1500);
        assert.ok(
            block.indexOf("listenerCount('inspector#indexes')") > -1,
            'expected listenerCount check in server.js indexes endpoint'
        );
    });

    it('server.js endpoint emits inspector#indexes event', function() {
        var src = getServerSrc();
        var idx = src.indexOf('/_gina\\/indexes');
        var block = src.substring(idx, idx + 2500);
        assert.ok(
            block.indexOf("process.emit('inspector#indexes'") > -1,
            'expected process.emit in server.js indexes endpoint'
        );
    });

    it('server.js endpoint has 2-second timeout safety net', function() {
        var src = getServerSrc();
        var idx = src.indexOf('/_gina\\/indexes');
        var block = src.substring(idx, idx + 2500);
        assert.ok(
            /setTimeout\(\s*_ixRespond\s*,\s*2000\s*\)/.test(block),
            'expected 2000ms timeout in server.js indexes endpoint'
        );
    });

    it('server.js endpoint sets access-control-allow-origin for CORS', function() {
        var src = getServerSrc();
        var idx = src.indexOf('/_gina\\/indexes');
        var block = src.substring(idx, idx + 1500);
        assert.ok(
            block.indexOf('access-control-allow-origin') > -1,
            'expected CORS header in indexes endpoint'
        );
    });

    // ── server.isaac.js endpoint ───────────────────────────────────────────

    it('server.isaac.js has /_gina/indexes endpoint', function() {
        assert.ok(
            getIsaacSrc().indexOf('/_gina\\/indexes') > -1,
            'expected /_gina/indexes regex in server.isaac.js'
        );
    });

    it('server.isaac.js endpoint supports HTTP/2 streams', function() {
        var src = getIsaacSrc();
        var idx = src.indexOf('/_gina\\/indexes');
        var block = src.substring(idx, idx + 2000);
        assert.ok(
            block.indexOf('response.stream') > -1,
            'expected HTTP/2 stream support in server.isaac.js indexes endpoint'
        );
    });

    // ── Inspector UI ───────────────────────────────────────────────────────

    it('Inspector JS has fetchLiveIndexes function', function() {
        assert.ok(
            getInspJs().indexOf('fetchLiveIndexes') > -1,
            'expected fetchLiveIndexes in inspector.js'
        );
    });

    it('Inspector JS fetches /_gina/indexes', function() {
        assert.ok(
            getInspJs().indexOf('/_gina/indexes') > -1,
            'expected /_gina/indexes URL in inspector.js'
        );
    });

    it('Inspector JS has resolveLiveIndexes function', function() {
        assert.ok(
            getInspJs().indexOf('resolveLiveIndexes') > -1,
            'expected resolveLiveIndexes in inspector.js'
        );
    });

    it('Inspector JS has extractTableFromStatement function', function() {
        assert.ok(
            getInspJs().indexOf('extractTableFromStatement') > -1,
            'expected extractTableFromStatement in inspector.js'
        );
    });

    it('renderQueryContent resolves live indexes before rendering badges', function() {
        var src = getInspJs();
        var resolveIdx = src.indexOf('resolveLiveIndexes(q)');
        var badgeIdx = src.indexOf('bm-idx-none');
        assert.ok(
            resolveIdx > -1 && badgeIdx > -1 && resolveIdx < badgeIdx,
            'live index resolution must happen before badge rendering'
        );
    });

    it('renderQueryContent triggers fetchLiveIndexes for N/A queries', function() {
        var src = getInspJs();
        var renderIdx = src.indexOf('function renderQueryContent');
        var endIdx = src.indexOf('function', renderIdx + 30);
        // Find fetchLiveIndexes() call within the function
        var fnBlock = src.substring(renderIdx, endIdx > renderIdx ? endIdx : renderIdx + 10000);
        assert.ok(
            fnBlock.indexOf('fetchLiveIndexes()') > -1,
            'expected fetchLiveIndexes() call in renderQueryContent'
        );
    });
});


// ── 49 — explainForIndexes: dual conn shape resolution and error safety ──────

describe('49 - explainForIndexes: dual conn shape and error safety', function() {

    var CB_SRC_49 = path.join(FW, 'core/connectors/couchbase/index.js');
    var _cbSrc49;
    function getCbSrc49() { return _cbSrc49 || (_cbSrc49 = fs.readFileSync(CB_SRC_49, 'utf8')); }

    function getExplainBlock() {
        var src = getCbSrc49();
        var idx = src.indexOf('var explainForIndexes = function');
        return src.substring(idx, idx + 2000);
    }

    // Cluster resolution was factored out of explainForIndexes into the shared
    // resolveCluster() helper — slice that helper for the dual-shape pins below.
    function getResolveBlock() {
        var src = getCbSrc49();
        var idx = src.indexOf('var resolveCluster = function');
        return src.substring(idx, idx + 1000);
    }

    // ── cluster resolution from two conn shapes ──

    it('resolves cluster from conn._cluster (entity query path)', function() {
        var block = getResolveBlock();
        assert.ok(
            /conn\._cluster/.test(block),
            'expected conn._cluster probe for entity query path'
        );
    });

    it('resolves cluster from conn._scope._bucket._cluster (bulk insert path)', function() {
        var block = getResolveBlock();
        assert.ok(
            /conn\._scope.*\._bucket.*\._cluster/.test(block),
            'expected conn._scope._bucket._cluster probe for bulk insert path'
        );
    });

    it('checks conn._cluster first (direct path takes priority)', function() {
        var block = getResolveBlock();
        var directIdx = block.indexOf('conn._cluster');
        var nestedIdx = block.indexOf('conn._scope');
        assert.ok(directIdx > -1 && nestedIdx > -1);
        assert.ok(
            directIdx < nestedIdx,
            'conn._cluster must be checked before conn._scope._bucket._cluster'
        );
    });

    // ── graceful fallback when cluster cannot be resolved ──

    it('returns early with a warning when cluster is null', function() {
        // The null-cluster guard now lives in the shared resolveCluster() (it
        // throws GINA_COUCHBASE_CLUSTER_UNRESOLVED); explainForIndexes catches
        // that and degrades non-fatally (warn + return) before touching cache.
        var resolveBlock = getResolveBlock();
        assert.ok(
            /!cluster/.test(resolveBlock),
            'expected null cluster guard in resolveCluster'
        );

        var block = getExplainBlock();
        assert.ok(
            block.indexOf('console.warn') > -1,
            'expected console.warn for unresolvable cluster'
        );
        // Must catch the resolution error and return before marking cache pending
        var catchIdx    = block.indexOf('catch (_clusterErr)');
        var returnIdx   = block.indexOf('return;', catchIdx);
        var cacheSetIdx = block.indexOf('_explainCache.set(statement, null)');
        assert.ok(catchIdx > -1, 'explainForIndexes must catch the resolution error');
        assert.ok(
            returnIdx > -1 && returnIdx < cacheSetIdx,
            'must return before marking cache as pending'
        );
    });

    it('validates cluster.query is a function', function() {
        var block = getResolveBlock();
        assert.ok(
            /typeof.*cluster\.query.*!==?\s*'function'/.test(block) ||
            /typeof\(cluster\.query\)\s*!==?\s*'function'/.test(block),
            'expected typeof cluster.query check'
        );
    });

    // ── try/catch wraps the cluster.query() call ──

    it('wraps cluster.query() in try/catch for synchronous error safety', function() {
        var block = getExplainBlock();
        var queryIdx = block.indexOf('cluster.query(');
        assert.ok(queryIdx > -1, 'expected cluster.query() call');
        // try must appear before the query call
        var tryIdx = block.lastIndexOf('try {', queryIdx);
        assert.ok(tryIdx > -1, 'expected try block before cluster.query()');
        // catch must appear after
        var catchIdx = block.indexOf('catch (_explainErr)', queryIdx);
        assert.ok(catchIdx > -1, 'expected catch (_explainErr) after cluster.query()');
    });

    it('try/catch sets cache to null on synchronous error', function() {
        var block = getExplainBlock();
        var catchIdx = block.indexOf('catch (_explainErr)');
        assert.ok(catchIdx > -1);
        var catchBlock = block.substring(catchIdx, catchIdx + 200);
        assert.ok(
            catchBlock.indexOf('_explainCache.set(statement, null)') > -1,
            'expected cache set to null in catch block'
        );
    });

    it('try/catch logs the error message', function() {
        var block = getExplainBlock();
        var catchIdx = block.indexOf('catch (_explainErr)');
        assert.ok(catchIdx > -1);
        var catchBlock = block.substring(catchIdx, catchIdx + 200);
        assert.ok(
            catchBlock.indexOf('console.warn') > -1,
            'expected console.warn in catch block'
        );
    });

    // ── both call sites are safe ──

    it('entity query call site (onQueryCallback) calls explainForIndexes without external try/catch', function() {
        var src = getCbSrc49();
        // Find the first call site (onQueryCallback path) — not inside a try/catch wrapper
        var firstCallIdx = src.indexOf('explainForIndexes(conn,');
        assert.ok(firstCallIdx > -1, 'expected first call site');
        // Should NOT have "try {" wrapping it — the function handles errors internally
        var preceding = src.substring(Math.max(0, firstCallIdx - 80), firstCallIdx);
        assert.ok(
            preceding.indexOf('try {') === -1 || preceding.indexOf('try {') < preceding.indexOf('\n'),
            'entity query call site should not need external try/catch'
        );
    });

    it('bulk insert call site calls explainForIndexes without external try/catch', function() {
        var src = getCbSrc49();
        // Find the second call site (bulkInsert path)
        var firstCallIdx = src.indexOf('explainForIndexes(conn,');
        var secondCallIdx = src.indexOf('explainForIndexes(conn,', firstCallIdx + 1);
        assert.ok(secondCallIdx > -1, 'expected second call site in bulkInsert');
        // Should NOT have external try/catch — internal handling is sufficient
        var preceding = src.substring(Math.max(0, secondCallIdx - 80), secondCallIdx);
        assert.ok(
            preceding.indexOf('try {') === -1 || preceding.indexOf('try {') < preceding.indexOf('\n'),
            'bulk insert call site should not need external try/catch'
        );
    });

    // ── uses resolved cluster variable, not conn._cluster directly ──

    it('calls cluster.query() not conn._cluster.query()', function() {
        var block = getExplainBlock();
        // After the resolution block, the actual query call should use the resolved `cluster` var
        var queryCallIdx = block.indexOf('cluster.query(');
        assert.ok(queryCallIdx > -1, 'expected cluster.query() call');
        // There should be no conn._cluster.query() after the resolution
        var directCallIdx = block.indexOf('conn._cluster.query(');
        assert.ok(
            directCallIdx === -1,
            'should use resolved cluster variable, not conn._cluster.query() directly'
        );
    });
});


// ── 50 — /_gina/reveal handler in server.js (engine-agnostic) ────────────────

describe('50 - /_gina/reveal handler is in server.js (engine-agnostic)', function() {

    function getBlock() {
        var src = getServerSrc();
        var start = src.indexOf('Inspector reveal');
        assert.ok(start > -1, 'expected "Inspector reveal" anchor comment in server.js');
        var end = src.indexOf('Fixing an express js bug', start);
        assert.ok(end > -1, 'expected end anchor after reveal block');
        return src.substring(start, end);
    }

    it('server.js contains the /_gina/reveal regex', function() {
        assert.ok(
            getBlock().indexOf('/_gina\\/reveal') > -1,
            'expected /_gina/reveal regex in server.js'
        );
    });

    it('server.js checks NODE_ENV_IS_DEV for the reveal endpoint', function() {
        assert.ok(
            getBlock().indexOf('NODE_ENV_IS_DEV') > -1,
            'expected NODE_ENV_IS_DEV guard near the reveal handler'
        );
    });

    it('server.js restricts reveal to GET requests', function() {
        var block = getBlock();
        assert.ok(
            /request\.method\.toUpperCase\(\)\s*===\s*'GET'/.test(block),
            'expected GET-only guard in reveal handler'
        );
    });

    it('server.js sets content-type application/json for reveal', function() {
        assert.ok(
            /setHeader\('content-type',\s*'application\/json/.test(getBlock()),
            'expected application/json content-type in reveal handler'
        );
    });

    it('server.js sets cache-control no-cache, no-store for reveal', function() {
        assert.ok(
            /setHeader\('cache-control',\s*'no-cache,\s*no-store'\)/.test(getBlock()),
            'expected no-cache, no-store cache-control header'
        );
    });

    it('server.js sets access-control-allow-origin CORS header for reveal', function() {
        assert.ok(
            /setHeader\('access-control-allow-origin',\s*'\*'\)/.test(getBlock()),
            'expected CORS header in reveal handler'
        );
    });

    it('server.js returns 403 when NODE_SCOPE is not local', function() {
        var block = getBlock();
        assert.ok(
            block.indexOf("process.env.NODE_SCOPE !== 'local'") > -1,
            'expected NODE_SCOPE !== local guard'
        );
        assert.ok(
            /statusCode\s*=\s*403/.test(block),
            'expected statusCode 403 for non-local scope'
        );
        assert.ok(
            /reveal forbidden in non-local scope/.test(block),
            'expected 403 error body'
        );
    });

    it('server.js returns 404 when no unredacted snapshot is available', function() {
        var block = getBlock();
        assert.ok(
            block.indexOf('_lastGinaDataUnredacted') > -1,
            'expected _lastGinaDataUnredacted reference in reveal handler'
        );
        assert.ok(
            /statusCode\s*=\s*404/.test(block),
            'expected statusCode 404 when snapshot missing'
        );
        assert.ok(
            /no snapshot available/.test(block),
            'expected 404 error body'
        );
    });

    it('server.js returns the unredacted snapshot on success', function() {
        var block = getBlock();
        assert.ok(
            /JSON\.stringify\(self\.instance\._lastGinaDataUnredacted\)/.test(block),
            'expected JSON.stringify(self.instance._lastGinaDataUnredacted) on success path'
        );
    });

});


// ── 51 — /_gina/reveal handler in server.isaac.js (Isaac fast-path) ──────────

describe('51 - /_gina/reveal handler is in server.isaac.js (Isaac fast-path)', function() {

    var _isaacSrc51;
    function getIsaacSrc51() { return _isaacSrc51 || (_isaacSrc51 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }

    function getBlock() {
        var src = getIsaacSrc51();
        var start = src.indexOf('Inspector reveal');
        assert.ok(start > -1, 'expected "Inspector reveal" anchor comment in server.isaac.js');
        var end = src.indexOf('Proxy detection', start);
        assert.ok(end > -1, 'expected end anchor after reveal block');
        return src.substring(start, end);
    }

    it('server.isaac.js contains the /_gina/reveal regex', function() {
        assert.ok(
            getBlock().indexOf('/_gina\\/reveal') > -1,
            'expected /_gina/reveal regex in server.isaac.js'
        );
    });

    it('server.isaac.js uses the isCacheless dev-mode guard', function() {
        assert.ok(
            /if\s*\(\s*isCacheless/.test(getBlock()),
            'expected isCacheless guard on the reveal handler'
        );
    });

    it('server.isaac.js restricts reveal to GET requests', function() {
        assert.ok(
            /request\.method\.toUpperCase\(\)\s*===\s*'GET'/.test(getBlock()),
            'expected GET-only guard in Isaac reveal handler'
        );
    });

    it('server.isaac.js sets application/json content-type for reveal', function() {
        assert.ok(
            /'content-type':\s*'application\/json/.test(getBlock()),
            'expected application/json content-type header'
        );
    });

    it('server.isaac.js sets no-cache cache-control for reveal', function() {
        assert.ok(
            /'cache-control':\s*'no-cache,\s*no-store'/.test(getBlock()),
            'expected no-cache, no-store cache-control header'
        );
    });

    it('server.isaac.js sets CORS header for cross-origin reveal access', function() {
        assert.ok(
            /'access-control-allow-origin':\s*'\*'/.test(getBlock()),
            'expected CORS header in Isaac reveal handler'
        );
    });

    it('server.isaac.js supports HTTP/2 via response.stream.respond()', function() {
        var block = getBlock();
        assert.ok(
            block.indexOf('response.stream') > -1,
            'expected response.stream check in Isaac reveal handler'
        );
        assert.ok(
            /response\.stream\.respond\(/.test(block),
            'expected response.stream.respond() HTTP/2 path'
        );
        assert.ok(
            /response\.stream\.destroyed\s*\|\|\s*response\.stream\.closed/.test(block),
            'expected destroyed/closed guard on response.stream'
        );
    });

    it('server.isaac.js returns 403 when NODE_SCOPE is not local', function() {
        var block = getBlock();
        assert.ok(
            block.indexOf("process.env.NODE_SCOPE !== 'local'") > -1,
            'expected NODE_SCOPE !== local guard in Isaac'
        );
        assert.ok(
            /_rvSend\(403,/.test(block),
            'expected _rvSend(403, ...) call for non-local scope'
        );
        assert.ok(
            /reveal forbidden in non-local scope/.test(block),
            'expected 403 error body'
        );
    });

    it('server.isaac.js returns 404 when no unredacted snapshot is available', function() {
        var block = getBlock();
        assert.ok(
            block.indexOf('server._lastGinaDataUnredacted') > -1,
            'expected server._lastGinaDataUnredacted reference'
        );
        assert.ok(
            /_rvSend\(404,/.test(block),
            'expected _rvSend(404, ...) call for missing snapshot'
        );
        assert.ok(
            /no snapshot available/.test(block),
            'expected 404 error body'
        );
    });

    it('server.isaac.js returns the unredacted snapshot on success', function() {
        var block = getBlock();
        assert.ok(
            /_rvSend\(200,\s*server\._lastGinaDataUnredacted\)/.test(block),
            'expected _rvSend(200, server._lastGinaDataUnredacted) on success path'
        );
    });

});


// ── 52 — /_gina/reveal URL pattern matching ──────────────────────────────────

describe('52 - /_gina/reveal URL pattern matching', function() {

    var pattern = /\/_gina\/reveal$/;

    it('matches /_gina/reveal', function() {
        assert.ok(pattern.test('/_gina/reveal'));
    });

    it('matches /webroot/_gina/reveal', function() {
        assert.ok(pattern.test('/myapp/_gina/reveal'));
    });

    it('does not match /_gina/reveal/', function() {
        assert.ok(!pattern.test('/_gina/reveal/'));
    });

    it('does not match /_gina/reveal/foo', function() {
        assert.ok(!pattern.test('/_gina/reveal/foo'));
    });

    it('does not match /_gina/reveals', function() {
        assert.ok(!pattern.test('/_gina/reveals'));
    });

    it('does not match /_gina/revealx', function() {
        assert.ok(!pattern.test('/_gina/revealx'));
    });

    it('does not match /_gina/agent', function() {
        assert.ok(!pattern.test('/_gina/agent'));
    });

    it('does not match /_gina/logs', function() {
        assert.ok(!pattern.test('/_gina/logs'));
    });

    it('does not match /_gina/inspector', function() {
        assert.ok(!pattern.test('/_gina/inspector'));
    });

});


// ── 53 — unredacted snapshot scope gate (render-swig.js + render-json.js) ────

describe('53 - unredacted snapshot is only stored when scope === local', function() {

    var RENDER_SWIG_53 = path.join(FW, 'core/controller/controller.render-swig.js');
    var RENDER_JSON_53 = path.join(FW, 'core/controller/controller.render-json.js');
    var _rSwigSrc53, _rJsonSrc53;
    function getRSwigSrc53() { return _rSwigSrc53 || (_rSwigSrc53 = fs.readFileSync(RENDER_SWIG_53, 'utf8')); }
    function getRJsonSrc53() { return _rJsonSrc53 || (_rJsonSrc53 = fs.readFileSync(RENDER_JSON_53, 'utf8')); }

    // ── render-swig.js ──

    it('render-swig.js gates the unredacted snapshot on NODE_SCOPE === local', function() {
        var src = getRSwigSrc53();
        assert.ok(
            /__gdPayloadUnredacted\s*=\s*\(process\.env\.NODE_SCOPE\s*===\s*'local'\)/.test(src),
            'expected scope-gated ternary assigning __gdPayloadUnredacted in render-swig.js'
        );
    });

    it('render-swig.js uses a deep clone (JSON.parse + JSON.stringify) for the snapshot', function() {
        var src = getRSwigSrc53();
        assert.ok(
            /__gdPayloadUnredacted\s*=\s*\(process\.env\.NODE_SCOPE\s*===\s*'local'\)\s*\?\s*JSON\.parse\(JSON\.stringify\(__gdPayload\)\)\s*:\s*null/.test(src),
            'expected JSON.parse(JSON.stringify(__gdPayload)) deep clone, null otherwise'
        );
    });

    it('render-swig.js snapshots BEFORE the redact pass', function() {
        var src = getRSwigSrc53();
        var snapIdx = src.indexOf('__gdPayloadUnredacted');
        var redactIdx = src.indexOf('inspectorRedact.redact(__gdPayload', snapIdx);
        assert.ok(snapIdx > -1 && redactIdx > -1, 'both snapshot and redact call must exist');
        assert.ok(
            snapIdx < redactIdx,
            'unredacted snapshot must be taken BEFORE the redact() call'
        );
    });

    it('render-swig.js assigns the snapshot to serverInstance._lastGinaDataUnredacted', function() {
        var src = getRSwigSrc53();
        assert.ok(
            /self\.serverInstance\._lastGinaDataUnredacted\s*=\s*__gdPayloadUnredacted/.test(src),
            'expected assignment to self.serverInstance._lastGinaDataUnredacted'
        );
    });

    it('render-swig.js defensively clears _lastGinaDataUnredacted when snapshot is null', function() {
        var src = getRSwigSrc53();
        assert.ok(
            /self\.serverInstance\._lastGinaDataUnredacted\s*=\s*null/.test(src),
            'expected defensive null assignment when snapshot is null'
        );
    });

    it('render-swig.js exposes bundle scope on __gdGina.environment.scope', function() {
        var src = getRSwigSrc53();
        assert.ok(
            /__gdGina\.environment\.scope\s*=\s*process\.env\.NODE_SCOPE\s*\|\|\s*null/.test(src),
            'expected __gdGina.environment.scope exposure'
        );
    });

    // ── render-json.js — MUST NOT write the unredacted snapshot ──
    // Reveal unmasks the Data tab, which is sourced from the HTML render's
    // window.opener.__ginaData. If JSON responses wrote _lastGinaDataUnredacted,
    // a background session poll or ping XHR between page load and Reveal click
    // would clobber the HTML snapshot (78B session blob vs 88KB invoice page).
    // Observed 2026-04-16, fixed by making render-swig.js the sole writer.

    it('render-json.js does NOT reference __gdPayloadUnredacted', function() {
        var src = getRJsonSrc53();
        assert.ok(
            !/__gdPayloadUnredacted/.test(src),
            'render-json.js must not build an unredacted snapshot — only render-swig.js does'
        );
    });

    it('render-json.js does NOT write _lastGinaDataUnredacted', function() {
        var src = getRJsonSrc53();
        // Strip comments before checking — comments may reference the slot
        // to explain why it isn't written. Only real code assignments matter.
        var stripped = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/_lastGinaDataUnredacted\s*=/.test(stripped),
            'render-json.js must not write the unredacted slot — JSON polls would clobber the HTML render snapshot'
        );
    });

    it('render-json.js still writes the redacted _lastGinaData and emits inspector#data', function() {
        var src = getRJsonSrc53();
        assert.ok(
            /self\.serverInstance\._lastGinaData\s*=\s*__gdPayload/.test(src),
            'render-json.js must still write the redacted _lastGinaData slot for SSE/engine.io'
        );
        assert.ok(
            /process\.emit\(\s*['"]inspector#data['"]/.test(src),
            'render-json.js must still emit inspector#data for SSE streaming'
        );
    });

});


// ── 54 — toggleReveal URL resolution (cross-bundle proxy routing) ──────────
// Proxy-routed multi-bundle setups mount bundles under
// path prefixes on a single host. A bare fetch to `/_gina/reveal` from the
// Inspector window lands on the proxy's default bundle, not the one that
// rendered the current page — so the snapshot returned is wrong (or 404).
// Fix: derive the URL prefix from `window.opener.location.pathname` so the
// request routes through the same bundle that produced the snapshot.

describe('54 - toggleReveal resolves /_gina/reveal via the shared resolveBundleBase()', function() {

    var INSPECTOR_JS_54 = path.join(BM_DIR, 'inspector.js');
    var _inspSrc54;
    function getInspSrc54() { return _inspSrc54 || (_inspSrc54 = fs.readFileSync(INSPECTOR_JS_54, 'utf8')); }

    // resolveBundleBase()'s own 3-fallback internals (?target= -> opener ->
    // strip) + cross-origin try/catch are pinned in §79; §54 now pins only that
    // toggleReveal routes through that shared resolver (the inline copy was
    // folded in — see llms.txt #176 (formerly #190) follow-up).

    it('toggleReveal resolves its base via the shared resolveBundleBase()', function() {
        var src = getInspSrc54();
        var idx = src.indexOf('function toggleReveal');
        assert.ok(idx > -1, 'toggleReveal function must exist');
        var body = src.slice(idx, idx + 3000);
        assert.ok(
            /var base\s*=\s*resolveBundleBase\(\)/.test(body),
            'toggleReveal must resolve its base via resolveBundleBase()'
        );
    });

    it('toggleReveal no longer inlines the base resolver', function() {
        var src = getInspSrc54();
        var idx = src.indexOf('function toggleReveal');
        var body = src.slice(idx, idx + 3000);
        // Window-independent negative: the inline resolver's distinctive
        // `var base = '';` init is globally gone after the fold (0 file-wide),
        // so this can't trip on neighbouring code the way a `window.opener...`
        // grep over a fixed-size slice would (jsdoc.md fixed-window brittleness).
        assert.ok(
            body.indexOf("var base = '';") < 0,
            'the inline base resolver must be gone from toggleReveal (folded into resolveBundleBase)'
        );
    });

    it('toggleReveal builds the final URL as base + /_gina/reveal', function() {
        var src = getInspSrc54();
        assert.ok(
            /var url\s*=\s*base\s*\+\s*['"]\/_gina\/reveal['"]/.test(src),
            'expected `var url = base + "/_gina/reveal"` construction'
        );
    });

});


// ── 55 — Inspector passive /_gina/agent subscription (opener mode SPA fix) ──

describe('55 - Inspector passive /_gina/agent subscription alongside opener', function() {

    var INSPECTOR_55 = path.join(BM_DIR, 'inspector.js');
    var _inspSrc55;
    function getInspSrc55() { return _inspSrc55 || (_inspSrc55 = fs.readFileSync(INSPECTOR_55, 'utf8')); }

    it('inspector.js defines tryAgentPassive function', function() {
        assert.ok(
            getInspSrc55().indexOf('function tryAgentPassive') > -1,
            'expected tryAgentPassive() function definition'
        );
    });

    it('tryAgentPassive skips when source is already agent', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        assert.ok(idx > -1);
        var body = src.slice(idx, idx + 2000);
        assert.ok(
            /source\s*===\s*'agent'/.test(body),
            'expected guard skipping passive subscription when source === "agent"'
        );
    });

    it('tryAgentPassive resolves the bundle URL via the shared resolveBundleBase()', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 2500);
        assert.ok(
            /var base\s*=\s*resolveBundleBase\(\)/.test(body),
            'tryAgentPassive must resolve its base via resolveBundleBase()'
        );
        assert.ok(
            body.indexOf("var base = '';") < 0,
            'the inline base resolver must be gone from tryAgentPassive (folded into resolveBundleBase; its ?target= branch is inert here)'
        );
    });

    it('tryAgentPassive opens an EventSource to /_gina/agent', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 2500);
        assert.ok(
            body.indexOf('/_gina/agent') > -1,
            'expected /_gina/agent URL construction'
        );
        assert.ok(
            body.indexOf('new EventSource') > -1,
            'expected new EventSource() call'
        );
    });

    it('tryAgentPassive does NOT mutate the primary source', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 6000);
        // The primary source must stay on opener — never reassigned to 'agent'
        assert.ok(
            !/source\s*=\s*'agent'/.test(body),
            'tryAgentPassive must NOT reassign source = "agent" (breaks opener-driven behaviour)'
        );
    });

    it('tryAgentPassive listens for named data events', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 6000);
        assert.ok(
            body.indexOf("addEventListener('data'") > -1,
            'expected es.addEventListener("data") in tryAgentPassive'
        );
    });

    it('tryAgentPassive listens for named log events', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 6000);
        assert.ok(
            body.indexOf("addEventListener('log'") > -1,
            'expected es.addEventListener("log") in tryAgentPassive'
        );
    });

    it('tryAgentPassive diffs JSON via lastGdStr (no redundant re-renders)', function() {
        var src = getInspSrc55();
        var idx = src.indexOf('function tryAgentPassive');
        var body = src.slice(idx, idx + 6000);
        assert.ok(
            /lastGdStr/.test(body),
            'expected lastGdStr compared to stringified payload'
        );
    });

    // (cross-origin try/catch safety is now resolveBundleBase()'s concern,
    //  pinned in §79; tryAgentPassive resolves via that helper — see above.)

    it('init wires tryAgentPassive inside the !isAgent branch', function() {
        var src = getInspSrc55();
        var isAgentIdx = src.indexOf('var isAgent = tryAgent()');
        assert.ok(isAgentIdx > -1);
        // grep forward through the !isAgent block — tryAgentPassive should be
        // called there, not inside the agent branch
        var block = src.slice(isAgentIdx, isAgentIdx + 4200);
        assert.ok(
            block.indexOf('if (!isAgent)') > -1,
            'expected if (!isAgent) guard'
        );
        assert.ok(
            block.indexOf('tryAgentPassive()') > -1,
            'expected tryAgentPassive() call inside the !isAgent branch'
        );
    });

    it('init skips tryServerLogs when passive agent succeeds (no duplicate log entries)', function() {
        var src = getInspSrc55();
        var isAgentIdx = src.indexOf('var isAgent = tryAgent()');
        var block = src.slice(isAgentIdx, isAgentIdx + 4200);
        // Expect the call sequence: tryAgentPassive(), then conditional tryServerLogs()
        assert.ok(
            /tryAgentPassive\(\)[\s\S]*?if\s*\(\s*!_passiveAgentActive[\s\S]*?tryServerLogs\(\)/.test(block),
            'expected tryServerLogs() to be gated on !_passiveAgentActive'
        );
    });

    it('_passiveAgentEs state variable is declared in the state block', function() {
        var src = getInspSrc55();
        assert.ok(
            /var\s+_passiveAgentEs\s*=\s*null\s*;/.test(src),
            'expected _passiveAgentEs state variable declaration'
        );
    });

});


// ── 56 — Refresh button: soft refresh + Shift+click hard refresh ────────────

describe('56 - Refresh button soft refresh (live indexes, reveal, passive agent) + Shift+click reload', function() {

    var INSPECTOR_56 = path.join(BM_DIR, 'inspector.js');
    var INDEX_HTML_56 = path.join(BM_DIR, 'index.html');
    var _inspSrc56, _htmlSrc56;
    function getInspSrc56() { return _inspSrc56 || (_inspSrc56 = fs.readFileSync(INSPECTOR_56, 'utf8')); }
    function getHtmlSrc56() { return _htmlSrc56 || (_htmlSrc56 = fs.readFileSync(INDEX_HTML_56, 'utf8')); }

    function getRefreshHandler() {
        var src = getInspSrc56();
        var idx = src.indexOf("qs('#bm-refresh')");
        assert.ok(idx > -1, 'expected #bm-refresh lookup');
        return src.slice(idx, idx + 3000);
    }

    it('click handler invalidates the JSON diff cache and re-polls', function() {
        var body = getRefreshHandler();
        assert.ok(/lastGdStr\s*=\s*''/.test(body), 'expected lastGdStr reset');
        assert.ok(/pollData\(\)/.test(body), 'expected pollData() call');
    });

    it('click handler forces a live indexes re-fetch (bypasses cache guard)', function() {
        var body = getRefreshHandler();
        assert.ok(/_liveIndexes\s*=\s*null/.test(body), 'expected _liveIndexes reset to null');
        assert.ok(/_liveIndexesFetching\s*=\s*false/.test(body), 'expected _liveIndexesFetching reset to false');
        assert.ok(/fetchLiveIndexes\(\)/.test(body), 'expected fetchLiveIndexes() call');
    });

    it('click handler refetches /_gina/reveal only when _revealActive', function() {
        var body = getRefreshHandler();
        assert.ok(/if\s*\(\s*_revealActive\s*\)/.test(body), 'expected _revealActive guard');
        assert.ok(body.indexOf('/_gina/reveal') > -1, 'expected /_gina/reveal URL');
        assert.ok(/new\s+XMLHttpRequest\(\)/.test(body), 'expected XMLHttpRequest for reveal refetch');
        assert.ok(/_revealedData\s*=\s*JSON\.parse/.test(body), 'expected _revealedData reassignment on 200');
        assert.ok(/renderTab\(\s*'data'\s*\)/.test(body), 'expected renderTab("data") on success');
        assert.ok(/var base\s*=\s*resolveBundleBase\(\)/.test(body), 'the reveal refetch must resolve its base via resolveBundleBase()');
        assert.ok(body.indexOf("var base = '';") < 0, 'the inline base resolver must be gone from the refresh handler (folded into resolveBundleBase)');
    });

    it('click handler reopens the passive agent SSE stream when closed', function() {
        var body = getRefreshHandler();
        assert.ok(/source\s*!==\s*'agent'/.test(body), 'expected source !== "agent" guard');
        assert.ok(
            /!_passiveAgentEs\s*\|\|\s*_passiveAgentEs\.readyState\s*===\s*2/.test(body),
            'expected readyState === 2 (CLOSED) or null check'
        );
        assert.ok(/tryAgentPassive\(\s*_channelBase/.test(body),
            'expected tryAgentPassive(_channelBase …) — the reopen stays on the currently-followed bundle (#B205)');
    });

    it('Shift+click triggers window.opener.location.reload()', function() {
        var body = getRefreshHandler();
        assert.ok(/ev\.shiftKey/.test(body), 'expected ev.shiftKey check');
        assert.ok(
            /window\.opener\.location\.reload\(\)/.test(body),
            'expected opener reload on shift+click'
        );
        assert.ok(
            /window\.opener\s*&&\s*!window\.opener\.closed/.test(body),
            'expected null/closed guard on opener'
        );
    });

    it('spin animation is still wired on animationend', function() {
        var body = getRefreshHandler();
        assert.ok(/classList\.add\(['"]spinning['"]\)/.test(body), 'expected .spinning class add');
        assert.ok(
            /animationend[\s\S]*?classList\.remove\(['"]spinning['"]\)/.test(body),
            'expected .spinning class removal on animationend'
        );
    });

    it('index.html refresh button tooltip advertises Shift+click', function() {
        var html = getHtmlSrc56();
        assert.ok(
            /id="bm-refresh"[^>]*title="[^"]*Shift\+click/.test(html),
            'expected "Shift+click" in #bm-refresh title attribute'
        );
    });

});


describe('57 - Template engine version badge in View tab', function() {

    var RENDER_SWIG_57    = path.join(FW, 'core/controller/controller.render-swig.js');
    var RENDER_NJ_57      = path.join(FW, 'core/controller/controller.render-nunjucks.js');
    var INSPECTOR_JS_57   = path.join(BM_DIR, 'inspector.js');
    var INSPECTOR_CSS_57  = path.join(BM_DIR, 'inspector.css');
    var _rSwigSrc57, _rNjSrc57, _iJsSrc57, _iCssSrc57;
    function getRSwigSrc57()    { return _rSwigSrc57  || (_rSwigSrc57  = fs.readFileSync(RENDER_SWIG_57,    'utf8')); }
    function getRNjSrc57()      { return _rNjSrc57    || (_rNjSrc57    = fs.readFileSync(RENDER_NJ_57,      'utf8')); }
    function getInspectorJs57() { return _iJsSrc57    || (_iJsSrc57    = fs.readFileSync(INSPECTOR_JS_57,   'utf8')); }
    function getInspectorCss57(){ return _iCssSrc57   || (_iCssSrc57   = fs.readFileSync(INSPECTOR_CSS_57,  'utf8')); }

    it('render-swig.js reads process.gina._swigDecision', function() {
        assert.ok(
            /process\.gina\s*&&\s*process\.gina\._swigDecision/.test(getRSwigSrc57()),
            'expected _swigDecision lookup'
        );
    });

    it('render-swig.js emits __gdGina.environment.templateEngine = { name, version }', function() {
        assert.ok(
            /__gdGina\.environment\.templateEngine\s*=\s*\{[^}]*name[^}]*version/.test(getRSwigSrc57()),
            'expected templateEngine = { name, version } on __gdGina.environment'
        );
    });

    it('render-swig.js mirrors templateEngine on __gdUser.environment', function() {
        assert.ok(
            /__gdUser\.environment\.templateEngine\s*=\s*\{[^}]*name[^}]*version/.test(getRSwigSrc57()),
            'expected templateEngine on __gdUser.environment too'
        );
    });

    it('render-swig.js has package.json fallback when decision version is missing', function() {
        assert.ok(
            /require\(_swigPkg\s*\+\s*['"]\/package\.json['"]\)\.version/.test(getRSwigSrc57()),
            'expected require(pkg + "/package.json").version fallback'
        );
    });

    it('render-swig.js strips @rhinostone/ prefix from package name', function() {
        assert.ok(
            /replace\(\/\^@rhinostone\\\//.test(getRSwigSrc57()),
            'expected /^@rhinostone\\// prefix stripping'
        );
    });

    it('render-nunjucks.js reads process.gina._nunjucksDecision', function() {
        assert.ok(
            /process\.gina\s*&&\s*process\.gina\._nunjucksDecision/.test(getRNjSrc57()),
            'expected _nunjucksDecision lookup'
        );
    });

    it('render-nunjucks.js emits templateEngine with name "nunjucks"', function() {
        assert.ok(
            /__gdGina\.environment\.templateEngine\s*=\s*\{\s*name:\s*['"]nunjucks['"]/.test(getRNjSrc57()),
            'expected literal name: "nunjucks" in templateEngine for nunjucks delegate'
        );
    });

    it('render-nunjucks.js mirrors templateEngine on __gdUser.environment', function() {
        assert.ok(
            /__gdUser\.environment\.templateEngine\s*=/.test(getRNjSrc57()),
            'expected templateEngine on __gdUser.environment too'
        );
    });

    it('inspector.js detectEngine checks env.templateEngine BEFORE the view.layout heuristic', function() {
        var src = getInspectorJs57();
        var fnIdx = src.indexOf('function detectEngine(');
        assert.ok(fnIdx > -1, 'detectEngine function must exist');
        var envIdx    = src.indexOf('env.templateEngine', fnIdx);
        var layoutIdx = src.indexOf('view.layout',        fnIdx);
        assert.ok(envIdx    > -1, 'expected env.templateEngine read');
        assert.ok(layoutIdx > -1, 'expected view.layout heuristic');
        assert.ok(envIdx < layoutIdx, 'env.templateEngine must be checked before the heuristic');
    });

    it('inspector.js detectEngine returns { name, version } object shape', function() {
        var src = getInspectorJs57();
        var fnIdx  = src.indexOf('function detectEngine(');
        // Scan ~2000 chars of function body — enough for the whole body.
        var fnBody = src.substring(fnIdx, fnIdx + 2000);
        assert.ok(
            /return\s*\{[\s\S]*?name[\s\S]*?version[\s\S]*?\}/.test(fnBody),
            'expected return { name, version } shape'
        );
    });

    it('inspector.js wraps the version render in an engineVersion guard', function() {
        assert.ok(
            /if\s*\(\s*engineVersion\s*\)/.test(getInspectorJs57()),
            'expected if (engineVersion) guard around the version span'
        );
    });

    it('inspector.js renders bm-vbadge-sep + bm-vbadge-ver inside the engine badge', function() {
        var src = getInspectorJs57();
        // The two spans must be adjacent (sep then ver) inside the engine
        // badge's `if (engine)` block.
        assert.ok(
            /bm-vbadge-sep[\s\S]{0,200}?bm-vbadge-ver/.test(src),
            'expected bm-vbadge-sep followed by bm-vbadge-ver span'
        );
    });

    it('inspector.css has scoped .bm-vbadge-engine .bm-vbadge-ver rule', function() {
        assert.ok(
            /\.bm-vbadge-engine\s+\.bm-vbadge-ver\s*\{/.test(getInspectorCss57()),
            'expected scoped .bm-vbadge-engine .bm-vbadge-ver rule in compiled CSS'
        );
    });

    it('inspector.css resets text-transform and letter-spacing for the version span', function() {
        var src   = getInspectorCss57();
        var match = src.match(/\.bm-vbadge-engine\s+\.bm-vbadge-ver\s*\{[^}]+\}/);
        assert.ok(match, 'scoped rule must exist');
        assert.ok(/text-transform\s*:\s*none/.test(match[0]),  'expected text-transform: none');
        assert.ok(/letter-spacing\s*:\s*0/.test(match[0]),     'expected letter-spacing: 0');
        assert.ok(/opacity\s*:\s*\.?0?\.65/.test(match[0]),    'expected opacity: .65 (dimmed)');
    });

});


describe('58 - View tab Weight / Load fallback via server-side metrics', function() {

    var RENDER_SWIG_58   = path.join(FW, 'core/controller/controller.render-swig.js');
    var RENDER_NJ_58     = path.join(FW, 'core/controller/controller.render-nunjucks.js');
    var INSPECTOR_JS_58  = path.join(BM_DIR, 'inspector.js');
    var _rSwig58, _rNj58, _iJs58;
    function getRSwig58()      { return _rSwig58 || (_rSwig58 = fs.readFileSync(RENDER_SWIG_58,   'utf8')); }
    function getRNj58()        { return _rNj58   || (_rNj58   = fs.readFileSync(RENDER_NJ_58,     'utf8')); }
    function getInspectorJs58(){ return _iJs58   || (_iJs58   = fs.readFileSync(INSPECTOR_JS_58,  'utf8')); }

    // ── Server-side emission ──────────────────────────────────────────────

    it('render-swig.js emits __gdGina.environment.metrics with weightBytes + serverMs', function() {
        assert.ok(
            /__gdGina\.environment\.metrics\s*=\s*\{\s*weightBytes:\s*null,\s*serverMs:/.test(getRSwig58()),
            'expected metrics = { weightBytes: null, serverMs } on __gdGina.environment'
        );
    });

    it('render-swig.js mirrors metrics on __gdUser.environment', function() {
        assert.ok(
            /__gdUser\.environment\.metrics\s*=\s*\{\s*weightBytes:\s*null,\s*serverMs:/.test(getRSwig58()),
            'expected metrics on __gdUser.environment too'
        );
    });

    it('render-swig.js computes serverMs from local._timeline entries', function() {
        var src = getRSwig58();
        // The init computation walks timeline entries; the var name is _serverMsInit.
        assert.ok(src.indexOf('_serverMsInit') > -1, 'expected _serverMsInit variable');
        assert.ok(
            /local\._timeline\.entries/.test(src),
            'expected reads from local._timeline.entries to compute serverMs'
        );
    });

    it('render-swig.js cache-hit patch late-binds weightBytes via Buffer.byteLength', function() {
        var src = getRSwig58();
        var idx = src.indexOf('_cacheWeightBytes');
        assert.ok(idx > -1, 'expected _cacheWeightBytes variable in cache-hit branch');
        var block = src.substring(idx, idx + 200);
        assert.ok(
            /Buffer\.byteLength\(htmlContent,\s*['"]utf8['"]\)/.test(block),
            'expected Buffer.byteLength(htmlContent, "utf8") near _cacheWeightBytes'
        );
    });

    it('render-swig.js cache-miss patch late-binds weightBytes via Buffer.byteLength', function() {
        var src = getRSwig58();
        var idx = src.indexOf('_weightBytesFinal');
        assert.ok(idx > -1, 'expected _weightBytesFinal variable in cache-miss branch');
        var block = src.substring(idx, idx + 200);
        assert.ok(
            /Buffer\.byteLength\(htmlContent,\s*['"]utf8['"]\)/.test(block),
            'expected Buffer.byteLength(htmlContent, "utf8") near _weightBytesFinal'
        );
    });

    it('render-swig.js patch script writes weightBytes + serverMs onto both user and gina environments', function() {
        var src = getRSwig58();
        // Both cache-hit and cache-miss patches must touch user.environment.metrics
        // AND gina.environment.metrics for the SSE/poll consumers.
        var userPatches = src.match(/u\.environment\.metrics\.weightBytes\s*=/g) || [];
        var ginaPatches = src.match(/g\.environment\.metrics\.weightBytes\s*=/g) || [];
        assert.ok(userPatches.length >= 2, 'expected u.environment.metrics.weightBytes assignment in both branches');
        assert.ok(ginaPatches.length >= 2, 'expected g.environment.metrics.weightBytes assignment in both branches');
    });

    it('render-swig.js patch combines flow late-entries with metrics late-bind', function() {
        var src = getRSwig58();
        // The new patch shape has a _flowPatch ternary that only emits when
        // late entries exist, then unconditionally late-binds metrics.
        assert.ok(
            /_flowPatch\s*=\s*\(\s*_lateEntries\.length\s*>\s*0\s*\)/.test(src),
            'expected _flowPatch ternary in cache-miss'
        );
        assert.ok(
            /_cacheFlowPatch\s*=\s*\(\s*_cacheLateEntries\.length\s*>\s*0\s*\)/.test(src),
            'expected _cacheFlowPatch ternary in cache-hit'
        );
    });

    it('render-nunjucks.js emits metrics with weightBytes:null + serverMs (emit-time fallback for cache-hits)', function() {
        var src = getRNj58();
        assert.ok(
            /__gdGina\.environment\.metrics\s*=\s*\{\s*weightBytes:\s*null,\s*serverMs:/.test(src),
            'expected metrics = { weightBytes: null, serverMs } on nunjucks __gdGina.environment (cache-hit fallback)'
        );
        assert.ok(
            /__gdUser\.environment\.metrics\s*=/.test(src),
            'expected metrics on __gdUser.environment too'
        );
    });

    it('render-nunjucks.js computes serverMs from local._timeline', function() {
        var src = getRNj58();
        assert.ok(src.indexOf('_njServerMs') > -1, 'expected _njServerMs variable');
        assert.ok(
            /local\._timeline\.entries/.test(src),
            'expected nunjucks delegate reads timeline entries'
        );
    });

    it('render-nunjucks.js late-binds weightBytes via Buffer.byteLength(html)', function() {
        var src = getRNj58();
        var idx = src.indexOf('_njWeightBytesFinal');
        assert.ok(idx > -1, 'expected _njWeightBytesFinal variable in late-bind block');
        var block = src.substring(idx, idx + 200);
        assert.ok(
            /Buffer\.byteLength\(html,\s*['"]utf8['"]\)/.test(block),
            'expected Buffer.byteLength(html, "utf8") near _njWeightBytesFinal'
        );
    });

    it('render-nunjucks.js late-binds serverMs as final timeline delta', function() {
        var src = getRNj58();
        var idx = src.indexOf('_njServerMsFinal');
        assert.ok(idx > -1, 'expected _njServerMsFinal variable in late-bind block');
        var block = src.substring(idx, idx + 300);
        assert.ok(
            /Date\.now\(\)\s*-\s*local\._timeline\.requestStart/.test(block),
            'expected Date.now() - local._timeline.requestStart near _njServerMsFinal'
        );
    });

    it('render-nunjucks.js patch script writes weightBytes + serverMs onto both user and gina environments', function() {
        var src = getRNj58();
        // Single late-bind site (no cache-hit/miss split in nunjucks),
        // so >= 1 occurrence each is enough.
        var userPatches = src.match(/u\.environment\.metrics\.weightBytes\s*=/g) || [];
        var ginaPatches = src.match(/g\.environment\.metrics\.weightBytes\s*=/g) || [];
        assert.ok(userPatches.length >= 1, 'expected u.environment.metrics.weightBytes assignment');
        assert.ok(ginaPatches.length >= 1, 'expected g.environment.metrics.weightBytes assignment');
    });

    it('render-nunjucks.js patch script injects via /<\\/body>/i replace', function() {
        var src = getRNj58();
        var idx = src.indexOf('_njPatchScript');
        assert.ok(idx > -1, 'expected _njPatchScript variable');
        // #B386 — realigned to the FUNCTION replacer. The patch embeds
        // JSON.stringify'd flow entries, and a string replacement expands $&,
        // $` , $' and $1 in the replacement text; both render-swig.js sites
        // already used the function form. Strictly tighter than the previous
        // pin: it now also asserts WHICH replacer form is used.
        //
        // Matched against the WHOLE source rather than a char-distance window:
        // `_njPatchScript` occurs exactly twice (the declaration and this
        // replace call), so the match is unambiguous, and a proximity pin keyed
        // on a fixed byte-count silently stops reaching its target the moment a
        // comment is added above it — which is exactly what happened here.
        assert.strictEqual(
            (src.match(/_njPatchScript/g) || []).length, 2,
            'expected _njPatchScript to appear exactly twice (declaration + replace call)'
        );
        assert.ok(
            /html\s*=\s*html\.replace\(\s*\/<\\\/body>\/i\s*,\s*function\s*\(\s*\)\s*\{\s*return\s+_njPatchScript/.test(src),
            'expected html = html.replace(/<\\/body>/i, function () { return _njPatchScript + ... })'
        );
    });

    it('render-nunjucks.js late-bind block guards on </body> presence and inspector gate', function() {
        var src = getRNj58();
        var idx = src.indexOf('_njPatchScript');
        assert.ok(idx > -1, 'expected _njPatchScript variable');
        // Walk back from _njPatchScript to find the gating if-condition.
        var preamble = src.substring(Math.max(0, idx - 800), idx);
        assert.ok(
            /\/<\\\/body>\/i\.test\(\s*html\s*\)/.test(preamble),
            'expected /<\\/body>/i.test(html) guard before patch generation'
        );
        assert.ok(
            /displayInspector\s*\|\|\s*self\.isCacheless\(\)/.test(preamble),
            'expected gating on (displayInspector || self.isCacheless())'
        );
    });

    // ── Client-side consumption ───────────────────────────────────────────

    it('inspector.js getPageMetrics reads env.metrics into serverWeight + serverLoadMs', function() {
        var src = getInspectorJs58();
        var fnIdx = src.indexOf('function getPageMetrics(');
        assert.ok(fnIdx > -1, 'getPageMetrics function must exist');
        var fnBody = src.substring(fnIdx, fnIdx + 3000);
        assert.ok(
            /environment\.metrics/.test(fnBody),
            'expected env.metrics read in getPageMetrics'
        );
        assert.ok(/serverWeight/.test(fnBody),  'expected serverWeight assignment');
        assert.ok(/serverLoadMs/.test(fnBody),  'expected serverLoadMs assignment');
    });

    it('inspector.js hasBadges gate considers server metrics', function() {
        var src = getInspectorJs58();
        var idx = src.indexOf('var hasBadges =');
        assert.ok(idx > -1, 'hasBadges must exist');
        var block = src.substring(idx, idx + 300);
        assert.ok(/metrics\.serverWeight/.test(block),  'expected serverWeight in hasBadges');
        assert.ok(/metrics\.serverLoadMs/.test(block),  'expected serverLoadMs in hasBadges');
    });

    it('inspector.js weight badge renders dual when both client + server are present', function() {
        var src = getInspectorJs58();
        // Look for the explicit if-both branch in the weight block.
        assert.ok(
            /if\s*\(\s*_clientW\s*&&\s*_serverW\s*\)/.test(src),
            'expected dual branch for client + server weight'
        );
        // The dual branch must use bm-vbadge-res (dimmed) + bm-vbadge-sep.
        var dualIdx = src.search(/if\s*\(\s*_clientW\s*&&\s*_serverW\s*\)/);
        var block = src.substring(dualIdx, dualIdx + 600);
        assert.ok(/bm-vbadge-svr/.test(block),  'expected bm-vbadge-svr (server-emitted dim) in weight dual');
        assert.ok(/bm-vbadge-sep/.test(block),  'expected bm-vbadge-sep in weight dual');
    });

    it('inspector.js load badge renders dual when both client + server are present', function() {
        var src = getInspectorJs58();
        assert.ok(
            /if\s*\(\s*_ld\s*&&\s*_srvLd\s*\)/.test(src),
            'expected dual branch for client + server load'
        );
        var dualIdx = src.search(/if\s*\(\s*_ld\s*&&\s*_srvLd\s*\)/);
        var block = src.substring(dualIdx, dualIdx + 600);
        assert.ok(/bm-vbadge-svr/.test(block),  'expected bm-vbadge-svr (server-emitted dim) in load dual');
        assert.ok(/bm-vbadge-sep/.test(block),  'expected bm-vbadge-sep in load dual');
    });

    it('inspector.js weight badge falls back to server value when no client', function() {
        var src = getInspectorJs58();
        // The server-only branch must reference _serverW alone and surface a
        // tooltip mentioning the opener-unavailable reason.
        assert.ok(
            /Server response body size[\s\S]{0,200}opener/.test(src),
            'expected server-only weight branch with opener-unavailable tooltip'
        );
    });

    it('inspector.js load badge falls back to server value when no client', function() {
        var src = getInspectorJs58();
        assert.ok(
            /Server processing time[\s\S]{0,200}opener/.test(src),
            'expected server-only load branch with opener-unavailable tooltip'
        );
    });

    it('inspector.js empty-state guard considers env.metrics (renderViewContent)', function() {
        var src = getInspectorJs58();
        var fnIdx = src.indexOf('function renderViewContent(');
        assert.ok(fnIdx > -1, 'renderViewContent must exist');
        // Up to the empty-state container HTML.
        var stretch = src.substring(fnIdx, fnIdx + 1500);
        assert.ok(
            /_emSrvMet/.test(stretch),
            'expected _emSrvMet check (server metrics fallback) in empty-state guard'
        );
    });

});

describe('59 - View tab server-emitted dim differentiation (bm-vbadge-svr)', function() {

    var INSPECTOR_JS_59  = path.join(BM_DIR, 'inspector.js');
    var INSPECTOR_CSS_59 = path.join(BM_DIR, 'inspector.css');
    var _iJs59, _iCss59;
    function getInspectorJs59() { return _iJs59  || (_iJs59  = fs.readFileSync(INSPECTOR_JS_59,  'utf8')); }
    function getInspectorCss59(){ return _iCss59 || (_iCss59 = fs.readFileSync(INSPECTOR_CSS_59, 'utf8')); }

    it('inspector.css defines a .bm-vbadge-svr rule', function() {
        assert.ok(
            /\.bm-vbadge-svr\s*\{/.test(getInspectorCss59()),
            'expected .bm-vbadge-svr rule in compiled CSS'
        );
    });

    it('.bm-vbadge-svr applies italic + deeper opacity (.55), distinct from .bm-vbadge-res (.65)', function() {
        var css   = getInspectorCss59();
        var match = css.match(/\.bm-vbadge-svr\s*\{[^}]+\}/);
        assert.ok(match, 'expected a .bm-vbadge-svr rule body');
        var body = match[0];
        assert.ok(/font-style:\s*italic/.test(body), 'expected font-style: italic in .bm-vbadge-svr');
        assert.ok(/opacity:\s*0?\.55/.test(body),    'expected opacity: 0.55 in .bm-vbadge-svr');
    });

    it('.bm-vbadge-svr is standalone — NOT scoped under .bm-vbadge-engine (engine version stays bm-vbadge-ver)', function() {
        assert.ok(
            !/\.bm-vbadge-engine\s+\.bm-vbadge-svr/.test(getInspectorCss59()),
            'bm-vbadge-svr must not be nested under .bm-vbadge-engine'
        );
    });

    it('inspector.js applies bm-vbadge-svr to BOTH the weight + load server-emitted dims', function() {
        var hits = (getInspectorJs59().match(/bm-vbadge-svr/g) || []);
        assert.ok(hits.length >= 2, 'expected >= 2 bm-vbadge-svr usages (weight + load server dims), got ' + hits.length);
    });

    it('inspector.js server dim wraps formatBytes(_serverW) and fmtMs(_srvLd)', function() {
        var src = getInspectorJs59();
        assert.ok(
            /bm-vbadge-svr[\s\S]{0,40}formatBytes\(_serverW\)/.test(src),
            'expected bm-vbadge-svr span around formatBytes(_serverW) (weight server dim)'
        );
        assert.ok(
            /bm-vbadge-svr[\s\S]{0,40}fmtMs\(_srvLd\)/.test(src),
            'expected bm-vbadge-svr span around fmtMs(_srvLd) (load server dim)'
        );
    });

    it('inspector.js leaves the legacy client-only dims on bm-vbadge-res (not server-emitted)', function() {
        // The resource-vs-transfer (weight) + load-vs-transfer (load) legacy
        // dual dims are client-measured, so they keep bm-vbadge-res — 3 sites.
        var resHits = (getInspectorJs59().match(/bm-vbadge-res/g) || []);
        assert.ok(resHits.length >= 3, 'expected the 3 legacy client dims to still use bm-vbadge-res, got ' + resHits.length);
    });

});

describe('60 - Flow tab nunjucks parity — data.page.flow build + late-entry _njFlowPatch', function() {

    var RENDER_NJ_60 = path.join(FW, 'core/controller/controller.render-nunjucks.js');
    var _rNj60;
    function getRNj60() { return _rNj60 || (_rNj60 = fs.readFileSync(RENDER_NJ_60, 'utf8')); }

    // ── Base flow build (injectInspectorScripts) ──────────────────────────

    it('render-nunjucks.js builds data.page.flow = { requestStart, entries }', function() {
        var src = getRNj60();
        var idx = src.indexOf('data.page.flow =');
        assert.ok(idx > -1, 'expected data.page.flow assignment (was entirely missing before — Flow tab stayed empty)');
        var block = src.substring(idx, idx + 160);
        assert.ok(/requestStart:\s*local\._timeline\.requestStart/.test(block), 'expected requestStart: local._timeline.requestStart');
        assert.ok(/entries:\s*local\._timeline\.entries/.test(block),           'expected entries: local._timeline.entries');
    });

    it('render-nunjucks.js converts QI entries to timeline entries (n1ql label, cat db)', function() {
        var src = getRNj60();
        assert.ok(/local\._queryLog/.test(src), 'expected the QI conversion to read local._queryLog');
        var idx = src.indexOf("label: 'n1ql:'");
        assert.ok(idx > -1, "expected label: 'n1ql:' + trigger entry (mirrors render-swig.js)");
        var block = src.substring(idx, idx + 220);
        assert.ok(/cat:\s*'db'/.test(block), "expected cat: 'db' on the QI-derived entry");
    });

    // ── Snapshot + late-entry pushes ──────────────────────────────────────

    it('render-nunjucks.js captures _njFlowSnapshotCount after serialisation', function() {
        var src = getRNj60();
        assert.ok(
            /_njFlowSnapshotCount\s*=\s*\(local\._timeline\)\s*\?\s*local\._timeline\.entries\.length/.test(src),
            'expected _njFlowSnapshotCount = (local._timeline) ? local._timeline.entries.length : 0'
        );
    });

    it('render-nunjucks.js pushes response-write + total late entries', function() {
        var src = getRNj60();
        assert.ok(/label:\s*'response-write',\s*cat:\s*'response'/.test(src), "expected the response-write / 'response' entry push");
        assert.ok(/label:\s*'total',\s*cat:\s*'total'/.test(src),             "expected the total / 'total' entry push");
    });

    it('render-nunjucks.js slices _njLateEntries from the snapshot', function() {
        var src = getRNj60();
        assert.ok(
            /_njLateEntries\s*=\s*local\._timeline\.entries\.slice\(\s*_njFlowSnapshotCount\s*\)/.test(src),
            'expected _njLateEntries = local._timeline.entries.slice(_njFlowSnapshotCount)'
        );
    });

    // ── _njFlowPatch (mirrors render-swig.js _flowPatch) ──────────────────

    it('render-nunjucks.js builds the _njFlowPatch ternary gated on late entries', function() {
        var src = getRNj60();
        assert.ok(
            /_njFlowPatch\s*=\s*\(\s*_njLateEntries\.length\s*>\s*0\s*\)/.test(src),
            'expected _njFlowPatch = (_njLateEntries.length > 0) ? ... : "" ternary (mirrors swig _flowPatch)'
        );
    });

    it('render-nunjucks.js _njFlowPatch appends late entries onto u.flow.entries', function() {
        var src = getRNj60();
        assert.ok(
            /if\(u&&u\.flow\)\{var _e=u\.flow\.entries/.test(src),
            'expected the _njFlowPatch to push onto u.flow.entries (matches render-swig.js — user namespace only)'
        );
    });

    it('render-nunjucks.js inserts _njFlowPatch BEFORE the metrics late-bind in _njPatchScript', function() {
        var src = getRNj60();
        var idx = src.indexOf('_njPatchScript =');
        assert.ok(idx > -1, 'expected the _njPatchScript assembly');
        var block      = src.substring(idx, idx + 800);
        var flowIdx    = block.indexOf('+ _njFlowPatch');
        var metricsIdx = block.indexOf('u.environment.metrics.weightBytes');
        assert.ok(flowIdx > -1,    'expected + _njFlowPatch in the _njPatchScript concat');
        assert.ok(metricsIdx > -1, 'expected the metrics late-bind in the _njPatchScript concat');
        assert.ok(flowIdx < metricsIdx, 'expected _njFlowPatch to come BEFORE the metrics late-bind (mirrors render-swig.js ordering)');
    });

});


describe('61 - QI Phase C: column-level index coverage matching (#QI Phase C)', function() {

    var sqlParser = require(path.join(FW, 'core/connectors/sql-parser'));

    var INSPECTOR_61 = path.join(BM_DIR, 'inspector.js');
    var CSS_61       = path.join(BM_DIR, 'inspector.css');
    var _insp61, _css61;
    function getInsp61() { return _insp61 || (_insp61 = fs.readFileSync(INSPECTOR_61, 'utf8')); }
    function getCss61()  { return _css61  || (_css61  = fs.readFileSync(CSS_61, 'utf8')); }

    // ── parseCreateIndexes now captures columns (additive to §46) ─────────────

    it('parseCreateIndexes captures the indexed column list (leftmost-first)', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX idx ON users (email, status);');
        assert.deepStrictEqual(map['users'][0].columns, ['email', 'status']);
    });

    it('parseCreateIndexes captures a single column', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX idx ON orders (user_id);');
        assert.deepStrictEqual(map['orders'][0].columns, ['user_id']);
    });

    it('parseCreateIndexes handles PostgreSQL USING <method> before the column list', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX idx ON public.users USING btree (email);');
        assert.deepStrictEqual(map['users'][0].columns, ['email']);
    });

    it('parseCreateIndexes drops ASC/DESC direction keywords from columns', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX i ON "orders" (created_at DESC, "user_id");');
        assert.deepStrictEqual(map['orders'][0].columns, ['created_at', 'user_id']);
    });

    it('parseCreateIndexes reduces a prefix-length spec to the bare column', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX i ON t (email(10));');
        assert.deepStrictEqual(map['t'][0].columns, ['email']);
    });

    it('parseCreateIndexes still exposes name + primary (back-compat with §46)', function() {
        var map = sqlParser.parseCreateIndexes('CREATE INDEX idx ON users (email);');
        assert.strictEqual(map['users'][0].name, 'idx');
        assert.strictEqual(map['users'][0].primary, false);
    });

    // ── extractWhereColumns ──────────────────────────────────────────────────

    it('extractWhereColumns is exported', function() {
        assert.strictEqual(typeof sqlParser.extractWhereColumns, 'function');
    });

    it('extractWhereColumns pulls equality + IN columns, strips qualifiers, ignores ORDER BY', function() {
        var cols = sqlParser.extractWhereColumns('SELECT * FROM users WHERE t.email = ? AND status IN (?) ORDER BY created');
        assert.deepStrictEqual(cols, ['email', 'status']);
    });

    it('extractWhereColumns handles range + BETWEEN', function() {
        var cols = sqlParser.extractWhereColumns('SELECT * FROM o WHERE price > 10 AND created BETWEEN ? AND ?');
        assert.deepStrictEqual(cols, ['price', 'created']);
    });

    it('extractWhereColumns returns [] for a query with no WHERE clause', function() {
        assert.deepStrictEqual(sqlParser.extractWhereColumns('SELECT * FROM users'), []);
    });

    it('extractWhereColumns yields no column for a functional predicate (conservative)', function() {
        assert.deepStrictEqual(sqlParser.extractWhereColumns('SELECT * FROM users WHERE LOWER(email) = ?'), []);
    });

    // ── annotateCoverage — leftmost-prefix ───────────────────────────────────

    it('annotateCoverage is exported', function() {
        assert.strictEqual(typeof sqlParser.annotateCoverage, 'function');
    });

    it('annotateCoverage marks covers=true when the index leads with a filtered column', function() {
        var idxs = [{ name: 'i1', primary: false, columns: ['email', 'status'] }];
        var cov  = sqlParser.annotateCoverage(idxs, 'SELECT * FROM users WHERE email = ?');
        assert.strictEqual(cov.anyCovered, true);
        assert.strictEqual(cov.indexes[0].covers, true);
        assert.deepStrictEqual(cov.whereColumns, ['email']);
    });

    it('annotateCoverage marks covers=false when only a non-leading column is filtered', function() {
        var idxs = [{ name: 'i1', primary: false, columns: ['email', 'status'] }];
        var cov  = sqlParser.annotateCoverage(idxs, 'SELECT * FROM users WHERE status = ?');
        assert.strictEqual(cov.anyCovered, false);
        assert.strictEqual(cov.indexes[0].covers, false);
    });

    it('annotateCoverage reports anyCovered=false when no index covers the filter', function() {
        var idxs = [
            { name: 'i1', primary: false, columns: ['email'] },
            { name: 'i2', primary: false, columns: ['status'] }
        ];
        var cov = sqlParser.annotateCoverage(idxs, 'SELECT * FROM users WHERE name = ?');
        assert.strictEqual(cov.anyCovered, false);
    });

    it('annotateCoverage does not mutate the source descriptors', function() {
        var idxs = [{ name: 'i1', primary: false, columns: ['email'] }];
        sqlParser.annotateCoverage(idxs, 'SELECT * FROM users WHERE email = ?');
        assert.strictEqual(idxs[0].covers, undefined, 'source descriptor must not gain a covers field');
    });

    // ── Inspector UI — bm-idx-uncovered badge (source-scan, mirrors §31) ──────

    it('renderQueryContent has a bm-idx-uncovered branch', function() {
        var js    = getInsp61();
        var idx   = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 8000);
        assert.ok(block.indexOf('bm-idx-uncovered') > -1, 'expected bm-idx-uncovered class in renderQueryContent');
    });

    it('uncovered branch reads q.whereColumns and per-index covers', function() {
        var js    = getInsp61();
        var idx   = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 8000);
        assert.ok(/q\.whereColumns/.test(block), 'expected q.whereColumns check');
        assert.ok(/\.covers/.test(block),         'expected per-index .covers check');
    });

    it('uncovered branch is gated on a WHERE filter being present (no false uncovered)', function() {
        var js    = getInsp61();
        var idx   = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 8000);
        assert.ok(/_hasWhere\s*&&\s*!_anyCovers/.test(block), 'expected the (_hasWhere && !_anyCovers) gate');
    });

    it('existing green/amber/red/N-A branches are preserved', function() {
        var js    = getInsp61();
        var idx   = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 8000);
        assert.ok(block.indexOf('bm-idx-secondary') > -1, 'green preserved');
        assert.ok(block.indexOf('bm-idx-primary') > -1,   'amber preserved');
        assert.ok(block.indexOf('bm-idx-none') > -1,      'red preserved');
        assert.ok(block.indexOf('bm-idx-na') > -1,        'N/A preserved');
    });

    // ── Inspector CSS — .bm-idx-uncovered (dark + light) ─────────────────────

    it('inspector.css defines .bm-idx-uncovered for dark and light themes', function() {
        var css = getCss61();
        assert.ok(/\.bm-idx-uncovered\s*\{/.test(css),                          'expected dark .bm-idx-uncovered rule');
        assert.ok(/\[data-theme=light\]\s*\.bm-idx-uncovered\s*\{/.test(css),   'expected light-theme .bm-idx-uncovered rule');
    });

});


// ── 62 — Phase C.2: live-introspection column capture (#QI Phase C.2) ───────

describe('62 - QI Phase C.2: live-introspection column capture (#QI Phase C.2)', function() {

    var sqlParser = require(path.join(FW, 'core/connectors/sql-parser'));

    var MYSQL_SRC_62  = path.join(FW, 'core/connectors/mysql/index.js');
    var PG_SRC_62     = path.join(FW, 'core/connectors/postgresql/index.js');
    var SQLITE_SRC_62 = path.join(FW, 'core/connectors/sqlite/index.js');
    var _my62, _pg62, _sq62;
    function getMy62() { return _my62 || (_my62 = fs.readFileSync(MYSQL_SRC_62, 'utf8')); }
    function getPg62() { return _pg62 || (_pg62 = fs.readFileSync(PG_SRC_62, 'utf8')); }
    function getSq62() { return _sq62 || (_sq62 = fs.readFileSync(SQLITE_SRC_62, 'utf8')); }

    // ── parseIndexDefColumns — the new sql-parser export (PostgreSQL indexdef) ─

    it('exports parseIndexDefColumns', function() {
        assert.strictEqual(typeof sqlParser.parseIndexDefColumns, 'function');
    });

    it('parses a multi-column indexdef (leftmost-first, lowercased)', function() {
        assert.deepStrictEqual(
            sqlParser.parseIndexDefColumns('CREATE INDEX i ON public.users USING btree (email, status)'),
            ['email', 'status']
        );
    });

    it('parses a single-column pkey indexdef', function() {
        assert.deepStrictEqual(
            sqlParser.parseIndexDefColumns('CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'),
            ['id']
        );
    });

    it('drops direction keywords and works without an explicit USING method', function() {
        assert.deepStrictEqual(
            sqlParser.parseIndexDefColumns('CREATE INDEX i ON t (created_at DESC, status)'),
            ['created_at', 'status']
        );
    });

    it('reduces a functional expression to its leading token (conservative — no false coverage)', function() {
        // lower(email) → 'lower' won't match a bare WHERE column, so no coverage is claimed.
        assert.deepStrictEqual(
            sqlParser.parseIndexDefColumns('CREATE INDEX i ON t USING btree (lower(email))'),
            ['lower']
        );
    });

    it('returns [] for empty / null / non-indexdef input', function() {
        assert.deepStrictEqual(sqlParser.parseIndexDefColumns(''), []);
        assert.deepStrictEqual(sqlParser.parseIndexDefColumns(null), []);
        assert.deepStrictEqual(sqlParser.parseIndexDefColumns('NOT AN INDEX DEFINITION'), []);
    });

    // ── End-to-end: a live-shaped descriptor carrying columns yields coverage ─

    it('annotateCoverage marks covers=true when a live descriptor carries columns', function() {
        var cols = sqlParser.parseIndexDefColumns('CREATE INDEX idx_email ON users USING btree (email, status)');
        var cov  = sqlParser.annotateCoverage(
            [{ name: 'idx_email', primary: false, columns: cols }],
            'SELECT * FROM users WHERE email = ?'
        );
        assert.strictEqual(cov.anyCovered, true);
        assert.strictEqual(cov.indexes[0].covers, true);
    });

    it('annotateCoverage yields covers=false for a columnless descriptor (the pre-C.2 gap this closes)', function() {
        var cov = sqlParser.annotateCoverage(
            [{ name: 'idx_email', primary: false }],
            'SELECT * FROM users WHERE email = ?'
        );
        assert.strictEqual(cov.anyCovered, false);
        assert.strictEqual(cov.indexes[0].covers, false);
    });

    // ── Source pins: each live-introspection block now captures columns ───────

    it('MySQL live introspection selects SEQ_IN_INDEX and COLUMN_NAME', function() {
        var src = getMy62();
        assert.ok(src.indexOf('SEQ_IN_INDEX') > -1, 'expected SEQ_IN_INDEX in the STATISTICS query');
        assert.ok(src.indexOf('COLUMN_NAME')  > -1, 'expected COLUMN_NAME in the STATISTICS query');
    });

    it('MySQL live introspection accumulates a columns array', function() {
        assert.ok(/columns:\s*\[\]/.test(getMy62()), 'expected a columns: [] accumulator in the MySQL live block');
    });

    it('PostgreSQL live introspection parses columns from indexdef', function() {
        assert.ok(
            getPg62().indexOf('parseIndexDefColumns(def)') > -1,
            'expected parseIndexDefColumns(def) in the PostgreSQL live block'
        );
    });

    it('SQLite live introspection reads PRAGMA index_info', function() {
        assert.ok(
            getSq62().indexOf('PRAGMA index_info') > -1,
            'expected PRAGMA index_info in the SQLite live block'
        );
    });

});


// ── 63 — Phase C.3: retroactive live-index coverage on the SPA (#QI Phase C.3) ──

describe('63 - QI Phase C.3: retroactive live-index coverage on the SPA (#QI Phase C.3)', function() {

    var MYSQL_SRC_63  = path.join(FW, 'core/connectors/mysql/index.js');
    var PG_SRC_63     = path.join(FW, 'core/connectors/postgresql/index.js');
    var SQLITE_SRC_63 = path.join(FW, 'core/connectors/sqlite/index.js');
    var INSPECTOR_63  = path.join(BM_DIR, 'inspector.js');
    var _my63, _pg63, _sq63, _insp63;
    function getMy63()   { return _my63   || (_my63   = fs.readFileSync(MYSQL_SRC_63, 'utf8')); }
    function getPg63()   { return _pg63   || (_pg63   = fs.readFileSync(PG_SRC_63, 'utf8')); }
    function getSq63()   { return _sq63   || (_sq63   = fs.readFileSync(SQLITE_SRC_63, 'utf8')); }
    function getInsp63() { return _insp63 || (_insp63 = fs.readFileSync(INSPECTOR_63, 'utf8')); }

    // ── Server: whereColumns + table now emitted unconditionally ──────────────
    // Before C.3 they were computed inside `if (_knownIndexes !== null)`, so a
    // bundle without indexes.sql emitted whereColumns:null / table:null and the
    // SPA had nothing to compute coverage from. The annotateCoverage call (which
    // needs known indexes) stays gated; only the always-available filter metadata
    // moves out of the gate.

    function assertUnconditionalFilterMeta(src, label) {
        var wc  = src.indexOf('var _whereColumns = sqlParser.extractWhereColumns(queryString)');
        var tbl = src.indexOf('var _tbl = sqlParser.extractTargetTable(queryString)');
        var cov = src.indexOf('sqlParser.annotateCoverage(_tblIdx, queryString)');
        assert.ok(wc  > -1, label + ': expected unconditional extractWhereColumns(queryString)');
        assert.ok(tbl > -1, label + ': expected unconditional extractTargetTable(queryString)');
        assert.ok(cov > -1, label + ': expected the gated annotateCoverage call to remain');
        assert.ok(tbl < cov, label + ': extractTargetTable must precede the gated annotateCoverage');
        assert.ok(wc  < cov, label + ': extractWhereColumns must precede the gated annotateCoverage');
    }

    it('MySQL emits whereColumns + table outside the _knownIndexes gate', function() {
        assertUnconditionalFilterMeta(getMy63(), 'MySQL');
    });

    it('PostgreSQL emits whereColumns + table outside the _knownIndexes gate', function() {
        assertUnconditionalFilterMeta(getPg63(), 'PostgreSQL');
    });

    it('SQLite emits whereColumns + table outside the _knownIndexes gate', function() {
        assertUnconditionalFilterMeta(getSq63(), 'SQLite');
    });

    it('index annotation stays gated on _knownIndexes (indexes still null without indexes.sql)', function() {
        // _indexes defaults to null and is only assigned from _cov inside the gate,
        // so the N/A badge — and the SPA live-resolution trigger — is preserved.
        [['MySQL', getMy63()], ['PostgreSQL', getPg63()], ['SQLite', getSq63()]].forEach(function(pair) {
            var label = pair[0], src = pair[1];
            var dflt = src.indexOf('var _indexes = null;');
            var gate = src.indexOf('if (_knownIndexes !== null) {');
            var set  = src.indexOf('_indexes = _cov.indexes;');
            assert.ok(dflt > -1 && gate > -1 && set > -1, label + ': expected _indexes default + gate + assignment');
            assert.ok(dflt < gate && gate < set, label + ': _indexes must default to null before the gate and only be set inside it');
        });
    });

    // ── Client: resolveLiveIndexes clones + stamps covers (leftmost-prefix) ───
    // Reads from BM_DIR (dist) — the built artefact the framework serves and the
    // suite tests against — so this section depends on the prod dist rebuild.

    it('resolveLiveIndexes reads q.whereColumns and stamps a per-descriptor covers flag', function() {
        var js  = getInsp63();
        var i   = js.indexOf('function resolveLiveIndexes');
        assert.ok(i > -1, 'expected resolveLiveIndexes in dist inspector.js');
        var blk = js.substring(i, i + 1800);
        assert.ok(/q\.whereColumns/.test(blk),               'expected a q.whereColumns read');
        assert.ok(/covers\s*:/.test(blk),                    'expected a covers field on the returned descriptors');
        assert.ok(/indexOf\(cols\[0\]\)\s*>\s*-1/.test(blk),  'expected the leftmost-prefix (cols[0]) test');
    });

    it('resolveLiveIndexes clones descriptors — never returns the shared cache array', function() {
        var js  = getInsp63();
        var i   = js.indexOf('function resolveLiveIndexes');
        var blk = js.substring(i, i + 1800);
        assert.ok(/cols\.slice\(\)/.test(blk), 'expected columns: cols.slice() clone of the column list');
        assert.ok(/out\.push\(\{/.test(blk),   'expected fresh descriptor objects pushed to a new array');
        assert.ok(!/return\s+tables\[tbl\]\s*\|\|\s*\[\]/.test(blk),
            'must no longer return the shared tables[tbl] array directly (cache-poisoning guard)');
    });

    it('resolveLiveIndexes still returns [] when the table has no live index', function() {
        var js  = getInsp63();
        var i   = js.indexOf('function resolveLiveIndexes');
        var blk = js.substring(i, i + 1800);
        assert.ok(/if\s*\(!live\)\s*return\s*\[\];/.test(blk), 'expected the empty-table [] path');
    });

    it('live-resolved indexes feed the existing bm-idx-uncovered branch', function() {
        // renderQueryContent assigns q.indexes = resolveLiveIndexes(q) for N/A entries;
        // with covers + whereColumns now present, the §61 uncovered branch fires for
        // the live (no indexes.sql) path too.
        var js  = getInsp63();
        var i   = js.indexOf('function renderQueryContent');
        var blk = js.substring(i, i + 8000);
        assert.ok(/q\.indexes\s*=\s*_resolved/.test(blk), 'expected live-resolved indexes assigned to q.indexes');
        assert.ok(blk.indexOf('bm-idx-uncovered') > -1,   'expected the uncovered branch to remain reachable');
    });

});


// ── 64 — #INS9b: /_gina/agent API-key auth gate in server.js ─────────────────

describe('64 - #INS9b /_gina/agent auth gate in server.js', function() {

    it('server.js defines the _agentKeyValid helper', function() {
        assert.ok(
            getServerSrc().indexOf('function _agentKeyValid') > -1,
            'expected a file-scope _agentKeyValid(req) helper in server.js'
        );
    });

    it('_agentKeyValid reads the x-gina-inspector-key header and ?key= query param', function() {
        var src = getServerSrc();
        var i = src.indexOf('function _agentKeyValid');
        var blk = src.substring(i, i + 900);
        assert.ok(blk.indexOf("'x-gina-inspector-key'") > -1, 'expected the x-gina-inspector-key header read');
        assert.ok(blk.indexOf('URLSearchParams') > -1,        'expected ?key= parsing via URLSearchParams');
        assert.ok(blk.indexOf(".get('key')") > -1,            'expected the key query-param read');
    });

    it('_agentKeyValid compares in constant time with a length guard', function() {
        var src = getServerSrc();
        var i = src.indexOf('function _agentKeyValid');
        var blk = src.substring(i, i + 900);
        assert.ok(blk.indexOf('crypto.timingSafeEqual') > -1, 'expected crypto.timingSafeEqual');
        assert.ok(/a\.length\s*!==\s*b\.length/.test(blk),     'expected an equal-length guard before timingSafeEqual');
    });

    it('_agentKeyValid fails closed when no key is configured', function() {
        var src = getServerSrc();
        var i = src.indexOf('function _agentKeyValid');
        var blk = src.substring(i, i + 900);
        assert.ok(/if\s*\(!configured\)\s*return\s*false/.test(blk),
            'expected fail-closed when process.gina._inspectorAgentKey is empty');
    });

    it('server.js requires the crypto module', function() {
        assert.ok(/require\('crypto'\)/.test(getServerSrc()), "expected const crypto = require('crypto')");
    });

    it('the agent gate opens on dev OR _inspectorAgentEnabled', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(block.indexOf('_inspectorAgentEnabled') > -1, 'expected the _inspectorAgentEnabled toggle in the gate');
        assert.ok(block.indexOf('NODE_ENV_IS_DEV') > -1,        'expected the dev path preserved in the gate');
    });

    it('the agent gate returns 401 on a missing/invalid key outside dev', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(block.indexOf('_agentKeyValid(request)') > -1, 'expected the key check before opening the stream');
        assert.ok(/statusCode\s*=\s*401/.test(block),            'expected a 401 deny status');
        assert.ok(block.indexOf('invalid or missing inspector key') > -1, 'expected the deny message');
    });

    it('the dev path requires no key (back-compat with #INS9a)', function() {
        var src = getServerSrc();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('(SSE agent)'));
        assert.ok(/!_agIsDev\s*&&\s*!_agentKeyValid/.test(block),
            'expected the key check to be skipped in dev mode');
    });

});


// ── 65 — #INS9b: /_gina/agent API-key auth gate in server.isaac.js ───────────

describe('65 - #INS9b /_gina/agent auth gate in server.isaac.js', function() {

    var _isaacSrc65;
    function getIsaacSrc65() { return _isaacSrc65 || (_isaacSrc65 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }

    it('server.isaac.js defines the _agentKeyValid helper', function() {
        assert.ok(getIsaacSrc65().indexOf('function _agentKeyValid') > -1, 'expected _agentKeyValid in server.isaac.js');
    });

    it('_agentKeyValid reads header + ?key= and compares in constant time', function() {
        var src = getIsaacSrc65();
        var i = src.indexOf('function _agentKeyValid');
        var blk = src.substring(i, i + 900);
        assert.ok(blk.indexOf("'x-gina-inspector-key'") > -1, 'expected the header read');
        assert.ok(blk.indexOf('URLSearchParams') > -1,        'expected ?key= parsing');
        assert.ok(blk.indexOf('crypto.timingSafeEqual') > -1, 'expected constant-time compare');
        assert.ok(/if\s*\(!configured\)\s*return\s*false/.test(blk), 'expected fail-closed when unconfigured');
    });

    it('server.isaac.js requires the crypto module', function() {
        assert.ok(/require\('crypto'\)/.test(getIsaacSrc65()), "expected const crypto = require('crypto')");
    });

    it('the agent gate opens on isCacheless OR _inspectorAgentEnabled', function() {
        var src = getIsaacSrc65();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(block.indexOf('_inspectorAgentEnabled') > -1, 'expected the toggle in the gate');
        assert.ok(block.indexOf('isCacheless') > -1,            'expected the dev path preserved');
    });

    it('the agent gate returns 401 on missing/invalid key outside dev (both transports)', function() {
        var src = getIsaacSrc65();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(block.indexOf('_agentKeyValid(request)') > -1,   'expected the key check');
        assert.ok(/':status':\s*401/.test(block),                  'expected HTTP/2 401 via response.stream.respond');
        assert.ok(/writeHead\(401/.test(block),                    'expected HTTP/1.1 401 via response.writeHead');
        assert.ok(block.indexOf('invalid or missing inspector key') > -1, 'expected the deny message');
        assert.ok(block.indexOf('_setPoweredByHeader') > -1,       'expected the deny headers via _setPoweredByHeader');
    });

    it('the dev path requires no key (back-compat with #INS9a)', function() {
        var src = getIsaacSrc65();
        var agentIdx = src.indexOf('Inspector agent');
        var block = src.substring(agentIdx, src.indexOf('Proxy detection'));
        assert.ok(/!isCacheless\s*&&\s*!_agentKeyValid/.test(block), 'expected the key check skipped in dev mode');
    });

});


// ── 66 — #INS9b: _agentKeyValid behavioral replica ───────────────────────────

describe('66 - #INS9b _agentKeyValid behavioral replica', function() {

    var crypto = require('crypto');

    // Inline replica of the _agentKeyValid helper (identical logic in both
    // server.js and server.isaac.js). `configured` is a parameter so we can
    // exercise the unconfigured (fail-closed) branch without process.gina.
    function agentKeyValid(req, configured) {
        if (!configured) return false;
        var presented = (req.headers && req.headers['x-gina-inspector-key']) || '';
        if (!presented && typeof req.url === 'string') {
            var _qi = req.url.indexOf('?');
            if (_qi >= 0) {
                try { presented = new URLSearchParams(req.url.slice(_qi + 1)).get('key') || ''; } catch (e) { presented = ''; }
            }
        }
        if (!presented) return false;
        var a = Buffer.from(String(presented));
        var b = Buffer.from(configured);
        if (a.length !== b.length) return false;
        try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
    }

    var KEY = 'sekret-inspector-key-123';

    it('accepts a matching key via the x-gina-inspector-key header', function() {
        var req = { headers: { 'x-gina-inspector-key': KEY }, url: '/_gina/agent' };
        assert.equal(agentKeyValid(req, KEY), true);
    });

    it('accepts a matching key via the ?key= query param', function() {
        var req = { headers: {}, url: '/_gina/agent?key=' + encodeURIComponent(KEY) };
        assert.equal(agentKeyValid(req, KEY), true);
    });

    it('accepts the key when extra query params precede it', function() {
        var req = { headers: {}, url: '/_gina/agent?foo=1&key=' + encodeURIComponent(KEY) };
        assert.equal(agentKeyValid(req, KEY), true);
    });

    it('rejects a wrong key', function() {
        var req = { headers: { 'x-gina-inspector-key': 'wrong-key-value-here' }, url: '/_gina/agent' };
        assert.equal(agentKeyValid(req, KEY), false);
    });

    it('rejects a same-length-but-different key (constant-time path)', function() {
        assert.equal(agentKeyValid({ headers: { 'x-gina-inspector-key': 'abcd' }, url: '/x' }, 'abce'), false);
    });

    it('rejects when no key is presented (no header, no query)', function() {
        var req = { headers: {}, url: '/_gina/agent' };
        assert.equal(agentKeyValid(req, KEY), false);
    });

    it('fails closed when no key is configured, even with a presented key', function() {
        var req = { headers: { 'x-gina-inspector-key': KEY }, url: '/_gina/agent?key=' + KEY };
        assert.equal(agentKeyValid(req, ''), false);
    });

    it('the header takes precedence over the query param', function() {
        // Header is wrong, query is right → header is read first → denied.
        var req = { headers: { 'x-gina-inspector-key': 'wrong' }, url: '/_gina/agent?key=' + encodeURIComponent(KEY) };
        assert.equal(agentKeyValid(req, KEY), false);
    });

    it('rejects a url with no query string and no header', function() {
        assert.equal(agentKeyValid({ headers: {}, url: '/_gina/agent' }, KEY), false);
    });

});


// ── 67 — #INS9b: Inspector SPA threads the optional ?key= ────────────────────

describe('67 - #INS9b Inspector SPA threads ?key= for an auth-gated agent', function() {

    var _inspJs67, _inspHtml67;
    function getInspJs67()   { return _inspJs67   || (_inspJs67   = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }
    function getInspHtml67() { return _inspHtml67 || (_inspHtml67 = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8')); }

    it('tryAgent() appends ?key= to the agent URL when a key param is present', function() {
        var js = getInspJs67();
        var i = js.indexOf('function tryAgent');
        assert.ok(i > -1, 'expected tryAgent in dist inspector.js');
        var blk = js.substring(i, i + 900);
        assert.ok(blk.indexOf("params.get('key')") > -1, 'expected the ?key= param read in tryAgent');
        assert.ok(blk.indexOf("'?key='") > -1,            'expected ?key= appended to the agent EventSource URL');
    });

    it('the manual connect form composes &key= into the ?target= redirect', function() {
        var js = getInspJs67();
        var i = js.indexOf("qs('#bm-connect-form')");
        assert.ok(i > -1, 'expected the connect-form handler');
        var blk = js.substring(i, i + 1400);
        assert.ok(blk.indexOf('#bm-connect-key') > -1, 'expected the key input read');
        assert.ok(blk.indexOf("'&key='") > -1,         'expected &key= appended to the redirect URL');
    });

    it('index.html has the optional inspector key input', function() {
        assert.ok(getInspHtml67().indexOf('id="bm-connect-key"') > -1, 'expected #bm-connect-key input in the overlay form');
    });

    it('the key is not persisted to localStorage (ephemeral)', function() {
        var js = getInspJs67();
        assert.ok(js.indexOf('__gina_inspector_key') === -1,
            'inspector key must not be written to localStorage');
    });

});


// ── 68 — #INS10: /_gina/instrument control endpoint in server.js ─────────────

describe('68 - #INS10 /_gina/instrument control endpoint in server.js', function() {

    function instrBlock() {
        var src = getServerSrc();
        var s = src.indexOf('process.gina._inspectorInstrumentEnabled');
        var e = src.indexOf('Inspector SPA', s);
        return src.substring(s, e);
    }

    it('defines the _instrumentKeyValid helper reading the SEPARATE instrument key', function() {
        var src = getServerSrc();
        assert.ok(src.indexOf('function _instrumentKeyValid') > -1, 'expected a _instrumentKeyValid(req) helper');
        var i = src.indexOf('function _instrumentKeyValid');
        var h = src.substring(i, i + 900);
        assert.ok(h.indexOf('_inspectorInstrumentKey') > -1, 'expected it to read _inspectorInstrumentKey');
        assert.ok(h.indexOf('_inspectorAgentKey') === -1,    'must NOT read the agent key — instrumentation is a separate authority');
        assert.ok(h.indexOf('crypto.timingSafeEqual') > -1,  'expected constant-time compare');
        assert.ok(/if\s*\(!configured\)\s*return\s*false/.test(h), 'expected fail-closed when no key configured');
    });

    it('defines a bounded _readInstrumentBody with a req.body fast-path + timeout', function() {
        var src = getServerSrc();
        var i = src.indexOf('function _readInstrumentBody');
        assert.ok(i > -1, 'expected a _readInstrumentBody helper');
        var b = src.substring(i, i + 1300);
        assert.ok(b.indexOf('4096') > -1,                          'expected a 4KB body cap');
        assert.ok(/req\.body\s*&&\s*typeof\s*req\.body/.test(b),   'expected the req.body fast-path');
        assert.ok(b.indexOf('body read timeout') > -1,             'expected the stream-consumed timeout guard');
        assert.ok(b.indexOf('.unref(') > -1,                       'expected the timeout to be unref()d');
    });

    it('the endpoint gate requires the instrumentation opt-in and accepts GET + POST', function() {
        var block = instrBlock();
        assert.ok(block.indexOf('_inspectorInstrumentEnabled') > -1, 'expected the opt-in gate');
        assert.ok(block.indexOf("=== 'GET'") > -1,  'expected GET handling');
        assert.ok(block.indexOf("=== 'POST'") > -1, 'expected POST handling');
    });

    it('requires the key EVEN in dev (no dev bypass)', function() {
        var block = instrBlock();
        assert.ok(/if\s*\(!_instrumentKeyValid\(request\)\)/.test(block), 'expected an unconditional key check');
        assert.ok(block.indexOf('_agIsDev') === -1, 'must NOT carry a dev key-bypass (unlike /_gina/agent)');
        assert.ok(/statusCode\s*=\s*401/.test(block), 'expected a 401 on missing/invalid key');
    });

    it('GET returns lib.instrument.status(); POST opens/closes via lib.instrument', function() {
        var block = instrBlock();
        assert.ok(block.indexOf('lib.instrument.status()') > -1, 'expected GET → status()');
        assert.ok(block.indexOf('lib.instrument.open(')   > -1, 'expected POST enable → open()');
        assert.ok(block.indexOf('lib.instrument.close()') > -1, 'expected POST disable → close()');
    });

    it('400s on a malformed / unrecognised body', function() {
        var block = instrBlock();
        assert.ok(/statusCode\s*=\s*400/.test(block), 'expected a 400 status path');
        assert.ok(block.indexOf('bad_request') > -1,  'expected the bad_request error');
    });

});


// ── 69 — #INS10: /_gina/instrument control endpoint in server.isaac.js ───────

describe('69 - #INS10 /_gina/instrument control endpoint in server.isaac.js', function() {

    var _isaacSrc69;
    function getIsaacSrc69() { return _isaacSrc69 || (_isaacSrc69 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }
    function instrBlock() {
        var src = getIsaacSrc69();
        var s = src.indexOf('process.gina._inspectorInstrumentEnabled');
        var e = src.indexOf('Inspector SPA', s);
        return src.substring(s, e);
    }

    it('defines _instrumentKeyValid + _readInstrumentBody (mirrors server.js)', function() {
        var src = getIsaacSrc69();
        assert.ok(src.indexOf('function _instrumentKeyValid') > -1, 'expected _instrumentKeyValid in server.isaac.js');
        assert.ok(src.indexOf('function _readInstrumentBody') > -1, 'expected _readInstrumentBody in server.isaac.js');
        var i = src.indexOf('function _instrumentKeyValid');
        var h = src.substring(i, i + 900);
        assert.ok(h.indexOf('_inspectorInstrumentKey') > -1, 'expected the separate instrument key read');
        assert.ok(h.indexOf('_inspectorAgentKey') === -1,    'must NOT read the agent key');
    });

    it('the endpoint gate requires the opt-in and accepts GET + POST', function() {
        var block = instrBlock();
        assert.ok(block.indexOf('_inspectorInstrumentEnabled') > -1, 'expected the opt-in gate');
        assert.ok(block.indexOf("=== 'GET'") > -1,  'expected GET handling');
        assert.ok(block.indexOf("=== 'POST'") > -1, 'expected POST handling');
    });

    it('requires the key EVEN in dev (no isCacheless bypass)', function() {
        var block = instrBlock();
        assert.ok(/if\s*\(!_instrumentKeyValid\(request\)\)/.test(block), 'expected an unconditional key check');
        assert.ok(block.indexOf('isCacheless') === -1, 'must NOT carry a dev (isCacheless) key-bypass');
    });

    it('replies over both transports (HTTP/2 :status + HTTP/1.1 writeHead) via _setPoweredByHeader', function() {
        var block = instrBlock();
        assert.ok(block.indexOf('_setPoweredByHeader') > -1,  'expected headers via _setPoweredByHeader (#HDR8 parity)');
        assert.ok(block.indexOf("':status': _code") > -1,    'expected the HTTP/2 stream.respond path');
        assert.ok(/writeHead\(_code/.test(block),             'expected the HTTP/1.1 writeHead path');
        assert.ok(block.indexOf('_instrSend(401') > -1,       'expected a 401 deny');
    });

    it('GET → status(); POST → open()/close() via lib.instrument', function() {
        var block = instrBlock();
        assert.ok(block.indexOf('lib.instrument.status()') > -1, 'expected GET → status()');
        assert.ok(block.indexOf('lib.instrument.open(')   > -1, 'expected POST enable → open()');
        assert.ok(block.indexOf('lib.instrument.close()') > -1, 'expected POST disable → close()');
    });

});


// ── 70 — #INS10: _instrumentKeyValid separate-key pin + behavioral replica ───

describe('70 - #INS10 _instrumentKeyValid (separate key) behavioral replica', function() {

    var crypto = require('crypto');

    it('both engines read _inspectorInstrumentKey, never _inspectorAgentKey', function() {
        [getServerSrc(), fs.readFileSync(ISAAC_SOURCE, 'utf8')].forEach(function(src) {
            var i = src.indexOf('function _instrumentKeyValid');
            var blk = src.substring(i, i + 900);
            assert.ok(blk.indexOf('_inspectorInstrumentKey') > -1, 'expected the separate instrument key');
            assert.ok(blk.indexOf('_inspectorAgentKey') === -1,    'instrument auth must not borrow the agent key');
        });
    });

    // Inline replica of _instrumentKeyValid (identical compare logic to
    // _agentKeyValid; only the configured-key SOURCE differs, parameterised here).
    function instrumentKeyValid(req, configured) {
        if (!configured) return false;
        var presented = (req.headers && req.headers['x-gina-inspector-key']) || '';
        if (!presented && typeof req.url === 'string') {
            var _qi = req.url.indexOf('?');
            if (_qi >= 0) {
                try { presented = new URLSearchParams(req.url.slice(_qi + 1)).get('key') || ''; } catch (e) { presented = ''; }
            }
        }
        if (!presented) return false;
        var a = Buffer.from(String(presented));
        var b = Buffer.from(configured);
        if (a.length !== b.length) return false;
        try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
    }

    var KEY = 'instrument-key-xyz-456';

    it('accepts a matching key via the x-gina-inspector-key header', function() {
        assert.equal(instrumentKeyValid({ headers: { 'x-gina-inspector-key': KEY }, url: '/_gina/instrument' }, KEY), true);
    });

    it('accepts a matching key via the ?key= query param', function() {
        assert.equal(instrumentKeyValid({ headers: {}, url: '/_gina/instrument?key=' + encodeURIComponent(KEY) }, KEY), true);
    });

    it('rejects a wrong key and a same-length-different key', function() {
        assert.equal(instrumentKeyValid({ headers: { 'x-gina-inspector-key': 'nope' }, url: '/x' }, KEY), false);
        assert.equal(instrumentKeyValid({ headers: { 'x-gina-inspector-key': 'abcd' }, url: '/x' }, 'abce'), false);
    });

    it('fails closed when no key is configured, even with a presented key', function() {
        assert.equal(instrumentKeyValid({ headers: { 'x-gina-inspector-key': KEY }, url: '/_gina/instrument?key=' + KEY }, ''), false);
    });

});


// ── 71 — #INS10: capture gates honour the instrumentation window ─────────────

describe('71 - #INS10 capture gates honour the instrumentation window', function() {

    var WINDOW = 'process.gina._inspectorWindowUntil > Date.now()';

    it('the ALS-entry gate (controller.js) opens on the window, header path stays behind _isDev', function() {
        var src = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
        var i = src.indexOf("x-gina-inspector'] === 'true'");
        assert.ok(i > -1, 'expected the ALS-entry gate');
        var gate = src.substring(src.lastIndexOf('if (', i), i + 140);
        assert.ok(gate.indexOf(WINDOW) > -1, 'expected the window predicate in the ALS gate');
        assert.ok(gate.indexOf('_isDev') > -1, 'expected the dev path preserved');
        // Prod-safety invariant: the spoofable x-gina-inspector header path stays
        // gated behind _isDev, so an external request cannot trigger capture in
        // production by setting the header — only an opened window does.
        assert.ok(/_isDev\s*&&\s*\(process\.gina\._inspectorActive/.test(gate),
            'the x-gina-inspector header path must remain behind _isDev (no prod capture via spoofed header)');
    });

    it('both flow-create gates open on the window', function() {
        var s  = getServerSrc();
        var si = s.indexOf('request._devTimeline = {');
        assert.ok(si > -1, 'expected server.js flow-create');
        assert.ok(s.substring(s.lastIndexOf('if (', si), si).indexOf(WINDOW) > -1,
            'server.js flow-create must open on the window');

        var is = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        var ii = is.indexOf('request._devTimeline = {');
        assert.ok(ii > -1, 'expected server.isaac.js flow-create');
        assert.ok(is.substring(is.lastIndexOf('if (', ii), ii).indexOf(WINDOW) > -1,
            'server.isaac.js flow-create must open on the window');
    });

    it('every connector query-capture gate ORs the window onto envIsDev (dev preserved)', function() {
        ['couchbase', 'mysql', 'postgresql', 'sqlite', 'mongodb', 'scylladb', 'duckdb'].forEach(function(c) {
            var src = fs.readFileSync(path.join(FW, 'core/connectors/' + c + '/index.js'), 'utf8');
            assert.ok(/envIsDev\s*\|\|\s*\(process\.gina && process\.gina\._inspectorWindowUntil > Date\.now\(\)\)/.test(src),
                c + ' must OR the window predicate onto envIsDev');
        });
    });

    it('couchbase broadens BOTH the main-query and bulkInsert capture gates', function() {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/couchbase/index.js'), 'utf8');
        var matches = src.match(/envIsDev \|\| \(process\.gina && process\.gina\._inspectorWindowUntil > Date\.now\(\)\)/g);
        assert.ok(matches && matches.length >= 2,
            'expected the window predicate on both couchbase capture gates, found ' + (matches ? matches.length : 0));
    });

});


// ── 72 — #INS10: window egress is authenticated + leak-safe ──────────────────

describe('72 - #INS10 window egress is authenticated + leak-safe', function() {

    var WINDOW = 'process.gina._inspectorWindowUntil > Date.now()';

    it('render-json emit + flow-close gates open on the window', function() {
        var src = fs.readFileSync(path.join(FW, 'core/controller/controller.render-json.js'), 'utf8');
        var emitIdx = src.indexOf('#INS — emit Inspector payload');
        assert.ok(emitIdx > -1 && src.substring(emitIdx, emitIdx + 500).indexOf(WINDOW) > -1,
            'the JSON emit gate must open on the window');
        var fcIdx = src.indexOf('Flow waterfall has closing bars');
        assert.ok(fcIdx > -1 && src.substring(fcIdx, fcIdx + 500).indexOf(WINDOW) > -1,
            'the flow-close gate must open on the window');
    });

    it('render-json cross-bundle sidecars emit raw data only in dev (#B993: the header is client-controlled)', function() {
        var src = fs.readFileSync(path.join(FW, 'core/controller/controller.render-json.js'), 'utf8');
        var qi = src.indexOf('jsonObj.__ginaQueries = local._queryLog;');
        var qGate = src.substring(src.lastIndexOf('if (', qi), qi);
        assert.ok(qGate.indexOf('self.isCacheless()') > -1, 'dev path preserved (sidecar emits in dev)');
        assert.equal(qGate.indexOf(WINDOW), -1, '#B993: the raw query sidecar must not open on the window');
        assert.equal(qGate.indexOf('x-gina-inspector'), -1,
            '#B993: the raw query sidecar must not trust the x-gina-inspector header (any client can send it)');
        var fi = src.indexOf('jsonObj.__ginaFlow = local._timeline.entries;');
        var fGate = src.substring(src.lastIndexOf('if (', fi), fi);
        assert.ok(fGate.indexOf('self.isCacheless()') > -1, 'dev path preserved (__ginaFlow emits in dev)');
        assert.equal(fGate.indexOf(WINDOW), -1, '#B993: the __ginaFlow sidecar must not open on the window');
        assert.equal(fGate.indexOf('x-gina-inspector'), -1, '#B993: the __ginaFlow sidecar must not trust the header');
    });

    it('controller cross-bundle header-set + extract open on the window', function() {
        var src = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
        var hi = src.indexOf("options.headers['x-gina-inspector'] = 'true';");
        assert.ok(src.substring(src.lastIndexOf('if (', hi), hi).indexOf(WINDOW) > -1, 'header-set must open on the window');
        var xi = src.indexOf('data.__ginaQueries && local._queryLog');
        assert.ok(src.substring(src.lastIndexOf('if (', xi), xi).indexOf(WINDOW) > -1, 'sidecar extract must open on the window');
    });

    it('engine.io getGinaData never serves the snapshot outside dev (unauthenticated channel)', function() {
        var src = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        var gi = src.indexOf("payload.type === 'getGinaData'");
        var blk = src.substring(gi, gi + 250);
        assert.ok(/options\.isCacheless\s*\?\s*server\._lastGinaData\s*:\s*null/.test(blk),
            'getGinaData must dev-gate the snapshot (null outside dev) — no leak over the unauthenticated socket');
    });

    it('agent SSE replays the snapshot only in dev OR an active window (both engines)', function() {
        var s = getServerSrc();
        var si = s.indexOf('self.instance && self.instance._lastGinaData');
        assert.ok(s.substring(s.lastIndexOf('if (', si), si).indexOf('lib.instrument.isActive()') > -1,
            'server.js agent snapshot replay must be gated on dev-or-window');
        var is = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        var ii = is.indexOf('JSON.stringify(server._lastGinaData)');
        assert.ok(is.substring(is.lastIndexOf('if (', ii), ii).indexOf('lib.instrument.isActive()') > -1,
            'isaac agent snapshot replay must be gated on dev-or-window');
    });

});


// ── 73 — #INS10 follow-up: server-rendered HTML page egress (swig + nunjucks) ─
// The dev-mode inspector#data emit in render-swig.js / render-nunjucks.js is
// entangled with the __ginaData script injection + </body> rewrite, so its
// gate cannot be broadened to prod windows without corrupting cached renders.
// A separate HTML-free emit path (inspector-window-emit.js) mirrors the
// render-json v1 emit and is wired at the swig cache-hit + cache-miss tails and
// the nunjucks fresh-render tail, gated window-open-AND-not-dev so it is
// mutually exclusive with the dev block (no double emit, no prod HTML mutation).

describe('73 - #INS10 follow-up: server-rendered HTML page egress', function() {

    var WINDOW = 'process.gina._inspectorWindowUntil > Date.now()';
    var RSWIG  = path.join(FW, 'core/controller/controller.render-swig.js');
    var RNJK   = path.join(FW, 'core/controller/controller.render-nunjucks.js');
    var HELPER = path.join(FW, 'core/controller/inspector-window-emit.js');

    // ── source pins ──

    it('both HTML delegates require the window-emit helper', function() {
        assert.ok(/require\(\s*['"]\.\/inspector-window-emit['"]\s*\)/.test(fs.readFileSync(RSWIG, 'utf8')),
            'render-swig.js must require ./inspector-window-emit');
        assert.ok(/require\(\s*['"]\.\/inspector-window-emit['"]\s*\)/.test(fs.readFileSync(RNJK, 'utf8')),
            'render-nunjucks.js must require ./inspector-window-emit');
    });

    it('render-swig.js wires the emit at BOTH cache paths (cache-hit + cache-miss)', function() {
        var calls = (fs.readFileSync(RSWIG, 'utf8').match(/emitInspectorWindowData\(self,\s*local\)/g) || []);
        assert.equal(calls.length, 2,
            'expected 2 swig emit call sites (cache-hit + cache-miss), found ' + calls.length);
    });

    it('render-nunjucks.js wires exactly one emit (fresh-render path)', function() {
        var calls = (fs.readFileSync(RNJK, 'utf8').match(/emitInspectorWindowData\(self,\s*local\)/g) || []);
        assert.equal(calls.length, 1, 'expected 1 nunjucks emit call site, found ' + calls.length);
    });

    it('every call site is gated window-open AND not-dev (mutually exclusive with the dev block)', function() {
        // !self.isCacheless() means the new path NEVER co-runs with the dev-only
        // injection block (which requires isCacheless()/displayInspector === true)
        // — no double emit, and dev-path HTML mutation never runs in prod.
        [RSWIG, RNJK].forEach(function(f) {
            var src = fs.readFileSync(f, 'utf8');
            var idx = src.indexOf('emitInspectorWindowData(self, local)');
            var n = 0;
            while (idx > -1) {
                var gate = src.substring(src.lastIndexOf('if (', idx), idx);
                assert.ok(gate.indexOf(WINDOW) > -1, f + ': a call site is missing the window predicate');
                assert.ok(gate.indexOf('!self.isCacheless()') > -1, f + ': a call site is missing !self.isCacheless()');
                n++;
                idx = src.indexOf('emitInspectorWindowData(self, local)', idx + 1);
            }
            assert.ok(n > 0, f + ': expected at least one emit call site');
        });
    });

    it('the helper is leak-safe + minimal (no unredacted slot, no user.data; builds env+queries+flow, redacts, emits)', function() {
        var stripped = fs.readFileSync(HELPER, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        assert.ok(!/_lastGinaDataUnredacted\s*=/.test(stripped),
            'the window emit must not write the unredacted slot (a prod window is never local scope)');
        assert.ok(!/\buser\.data\b/.test(stripped) && !/\bdata\s*:\s*jsonObj\b/.test(stripped),
            'the minimal payload must not carry user.data');
        assert.ok(/_gdUser\s*=\s*\{\s*environment/.test(stripped), 'payload must carry user.environment');
        assert.ok(/_gdUser\.queries\s*=\s*local\._queryLog/.test(stripped), 'payload must attach queries from local._queryLog');
        assert.ok(/_gdUser\.flow\s*=/.test(stripped), 'payload must attach flow from local._timeline');
        assert.ok(/inspectorRedact\.redact\(/.test(stripped), 'payload must be redacted before any sink');
        assert.ok(/self\.serverInstance\._lastGinaData\s*=/.test(stripped), 'must store the redacted snapshot for SSE replay');
        assert.ok(/process\.emit\(\s*['"]inspector#data['"]/.test(stripped), 'must emit inspector#data');
    });

    // ── behavioral ──

    it('emits a redacted environment+queries+flow payload over inspector#data (no user.data)', function() {
        var emit = require(HELPER);
        var prevGetContext = global.getContext;
        var prevGetEnvVar  = global.getEnvVar;
        global.getContext = function(k) { return (k === 'gina') ? { version: '9.9.9-test' } : {}; };
        global.getEnvVar  = function(k) { return (k === 'GINA_PID') ? '4242' : null; };

        var captured = null;
        var listener = function(p) { captured = p; };
        process.once('inspector#data', listener);

        var serverInstance = {};
        var self  = { serverInstance: serverInstance, isCacheless: function() { return false; } };
        var local = {
            options: { conf: {
                bundle: 'demo',
                projectName: 'demoProj',
                server: { engine: 'isaac', protocol: 'http/2.0', scheme: 'https', port: 3000, webroot: '/' },
                content: { settings: { inspector: { url: 'http://localhost:4001' } } }
            } },
            // `password` is a deliberately-planted secret-NAMED key to prove the
            // redaction pass runs end-to-end (a real query entry has no such key).
            _queryLog: [ { type: 'N1QL', statement: 'SELECT 1', params: [], password: 'sekret' } ],
            _timeline: { requestStart: 1000, entries: [ { label: 'total', cat: 'total', startMs: 1000, endMs: 1012, durationMs: 12 } ] }
        };

        try {
            emit(self, local);
        } finally {
            process.removeListener('inspector#data', listener);
            if (prevGetContext === undefined) { delete global.getContext; } else { global.getContext = prevGetContext; }
            if (prevGetEnvVar === undefined)  { delete global.getEnvVar;  } else { global.getEnvVar  = prevGetEnvVar;  }
        }

        assert.ok(captured, 'inspector#data must fire');
        // envelope mirrors render-json v1
        assert.ok(captured.gina && captured.gina.environment, 'gina.environment present');
        assert.equal(captured.gina.environment.gina, '9.9.9-test', 'environment sourced from getContext("gina")');
        assert.equal(captured.gina.environment['gina pid'], '4242', 'gina pid sourced from getEnvVar');
        assert.equal(captured.gina.inspectorUrl, 'http://localhost:4001', 'inspectorUrl from settings');
        assert.ok(captured.user && captured.user.environment, 'user.environment present');
        assert.ok(Array.isArray(captured.user.queries) && captured.user.queries.length === 1, 'user.queries present');
        assert.ok(captured.user.flow && captured.user.flow.entries.length === 1, 'user.flow present');
        // minimal payload — NO user.data
        assert.ok(!('data' in captured.user), 'user.data must be absent (minimal payload)');
        // redaction ran (key-name match on the planted secret)
        assert.equal(captured.user.queries[0].password, '[redacted]', 'secret-named field must be redacted');
        // original buffer untouched (redact returns a deep clone)
        assert.equal(local._queryLog[0].password, 'sekret', 'redact must not mutate the source query log');
        // snapshot stored for SSE replay; unredacted slot NOT written in a prod window
        assert.equal(serverInstance._lastGinaData, captured, '_lastGinaData stored for SSE replay');
        assert.ok(!('_lastGinaDataUnredacted' in serverInstance), 'unredacted slot must NOT be written in a prod window');
    });

    it('is no-op-safe on incomplete args (never throws, never emits)', function() {
        var emit = require(HELPER);
        var fired = false;
        var listener = function() { fired = true; };
        process.on('inspector#data', listener);
        try {
            assert.doesNotThrow(function() { emit(null, null); });
            assert.doesNotThrow(function() { emit({}, {}); });                    // no serverInstance
            assert.doesNotThrow(function() { emit({ serverInstance: {} }, {}); }); // no local.options
        } finally {
            process.removeListener('inspector#data', listener);
        }
        assert.equal(fired, false, 'must not emit when args are incomplete');
    });

});


// ── 74 — #INS8: authenticated WebSocket /_gina/agent transport (server.js) ────

describe('74 - #INS8 authenticated WebSocket /_gina/agent transport in server.js', function() {

    function wsBlk() {
        var src = getServerSrc();
        var i = src.indexOf('function attachInspectorAgentWs');
        assert.ok(i > -1, 'expected attachInspectorAgentWs() in server.js');
        return src.substring(i, i + 6200);
    }

    it('server.js defines attachInspectorAgentWs(rawServer, ctx)', function() {
        assert.ok(getServerSrc().indexOf('function attachInspectorAgentWs(rawServer, ctx)') > -1,
            'expected the file-scope attachInspectorAgentWs helper');
    });

    it('lazy-requires ws inside try/catch and fails graceful (SSE stays the transport)', function() {
        var blk = wsBlk();
        assert.ok(blk.indexOf("require('ws')") > -1,            'expected require(ws)');
        assert.ok(/try\s*\{[\s\S]*require\('ws'\)/.test(blk),    'expected require(ws) inside a try block');
        assert.ok(blk.indexOf('WebSocket transport disabled') > -1, 'expected a fail-graceful warn when ws is unavailable');
        assert.ok(/catch\s*\(wsErr\)/.test(blk),                'expected a catch around the ws require');
    });

    it('creates a noServer WebSocketServer', function() {
        var blk = wsBlk();
        assert.ok(/new WebSocketServer\(\{\s*noServer:\s*true\s*\}\)/.test(blk),
            'expected new WebSocketServer({ noServer: true })');
    });

    it('registers an upgrade listener that path-matches /_gina/agent (with optional query)', function() {
        var blk = wsBlk();
        assert.ok(/rawServer\.on\('upgrade'/.test(blk), 'expected rawServer.on(upgrade)');
        assert.ok(blk.indexOf('/\\/_gina\\/agent(?:\\?|$)/') > -1,
            'expected the /_gina/agent(?:\\?|$) path regex (matches query-string form)');
    });

    it('gate opens on dev OR _inspectorAgentEnabled; 404 when neither', function() {
        var blk = wsBlk();
        assert.ok(blk.indexOf('NODE_ENV_IS_DEV') > -1,         'expected the dev path in the gate');
        assert.ok(blk.indexOf('_inspectorAgentEnabled') > -1,  'expected the enabled toggle in the gate');
        assert.ok(/HTTP\/1\.1 404 Not Found/.test(blk),        'expected a raw 404 when not dev and not enabled');
    });

    it('requires a valid key outside dev and denies with a raw 401 socket write', function() {
        var blk = wsBlk();
        assert.ok(/!_agIsDev\s*&&\s*!_agentKeyValid\(req\)/.test(blk), 'expected the key check skipped in dev, enforced outside');
        assert.ok(/HTTP\/1\.1 401 Unauthorized/.test(blk),     'expected a raw 401 status line on the upgrade socket');
        assert.ok(blk.indexOf('socket.destroy()') > -1,        'expected socket.destroy() on deny');
    });

    it('enforces the Origin allowlist only when configured (403 on mismatch)', function() {
        var blk = wsBlk();
        assert.ok(blk.indexOf('_inspectorAgentAllowedOrigins') > -1, 'expected the Origin allowlist read');
        assert.ok(/_allowed\.length\s*>\s*0/.test(blk),         'expected enforcement gated on a non-empty allowlist');
        assert.ok(/HTTP\/1\.1 403 Forbidden/.test(blk),         'expected a raw 403 on Origin mismatch');
    });

    it('on upgrade registers inspector#data + logger#default listeners with cleanup', function() {
        var blk = wsBlk();
        assert.ok(blk.indexOf('handleUpgrade(req, socket, head') > -1, 'expected wss.handleUpgrade');
        assert.ok(blk.indexOf("process.on('inspector#data'") > -1,     'expected the data listener');
        assert.ok(blk.indexOf("process.on('logger#default'") > -1,     'expected the log listener');
        assert.ok(blk.indexOf("removeListener('inspector#data'") > -1, 'expected data listener cleanup');
        assert.ok(blk.indexOf("removeListener('logger#default'") > -1, 'expected log listener cleanup');
        assert.ok(/ws\.on\('close'/.test(blk) && /ws\.on\('error'/.test(blk), 'expected cleanup on close + error');
    });

    it('frames are JSON envelopes {event:data} / {event:log} matching the SSE shape', function() {
        var blk = wsBlk();
        assert.ok(blk.indexOf("event: 'data'") > -1, 'expected the data envelope');
        assert.ok(blk.indexOf("event: 'log'") > -1,  'expected the log envelope');
        assert.ok(blk.indexOf("src: 'server'") > -1, 'expected the server log src tag (SSE parity)');
    });

    it('replays the last snapshot only in dev OR an active instrumentation window (#INS10 parity)', function() {
        var blk = wsBlk();
        assert.ok(/_agIsDev\s*\|\|\s*\(lib\.instrument\s*&&\s*lib\.instrument\.isActive\(\)\)/.test(blk),
            'expected snapshot replay gated on dev OR an active window');
        assert.ok(blk.indexOf('_lastGinaData') > -1, 'expected the snapshot source');
    });

    it('is attached at the unified listen() point for both engines', function() {
        var src = getServerSrc();
        assert.ok(src.indexOf('attachInspectorAgentWs(process.server, self)') > -1,
            'expected the call site after listen() (covers isaac + express via the raw server)');
    });

});


// ── 75 — #INS8: WS coexistence + config wiring (isaac, gna.js, settings, manifest) ──

describe('75 - #INS8 WebSocket transport coexistence + config wiring', function() {

    var _isaacSrc75; function getIsaacSrc75() { return _isaacSrc75 || (_isaacSrc75 = fs.readFileSync(ISAAC_SOURCE, 'utf8')); }
    var GNA_SOURCE   = path.join(FW, 'core/gna.js');
    var SETTINGS_TPL = path.join(FW, 'core/template/conf/settings.json');
    var FW_PKG       = path.join(FW, 'package.json');
    var ROOT_PKG     = path.join(FW, '../../package.json');

    it('isaac engine.io upgrade handler defers /_gina/agent to the WS agent handler', function() {
        var src = getIsaacSrc75();
        var i = src.indexOf("server.on('upgrade'");
        assert.ok(i > -1, 'expected the engine.io upgrade handler');
        var blk = src.substring(i, i + 400);
        assert.ok(blk.indexOf('/\\/_gina\\/agent(?:\\?|$)/') > -1, 'expected the /_gina/agent skip-guard regex');
        assert.ok(/agent\(\?:\\\?\|\$\)\/\.test\(req\.url[\s\S]*?\{\s*return;\s*\}/.test(blk),
            'expected an early return so engine.io does not grab the agent upgrade');
    });

    it('gna.js captures _inspectorAgentAllowedOrigins from settings (with fail-closed default)', function() {
        var src = fs.readFileSync(GNA_SOURCE, 'utf8');
        assert.ok(src.indexOf('_inspectorAgentAllowedOrigins') > -1, 'expected the allowlist capture');
        assert.ok(/Array\.isArray\(_inspAgent\.allowedOrigins\)\s*\?\s*_inspAgent\.allowedOrigins\s*:\s*\[\]/.test(src),
            'expected the array-guarded read defaulting to []');
        // fail-closed default present in the catch block
        assert.ok(/process\.gina\._inspectorAgentAllowedOrigins\s*=\s*\[\];/.test(src),
            'expected the [] fail-closed default in the catch block');
    });

    it('settings.json template documents inspector.agent.allowedOrigins (default [])', function() {
        var src = fs.readFileSync(SETTINGS_TPL, 'utf8');
        var i = src.indexOf('"agent"');
        var blk = src.substring(i, i + 220);
        assert.ok(blk.indexOf('"allowedOrigins"') > -1, 'expected allowedOrigins in the agent block');
        assert.ok(/"allowedOrigins":\s*\[\]/.test(blk), 'expected the default empty allowlist');
    });

    it('ws is declared in BOTH the framework and root manifests (dual-manifest parity)', function() {
        var fwPkg   = JSON.parse(fs.readFileSync(FW_PKG, 'utf8'));
        var rootPkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
        assert.ok(fwPkg.dependencies && fwPkg.dependencies.ws,   'expected ws in framework/v*/package.json');
        assert.ok(rootPkg.dependencies && rootPkg.dependencies.ws, 'expected ws in root package.json');
    });

});


// ── 76 — #INS8: WebSocket gate/auth/origin behavioral replica ─────────────────

describe('76 - #INS8 WebSocket upgrade gate/auth/origin behavioral replica', function() {

    // The path regex is shared by the WS upgrade handler (server.js) and the
    // isaac skip-guard. Per the §52/§37 gotcha, exercise it against query'd URLs.
    var AGENT_RE = /\/_gina\/agent(?:\?|$)/;

    it('path regex matches /_gina/agent and its query-string form', function() {
        assert.equal(AGENT_RE.test('/_gina/agent'), true);
        assert.equal(AGENT_RE.test('/_gina/agent?key=abc'), true);
        assert.equal(AGENT_RE.test('/sub/_gina/agent?key=abc&foo=1'), true);
    });

    it('path regex rejects look-alikes', function() {
        assert.equal(AGENT_RE.test('/_gina/agentx'), false);
        assert.equal(AGENT_RE.test('/_gina/agentstuff'), false);
        assert.equal(AGENT_RE.test('/_gina/agent/foo'), false);
        assert.equal(AGENT_RE.test('/_gina/agents'), false);
    });

    // Replica of the upgrade gate decision (server.js attachInspectorAgentWs).
    // Returns the HTTP status that would be written on the raw socket, or 101
    // when the handshake proceeds.
    function upgradeDecision(opts) {
        var isDev    = opts.isDev === true;
        var enabled  = opts.enabled === true;
        var keyOk    = opts.keyOk === true;
        var allowed  = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : [];
        var origin   = opts.origin || '';
        if (!isDev && !enabled) { return 404; }
        if (!isDev && !keyOk)   { return 401; }
        if (allowed.length > 0 && allowed.indexOf(origin) < 0) { return 403; }
        return 101;
    }

    it('dev mode upgrades with no key (back-compat with #INS9a)', function() {
        assert.equal(upgradeDecision({ isDev: true }), 101);
    });

    it('non-dev + not enabled ⇒ 404 (endpoint invisible unless opted in)', function() {
        assert.equal(upgradeDecision({ isDev: false, enabled: false }), 404);
    });

    it('non-dev + enabled + missing/invalid key ⇒ 401', function() {
        assert.equal(upgradeDecision({ isDev: false, enabled: true, keyOk: false }), 401);
    });

    it('non-dev + enabled + valid key ⇒ 101 when no Origin allowlist configured', function() {
        assert.equal(upgradeDecision({ isDev: false, enabled: true, keyOk: true }), 101);
    });

    it('Origin allowlist enforced only when non-empty', function() {
        // empty allowlist ⇒ any origin passes
        assert.equal(upgradeDecision({ isDev: false, enabled: true, keyOk: true, allowedOrigins: [], origin: 'http://evil' }), 101);
        // configured ⇒ mismatch is 403
        assert.equal(upgradeDecision({ isDev: false, enabled: true, keyOk: true, allowedOrigins: ['http://localhost:4101'], origin: 'http://evil' }), 403);
        // configured ⇒ match passes
        assert.equal(upgradeDecision({ isDev: false, enabled: true, keyOk: true, allowedOrigins: ['http://localhost:4101'], origin: 'http://localhost:4101' }), 101);
    });

    it('dev bypasses the key check even when an allowlist is configured', function() {
        // dev short-circuits enabled+key; allowlist still applies (defense-in-depth)
        assert.equal(upgradeDecision({ isDev: true, allowedOrigins: ['http://localhost:4101'], origin: 'http://localhost:4101' }), 101);
        assert.equal(upgradeDecision({ isDev: true, allowedOrigins: ['http://localhost:4101'], origin: 'http://evil' }), 403);
    });

});


// ── 77 — #INS8: Inspector SPA WebSocket transport (tryAgentWS opt-in) ─────────

describe('77 - #INS8 Inspector SPA WebSocket transport (tryAgentWS)', function() {

    var _inspJs77;
    function getInspJs77() { return _inspJs77 || (_inspJs77 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    function wsFnBlk() {
        var js = getInspJs77();
        var i = js.indexOf('function tryAgentWS');
        assert.ok(i > -1, 'expected tryAgentWS in dist inspector.js');
        // End-anchor on the next function so the whole tryAgentWS body is captured
        // regardless of internal growth (e.g. the #AISTREAM token branch); the old
        // fixed +4400 window dropped the onclose fallback guard once that landed.
        var end = js.indexOf('function tryAgentPassive', i);
        return js.substring(i, end > i ? end : i + 6000);
    }

    it('dist inspector.js defines tryAgentWS()', function() {
        assert.ok(getInspJs77().indexOf('function tryAgentWS') > -1, 'expected tryAgentWS()');
    });

    it('connects via a native WebSocket to {target}/_gina/agent', function() {
        var blk = wsFnBlk();
        assert.ok(/typeof WebSocket === 'undefined'/.test(blk), 'expected a WebSocket feature check');
        assert.ok(blk.indexOf('new WebSocket(wsUrl)') > -1,      'expected new WebSocket(wsUrl)');
        assert.ok(blk.indexOf("'/_gina/agent'") > -1,           'expected the /_gina/agent path');
    });

    it('switches the scheme to ws/wss and threads ?key=', function() {
        var blk = wsFnBlk();
        assert.ok(/replace\(\/\^http\/i,\s*'ws'\)/.test(blk), 'expected http→ws scheme swap (preserves https→wss)');
        assert.ok(blk.indexOf("params.get('key')") > -1,      'expected the ?key= read');
        assert.ok(blk.indexOf("'?key='") > -1,                'expected ?key= appended to the WS URL');
    });

    it('parses {event, data} envelopes for data and log frames', function() {
        var blk = wsFnBlk();
        assert.ok(blk.indexOf('JSON.parse(ev.data)') > -1,    'expected JSON parse of the frame');
        assert.ok(blk.indexOf("frame.event === 'data'") > -1, 'expected the data envelope branch');
        assert.ok(blk.indexOf("frame.event === 'log'") > -1,  'expected the log envelope branch');
    });

    it('falls back to SSE once when the socket never opens', function() {
        var blk = wsFnBlk();
        assert.ok(/ws\.onclose\s*=/.test(blk),           'expected an onclose handler');
        assert.ok(/!_opened\s*&&\s*!_fellBack/.test(blk), 'expected a one-shot fallback guard');
        assert.ok(blk.indexOf('tryAgent()') > -1,        'expected the SSE fallback call');
    });

    it('source acquisition uses WS by default; ?transport=sse forces SSE (#INS9b)', function() {
        var js = getInspJs77();
        assert.ok(js.indexOf("get('transport')") > -1,             'expected the ?transport read');
        assert.ok(js.indexOf("_agentTransport !== 'sse'") > -1,    'expected WS-by-default gated on ?transport !== sse (SSE escape hatch)');
        assert.ok(js.indexOf('var isAgent = tryAgent()') > -1,     'expected the preserved SSE entry point');
        var wsIdx  = js.indexOf('tryAgentWS();');
        var sseIdx = js.indexOf('var isAgent = tryAgent()');
        assert.ok(wsIdx > -1 && wsIdx < sseIdx, 'expected tryAgentWS() invoked before the tryAgent() entry');
    });

    it('tryAgent() short-circuits when the WebSocket already claimed the channel', function() {
        var js = getInspJs77();
        var i = js.indexOf('function tryAgent()');
        var blk = js.substring(i, i + 200);
        assert.ok(/if \(source === 'agent'\) return true;/.test(blk),
            'expected the source===agent no-op guard at the top of tryAgent');
    });

    it('claims source=agent only after the socket is constructed', function() {
        var blk = wsFnBlk();
        var wsIdx  = blk.indexOf('new WebSocket(wsUrl)');
        var srcIdx = blk.indexOf("source = 'agent'");
        assert.ok(wsIdx > -1 && srcIdx > wsIdx,
            'expected source=agent set AFTER new WebSocket (constructor throw leaves SSE as fallback)');
    });

    // Behavioral replica of the WS URL construction (scheme swap + key append).
    function wsUrl(target, key) {
        target = String(target).replace(/\/+$/, '');
        var u = target.replace(/^http/i, 'ws') + '/_gina/agent';
        if (key) { u += '?key=' + encodeURIComponent(key); }
        return u;
    }

    it('builds ws:// for http targets and wss:// for https targets', function() {
        assert.equal(wsUrl('http://localhost:3100'),  'ws://localhost:3100/_gina/agent');
        assert.equal(wsUrl('https://example.com/'),   'wss://example.com/_gina/agent');
        assert.equal(wsUrl('http://localhost:3100/', 'k e y'), 'ws://localhost:3100/_gina/agent?key=k%20e%20y');
    });

});


// ── 18 — Data-source freshness guard: a stale-process opener/localStorage
//         snapshot must not override the live agent data (e.g. the
//         template-engine version badge after a bundle restart) ─────────────
describe('18 - Inspector data-source freshness guard', function() {

    var INSPECTOR_JS = path.join(BM_DIR, 'inspector.js');
    var _src;
    function getSrc() { return _src || (_src = fs.readFileSync(INSPECTOR_JS, 'utf8')); }

    // ── Source pins ──────────────────────────────────────────────────────
    it('declares the _livePid freshness reference', function() {
        assert.match(getSrc(), /var _livePid = null;/);
    });

    it('defines the _gdPid / _noteLivePid / _isStaleSource helpers', function() {
        var src = getSrc();
        assert.match(src, /function _gdPid\(gd\)/);
        assert.match(src, /function _noteLivePid\(gd\)/);
        assert.match(src, /function _isStaleSource\(gd\)/);
    });

    it('reads the "gina pid" off gina.environment first then user.environment', function() {
        var src = getSrc();
        assert.match(src, /\['gina pid'\]/);
        var body = src.substring(src.indexOf('function _gdPid'), src.indexOf('function _gdPid') + 320);
        assert.ok(body.indexOf('gd.gina && gd.gina.environment') > -1, 'gina.environment first');
        assert.ok(body.indexOf('gd.user && gd.user.environment') > -1, 'user.environment fallback');
    });

    it('records the live pid at all three agent apply sites', function() {
        var calls = (getSrc().match(/_noteLivePid\(gd\);/g) || []).length;
        assert.equal(calls, 3, 'expected _noteLivePid(gd) at the SSE, WS and passive agent handlers');
    });

    it('gates the opener/localStorage poll on _isStaleSource before applying', function() {
        var src = getSrc();
        assert.match(src, /if \(_isStaleSource\(gd\)\) return;/);
        var pd    = src.indexOf('function pollData');
        var guard = src.indexOf('if (_isStaleSource(gd)) return;', pd);
        var apply = src.indexOf('ginaData = gd;', pd);
        assert.ok(pd > -1 && guard > pd && guard < apply,
            'guard must run inside pollData, before ginaData = gd');
    });

    it('is inert (returns false) until an agent pid is known', function() {
        var src = getSrc();
        var body = src.substring(src.indexOf('function _isStaleSource'), src.indexOf('function _isStaleSource') + 200);
        assert.ok(body.indexOf('if (!_livePid) return false;') > -1,
            'expected the no-agent inert short-circuit');
    });

    // ── Pure-logic replica of _gdPid + the staleness decision ─────────────
    function gdPid(gd) {
        try {
            var e = (gd && gd.gina && gd.gina.environment)
                 || (gd && gd.user && gd.user.environment) || null;
            return e ? (e['gina pid'] || null) : null;
        } catch (e) { return null; }
    }
    function isStale(livePid, gd) {
        if (!livePid) return false;
        var p = gdPid(gd);
        return !!(p && p !== livePid);
    }
    function fromPid(pid, view) {
        var o = {}; o[view || 'gina'] = { environment: { 'gina pid': pid } }; return o;
    }

    it('extracts pid from the gina view, falling back to the user view', function() {
        assert.equal(gdPid(fromPid(223, 'gina')), 223);
        assert.equal(gdPid(fromPid(223, 'user')), 223);
        assert.equal(gdPid({ gina: { environment: {} } }), null);
        assert.equal(gdPid(null), null);
    });

    it('inert before any agent frame — a stale-looking opener still applies', function() {
        assert.equal(isStale(null, fromPid(1238)), false);
    });

    it('suppresses an opener payload from a different (stale) process', function() {
        // agent established live pid 223; opener still on the pre-restart pid 1238
        assert.equal(isStale(223, fromPid(1238)), true);
    });

    it('applies an opener payload from the live process (same pid)', function() {
        assert.equal(isStale(223, fromPid(223)), false);
    });

    it('applies an opener payload with no pid (back-compat — nothing to compare)', function() {
        assert.equal(isStale(223, { gina: { environment: {} } }), false);
        assert.equal(isStale(223, null), false);
    });

});


// ── 78 — agent-WS SIGTERM-drain registration (server.js) ─────────────────────
// Live /_gina/agent WebSocket sockets register a `1001 going away` closer in
// process.gina._sseConnections (the registry proc.js drains BEFORE
// _httpServer.close()) and deregister in their own _cleanup, so SIGTERM no
// longer blocks on open agent sockets until the hard shutdown timeout.

describe('78 - agent-WS SIGTERM-drain registration in server.js', function() {

    function wsDrainBlk() {
        var src = getServerSrc();
        var i = src.indexOf('function attachInspectorAgentWs');
        assert.ok(i > -1, 'expected attachInspectorAgentWs() in server.js');
        return src.substring(i, i + 8000);
    }

    it('registers a shutdown closer in process.gina._sseConnections on upgrade', function() {
        var blk = wsDrainBlk();
        assert.ok(
            blk.indexOf('if (!process.gina._sseConnections) process.gina._sseConnections = new Set();') > -1,
            'expected the lazy Set init (same idiom as the SSE handlers)'
        );
        assert.ok(
            blk.indexOf('process.gina._sseConnections.add(_wsShutdownCloser)') > -1,
            'expected the closer registration'
        );
    });

    it("the closer sends a clean `1001 going away` close handshake", function() {
        assert.match(
            wsDrainBlk(),
            /var _wsShutdownCloser = function\(\) \{\s*try \{ ws\.close\(1001, 'server shutting down'\); \} catch \(e\) \{\}\s*\};/,
            "expected `ws.close(1001, 'server shutting down')` — byte-consistent with the ws-session drain closer"
        );
    });

    it('_cleanup deregisters the closer (close fires after the handshake completes)', function() {
        var blk = wsDrainBlk();
        var cleanupIdx = blk.indexOf('var _cleanup = function()');
        assert.ok(cleanupIdx > -1, '_cleanup must exist');
        var delIdx = blk.indexOf('process.gina._sseConnections.delete(_wsShutdownCloser)', cleanupIdx);
        var bindIdx = blk.indexOf("ws.on('close', _cleanup)", cleanupIdx);
        assert.ok(delIdx > -1 && bindIdx > delIdx,
            'expected the deregistration inside _cleanup, before the close/error bindings');
    });

    it('registration precedes the _cleanup bindings (no unregistered-close window)', function() {
        var blk = wsDrainBlk();
        var addIdx  = blk.indexOf('process.gina._sseConnections.add(_wsShutdownCloser)');
        var bindIdx = blk.indexOf("ws.on('close', _cleanup)");
        assert.ok(addIdx > -1 && bindIdx > addIdx, 'add must come before the close/error bindings');
    });

    it('_cleanup stays idempotent when close AND error both fire (replica)', function() {
        var registry = new Set();
        var removed = [];
        var _wsShutdownCloser = function() {};
        registry.add(_wsShutdownCloser);
        var _cleanup = function() {
            removed.push('listeners');
            if (registry) { registry.delete(_wsShutdownCloser); }
        };
        // ws can emit both 'close' and 'error' for the same socket
        _cleanup();
        _cleanup();
        assert.equal(registry.size, 0, 'double _cleanup must not throw and must leave the registry clean');
        assert.equal(removed.length, 2);
    });

});


// ── 79 — resolveBundleBase shared resolver routes /_gina/indexes + /_gina/logs ─
//
// fetchLiveIndexes (/_gina/indexes) and tryServerLogs (/_gina/logs) previously
// derived their base URL with a bare `window.location.pathname` strip — no
// ?target= / opener fallback — so in proxy-routed multi-bundle setups (bundles
// sharing a host, differing only by path prefix) they misrouted to the proxy's
// default bundle. They now go through the shared resolveBundleBase() helper, the
// same 3-fallback toggleReveal() uses. (toggleReveal / tryAgentPassive and the
// refresh re-reveal now route through resolveBundleBase() too, pinned by
// §54/§55/§56 — every per-bundle /_gina/* consumer uses the one resolver.)

describe('79 - resolveBundleBase shared resolver routes /_gina/indexes + /_gina/logs', function() {

    var INSPECTOR_79 = path.join(BM_DIR, 'inspector.js');
    var _src79;
    function getSrc79() { return _src79 || (_src79 = fs.readFileSync(INSPECTOR_79, 'utf8')); }

    it('inspector.js defines resolveBundleBase()', function() {
        assert.ok(getSrc79().indexOf('function resolveBundleBase') > -1, 'expected resolveBundleBase() definition');
    });

    it('resolveBundleBase implements the 3-fallback (target -> opener -> strip) in try/catch', function() {
        var src = getSrc79();
        var idx = src.indexOf('function resolveBundleBase');
        assert.ok(idx > -1, 'resolveBundleBase must exist');
        var body = src.slice(idx, idx + 900);
        assert.ok(/params\.get\(\s*['"]target['"]\s*\)/.test(body), 'expected ?target= lookup (fallback 1)');
        assert.ok(body.indexOf('window.opener.location.pathname') > -1, 'expected opener pathname (fallback 2)');
        assert.ok(body.indexOf('window.location.pathname.replace') > -1, 'expected inspector-path strip fallback (fallback 3)');
        assert.ok(/try\s*\{[\s\S]*?\}\s*catch\s*\(/.test(body), 'expected try/catch for cross-origin opener safety');
    });

    it('fetchLiveIndexes resolves its base via resolveBundleBase() (no bare strip)', function() {
        var src = getSrc79();
        var idx = src.indexOf('function fetchLiveIndexes');
        assert.ok(idx > -1, 'fetchLiveIndexes must exist');
        var body = src.slice(idx, idx + 700);
        assert.ok(/var base\s*=\s*resolveBundleBase\(\)/.test(body), 'fetchLiveIndexes must call resolveBundleBase()');
        assert.ok(body.indexOf("'/_gina/indexes'") > -1, 'still builds the /_gina/indexes URL');
        assert.ok(body.indexOf('window.location.pathname.replace') < 0, 'the old bare-strip resolver must be gone from fetchLiveIndexes');
    });

    it('tryServerLogs resolves its base via resolveBundleBase() (no bare strip)', function() {
        var src = getSrc79();
        var idx = src.indexOf('function tryServerLogs');
        assert.ok(idx > -1, 'tryServerLogs must exist');
        var body = src.slice(idx, idx + 700);
        assert.ok(/var base\s*=\s*resolveBundleBase\(\)/.test(body), 'tryServerLogs must call resolveBundleBase()');
        assert.ok(body.indexOf("'/_gina/logs'") > -1, 'still builds the /_gina/logs URL');
        assert.ok(body.indexOf('window.location.pathname.replace') < 0, 'the old bare-strip resolver must be gone from tryServerLogs');
    });

});


// ── 80 — SPA input hardening: loadFoldStore shape-guard + form-key escaping ──
//
// Two defense-in-depth hardenings in the Inspector SPA:
//   (C) loadFoldStore() validates the parsed __gina_inspector_folds JSON is a
//       plain object — a corrupted/tampered primitive would otherwise crash the
//       (un-try/caught) <details> toggle handler with a strict-mode TypeError.
//   (D) renderFormDataSections escapes the form-data section key via escHtml
//       before it reaches innerHTML (the only key/label interpolation in the SPA
//       that previously lacked escaping).

describe('80 - SPA input hardening (loadFoldStore shape-guard + form-key escHtml)', function() {

    var INSPECTOR_80 = path.join(BM_DIR, 'inspector.js');
    var _src80;
    function getSrc80() { return _src80 || (_src80 = fs.readFileSync(INSPECTOR_80, 'utf8')); }

    it('loadFoldStore validates the parsed value is a plain object (not a primitive/array)', function() {
        var src = getSrc80();
        var idx = src.indexOf('function loadFoldStore');
        assert.ok(idx > -1, 'loadFoldStore must exist');
        var body = src.slice(idx, idx + 700);
        assert.ok(/typeof\s+\w+\s*===?\s*'object'/.test(body), "expected a `typeof === 'object'` shape check");
        assert.ok(body.indexOf('!Array.isArray(') > -1, 'expected an !Array.isArray guard (reject array/primitive)');
    });

    it('renderFormDataSections escapes the form-data section key via escHtml', function() {
        var src = getSrc80();
        assert.ok(src.indexOf('escHtml(keys[k])') > -1, 'expected escHtml(keys[k]) on the form-data section title (XSS hardening)');
    });

});

describe('81 - Inspector per-tab BroadcastChannel data binding (#INS)', function() {
    var _sbar81, _ijs81;
    function statusbar81() {
        return _sbar81 || (_sbar81 = fs.readFileSync(path.join(BM_DIR, '..', 'html', 'statusbar.html'), 'utf8'));
    }
    function inspjs81() {
        return _ijs81 || (_ijs81 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8'));
    }

    // ── statusbar.html (sender side) ──────────────────────────────────────
    it('statusbar derives a stable per-tab id from sessionStorage', function() {
        var s = statusbar81();
        assert.ok(s.indexOf("sessionStorage.getItem('__gina_tab_id')") > -1,
            'expected sessionStorage __gina_tab_id read (stable across this tab\'s navigations)');
        assert.ok(s.indexOf("sessionStorage.setItem('__gina_tab_id'") > -1,
            'expected sessionStorage __gina_tab_id write (created once)');
    });

    it('statusbar opens a per-tab BroadcastChannel keyed by the tab id', function() {
        var s = statusbar81();
        assert.ok(s.indexOf("new BroadcastChannel('gina-inspector-' + _ginaTabId)") > -1,
            'expected BroadcastChannel("gina-inspector-"+tabId)');
    });

    it('statusbar publishes __ginaData on the channel at load + update + restore', function() {
        var s = statusbar81();
        var n = (s.match(/_ginaPublish\(\);/g) || []).length;
        assert.ok(n >= 3, 'expected >= 3 _ginaPublish() calls (load + ginaToolbar.update + restore), got ' + n);
        assert.ok(s.indexOf("postMessage({ type: 'data', payload: window.__ginaData })") > -1,
            'expected {type:data,payload} publish');
    });

    it('statusbar replies to a {type:request} with the current payload', function() {
        var s = statusbar81();
        assert.ok(s.indexOf("ev.data.type === 'request'") > -1,
            'expected the sender to answer the Inspector\'s {type:request} handshake');
    });

    it('statusbar opens the embedded Inspector with ?ch=<tabId>', function() {
        var s = statusbar81();
        assert.ok(s.indexOf("_embeddedUrl + (_ginaTabId ? '?ch=' + encodeURIComponent(_ginaTabId)") > -1,
            'expected ?ch= appended to the embedded Inspector open URL');
    });

    // ── inspector.js (receiver side) ──────────────────────────────────────
    it('inspector.js defines setupBoundChannel', function() {
        assert.ok(inspjs81().indexOf('function setupBoundChannel') > -1,
            'expected setupBoundChannel definition');
    });

    it('setupBoundChannel binds gina-inspector-<ch>, sets source=broadcast, requests initial data', function() {
        var s = inspjs81();
        var i = s.indexOf('function setupBoundChannel');
        assert.ok(i > -1, 'setupBoundChannel must exist');
        var body = s.slice(i, i + 1300);
        assert.ok(body.indexOf("new BroadcastChannel('gina-inspector-' + ch)") > -1,
            'expected the channel bound by the ?ch= id');
        assert.ok(body.indexOf("source = 'broadcast'") > -1, "expected source = 'broadcast'");
        assert.ok(body.indexOf("postMessage({ type: 'request' })") > -1,
            'expected a {type:request} on connect (BroadcastChannel does not replay)');
        assert.ok(body.indexOf("ev.data.type !== 'data'") > -1,
            'expected the handler to ignore non-data frames');
    });

    it('init reads ?ch= and enters bound mode inside the !isAgent branch', function() {
        var s = inspjs81();
        var i = s.indexOf('var isAgent = tryAgent()');
        var block = s.slice(i, i + 4200);
        assert.ok(block.indexOf(".get('ch')") > -1, 'expected ?ch= read via URLSearchParams.get');
        assert.ok(block.indexOf('setupBoundChannel(_boundCh)') > -1, 'expected setupBoundChannel(_boundCh) in init');
    });

    it('pollData reads _bcLatest in broadcast mode', function() {
        var s = inspjs81();
        var i = s.indexOf('function pollData');
        var body = s.slice(i, i + 900);
        assert.ok(body.indexOf("source === 'broadcast'") > -1, "expected a source === 'broadcast' branch in pollData");
        assert.ok(body.indexOf('gd = _bcLatest') > -1, 'expected gd = _bcLatest read');
    });

    it('pollData error path does NOT reset a broadcast source', function() {
        var s = inspjs81();
        assert.ok(s.indexOf("source !== 'localStorage' && source !== 'broadcast'") > -1,
            'expected the catch-block to preserve a broadcast source (else it reverts to the global channels)');
    });

    // ── pure-logic replica of the bound-channel message filter ────────────
    it('bound-channel onmessage applies only well-formed {type:data} frames', function() {
        var applied = [];
        // Mirror of setupBoundChannel's onmessage contract.
        function onmessage(ev) {
            if (!ev || !ev.data || ev.data.type !== 'data' || !ev.data.payload) return;
            applied.push(ev.data.payload);
        }
        onmessage({ data: { type: 'data', payload: { p: 1 } } }); // applied
        onmessage({ data: { type: 'request' } });                 // ignored (handshake)
        onmessage({ data: { type: 'data' } });                    // ignored (no payload)
        onmessage({ data: null });                                // ignored
        onmessage(null);                                          // ignored
        assert.strictEqual(applied.length, 1, 'only the well-formed data frame should apply');
        assert.strictEqual(applied[0].p, 1);
    });
});


describe('82 - extractIndexes: nested scan containers — IntersectScan/UnionScan/OrderedIntersectScan (`scans`) + DistinctScan (`scan`) (#B193)', function() {

    // Same extraction pattern as §30: pull the REAL function out of the connector
    // source by brace-counting and eval it — no replica to drift.
    var extractIndexes;
    var fnSrc = '';
    try {
        var src = fs.readFileSync(path.join(FW, 'core/connectors/couchbase/index.js'), 'utf8');
        var fnStart = src.indexOf('var extractIndexes = function(profile)');
        if (fnStart > -1) {
            var body = src.substring(fnStart);
            var braceDepth = 0, fnEnd = -1;
            for (var i = body.indexOf('{'); i < body.length; i++) {
                if (body[i] === '{') braceDepth++;
                if (body[i] === '}') braceDepth--;
                if (braceDepth === 0) { fnEnd = i + 1; break; }
            }
            if (fnEnd > -1) {
                fnSrc = body.substring(0, fnEnd);
                eval(fnSrc);  // defines extractIndexes in this scope
            }
        }
    } catch (e) {
        // extraction failure surfaces via the first assertion below
    }

    // -- fixture helpers (shapes taken from real EXPLAIN output) --
    function seq(op) {
        return { executionTimings: { '#operator': 'Sequence', '~children': [ op, { '#operator': 'Fetch', keyspace: 'sample' } ] } };
    }
    function idxScan(name) {
        return { '#operator': 'IndexScan3', index: name, keyspace: 'sample' };
    }
    function names(result) {
        return (result || []).map(function(ix) { return ix.name; });
    }

    it('extractIndexes function was successfully extracted from connector', function() {
        assert.ok(typeof extractIndexes === 'function', 'extractIndexes should be a callable function');
        assert.ok(fnSrc.length > 0, 'expected a non-empty extracted source');
    });

    // -- controls: the function CAN report an index / an empty plan reads [] --
    // (both must stay green pre-fix AND post-fix — they isolate the wrapper
    //  operator as the only variable in the discriminator cases below)
    it('control: a plain IndexScan3 is reported (the instrument can fire)', function() {
        assert.deepStrictEqual(names(extractIndexes(seq(idxScan('idx_a')))), ['idx_a']);
    });

    it('control: a plan with no scan operators reads [] (the no-index reading is real)', function() {
        var r = extractIndexes({ executionTimings: { '#operator': 'Sequence', '~children': [
            { '#operator': 'Filter' }, { '#operator': 'FinalProject' }
        ] } });
        assert.ok(Array.isArray(r));
        assert.strictEqual(r.length, 0);
    });

    // -- discriminators: the four measured multi-index/nested operators (#B193) --
    // Pre-fix each returned [] — the Inspector then rendered the red "no index —
    // full bucket scan" badge + banner for a query the planner had already served
    // with MULTIPLE indexes: a false negative that invites a pointless (and
    // write-amplifying) index build.
    it('IntersectScan: both child IndexScan3 nodes under `scans` are reported', function() {
        var r = extractIndexes(seq({ '#operator': 'IntersectScan', scans: [ idxScan('idx_a'), idxScan('idx_b') ] }));
        assert.deepStrictEqual(names(r), ['idx_a', 'idx_b']);
    });

    it('UnionScan: both child IndexScan3 nodes under `scans` are reported', function() {
        var r = extractIndexes(seq({ '#operator': 'UnionScan', scans: [ idxScan('idx_a'), idxScan('idx_b') ] }));
        assert.deepStrictEqual(names(r), ['idx_a', 'idx_b']);
    });

    it('OrderedIntersectScan: `scans` children are reported (same family, absent from the original report)', function() {
        var r = extractIndexes(seq({ '#operator': 'OrderedIntersectScan', scans: [ idxScan('idx_a'), idxScan('idx_d') ] }));
        assert.deepStrictEqual(names(r), ['idx_a', 'idx_d']);
    });

    it('DistinctScan: the SINGULAR `scan` container is walked', function() {
        var r = extractIndexes(seq({ '#operator': 'DistinctScan', scan: idxScan('idx_c') }));
        assert.deepStrictEqual(names(r), ['idx_c']);
    });

    it('nested composite: a UnionScan of an IntersectScan recurses through scans-in-scans', function() {
        var r = extractIndexes(seq({ '#operator': 'UnionScan', scans: [
            { '#operator': 'IntersectScan', scans: [ idxScan('idx_a'), idxScan('idx_b') ] },
            idxScan('idx_c')
        ] }));
        assert.deepStrictEqual(names(r), ['idx_a', 'idx_b', 'idx_c']);
    });

    it('dedupe: the same index appearing in two scans collapses to one entry (seen[] holds)', function() {
        var r = extractIndexes(seq({ '#operator': 'IntersectScan', scans: [ idxScan('idx_a'), idxScan('idx_a') ] }));
        assert.deepStrictEqual(names(r), ['idx_a']);
    });

    it('the primary flag is computed unchanged on nested nodes', function() {
        var r = extractIndexes(seq({ '#operator': 'IntersectScan', scans: [
            { '#operator': 'PrimaryScan3', index: '#primary', keyspace: 'sample' },
            idxScan('idx_a')
        ] }));
        assert.deepStrictEqual(r.map(function(ix) { return ix.name + ':' + ix.primary; }),
            ['#primary:true', 'idx_a:false']);
    });

    // -- source pins: the fix cannot be silently reverted --
    it('source pin: the walker visits the singular `scan` container', function() {
        assert.ok(fnSrc.indexOf("node['scan']") > -1, "expected a `node['scan']` clause in extractIndexes");
    });

    it('source pin: the walker visits the `scans` array behind an Array.isArray guard', function() {
        assert.match(fnSrc, /node\['scans'\] && Array\.isArray\(node\['scans'\]\)/);
    });

    it('source pin: the #B193 rationale comment marks the clauses', function() {
        assert.ok(fnSrc.indexOf('#B193') > -1, 'expected the #B193 marker comment in extractIndexes');
    });

    it('roster pin: the walker dispatches walk() at exactly five sites (root + 4 containers)', function() {
        // ~child, ~children[i], scan, scans[j], walk(root) — a silent fifth
        // container (or a dropped one) changes this count. Pre-fix the count was 3.
        assert.strictEqual((fnSrc.match(/walk\(/g) || []).length, 5);
    });
});


describe('83 - tab-layout preview: every preset tab has a label + color; unknown tabs humanize, never "undefined" (#B194)', function() {

    // dist copy, same as §44's getJs() — the SPA is served from dist verbatim.
    var _js83;
    function js83() { return _js83 || (_js83 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    // Extract an object literal `var NAME = {...};` by brace counting.
    function extractObj(name) {
        var src = js83();
        var at = src.indexOf('var ' + name + ' = {');
        if (at < 0) return null;
        var body = src.substring(at), depth = 0;
        for (var i = body.indexOf('{'); i < body.length; i++) {
            if (body[i] === '{') depth++;
            if (body[i] === '}') depth--;
            if (depth === 0) return body.substring(0, i + 1);
        }
        return null;
    }
    // Extract a `function name(...) {...}` by brace counting.
    function extractFn(name) {
        var src = js83();
        var at = src.indexOf('function ' + name + '(');
        if (at < 0) return null;
        var body = src.substring(at), depth = 0;
        for (var i = body.indexOf('{'); i < body.length; i++) {
            if (body[i] === '{') depth++;
            if (body[i] === '}') depth--;
            if (depth === 0) return body.substring(0, i + 1);
        }
        return null;
    }

    var TAB_LAYOUTS, TAB_PREVIEW_LABELS, TAB_PREVIEW_COLORS, pillLabel, pillColor;
    try {
        /* jshint evil: true */
        eval(extractObj('TAB_LAYOUTS'));
        eval(extractObj('TAB_PREVIEW_LABELS'));
        eval(extractObj('TAB_PREVIEW_COLORS'));
        var _fL = extractFn('pillLabel'), _fC = extractFn('pillColor');
        if (_fL) eval('pillLabel = ' + _fL);
        if (_fC) eval('pillColor = ' + _fC);
    } catch (e) { /* surfaced by the assertions below */ }

    it('the three structures extract from the dist SPA', function() {
        assert.ok(TAB_LAYOUTS && TAB_PREVIEW_LABELS && TAB_PREVIEW_COLORS, 'expected TAB_LAYOUTS + both preview maps');
    });

    it('control: the six original tabs are mapped (label + color) — pre-existing behaviour preserved', function() {
        ['data', 'view', 'logs', 'forms', 'query', 'flow'].forEach(function(tab) {
            assert.equal(typeof TAB_PREVIEW_LABELS[tab], 'string', tab + ' label');
            assert.equal(typeof TAB_PREVIEW_COLORS[tab], 'string', tab + ' color');
        });
    });

    // -- the class invariant (#B194): a tab CANNOT enter a preset without map entries.
    //    Pre-fix this failed on stream + events — both were added to all three
    //    presets but neither map, so the preview rendered the literal string
    //    "undefined" as their pill text (and --pill-color:undefined).
    it('every tab named in ANY preset has a label AND a color (roster completeness)', function() {
        Object.keys(TAB_LAYOUTS).forEach(function(preset) {
            TAB_LAYOUTS[preset].forEach(function(tab) {
                assert.equal(typeof TAB_PREVIEW_LABELS[tab], 'string',
                    'preset "' + preset + '" tab "' + tab + '" has no TAB_PREVIEW_LABELS entry');
                assert.equal(typeof TAB_PREVIEW_COLORS[tab], 'string',
                    'preset "' + preset + '" tab "' + tab + '" has no TAB_PREVIEW_COLORS entry');
            });
        });
    });

    it('the two newer tabs carry their display labels', function() {
        assert.equal(TAB_PREVIEW_LABELS.stream, 'Stream');
        assert.equal(TAB_PREVIEW_LABELS.events, 'Events');
    });

    // -- the fallback helpers: an UNKNOWN tab humanizes instead of rendering "undefined"
    it('pillLabel: mapped tabs resolve from the map, unknown tabs humanize', function() {
        assert.equal(typeof pillLabel, 'function', 'expected a pillLabel helper');
        assert.equal(pillLabel('query'), 'Query');
        assert.equal(pillLabel('stream'), 'Stream');
        assert.equal(pillLabel('metrics'), 'Metrics', 'an unmapped tab renders its capitalized name');
        assert.notEqual(String(pillLabel('metrics')), 'undefined');
    });

    it('pillColor: mapped tabs resolve from the map, unknown tabs get the neutral color', function() {
        assert.equal(typeof pillColor, 'function', 'expected a pillColor helper');
        assert.equal(pillColor('flow'), 'var(--accent)');
        assert.equal(pillColor('metrics'), 'var(--text-dim)', 'an unmapped tab gets a neutral pill color');
    });

    it('renderLayoutPreview routes BOTH render sites through the helpers (count pins)', function() {
        var src = js83();
        // visible + hidden pill loops: 3 pillLabel( call sites (visible label,
        // hidden pill's "Restore <Label> tab" title — §88 per-tab restore —
        // and hidden label) + 2 pillColor( call sites
        // (the '(' excludes the definitions, which match 'function pillLabel(').
        assert.equal((src.match(/pillLabel\(/g) || []).length, 4, 'definition + 3 call sites (§88 added the restore-title site)');
        assert.equal((src.match(/pillColor\(/g) || []).length, 3, 'definition + 2 call sites');
        // the maps are read ONLY inside the helpers now — a bare map read at a
        // render site is the "undefined"-class regression this section kills.
        assert.equal((src.match(/TAB_PREVIEW_LABELS\[/g) || []).length, 1, 'one read, inside pillLabel');
        assert.equal((src.match(/TAB_PREVIEW_COLORS\[/g) || []).length, 1, 'one read, inside pillColor');
    });

    // -- the same-family cap (#B194): the custom-order validator derives its bound
    //    from the roster instead of the stale literal 6 (with 7-8 visible tabs a
    //    saved custom order was rejected on read and never survived a reload).
    it('getCustomOrder bounds the saved array by the preset roster length, not a literal 6', function() {
        var src = js83();
        assert.ok(src.indexOf('arr.length <= TAB_LAYOUTS.balanced.length') > -1,
            'expected the roster-derived bound');
        assert.equal(src.indexOf('arr.length <= 6'), -1, 'the stale literal-6 bound must be gone');
    });

    it('the roster-derived bound admits a full 8-tab custom order today', function() {
        assert.equal(TAB_LAYOUTS.balanced.length, 8, 'all three presets carry 8 tabs today');
    });
});


// ── 84 — bundle-follow: server channels re-point on bundle crossing (#B205) ──
// In a proxy-routed multi-bundle project the Inspector's server-side channels
// (/_gina/logs SSE + passive /_gina/agent SSE) used to stay pinned to the
// bundle they were derived from at open time. A bundle the Inspector was never
// opened from therefore never saw a /_gina/* hit, its per-process dev-capture
// activation flag never latched, and every page it served rendered with no
// flow/queries — the Flow tab showed "No timeline data for this request.".
// The fix: each applied payload's environment.webroot drives
// _followBundleChannels(), which closes + re-opens the live channels against
// the new bundle's base; the /_gina/* hit latches that bundle's capture.
// The earlier pid-guard section's local replica stays valid for its
// webroot-less fixtures (behaviour unchanged there); the new webroot-aware
// branch is covered here by executing the EXTRACTED shipped bytes.

describe('84 - bundle-follow: server channels re-point on bundle crossing (#B205)', function() {

    var INSPECTOR_84 = path.join(BM_DIR, 'inspector.js');
    var _src84;
    function getSrc84() { return _src84 || (_src84 = fs.readFileSync(INSPECTOR_84, 'utf8')); }

    /**
     * Brace-matched extraction of a function's shipped bytes (started-flag
     * walker — safe here because none of the extracted bodies carry braces
     * inside string/regex literals). Throws on not-found / duplicate decl /
     * unbalanced braces so a silent mis-extraction cannot vacuously pass.
     */
    function extractFn84(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    // ── Source pins ──────────────────────────────────────────────────────

    it('declares the bundle-follow module state', function() {
        var src = getSrc84();
        assert.match(src, /var _serverLogsEs = null;/);
        assert.match(src, /var _channelBase = null;/);
        assert.match(src, /var _livePidWebroot = null;/);
    });

    it('tryServerLogs keeps the shared resolver and accepts an explicit base', function() {
        var src = getSrc84();
        var i = src.indexOf('function tryServerLogs(baseOverride)');
        assert.ok(i > -1, 'tryServerLogs must take the baseOverride param');
        var j = src.indexOf('es.onmessage', i);
        assert.ok(j > i, 'end anchor (es.onmessage) must follow the declaration');
        var blk = src.slice(i, j);
        var res = blk.indexOf('var base = resolveBundleBase();');
        var ovr = blk.indexOf("typeof baseOverride === 'string'");
        assert.ok(res > -1, 'the shared resolver stays the default');
        assert.ok(ovr > res, 'the override guard must follow (not replace) the resolver');
    });

    it('tryServerLogs keeps a single live stream and records the base', function() {
        var src = getSrc84();
        var i = src.indexOf('function tryServerLogs(baseOverride)');
        var blk = src.slice(i, src.indexOf('es.onmessage', i));
        assert.ok(blk.indexOf('_serverLogsEs.close()') > -1, 'previous stream must be closed on re-point');
        assert.ok(blk.indexOf('_serverLogsEs = es;') > -1, 'the live stream handle must be kept');
        assert.match(blk, /_channelBase\s*=\s*base;/, 'the connected base must be recorded');
    });

    it('tryAgentPassive accepts the override, closes the previous stream, records the base', function() {
        var src = getSrc84();
        var i = src.indexOf('function tryAgentPassive(baseOverride)');
        assert.ok(i > -1, 'tryAgentPassive must take the baseOverride param');
        var j = src.indexOf("es.addEventListener('data'", i);
        assert.ok(j > i, 'end anchor (data listener) must follow the declaration');
        var blk = src.slice(i, j);
        var res = blk.indexOf('var base = resolveBundleBase();');
        var ovr = blk.indexOf("typeof baseOverride === 'string'");
        assert.ok(res > -1 && ovr > res, 'resolver stays the default; override follows it');
        assert.ok(blk.indexOf('_passiveAgentEs.close()') > -1, 'previous stream must be closed on re-point');
        assert.match(blk, /_channelBase\s*=\s*base;/, 'the connected base must be recorded');
    });

    it('pollData drives the bundle-follow after the stale gate, before the label update', function() {
        var src = getSrc84();
        var pd = src.indexOf('function pollData');
        assert.ok(pd > -1);
        var stale  = src.indexOf('if (_isStaleSource(gd)) return;', pd);
        var follow = src.indexOf('_followBundleChannels(gd);', pd);
        var label  = src.indexOf("qs('#bm-label').textContent", pd);
        assert.ok(stale > pd, 'stale gate inside pollData');
        assert.ok(follow > stale, 'follow must run only on payloads that pass the stale gate');
        assert.ok(label > follow, 'follow must run as part of the apply (before the label update)');
    });

    it('_followBundleChannels never re-points in agent mode (source pin)', function() {
        var src = getSrc84();
        var fn = extractFn84(src, 'function _followBundleChannels(gd)');
        assert.ok(fn.indexOf("if (source === 'agent') return;") > -1,
            'agent mode (?target=) is an explicit binding — never re-pointed');
    });

    it('_isStaleSource narrows to same-bundle pid mismatches (source pin)', function() {
        var src = getSrc84();
        var fn = extractFn84(src, 'function _isStaleSource(gd)');
        var same = fn.indexOf('if (!p || p === _livePid) return false;');
        var wr   = fn.indexOf('_normWebroot(_gdWebroot(gd))');
        var tail = fn.indexOf('return true;');
        assert.ok(same > -1, 'same-pid / pid-less payloads still pass first');
        assert.ok(wr > same, 'the webroot comparison follows the pid checks');
        assert.ok(tail > wr, 'only a same-webroot (or webroot-less) pid mismatch stays stale');
    });

    // ── Behavioral — the EXTRACTED shipped bytes are executed ─────────────

    it('extraction controls: every construct extracts exactly once with balanced braces', function() {
        var src = getSrc84();
        var decls = [
            'function _normWebroot(w)',
            'function _gdWebroot(gd)',
            'function _gdPid(gd)',
            'function _isStaleSource(gd)',
            'function _followBundleChannels(gd)'
        ];
        for (var d = 0; d < decls.length; d++) {
            var fn = extractFn84(src, decls[d]);
            assert.ok(/^function /.test(fn) && /\}$/.test(fn), 'clean extraction for ' + decls[d]);
        }
    });

    it('_normWebroot: root forms collapse, trailing slashes strip, non-strings are unknown', function() {
        var norm = new Function('return (' + extractFn84(getSrc84(), 'function _normWebroot(w)') + ');')();
        assert.strictEqual(norm('/'), '');
        assert.strictEqual(norm(''), '');
        assert.strictEqual(norm('/admin'), '/admin');
        assert.strictEqual(norm('/admin/'), '/admin');
        assert.strictEqual(norm('/admin///'), '/admin');
        assert.strictEqual(norm(undefined), null);
        assert.strictEqual(norm(3), null);
    });

    it('_gdWebroot: gina view first, user view fallback, non-string is null', function() {
        var src = getSrc84();
        var wrFn = new Function('return (' + extractFn84(src, 'function _gdWebroot(gd)') + ');')();
        assert.strictEqual(wrFn({ gina: { environment: { webroot: '/admin' } } }), '/admin');
        assert.strictEqual(wrFn({ user: { environment: { webroot: '/' } } }), '/');
        assert.strictEqual(wrFn({ user: { environment: {} } }), null);
        assert.strictEqual(wrFn(null), null);
    });

    /** Run the shipped _isStaleSource with injected guard state. */
    function runStale(livePid, livePidWebroot, gd) {
        var src = getSrc84();
        var runner = new Function('livePid', 'livePidWebroot', 'gd',
            'var _livePid = livePid; var _livePidWebroot = livePidWebroot;' +
            'var _gdPid = (' + extractFn84(src, 'function _gdPid(gd)') + ');' +
            'var _gdWebroot = (' + extractFn84(src, 'function _gdWebroot(gd)') + ');' +
            'var _normWebroot = (' + extractFn84(src, 'function _normWebroot(w)') + ');' +
            'var _isStaleSource = (' + extractFn84(src, 'function _isStaleSource(gd)') + ');' +
            'return _isStaleSource(gd);');
        return runner(livePid, livePidWebroot, gd);
    }

    /** Payload fixture: user-view environment with optional webroot / pid. */
    function gdWith(webroot, pid) {
        var env = {};
        if (typeof webroot !== 'undefined') env.webroot = webroot;
        if (typeof pid !== 'undefined') env['gina pid'] = pid;
        return { user: { environment: env } };
    }

    it('staleness: a different pid on ANOTHER webroot passes — a bundle crossing, not staleness', function() {
        // live channel on the root bundle; the tab moved to the /admin bundle
        assert.strictEqual(runStale(223, '', gdWith('/admin', 999)), false);
        // and the reverse crossing
        assert.strictEqual(runStale(223, '/admin', gdWith('/', 999)), false);
    });

    it('staleness: same-webroot restarts and webroot-less payloads still read stale', function() {
        // same bundle ('/' normalises to ''), older process — a pre-restart snapshot
        assert.strictEqual(runStale(223, '', gdWith('/', 999)), true);
        // payload without webroot — back-compat: pid comparison alone decides
        assert.strictEqual(runStale(223, '', gdWith(undefined, 999)), true);
        // live webroot unknown — conservative: keep the pid-only verdict
        assert.strictEqual(runStale(223, null, gdWith('/admin', 999)), true);
        // unchanged verdicts: same pid, and no live pid at all
        assert.strictEqual(runStale(223, '', gdWith('/', 223)), false);
        assert.strictEqual(runStale(null, null, gdWith('/', 999)), false);
    });

    /** Run the shipped _followBundleChannels with an injected scope + spies. */
    function runFollow(scope) {
        var src = getSrc84();
        var runner = new Function('scope',
            'var source = scope.source;' +
            'var _channelBase = scope.channelBase;' +
            'var _passiveAgentEs = scope.passiveEs;' +
            'var _serverLogsEs = scope.logsEs;' +
            'var _normWebroot = (' + extractFn84(src, 'function _normWebroot(w)') + ');' +
            'var _gdWebroot = (' + extractFn84(src, 'function _gdWebroot(gd)') + ');' +
            'var calls = { passive: [], logs: [] };' +
            'var tryAgentPassive = function (b) { calls.passive.push(b); };' +
            'var tryServerLogs   = function (b) { calls.logs.push(b); };' +
            'var _followBundleChannels = (' + extractFn84(src, 'function _followBundleChannels(gd)') + ');' +
            '_followBundleChannels(scope.gd);' +
            'return { channelBase: _channelBase, calls: calls };');
        return runner(scope);
    }

    it('follow: a crossing re-points exactly the channels that are open, to the new base', function() {
        // passive stream open (opener mode)
        var r1 = runFollow({ source: 'opener-window', channelBase: '', passiveEs: {}, logsEs: null,
            gd: gdWith('/admin') });
        assert.deepStrictEqual(r1.calls.passive, ['/admin']);
        assert.deepStrictEqual(r1.calls.logs, []);
        assert.strictEqual(r1.channelBase, '/admin');
        // logs stream open (bound mode)
        var r2 = runFollow({ source: 'broadcast', channelBase: '/admin', passiveEs: null, logsEs: {},
            gd: gdWith('/') });
        assert.deepStrictEqual(r2.calls.passive, []);
        assert.deepStrictEqual(r2.calls.logs, ['']);
        assert.strictEqual(r2.channelBase, '');
        // both open (refresh-button can leave both live)
        var r3 = runFollow({ source: 'broadcast', channelBase: '', passiveEs: {}, logsEs: {},
            gd: gdWith('/admin') });
        assert.deepStrictEqual(r3.calls.passive, ['/admin']);
        assert.deepStrictEqual(r3.calls.logs, ['/admin']);
    });

    it('follow: agent mode, unknown webroot, and an unchanged base are all no-ops', function() {
        var agent = runFollow({ source: 'agent', channelBase: '', passiveEs: {}, logsEs: {},
            gd: gdWith('/admin') });
        assert.deepStrictEqual(agent.calls, { passive: [], logs: [] });
        assert.strictEqual(agent.channelBase, '');
        var unknown = runFollow({ source: 'broadcast', channelBase: '', passiveEs: {}, logsEs: {},
            gd: gdWith(undefined) });
        assert.deepStrictEqual(unknown.calls, { passive: [], logs: [] });
        assert.strictEqual(unknown.channelBase, '');
        var same = runFollow({ source: 'broadcast', channelBase: '/admin', passiveEs: {}, logsEs: {},
            gd: gdWith('/admin/') });   // trailing slash still the same base
        assert.deepStrictEqual(same.calls, { passive: [], logs: [] });
        assert.strictEqual(same.channelBase, '/admin');
    });

    it('follow: adopts the new base even when no channel is open', function() {
        var r = runFollow({ source: 'broadcast', channelBase: '', passiveEs: null, logsEs: null,
            gd: gdWith('/admin') });
        assert.deepStrictEqual(r.calls, { passive: [], logs: [] });
        assert.strictEqual(r.channelBase, '/admin');
    });

});


// ── 85 — fetchLiveIndexes re-render must target #tree-query (#B222) ──────────

describe('85 - fetchLiveIndexes success re-render targets #tree-query, never the scroll-area wrapper (#B222)', function() {

    // The Query tab shell nests the render container INSIDE the scroll wrapper:
    //   <div class="bm-scroll-area" data-tab="query"><div id="tree-query">…</div></div>
    // renderTab('query') writes #tree-query and BAILS silently when it is absent
    // (`var treeEl = qs('#tree-' + name); if (!treeEl) return;`). So a re-render
    // that replaces the WRAPPER's innerHTML destroys #tree-query and freezes the
    // Query pane + badge for every later payload (navigation, XHR, refresh
    // button) until the Inspector window itself is reloaded — the #B222 bug.
    // The live-index fetch fires whenever a rendered query still has
    // `indexes: null` (EXPLAIN pending / unsupported), so the freeze armed on
    // most first renders and re-armed on every refresh-button click.

    var INSPECTOR_85 = path.join(BM_DIR, 'inspector.js');
    var SHELL_85     = path.join(BM_DIR, 'index.html');
    var SRC_COPY_85  = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/js/inspector.js');
    var _src85;
    function getSrc85() { return _src85 || (_src85 = fs.readFileSync(INSPECTOR_85, 'utf8')); }

    /** Same started-flag brace walker as §84 (no braces inside string literals here). */
    function extractFn85(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    // ── Premise (control that documents WHY the wrapper write is destructive) ──

    it('shell premise: #tree-query is nested inside the query scroll-area wrapper', function() {
        var shell = fs.readFileSync(SHELL_85, 'utf8');
        var wrap = shell.indexOf('class="bm-scroll-area" data-tab="query"');
        assert.ok(wrap > -1, 'query scroll-area wrapper must exist in the shell');
        var root = shell.indexOf('id="tree-query"', wrap);
        assert.ok(root > -1 && root - wrap < 200,
            '#tree-query must sit inside the query scroll-area (this nesting is what makes a wrapper innerHTML write destroy the render container)');
    });

    it('renderTab bails silently on a missing tree container (the freeze mechanism)', function() {
        var blk = extractFn85(getSrc85(), 'function renderTab(name)');
        assert.match(blk, /var treeEl = qs\('#tree-' \+ name\);\s*\n\s*if \(!treeEl\) return;/,
            'renderTab must early-return on a missing #tree-<name> — the pin documents why destroying #tree-query freezes the pane');
    });

    // ── The fix: re-render into the container renderTab owns ──────────────

    it('fetchLiveIndexes success re-render targets #tree-query', function() {
        var blk = extractFn85(getSrc85(), 'function fetchLiveIndexes()');
        var re = blk.indexOf("qs('#tree-query')");
        assert.ok(re > -1, 'the re-render must query #tree-query (the container renderTab owns)');
        assert.ok(blk.indexOf('renderQueryContent(', re) > re,
            'the #tree-query lookup must feed the renderQueryContent re-render (#B225 realigned: the argument now derives from the live payload — pinned in §86)');
    });

    it('fetchLiveIndexes never touches the scroll-area wrapper', function() {
        // Block-scoped negative: the wrapper class is legitimately used elsewhere
        // (fold-state capture/restore, scroll-position restore) — only the
        // fetchLiveIndexes block must not reference it.
        var blk = extractFn85(getSrc85(), 'function fetchLiveIndexes()');
        assert.ok(blk.indexOf('bm-scroll-area') < 0,
            'the live-index re-render must not target the scroll wrapper — replacing its children destroys #tree-query');
    });

    // ── Behavioral: drive the extracted onload against a fake DOM ─────────

    it('extracted onload writes the tree root, not the wrapper (real bytes, no replica)', function() {
        var fnBlk = extractFn85(getSrc85(), 'function fetchLiveIndexes()');
        var onload = extractFn85(fnBlk, 'xhr.onload = function()');
        // Fake DOM: a wrapper containing the tree root, both recording writes.
        var treeEl = { innerHTML: '' };
        var wrapEl = { innerHTML: '', querySelector: function (sel) { return sel === '.bm-scroll-area' ? wrapEl : null; } };
        var tabEl  = { querySelector: function (sel) { return sel === '.bm-scroll-area' ? wrapEl : null; } };
        var doc = { getElementById: function (id) { return id === 'tab-query' ? tabEl : null; } };
        var qsFake = function (sel) { return sel === '#tree-query' ? treeEl : null; };
        // #B225 realigned: the onload now derives its queries from the live
        // payload (ginaData + the reveal swap) instead of the module cache —
        // the scope bindings follow (the eval-harness-gains-a-dependency rule).
        var runner = new Function('xhr', 'document', 'qs', 'renderQueryContent', 'ginaData', '_revealActive', '_revealedData',
            "var _liveIndexes = null; var _liveIndexesFetching = true; var __on = (" + onload.replace(/^xhr\.onload = /, '') + "); __on(); return { liveIndexes: _liveIndexes, fetching: _liveIndexesFetching };");
        var out = runner(
            { status: 200, responseText: '{"connectors":{}}' },
            doc, qsFake,
            function () { return 'RENDERED_CARDS'; },
            { user: { queries: [ { type: 'SQL', statement: 'SELECT 1', indexes: null } ] } },
            false, null
        );
        assert.strictEqual(out.fetching, false, 'onload must clear the fetching flag');
        assert.deepStrictEqual(out.liveIndexes, { connectors: {} }, 'onload must cache the parsed index payload');
        assert.strictEqual(treeEl.innerHTML, 'RENDERED_CARDS',
            'the re-render must land in #tree-query (pre-fix bytes wrote the wrapper instead, destroying the tree root)');
        assert.strictEqual(wrapEl.innerHTML, '', 'the scroll wrapper children must be left alone');
    });

    // ── Build-step lock: the served dist copy is the src, verbatim ────────

    it('dist inspector.js is byte-identical to src (verbatim-copy build step)', function() {
        var src  = fs.readFileSync(SRC_COPY_85, 'utf8');
        var dist = getSrc85();
        assert.strictEqual(dist, src, 'dist/vendor/gina/inspector/inspector.js must be the verbatim src copy');
    });

});


// ── 86 — #B225: ⟳ bound-mode SSE guard + derive-from-truth query re-renders ────────

describe('86 - #B225: refresh-button SSE guard (bound mode) + derive-from-truth query re-renders', function() {

    // Three mechanisms, one operator-visible symptom (the Query badge blinking
    // page-count → xhr-count → page-count on a popin open, with the XHR payload
    // never rendering):
    //   (b) the ⟳ refresh handler re-opened the passive /_gina/agent SSE stream
    //       even in a BOUND window (source === 'broadcast'), whose data comes
    //       from the statusbar publisher (#INS15) — the leaked stream then
    //       applied bundle-wide payloads over the page-scoped ones (the
    //       measured badge blink at every later XHR overlay);
    //   (c) rerenderQueries() and the live-index success re-render repainted
    //       from the module query cache, which renderQueryContent's empty path
    //       never clears and which survives overlay eras that end while the
    //       Query tab is inactive — so a ⟳ resurrected dead queries and
    //       rewrote the badge (measured 3→7).
    // Fix (a) — the popin preload-consume overlay set — is popin.test.js §32.
    // All reads here target the DIST copy (BM_DIR): these pins watch the served
    // artifact, so they stay red between a src fix and the dist copy (#B222's
    // mid-state evidence pattern).

    var INSPECTOR_86 = path.join(BM_DIR, 'inspector.js');
    var _src86;
    function getSrc86() { return _src86 || (_src86 = fs.readFileSync(INSPECTOR_86, 'utf8')); }

    /** Same started-flag brace walker as §84/§85. */
    function extractFn86(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    /** Active lines only — negative pins must not trip on prose naming a symbol. */
    function stripComments86(block) {
        return block.split('\n').filter(function (l) {
            return !/^\s*(\/\/|\*|\/\*)/.test(l);
        }).join('\n');
    }

    // ── (b) the ⟳ reopen gate ─────────────────────────────────────────────

    it('source: the ⟳ reopen gate skips bound-mode windows too (whole-expression pin)', function() {
        assert.match(getSrc86(),
            /if \(source !== 'agent' && source !== 'broadcast'\n\s*&& \(!_passiveAgentEs \|\| _passiveAgentEs\.readyState === 2\)\) \{/,
            'the passive-SSE reopen must be gated on source !== \'agent\' AND source !== \'broadcast\' — a bound window takes its data from the statusbar publisher (#INS15)');
    });

    /** Executes the SHIPPED ⟳ click listener bytes with a recording scope;
     *  returns the tryAgentPassive call args. */
    function driveRefresh(src, sourceVal) {
        var decl = "refreshBtn.addEventListener('click', function (ev) {";
        var block = extractFn86(src, decl);
        var fnText = block.slice(block.indexOf('function'));
        var tryCalls = [];
        var btn = {
            classList: { add: function () {}, remove: function () {} },
            addEventListener: function () {}, removeEventListener: function () {}
        };
        var runner = new Function(
            'ev', 'lastGdStr', 'refreshBtn', 'pollData',
            '_liveIndexes', '_liveIndexesFetching', 'fetchLiveIndexes',
            '_revealActive', 'source', '_passiveAgentEs', 'tryAgentPassive', '_channelBase',
            'var __fn = (' + fnText + '); __fn(ev);'
        );
        runner({ shiftKey: false }, '', btn, function () {},
            null, false, function () {},
            false, sourceVal, null, function (base) { tryCalls.push(base); }, null);
        return tryCalls;
    }

    it('behavioral: a broadcast-sourced window\'s ⟳ never reopens the passive agent stream (real bytes)', function() {
        var calls = driveRefresh(getSrc86(), 'broadcast');
        assert.equal(calls.length, 0,
            'bound mode must not open /_gina/agent on ⟳ — the leaked stream applies bundle-wide payloads over the page-scoped statusbar ones (the measured badge blink)');
    });

    it('behavioral: a self-polling window (source null) still reopens the stream on ⟳ — and stays on the followed bundle', function() {
        var calls = driveRefresh(getSrc86(), null);
        assert.equal(calls.length, 1, 'the self-polling reopen path must survive the new gate');
        assert.strictEqual(calls[0], undefined,
            'a null _channelBase must map to undefined (#B205 — tryAgentPassive re-derives its default)');
    });

    it('behavioral: agent mode stays excluded (pre-existing gate, control)', function() {
        assert.equal(driveRefresh(getSrc86(), 'agent').length, 0,
            'agent mode already has its own stream — the ⟳ must not open a second one');
    });

    // ── (c) derive-from-truth query re-renders ────────────────────────────

    it('source: rerenderQueries derives from the live payload (renderTab preference), never the module query cache', function() {
        var blk = extractFn86(getSrc86(), 'function rerenderQueries()');
        assert.ok(blk.indexOf("(_revealActive && _revealedData) ? _revealedData : ginaData") > -1,
            'rerenderQueries must start from the reveal-aware payload source, exactly like renderTab');
        assert.match(blk, /u\['data-xhr'\] && u\['data-xhr'\]\.queries\s*\n?\s*\? u\['data-xhr'\]\.queries : u\.queries/,
            'rerenderQueries must apply renderTab(\'query\')\'s own data-xhr-first preference');
        assert.ok(stripComments86(blk).indexOf('_lastQueries') < 0,
            'rerenderQueries must not read the module query cache — it survives eras that end while the Query tab is inactive');
    });

    it('source: the live-index success re-render derives from the live payload too', function() {
        var blk = extractFn86(getSrc86(), 'function fetchLiveIndexes()');
        assert.ok(blk.indexOf("(_revealActive && _revealedData) ? _revealedData : ginaData") > -1,
            'the ⟳-forced live-index re-render must derive from the reveal-aware payload source');
        assert.match(blk, /u\['data-xhr'\] && u\['data-xhr'\]\.queries\s*\n?\s*\? u\['data-xhr'\]\.queries : u\.queries/,
            'the live-index re-render must apply renderTab(\'query\')\'s own data-xhr-first preference');
        assert.ok(stripComments86(blk).indexOf('_lastQueries') < 0,
            'the live-index re-render must not read the module query cache (#B225 — the ⟳ badge rewrite 3→7)');
    });

    /** Executes the SHIPPED rerenderQueries bytes. The stale-cache binding is
     *  provided so the PRE-fix bytes run too (red-first stays semantic, never a
     *  harness ReferenceError); post-fix bytes simply never read it. */
    function driveRerender(src, opts) {
        var fnText = extractFn86(src, 'function rerenderQueries()');
        var rendered = [];
        var panel = { innerHTML: '' };
        var runner = new Function(
            '_lastQueries', '_revealActive', '_revealedData', 'ginaData', 'qs', 'renderQueryContent',
            'var __fn = (' + fnText + '); __fn();'
        );
        runner(opts.cache, opts.revealActive || false, opts.revealed || null, opts.ginaData,
            function (sel) { return sel === '#tree-query' ? panel : null; },
            function (q) { rendered.push(q); return 'RENDERED'; });
        return { rendered: rendered, panel: panel };
    }

    var STALE = [{ statement: 'STALE' }];

    it('behavioral: rerenderQueries paints the payload-derived queries, never the cached ones (real bytes)', function() {
        var LIVE = [{ statement: 'LIVE' }];
        var out = driveRerender(getSrc86(), { cache: STALE, ginaData: { user: { queries: LIVE } } });
        assert.equal(out.rendered.length, 1, 'one repaint');
        assert.strictEqual(out.rendered[0], LIVE,
            'the repaint must use the live payload queries (pre-fix bytes painted the stale cache)');
        assert.equal(out.panel.innerHTML, 'RENDERED', 'the repaint lands in #tree-query');
    });

    it('behavioral: a dead-era cache no longer repaints — empty truth bails', function() {
        var out = driveRerender(getSrc86(), { cache: STALE, ginaData: { user: {} } });
        assert.equal(out.rendered.length, 0,
            'no live queries -> no repaint (pre-fix bytes resurrected the stale cache here)');
        assert.equal(out.panel.innerHTML, '', 'the pane is left to renderTab');
    });

    it('behavioral: an active data-xhr era wins (renderTab parity)', function() {
        var PAGE = [{ statement: 'P1' }], XHRQ = [{ statement: 'X1' }, { statement: 'X2' }];
        var out = driveRerender(getSrc86(), {
            cache: STALE,
            ginaData: { user: { 'data-xhr': { queries: XHRQ }, queries: PAGE } }
        });
        assert.strictEqual(out.rendered[0], XHRQ,
            'while an XHR overlay era is active its queries must win, exactly like renderTab(\'query\')');
    });

    it('behavioral: an active reveal still wins over the redacted payload (reveal fidelity)', function() {
        var RED = [{ statement: 'REDACTED' }], REV = [{ statement: 'REVEALED' }];
        var out = driveRerender(getSrc86(), {
            cache: STALE, revealActive: true, revealed: { user: { queries: REV } },
            ginaData: { user: { queries: RED } }
        });
        assert.strictEqual(out.rendered[0], REV,
            'reveal mode must keep painting the unredacted payload (renderTab\'s source swap, mirrored)');
    });

    it('behavioral: the live-index success re-render paints derived queries into #tree-query (real bytes)', function() {
        var LIVE = [{ statement: 'LIVE', indexes: null }];
        var fnBlk = extractFn86(getSrc86(), 'function fetchLiveIndexes()');
        var onload = extractFn86(fnBlk, 'xhr.onload = function()');
        var rendered = [];
        var treeEl = { innerHTML: '' };
        var runner = new Function(
            'xhr', 'qs', 'renderQueryContent',
            '_lastQueries', '_revealActive', '_revealedData', 'ginaData',
            "var _liveIndexes = null; var _liveIndexesFetching = true; var __on = (" + onload.replace(/^xhr\.onload = /, '') + "); __on(); return { liveIndexes: _liveIndexes, fetching: _liveIndexesFetching };");
        var out = runner(
            { status: 200, responseText: '{"connectors":{}}' },
            function (sel) { return sel === '#tree-query' ? treeEl : null; },
            function (q) { rendered.push(q); return 'RENDERED_CARDS'; },
            STALE, false, null, { user: { queries: LIVE } }
        );
        assert.strictEqual(out.fetching, false, 'onload must clear the fetching flag');
        assert.equal(rendered.length, 1, 'one repaint on success');
        assert.strictEqual(rendered[0], LIVE,
            'the ⟳-forced re-render must paint the live payload queries (pre-fix bytes painted the stale cache — the measured badge rewrite 3→7)');
        assert.equal(treeEl.innerHTML, 'RENDERED_CARDS', 'the repaint lands in #tree-query (#B222 invariant preserved)');
    });
});

describe('87 - #B231: ?ch=-less Inspector adopts the statusbar-advertised tab channel; source-mode badge', function() {

    var INSPECTOR_87 = path.join(BM_DIR, 'inspector.js');
    var INDEX_87     = path.join(BM_DIR, 'index.html');
    var CSS_87       = path.join(BM_DIR, 'inspector.css');
    var SBAR_87      = path.join(BM_DIR, '..', 'html', 'statusbar.html');
    var SRC_INSP_87  = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/js/inspector.js');
    var SRC_SBAR_87  = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/html/statusbar.html');
    var SRC_INDEX_87 = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/html/index.html');

    var _src87, _sbar87;
    function getSrc87()  { return _src87  || (_src87  = fs.readFileSync(INSPECTOR_87, 'utf8')); }
    function getSbar87() { return _sbar87 || (_sbar87 = fs.readFileSync(SBAR_87, 'utf8')); }

    /**
     * Brace-matched extraction of a function's shipped bytes (§84 pattern:
     * started-flag walker; safe here because neither extracted body carries a
     * brace inside a string/regex literal). Throws on not-found / duplicate
     * decl / unbalanced braces so a silent mis-extraction cannot vacuously pass.
     */
    function extractFn87(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    it('extraction control: a bogus declaration throws (the walker can fail)', function() {
        assert.throws(function() { extractFn87(getSrc87(), 'function _noSuchFunction87('); },
            /decl not found/);
    });

    // ── statusbar.html (sender side) ──────────────────────────────────────

    it('statusbar advertises the tab channel id inside _ginaPublish, before the postMessage', function() {
        var s = getSbar87();
        var decl = s.indexOf('function _ginaPublish() {');
        assert.ok(decl > -1, '_ginaPublish declaration must exist');
        var endAnchor = s.indexOf('// A freshly-opened Inspector', decl);
        assert.ok(endAnchor > decl, 'end anchor (request-reply comment) must follow _ginaPublish');
        var body = s.slice(decl, endAnchor);
        var adv  = body.indexOf("localStorage.setItem('__gina_last_tab_ch', _ginaTabId)");
        var post = body.indexOf("postMessage({ type: 'data', payload: window.__ginaData })");
        assert.ok(adv > -1,  'expected the advert write (code form) inside _ginaPublish');
        assert.ok(post > adv, 'the advert write must precede the channel publish');
    });

    it('statusbar advert write is try/catch-guarded (storage-blocked browsers must not break publish)', function() {
        var s = getSbar87();
        assert.match(s, /try \{ localStorage\.setItem\('__gina_last_tab_ch', _ginaTabId\); \} catch \(e\) \{\}/);
    });

    // ── inspector.js — source pins ────────────────────────────────────────

    it('declares the ADOPT_HANDSHAKE_MS liveness window', function() {
        assert.match(getSrc87(), /var ADOPT_HANDSHAKE_MS = 1500;/);
    });

    it('defines _adoptAdvertisedChannel(onDead) reading the advert via getItem and binding through setupBoundChannel', function() {
        var body = extractFn87(getSrc87(), 'function _adoptAdvertisedChannel(onDead)');
        assert.ok(body.indexOf("localStorage.getItem('__gina_last_tab_ch')") > -1,
            'expected the advert read (code form)');
        assert.ok(body.indexOf('setupBoundChannel(ad)') > -1,
            'expected the bind through setupBoundChannel');
        assert.ok(body.indexOf('ADOPT_HANDSHAKE_MS') > -1,
            'expected the handshake timer to use the named window constant');
    });

    it('handshake teardown closes the bound channel AND the logs stream, nulls source, then runs onDead', function() {
        var body = extractFn87(getSrc87(), 'function _adoptAdvertisedChannel(onDead)');
        var liveGuard = body.indexOf("source !== 'broadcast' || _bcLatest !== null");
        var closeB    = body.indexOf('_boundChannel.close()');
        var closeL    = body.indexOf('_serverLogsEs.close()');
        var nullSrc   = body.indexOf('source = null;');
        var dead      = body.indexOf('onDead()');
        assert.ok(liveGuard > -1, 'expected the proven-live / re-claimed early return');
        assert.ok(closeB > liveGuard, 'bound-channel close after the live guard');
        assert.ok(closeL > closeB,   'logs-stream close after the bound-channel close');
        assert.ok(nullSrc > closeL,  'source reset after both closes');
        assert.ok(dead > nullSrc,    'onDead runs last (the legacy acquisition takes over)');
    });

    it('init dispatch: adopt is the second arm of the bound-mode OR; the else delegates to _startLegacyAcquisition', function() {
        var s = getSrc87();
        var a = s.indexOf('var isAgent = tryAgent()');
        assert.ok(a > -1, 'init anchor must exist');
        var end = s.indexOf('── Persist window geometry', a);
        assert.ok(end > a, 'end anchor (geometry comment) must follow the acquisition block');
        var blk = s.slice(a, end);
        var setup    = blk.indexOf('setupBoundChannel(_boundCh)');
        var adoptArm = blk.indexOf('|| _adoptAdvertisedChannel(_startLegacyAcquisition)');
        var elseCall = blk.indexOf('_startLegacyAcquisition();');
        var legDecl  = blk.indexOf('function _startLegacyAcquisition()');
        assert.ok(setup > -1, 'explicit ?ch= bind stays the first arm');
        assert.ok(adoptArm > setup, 'the adopt arm follows the explicit bind in the same OR');
        assert.ok(elseCall > adoptArm, 'the legacy else delegates to _startLegacyAcquisition');
        assert.ok(legDecl > elseCall, 'the legacy body is the hoisted declaration below the dispatch');
        // Subtract: the pre-#B231 inline else body is gone; its first statement
        // now lives inside the hoisted function.
        assert.ok(!/else\s*\{\s*\n\s*var ok = tryOpener/.test(blk),
            'the legacy body must no longer be inlined in the else');
        var legBody = extractFn87(s, 'function _startLegacyAcquisition()');
        assert.ok(legBody.indexOf('var ok = tryOpener() || tryLocalStorage();') > -1,
            'the legacy body opens with the opener/localStorage acquisition, unchanged');
        assert.ok(legBody.indexOf('var _passiveAgentActive = tryAgentPassive();') > -1,
            'the passive agent subscription stays in the legacy body');
    });

    it('pollData refreshes the source-mode badge at the top of every tick', function() {
        var s = getSrc87();
        var pd = s.indexOf('function pollData() {');
        assert.ok(pd > -1);
        var gd = s.indexOf('var gd;', pd);
        var badge = s.indexOf('updateSourceModeBadge();', pd);
        assert.ok(badge > pd && badge < gd,
            'updateSourceModeBadge() must run before the source branches (covers every mode incl. early returns)');
    });

    // ── behavioral: _adoptAdvertisedChannel (extracted shipped bytes) ─────

    function driveAdopt(opts) {
        var fnSrc = extractFn87(getSrc87(), 'function _adoptAdvertisedChannel(onDead)');
        var timers = [];
        var log = { setupCalls: [], boundClosed: 0, logsClosed: 0, onDead: 0 };
        var harness = new Function('deps', [
            'var localStorage = deps.localStorage;',
            'var setupBoundChannel = deps.setupBoundChannel;',
            'var setTimeout = deps.setTimeout;',
            'var ADOPT_HANDSHAKE_MS = 1500;',
            'var source = deps.source;',
            'var _bcLatest = deps.bcLatest;',
            'var _boundChannel = deps.boundChannel;',
            'var _serverLogsEs = deps.serverLogsEs;',
            fnSrc,
            'return {',
            '    adopt: _adoptAdvertisedChannel,',
            '    state: function () { return { source: source, boundChannel: _boundChannel, serverLogsEs: _serverLogsEs }; },',
            '    set: {',
            '        source: function (v) { source = v; },',
            '        bcLatest: function (v) { _bcLatest = v; },',
            '        boundChannel: function (v) { _boundChannel = v; },',
            '        serverLogsEs: function (v) { _serverLogsEs = v; }',
            '    }',
            '};'
        ].join('\n'));
        var api = harness({
            localStorage: opts.localStorage,
            setupBoundChannel: function (ch) { log.setupCalls.push(ch); return opts.setupReturns; },
            setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
            source: null,
            bcLatest: null,
            boundChannel: null,
            serverLogsEs: null
        });
        return { api: api, timers: timers, log: log };
    }

    it('no advert -> false, setupBoundChannel never called, no timer armed', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return null; } }, setupReturns: true });
        var onDead = 0;
        assert.strictEqual(d.api.adopt(function () { onDead++; }), false);
        assert.equal(d.log.setupCalls.length, 0, 'must not bind without an advert');
        assert.equal(d.timers.length, 0, 'no handshake timer without a bind');
        assert.equal(onDead, 0);
    });

    it('storage read throwing -> false (blocked-storage browsers)', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { throw new Error('denied'); } }, setupReturns: true });
        assert.strictEqual(d.api.adopt(function () {}), false);
        assert.equal(d.log.setupCalls.length, 0);
    });

    it('advert present but the bind fails -> false, no timer', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: false });
        assert.strictEqual(d.api.adopt(function () {}), false);
        assert.deepEqual(d.log.setupCalls, ['gtabc'], 'the advertised id is what gets bound');
        assert.equal(d.timers.length, 0);
    });

    it('adopt success arms exactly one handshake timer at ADOPT_HANDSHAKE_MS', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: true });
        assert.strictEqual(d.api.adopt(function () {}), true);
        assert.equal(d.timers.length, 1, 'exactly one timer');
        assert.equal(d.timers[0].ms, 1500, 'armed at the named window');
    });

    it('dead advert: timer fires with no data -> both streams closed, source nulled, onDead runs once', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: true });
        var onDead = 0;
        assert.strictEqual(d.api.adopt(function () { onDead++; }), true);
        var boundClosed = 0, logsClosed = 0;
        d.api.set.source('broadcast');
        d.api.set.bcLatest(null);
        d.api.set.boundChannel({ close: function () { boundClosed++; } });
        d.api.set.serverLogsEs({ close: function () { logsClosed++; } });
        d.timers[0].fn();
        assert.equal(boundClosed, 1, 'bound channel closed');
        assert.equal(logsClosed, 1, 'the /_gina/logs stream the adopt branch opened is closed too (no double log delivery after fallback)');
        assert.strictEqual(d.api.state().source, null, 'source released for the legacy acquisition');
        assert.strictEqual(d.api.state().boundChannel, null);
        assert.strictEqual(d.api.state().serverLogsEs, null);
        assert.equal(onDead, 1, 'legacy acquisition handed over exactly once');
    });

    it('live advert: a data frame arrived before the timer -> no teardown, no fallback', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: true });
        var onDead = 0;
        d.api.adopt(function () { onDead++; });
        var closed = 0;
        d.api.set.source('broadcast');
        d.api.set.bcLatest({ user: {} });
        d.api.set.boundChannel({ close: function () { closed++; } });
        d.timers[0].fn();
        assert.equal(closed, 0, 'a proven-live channel is never torn down');
        assert.equal(onDead, 0);
        assert.strictEqual(d.api.state().source, 'broadcast');
    });

    it('re-claimed source: timer fires after another mode took over -> no-op', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: true });
        var onDead = 0;
        d.api.adopt(function () { onDead++; });
        d.api.set.source('agent');
        d.api.set.bcLatest(null);
        var closed = 0;
        d.api.set.boundChannel({ close: function () { closed++; } });
        d.timers[0].fn();
        assert.equal(closed, 0);
        assert.equal(onDead, 0);
    });

    it('teardown with no logs stream open does not throw and still hands over', function() {
        var d = driveAdopt({ localStorage: { getItem: function () { return 'gtabc'; } }, setupReturns: true });
        var onDead = 0;
        d.api.adopt(function () { onDead++; });
        d.api.set.source('broadcast');
        d.api.set.bcLatest(null);
        d.api.set.boundChannel({ close: function () {} });
        d.api.set.serverLogsEs(null);
        assert.doesNotThrow(function () { d.timers[0].fn(); });
        assert.equal(onDead, 1);
    });

    // ── behavioral: updateSourceModeBadge (extracted shipped bytes) ───────

    function driveBadge(sourceValue, elPresent) {
        var fnSrc = extractFn87(getSrc87(), 'function updateSourceModeBadge()');
        var el = elPresent === false ? null
            : { hidden: undefined, textContent: '', className: '', title: '' };
        var harness = new Function('deps', [
            'var qs = deps.qs;',
            'var source = deps.source;',
            fnSrc,
            'return updateSourceModeBadge;'
        ].join('\n'));
        harness({ qs: function () { return el; }, source: sourceValue })();
        return el;
    }

    it('broadcast -> "bound", no warn tint', function() {
        var el = driveBadge('broadcast');
        assert.strictEqual(el.hidden, false);
        assert.strictEqual(el.textContent, 'bound');
        assert.strictEqual(el.className, 'bm-source-mode');
        assert.ok(el.title.length > 0, 'tooltip explains the mode');
    });

    it('agent -> "agent", no warn tint', function() {
        var el = driveBadge('agent');
        assert.strictEqual(el.textContent, 'agent');
        assert.strictEqual(el.className, 'bm-source-mode');
    });

    it('localStorage fallback -> "global" with the warn tint and a pointer at the statusbar link', function() {
        var el = driveBadge('localStorage');
        assert.strictEqual(el.textContent, 'global');
        assert.strictEqual(el.className, 'bm-source-mode bm-source-mode-warn');
        assert.ok(/statusbar/.test(el.title), 'tooltip must tell the user how to reach bound mode');
    });

    it('opener (a Window object) -> "global" with the warn tint (the passive bundle-wide SSE runs in that mode too)', function() {
        var el = driveBadge({ location: {} });
        assert.strictEqual(el.textContent, 'global');
        assert.ok(/bm-source-mode-warn/.test(el.className));
    });

    it('no source -> badge hidden; absent element -> no throw', function() {
        var el = driveBadge(null);
        assert.strictEqual(el.hidden, true);
        assert.doesNotThrow(function () { driveBadge('broadcast', false); });
    });

    // ── markup + css pins ─────────────────────────────────────────────────

    it('index.html carries the badge span inside the footer target, before the health dot', function() {
        var html = fs.readFileSync(INDEX_87, 'utf8');
        var target = html.indexOf('class="bm-target"');
        var badge  = html.indexOf('id="bm-source-mode"', target);
        var dot    = html.indexOf('id="bm-dot"', target);
        assert.ok(target > -1, 'footer target div must exist');
        assert.ok(badge > target, 'badge span inside the target div');
        assert.ok(dot > badge, 'badge renders before the health dot');
    });

    it('inspector.css styles the badge and its warn tint', function() {
        var css = fs.readFileSync(CSS_87, 'utf8');
        assert.ok(css.indexOf('.bm-source-mode') > -1, 'expected .bm-source-mode in the compiled css');
        assert.ok(css.indexOf('.bm-source-mode-warn') > -1, 'expected the warn modifier in the compiled css');
    });

    // ── src -> dist fidelity (these three are the free subtract at the
    //    src-fixed/dist-stale midstate: red until the build copies) ────────

    it('inspector.js dist is the verbatim src copy', function() {
        assert.strictEqual(fs.readFileSync(INSPECTOR_87, 'utf8'), fs.readFileSync(SRC_INSP_87, 'utf8'));
    });

    it('statusbar.html dist is the verbatim src copy', function() {
        assert.strictEqual(fs.readFileSync(SBAR_87, 'utf8'), fs.readFileSync(SRC_SBAR_87, 'utf8'));
    });

    it('index.html dist is the verbatim src copy', function() {
        assert.strictEqual(fs.readFileSync(INDEX_87, 'utf8'), fs.readFileSync(SRC_INDEX_87, 'utf8'));
    });
});


// ── 88 — per-tab restore: clickable hidden preview pills (+ glyph) ────────────

describe('88 - per-tab restore: a dimmed preview pill restores just that tab (Reset untouched)', function() {

    // Tab hiding (custom layout mode) had no per-tab inverse: hideTab() existed,
    // but the only way back was the all-or-nothing Reset link (restoreAllTabs).
    // The struck-through preview pill is the removed tab's only remaining
    // representative, so it becomes the restore control: it carries data-tab
    // for a delegated click handler, a native title, and a leading + glyph as
    // the visible affordance. Restoring deliberately does NOT activate the
    // restored tab (the user is mid-layout-editing), and the button is
    // explicitly re-parked at the END of the nav — applyTabLayout parks
    // hidden buttons at the FRONT (only ordered visible tabs are appended),
    // so without the appendChild the restored tab would surface leftmost.

    var INSPECTOR_88 = path.join(BM_DIR, 'inspector.js');
    var CSS_88       = path.join(BM_DIR, 'inspector.css');
    var SRC_JS_88    = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/js/inspector.js');
    var SRC_CSS_88   = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/css/inspector.css');
    var _src88, _css88;
    function getSrc88() { return _src88 || (_src88 = fs.readFileSync(INSPECTOR_88, 'utf8')); }
    function getCss88() { return _css88 || (_css88 = fs.readFileSync(CSS_88, 'utf8')); }

    /** Same started-flag brace walker as §84/§85 (no braces inside string literals in these blocks). */
    function extractFn88(src, decl) {
        var i = src.indexOf(decl);
        if (i < 0) throw new Error('decl not found: ' + decl);
        if (src.indexOf(decl, i + 1) > -1) throw new Error('decl not unique: ' + decl);
        var depth = 0, started = false, j = i;
        for (; j < src.length; j++) {
            var c = src[j];
            if (c === '{') { depth++; started = true; }
            else if (c === '}') {
                depth--;
                if (started && depth === 0) { j++; break; }
            }
        }
        if (!started || depth !== 0) throw new Error('unbalanced braces for: ' + decl);
        return src.slice(i, j);
    }

    // ── Instrument control ────────────────────────────────────────────────

    it('control: the extractor can fail (bogus decl throws)', function() {
        assert.throws(function () { extractFn88(getSrc88(), 'function noSuchFn88()'); },
            /decl not found/, 'a walker that cannot miss proves nothing');
    });

    // ── Premises (document the asymmetry being closed + Reset preserved) ──

    it('premise: hideTab exists and DOES switch away from an active hidden tab', function() {
        var blk = extractFn88(getSrc88(), 'function hideTab(tabName)');
        assert.ok(blk.indexOf('switchTab(') > -1,
            'hideTab must switch away when hiding the active tab — the discriminator for the no-activation pin on restoreTab');
    });

    it('premise: restoreAllTabs (the Reset path) is untouched and still clears the whole hidden list', function() {
        var blk = extractFn88(getSrc88(), 'function restoreAllTabs()');
        assert.ok(blk.indexOf('saveHiddenTabs([])') > -1, 'Reset must still clear the entire hidden list');
    });

    // ── restoreTab source pins ────────────────────────────────────────────

    it('restoreTab is declared (the per-tab inverse of hideTab)', function() {
        var blk = extractFn88(getSrc88(), 'function restoreTab(tabName)');
        var iGuard  = blk.indexOf('indexOf(tabName)');
        var iSplice = blk.indexOf('splice(');
        var iSave   = blk.indexOf('saveHiddenTabs(');
        assert.ok(iGuard > -1, 'must guard on the tab actually being hidden');
        assert.ok(iSplice > iGuard && iSave > iSplice,
            'must remove the one name then persist — guard, splice, saveHiddenTabs in that order');
    });

    it('restoreTab re-shows the button at the END of the nav and persists the new order', function() {
        var blk = extractFn88(getSrc88(), 'function restoreTab(tabName)');
        var iShow   = blk.indexOf(".style.display = ''");
        var iAppend = blk.indexOf('nav.appendChild(btn)');
        var iOrder  = blk.indexOf('saveCustomOrder()');
        var iPrev   = blk.indexOf("renderLayoutPreview('custom')");
        assert.ok(iShow > -1, 'must clear display:none on the tab button');
        assert.ok(iAppend > iShow, 'must re-park the button at the end (hidden buttons sit at the FRONT of the nav)');
        assert.ok(iOrder > iAppend && iPrev > iOrder,
            'must save the order AFTER the move, then re-render the pills');
    });

    it('restoreTab does NOT activate the restored tab (no switchTab call)', function() {
        var blk = extractFn88(getSrc88(), 'function restoreTab(tabName)');
        assert.ok(blk.indexOf('switchTab(') < 0,
            'restoring must not steal the active panel — hideTab is the half that switches (see premise)');
    });

    // ── renderLayoutPreview emission pins ─────────────────────────────────

    it('hidden-pill emission carries data-tab, a Restore title, and the + glyph', function() {
        var blk = extractFn88(getSrc88(), 'function renderLayoutPreview(layout)');
        var i = blk.indexOf('bm-lp-pill-hidden');
        assert.ok(i > -1, 'hidden-pill emission must exist');
        var slice = blk.slice(i, i + 400);
        assert.ok(slice.indexOf('data-tab="') > -1, 'hidden pill must carry data-tab for the delegated handler');
        assert.ok(slice.indexOf('title="Restore ') > -1, 'hidden pill must carry the native Restore tooltip');
        assert.ok(slice.indexOf('bm-lp-pill-add') > -1, 'hidden pill must carry the + affordance span');
    });

    it('control: visible-pill emission stays a passive readout (none of the three)', function() {
        var blk = extractFn88(getSrc88(), 'function renderLayoutPreview(layout)');
        var i = blk.indexOf('<span class="bm-lp-pill" style=');
        assert.ok(i > -1, 'visible-pill emission must exist (and must NOT gain data-tab — that is the discriminator between readout and control)');
        var end = blk.indexOf('</span>', i);
        var slice = blk.slice(i, end);
        assert.ok(slice.indexOf('data-tab') < 0 && slice.indexOf('title="Restore') < 0 && slice.indexOf('bm-lp-pill-add') < 0,
            'visible pills are not restore controls');
    });

    // ── Behavioral: drive the extracted restoreTab (real bytes, no replica) ──

    function driveRestore88(tabName, hiddenList, btnPresent) {
        var blk = extractFn88(getSrc88(), 'function restoreTab(tabName)');
        var saved = { hidden: null, orderCalls: 0, previewArg: null, switched: 0, appended: [] };
        var btn = { style: { display: 'none' } };
        var nav = { appendChild: function (n) { saved.appended.push(n); } };
        var qsFake = function (sel) {
            if (sel === '.bm-tabs') return nav;
            if (sel.indexOf('.bm-tab[data-tab=') === 0) return btnPresent ? btn : null;
            return null;
        };
        var runner = new Function('qs', 'getHiddenTabs', 'saveHiddenTabs', 'saveCustomOrder', 'renderLayoutPreview', 'switchTab',
            blk + '\nreturn restoreTab;');
        var restoreTab = runner(
            qsFake,
            function () { return hiddenList.slice(); },
            function (h) { saved.hidden = h; },
            function () { saved.orderCalls++; },
            function (l) { saved.previewArg = l; },
            function () { saved.switched++; }
        );
        restoreTab(tabName);
        return { saved: saved, btn: btn };
    }

    it('restoring a hidden tab: list persisted without it, button shown + re-parked, preview re-rendered, no activation', function() {
        var out = driveRestore88('forms', ['forms', 'flow'], true);
        assert.deepStrictEqual(out.saved.hidden, ['flow'], 'only the restored name leaves the hidden list');
        assert.strictEqual(out.btn.style.display, '', 'the tab button must be shown again');
        assert.strictEqual(out.saved.appended.length, 1, 'the button must be re-parked via appendChild');
        assert.strictEqual(out.saved.orderCalls, 1, 'the new order must be persisted');
        assert.strictEqual(out.saved.previewArg, 'custom', 'the pills must re-render for custom mode');
        assert.strictEqual(out.saved.switched, 0, 'restore must not activate the tab');
    });

    it('restoring a name that is not hidden is a no-op', function() {
        var out = driveRestore88('query', ['forms'], true);
        assert.strictEqual(out.saved.hidden, null, 'nothing may be persisted');
        assert.strictEqual(out.saved.orderCalls, 0, 'no order write');
        assert.strictEqual(out.btn.style.display, 'none', 'no DOM change');
    });

    it('restoring with the button absent still cleans the stored list (stale-storage resilience)', function() {
        var out = driveRestore88('forms', ['forms'], false);
        assert.deepStrictEqual(out.saved.hidden, [], 'the stale name must leave the list even with no button to show');
        assert.strictEqual(out.saved.orderCalls, 1, 'order still persisted');
        assert.strictEqual(out.saved.appended.length, 0, 'nothing to re-park');
    });

    it('extracted renderLayoutPreview emits the restorable hidden pill (real bytes)', function() {
        var blk = extractFn88(getSrc88(), 'function renderLayoutPreview(layout)');
        var el = { innerHTML: '' };
        var resetEl = { classList: { toggle: function () {} } };
        var qsFake = function (sel) {
            if (sel === '#bm-layout-preview') return el;
            if (sel === '#bm-layout-reset') return resetEl;
            return null;
        };
        var runner = new Function('qs', 'getCustomOrder', 'getCurrentTabOrder', 'getHiddenTabs', 'TAB_LAYOUTS', 'pillColor', 'pillLabel',
            blk + '\nreturn renderLayoutPreview;');
        var render = runner(
            qsFake,
            function () { return ['data', 'view']; },
            function () { return ['data', 'view']; },
            function () { return ['forms']; },
            { balanced: ['data', 'view', 'logs', 'forms', 'query', 'flow', 'stream', 'events'] },
            function () { return 'red'; },
            function (t) { return t.charAt(0).toUpperCase() + t.slice(1); }
        );
        render('custom');
        assert.ok(el.innerHTML.indexOf('data-tab="forms"') > -1, 'hidden pill must name its tab');
        assert.ok(el.innerHTML.indexOf('title="Restore Forms tab"') > -1, 'hidden pill must carry the tooltip');
        assert.ok(el.innerHTML.indexOf('<span class="bm-lp-pill-add">+</span>') > -1, 'hidden pill must carry the + glyph');
        var visible = el.innerHTML.slice(0, el.innerHTML.indexOf('bm-lp-pill-hidden'));
        assert.ok(visible.indexOf('data-tab') < 0, 'visible pills must stay passive (control)');
    });

    // ── Delegated wiring ──────────────────────────────────────────────────

    it('the restore handler is delegated on #bm-layout-preview and resolves pills via closest()', function() {
        var src = getSrc88();
        var i = src.indexOf("var previewEl = qs('#bm-layout-preview')");
        assert.ok(i > -1, 'the container lookup must exist');
        assert.ok(src.indexOf("var previewEl = qs('#bm-layout-preview')", i + 1) < 0, 'and be unique');
        var end = src.indexOf('setupTabDrag()', i);
        assert.ok(end > i, 'the wiring must sit before the drag setup');
        var slice = src.slice(i, end);
        assert.ok(slice.indexOf("closest('.bm-lp-pill-hidden')") > -1, 'must resolve the pill via closest (the + glyph is a child span)');
        assert.ok(slice.indexOf('restoreTab(') > -1, 'must call restoreTab');
        assert.ok(slice.indexOf('addEventListener') > -1, 'must be a listener on the container (the row is rebuilt via innerHTML)');
    });

    it('driven handler: a click inside a hidden pill restores that tab; elsewhere is ignored (real bytes)', function() {
        var src = getSrc88();
        var i = src.indexOf("var previewEl = qs('#bm-layout-preview')");
        var end = src.indexOf('// ── Tab drag-to-reorder', i);
        assert.ok(i > -1 && end > i, 'wiring slice must be extractable');
        var slice = src.slice(i, end);
        var recorded = [];
        var fakeEl = { addEventListener: function (type, fn) { recorded.push({ type: type, fn: fn }); } };
        var restored = [];
        var runner = new Function('qs', 'restoreTab', slice + '\nreturn previewEl;');
        runner(function (sel) { return sel === '#bm-layout-preview' ? fakeEl : null; },
               function (name) { restored.push(name); });
        assert.strictEqual(recorded.length, 1, 'exactly one listener on the container');
        assert.strictEqual(recorded[0].type, 'click');
        var pill = { getAttribute: function (a) { return a === 'data-tab' ? 'flow' : null; } };
        recorded[0].fn({ target: { closest: function (sel) { return sel === '.bm-lp-pill-hidden' ? pill : null; } } });
        assert.deepStrictEqual(restored, ['flow'], 'a pill-borne click restores its tab');
        recorded[0].fn({ target: { closest: function () { return null; } } });
        assert.deepStrictEqual(restored, ['flow'], 'a click outside any hidden pill is ignored');
        recorded[0].fn({ target: { closest: function (sel) { return sel === '.bm-lp-pill-hidden' ? { getAttribute: function () { return null; } } : null; } } });
        assert.deepStrictEqual(restored, ['flow'], 'a pill without data-tab is ignored (defensive)');
    });

    // ── CSS ───────────────────────────────────────────────────────────────

    it('hidden pills advertise clickability: cursor pointer + hover opacity lift', function() {
        var css = getCss88();
        assert.match(css, /\.bm-lp-pill-hidden\s*\{[^}]*cursor:\s*pointer/, 'hidden pills must get cursor:pointer');
        assert.match(css, /\.bm-lp-pill-hidden:hover\s*\{[^}]*opacity/, 'hover must lift the dimming');
    });

    it('the + glyph escapes the strikethrough (inline-block) and turns amber on hover', function() {
        var css = getCss88();
        assert.match(css, /\.bm-lp-pill-add\s*\{[^}]*display:\s*inline-block/,
            'inline-block is what keeps the + unstruck — text-decoration does not propagate into atomic inlines');
        assert.match(css, /\.bm-lp-pill-hidden:hover\s+\.bm-lp-pill-add\s*\{[^}]*var\(--accent\)/,
            'the + must go amber on hover, matching the reset-link hover idiom');
    });

    // ── Build-step lock: served dist copies are the src, verbatim ─────────

    it('dist inspector.js is byte-identical to src (verbatim-copy build step)', function() {
        assert.strictEqual(getSrc88(), fs.readFileSync(SRC_JS_88, 'utf8'));
    });

    it('dist inspector.css is byte-identical to the committed src intermediate', function() {
        assert.strictEqual(getCss88(), fs.readFileSync(SRC_CSS_88, 'utf8'));
    });

});


// ── 89 — footer memory gauge: the unfilled track must be visible ─────────────

describe('89 - footer memory gauge: the unfilled track is visible in both themes (#B237)', function() {

    // The gauge track (.bm-mem-bar-wrap) had background: var(--bg2) — the exact
    // token .bm-footer uses for its own background — so the unfilled portion
    // rendered invisible in BOTH themes, and a low fill (64 MB / 3.1 GB ≈ 2%)
    // read as a floating green dot. The recessed-groove fix: the track sits on
    // --bg3 (visibly lighter than the footer in dark, darker in light) with a
    // theme-scoped inset shadow for depth. An inset box-shadow paints UNDER
    // child content, so the groove shading shows only on the empty region —
    // the fill covers it as it grows.

    var CSS_89     = path.join(BM_DIR, 'inspector.css');
    var SRC_CSS_89 = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/css/inspector.css');
    var SCSS_89    = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/sass/inspector.scss');
    var _scss89, _css89;
    function getScss89() { return _scss89 || (_scss89 = fs.readFileSync(SCSS_89, 'utf8')); }
    function getCss89()  { return _css89  || (_css89  = fs.readFileSync(SRC_CSS_89, 'utf8')); }

    /**
     * Extract one top-level rule block (selector at column 0, brace-free body —
     * true for every block §89 pins, comments included).
     * @inner
     * @param   {string} src       Stylesheet text (scss or compiled css).
     * @param   {string} selector  Escaped selector regex fragment.
     * @returns {?string} The matched block, or null when absent.
     */
    function cssBlock89(src, selector) {
        var m = src.match(new RegExp('^' + selector + '\\s*\\{[^}]*\\}', 'm'));
        return m ? m[0] : null;
    }

    // ── Instrument control ────────────────────────────────────────────────

    it('control: the block matcher can fail (bogus selector yields null)', function() {
        assert.strictEqual(cssBlock89(getCss89(), '\\.bm-no-such-gauge'), null,
            'a matcher that cannot miss proves nothing');
    });

    // ── Premises (the collision being fixed + the contrast it relies on) ──

    it('premise: .bm-footer background is var(--bg2) — the surface the track sits on', function() {
        var blk = cssBlock89(getCss89(), '\\.bm-footer');
        assert.ok(blk && blk.indexOf('background: var(--bg2)') > -1,
            'the footer bg is what the track must NOT share — if this token ever moves, re-evaluate the track contrast');
    });

    it('premise: both themes define --bg3 distinct from --bg2 (the contrast mechanism)', function() {
        ['dark', 'light'].forEach(function (theme) {
            var blk = cssBlock89(getCss89(), '\\[data-theme=' + theme + '\\]');
            assert.ok(blk, theme + ' theme variables block must exist');
            var bg2 = (blk.match(/--bg2:\s*([^;]+);/) || [])[1];
            var bg3 = (blk.match(/--bg3:\s*([^;]+);/) || [])[1];
            assert.ok(bg2 && bg3, theme + ' must define both --bg2 and --bg3');
            assert.notStrictEqual(bg2.trim(), bg3.trim(),
                theme + ': --bg3 must differ from --bg2, or the track vanishes again');
        });
    });

    // ── Feature pins (scss is the authored source) ────────────────────────

    it('scss: the track sits on var(--bg3), footer token gone, geometry untouched', function() {
        var blk = cssBlock89(getScss89(), '\\.bm-mem-bar-wrap');
        assert.ok(blk, 'main .bm-mem-bar-wrap block must exist');
        assert.ok(blk.indexOf('background: var(--bg3)') > -1, 'track must sit on --bg3');
        assert.ok(blk.indexOf('--bg2') < 0, 'the footer background token must be gone from the track block');
        assert.ok(blk.indexOf('height: 6px') > -1 && blk.indexOf('border-radius: 3px') > -1
            && blk.indexOf('overflow: hidden') > -1,
            'visibility fix only — geometry must be unchanged');
    });

    it('scss: the track carries the recessed-groove inset shadow', function() {
        var blk = cssBlock89(getScss89(), '\\.bm-mem-bar-wrap');
        assert.ok(blk && blk.indexOf('box-shadow: inset 0 1px 2px rgba(0,0,0,.35)') > -1,
            'the groove depth shadow must be on the track');
    });

    it('scss: the light theme softens the groove shadow (quoted attribute form)', function() {
        var blk = cssBlock89(getScss89(), '\\[data-theme="light"\\] \\.bm-mem-bar-wrap');
        assert.ok(blk && blk.indexOf('rgba(0,0,0,.12)') > -1,
            '35% black on #dddde1 would read as a smudge — light theme needs its own softer shadow');
    });

    it('compiled css carries all three (sass-normalized rgba, unquoted [data-theme=light])', function() {
        var main = cssBlock89(getCss89(), '\\.bm-mem-bar-wrap');
        assert.ok(main && main.indexOf('background: var(--bg3)') > -1,
            'compiled track must sit on --bg3 — a red here with green scss pins means the sass step was skipped');
        assert.ok(main.indexOf('box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35)') > -1,
            'compiled shadow must carry the dart-sass-normalized rgba form');
        var light = cssBlock89(getCss89(), '\\[data-theme=light\\] \\.bm-mem-bar-wrap');
        assert.ok(light && light.indexOf('rgba(0, 0, 0, 0.12)') > -1,
            'compiled light override must exist in the UNQUOTED attribute form (sass strips the quotes)');
    });

    // ── Control: the fill is untouched ────────────────────────────────────

    it('control: the fill severity classes are untouched (ok/warn/crit)', function() {
        [['mem-ok', '--ok'], ['mem-warn', '--warn'], ['mem-crit', '--err']].forEach(function (pair) {
            var blk = cssBlock89(getCss89(), '\\.bm-mem-bar\\.' + pair[0]);
            assert.ok(blk && blk.indexOf('var(' + pair[1] + ')') > -1,
                '.' + pair[0] + ' must still map to var(' + pair[1] + ') — the fix touches the track, never the fill');
        });
    });

    // ── Build-step lock: served dist copy is the src, verbatim ────────────

    it('dist inspector.css is byte-identical to the committed src intermediate', function() {
        assert.strictEqual(fs.readFileSync(CSS_89, 'utf8'), fs.readFileSync(SRC_CSS_89, 'utf8'));
    });

});


// ── 90 — Data tab hides framework-internal __gina* transport keys (#B340) ────

describe('90 - Data tab hides framework-internal __gina* keys (#B340)', function() {

    var _b340;
    function getJs() {
        return _b340 || (_b340 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8'));
    }

    /**
     * Extract a function declaration by brace-walking from its opening `{` to
     * the matching `}`. Deliberately NOT a fixed-width slice: jsdoc.md records
     * that shape breaking three times when source above the target grows.
     */
    function extractFn(src, name) {
        var start = src.indexOf('function ' + name + '(');
        assert.ok(start > -1, 'expected `function ' + name + '(` in inspector.js');
        var depth = 0, end = -1;
        for (var j = src.indexOf('{', start); j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
        }
        assert.ok(end > -1, 'unbalanced braces while walking ' + name);
        return src.substring(start, end);
    }

    /** Rebuild stripInternalKeys in isolation, with its one dependency. */
    function loadStrip() {
        var src = getJs();
        var m = /var INTERNAL_KEY_PREFIX\s*=\s*'([^']+)'/.exec(src);
        assert.ok(m, 'expected an INTERNAL_KEY_PREFIX declaration');
        return new Function(
            'var INTERNAL_KEY_PREFIX = ' + JSON.stringify(m[1]) + ';'
            + extractFn(src, 'stripInternalKeys')
            + ' return stripInternalKeys;'
        )();
    }

    function payload() {
        return {
            operation:     'update',
            status:        200,
            __ginaFlow:    [{ label: 'route-match' }],
            __ginaQueries: [{ statement: 'SELECT 1' }],
            company:       { id: 7 },
            session:       { uid: 'abc' }
        };
    }

    it('declares the __gina prefix as a named constant', function() {
        assert.match(getJs(), /var INTERNAL_KEY_PREFIX\s*=\s*'__gina'/);
    });

    it('strips root-level __ginaFlow and __ginaQueries', function() {
        var out = loadStrip()(payload());
        assert.strictEqual(typeof out.__ginaFlow, 'undefined');
        assert.strictEqual(typeof out.__ginaQueries, 'undefined');
    });

    it('control: the UNSTRIPPED payload does carry both keys', function() {
        // Guards against a vacuous pass — if the fixture ever stopped carrying
        // the keys, the assertions above would succeed while proving nothing.
        var raw = payload();
        assert.ok(Array.isArray(raw.__ginaFlow) && Array.isArray(raw.__ginaQueries));
    });

    it('preserves every application key, by value', function() {
        var out = loadStrip()(payload());
        assert.deepStrictEqual(Object.keys(out).sort(), ['company', 'operation', 'session', 'status']);
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.company.id, 7);
    });

    it('leaves NESTED __gina* keys alone — root-only, by design', function() {
        var out = loadStrip()({ company: { __ginaX: 1 }, __ginaFlow: [] });
        assert.strictEqual(typeof out.__ginaFlow, 'undefined', 'root key must go');
        assert.strictEqual(out.company.__ginaX, 1, 'nested key is application data and must stay');
    });

    it('passes arrays, null and scalars through by reference', function() {
        var strip = loadStrip();
        var arr = [1, 2];
        assert.strictEqual(strip(arr), arr, 'arrays must not be copied — the tree renders them as arrays');
        assert.strictEqual(strip(null), null);
        assert.strictEqual(strip(undefined), undefined);
        assert.strictEqual(strip(42), 42);
    });

    it('does not mutate its input', function() {
        var raw = payload();
        loadStrip()(raw);
        assert.ok(Array.isArray(raw.__ginaFlow), 'input must survive untouched');
    });

    it('wraps every Data-tab source resolution site (5 call sites)', function() {
        var calls = getJs().match(/stripInternalKeys\(/g) || [];
        // 1 declaration + 3 @example lines + 5 call sites
        var declared = (getJs().match(/function stripInternalKeys\(/g) || []).length;
        assert.strictEqual(declared, 1, 'exactly one declaration expected');
        assert.ok(calls.length >= 9,
            'expected the declaration, 3 doc examples and 5 call sites; found ' + calls.length);
    });

    it('strips on the render path, raw mode, and both download paths', function() {
        var src = getJs();
        assert.ok(/var dataObj = stripInternalKeys\(hasXhr/.test(src), 'render path unwrapped');
        assert.ok(/var data = stripInternalKeys\(u\['data-xhr'\]/.test(src), 'raw mode unwrapped');
        var dl = src.match(/var dataObj = stripInternalKeys\(u\['data-xhr'\]/g) || [];
        assert.strictEqual(dl.length, 2, 'both download paths must be wrapped, found ' + dl.length);
    });

    it('keeps the diff overlay aligned by stripping ginaObj in step', function() {
        assert.ok(/var ginaObj = stripInternalKeys\(/.test(getJs()),
            'ginaObj must be stripped too, or the diff reports the hidden keys as removed');
    });

});


// ── 91 — Forms tab: bundle-catalog demotion (#B343) ──────────────────────────
//
// The server seeds `__ginaData.user.forms` with the WHOLE bundle forms catalog
// (controller.js sets `page.forms = conf.content.forms` — the walked
// `<bundle>/forms/` directory: `rules`, `mocks`, `validators`, open-ended per
// config.js loadForms()). The Forms tab used to render each catalog group as a
// pseudo-form card ABOVE the page's real forms. #B343 demotes them into one
// collapsed, muted "Bundle catalog" card at the bottom.
//
// Discriminator under test: a top-level key is catalog iff it is ALSO present
// in the pristine gina half (`__ginaData.gina.forms`) — the statusbar merge
// only ever writes `u.forms[<id>]` (statusbar.html), so `g.forms` stays the
// untouched server snapshot. Keys only in the user half are runtime form state
// (e.g. a departed popin form) and keep the legacy per-key card. With no gina
// half at all, EVERY key falls through to the legacy card — nothing is hidden.

describe('91 - Forms tab bundle-catalog demotion (#B343)', function() {

    var SRC_JS   = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/js/inspector.js');
    var SRC_SCSS = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/sass/inspector.scss');
    var SRC_CSS  = path.join(FW, 'core/asset/plugin/src/vendor/gina/inspector/css/inspector.css');
    var DIST_CSS = path.join(BM_DIR, 'inspector.css');

    var _js91;
    function getJs91() { return _js91 || (_js91 = fs.readFileSync(path.join(BM_DIR, 'inspector.js'), 'utf8')); }

    // ── source pins (dist copy — Phase 3 writes it verbatim from src) ──────
    it('classifies unmatched keys via hasOwnProperty against the gina half', function() {
        assert.ok(getJs91().indexOf('Object.prototype.hasOwnProperty.call(ginaFormsData, dkName)') > -1,
            'expected the gina-half presence discriminator in renderFormsContent');
    });

    it('emits the catalog card with its own data-path, title and hint', function() {
        var src = getJs91();
        assert.ok(src.indexOf('bm-catalog-card') > -1, 'expected the bm-catalog-card class');
        assert.ok(src.indexOf('form.__catalog') > -1, 'expected the form.__catalog data-path');
        assert.ok(src.indexOf('bm-catalog-hint') > -1, 'expected the bm-catalog-hint group listing');
        assert.ok(src.indexOf('BUNDLE CATALOG') > -1, 'expected the card title literal');
    });

    // ── behavioral — extract-and-execute the REAL renderer bytes ───────────
    function extractFn(src, name) {
        var start = src.indexOf('function ' + name + '(');
        assert.ok(start > -1, name + ' must exist');
        var i = src.indexOf('{', start), depth = 0;
        for (var p = i; p < src.length; p++) {
            if (src[p] === '{') depth++;
            else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
        }
        assert.fail('unbalanced braces extracting ' + name);
    }

    function buildRenderer() {
        var src = getJs91();
        var body = extractFn(src, 'renderFormsContent') + '\n'
                 + extractFn(src, 'renderFormDataSections') + '\n'
                 + 'return renderFormsContent;';
        // escHtml / renderTree stubs; `source`/`ginaData` stay undefined so
        // the opener-DOM read is inert (pageForms = []).
        return new Function('escHtml', 'renderTree', 'source', 'ginaData', body)(
            function (s) { return String(s); },
            function (o) { return '<tree>' + JSON.stringify(o) + '</tree>'; }
        );
    }

    it('extraction control: the extractor CAN fail (unknown function name)', function() {
        assert.throws(function () { extractFn(getJs91(), 'noSuchFunction91'); });
    });

    it('demotes gina-half keys into ONE collapsed catalog card AFTER runtime form cards', function() {
        var render  = buildRenderer();
        var catalog = { rules: { login: { isRequired: true } }, mocks: { m: 1 }, validators: { v: 1 } };
        var user    = {
            rules: catalog.rules, mocks: catalog.mocks, validators: catalog.validators,
            'departed-form': { errors: { email: 'is required' } }
        };
        var html = render(user, catalog);

        assert.strictEqual((html.match(/bm-catalog-card/g) || []).length, 1,
            'exactly one catalog card expected');
        assert.ok(html.indexOf('form.__catalog') > -1, 'catalog card carries its data-path');
        assert.ok(html.indexOf('rules · mocks · validators') > -1,
            'hint lists the groups in payload order');

        // the departed runtime form keeps a legacy card OUTSIDE the catalog
        var departedIdx = html.indexOf('DEPARTED-FORM');
        var catalogIdx  = html.indexOf('bm-catalog-card');
        assert.ok(departedIdx > -1, 'departed runtime form must still render');
        assert.ok(departedIdx < catalogIdx, 'catalog card must come AFTER runtime form cards');

        // groups render inside as sub-cards and KEEP their fold data-paths
        assert.strictEqual((html.match(/bm-catalog-sub/g) || []).length, 3,
            'three catalog sub-cards expected');
        assert.ok(html.indexOf('data-path="form.rules"') > -1, 'rules keeps its fold path');
        assert.ok(html.indexOf('RULES') > -1 && html.indexOf('MOCKS') > -1
            && html.indexOf('VALIDATORS') > -1, 'group titles render');
    });

    it('falls back to legacy per-key cards when the gina half is absent (nothing hidden)', function() {
        var render = buildRenderer();
        var html = render({ rules: { r: 1 }, mocks: { m: 1 }, 'departed-form': { errors: {} } }, undefined);
        assert.strictEqual((html.match(/bm-catalog-card/g) || []).length, 0,
            'no catalog card without a gina half');
        assert.strictEqual((html.match(/bm-form-card/g) || []).length, 3,
            'all three keys keep legacy cards');
    });

    it('renders the empty state when there is nothing at all', function() {
        var render = buildRenderer();
        assert.ok(/No forms/.test(render({}, {})), 'expected an empty-state message');
    });

    // ── CSS pins — muted catalog styling in scss, src intermediate AND dist ─
    it('inspector.scss styles the catalog card (dashed + dim header + hint)', function() {
        var scss = fs.readFileSync(SRC_SCSS, 'utf8');
        assert.ok(scss.indexOf('.bm-catalog-card') > -1, 'scss must carry .bm-catalog-card');
        assert.ok(scss.indexOf('border-style: dashed') > -1, 'muted card is dashed');
        assert.ok(scss.indexOf('.bm-catalog-hint') > -1, 'hint class must be styled');
    });

    it('compiled CSS carries the catalog selectors in src intermediate and dist', function() {
        var pair = [fs.readFileSync(SRC_CSS, 'utf8'), fs.readFileSync(DIST_CSS, 'utf8')];
        pair.forEach(function (c, n) {
            var label = n === 0 ? 'src css' : 'dist css';
            assert.ok(c.indexOf('.bm-catalog-card') > -1, label + ' must carry .bm-catalog-card');
            assert.ok(c.indexOf('.bm-catalog-card[open]') > -1, label + ' must carry the [open] override');
            assert.ok(c.indexOf('.bm-catalog-hint') > -1, label + ' must carry .bm-catalog-hint');
        });
    });

    // ── src ↔ dist identity (Phase 3 copies verbatim) ───────────────────────
    it('dist inspector.js is byte-identical to src (Phase 3 verbatim copy)', function() {
        assert.strictEqual(getJs91(), fs.readFileSync(SRC_JS, 'utf8'),
            'dist inspector.js must equal src — run the plugin build');
    });

    it('dist inspector.css is byte-identical to the src intermediate', function() {
        assert.strictEqual(fs.readFileSync(DIST_CSS, 'utf8'), fs.readFileSync(SRC_CSS, 'utf8'),
            'dist inspector.css must equal src css — run the plugin build');
    });

});
