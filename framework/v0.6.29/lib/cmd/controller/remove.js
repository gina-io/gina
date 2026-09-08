var fs        = require('fs');
var readline  = require('readline');
var rl        = readline.createInterface(process.stdin, process.stdout);
var console   = lib.logger;

var CmdHelper = require('./../helper');
var args      = require('./inc/args');
var ns        = require('./inc/namespace');
var refScan   = require('./inc/reference-scan');

/**
 * @module gina/lib/cmd/controller/remove
 */
/**
 * Removes a NAMESPACE controller from a bundle — but only after a
 * reference-aware safety scan. A controller is referenced purely by its
 * namespace string, and a routing rule that names a namespace with no matching
 * `controller.<name>.js` does NOT error — it silently falls back to the default
 * `controller.js` (a misdispatch). So a bare delete is unsafe: `remove` scans
 * the four reference sites (routing.json rule-level `namespace` + `param.namespace`,
 * `requireController('<name>')` literals across the bundle `.js` tree) and
 * REFUSES if any blocking reference remains, listing every one so you can repoint
 * it first. When clean, it confirms interactively, then deletes the controller
 * file and its `templates/html/<name>/` tree. It NEVER edits routing.json.
 *
 * The default controller (`controller.js`, namespace `controller`) is reserved
 * and can never be removed. `controller:rm` is a thin alias.
 *
 * Bundle-scoped, same-project: `gina controller:remove <name> <bundle> @<project>`.
 *
 * Usage:
 *  gina controller:remove <name> <bundle> @<project>
 *  gina controller:remove <name> <bundle> @<project> --dry-run
 *  gina controller:remove <name> <bundle> @<project> --dry-run --format=json
 *  gina controller:remove <name> <bundle> @<project> --force    // delete the file even with blockers (routing.json is never touched)
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
 *  // refuse when a routing rule still points at the controller
 *  $ gina controller:remove checkout demo @myproject
 *  Cannot remove controller "checkout" from demo@myproject — 1 blocking reference:
 *    config/routing.json
 *      - rule "checkout-start"  ("namespace": "checkout")
 */
function Remove(opt, cmd) {
    var self  = {};
    var local = { name: null, bundle: null };

    /**
     * Wires CmdHelper, parses the two positionals (controller name + bundle) via
     * the group's own parser (CmdHelper's positional cleanup is `bundle:`-only),
     * validates the project, then runs the removal.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        var positionals = args.positionals(opt.argv);
        if ( positionals.length !== 2 ) {
            console.error('controller:remove requires a controller name AND a bundle: gina controller:remove <name> <bundle> @<project>');
            process.exit(1);
            return;
        }
        local.name   = positionals[0];
        local.bundle = positionals[1];

        if ( self.projectName == null || typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
            return;
        }

        loadAssets();

        run();
    };

    /**
     * Splits the scan into the blocking subset for a REMOVE: every routing
     * reference blocks, and every `requireController('<name>')` reference blocks
     * EXCEPT one inside the controller file being deleted (it goes away with the
     * file). Dynamic references are advisory (surfaced, never counted as clean).
     *
     * @inner
     * @private
     * @param {object} scan - Output of refScan.scan
     * @returns {{routing: Array, require: Array, count: number}}
     */
    var blockers = function(scan) {
        var routing = scan.routingRefs;
        var require_ = scan.requireRefs.filter(function(r) {
            return r.file !== scan.controllerFile; // a self-reference is moot on delete
        });
        return { routing: routing, require: require_, count: routing.length + require_.length };
    };

    /**
     * Renders the advisory dynamic-reference note (`:variable` namespaces,
     * non-literal `requireController(...)`) — surfaced on every report so a
     * static "clean" verdict is never mistaken for a runtime guarantee.
     *
     * @inner
     * @private
     * @param {Array} dynamicRefs
     * @returns {string[]} lines (empty when none)
     */
    var dynamicNote = function(dynamicRefs) {
        if ( !dynamicRefs || dynamicRefs.length === 0 ) return [];
        var lines = ['', 'Note — '+ dynamicRefs.length +' dynamic reference'+ (dynamicRefs.length === 1 ? '' : 's') +' a static scan cannot resolve (verify manually):'];
        for (var i = 0; i < dynamicRefs.length; i++) {
            var d = dynamicRefs[i];
            if ( d.kind === 'routing-namespace' ) {
                lines.push('  - '+ d.file +' rule "'+ d.rule +'" '+ d.site +' = "'+ d.value +'" (resolved from the URL at request time)');
            } else {
                lines.push('  - '+ d.file +' line '+ d.line +': requireController(<expression>)');
            }
        }
        return lines;
    };

    /**
     * Builds the deletion-set lines (controller file + template tree) shown in
     * the plan / dry-run / removed reports.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {string} verb - 'delete' (plan) or 'deleted' (result)
     * @returns {string[]}
     */
    var deletionLines = function(scan, verb) {
        var lines = ['  - '+ verb +' '+ scan.controllerFile];
        if ( scan.templateDir ) {
            var count = countTemplateFiles(scan.templatePath);
            lines.push('  - '+ verb +' '+ scan.templateDir +'/ ('+ count +' file'+ (count === 1 ? '' : 's') +')');
        }
        return lines;
    };

    /**
     * Groups blocking references by file into a printable block.
     *
     * @inner
     * @private
     * @param {{routing: Array, require: Array}} b
     * @param {string} name
     * @returns {string[]}
     */
    var blockerLines = function(b, name) {
        var byFile = {}, order = [];
        var push = function(file, line) {
            if ( !byFile[file] ) { byFile[file] = []; order.push(file); }
            byFile[file].push(line);
        };
        for (var i = 0; i < b.routing.length; i++) {
            var r = b.routing[i];
            push(r.file, '    - rule "'+ r.rule +'"  ("'+ r.site +'": "'+ name +'")');
        }
        for (var j = 0; j < b.require.length; j++) {
            var q = b.require[j];
            push(q.file, '    - line '+ q.line +": requireController('"+ name +"')");
        }
        var lines = [];
        for (var k = 0; k < order.length; k++) {
            lines.push('  '+ order[k]);
            lines = lines.concat(byFile[order[k]]);
        }
        return lines;
    };

    /**
     * Deletes the controller file and (if present) its template tree.
     *
     * @inner
     * @private
     * @param {object} scan
     */
    var performDelete = function(scan) {
        // controller file
        try { fs.rmSync(scan.controllerPath, { force: true }); } catch (e) {
            console.error('Failed to delete '+ scan.controllerFile +': '+ (e.message || e));
            process.exit(1);
        }
        // template tree (recursive)
        if ( scan.templatePath ) {
            try { fs.rmSync(scan.templatePath, { recursive: true, force: true }); } catch (e) {
                console.error('Failed to delete '+ scan.templateDir +': '+ (e.message || e));
                process.exit(1);
            }
        }
    };

    /**
     * Emits the machine-readable envelope and exits. Never deletes on its own —
     * `opts.removed` reflects whether the caller already performed the deletion.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {object} b - blockers()
     * @param {{dryRun: boolean, force: boolean, removed: boolean}} opts
     */
    var emitJson = function(scan, b, opts) {
        fs.writeSync(1, JSON.stringify({
            name           : local.name,
            bundle         : local.bundle,
            project        : self.projectName,
            controllerFile : scan.controllerFile,
            templateDir    : scan.templateDir,
            routingRefs    : b.routing,
            requireRefs    : b.require,
            dynamicRefs    : scan.dynamicRefs,
            blocking       : b.count,
            removable      : b.count === 0,
            dryRun         : !!opts.dryRun,
            force          : !!opts.force,
            removed        : !!opts.removed
        }));
        process.exit(0);
    };

    /**
     * Prints the plan (deletion set + any blockers + dynamic note) without
     * touching anything — the `--dry-run` report.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {object} b
     */
    var reportDryRun = function(scan, b) {
        var lines = ['', '[ dry-run ] would remove controller "'+ local.name +'" from '+ local.bundle +'@'+ self.projectName +' (no changes written).'];
        lines = lines.concat(deletionLines(scan, 'delete'));
        if ( b.count > 0 ) {
            lines.push('', 'Blocked — '+ b.count +' reference'+ (b.count === 1 ? '' : 's') +' still point'+ (b.count === 1 ? 's' : '') +' at "'+ local.name +'":');
            lines = lines.concat(blockerLines(b, local.name));
            lines.push('', 'routing.json is never edited by this command — repoint these first, or pass --force.');
        } else {
            lines.push('  no blocking references.');
        }
        lines = lines.concat(dynamicNote(scan.dynamicRefs));
        lines.push('');
        fs.writeSync(1, lines.join('\n'));
        process.exit(0);
    };

    /**
     * Prints the refusal report and exits non-zero (blocked, no `--force`).
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {object} b
     */
    var reportRefusal = function(scan, b) {
        var lines = ['', 'Cannot remove controller "'+ local.name +'" from '+ local.bundle +'@'+ self.projectName +' — '+ b.count +' blocking reference'+ (b.count === 1 ? '' : 's') +':', ''];
        lines = lines.concat(blockerLines(b, local.name));
        lines.push('', 'Remove or repoint these first (a stale namespace silently falls back to', 'controller.js — see the docs), or re-run with --force to delete the', 'controller file only, leaving the references for you to clean.');
        lines = lines.concat(dynamicNote(scan.dynamicRefs));
        lines.push('');
        fs.writeSync(1, lines.join('\n'));
        process.exit(1);
    };

    /**
     * Deletes on `--force` (skips the blocker refusal AND the confirmation),
     * then prints what was deleted plus any references left for manual cleanup.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {object} b
     */
    var reportForce = function(scan, b) {
        var deleted = deletionLines(scan, 'deleted'); // count the template files BEFORE deleting them
        performDelete(scan);
        var lines = ['', 'Force-removed controller "'+ local.name +'" from '+ local.bundle +'@'+ self.projectName +' (--force):'];
        lines = lines.concat(deleted);
        if ( b.count > 0 ) {
            lines.push('', b.count +' reference'+ (b.count === 1 ? '' : 's') +' NOT touched (routing.json is never edited) — clean up manually:');
            lines = lines.concat(blockerLines(b, local.name));
        }
        lines = lines.concat(dynamicNote(scan.dynamicRefs));
        lines.push('');
        fs.writeSync(1, lines.join('\n'));
        process.exit(0);
    };

    /**
     * The clean, interactive path: prints the deletion plan, prompts yes/no, and
     * deletes on confirmation. A non-interactive stdin (no TTY) aborts with a
     * message naming the `--force` / `--dry-run` bypasses (the readline would
     * otherwise throw on a closed stream — the `view:add` guard).
     *
     * @inner
     * @private
     * @param {object} scan
     */
    var confirmThenDelete = function(scan) {
        if ( !process.stdin.isTTY || rl.closed ) {
            console.error(
                'Removing controller "'+ local.name +'" needs an interactive confirmation, and stdin is not a TTY.\n'
                + 'Re-run in an interactive terminal, or pass --force to delete non-interactively, or --dry-run to preview.'
            );
            return process.exit(1);
        }
        var plan = ['', 'Remove controller "'+ local.name +'" from '+ local.bundle +'@'+ self.projectName +'?'];
        plan = plan.concat(deletionLines(scan, 'delete'));
        plan = plan.concat(dynamicNote(scan.dynamicRefs));
        plan.push('');
        fs.writeSync(1, plan.join('\n'));

        rl.setPrompt('Proceed? (yes|no) > \n');
        rl.prompt();
        rl.on('line', function(line) {
            switch ( line.trim().toLowerCase() ) {
                case 'y':
                case 'yes':
                    var done = ['', 'Removed controller "'+ local.name +'" from '+ local.bundle +'@'+ self.projectName +':'];
                    done = done.concat(deletionLines(scan, 'deleted')); // count BEFORE deleting
                    performDelete(scan);
                    done.push('');
                    fs.writeSync(1, done.join('\n'));
                    process.exit(0);
                    break;
                case 'n':
                case 'no':
                    console.log('Aborted — nothing removed.');
                    process.exit(0);
                    break;
                default:
                    console.log('Please write "yes" to proceed or "no" to cancel.');
                    rl.prompt();
                    break;
            }
        }).on('close', function() {
            process.exit(0); // Ctrl-D without answering → abort
        });
    };

    /**
     * Validates the namespace / bundle, scans the reference sites, then routes to
     * the JSON / dry-run / refusal / force / interactive-confirm branch.
     *
     * @inner
     * @private
     */
    var run = function() {
        var p       = self.params || {}
            , dryRun  = !!p['dry-run']
            , force   = !!p['force']
            , format  = p['format'] || null
            , jsonMode = /^json?/.test(format || '')
            , name    = local.name
            , bundle  = local.bundle
            , project = self.projectName;

        // 1) namespace charset + reserved guard (rejects the default `controller`)
        if ( !ns.isValidNamespace(name) ) {
            console.error('[ '+ name +' ] is not a valid controller name. Use a lowercase letter followed by letters, digits or underscores (reserved: '+ ns.RESERVED.join(', ') +' — the default controller is never removable).');
            process.exit(1);
            return;
        }

        // 2) bundle must be registered + present on disk
        var srcEntry = (self.bundlesByProject && self.bundlesByProject[project])
            ? self.bundlesByProject[project][bundle]
            : null;
        if ( !srcEntry ) {
            console.error('Bundle [ '+ bundle +' ] is not registered inside `@'+ project +'`.');
            process.exit(1);
            return;
        }
        var srcPath = _(self.projects[project].path + '/' + srcEntry.src, true).toString();
        if ( !fs.existsSync(srcPath) ) {
            console.error('Bundle directory `'+ srcPath +'` does not exist.');
            process.exit(1);
            return;
        }

        // 3) scan the reference sites
        var scan = refScan.scan(srcPath, name);

        // 4) the controller must exist to be removed
        if ( !scan.controllerFile ) {
            console.error('Controller [ '+ ns.controllerFileName(name) +' ] does not exist in bundle [ '+ bundle +'@'+ project +' ]. Nothing to remove.');
            process.exit(1);
            return;
        }

        var b = blockers(scan);

        // JSON mode is non-interactive: it reports the plan, and only deletes when
        // --force is present (never on an un-forced interactive confirmation).
        if ( jsonMode ) {
            if ( !dryRun && force ) {
                performDelete(scan);
                return emitJson(scan, b, { dryRun: false, force: true, removed: true });
            }
            return emitJson(scan, b, { dryRun: dryRun, force: force, removed: false });
        }

        // text mode
        if ( dryRun ) {
            return reportDryRun(scan, b);
        }
        if ( b.count > 0 && !force ) {
            return reportRefusal(scan, b);
        }
        if ( force ) {
            return reportForce(scan, b);
        }
        // clean + interactive
        confirmThenDelete(scan);
    };

    init();
};

/**
 * Counts the files under a template directory (for the deletion-plan line).
 *
 * @inner
 * @private
 * @param {string} dir
 * @returns {number}
 */
function countTemplateFiles(dir) {
    var count = 0;
    var walk = function(d) {
        var entries = [];
        try { entries = fs.readdirSync(d); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
            var full = d + '/' + entries[i];
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if ( st.isDirectory() ) walk(full);
            else count++;
        }
    };
    walk(dir);
    return count;
}

module.exports = Remove
