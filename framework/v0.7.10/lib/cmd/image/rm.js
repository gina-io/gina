var fs        = require('fs');
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/image/rm
 */
/**
 * Removes an OCI image from the container host that `image:build` targets —
 * `buildah rmi <ref>` (add `--force` to remove an image still referenced by a
 * container). The image reference is a required positional (a `repo[:tag]`, a
 * `repo@sha256:…` digest, or an image id); with no ref the command is a usage
 * error (exit 1) — there is no blind bulk delete.
 *
 * The ref is charset-gated by `imageBuild.isValidImageRef` before it is passed
 * to the (possibly remote) shell: it must begin with an alphanumeric and
 * contain only image-ref characters, which blocks both shell injection and
 * option injection (a ref like `-f` being read by buildah as a flag).
 *
 * Container-host resolution is IDENTICAL to `image:build` / `image:list`: the
 * `GINA_CONTAINER_HOST` env override wins, then a native Linux+buildah host,
 * then `container.host` in `~/.gina/<shortVersion>/settings.json`, otherwise an
 * actionable error (exit 1).
 *
 * Usage:
 *  gina image:rm <image>              # remove by repo:tag or id
 *  gina image:rm <image> --force      # force removal (image in use by a container)
 *
 * Output contract:
 *  - success: `[image:rm] removed <ref> on <host>` on stdout (synchronous
 *    `fs.writeSync`), exit 0.
 *  - failures (missing/invalid ref, unresolvable host, ssh/buildah error): the
 *    reason on stdout, exit 1.
 *
 * @class Rm
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Remove a built image.
 * //   $ gina image:rm localhost/myproject/demo:prod
 *
 * @example
 * // Force-remove an image still referenced by a container.
 * //   $ gina image:rm 44b5401ff810 --force
 */
function Rm(opt, cmd) {

    var self = {};

    /**
     * Pure OCI packaging primitives — host descriptor resolution, spawn-arg
     * assembly, image-ref validation. See `lib/image-build`.
     *
     * @inner
     * @constant
     */
    var imageBuild = lib.imageBuild;

    /**
     * Terminal failure: the reason to stdout, then exit 1.
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
     * Parse the ref + --force, validate, resolve the host, run `buildah rmi`.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var ref   = firstPositional();
        var force = !!(self.params && self.params['force']);

        if (!ref) {
            return fail('`image:rm` requires an image reference. Usage: gina image:rm <image> [--force] (see `gina image:list`)');
        }
        if (!imageBuild.isValidImageRef(ref)) {
            return fail('invalid image reference `' + ref + '` — expected a repo[:tag], repo@digest, or image id');
        }

        var host = hostUtil.resolveHost();
        if (host.mode === 'error') {
            return fail(host.reason);
        }
        var hostLabel = (host.mode === 'native') ? 'native' : host.descriptor;

        var rmiArgs = force ? ['rmi', '-f', ref] : ['rmi', ref];
        var spawnCmd = imageBuild.containerHostSpawn(host, rmiArgs);
        var res = spawnSync(spawnCmd.command, spawnCmd.args, { encoding: 'utf8' });

        if (res.error) {
            return fail('could not remove `' + ref + '` on ' + hostLabel + ' — ' + (res.error.message || res.error));
        }
        if (res.status !== 0) {
            var reason = 'removing `' + ref + '` failed (exit ' + res.status + ') on ' + hostLabel;
            var errTail = String(res.stderr || '').trim();
            if (host.mode === 'ssh' && /Host key verification failed/.test(errTail)) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            } else if (/image .*in use|image is in use|container/i.test(errTail)) {
                reason += ' — the image is still referenced by a container; retry with `--force`';
            } else if (errTail) {
                reason += ' — ' + errTail.split('\n').slice(-3).join(' | ');
            }
            return fail(reason);
        }

        fs.writeSync(1, '[image:rm] removed ' + ref + ' on ' + hostLabel + '\n');
        process.exit(0);
    };

    init();
}

module.exports = Rm;
