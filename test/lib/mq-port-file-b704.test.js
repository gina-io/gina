'use strict';
/**
 * #B704 — the framework CLI's log-listener port file. `bin/cli` wrote
 * `<tmpdir>/mq-listener-v<version>.port` with `fs.writeFileSync` (O_TRUNC,
 * follows a symlink, mode 0644 by the default umask) on every `gina` command,
 * and `gina tail` (lib/cmd/framework/tail.js) read it back from the same
 * place. In a shared `/tmp` (Linux by default) another local user could create
 * that name first: with the kernel's `fs.protected_regular` protection on
 * (the systemd / Ubuntu / Debian defaults) every `gina` command of the other
 * users then failed at start-up with EACCES; without `fs.protected_symlinks`,
 * a symbolic link there had the command overwrite a file of that user's
 * choosing with the port number. Same class as #B676 (the argv file) and
 * #B702 (the Shell log files), measured 2026-09-28 (`todo/b664-design.md § 10`).
 *
 * The fix moves the file under `getArgvDir()` — `<GINA_HOMEDIR>/run`, created
 * 0700 by #B676 — written with mode 0600, on both the writer and the reader.
 *
 * §01 — source pins on the writer (bin/cli) and the reader (tail.js).
 * §02 — live: a CLI child run through a `gina`-named link with an isolated HOME
 *       and a private TMPDIR is watched while it runs — the port file appears
 *       under `<HOME>/.gina/run/`, mode 0600, holding the MQ port, never under
 *       the child's TMPDIR, and is gone once the child has exited (the on-exit
 *       unlink). Red-first: on the pre-fix bytes the file appears under TMPDIR
 *       (`settings.tmpdir` is recorded from the child's `os.tmpdir()`).
 */

var assert   = require('node:assert');
var fs       = require('node:fs');
var os       = require('node:os');
var path     = require('node:path');
var net      = require('node:net');
var spawn    = require('node:child_process').spawn;
var describe = require('node:test').describe;
var it       = require('node:test').it;
var after    = require('node:test').after;

var FW       = require('../fw');
var ROOT     = path.resolve(FW, '..', '..');
var CLI_SRC  = fs.readFileSync(path.join(ROOT, 'bin/cli'), 'utf8');
var TAIL_SRC = fs.readFileSync(path.join(FW, 'lib/cmd/framework/tail.js'), 'utf8');

var TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b704-'));
var LINK = path.join(TMP, 'gina');                 // named like an install: bin/cli's `gina/bin/cli` test
var HOME = path.join(TMP, 'home');
var CHILD_TMP = path.join(TMP, 'tmp');             // the child's private TMPDIR (never the shared one)

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function freePort() {
    return new Promise(function (resolve, reject) {
        var srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
    });
}

function listPortFiles(dir) {
    try { return fs.readdirSync(dir).filter(function (f) { return /^mq-listener-v.*\.port$/.test(f); }); }
    catch (e) { return []; }
}

describe('01 - #B704 the port file lives under the framework home run dir, not the shared tmp dir', function() {

    it('bin/cli writes it under getArgvDir(), mode 0600', function() {
        assert.match(CLI_SRC, /getArgvDir\(\)\s*\+\s*'\/mq-listener-v'/, 'the writer builds the path under the run dir');
        assert.doesNotMatch(CLI_SRC, /getTmpDir\(\)\s*\+\s*'\/mq-listener-v'/, 'and no longer under the tmp dir');
        var at = CLI_SRC.search(/getArgvDir\(\)\s*\+\s*'\/mq-listener-v'/);
        var write = CLI_SRC.indexOf('fs.writeFileSync( mqPortFile', at);
        assert.ok(write > at, 'the write follows the path (anchor control)');
        assert.match(CLI_SRC.slice(write, write + 120), /mode:\s*0o600/, 'written with mode 0600');
    });

    it('tail.js reads it from the same place', function() {
        assert.match(TAIL_SRC, /getArgvDir\(\)\s*\+\s*'\/mq-listener-v'/, 'the reader builds the path under the run dir');
        assert.doesNotMatch(TAIL_SRC, /getTmpDir\(\)\s*\+\s*'\/mq-listener-v'/, 'and no longer under the tmp dir');
    });

    it('control — getTmpDir() is still defined and exported (the tmp dir itself is not retired)', function() {
        var HELPER_SRC = fs.readFileSync(path.join(ROOT, 'utils/helper.js'), 'utf8');
        assert.match(HELPER_SRC, /getTmpDir\s*=\s*function/);
        assert.match(HELPER_SRC, /getArgvDir\s*=\s*function/);
    });
});

describe('02 - #B704 live: a CLI child writes the port file under its home run dir, mode 0600', function() {

    it('the file is seen under <HOME>/.gina/run while the child runs, never under its TMPDIR, and is gone after exit', async function() {
        var mqPort = String(await freePort());
        fs.symlinkSync(ROOT, LINK);
        fs.mkdirSync(HOME, { recursive: true });
        fs.mkdirSync(CHILD_TMP, { recursive: true });
        var env = Object.assign({}, process.env, { HOME: HOME, TMPDIR: CHILD_TMP, GINA_LOG_STDOUT: 'true', GINA_MQ_PORT: mqPort });
        delete env.GINA_HOMEDIR;
        delete env.GINA_TMPDIR;

        var runDir = path.join(HOME, '.gina', 'run');
        var seen = null, seenInTmp = [], out = '';
        var child = spawn(process.execPath, [path.join(LINK, 'bin', 'cli'), 'version'], { env: env, cwd: HOME });
        child.stdout.on('data', function (d) { out += d; });
        child.stderr.on('data', function (d) { out += d; });
        var poll = setInterval(function () {
            if ( !seen ) {
                var files = listPortFiles(runDir);
                if ( files.length ) {
                    var p = path.join(runDir, files[0]);
                    try {
                        seen = { name: files[0], mode: (fs.statSync(p).mode & 0o777).toString(8), content: fs.readFileSync(p, 'utf8') };
                    } catch (e) { /* the child may be mid-write or exiting; keep polling */ }
                }
            }
            seenInTmp = seenInTmp.concat(listPortFiles(CHILD_TMP));
        }, 10);
        var exit = await new Promise(function (resolve) {
            var t = setTimeout(function () { child.kill('SIGKILL'); resolve({ code: null, signal: 'TIMEOUT' }); }, 30000);
            child.on('exit', function (code, signal) { clearTimeout(t); resolve({ code: code, signal: signal }); });
        });
        clearInterval(poll);

        assert.strictEqual(exit.signal, null, 'the child exited on its own:\n' + out);
        assert.match(out, /is wait+ing for speakers on port/, 'CONTROL: the MQ listener started, so the port file was written:\n' + out);
        assert.ok(seen, 'the port file was observed under ' + runDir + ' while the child ran:\n' + out);
        assert.match(seen.name, /^mq-listener-v.+\.port$/);
        assert.strictEqual(seen.mode, '600', 'written with mode 0600');
        assert.strictEqual(seen.content, mqPort, 'holding the MQ port');
        assert.deepStrictEqual(seenInTmp, [], 'never written under the child\'s TMPDIR');
        assert.deepStrictEqual(listPortFiles(runDir), [], 'removed on exit');
        var st = fs.statSync(runDir);
        assert.strictEqual((st.mode & 0o777).toString(8), '700', 'the run dir itself is 0700 (#B676)');
    });
});
