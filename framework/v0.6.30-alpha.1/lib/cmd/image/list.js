var fs        = require('fs');
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/image/list
 */
/**
 * Lists OCI images present on the container host that `image:build` targets —
 * every image on the host, mirroring `buildah images` / `docker images`. There
 * is no reliable "gina-built" marker (the synthesized images carry no gina
 * label), so no filter is applied; a dedicated build host's images are mostly
 * gina's anyway.
 *
 * Container-host resolution is IDENTICAL to `image:build`: the
 * `GINA_CONTAINER_HOST` env override wins, then a Linux host with buildah on
 * PATH (native), then the `container.host` key of
 * `~/.gina/<shortVersion>/settings.json`, otherwise an actionable error
 * (exit 1). The remote path runs `buildah images --json` over ssh; nothing is
 * mutated and no listening socket is opened.
 *
 * Usage:
 *  gina image:list                    # text table on the resolved host
 *  gina image:list --format=json      # { host, images: [{ ref, id, size, created, sizeBytes, createdAt }] }
 *
 * Output contract:
 *  - text (default): a `pad`-aligned table — REPOSITORY:TAG · IMAGE ID · SIZE ·
 *    CREATED. An untagged image renders as `<none>:<none>`; a multi-tagged
 *    image yields one row per tag.
 *  - `--format=json`: `{ host, images: [{ ref, id, size, created, sizeBytes,
 *    createdAt }] }` on stdout (synchronous `fs.writeSync` so `process.exit()`
 *    cannot truncate it on a pipe), exit 0. `size`/`created` are buildah's
 *    humanized display strings; `createdAt` is the exact RFC3339 creation
 *    time and `sizeBytes` an approximate byte count derived from the
 *    humanized size (buildah exposes no raw byte count anywhere).
 *  - failures (unresolvable host, ssh/buildah error): the reason on stdout,
 *    exit 1.
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // List images on the resolved host.
 * //   $ gina image:list
 *
 * @example
 * // Machine-readable, e.g. the tags on the host.
 * //   $ gina image:list --format=json | jq -r '.images[].ref'
 */
function List(opt, cmd) {

    var self = { format: 'text' };

    /**
     * Pure OCI packaging primitives — host descriptor resolution, spawn-arg
     * assembly, `buildah images --json` parsing. See `lib/image-build`.
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
     * Renders the image rows as a `pad`-aligned text table (header + one line
     * per row). Column widths are computed from the data so the table stays
     * tight regardless of ref/size length.
     *
     * @inner
     * @private
     * @param {Array<{ref:string,id:string,size:string,created:string,sizeBytes:(number|null),createdAt:string}>} rows - Only the four display keys are rendered
     * @returns {string} The full table (trailing newline), or a header-only
     *   note when there are no images
     */
    var renderTable = function (rows) {
        var refW  = 'REPOSITORY:TAG'.length;
        var idW   = 'IMAGE ID'.length;
        var sizeW = 'SIZE'.length;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].ref.length  > refW)  refW  = rows[i].ref.length;
            if (rows[i].id.length   > idW)   idW   = rows[i].id.length;
            if (rows[i].size.length > sizeW) sizeW = rows[i].size.length;
        }
        var line = function (a, b, c, d) {
            return fmt.pad(a, refW) + '  ' + fmt.pad(b, idW) + '  ' + fmt.pad(c, sizeW) + '  ' + d;
        };
        var out = line('REPOSITORY:TAG', 'IMAGE ID', 'SIZE', 'CREATED') + '\n';
        for (var r = 0; r < rows.length; r++) {
            out += line(rows[r].ref, rows[r].id, rows[r].size, rows[r].created) + '\n';
        }
        return out;
    };

    /**
     * Parse --format, resolve the host, run `buildah images --json`, emit.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

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

        var spawnCmd = imageBuild.containerHostSpawn(host, ['images', '--json']);
        var res = spawnSync(spawnCmd.command, spawnCmd.args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

        if (res.error) {
            return fail('could not list images on ' + hostLabel + ' — ' + (res.error.message || res.error));
        }
        if (res.status !== 0) {
            var reason = 'listing images failed (exit ' + res.status + ') on ' + hostLabel;
            var errTail = String(res.stderr || '').trim();
            if (host.mode === 'ssh' && /Host key verification failed/.test(errTail)) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            } else if (errTail) {
                reason += ' — ' + errTail.split('\n').slice(-3).join(' | ');
            }
            return fail(reason);
        }

        var rows = imageBuild.parseImagesJson(res.stdout);

        if (self.format === 'json') {
            fs.writeSync(1, JSON.stringify({ host: hostLabel, images: rows }) + '\n');
        } else if (rows.length === 0) {
            fs.writeSync(1, '(no images on ' + hostLabel + ')\n');
        } else {
            fs.writeSync(1, renderTable(rows));
        }
        process.exit(0);
    };

    init();
}

module.exports = List;
