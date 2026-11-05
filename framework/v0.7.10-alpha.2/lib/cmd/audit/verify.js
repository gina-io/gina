var fs        = require('fs');
var console   = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/audit/verify
 */
/**
 * Verifies the tamper-evidence hash chain of a bundle's audit trail
 * (#COMPLY2 slice 3). Walks the JSONL file and recomputes every record's
 * `hash` (`HMAC-SHA256(secret, prevHash + ':' + canonicalV1(record))`);
 * reports the FIRST break with its line and reason, or the intact totals.
 *
 * Offline command — reads the trail file directly, no daemon and no running
 * bundle needed. The chain engine is `lib.audit.verifyChain` (the single
 * canonical implementation, shared with the tests); this handler only
 * resolves WHICH file and WHICH key.
 *
 * File resolution: `--file=</abs/path>` wins; otherwise the bundle's
 * `config/settings.json > audit.file` is replayed exactly like the boot does
 * (absolute as-is; relative against the project root; absent → the default
 * `<project>/logs/audit-<bundle>-<env>.jsonl`).
 *
 * Key resolution: `settings.json > audit.chain.secret` (a `${secret:VAR}`
 * placeholder is resolved here because config-load substitution does not run
 * offline — read from the framework env reader first, then `process.env[VAR]`,
 * so GINA_-prefixed names swept out of process.env by the CLI still resolve,
 * #B156), then `GINA_AUDIT_SECRET` through the same two-tier read.
 *
 * Exit codes: `0` chain intact (warnings, if any, are printed — read them) ·
 * `1` chain BROKEN · `2` usage/config error (no trail file, no key, bad --env).
 *
 * Usage:
 *  gina audit:verify <bundle> @<project>
 *  gina audit:verify <bundle> @<project> --env=prod
 *  gina audit:verify <bundle> @<project> --file=/var/log/audit-web-prod.jsonl
 *  gina audit:verify <bundle> @<project> --format=json
 *
 * @class Verify
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  $ gina audit:verify web @myproject --env=prod
 *  [ audit:verify ] /srv/myproject/logs/audit-web-prod.jsonl
 *  OK — chain intact: 1042 chained record(s), 17 pre-chain record(s)
 */
function Verify(opt, cmd) {
    var self  = {};
    var local = { bundle: null, env: null, file: null, secret: null };

    /**
     * Wires CmdHelper, parses the bundle positional, resolves env / trail
     * file / signing key, then runs the verification.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        // ONE positional (the bundle). CmdHelper's positional cleanup only
        // runs for `bundle:` tasks, so parse argv directly: everything after
        // the task token that is neither `@<project>` nor a `--flag`.
        var positionals = [];
        for (var i = 3; i < opt.argv.length; ++i) {
            if ( /^\@/.test(opt.argv[i]) || /^--/.test(opt.argv[i]) ) continue;
            positionals.push(opt.argv[i]);
        }
        if ( positionals.length !== 1 ) {
            console.error('audit:verify requires a bundle: gina audit:verify <bundle> @<project> [--env=<env>] [--file=</abs/path>] [--format=json]');
            process.exit(2);
            return;
        }
        local.bundle = positionals[0];

        if ( self.projectName == null || typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(2);
            return;
        }

        if ( !resolveEnv() || !resolveFile() || !resolveSecret() ) {
            return; // each resolver exits with code 2 on failure
        }

        run();
    };

    /**
     * Resolves the env: `--env` when given (validated against the project's
     * env list — the CmdHelper `--env` override only fires for lifecycle
     * tasks, so read `self.params` directly), else the project default.
     *
     * @inner
     * @private
     * @returns {boolean}
     */
    var resolveEnv = function() {
        var p = self.params || {};
        if ( typeof(p.env) != 'undefined' ) {
            if ( !Array.isArray(self.envs) || self.envs.indexOf(p.env) < 0 ) {
                console.error('Environment `'+ p.env +'` not found in your project [ '+ self.projectName +' ]');
                process.exit(2);
                return false;
            }
            local.env = p.env;
        } else {
            local.env = self.projects[self.projectName].def_env;
        }
        return true;
    };

    /**
     * Resolves the trail file: `--file` (absolute) wins; otherwise replays the
     * boot's derivation from the bundle's `config/settings.json > audit`.
     *
     * @inner
     * @private
     * @returns {boolean}
     */
    var resolveFile = function() {
        var p = self.params || {};
        if ( typeof(p.file) != 'undefined' ) {
            if ( typeof(p.file) != 'string' || !/^\//.test(p.file) ) {
                console.error('--file must be an absolute path.');
                process.exit(2);
                return false;
            }
            local.file = p.file;
            return true;
        }

        var projectPath = self.projects[self.projectName].path;
        var srcEntry = ( self.bundlesByProject && self.bundlesByProject[self.projectName] )
            ? self.bundlesByProject[self.projectName][local.bundle]
            : null;
        if ( !srcEntry ) {
            console.error('Bundle [ '+ local.bundle +' ] is not registered inside `@'+ self.projectName +'`.');
            process.exit(2);
            return false;
        }

        var auditSettings = readAuditSettings(projectPath, srcEntry.src);
        if ( auditSettings && auditSettings.store ) {
            console.error('Bundle [ '+ local.bundle +' ] uses the connector store backend (`audit.store`) — the chain requires the file backend, so there is no trail file to derive. Pass --file explicitly if a file trail exists elsewhere.');
            process.exit(2);
            return false;
        }

        var file = ( auditSettings && typeof(auditSettings.file) == 'string' && auditSettings.file ) ? auditSettings.file : null;
        if ( !file || !/^\//.test(file) ) {
            file = file
                ? projectPath + '/' + file
                : projectPath + '/logs/audit-'+ local.bundle +'-'+ local.env +'.jsonl';
        }
        local.file = _(file, true).toString();
        return true;
    };

    /**
     * Reads the bundle's `settings.json > audit` block — `requireJSON`, never
     * `JSON.parse` (settings files routinely carry `//` comments). A missing
     * or unreadable file falls through to `null` (the defaults still let the
     * default trail path be derived).
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string} srcRel - the bundle's `src` entry from manifest.json
     * @returns {?object}
     */
    var readAuditSettings = function(projectPath, srcRel) {
        try {
            var settingsPath = _(projectPath + '/' + srcRel + '/config/settings.json', true);
            if ( !fs.existsSync(settingsPath.toString()) ) return null;
            var settings = requireJSON(settingsPath);
            return ( settings && typeof(settings.audit) == 'object' && settings.audit ) ? settings.audit : null;
        } catch (err) {
            return null;
        }
    };

    /**
     * Resolves the signing key: `audit.chain.secret` (literal, or a
     * `${secret:VAR}` placeholder read from the framework env reader first,
     * then `process.env[VAR]` — the CLI sweep moves GINA_*-prefixed keys out
     * of `process.env`, so the two-tier read is what lets a shell-exported
     * variable resolve in this offline process, #B156), then
     * `GINA_AUDIT_SECRET` through the same two-tier read.
     *
     * @inner
     * @private
     * @returns {boolean}
     */
    var resolveSecret = function() {
        var projectPath = self.projects[self.projectName].path;
        var srcEntry = ( self.bundlesByProject && self.bundlesByProject[self.projectName] )
            ? self.bundlesByProject[self.projectName][local.bundle]
            : null;
        var auditSettings = srcEntry ? readAuditSettings(projectPath, srcEntry.src) : null;

        var secret = ( auditSettings && auditSettings.chain && typeof(auditSettings.chain.secret) == 'string' && auditSettings.chain.secret )
            ? auditSettings.chain.secret
            : null;
        if ( secret ) {
            var m = secret.match(/^\$\{secret:([^}]+)\}$/);
            if ( m ) {
                secret = ( typeof(getEnvVar) == 'function' && getEnvVar(m[1]) ) || process.env[m[1]] || null;
                if ( !secret ) {
                    console.error('`audit.chain.secret` names `${secret:'+ m[1] +'}` but `'+ m[1] +'` is not set in this environment. Export it before running the command, or set GINA_AUDIT_SECRET.');
                    process.exit(2);
                    return false;
                }
            }
        }
        if ( !secret ) {
            secret = ( typeof(getEnvVar) == 'function' && getEnvVar('GINA_AUDIT_SECRET') ) || process.env.GINA_AUDIT_SECRET || null;
        }
        if ( !secret ) {
            console.error('No signing key found — set `settings.json > audit.chain.secret` for [ '+ local.bundle +' ], or export GINA_AUDIT_SECRET.');
            process.exit(2);
            return false;
        }
        local.secret = secret;
        return true;
    };

    /**
     * Runs `lib.audit.verifyChain` and emits the report. Output goes through
     * `fs.writeSync(1, ...)` — `process.exit` right after an async stdout
     * write truncates on a pipe (the connector:infer lesson), and a verify
     * verdict must never be lost mid-pipe.
     *
     * @inner
     * @private
     */
    var run = function() {
        if ( !fs.existsSync(local.file) ) {
            console.error('No trail found at '+ local.file +' — nothing to verify. (A missing trail is NOT a pass.)');
            process.exit(2);
            return;
        }

        var result = lib.audit.verifyChain(local.file, local.secret);
        var jsonMode = ( self.params && self.params.format === 'json' );
        var out = '';

        if ( jsonMode ) {
            result.file = local.file;
            out = JSON.stringify(result) + '\n';
        } else {
            out = '[ audit:verify ] '+ local.file +'\n';
            if ( result.ok ) {
                out += ( result.records === 0 && result.unchained === 0 )
                    ? 'OK — empty trail (0 records)\n'
                    : 'OK — chain intact: '+ result.records +' chained record(s), '+ result.unchained +' pre-chain record(s)\n';
            } else {
                out += 'FAIL — break at line '+ result.breakAt.line +': '+ result.breakAt.reason +'\n';
                out += '  '+ result.records +' record(s) verified before the break. Remediation: investigate, then rotate the file aside to re-baseline the chain.\n';
            }
            for (var w = 0; w < result.warnings.length; ++w) {
                out += '  warning — line '+ result.warnings[w].line +': '+ result.warnings[w].type +'\n';
            }
        }

        fs.writeSync(1, out);
        end(result.ok ? 0 : 1);
    };

    /**
     * Terminates the command: closes the client socket when live, then exits.
     *
     * @inner
     * @private
     * @param {number} code
     */
    var end = function(code) {
        if ( opt.client && typeof(opt.client.emit) == 'function' ) {
            try { opt.client.emit('end'); } catch (err) { /* offline mode has no live socket */ }
        }
        process.exit(code);
    };

    init();
}

module.exports = Verify;
