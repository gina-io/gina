/**
 * script/pre_install.js + script/post_install.js — #B126 guarded npm-prefix probe.
 *
 * `npm config get prefix` REFUSES the read (exit 1: "The prefix option is
 * protected, and cannot be retrieved in this way") whenever the RESOLVED VALUE
 * trips npm's redactor (npm lib/commands/config.js `isPrivate(key, val)` =
 * `isProtected(k) || redact(v) !== v`) — e.g. a prefix path containing a
 * UUID-shaped segment (a CI sandbox, a generated workspace dir). Measured on
 * npm 10.9.8 / 11.6.2 / 11.18.0 / 12.0.1 — every current generation; the
 * option's SOURCE (flag, env, npmrc) is irrelevant, only the VALUE matters.
 * Both install scripts ran the probe unguarded at configure() start, so the
 * refusal killed the whole `npm install -g gina` (pre_install died first;
 * post_install carried the identical probe one phase later).
 *
 * Post-fix: the probe sits in a try/catch in BOTH scripts; on refusal the
 * default prefix falls back to the lifecycle-exported `npm_config_prefix`
 * (npm exports the effective prefix to script children — measured in a real
 * `-g --prefix` lifecycle) and, last resort, the node-derived default prefix
 * (`path.resolve(process.execPath, '..', '..')`).
 *
 * Since #B663 the probe is an argument vector — `execFileSync('npm', ['config',
 * 'get', 'prefix', '--quiet'])`, no shell: the `$(which npm)` form split an npm
 * installed under a path containing a space. The §01 pins read comment-stripped
 * source, so the pre-#B663 line kept as a comment can neither satisfy them nor
 * count as a second probe.
 *
 * Sections:
 *   01 — source pins: probe-inside-try + fallback chain, in BOTH scripts
 *   02 — behavioural replica against a refusing npm SHIM (deterministic — no
 *        dependency on the host npm's redaction gate), incl. the pre-fix
 *        subtract reproducing the crash
 *
 * Usage: node --test test/lib/pre-install-prefix-probe.test.js
 */

var path   = require('path');
var assert = require('assert');
var fs     = require('fs');
var os     = require('os');
var cp     = require('child_process');

var describe = require('node:test').describe;
var it       = require('node:test').it;

var REPO     = path.join(__dirname, '..', '..');
var PRE_SRC  = fs.readFileSync(path.join(REPO, 'script/pre_install.js'),  'utf8');
var POST_SRC = fs.readFileSync(path.join(REPO, 'script/post_install.js'), 'utf8');

// the scripts without their whole-line comments (the pins below read these)
function activeSource(src) {
    return src.split('\n').filter(function(l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
var PRE_ACTIVE  = activeSource(PRE_SRC);
var POST_ACTIVE = activeSource(POST_SRC);

var PROBE_CMD = "['config', 'get', 'prefix', '--quiet']";


function assertGuardedProbe(src, label) {
    var probeIdx = src.indexOf(PROBE_CMD);
    assert.ok(probeIdx > -1, label + ': the prefix probe must exist');
    // exactly one probe per script — a second unguarded copy would resurrect
    // the crash class
    assert.equal(src.indexOf(PROBE_CMD, probeIdx + 1), -1, label + ': exactly one probe');
    // the probe line sits directly inside a try block …
    var tryIdx = src.lastIndexOf('try {', probeIdx);
    assert.ok(tryIdx > -1 && probeIdx - tryIdx < 120, label + ': probe must open inside a try block');
    // … whose catch applies the fallback chain
    var catchIdx = src.indexOf('catch (probeErr)', probeIdx);
    assert.ok(catchIdx > -1 && catchIdx - probeIdx < 240, label + ': catch (probeErr) must follow the probe');
    var catchWin = src.slice(catchIdx, catchIdx + 500);
    assert.ok(catchWin.indexOf('process.env.npm_config_prefix') > -1,
        label + ': fallback must read the lifecycle-exported npm_config_prefix');
    assert.ok(/require\(\s*'path'\s*\)\.resolve\(\s*process\.execPath\s*,\s*'\.\.'\s*,\s*'\.\.'\s*\)/.test(catchWin),
        label + ': last resort must be the node-derived default prefix');
}


describe('01 - guarded prefix-probe source pins (#B126)', function() {

    it('pre_install.js guards the probe with the fallback chain', function() {
        assertGuardedProbe(PRE_ACTIVE, 'pre_install');
    });

    it('post_install.js guards the identical probe the same way', function() {
        assertGuardedProbe(POST_ACTIVE, 'post_install');
    });

    it('neither script keeps an UNGUARDED bare-assignment probe', function() {
        // the pre-fix shape was a column-aligned bare assignment (6 spaces
        // before `=`), never inside a try — its disappearance plus the
        // exactly-one + inside-try pins above close the class
        assert.doesNotMatch(PRE_SRC,  /self\.defaultPrefix\s{2,}=\s*execSync\('\$\(which npm\) config get prefix --quiet'\)[^;]*;\n\n/);
        assert.doesNotMatch(POST_SRC, /self\.defaultPrefix\s{2,}=\s*execSync\('\$\(which npm\) config get prefix --quiet'\)[^;]*;\n\s*\/\/ var pkg/);
    });

});


describe('02 - refusal fallback behaviour — refusing-shim replica (#B126)', function() {

    // A PATH-shimmed `npm` that refuses exactly like the real gate. The shim
    // makes the replica deterministic: the real npm only refuses when the
    // prefix VALUE redacts, which this suite must not depend on.
    var shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b126-shim-'));
    fs.writeFileSync(path.join(shimDir, 'npm'),
        '#!/bin/sh\n'
        + 'echo "npm error The prefix option is protected, and cannot be retrieved in this way" >&2\n'
        + 'exit 1\n');
    fs.chmodSync(path.join(shimDir, 'npm'), 448 /* 0o700 */);

    var okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b126-ok-'));
    fs.writeFileSync(path.join(okDir, 'npm'), '#!/bin/sh\necho "/opt/some/prefix"\nexit 0\n');
    fs.chmodSync(path.join(okDir, 'npm'), 448);

    var BASE_PATH = '/usr/bin:/bin'; // `which` + `sh` for the pre-#B663 $(which npm) form the sanity and SUBTRACT arms run

    // Verbatim-shaped replica of the shipped guarded block (locked to the real
    // scripts by the §01 pins); env parameterized so each case controls the
    // lifecycle variable explicitly.
    function guardedProbe(binDir, env) {
        var defaultPrefix;
        var _env = { PATH: binDir + ':' + BASE_PATH };
        if (typeof env.npm_config_prefix !== 'undefined') {
            _env.npm_config_prefix = env.npm_config_prefix;
        }
        try {
            defaultPrefix = cp.execFileSync('npm', ['config', 'get', 'prefix', '--quiet'], { env: _env }).toString().replace(/\n$/g, '');
        } catch (probeErr) {
            defaultPrefix = _env.npm_config_prefix
                          || require('path').resolve(process.execPath, '..', '..');
        }
        return defaultPrefix;
    }

    it('sanity — the refusing shim refuses with the real error text', function() {
        var threw = false;
        try {
            cp.execSync("$(which npm) config get prefix --quiet", { env: { PATH: shimDir + ':' + BASE_PATH } });
        } catch (err) {
            threw = true;
            assert.match(err.stderr.toString(), /The prefix option is protected, and cannot be retrieved in this way/);
        }
        assert.ok(threw, 'shim must refuse');
    });

    it('refusal + lifecycle env prefix → falls back to npm_config_prefix', function() {
        assert.equal(guardedProbe(shimDir, { npm_config_prefix: '/tmp/custom-prefix' }), '/tmp/custom-prefix');
    });

    it('refusal + NO env prefix → node-derived default prefix', function() {
        assert.equal(guardedProbe(shimDir, {}), path.resolve(process.execPath, '..', '..'));
    });

    it('a working probe wins — the fallback never fires on the happy path', function() {
        assert.equal(guardedProbe(okDir, { npm_config_prefix: '/tmp/ignored' }), '/opt/some/prefix');
    });

    it('SUBTRACT — the pre-fix unguarded shape THROWS on the refusal (the install-killing crash)', function() {
        assert.throws(function() {
            // the exact pre-fix statement: bare execSync, no catch
            cp.execSync("$(which npm) config get prefix --quiet", { env: { PATH: shimDir + ':' + BASE_PATH } }).toString().replace(/\n$/g, '');
        }, /Command failed/);
    });

});
