var fs        = require('fs');
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./../image/_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/container/ps
 */
/**
 * Lists the containers running on the container host that `image:build` targets
 * — `podman ps`. Every container on the host is shown, not just the ones
 * `image:run` started: there is no reliable gina marker, and a dedicated host's
 * containers are mostly gina's anyway (the same reasoning as `image:list`).
 *
 * `container:*` is a separate group from `image:*` because these verbs act on
 * CONTAINERS, not images — the same reason podman and docker split them.
 *
 * Container-host resolution is IDENTICAL to `image:build` / `image:run`: the
 * `GINA_CONTAINER_HOST` env override wins, then a Linux host with buildah on
 * PATH (native), then `container.host` in
 * `~/.gina/<shortVersion>/settings.json`, otherwise an actionable error
 * (exit 1). Nothing is mutated and no listening socket is opened.
 *
 * Usage:
 *  gina container:ps                  # running containers on the resolved host
 *  gina container:ps --all            # include exited ones
 *  gina container:ps --format=json    # { host, containers: [...] }
 *
 * Output contract:
 *  - text (default): a `pad`-aligned table — CONTAINER ID · NAME · IMAGE ·
 *    STATUS · PORTS.
 *  - `--format=json`: `{ host, containers: [{ id, name, image, state, status,
 *    ports, created, createdAt }] }` on stdout (synchronous `fs.writeSync` so
 *    `process.exit()` cannot truncate it on a pipe), exit 0. `created` is
 *    podman's humanized display string; `createdAt` is its exact ISO sibling
 *    (the `image:list` dual-key convention).
 *  - failures (unresolvable host, run-incapable host, ssh/podman error): the
 *    reason on stdout, exit 1.
 *
 * @class Ps
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // What is running on the host?
 * //   $ gina container:ps
 *
 * @example
 * // The names of everything, running or not.
 * //   $ gina container:ps --all --format=json | jq -r '.containers[].name'
 */
function Ps(opt, cmd) {

    var self = { format: 'text' };

    /**
     * Pure OCI packaging primitives — spawn-arg assembly and `podman ps
     * --format json` parsing. See `lib/image-build`.
     *
     * @inner
     * @constant
     */
    var imageBuild = lib.imageBuild;

    /**
     * Status-format helpers (`pad`). See `lib/cmd-status-format`.
     *
     * @inner
     * @constant
     */
    var fmt = lib.cmdStatusFormat;

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
     * Renders one normalized port entry the way podman displays it —
     * `[ip:]host->container/proto` — with an explicit `xN` when the entry
     * covers a published RANGE rather than a single pair.
     *
     * @inner
     * @private
     * @param {object} p - A normalized entry from `parsePsJson`
     * @returns {string}
     */
    var renderPort = function (p) {
        var s = (p.hostIp ? p.hostIp + ':' : '') + p.hostPort + '->' + p.containerPort + '/' + p.protocol;
        return p.range ? s + ' (x' + p.range + ')' : s;
    };

    /**
     * Renders the container rows as a `pad`-aligned text table (header + one
     * line per row). Column widths are computed from the data so the table
     * stays tight regardless of name/image length.
     *
     * @inner
     * @private
     * @param {Array<object>} rows - Rows from `parsePsJson`
     * @returns {string} The full table (trailing newline)
     */
    var renderTable = function (rows) {
        var cells = rows.map(function (r) {
            return {
                id     : r.id,
                name   : r.name || '<none>',
                image  : r.image || '<none>',
                status : r.status || r.state || '',
                ports  : r.ports.length ? r.ports.map(renderPort).join(', ') : '-'
            };
        });

        var idW     = 'CONTAINER ID'.length;
        var nameW   = 'NAME'.length;
        var imageW  = 'IMAGE'.length;
        var statusW = 'STATUS'.length;
        for (var i = 0; i < cells.length; i++) {
            if (cells[i].id.length     > idW)     idW     = cells[i].id.length;
            if (cells[i].name.length   > nameW)   nameW   = cells[i].name.length;
            if (cells[i].image.length  > imageW)  imageW  = cells[i].image.length;
            if (cells[i].status.length > statusW) statusW = cells[i].status.length;
        }
        var line = function (a, b, c, d, e) {
            return fmt.pad(a, idW) + '  ' + fmt.pad(b, nameW) + '  ' + fmt.pad(c, imageW) + '  ' + fmt.pad(d, statusW) + '  ' + e;
        };
        var out = line('CONTAINER ID', 'NAME', 'IMAGE', 'STATUS', 'PORTS') + '\n';
        for (var r = 0; r < cells.length; r++) {
            out += line(cells[r].id, cells[r].name, cells[r].image, cells[r].status, cells[r].ports) + '\n';
        }
        return out;
    };

    /**
     * Parse --format/--all, resolve the host, run `podman ps --format json`,
     * emit.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var all = !!(self.params && self.params['all']);

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            var eq  = arg.indexOf('=');
            if (!/^\-\-/.test(arg) || eq < 0) continue;
            if (arg.substring(2, eq) === 'format') self.format = arg.substring(eq + 1) || 'text';
        }
        if (['text', 'json'].indexOf(self.format) < 0) {
            return fail('unsupported --format `' + self.format + '` — use `text` or `json`');
        }

        var host = hostUtil.resolveHost();
        if (host.mode === 'error') {
            return fail(host.reason);
        }
        var hostLabel = (host.mode === 'native') ? 'native' : host.descriptor;

        var psArgs   = all ? ['ps', '-a', '--format', 'json'] : ['ps', '--format', 'json'];
        var spawnCmd = imageBuild.containerHostSpawn(host, psArgs, 'podman');
        var res = spawnSync(spawnCmd.command, spawnCmd.args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

        if (res.error && res.error.code === 'ENOENT') {
            return fail(hostUtil.runUnavailableReason(host, hostLabel, 'container:ps'));
        }
        if (res.error) {
            return fail('could not list containers on ' + hostLabel + ' — ' + (res.error.message || res.error));
        }
        if (res.status !== 0) {
            var errTail = String(res.stderr || '').trim();
            if (hostUtil.isRunIncapable(res.status, errTail)) {
                return fail(hostUtil.runUnavailableReason(host, hostLabel, 'container:ps'));
            }
            var reason = 'listing containers failed (exit ' + res.status + ') on ' + hostLabel;
            if (host.mode === 'ssh' && /Host key verification failed/.test(errTail)) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            } else if (errTail) {
                reason += ' — ' + errTail.split('\n').slice(-3).join(' | ');
            }
            return fail(reason);
        }

        var rows = imageBuild.parsePsJson(res.stdout);

        if (self.format === 'json') {
            fs.writeSync(1, JSON.stringify({ host: hostLabel, containers: rows }) + '\n');
        } else if (rows.length === 0) {
            fs.writeSync(1, '(no ' + (all ? '' : 'running ') + 'containers on ' + hostLabel + ')\n');
        } else {
            fs.writeSync(1, renderTable(rows));
        }
        process.exit(0);
    };

    init();
}

module.exports = Ps;
