var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var CMD_DIR = path.join(FW, 'lib/cmd/port');


// ── 01 — Handler file exists and is non-empty ─────────────────────────────────

describe('01 - port:set handler file exists', function() {

    it('set.js exists and is non-empty', function() {
        var f = path.join(CMD_DIR, 'set.js');
        assert.ok(fs.existsSync(f), 'set.js does not exist');
        assert.ok(fs.statSync(f).size > 0, 'set.js is empty');
    });

});


// ── 02 — Source structure: exports a constructor ──────────────────────────────

describe('02 - port:set source structure', function() {

    var src;

    function getSrc() {
        return src || (src = fs.readFileSync(path.join(CMD_DIR, 'set.js'), 'utf8'));
    }

    it('exports Set', function() {
        assert.ok(/module\.exports\s*=\s*Set/.test(getSrc()));
    });

    it('defines function Set(opt, cmd)', function() {
        assert.ok(/function Set\(opt,?\s*cmd\)/.test(getSrc()));
    });

    it('imports CmdHelper', function() {
        assert.ok(getSrc().indexOf('CmdHelper') > -1);
    });

    it('calls isCmdConfigured()', function() {
        assert.ok(getSrc().indexOf('isCmdConfigured()') > -1);
    });

    it('uses lib.logger', function() {
        assert.ok(getSrc().indexOf('lib.logger') > -1);
    });

    it('imports readline for interactive prompts', function() {
        assert.ok(getSrc().indexOf('readline') > -1);
    });

    it('writes to portsPath', function() {
        assert.ok(getSrc().indexOf('self.portsPath') > -1);
    });

    it('writes to portsReversePath', function() {
        assert.ok(getSrc().indexOf('self.portsReversePath') > -1);
    });

    it('uses createFileFromDataSync to persist', function() {
        assert.ok(getSrc().indexOf('createFileFromDataSync') > -1);
    });

});


// ── 03 — Source structure: reserved port range validation ─────────────────────

describe('03 - port:set validates reserved port range', function() {

    var src;

    function getSrc() {
        return src || (src = fs.readFileSync(path.join(CMD_DIR, 'set.js'), 'utf8'));
    }

    it('checks for reserved range 4100-4199', function() {
        assert.ok(getSrc().indexOf('4100') > -1);
        assert.ok(getSrc().indexOf('4199') > -1);
    });

    it('validates port upper bound 65535', function() {
        assert.ok(getSrc().indexOf('65535') > -1);
    });

});


// ── 04 — Pure logic: argv pre-parsing ─────────────────────────────────────────

describe('04 - port:set argv pre-parsing', function() {

    // Replica of the preParseArgs IIFE from set.js
    function preParseArgs(argv) {
        var requestedProtocol = null
            , requestedScheme = null
            , requestedPort   = null
            , requestedEnv    = null
        ;
        var cleaned = argv.slice(0, 3);

        for (var i = 3; i < argv.length; i++) {
            var arg = argv[i];

            // Positional protocol:port
            var m = arg.match(/^([a-z]+\/[0-9.]+)\:(\d+)$/);
            if (m) {
                requestedProtocol = m[1];
                requestedPort     = ~~m[2];
                continue;
            }

            // @project/env
            if ( /^\@[a-z0-9_.]/.test(arg) && arg.indexOf('/') > 0 ) {
                var slash = arg.indexOf('/');
                requestedEnv = arg.substring(slash + 1);
                cleaned.push( arg.substring(0, slash) );
                continue;
            }

            // Flags
            if ( /^\-\-port\=/.test(arg) )     { requestedPort     = ~~arg.split('=')[1]; continue; }
            if ( /^\-\-protocol\=/.test(arg) ) { requestedProtocol = arg.split('=')[1];   continue; }
            if ( /^\-\-scheme\=/.test(arg) )   { requestedScheme   = arg.split('=')[1];   continue; }
            if ( /^\-\-env\=/.test(arg) )      { requestedEnv      = arg.split('=')[1];   continue; }

            cleaned.push(arg);
        }

        return {
            protocol: requestedProtocol,
            scheme:   requestedScheme,
            port:     requestedPort,
            env:      requestedEnv,
            cleaned:  cleaned
        };
    }

    it('parses positional protocol:port', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'http/1.1:3200', 'frontend', '@myproject/dev']);
        assert.equal(result.protocol, 'http/1.1');
        assert.equal(result.port, 3200);
    });

    it('parses http/2.0 protocol', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'http/2.0:8443', 'api', '@myproject/staging']);
        assert.equal(result.protocol, 'http/2.0');
        assert.equal(result.port, 8443);
    });

    it('extracts env from @project/env', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'http/1.1:3200', 'frontend', '@myproject/dev']);
        assert.equal(result.env, 'dev');
    });

    it('passes clean @project to CmdHelper', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'http/1.1:3200', 'frontend', '@myproject/dev']);
        assert.ok(result.cleaned.indexOf('@myproject') > -1);
        assert.ok(result.cleaned.indexOf('@myproject/dev') === -1);
    });

    it('removes protocol:port from cleaned argv', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'http/1.1:3200', 'frontend', '@myproject/dev']);
        assert.ok(result.cleaned.indexOf('http/1.1:3200') === -1);
        assert.ok(result.cleaned.indexOf('frontend') > -1);
    });

    it('parses --protocol= flag', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'frontend', '@myproject', '--protocol=http/1.1']);
        assert.equal(result.protocol, 'http/1.1');
    });

    it('parses --scheme= flag', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'frontend', '@myproject', '--scheme=https']);
        assert.equal(result.scheme, 'https');
    });

    it('parses --port= flag', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'frontend', '@myproject', '--port=3200']);
        assert.equal(result.port, 3200);
    });

    it('parses --env= flag', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'frontend', '@myproject', '--env=staging']);
        assert.equal(result.env, 'staging');
    });

    it('parses all flags together', function() {
        var result = preParseArgs([
            'node', 'gina', 'port:set', 'frontend', '@myproject',
            '--protocol=http/2.0', '--scheme=https', '--port=8443', '--env=production'
        ]);
        assert.equal(result.protocol, 'http/2.0');
        assert.equal(result.scheme, 'https');
        assert.equal(result.port, 8443);
        assert.equal(result.env, 'production');
    });

    it('returns null for missing values', function() {
        var result = preParseArgs(['node', 'gina', 'port:set', 'frontend', '@myproject']);
        assert.equal(result.protocol, null);
        assert.equal(result.scheme, null);
        assert.equal(result.port, null);
        assert.equal(result.env, null);
    });

    it('flags override positional syntax when both present', function() {
        var result = preParseArgs([
            'node', 'gina', 'port:set', 'http/1.1:3200', 'frontend', '@myproject/dev',
            '--port=4200'
        ]);
        // flag --port= takes last-write-wins: 4200 replaces 3200
        assert.equal(result.port, 4200);
    });

});


// ── 05 — Pure logic: port validation ──────────────────────────────────────────

describe('05 - port:set port validation rules', function() {

    function validatePort(port) {
        if ( port < 1 || port > 65535 ) return 'range';
        if ( port >= 4100 && port <= 4199 ) return 'reserved';
        return 'ok';
    }

    it('rejects port 0', function() {
        assert.equal(validatePort(0), 'range');
    });

    it('rejects port 70000', function() {
        assert.equal(validatePort(70000), 'range');
    });

    it('rejects reserved port 4100', function() {
        assert.equal(validatePort(4100), 'reserved');
    });

    it('rejects reserved port 4150', function() {
        assert.equal(validatePort(4150), 'reserved');
    });

    it('rejects reserved port 4199', function() {
        assert.equal(validatePort(4199), 'reserved');
    });

    it('accepts port 4200 (just outside reserved range)', function() {
        assert.equal(validatePort(4200), 'ok');
    });

    it('accepts port 4099 (just below reserved range)', function() {
        assert.equal(validatePort(4099), 'ok');
    });

    it('accepts port 3100 (default start)', function() {
        assert.equal(validatePort(3100), 'ok');
    });

    it('accepts port 65535 (max)', function() {
        assert.equal(validatePort(65535), 'ok');
    });

    it('accepts port 1 (min)', function() {
        assert.equal(validatePort(1), 'ok');
    });

});


// ── 06 — Pure logic: port map operations ──────────────────────────────────────

describe('06 - port:set port map operations', function() {

    // Replica of the forward/reverse map update logic from setPort()
    function applyPort(ports, portsReverse, protocol, scheme, port, bundleName, projectName, env) {
        var bundleKey = bundleName +'@'+ projectName;
        var portValue = bundleKey +'/'+ env;
        var portStr   = ''+ port;

        // Check for conflict
        if (
            typeof(ports[protocol]) != 'undefined'
            && typeof(ports[protocol][scheme]) != 'undefined'
            && typeof(ports[protocol][scheme][portStr]) != 'undefined'
            && ports[protocol][scheme][portStr] !== portValue
        ) {
            return { error: 'conflict', assignedTo: ports[protocol][scheme][portStr] };
        }

        // Remove old assignment for this bundle/env/protocol/scheme
        if ( typeof(ports[protocol]) != 'undefined' && typeof(ports[protocol][scheme]) != 'undefined' ) {
            for (var p in ports[protocol][scheme]) {
                if ( ports[protocol][scheme][p] === portValue ) {
                    delete ports[protocol][scheme][p];
                    break;
                }
            }
        }

        // Ensure structure
        if ( typeof(ports[protocol]) == 'undefined' )          ports[protocol] = {};
        if ( typeof(ports[protocol][scheme]) == 'undefined' )  ports[protocol][scheme] = {};

        // Write
        ports[protocol][scheme][portStr] = portValue;

        // Reverse
        if ( typeof(portsReverse[bundleKey]) == 'undefined' )                       portsReverse[bundleKey] = {};
        if ( typeof(portsReverse[bundleKey][env]) == 'undefined' )                  portsReverse[bundleKey][env] = {};
        if ( typeof(portsReverse[bundleKey][env][protocol]) == 'undefined' )        portsReverse[bundleKey][env][protocol] = {};
        portsReverse[bundleKey][env][protocol][scheme] = ~~port;

        return { error: null, ports: ports, portsReverse: portsReverse };
    }

    it('creates new port entry in empty maps', function() {
        var result = applyPort({}, {}, 'http/1.1', 'http', 3200, 'frontend', 'myproject', 'dev');
        assert.equal(result.error, null);
        assert.equal(result.ports['http/1.1']['http']['3200'], 'frontend@myproject/dev');
        assert.equal(result.portsReverse['frontend@myproject']['dev']['http/1.1']['http'], 3200);
    });

    it('reassigns port (removes old, writes new)', function() {
        var ports = { 'http/1.1': { 'http': { '3100': 'frontend@myproject/dev' } } };
        var portsReverse = { 'frontend@myproject': { 'dev': { 'http/1.1': { 'http': 3100 } } } };
        var result = applyPort(ports, portsReverse, 'http/1.1', 'http', 3200, 'frontend', 'myproject', 'dev');
        assert.equal(result.error, null);
        assert.equal(result.ports['http/1.1']['http']['3200'], 'frontend@myproject/dev');
        assert.equal(typeof(result.ports['http/1.1']['http']['3100']), 'undefined', 'old port should be removed');
    });

    it('detects conflict when port is assigned to a different bundle', function() {
        var ports = { 'http/1.1': { 'http': { '3200': 'backend@myproject/dev' } } };
        var result = applyPort(ports, {}, 'http/1.1', 'http', 3200, 'frontend', 'myproject', 'dev');
        assert.equal(result.error, 'conflict');
        assert.equal(result.assignedTo, 'backend@myproject/dev');
    });

    it('allows setting same port to same bundle/env (idempotent)', function() {
        var ports = { 'http/1.1': { 'http': { '3200': 'frontend@myproject/dev' } } };
        var portsReverse = { 'frontend@myproject': { 'dev': { 'http/1.1': { 'http': 3200 } } } };
        var result = applyPort(ports, portsReverse, 'http/1.1', 'http', 3200, 'frontend', 'myproject', 'dev');
        assert.equal(result.error, null);
        assert.equal(result.ports['http/1.1']['http']['3200'], 'frontend@myproject/dev');
    });

    it('handles multiple protocols in same map', function() {
        var ports = { 'http/1.1': { 'http': { '3100': 'frontend@myproject/dev' } } };
        var portsReverse = {};
        var result = applyPort(ports, portsReverse, 'http/2.0', 'https', 8443, 'frontend', 'myproject', 'dev');
        assert.equal(result.error, null);
        assert.equal(result.ports['http/2.0']['https']['8443'], 'frontend@myproject/dev');
        // original entry untouched
        assert.equal(result.ports['http/1.1']['http']['3100'], 'frontend@myproject/dev');
    });

});


// ── 07 — help.txt documents port:set ──────────────────────────────────────────

describe('07 - help.txt documents port:set', function() {

    var helpPath = path.join(CMD_DIR, 'help.txt');
    var helpSrc;

    function getHelp() {
        return helpSrc || (helpSrc = fs.readFileSync(helpPath, 'utf8'));
    }

    it('help.txt exists', function() {
        assert.ok(fs.existsSync(helpPath));
    });

    it('documents port:set', function() {
        assert.ok(getHelp().indexOf('port:set') > -1);
    });

    it('documents @<project_name> syntax', function() {
        assert.ok(getHelp().indexOf('@<project_name>') > -1);
    });

    it('documents <bundle_name> parameter', function() {
        assert.ok(getHelp().indexOf('<bundle_name>') > -1);
    });

});
