/**
 * #B160 / #B161 — control-plane dial-host resolution and bind_host
 * persistence.
 *
 * #B160: the daemon binds `bind_host` (loopback by default) while CLI-side
 * clients dialled `host_v4` — unreachable from the daemon's own host whenever
 * `host_v4` is a non-loopback address of this machine. The fix resolves the
 * DIAL host through lib/net-locality at all four dial sites (command socket,
 * MQ speaker, MQ file container, `gina tail`); the bind side is untouched.
 *
 * #B320 tightened the two INTRA-HOST transports (MQ speaker + file container,
 * §02/§03): their listener is co-located by construction, so `host_v4` — which
 * on a shared or stale `~/.gina` can name ANOTHER machine — is no longer an
 * input of their dial at all. They resolve through resolveLocalDialHost
 * (bind side only, env first). The operator-facing clients (§01 command
 * socket, §04 tail) deliberately keep the #B160 resolution, remote dial
 * included. Behavioral coverage of the #B320 delivery lives in
 * test/lib/logger-mq-speaker-local-dial.test.js.
 *
 * #B161: a `bind_host` persisted via `gina framework:set --bind-host=` was
 * clobbered back to the default by (a) the settings regeneration in
 * framework/init.js::checkIfSettings — bind_host was the only connection key
 * without a disk -> env read-back — and (b) bin/gina-init's unconditional
 * settings.json overwrite with a hardcoded loopback value.
 *
 * Source pins lock the structural invariants (behavioral coverage of the
 * resolution itself lives in test/lib/net-locality.test.js); bin/gina-init is
 * additionally driven for REAL (spawned into an isolated temp home) because
 * its correctness is a runtime value: which bind_host survives the rewrite.
 *
 * Run: node --test test/bin/control-plane-dial.test.js
 */
'use strict';

var assert = require('node:assert');
var { describe, it, after } = require('node:test');
var fs   = require('fs');
var os   = require('os');
var path = require('path');
var { spawnSync } = require('child_process');

var FW          = require('../fw');
var GINA_ROOT   = path.resolve(__dirname, '..', '..');
var CLI_SOURCE  = path.join(GINA_ROOT, 'bin', 'cli');
var GINA_INIT   = path.join(GINA_ROOT, 'bin', 'gina-init');
var SPEAKER     = path.join(FW, 'lib/logger/src/containers/mq/speaker.js');
var TAIL        = path.join(FW, 'lib/cmd/framework/tail.js');
var INIT        = path.join(FW, 'lib/cmd/framework/init.js');

var cliSrc     = fs.readFileSync(CLI_SOURCE, 'utf8');
var ginaInitSrc = fs.readFileSync(GINA_INIT, 'utf8');
var speakerSrc = fs.readFileSync(SPEAKER, 'utf8');
var tailSrc    = fs.readFileSync(TAIL, 'utf8');
var initSrc    = fs.readFileSync(INIT, 'utf8');

var STAMP    = Date.now();
var TMP_BASE = path.join(os.tmpdir(), 'gina-control-plane-dial-test-' + STAMP);

/**
 * Runs the REAL bin/gina-init into an isolated temp home.
 * Mirrors the image-build.test.js helper: gina-init is the one bin that reads
 * raw process.env (its own documented convention), so the home and any
 * bind_host override are passed via env.
 *
 * @param {string} homedir - Isolated GINA_HOMEDIR for this arm
 * @param {object} [envOverrides] - Extra env vars (e.g. GINA_BIND_HOST)
 * @returns {object} { status, stdout, stderr, settings }
 */
function runGinaInit(homedir, envOverrides) {
    fs.mkdirSync(homedir, { recursive: true });
    var env = Object.assign({}, process.env, {
        GINA_HOMEDIR      : homedir,
        // minimal bootstrap identity — gina-init refuses to run without a project
        GINA_PROJECT_NAME : 'demo',
        GINA_BUNDLES      : 'web'
    }, envOverrides || {});
    delete env.GINA_INIT_CONFIG;
    if (!envOverrides || typeof envOverrides.GINA_BIND_HOST === 'undefined') {
        // an ambient GINA_BIND_HOST would contaminate the no-env arms
        delete env.GINA_BIND_HOST;
    }
    var r = spawnSync(process.execPath, [GINA_INIT], { env: env, encoding: 'utf8', timeout: 30000 });
    var settingsPath = findSettings(homedir);
    return {
        status   : r.status,
        stdout   : r.stdout || '',
        stderr   : r.stderr || '',
        settings : settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null,
        settingsPath : settingsPath
    };
}

/**
 * Locates the `<shortVersion>/settings.json` gina-init wrote, without
 * hardcoding the short version.
 *
 * @param {string} homedir
 * @returns {string|null}
 */
function findSettings(homedir) {
    var entries = [];
    try { entries = fs.readdirSync(homedir); } catch (e) { return null; }
    for (var i = 0; i < entries.length; i++) {
        var candidate = path.join(homedir, entries[i], 'settings.json');
        if (/^\d+\.\d+$/.test(entries[i]) && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

after(function () {
    try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 01. bin/cli — the command-socket dial (#B160 site 1)
// ---------------------------------------------------------------------------

describe('01 - bin/cli dials through the locality resolver', function () {

    it('resolves the dial host from (hostV4, bindHost) before connecting', function () {
        assert.match(cliSrc, /var dialHost = lib\.netLocality\.resolveDialHost\(hostV4, bindHost\);/);
    });

    it('net.connect targets the resolved dial host', function () {
        assert.match(cliSrc, /net\.connect\(\{port: port, host: dialHost\}/);
    });

    it('no longer dials host_v4 directly', function () {
        assert.equal(cliSrc.indexOf('net.connect({port: port, host: hostV4}'), -1,
            'the raw host_v4 dial must be gone');
    });

    it('the refused-connection error names the dial target and bind_host', function () {
        assert.match(cliSrc, /Could not reach the framework command socket at/);
        var errIdx = cliSrc.indexOf('Could not reach the framework command socket at');
        var errBlock = cliSrc.substring(errIdx, errIdx + 400);
        assert.ok(errBlock.indexOf('dialHost') > -1, 'error must interpolate the dial target');
        assert.ok(errBlock.indexOf('bind_host') > -1, 'error must name the bind_host knob');
        assert.ok(errBlock.indexOf('GINA_BIND_HOST') > -1, 'error must name the env var');
    });
});

// ---------------------------------------------------------------------------
// 02. MQ speaker (#B160 site 2)
// ---------------------------------------------------------------------------

describe('02 - the MQ speaker dials through the locality resolver', function () {

    it('requires lib/net-locality by relative path (registry unavailable that early)', function () {
        assert.match(speakerSrc, /var netLocality = require\(__dirname \+ '\/\.\.\/\.\.\/\.\.\/\.\.\/net-locality'\);/);
    });

    it('threads the settings bind_host onto opt for the dial', function () {
        assert.match(speakerSrc, /opt\.bindHost = settings\.bind_host;/);
    });

    it('resolves the dial host from the bind side ONLY (#B320 — host_v4 is not an input)', function () {
        assert.match(speakerSrc, /var host = netLocality\.resolveLocalDialHost\(_envBindHost \|\| opt\.bindHost\);/);
    });

    it('the env tier reads GINA_BIND_HOST guarded, with the process.env fallback the early-call window needs', function () {
        assert.match(speakerSrc,
            /var _envBindHost = \(typeof getEnvVar === 'function' && getEnvVar\('GINA_BIND_HOST'\)\)\s*\|\| process\.env\.GINA_BIND_HOST \|\| null;/);
    });

    it('the host_v4-consulting resolver call is gone from the speaker (whole file)', function () {
        // #B320 inverse pin: the speaker must never route through the
        // operator-facing resolver again — its remote-unchanged rule is what
        // shipped log frames to a foreign machine. Whole-source, and the token
        // is code-unique (comments name the rule, never this call form).
        assert.equal(speakerSrc.indexOf('netLocality.resolveDialHost('), -1);
    });

    it('the raw host_v4 dial assignment is gone', function () {
        assert.equal(speakerSrc.indexOf("var host = opt.hostV4 || '127.0.0.1';"), -1);
    });
});

// ---------------------------------------------------------------------------
// 03. (retired) MQ file container — the file container no longer dials.
//
// It became an in-process sink (#B526/#B527): it consumes the `logger#file`
// event `emit()` raises and opens no socket at all, so there is no dial left
// for the #B160/#B320 host-resolution contract to constrain. That contract is
// still pinned for every site that DOES dial — the MQ speaker in 02 and gina
// tail in 04 below, both unchanged. `test/lib/logger-file-rotation.test.js`
// now pins the absence of the dial from the other side.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 04. gina tail (#B160 site 4 — the consumer-visible [MQTail] emitter)
// ---------------------------------------------------------------------------

describe('04 - gina tail dials through the locality resolver', function () {

    it('requires lib/net-locality by relative path', function () {
        assert.match(tailSrc, /var netLocality\s+= require\(__dirname \+ '\/\.\.\/\.\.\/net-locality'\);/);
    });

    it('resolves the dial host from (hostV4, bindHost)', function () {
        assert.match(tailSrc, /var host = netLocality\.resolveDialHost\(opt\.hostV4 \|\| GINA_HOST_V4 \|\| '127\.0\.0\.1', getEnvVar\('GINA_BIND_HOST'\)\);/);
    });

    it('the raw host_v4 dial assignment is gone', function () {
        assert.equal(tailSrc.indexOf("var host = opt.hostV4 || GINA_HOST_V4 || '127.0.0.1';"), -1);
    });
});

// ---------------------------------------------------------------------------
// 05. framework/init.js — the #B161 disk -> env read-back
// ---------------------------------------------------------------------------

describe('05 - checkIfSettings reads bind_host back from disk before regenerating', function () {

    it('the read-back block exists, contiguous and placeholder-guarded', function () {
        assert.match(initSrc,
            /if \( !getEnvVar\('GINA_BIND_HOST'\) && targetObj\.existsSync\(\) \) \{\s*if \( typeof\(localUserSettings\.bind_host\) != 'undefined' && String\(localUserSettings\.bind_host\)\.indexOf\('\$\{'\) < 0 \) \{\s*setEnvVar\('GINA_BIND_HOST', localUserSettings\.bind_host\);/);
    });

    it('the read-back runs BEFORE the regeneration consumes GINA_BIND_HOST', function () {
        var readBackIdx = initSrc.indexOf("setEnvVar('GINA_BIND_HOST', localUserSettings.bind_host)");
        var consumeIdx  = initSrc.indexOf("'bind_host' : getEnvVar('GINA_BIND_HOST') || '127.0.0.1'");
        assert.ok(readBackIdx > -1, 'read-back must exist');
        assert.ok(consumeIdx > -1, 'the dic consumption site must exist');
        assert.ok(readBackIdx < consumeIdx,
            'the disk -> env seed must precede the dic build, or the regeneration clobbers the persisted value');
    });

    it('bind_host keeps parity with the sibling host_v4 read-back', function () {
        // the asymmetry WAS the bug: every other connection key had a read-back
        assert.match(initSrc, /if \( !getEnvVar\('GINA_HOST_V4'\) && targetObj\.existsSync\(\) \)/);
        assert.match(initSrc, /if \( !getEnvVar\('GINA_BIND_HOST'\) && targetObj\.existsSync\(\) \)/);
    });
});

// ---------------------------------------------------------------------------
// 06. bin/gina-init — env/file-preserving bind_host (#B161, second clobber)
// ---------------------------------------------------------------------------

describe('06 - gina-init preserves an operator-set bind_host', function () {

    it('source: bind_host resolves env-first, then the persisted value, then loopback', function () {
        assert.match(ginaInitSrc, /bind_host\s+:\s+process\.env\.GINA_BIND_HOST \|\| prevBindHost \|\| '127\.0\.0\.1',/);
    });

    it('source: the hardcoded loopback assignment is gone', function () {
        assert.doesNotMatch(ginaInitSrc, /bind_host\s+:\s+'127\.0\.0\.1',/);
    });

    it('source: the previous value is read from settings.json with a placeholder guard', function () {
        assert.match(ginaInitSrc, /prevBindHost = JSON\.parse\(_prevSettingsRaw\)\.bind_host \|\| null;/);
        assert.match(ginaInitSrc, /String\(prevBindHost\)\.indexOf\('\$\{'\) > -1/);
    });

    it('behaviour: a fresh bootstrap defaults to loopback', function () {
        var home = path.join(TMP_BASE, 'init-fresh');
        var r = runGinaInit(home);
        assert.equal(r.status, 0, 'gina-init failed: ' + r.stdout + r.stderr);
        assert.ok(r.settings, 'settings.json must be written');
        assert.equal(r.settings.bind_host, '127.0.0.1');
    });

    it('behaviour: a persisted bind_host SURVIVES the next bootstrap', function () {
        var home = path.join(TMP_BASE, 'init-preserve');
        var r1 = runGinaInit(home);
        assert.equal(r1.status, 0, 'first run failed: ' + r1.stdout + r1.stderr);
        var s = JSON.parse(fs.readFileSync(r1.settingsPath, 'utf8'));
        s.bind_host = '10.1.2.3';
        fs.writeFileSync(r1.settingsPath, JSON.stringify(s, null, 4) + '\n', 'utf8');
        var r2 = runGinaInit(home);
        assert.equal(r2.status, 0, 'second run failed: ' + r2.stdout + r2.stderr);
        assert.equal(r2.settings.bind_host, '10.1.2.3',
            'the unconditional settings.json rewrite must no longer discard the operator value');
    });

    it('behaviour: GINA_BIND_HOST env wins over the persisted value', function () {
        var home = path.join(TMP_BASE, 'init-env-wins');
        var r1 = runGinaInit(home);
        assert.equal(r1.status, 0);
        var s = JSON.parse(fs.readFileSync(r1.settingsPath, 'utf8'));
        s.bind_host = '10.1.2.3';
        fs.writeFileSync(r1.settingsPath, JSON.stringify(s, null, 4) + '\n', 'utf8');
        var r2 = runGinaInit(home, { GINA_BIND_HOST: '10.9.9.9' });
        assert.equal(r2.status, 0);
        assert.equal(r2.settings.bind_host, '10.9.9.9');
    });

    it('behaviour: an unresolved template placeholder is skipped, not preserved', function () {
        var home = path.join(TMP_BASE, 'init-placeholder');
        var r1 = runGinaInit(home);
        assert.equal(r1.status, 0);
        var s = JSON.parse(fs.readFileSync(r1.settingsPath, 'utf8'));
        s.bind_host = '${bind_host}';
        fs.writeFileSync(r1.settingsPath, JSON.stringify(s, null, 4) + '\n', 'utf8');
        var r2 = runGinaInit(home);
        assert.equal(r2.status, 0);
        assert.equal(r2.settings.bind_host, '127.0.0.1');
    });
});
