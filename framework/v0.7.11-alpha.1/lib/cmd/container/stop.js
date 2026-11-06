var fs        = require('fs');
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./../image/_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/container/stop
 */
/**
 * Stops a container on the container host that `image:build` targets —
 * `podman stop`, or `podman kill` with `--force`.
 *
 * Reports the RUNG the container came down on, which podman's own exit code
 * hides: `podman stop` exits 0 whether the container handled SIGTERM or had to
 * be SIGKILLed after the grace period, so the container's own exit code is the
 * only thing that distinguishes them (measured: a TERM-trapping container
 * reports 143, a non-trapping one 137). A post-stop `podman inspect` reads it.
 *
 * Stopping an already-exited container is a success no-op (podman exits 0), so
 * the verb is safe to re-run — it reports the exit code the container already
 * had.
 *
 * Container-host resolution is IDENTICAL to `image:build` / `image:run`: the
 * `GINA_CONTAINER_HOST` env override wins, then a Linux host with buildah on
 * PATH (native), then `container.host` in
 * `~/.gina/<shortVersion>/settings.json`, otherwise an actionable error
 * (exit 1).
 *
 * Usage:
 *  gina container:stop demo                  # SIGTERM, then SIGKILL after 10s
 *  gina container:stop demo --time=30        # a longer grace period
 *  gina container:stop demo --force          # SIGKILL immediately (podman kill)
 *  gina container:stop demo --format=json    # { host, id, name, result, exitCode }
 *
 * Output contract:
 *  - text (default): the rung, e.g. `[container:stop] demo stopped gracefully
 *    (exit 143) on <host>`.
 *  - `--format=json`: `{ host, id, name, result, exitCode }` on stdout
 *    (synchronous `fs.writeSync` so `process.exit()` cannot truncate it on a
 *    pipe), exit 0. `result` is `graceful` (the container handled the signal),
 *    `killed` (force-killed after the grace period elapsed) or `forced`
 *    (`--force`, killed immediately).
 *  - failures (usage, invalid target, unresolvable host, run-incapable host, no
 *    such container): the reason on stdout, exit 1.
 *
 * @class Stop
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Stop a container by name, reporting how it came down.
 * //   $ gina container:stop demo
 *
 * @example
 * // Machine-readable, e.g. to assert a graceful shutdown in CI.
 * //   $ gina container:stop demo --format=json | jq -r '.result'
 */
function Stop(opt, cmd) {

    var self = { format: 'text' };

    /**
     * Pure OCI packaging primitives — spawn-arg assembly, the container-token
     * gate, `podman inspect` state parsing. See `lib/image-build`.
     *
     * @inner
     * @constant
     */
    var imageBuild = lib.imageBuild;

    /**
     * podman's own default grace period before it escalates to SIGKILL.
     *
     * @inner
     * @constant {number}
     */
    var DEFAULT_GRACE_S = 10;

    /**
     * Terminal failure: the reason to stdout (plain text — the family
     * convention consumers already ANSI-strip), then exit 1.
     *
     * @inner
     * @private
     * @param {string} reason - User-facing failure reason
     * @returns {void}
     */
    var fail = function (reason) {
        console.error(reason);
        process.exit(1);
    };

    /**
     * First positional token after the task name (not a `--flag`), i.e. the
     * container name or id.
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
     * Reads the container's identity and exit code after it came down. The FULL
     * inspect document is read (never `--format '{{...}}'`): that token carries
     * a space, which the ssh transport's remote shell would split.
     *
     * Best-effort by design — the stop already succeeded, so an inspect failure
     * must not turn a successful stop into an error. Unknown fields come back
     * null and the caller reports what it does know.
     *
     * @inner
     * @private
     * @param {object} host   - The resolved host descriptor
     * @param {string} target - The (already gated) container name or id
     * @returns {{id: (string|null), name: (string|null), exitCode: (number|null)}}
     */
    var inspectState = function (host, target) {
        try {
            var probe = imageBuild.containerHostSpawn(host, ['inspect', target], 'podman');
            var res   = spawnSync(probe.command, probe.args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            if (res.status !== 0) return { id: null, name: null, exitCode: null };
            return imageBuild.parseInspectState(res.stdout);
        } catch (e) {
            return { id: null, name: null, exitCode: null };
        }
    };

    /**
     * Classifies the rung from the container's exit code. 137 is 128+SIGKILL:
     * podman escalated because the container did not handle SIGTERM within the
     * grace period. Anything else means the container exited on its own terms.
     *
     * @inner
     * @private
     * @param {boolean}     forced   - True when --force ran `podman kill`
     * @param {number|null} exitCode - The container's exit code
     * @returns {string} 'forced' | 'killed' | 'graceful'
     */
    var classifyRung = function (forced, exitCode) {
        if (forced) return 'forced';
        return (exitCode === 137) ? 'killed' : 'graceful';
    };

    /**
     * Parse the target + flags, validate, resolve the host, stop, report the
     * rung.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var forced = !!(self.params && self.params['force']);
        var grace  = DEFAULT_GRACE_S;

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            var eq  = arg.indexOf('=');
            if (!/^\-\-/.test(arg) || eq < 0) continue;
            var key = arg.substring(2, eq);
            var val = arg.substring(eq + 1);
            if (key === 'format') self.format = val || 'text';
            if (key === 'time')   self.time   = val;
        }

        if (['text', 'json'].indexOf(self.format) < 0) {
            return fail('unsupported --format `' + self.format + '` — use `text` or `json`');
        }

        // ---- gates: every user-controlled token, BEFORE any assembly --------
        var target = firstPositional();
        if (!target) {
            return fail('`container:stop` requires a container name or id. Usage: gina container:stop <name|id> [--time=<s>] [--force] [--format=json] (see `gina container:ps`)');
        }
        if (!imageBuild.isValidContainerToken(target)) {
            return fail('invalid container `' + target + '` — expected a letter or digit followed by letters, digits, `_`, `.` or `-`');
        }
        if (typeof self.time !== 'undefined') {
            if (!/^\d{1,5}$/.test(self.time)) {
                return fail('invalid --time `' + self.time + '` — expected a whole number of seconds');
            }
            grace = parseInt(self.time, 10);
        }

        var host = hostUtil.resolveHost();
        if (host.mode === 'error') {
            return fail(host.reason);
        }
        var hostLabel = (host.mode === 'native') ? 'native' : host.descriptor;

        var stopArgs = forced ? ['kill', target] : ['stop', '-t', String(grace), target];
        var spawnCmd = imageBuild.containerHostSpawn(host, stopArgs, 'podman');
        var res = spawnSync(spawnCmd.command, spawnCmd.args, { encoding: 'utf8' });

        if (res.error && res.error.code === 'ENOENT') {
            return fail(hostUtil.runUnavailableReason(host, hostLabel, 'container:stop'));
        }
        if (res.error) {
            return fail('could not stop `' + target + '` on ' + hostLabel + ' — ' + (res.error.message || res.error));
        }
        if (res.status !== 0) {
            var errTail = String(res.stderr || '').trim();
            if (hostUtil.isRunIncapable(res.status, errTail)) {
                return fail(hostUtil.runUnavailableReason(host, hostLabel, 'container:stop'));
            }
            var reason = 'stopping `' + target + '` failed (exit ' + res.status + ') on ' + hostLabel;
            if (host.mode === 'ssh' && /Host key verification failed/.test(errTail)) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            } else if (/no container with name or ID|no such container/i.test(errTail)) {
                reason += ' — no such container on the host (see `gina container:ps --all`)';
            } else if (errTail) {
                reason += ' — ' + errTail.split('\n').slice(-3).join(' | ');
            }
            return fail(reason);
        }

        var state  = inspectState(host, target);
        var result = classifyRung(forced, state.exitCode);

        if (self.format === 'json') {
            fs.writeSync(1, JSON.stringify({
                host     : hostLabel,
                id       : state.id,
                name     : state.name || target,
                result   : result,
                exitCode : state.exitCode
            }) + '\n');
        } else {
            var how = (result === 'forced')  ? 'force-killed'
                    : (result === 'killed')  ? 'force-killed after the ' + grace + 's grace period'
                    :                          'stopped gracefully';
            fs.writeSync(1, '[container:stop] ' + (state.name || target) + ' ' + how +
                (state.exitCode === null ? '' : ' (exit ' + state.exitCode + ')') +
                ' on ' + hostLabel + '\n');
        }
        process.exit(0);
    };

    init();
}

module.exports = Stop;
