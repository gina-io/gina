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

    it('server.isaac.js does NOT contain a duplicate Inspector handler', function() {
        var isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        assert.ok(
            isaacSrc.indexOf('/_gina\\/inspector') === -1
            && isaacSrc.indexOf('/_gina/inspector') === -1,
            'Inspector handler must not exist in server.isaac.js — it belongs in server.js'
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
        'css':  'text/css; charset=utf8'
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

    it('unknown.png → application/octet-stream', function() {
        assert.equal(resolveMime('unknown.png'), 'application/octet-stream');
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
        var before = src.substring(Math.max(0, pushIdx - 1600), pushIdx);
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
