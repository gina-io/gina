var fs        = require('fs');
var os        = require('os');
var nodePath  = require('path');
var spawn     = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/image/run
 */
/**
 * Runs an OCI image as a container on the container host that `image:build`
 * targets — `podman run`. buildah builds images but cannot run them; podman
 * uses crun natively, so a host may build without being able to run. A
 * build-only host (buildah present, podman absent) is a supported shape and is
 * reported honestly rather than as an opaque exec failure.
 *
 * Detached by default (the container keeps running, its id is printed);
 * `--stream` runs it in the foreground and mirrors its output as NDJSON.
 *
 * Ports: with no `--publish`, the image's OWN `EXPOSE` is published same:same.
 * That EXPOSE is the port `image:build` computed with the gina-init allocator
 * replica and baked into the image, so the mapping is the one the bundle will
 * actually bind — never recomputed here. `--publish` overrides it entirely,
 * `--publish=none` disables publishing, and an image with no EXPOSE and no flag
 * publishes nothing.
 *
 * Environment: `--env-var=KEY=VALUE` (repeatable) and `--env-file=<local path>`
 * compose one env file that reaches podman WITHOUT ever touching argv — values
 * would otherwise be world-readable in the host's process list. Natively the
 * lines are written to a 0600 temp file; over ssh they ride the ssh stdin into
 * a remote `mktemp` file that a `trap` removes when the command ends (the
 * `image:build` context-transfer idiom). `--env-var` overrides `--env-file` on
 * a duplicate key. This keeps the `${secret:KEY}` discipline: `image:build`
 * bakes no secret, and `image:run` hands the values to the container at start
 * without exposing them to any other process.
 *
 * Container-host resolution is IDENTICAL to `image:build` / `image:list` /
 * `image:rm`: the `GINA_CONTAINER_HOST` env override wins, then a Linux host
 * with buildah on PATH (native), then `container.host` in
 * `~/.gina/<shortVersion>/settings.json`, otherwise an actionable error
 * (exit 1).
 *
 * Usage:
 *  gina image:run <image>                          # detached, publishing the image's EXPOSE
 *  gina image:run <image> --name=demo --rm         # named, removed on exit
 *  gina image:run <image> --publish=8080:3100      # explicit port map
 *  gina image:run <image> --publish=none           # publish nothing
 *  gina image:run <image> --env-var=K=V --stream   # foreground, NDJSON frames
 *
 * Output contract:
 *  - text (default, detached): the container id ALONE on stdout, exit 0 — so
 *    `ID=$(gina image:run <image>)` captures the id and nothing else. The
 *    progress line goes to stderr for that reason.
 *  - `--format=json` (detached): `{ host, id, name, image, ports }` on stdout
 *    (synchronous `fs.writeSync` so `process.exit()` cannot truncate it on a
 *    pipe), exit 0.
 *  - `--stream`: NDJSON frames, one per line — `start` → `log`* → `done` |
 *    `error`; `log` frames carry `stream: "stdout"|"stderr"`, `done` carries
 *    the container's `exitCode`. All frames are `fs.writeSync`-flushed.
 *  - failures (usage, invalid ref/name/publish/env, unresolvable host,
 *    run-incapable host, podman error): the reason on stdout, exit 1 (an
 *    `error` frame in stream mode).
 *
 * @class Run
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Run a built image, publishing the port it EXPOSEs.
 * //   $ gina image:run localhost/myproject/demo:prod --name=demo
 *
 * @example
 * // Foreground with secrets from a local env file, streamed as NDJSON.
 * //   $ gina image:run localhost/myproject/demo:prod --env-file=./.env.prod --stream
 */
function Run(opt, cmd) {

    var self = { format: 'text', stream: false, rm: false };

    /**
     * Pure OCI packaging primitives — host descriptor resolution, spawn-arg
     * assembly, the ref/name/publish gates, EXPOSE + env composition. See
     * `lib/image-build`.
     *
     * @inner
     * @constant
     */
    var imageBuild = lib.imageBuild;

    /**
     * The env-file path placeholder in the assembled podman argv. The ssh path
     * substitutes the remote shell variable, the native path a real temp path —
     * so the argv is built ONCE for both.
     *
     * @inner
     * @constant {string}
     */
    var ENV_FILE_TOKEN = '__GINA_ENV_FILE__';

    /**
     * The native env temp dir, removed once the child settles.
     *
     * @inner
     * @type {string|null}
     */
    var nativeEnvDir = null;

    /**
     * Writes one NDJSON frame to stdout. Synchronous `fs.writeSync` (fd 1) so
     * the frame survives the `process.exit()` that follows the terminal frames
     * when stdout is a pipe. Mirrors `image:build`.
     *
     * @inner
     * @private
     * @param {object} frame - The frame (`type` plus payload fields)
     * @returns {void}
     */
    var emitFrame = function (frame) {
        fs.writeSync(1, JSON.stringify(frame) + '\n');
    };

    /**
     * Best-effort removal of the native env temp dir (the ssh path's remote
     * file is removed by its own shell `trap`).
     *
     * @inner
     * @private
     * @returns {void}
     */
    var cleanupNativeEnv = function () {
        if (!nativeEnvDir) return;
        try { fs.rmSync(nativeEnvDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        nativeEnvDir = null;
    };

    /**
     * Terminal failure: the reason goes to stdout (an `error` frame in stream
     * mode, plain text otherwise — the family convention consumers already
     * ANSI-strip), then exit 1. Always drops the native env file first.
     *
     * @inner
     * @private
     * @param {string} reason - User-facing failure reason
     * @returns {void}
     */
    var fail = function (reason) {
        cleanupNativeEnv();
        if (self.stream) {
            emitFrame({ type: 'error', error: { message: reason } });
        } else {
            console.error(reason);
        }
        process.exit(1);
    };

    /**
     * First positional token after the task name (not a `--flag`), i.e. the
     * image reference.
     *
     * @inner
     * @private
     * @returns {string|null}
     */
    var firstPositional = function () {
        for (var i = 3, len = process.argv.length; i < len; i++) {
            if (!/^\-/.test(process.argv[i])) return process.argv[i];
        }
        return null;
    };

    /**
     * Collects EVERY `--env-var=KEY=VALUE` occurrence in argv. The CmdHelper
     * params map keeps only the last value of a repeated flag, so the argv walk
     * is what makes the flag repeatable. Splits on the FIRST `=` only, twice:
     * once to strip the flag name, and once (in `composeEnvLines`) to split
     * KEY from VALUE — so a value may contain `=`.
     *
     * @inner
     * @private
     * @returns {string[]} The raw `KEY=VALUE` strings, in argv order
     */
    var collectEnvVars = function () {
        var out = [];
        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            var eq  = arg.indexOf('=');
            if (!/^\-\-/.test(arg) || eq < 0) continue;
            if (arg.substring(2, eq) === 'env-var') out.push(arg.substring(eq + 1));
        }
        return out;
    };

    /**
     * Reads a local `--env-file`, dropping blank lines and `#` comments. The
     * surviving lines are validated by `composeEnvLines` alongside the
     * `--env-var` entries.
     *
     * @inner
     * @private
     * @param {string} path - The local env-file path
     * @returns {string[]} The candidate `KEY=VALUE` lines
     */
    var readEnvFile = function (path) {
        var raw = fs.readFileSync(path, 'utf8');
        return raw.split(/\r?\n/).filter(function (line) {
            return !/^\s*$/.test(line) && !/^\s*#/.test(line);
        }).map(function (line) {
            return line.trim();
        });
    };

    /**
     * Explains a missing podman as a build-only host. Shared with
     * `container:ps` / `container:stop` via the `_host` preamble — all three
     * verbs need podman, and all three meet the same build-only shape.
     *
     * @inner
     * @private
     * @param {object} host      - The resolved host descriptor
     * @param {string} hostLabel - 'native' or the ssh descriptor
     * @returns {string} The user-facing reason
     */
    var runUnavailableReason = function (host, hostLabel) {
        return hostUtil.runUnavailableReason(host, hostLabel, 'image:run');
    };

    /**
     * True when a child failure means "podman is not on this host" rather than
     * "podman ran and refused". Shared via the `_host` preamble.
     *
     * @inner
     * @private
     * @param {number|null} code    - The child exit code
     * @param {string}      errText - Collected stderr/stdout tail
     * @returns {boolean}
     */
    var isRunIncapable = function (code, errText) {
        return hostUtil.isRunIncapable(code, errText);
    };

    /**
     * Resolves the ports to publish: an explicit `--publish` spec wins, `none`
     * disables, and by default the image's own EXPOSE is mapped same:same.
     *
     * @inner
     * @private
     * @param {object} host      - The resolved host descriptor
     * @param {string} hostLabel - 'native' or the ssh descriptor
     * @param {string} ref       - The (already gated) image reference
     * @returns {string[]} podman `-p` values, e.g. `['3101:3101']`
     */
    var resolvePorts = function (host, hostLabel, ref) {
        if (self.publish === 'none') return [];
        if (self.publish) return self.publish.split(',');

        // Default: the EXPOSE image:build baked. The FULL inspect document is
        // read (not `--format '{{json ...}}'`) because that format token
        // carries a space, which the ssh remote shell would split.
        var probe = imageBuild.containerHostSpawn(host, ['image', 'inspect', ref], 'podman');
        var res   = spawnSync(probe.command, probe.args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

        if (res.error && res.error.code === 'ENOENT') {
            return fail(runUnavailableReason(host, hostLabel));
        }
        if (res.status !== 0) {
            var errTail = String(res.stderr || '').trim();
            if (isRunIncapable(res.status, errTail)) {
                return fail(runUnavailableReason(host, hostLabel));
            }
            var reason = 'could not inspect `' + ref + '` on ' + hostLabel + ' (exit ' + res.status + ')';
            if (host.mode === 'ssh' && /Host key verification failed/.test(errTail)) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            } else if (/no such image|image not known/i.test(errTail)) {
                reason += ' — no such image on the host (see `gina image:list`)';
            } else if (errTail) {
                reason += ' — ' + errTail.split('\n').slice(-3).join(' | ');
            }
            return fail(reason);
        }

        return imageBuild.parseExposedPorts(res.stdout).map(function (e) {
            return e.port + ':' + e.port + (e.protocol === 'udp' ? '/udp' : '');
        });
    };

    /**
     * Assembles the podman `run` argv, shared by both hosts. Every
     * user-controlled token is already gated; `ENV_FILE_TOKEN` is substituted
     * per host.
     *
     * @inner
     * @private
     * @param {string}   ref      - The image reference
     * @param {string[]} portArgs - `-p` values
     * @returns {string[]} The podman argv
     */
    var buildPodmanArgs = function (ref, portArgs) {
        var args = ['run'];
        if (!self.stream) args.push('-d');
        if (self.rm)      args.push('--rm');
        // Always passed: an empty env file is a no-op (measured), so the common
        // path exercises the same shape as the secrets path.
        args.push('--env-file', ENV_FILE_TOKEN);
        if (self.name) args.push('--name', self.name);
        portArgs.forEach(function (p) { args.push('-p', p); });
        args.push(ref);
        return args;
    };

    /**
     * Builds the ssh remote command: the env lines arrive on stdin, land in a
     * `mktemp` file (0600 by mktemp), and a `trap` removes it when the shell
     * ends — the `image:build` context-transfer idiom. `podman` is NOT `exec`'d:
     * exec would replace the shell and the trap would never fire, leaking the
     * file. Without exec the shell exits with podman's status, which ssh
     * propagates as its own.
     *
     * @inner
     * @private
     * @param {string[]} podArgs - The podman argv (carrying ENV_FILE_TOKEN)
     * @returns {string} The remote command (a single ssh argv element)
     */
    var buildRemoteRunCommand = function (podArgs) {
        var remoteArgs = podArgs.map(function (t) {
            return (t === ENV_FILE_TOKEN) ? '"$F"' : t;
        });
        return 'sh -c \'set -e; F=$(mktemp); trap "rm -f \\"$F\\"" EXIT HUP INT TERM; cat > "$F"; podman ' +
               remoteArgs.join(' ') + '\'';
    };

    /**
     * Starts podman on the resolved host, handing it the env lines without ever
     * putting them in argv: natively via a 0600 temp file, over ssh via stdin
     * into the remote `mktemp` file.
     *
     * @inner
     * @private
     * @param {object}   host     - The resolved host descriptor
     * @param {string[]} podArgs  - The podman argv (carrying ENV_FILE_TOKEN)
     * @param {string[]} envLines - The validated `KEY=VALUE` lines
     * @returns {object} The spawned child process
     */
    var startChild = function (host, podArgs, envLines) {
        var body = envLines.length ? envLines.join('\n') + '\n' : '';

        if (host.mode === 'native') {
            nativeEnvDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gina-image-run-'));
            var envPath  = nodePath.join(nativeEnvDir, 'env');
            fs.writeFileSync(envPath, body, { mode: 384 }); // 0600 — never world-readable
            var nativeArgs = podArgs.map(function (t) {
                return (t === ENV_FILE_TOKEN) ? envPath : t;
            });
            return spawn('podman', nativeArgs);
        }

        var sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
        if (host.parsed.port) sshArgs.push('-p', String(host.parsed.port));
        sshArgs.push(host.parsed.sshTarget, buildRemoteRunCommand(podArgs));

        var child = spawn('ssh', sshArgs);
        child.stdin.on('error', function () { /* remote closed early — surfaced via exit code */ });
        child.stdin.end(body);
        return child;
    };

    /**
     * Parse + gate every input, resolve the host and ports, then run.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var p = self.params || {};
        self.stream = !!p['stream'];
        self.rm     = !!p['rm'];

        // Value flags — argv walk with a first-`=` split (a value may itself
        // contain `=`), mirroring image:build.
        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            var eq  = arg.indexOf('=');
            if (!/^\-\-/.test(arg) || eq < 0) continue;
            var key = arg.substring(2, eq);
            var val = arg.substring(eq + 1);
            if (key === 'format')   self.format  = val || 'text';
            if (key === 'name')     self.name    = val;
            if (key === 'publish')  self.publish = val;
            if (key === 'env-file') self.envFile = val;
        }

        if (['text', 'json'].indexOf(self.format) < 0) {
            return fail('unsupported --format `' + self.format + '` — use `text` or `json`');
        }

        // ---- gates: every user-controlled token, BEFORE any assembly --------
        var ref = firstPositional();
        if (!ref) {
            return fail('`image:run` requires an image reference. Usage: gina image:run <image> [--name=<n>] [--publish=<host:ctr>|none] [--env-var=K=V] [--env-file=<path>] [--rm] [--stream|--format=json] (see `gina image:list`)');
        }
        if (!imageBuild.isValidImageRef(ref)) {
            return fail('invalid image reference `' + ref + '` — expected a repo[:tag], repo@digest, or image id');
        }
        if (typeof self.name !== 'undefined' && !imageBuild.isValidContainerToken(self.name)) {
            return fail('invalid --name `' + self.name + '` — expected a letter or digit followed by letters, digits, `_`, `.` or `-`');
        }
        if (typeof self.publish !== 'undefined' && self.publish !== 'none' && !imageBuild.isValidPublishSpec(self.publish)) {
            return fail('invalid --publish `' + self.publish + '` — expected <host>:<container>[,<host>:<container>...] with ports in 1-65535, or `none`');
        }

        var envPairs = [];
        if (typeof self.envFile !== 'undefined') {
            if (!self.envFile) {
                return fail('--env-file needs a path');
            }
            try {
                envPairs = readEnvFile(self.envFile);
            } catch (e) {
                return fail('could not read --env-file `' + self.envFile + '` — ' + (e.message || e));
            }
        }
        // --env-var AFTER --env-file: podman lets a later duplicate key win, so
        // an inline value overrides the file's (podman's own --env precedence).
        envPairs = envPairs.concat(collectEnvVars());

        var envLines;
        try {
            envLines = imageBuild.composeEnvLines(envPairs);
        } catch (e) {
            return fail(e.message || String(e));
        }

        var host = hostUtil.resolveHost();
        if (host.mode === 'error') {
            return fail(host.reason);
        }
        var hostLabel = (host.mode === 'native') ? 'native' : host.descriptor;

        return doRun(host, hostLabel, ref, envLines);
    };

    /**
     * Resolves the ports, starts the container and emits the result.
     *
     * @inner
     * @private
     * @param {object}   host      - The resolved host descriptor
     * @param {string}   hostLabel - 'native' or the ssh descriptor
     * @param {string}   ref       - The gated image reference
     * @param {string[]} envLines  - The validated env lines
     * @returns {void}
     */
    var doRun = function (host, hostLabel, ref, envLines) {

        var portArgs = resolvePorts(host, hostLabel, ref);
        var podArgs  = buildPodmanArgs(ref, portArgs);

        if (self.stream) {
            emitFrame({
                type  : 'start',
                image : ref,
                name  : self.name || null,
                host  : hostLabel,
                ports : portArgs
            });
        } else if (self.format === 'text') {
            // fd 2, NOT fd 1: text-mode stdout carries the container id as a
            // VALUE (`ID=$(gina image:run ...)`), so progress must not pollute
            // it. `image:build` writes its progress to stdout because its text
            // output is narrative, not a value; `connector:models` is the
            // precedent for this shape — values on stdout, footer on stderr.
            fs.writeSync(2, '[image:run] starting ' + ref + ' on ' + hostLabel +
                (portArgs.length ? ' (publishing ' + portArgs.join(', ') + ')' : ' (no published ports)') + '\n');
        }

        var child   = null;
        try {
            child = startChild(host, podArgs, envLines);
        } catch (e) {
            return fail('could not start the container on ' + hostLabel + ' — ' + (e.message || e));
        }

        var outTail = [];
        var errTail = [];
        var pending = { stdout: '', stderr: '' };

        /**
         * Line-buffers a child stream, keeping a tail for failure reporting and
         * forwarding each line (stream mode → `log` frames; detached text mode
         * → the id is emitted at close, so nothing is forwarded here).
         *
         * @inner
         * @private
         * @param {string} which - 'stdout' | 'stderr'
         * @returns {function} The chunk handler
         */
        var onChunk = function (which) {
            return function (chunk) {
                pending[which] += chunk.toString();
                var idx;
                while ((idx = pending[which].indexOf('\n')) > -1) {
                    var line = pending[which].substring(0, idx);
                    pending[which] = pending[which].substring(idx + 1);
                    var tail = (which === 'stdout') ? outTail : errTail;
                    tail.push(line);
                    if (tail.length > 20) tail.shift();
                    if (self.stream) emitFrame({ type: 'log', stream: which, line: line });
                }
            };
        };

        child.stdout.on('data', onChunk('stdout'));
        child.stderr.on('data', onChunk('stderr'));

        child.on('error', function (err) {
            if (host.mode === 'native' && err && err.code === 'ENOENT') {
                return fail(runUnavailableReason(host, hostLabel));
            }
            fail((host.mode === 'native' ? '`podman`' : '`ssh`') + ' could not be spawned: ' + (err.message || err));
        });

        child.on('close', function (code) {
            cleanupNativeEnv();

            // Flush any unterminated trailing line so a tail is never lost.
            ['stdout', 'stderr'].forEach(function (w) {
                if (pending[w]) {
                    (w === 'stdout' ? outTail : errTail).push(pending[w]);
                    if (self.stream) emitFrame({ type: 'log', stream: w, line: pending[w] });
                    pending[w] = '';
                }
            });

            var allText = outTail.concat(errTail).join('\n');

            if (self.stream) {
                // Foreground: the container's own exit code is podman's, which
                // the remote shell and ssh both propagate.
                if (code !== 0 && isRunIncapable(code, allText)) {
                    return fail(runUnavailableReason(host, hostLabel));
                }
                emitFrame({ type: 'done', exitCode: code });
                return process.exit(code === 0 ? 0 : 1);
            }

            if (code !== 0) {
                if (isRunIncapable(code, allText)) {
                    return fail(runUnavailableReason(host, hostLabel));
                }
                var reason = 'could not run `' + ref + '` on ' + hostLabel + ' (exit ' + code + ')';
                var tail   = errTail.join('\n').trim();
                if (host.mode === 'ssh' && /Host key verification failed/.test(tail)) {
                    reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
                } else if (/port is already allocated|address already in use/i.test(tail)) {
                    reason += ' — a published port is already in use on the host; pass --publish=<host>:<container> to map another, or --publish=none';
                } else if (/already in use by container|container name .* is already in use/i.test(tail)) {
                    reason += ' — a container of that name already exists (see `gina container:ps --all`)';
                } else if (tail) {
                    reason += ' — ' + tail.split('\n').slice(-3).join(' | ');
                }
                return fail(reason);
            }

            // Detached: podman prints the 64-hex container id on stdout.
            var id = outTail.join('\n').trim().split('\n').pop() || '';
            if (!/^[0-9a-f]{12,64}$/.test(id)) {
                return fail('the container started on ' + hostLabel + ' but no container id was captured' +
                    (allText.trim() ? ' — last output: ' + allText.trim().split('\n').slice(-3).join(' | ') : ''));
            }

            if (self.format === 'json') {
                fs.writeSync(1, JSON.stringify({
                    host  : hostLabel,
                    id    : id,
                    name  : self.name || null,
                    image : ref,
                    ports : portArgs
                }) + '\n');
            } else {
                fs.writeSync(1, id + '\n');
            }
            process.exit(0);
        });
    };

    init();
}

module.exports = Run;
