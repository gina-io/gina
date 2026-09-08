var fs        = require('fs');
var os        = require('os');
var nodePath  = require('path');
var spawn     = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;

var CmdHelper = require('./../helper');
var hostUtil  = require('./_host');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/image/build
 */
/**
 * Packages a registered project bundle as a standard OCI image: synthesizes a
 * Containerfile + build context from what the framework already knows about
 * the project (bundles, entry, ports, env model, node floor), then executes
 * the build with buildah — natively on a Linux host, or on a configurable
 * container host reached over ssh.
 *
 * The synthesized artifact reuses the framework's own container mechanics:
 * `gina-init` (idempotent env-var-driven `~/.gina` bootstrap) + `gina-container`
 * (foreground bundle launcher, SIGTERM drain) as the entrypoint, and — when the
 * selected env is not the dev env — an in-image `gina bundle:build` producing
 * the release tree the launcher resolves (dev/prod parity, built by the
 * framework itself). The `EXPOSE` port is computed with an exact replica of
 * the `gina-init` allocator, so it always matches the port the bundle binds.
 *
 * `${secret:KEY}` config placeholders are NEVER resolved or baked: context
 * files are copied byte-verbatim and this command never invokes the secrets
 * resolver — references resolve from the container's environment at runtime.
 *
 * Container-host resolution precedence: the `GINA_CONTAINER_HOST` env var
 * (explicit `ssh://[user@]host[:port]` override) wins; then a Linux host with
 * buildah on PATH builds natively; then the `container.host` key of
 * `~/.gina/<shortVersion>/settings.json`; otherwise the command fails with an
 * actionable error naming both surfaces (exit 1). The remote path streams the
 * context as a tarball over ssh stdin into a remote temp dir (buildah accepts
 * only a directory context) and never opens any listening socket.
 *
 * Usage:
 *   gina image:build @<project>                          # single-bundle project
 *   gina image:build <bundle> @<project> --env=prod      # explicit bundle + env
 *   gina image:build @<project> --emit                   # print Containerfile + context manifest, build nothing
 *   gina image:build @<project> --format=json            # machine-readable one-shot result
 *   gina image:build @<project> --stream                 # NDJSON progress frames
 *
 * Output contract:
 *  - `--emit` prints the synthesized Containerfile, the entrypoint script and
 *    the context manifest (text), or `{ project, bundle, env, scope, image,
 *    tag, exposedPort, containerfile, entrypoint, context }` with
 *    `--format=json`. Nothing is built or staged.
 *  - `--format=json` (one-shot): `{ project, bundle, image, tag, imageId?,
 *    durationMs, host, exposedPort }` on stdout, exit 0.
 *  - `--stream`: NDJSON frames, one per line — `start` → `step` → `log`* →
 *    `done` | `error`; `done` carries the one-shot shape. All frames are
 *    written with synchronous `fs.writeSync` so `process.exit()` cannot
 *    truncate them on a pipe.
 *  - failures: the reason on stdout, exit 1 (an `error` frame in stream mode).
 *
 * Exit codes: 0 on success or a completed `--emit`; 1 on any usage error,
 * unresolvable plan, missing container host, transfer failure or build failure.
 *
 * @class Build
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 * // Inspect what would be built (nothing is executed).
 * //   $ gina image:build @myproject --emit
 *
 * @example
 * // Build a production image and capture the result.
 * //   $ gina image:build demo @myproject --env=prod --format=json | jq .imageId
 */
function Build(opt, cmd) {

    var self = { format: 'text', emit: false, stream: false };

    /**
     * Pure OCI packaging primitives — synthesis, staging, port computation,
     * descriptor resolution. See `lib/image-build/src/main.js`.
     *
     * @inner
     * @constant
     */
    var imageBuild = lib.imageBuild;

    /**
     * Writes one NDJSON frame to stdout. Synchronous `fs.writeSync` (fd 1) so
     * the frame survives the `process.exit()` that follows the terminal
     * frames when stdout is a pipe. Mirrors `connector:infer`.
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
     * Emits a `step` progress frame in stream mode (no-op otherwise).
     *
     * @inner
     * @private
     * @param {string} name - Step name: synthesize | stage | connect | build
     * @returns {void}
     */
    var emitStep = function (name) {
        if (self.stream) emitFrame({ type: 'step', name: name });
    };

    /**
     * Terminal failure: the reason goes to stdout (an `error` frame in stream
     * mode, plain text otherwise — the family convention consumers already
     * ANSI-strip), then exit 1.
     *
     * @inner
     * @private
     * @param {string} reason - User-facing failure reason
     * @returns {void}
     */
    var fail = function (reason) {
        if (self.stream) {
            emitFrame({ type: 'error', error: { message: reason } });
        } else {
            console.error(reason);
        }
        process.exit(1);
    };

    /**
     * Extracts positional arguments (neither `--flags` nor `@project`) from
     * argv after the task name. For `image:build` the only positional is the
     * optional bundle name.
     *
     * @inner
     * @private
     * @param {string[]} argv - process.argv
     * @returns {string[]} Positional tokens in order
     */
    var extractPositionals = function (argv) {
        var out = [];
        for (var i = 3, len = argv.length; i < len; i++) {
            var t = argv[i];
            if (/^\-/.test(t)) continue;
            if (/^@/.test(t)) continue;
            out.push(t);
        }
        return out;
    };

    /**
     * Parse flags, resolve the project + build plan, then route to `--emit`
     * or the real build.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var p = self.params || {};
        self.emit   = !!p['emit'];
        self.stream = !!p['stream'];

        // Value flags — argv walk with a first-`=` split (values may not be
        // re-split on later `=` chars), mirroring connector:infer.
        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            var eq  = arg.indexOf('=');
            if (!/^\-\-/.test(arg) || eq < 0) continue;
            var key = arg.substring(2, eq);
            var val = arg.substring(eq + 1);
            if (key === 'format')          self.format      = val || 'text';
            if (key === 'tag')             self.tagRef      = val;
            if (key === 'platform')        self.platform    = val;
            if (key === 'start-port-from') self.portStart   = val;
            if (key === 'gina-version')    self.ginaVersion = val;
            if (key === 'env')             self.env         = val;
            if (key === 'scope')           self.scope       = val;
        }

        if (['text', 'json'].indexOf(self.format) < 0) {
            return fail('unsupported --format `' + self.format + '` — use `text` or `json`');
        }

        var positionals = extractPositionals(process.argv);
        var bundleName  = positionals[0] || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            return fail('`image:build` requires `@<project>` (or run it from inside a registered project). Usage: gina image:build [<bundle>] @<project> [--env=<env>] [--emit|--format=json|--stream]');
        }
        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            return fail('project @' + self.projectName + ' is not registered — run `gina project:list`, or register it with `gina project:import @' + self.projectName + ' --path=<project_path>`');
        }

        var projectEntry = self.projects[self.projectName];
        var projectPath  = projectEntry.path;

        var manifest = null;
        try {
            manifest = requireJSON(_(projectPath + '/manifest.json', true));
        } catch (e) {
            return fail('could not read ' + projectPath + '/manifest.json — ' + (e.message || e));
        }

        var hasDependencies = false;
        try {
            var projectPkg = requireJSON(_(projectPath + '/package.json', true));
            hasDependencies = !!(projectPkg.dependencies && Object.keys(projectPkg.dependencies).length > 0);
        } catch (e) {
            hasDependencies = false; // no package.json → nothing to install
        }
        var hasLockfile = fs.existsSync(projectPath + '/package-lock.json');

        // The framework's own engine range — the node floor for the base image.
        var ginaPkg = require(__dirname + '/../../../../../package.json');

        var plan = null;
        try {
            plan = imageBuild.resolveBuildPlan({
                projectName     : self.projectName,
                projectEntry    : projectEntry,
                manifest        : manifest,
                bundleName      : bundleName,
                env             : self.env,
                scope           : self.scope,
                portStart       : self.portStart,
                tag             : self.tagRef,
                ginaVersion     : self.ginaVersion,
                platform        : self.platform,
                nodeEngine      : (ginaPkg.engines && ginaPkg.engines.node) || (ginaPkg.engine && ginaPkg.engine.node) || null,
                hasDependencies : hasDependencies,
                hasLockfile     : hasLockfile
            });
        } catch (e) {
            return fail(e.message || String(e));
        }

        if (self.emit) {
            return doEmit(plan, projectPath);
        }
        return doBuild(plan, projectPath);
    };

    /**
     * `--emit`: print the synthesized Containerfile, entrypoint and context
     * manifest — the expert-inspectable form. Builds and stages NOTHING.
     *
     * @inner
     * @private
     * @param {object} plan        - The resolved build plan
     * @param {string} projectPath - Project root on disk
     * @returns {void}
     */
    var doEmit = function (plan, projectPath) {
        var containerfile = imageBuild.renderContainerfile(plan);
        var entrypoint    = imageBuild.renderEntrypoint();
        var context       = imageBuild.listContext(plan, projectPath);

        if (self.format === 'json') {
            fs.writeSync(1, JSON.stringify({
                project       : plan.projectName,
                bundle        : plan.bundleName,
                env           : plan.env,
                scope         : plan.scope,
                image         : plan.image,
                tag           : plan.tag,
                exposedPort   : plan.exposedPort,
                containerfile : containerfile,
                entrypoint    : entrypoint,
                context       : context
            }) + '\n');
        } else {
            fs.writeSync(1,
                containerfile +
                '\n# --- gina-entrypoint.sh ---\n\n' + entrypoint +
                '\n# --- context manifest (' + context.length + ' files) ---\n\n' +
                context.join('\n') + '\n'
            );
        }
        process.exit(0);
    };

    /**
     * Builds the remote shell command for the ssh path. buildah accepts only
     * a DIRECTORY context (no stdin-tar form), so the context tarball is
     * streamed over ssh stdin into a remote temp dir, built there, and the
     * image id is echoed back behind a parseable marker. Every interpolated
     * token (tag, platform) is regex-validated by the plan resolver — no
     * user-controlled free text reaches the command line.
     *
     * @inner
     * @private
     * @param {object} plan - The resolved build plan
     * @returns {string} The remote command (single ssh argv element)
     */
    var buildRemoteCommand = function (plan) {
        var platformOpt = plan.platform ? ' --platform ' + plan.platform : '';
        return 'sh -c \'set -e; D=$(mktemp -d); trap "rm -rf \\"$D\\"" EXIT; tar -xf - -C "$D"; ' +
               'buildah build --format oci -f "$D/Containerfile" -t ' + plan.tag + platformOpt +
               ' --iidfile "$D/.gina-iid" "$D" 2>&1; ' +
               'echo "__GINA_IID__$(cat "$D/.gina-iid")"\'';
    };

    /**
     * Stages the context, resolves the container host, executes the buildah
     * build (native or over ssh), and emits the one-shot result / stream
     * frames. All stdout writes are synchronous.
     *
     * @inner
     * @private
     * @param {object} plan        - The resolved build plan
     * @param {string} projectPath - Project root on disk
     * @returns {void}
     */
    var doBuild = function (plan, projectPath) {
        var t0 = Date.now();

        var host = hostUtil.resolveHost();
        if (host.mode === 'error') {
            return fail(host.reason);
        }
        var hostLabel = (host.mode === 'native') ? 'native' : host.descriptor;

        if (self.stream) {
            emitFrame({
                type        : 'start',
                project     : plan.projectName,
                bundle      : plan.bundleName,
                env         : plan.env,
                scope       : plan.scope,
                image       : plan.image,
                tag         : plan.tag,
                host        : hostLabel,
                exposedPort : plan.exposedPort
            });
        } else if (self.format === 'text') {
            fs.writeSync(1, '[image:build] building ' + plan.tag + ' (' + plan.bundleName + '@' + plan.projectName + ', env: ' + plan.env + ') on ' + hostLabel + '\n');
        }

        emitStep('stage');
        var stagingDir = nodePath.join(os.tmpdir(), 'gina-image-build-' + plan.projectName + '-' + plan.bundleName + '-' + Date.now());
        try {
            imageBuild.stageContext(plan, projectPath, stagingDir);
        } catch (e) {
            return fail('context staging failed: ' + (e.message || e));
        }

        emitStep('build');
        var child   = null;
        var tarProc = null;
        if (host.mode === 'native') {
            var args = ['build', '--format', 'oci', '-f', stagingDir + '/Containerfile', '-t', plan.tag, '--iidfile', stagingDir + '/.gina-iid'];
            if (plan.platform) { args.push('--platform', plan.platform); }
            args.push(stagingDir);
            child = spawn('buildah', args);
        } else {
            // -p only when the descriptor names a port explicitly — a bare
            // ssh://host must let the user's ssh config decide (host aliases
            // may define their own Port/ProxyCommand).
            var sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
            if (host.parsed.port) { sshArgs.push('-p', String(host.parsed.port)); }
            sshArgs.push(host.parsed.sshTarget, buildRemoteCommand(plan));
            child = spawn('ssh', sshArgs);
            tarProc = spawn('tar', ['-cf', '-', '-C', stagingDir, '.']);
            tarProc.on('error', function (err) {
                fail('context transfer failed — could not run tar: ' + (err.message || err));
            });
            tarProc.stdout.pipe(child.stdin);
            child.stdin.on('error', function () { /* remote closed early — surfaced via exit code */ });
        }

        var imageId  = null;
        var logTail  = [];
        var pending  = '';

        /**
         * Line-buffers a child stream chunk: captures the image-id marker,
         * keeps a short tail for failure reporting, and forwards each line
         * (stream mode → `log` frames; text mode → passthrough).
         *
         * @inner
         * @private
         * @param {Buffer|string} chunk - Raw child output
         * @returns {void}
         */
        var onChunk = function (chunk) {
            pending += chunk.toString();
            var idx;
            while ((idx = pending.indexOf('\n')) > -1) {
                var line = pending.substring(0, idx);
                pending  = pending.substring(idx + 1);
                var m = line.match(/^__GINA_IID__(sha256:[0-9a-f]+|[0-9a-f]+)\s*$/);
                if (m) { imageId = m[1]; continue; }
                logTail.push(line);
                if (logTail.length > 20) logTail.shift();
                if (self.stream) {
                    emitFrame({ type: 'log', line: line });
                } else if (self.format === 'text') {
                    fs.writeSync(1, line + '\n');
                }
            }
        };

        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('error', function (err) {
            fail((host.mode === 'native' ? '`buildah`' : '`ssh`') + ' could not be spawned: ' + (err.message || err));
        });

        child.on('close', function (code) {
            if (host.mode === 'native' && imageId === null) {
                try {
                    imageId = fs.readFileSync(stagingDir + '/.gina-iid', 'utf8').trim() || null;
                } catch (e) { /* build failed before the iidfile was written */ }
            }

            if (code === 0 && imageId) {
                try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
                var oneShot = imageBuild.buildOneShot(plan, {
                    imageId    : imageId,
                    durationMs : Date.now() - t0,
                    host       : hostLabel
                });
                if (self.stream) {
                    oneShot.type = 'done';
                    emitFrame(oneShot);
                } else if (self.format === 'json') {
                    fs.writeSync(1, JSON.stringify(oneShot) + '\n');
                } else {
                    fs.writeSync(1, '[image:build] built ' + plan.tag + ' (' + imageId + ') on ' + hostLabel + ' in ' + oneShot.durationMs + ' ms\n');
                }
                process.exit(0);
            }

            // Failure — staging dir kept for inspection.
            var reason = 'build failed (exit ' + code + ') on ' + hostLabel;
            if (/exec format error/.test(logTail.join('\n'))) {
                reason += ' — the build host lacks qemu/binfmt emulation for ' + (plan.platform || 'the requested platform');
            }
            if (host.mode === 'ssh' && /Host key verification failed/.test(logTail.join('\n'))) {
                reason += ' — the host key is not trusted yet: run `ssh ' + host.parsed.sshTarget + '` once to accept it, then retry';
            }
            if (code === 0 && !imageId) {
                reason = 'build reported success but no image id was captured on ' + hostLabel;
            }
            if (self.format !== 'text' || self.stream) {
                var tail = logTail.slice(-5).join(' | ');
                if (tail) reason += ' — last output: ' + tail;
            }
            reason += ' (context kept at ' + stagingDir + ')';
            fail(reason);
        });
    };

    init();
}

module.exports = Build;
