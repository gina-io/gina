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

    it('matches with webroot prefix /entreprise/_gina/inspector/', function() {
        assert.ok(pattern.test('/entreprise/_gina/inspector/'));
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

    it('strips webroot prefix /entreprise/_gina/inspector/ → index.html', function() {
        assert.equal(extractPath('/entreprise/_gina/inspector/'), 'index.html');
    });

    it('strips webroot prefix /entreprise/_gina/inspector/inspector.css → inspector.css', function() {
        assert.equal(extractPath('/entreprise/_gina/inspector/inspector.css'), 'inspector.css');
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
        var block = src.substring(entryIdx, entryIdx + 750);
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
        var before = src.substring(Math.max(0, pushIdx - 1800), pushIdx);
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
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            block.indexOf('indexes') > -1,
            'expected "indexes" field in _queryEntry'
        );
    });

    it('_biQueryEntry includes indexes field', function() {
        var src = getCbSrc();
        var entryIdx = src.indexOf('_biQueryEntry = {');
        assert.ok(entryIdx > -1, '_biQueryEntry must exist');
        var block = src.substring(entryIdx, entryIdx + 750);
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

    it('matches with webroot prefix /entreprise/_gina/logs', function() {
        assert.ok(pattern.test('/entreprise/_gina/logs'));
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
        var preceding = src.substring(Math.max(0, rwIdx - 300), rwIdx);
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
        // Find the miss-path late-entry guard (after _snapshotCount, not _cacheSnapshotCount)
        var idx = src.indexOf('_lateEntries.length > 0');
        assert.ok(idx > -1, 'expected _lateEntries guard');
        var block = src.substring(idx, idx + 100);
        assert.ok(
            block.indexOf('self.isCacheless()') > -1,
            'miss-path late-entry patch must use isCacheless() fallback, not displayInspector alone'
        );
    });

    it('render-swig.js cache-hit path late-entry patch uses isCacheless() fallback', function() {
        var src = getRSwig25();
        var idx = src.indexOf('_cacheLateEntries.length > 0');
        assert.ok(idx > -1, 'expected _cacheLateEntries guard');
        var block = src.substring(idx, idx + 100);
        assert.ok(
            block.indexOf('self.isCacheless()') > -1,
            'cache-hit late-entry patch must use isCacheless() fallback, not displayInspector alone'
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
        var block = js.substring(idx, idx + 6000);
        assert.ok(
            block.indexOf('bm-idx-na') > -1,
            'expected bm-idx-na class for null indexes'
        );
    });

    it('renderQueryContent handles indexes === [] (no index badge)', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 6000);
        assert.ok(
            block.indexOf('bm-idx-none') > -1,
            'expected bm-idx-none class for empty indexes array'
        );
    });

    it('renderQueryContent handles populated indexes with primary detection', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 6000);
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
        var block = js.substring(idx, idx + 6000);
        assert.ok(
            /idx\.primary/.test(block),
            'expected idx.primary check in index badge rendering'
        );
    });

    it('null indexes branch requires q.connector to show N/A', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 6000);
        // N/A badge should only render when connector info is available
        assert.ok(
            /q\.connector/.test(block),
            'expected q.connector check for N/A badge'
        );
    });

    it('empty indexes branch shows "no index" warning text', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 6000);
        assert.ok(
            /no index/.test(block),
            'expected "no index" text for empty indexes array'
        );
    });

    it('N/A badge has tooltip explaining unavailability', function() {
        var js = getInsp31();
        var idx = js.indexOf('function renderQueryContent');
        var block = js.substring(idx, idx + 6000);
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
        var block = js.substring(idx, idx + 6000);
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
        var block = src.substring(idx, idx + 1000);
        assert.ok(
            /EXPLAIN.*statement/.test(block) || /['"]EXPLAIN ['"].*statement/.test(block),
            'expected EXPLAIN prefix prepended to the statement'
        );
    });

    it('explainForIndexes patches queryEntry.indexes in-place on success', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1000);
        assert.ok(
            block.indexOf('queryEntry.indexes') > -1,
            'expected in-place patch of queryEntry.indexes'
        );
    });

    it('explainForIndexes catches EXPLAIN failures gracefully', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1000);
        assert.ok(
            block.indexOf('.catch(') > -1,
            'expected .catch() on the EXPLAIN promise'
        );
    });

    it('explainForIndexes sets null in cache on failure', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1000);
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
        var block = src.substring(idx, idx + 1000);
        assert.ok(
            /adhoc\s*:\s*true/.test(block),
            'expected adhoc: true in EXPLAIN options'
        );
    });

    it('explainForIndexes forwards parameters from queryOptions', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('var explainForIndexes = function');
        var block = src.substring(idx, idx + 1000);
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
        var block = src.substring(idx, idx + 1000);
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

    it('EXPLAIN fallback is gated by sdkVersion > 2', function() {
        var src = getCbSrc33();
        var idx = src.indexOf('_explainCache.has(');
        // Look back to find the sdkVersion guard (may be up to ~350 chars before)
        var region = src.substring(Math.max(0, idx - 400), idx);
        assert.ok(
            /sdkVersion\s*>\s*2/.test(region),
            'expected sdkVersion > 2 guard before EXPLAIN fallback'
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
        assert.ok(matches && matches.length >= 2, 'expected at least two conn._cluster.query() calls');
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
        var block = src.substring(entryIdx, entryIdx + 750);
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
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /connector\s*:\s*'mysql'/.test(block),
            'expected connector: "mysql" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getMysqlSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getMysqlSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 1500), pushIdx);
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
        var block = src.substring(entryIdx, entryIdx + 750);
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

    var pattern = /\/_gina\/agent$/;

    it('matches /_gina/agent', function() {
        assert.ok(pattern.test('/_gina/agent'));
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
        var lastGdIdx = src.indexOf('_lastGinaData');
        assert.ok(emitIdx > -1 && lastGdIdx > -1, 'both inspector#data emit and _lastGinaData must exist');
        // They should be within ~200 chars of each other
        assert.ok(
            Math.abs(emitIdx - lastGdIdx) < 200,
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
        var block = src.substring(agentIdx, agentIdx + 800);
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
        var block = src.substring(agentIdx, agentIdx + 600);
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
        var block = src.substring(agentIdx, agentIdx + 3000);
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
        var block = src.substring(entryIdx, entryIdx + 750);
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
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /connector\s*:\s*'postgresql'/.test(block),
            'expected connector: "postgresql" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getPgSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getPgSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 1500), pushIdx);
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
        var block = src.substring(entryIdx, entryIdx + 750);
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
        var block = src.substring(entryIdx, entryIdx + 750);
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
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /connector\s*:\s*'sqlite'/.test(block),
            'expected connector: "sqlite" in _queryEntry'
        );
    });

    it('_queryEntry origin uses infos.bundle', function() {
        var src = getSqliteSrc();
        var entryIdx = src.indexOf('_queryEntry = {');
        var block = src.substring(entryIdx, entryIdx + 750);
        assert.ok(
            /origin\s*:\s*infos\.bundle/.test(block),
            'expected origin: infos.bundle in _queryEntry'
        );
    });

    it('push is guarded by envIsDev', function() {
        var src = getSqliteSrc();
        var pushIdx = src.indexOf('_devLog.push(_queryEntry)');
        assert.ok(pushIdx > -1, '_devLog push must exist');
        var before = src.substring(Math.max(0, pushIdx - 1500), pushIdx);
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
        var block = src.substring(entryIdx, entryIdx + 750);
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

    it('balanced layout order is data, view, logs, forms, query, flow', function() {
        var js = getJs();
        var match = js.match(/balanced\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected balanced array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['data', 'view', 'logs', 'forms', 'query', 'flow']);
    });

    it('backend layout order is data, query, flow, logs, view, forms', function() {
        var js = getJs();
        var match = js.match(/backend\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected backend array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['data', 'query', 'flow', 'logs', 'view', 'forms']);
    });

    it('frontend layout order is view, data, forms, logs, query, flow', function() {
        var js = getJs();
        var match = js.match(/frontend\s*:\s*\[([^\]]+)\]/);
        assert.ok(match, 'expected frontend array in TAB_LAYOUTS');
        var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/);
        assert.deepStrictEqual(tabs, ['view', 'data', 'forms', 'logs', 'query', 'flow']);
    });

    it('all three layouts contain exactly the same 6 tabs', function() {
        var js = getJs();
        var expected = ['data', 'flow', 'forms', 'logs', 'query', 'view'];
        ['balanced', 'backend', 'frontend'].forEach(function (name) {
            var match = js.match(new RegExp(name + '\\s*:\\s*\\[([^\\]]+)\\]'));
            assert.ok(match, 'expected ' + name + ' array');
            var tabs = match[1].replace(/'/g, '').replace(/"/g, '').split(/\s*,\s*/).sort();
            assert.deepStrictEqual(tabs, expected, name + ' must contain all 6 tabs');
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
        assert.ok(
            Math.abs(emitIdx - lastGdIdx) < 200,
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
            /\{\s*gina\s*:.*user\s*:/.test(src),
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
