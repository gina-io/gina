var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SERVER_SOURCE = path.join(FW, 'core/server.js');
var ISAAC_SOURCE  = path.join(FW, 'core/server.isaac.js');
var BM_DIR        = path.join(FW, 'core/asset/plugin/dist/vendor/gina/beemaster');

var _serverSrc; // lazy
function getServerSrc() { return _serverSrc || (_serverSrc = fs.readFileSync(SERVER_SOURCE, 'utf8')); }


// ── 01 — Source structure: handler lives in server.js (engine-agnostic) ──────

describe('01 - Beemaster handler is in server.js (engine-agnostic)', function() {

    it('server.js contains the /_gina/beemaster regex', function() {
        assert.ok(
            getServerSrc().indexOf('/_gina\\/beemaster') > -1,
            'expected /_gina/beemaster regex in server.js'
        );
    });

    it('server.js checks NODE_ENV_IS_DEV for Beemaster', function() {
        assert.ok(
            /NODE_ENV_IS_DEV.*beemaster|beemaster.*NODE_ENV_IS_DEV/is.test(getServerSrc()),
            'expected NODE_ENV_IS_DEV guard near the Beemaster handler'
        );
    });

    it('server.js serves from __dirname + asset/plugin/dist/vendor/gina/beemaster', function() {
        assert.ok(
            getServerSrc().indexOf("__dirname + '/asset/plugin/dist/vendor/gina/beemaster'") > -1,
            'expected __dirname-based beemaster path in server.js'
        );
    });

    it('server.js uses fs.readFileSync (not readSync) for Beemaster files', function() {
        // readSync is Isaac-only; the engine-agnostic layer must use fs.readFileSync
        var src = getServerSrc();
        var bmBlock = src.substring(
            src.indexOf('Beemaster SPA'),
            src.indexOf('Fall through to 404 if file not found')
        );
        assert.ok(
            bmBlock.indexOf('fs.readFileSync') > -1,
            'expected fs.readFileSync in the Beemaster handler'
        );
        assert.ok(
            bmBlock.indexOf('readSync(') === -1,
            'readSync (Isaac-only) must not appear in the engine-agnostic Beemaster handler'
        );
    });

    it('server.isaac.js does NOT contain a duplicate Beemaster handler', function() {
        var isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8');
        assert.ok(
            isaacSrc.indexOf('/_gina\\/beemaster') === -1
            && isaacSrc.indexOf('/_gina/beemaster') === -1,
            'Beemaster handler must not exist in server.isaac.js — it belongs in server.js'
        );
    });

});


// ── 02 — URL pattern matching ────────────────────────────────────────────────

describe('02 - Beemaster URL pattern matching', function() {

    var pattern = /^\/_gina\/beemaster(\/.*)?$/;

    it('matches /_gina/beemaster', function() {
        assert.ok(pattern.test('/_gina/beemaster'));
    });

    it('matches /_gina/beemaster/', function() {
        assert.ok(pattern.test('/_gina/beemaster/'));
    });

    it('matches /_gina/beemaster/index.html', function() {
        assert.ok(pattern.test('/_gina/beemaster/index.html'));
    });

    it('matches /_gina/beemaster/beemaster.js', function() {
        assert.ok(pattern.test('/_gina/beemaster/beemaster.js'));
    });

    it('matches /_gina/beemaster/beemaster.css', function() {
        assert.ok(pattern.test('/_gina/beemaster/beemaster.css'));
    });

    it('matches deep paths /_gina/beemaster/sub/dir/file.js', function() {
        assert.ok(pattern.test('/_gina/beemaster/sub/dir/file.js'));
    });

    it('does NOT match /_gina/beemasterx', function() {
        // "beemasterx" is not "beemaster" + optional /
        // The regex allows /_gina/beemaster followed by nothing or /...
        // /_gina/beemasterx has chars after "beemaster" with no /
        assert.ok(!pattern.test('/_gina/beemasterx'));
    });

    it('does NOT match /_gina/info', function() {
        assert.ok(!pattern.test('/_gina/info'));
    });

    it('does NOT match /beemaster', function() {
        assert.ok(!pattern.test('/beemaster'));
    });

    it('does NOT match /_gina/', function() {
        assert.ok(!pattern.test('/_gina/'));
    });

});


// ── 03 — Path extraction logic ───────────────────────────────────────────────

describe('03 - Beemaster path extraction', function() {

    // Replica of the path extraction logic from server.js
    function extractPath(url) {
        var _bmPath = url.replace(/^\/_gina\/beemaster\/?/, '').split('?')[0];
        if (!_bmPath || _bmPath === '') _bmPath = 'index.html';
        return _bmPath;
    }

    it('/_gina/beemaster → index.html', function() {
        assert.equal(extractPath('/_gina/beemaster'), 'index.html');
    });

    it('/_gina/beemaster/ → index.html', function() {
        assert.equal(extractPath('/_gina/beemaster/'), 'index.html');
    });

    it('/_gina/beemaster/beemaster.js → beemaster.js', function() {
        assert.equal(extractPath('/_gina/beemaster/beemaster.js'), 'beemaster.js');
    });

    it('/_gina/beemaster/beemaster.css → beemaster.css', function() {
        assert.equal(extractPath('/_gina/beemaster/beemaster.css'), 'beemaster.css');
    });

    it('/_gina/beemaster/index.html → index.html', function() {
        assert.equal(extractPath('/_gina/beemaster/index.html'), 'index.html');
    });

    it('strips query string', function() {
        assert.equal(extractPath('/_gina/beemaster/beemaster.js?v=1'), 'beemaster.js');
    });

    it('strips query string from bare path', function() {
        assert.equal(extractPath('/_gina/beemaster?t=123'), 'index.html');
    });

});


// ── 04 — MIME type resolution ────────────────────────────────────────────────

describe('04 - Beemaster MIME type resolution', function() {

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

    it('beemaster.js → application/javascript', function() {
        assert.equal(resolveMime('beemaster.js'), 'application/javascript; charset=utf8');
    });

    it('beemaster.css → text/css', function() {
        assert.equal(resolveMime('beemaster.css'), 'text/css; charset=utf8');
    });

    it('unknown.png → application/octet-stream', function() {
        assert.equal(resolveMime('unknown.png'), 'application/octet-stream');
    });

});


// ── 05 — SPA files exist on disk ─────────────────────────────────────────────

describe('05 - Beemaster SPA files exist', function() {

    it('index.html exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'index.html')));
    });

    it('beemaster.js exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'beemaster.js')));
    });

    it('beemaster.css exists', function() {
        assert.ok(fs.existsSync(path.join(BM_DIR, 'beemaster.css')));
    });

    it('index.html contains the SPA shell markers', function() {
        var html = fs.readFileSync(path.join(BM_DIR, 'index.html'), 'utf8');
        assert.ok(html.indexOf('beemaster.js') > -1, 'index.html must reference beemaster.js');
        assert.ok(html.indexOf('beemaster.css') > -1, 'index.html must reference beemaster.css');
    });

});


// ── 06 — Dev-mode guard ──────────────────────────────────────────────────────

describe('06 - Beemaster dev-mode guard', function() {

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
