var fs      = require('fs');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/protocol/remove
 */
/**
 * Removes a bundle's protocol assignment — deletes the bundle's explicit
 * `server.protocol` / `server.scheme` / `server.allowHTTP1` override from its
 * own `config/settings.json`, reverting the bundle to the project's default
 * protocol+scheme (`def_protocol` / `def_scheme` from `~/.gina/projects.json`).
 *
 * It touches ONLY the bundle's own `settings.json`. It deliberately does NOT
 * mutate the shared `~/.gina/ports.json` / `ports.reverse.json` port maps:
 * `project:add` pre-allocates the full protocol×scheme×env matrix for every
 * bundle, so the default-protocol port already exists and the allocation is not
 * "owned" by an individual `protocol:set`. At config-load time `core/config.js`
 * fills an absent `server.protocol`/`scheme` from the project default, so
 * deleting the override is safe — provided the default-protocol port is
 * allocated (verified by a guard; overridable with `--force`).
 *
 * Bundle-scoped per help.txt: `gina protocol:remove <bundle> @<project>`.
 *
 * Usage:
 *  gina protocol:remove <bundle_name> @<project_name>
 *  gina protocol:remove <bundle_name> @<project_name> --dry-run
 *  gina protocol:remove <bundle_name> @<project_name> --dry-run --format=json
 *
 * @class Remove
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // revert a bundle to the project default protocol
 *  $ gina protocol:remove api @myproject
 *  Reverted bundle [ api@myproject ] from http/2.0/https to the project default http/1.1/http.
 *  You need to restart your bundle.
 *
 * @example
 *  // preview only, machine-readable
 *  $ gina protocol:remove api @myproject --dry-run --format=json
 *  {"bundle":"api","project":"myproject","dryRun":true,"from":{"protocol":"http/2.0","scheme":"https"},"to":{"protocol":"http/1.1","scheme":"http"},"forcedMissingPortEnvs":[]}
 */
function Remove(opt, cmd) {
    var self = {};

    /**
     * Wires CmdHelper, validates the bundle + project, then runs the revert.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // protocol:remove is bundle-scoped (per help.txt) — a bundle positional
        // is required; the project is resolved by CmdHelper (cwd-inferred or @<project>).
        if ( typeof(self.name) == 'undefined' || self.name == null ) {
            console.error('protocol:remove requires a bundle: gina protocol:remove <bundle_name> @<project_name>');
            process.exit(1);
            return;
        }
        if ( self.projectName == null || typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
            return;
        }

        // populate bundlesByProject[...].configPaths (mirrors set.js setBundleOnly)
        loadAssets();

        remove();
    }


    /**
     * Header-preserving read of a JSON config (mirrors connector/remove.js):
     * captures the leading comment header verbatim and parses the body with the
     * comment-tolerant global `requireJSON`.
     *
     * @inner
     * @private
     * @param {string} target
     * @returns {{header: string, data: object}|null}
     */
    var readSettings = function(target) {
        if ( !fs.existsSync(target) ) {
            console.error('Bundle settings `'+ target +'` does not exist — nothing to remove.');
            process.exit(1);
            return null;
        }
        var raw;
        try {
            raw = fs.readFileSync(target, 'utf8');
        } catch (e) {
            console.error('Cannot read `'+ target +'`: '+ e.message);
            process.exit(1);
            return null;
        }
        var firstBrace = raw.indexOf('{');
        var header     = (firstBrace > 0) ? raw.slice(0, firstBrace) : '';
        var data;
        try {
            data = requireJSON(target) || {};
        } catch (e) {
            console.error('Cannot parse `'+ target +'`: '+ e.message);
            process.exit(1);
            return null;
        }
        return { header: header, data: data };
    }


    /**
     * Header-preserving write (mirrors connector/remove.js::writeFile) + evicts
     * the require cache so a re-read in the same process sees the change.
     *
     * @inner
     * @private
     * @param {string} target
     * @param {string} header
     * @param {object} data
     */
    var writeSettings = function(target, header, data) {
        var body = JSON.stringify(data, null, 4);
        var text = (header || '') + body + '\n';
        lib.generator.createFileFromDataSync(text, target);
        try { delete require.cache[require.resolve(target)]; } catch (e) { /* not cached */ }
    }


    /**
     * Returns the list of the bundle's envs that have NO port allocated for the
     * project default protocol+scheme. An empty list means reverting is safe;
     * a non-empty list means at least one env would be unrunnable after the
     * revert (config.js emergs on a missing port) unless --force is used.
     *
     * @inner
     * @private
     * @param {string} defProtocol
     * @param {string} defScheme
     * @returns {string[]}
     */
    var checkDefaultPort = function(defProtocol, defScheme) {
        var missing      = [];
        var key          = self.name + '@' + self.projectName;
        var portsReverse = {};
        var prPath       = (self.portsReversePath) ? self.portsReversePath : _(GINA_HOMEDIR + '/ports.reverse.json');
        try {
            if ( fs.existsSync(prPath) ) {
                portsReverse = requireJSON(prPath);
            }
        } catch (e) {
            portsReverse = {};
        }

        var envs = self.envs || [];
        for (var i = 0; i < envs.length; i++) {
            var env     = envs[i];
            var hasPort = portsReverse[key]
                && portsReverse[key][env]
                && portsReverse[key][env][defProtocol]
                && typeof(portsReverse[key][env][defProtocol][defScheme]) != 'undefined';
            if ( !hasPort ) {
                missing.push(env);
            }
        }
        return missing;
    }


    /**
     * Prints the revert result (or dry-run preview) as text, or a
     * `{ bundle, project, dryRun, from, to, forcedMissingPortEnvs }` envelope
     * with `--format=json`, then exits.
     *
     * @inner
     * @private
     * @param {string|null} curProtocol
     * @param {string|null} curScheme
     * @param {string} defProtocol
     * @param {string} defScheme
     * @param {string[]} missingEnvs
     * @param {boolean} dryRun
     * @param {string|null} format
     */
    var report = function(curProtocol, curScheme, defProtocol, defScheme, missingEnvs, dryRun, format) {
        if ( /^json?/.test(format) ) {
            process.stdout.write(JSON.stringify({
                bundle                : self.name,
                project               : self.projectName,
                dryRun                : dryRun,
                from                  : { protocol: curProtocol, scheme: curScheme },
                to                    : { protocol: defProtocol, scheme: defScheme },
                forcedMissingPortEnvs : missingEnvs
            }));
            return process.exit(0);
        }

        var fromStr = (curProtocol || '(none)') + '/' + (curScheme || '(none)');
        var toStr   = defProtocol + '/' + defScheme;
        if ( dryRun ) {
            console.log('[ dry-run ] would revert [ '+ self.name +'@'+ self.projectName +' ] from '+ fromStr +' to the project default '+ toStr +' (no changes written).');
        } else {
            console.log('Reverted bundle [ '+ self.name +'@'+ self.projectName +' ] from '+ fromStr +' to the project default '+ toStr +'.');
            if ( missingEnvs.length > 0 ) {
                console.log('  warning: no default-protocol port for env(s): '+ missingEnvs.join(', ') +' — run `gina protocol:set '+ self.name +' @'+ self.projectName +'` before starting those.');
            }
            console.log('You need to restart your bundle.');
        }
        process.exit(0);
    }


    /**
     * Resolves the bundle's settings.json, reads the current override, guards
     * the default-protocol port, then deletes the override (reverting to the
     * project default) — unless --dry-run.
     *
     * @inner
     * @private
     */
    var remove = function() {
        var p      = self.params || {};
        var dryRun = !!p['dry-run'];
        var force  = !!p['force'];
        var format = p['format'] || null;

        var projectConf = self.projects[self.projectName];
        var defProtocol = projectConf.def_protocol;
        var defScheme   = projectConf.def_scheme;
        if ( !defProtocol || !defScheme ) {
            console.error('Project [ '+ self.projectName +' ] has no default protocol/scheme — cannot revert. Run `gina protocol:set @'+ self.projectName +'` first.');
            process.exit(1);
            return;
        }

        // resolve the bundle's settings.json (same path set.js writes to)
        var bundleConfig = (self.bundlesByProject && self.bundlesByProject[self.projectName])
            ? self.bundlesByProject[self.projectName][self.name]
            : null;
        if ( !bundleConfig || !bundleConfig.configPaths || !bundleConfig.configPaths.settings ) {
            console.error('Bundle [ '+ self.name +' ] is not registered inside `@'+ self.projectName +'`.');
            process.exit(1);
            return;
        }
        var settingsPath = _(bundleConfig.configPaths.settings, true);

        var parsed = readSettings(settingsPath);
        if (!parsed) return;
        var settings = parsed.data;

        var curProtocol = (settings.server && settings.server.protocol) ? settings.server.protocol : null;
        var curScheme   = (settings.server && settings.server.scheme)   ? settings.server.scheme   : null;

        // nothing to remove — no override, or the override already equals default
        if ( curProtocol == null && curScheme == null ) {
            console.log('Bundle [ '+ self.name +'@'+ self.projectName +' ] has no protocol override — it already uses the project default '+ defProtocol +'/'+ defScheme +'. Nothing to remove.');
            process.exit(0);
            return;
        }
        if ( curProtocol === defProtocol && curScheme === defScheme ) {
            console.log('Bundle [ '+ self.name +'@'+ self.projectName +' ] already uses the project default '+ defProtocol +'/'+ defScheme +'. Nothing to remove.');
            process.exit(0);
            return;
        }

        // port guard: reverting to a default that has no allocated port would
        // make the bundle unrunnable (config.js emergs). Refuse unless --force.
        var missingEnvs = checkDefaultPort(defProtocol, defScheme);
        if ( missingEnvs.length > 0 && !force ) {
            console.error('Bundle [ '+ self.name +'@'+ self.projectName +' ] has no port allocated for the project default protocol '+ defProtocol +'/'+ defScheme +' (env: '+ missingEnvs.join(', ') +'). Run `gina protocol:set '+ self.name +' @'+ self.projectName +'` to (re)assign a port, or re-run with --force to revert anyway.');
            process.exit(1);
            return;
        }

        if ( dryRun ) {
            return report(curProtocol, curScheme, defProtocol, defScheme, missingEnvs, true, format);
        }

        // revert: drop the bundle's protocol override so config.js falls back
        // to the project default at load time.
        if ( settings.server ) {
            delete settings.server.protocol;
            delete settings.server.scheme;
            delete settings.server.allowHTTP1;
        }
        writeSettings(settingsPath, parsed.header, settings);

        report(curProtocol, curScheme, defProtocol, defScheme, missingEnvs, false, format);
    }


    init()
};

module.exports = Remove
