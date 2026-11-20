var fs        = require('fs');
var path      = require('path');
var readline  = require('readline');
var rl        = readline.createInterface(process.stdin, process.stdout);
var console   = lib.logger;

var CmdHelper = require('./../helper');
var args      = require('./inc/args');
var ns        = require('./inc/namespace');
var refScan   = require('./inc/reference-scan');
var rewrite   = require('./inc/reference-rewrite');

/**
 * @module gina/lib/cmd/controller/rename
 */
/**
 * Renames a NAMESPACE controller IN PLACE within a bundle, rewriting the
 * structured references to the OLD namespace so nothing dangles. Unlike
 * `controller:remove` (which never touches routing.json), `rename` DOES rewrite
 * routing.json — but only the `"namespace": "<old>"` VALUES, via anchored,
 * comment-preserving string ops (never a JSON parse→stringify, which would drop
 * comments + ordering). It moves `controllers/controller.<old>.js` →
 * `controller.<new>.js`, rewrites both routing sites (rule-level `namespace`
 * and `param.namespace`) and every `requireController('<old>')` literal, and
 * moves the `templates/html/<old>/` tree. A full plan is shown first, then it
 * confirms interactively before applying (all-or-nothing, snapshot-guarded).
 *
 * Only the four STRUCTURED sites are rewritten. Anything a static rewrite cannot
 * safely express — a `:variable` `param.namespace`, a non-literal
 * `requireController(...)`, or the cosmetic `<Bundle><Namespace>Controller` class
 * name inside the moved file — is REPORTED, never rewritten.
 *
 * Bundle-scoped, same-project: `gina controller:rename <old> <new> <bundle> @<project>`.
 *
 * Usage:
 *  gina controller:rename <old> <new> <bundle> @<project>
 *  gina controller:rename <old> <new> <bundle> @<project> --dry-run
 *  gina controller:rename <old> <new> <bundle> @<project> --dry-run --format=json
 *  gina controller:rename <old> <new> <bundle> @<project> --force   // apply without the interactive confirm
 *
 * @class Rename
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // rename controller `checkout` to `basket` in bundle `demo`
 *  $ gina controller:rename checkout basket demo @myproject
 *  Renamed controller "checkout" -> "basket" in demo@myproject.
 */
function Rename(opt, cmd) {
    var self  = {};
    var local = { old: null, neu: null, bundle: null };

    /**
     * Wires CmdHelper, parses the THREE positionals (old + new + bundle) via the
     * group's own parser, validates the project, then runs the rename.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        var positionals = args.positionals(opt.argv);
        if ( positionals.length !== 3 ) {
            console.error('controller:rename requires an old name, a new name AND a bundle: gina controller:rename <old> <new> <bundle> @<project>');
            process.exit(1);
            return;
        }
        local.old    = positionals[0];
        local.neu    = positionals[1];
        local.bundle = positionals[2];

        if ( self.projectName == null || typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
            return;
        }

        loadAssets();

        run();
    };

    /**
     * Groups the scan's requireController references by file, with a per-file
     * count (each file is rewritten once, touching all its calls).
     *
     * @inner
     * @private
     * @param {Array<{file: string, line: number}>} requireRefs
     * @returns {Array<{file: string, count: number}>}
     */
    var requireByFile = function(requireRefs) {
        var byFile = {}, order = [];
        for (var i = 0; i < requireRefs.length; i++) {
            var f = requireRefs[i].file;
            if ( typeof(byFile[f]) == 'undefined' ) { byFile[f] = 0; order.push(f); }
            byFile[f]++;
        }
        return order.map(function(f) { return { file: f, count: byFile[f] }; });
    };

    /**
     * Renders the advisory residual note (dynamic references + the cosmetic class
     * name) — the things a rename REPORTS instead of rewriting.
     *
     * @inner
     * @private
     * @param {Array} dynamicRefs
     * @returns {string[]}
     */
    var residualNote = function(dynamicRefs) {
        var lines = [];
        if ( dynamicRefs && dynamicRefs.length > 0 ) {
            lines.push('', 'Not rewritten — '+ dynamicRefs.length +' dynamic reference'+ (dynamicRefs.length === 1 ? '' : 's') +' a static rewrite cannot resolve (fix by hand):');
            for (var i = 0; i < dynamicRefs.length; i++) {
                var d = dynamicRefs[i];
                if ( d.kind === 'routing-namespace' ) {
                    lines.push('  - '+ d.file +' rule "'+ d.rule +'" '+ d.site +' = "'+ d.value +'"');
                } else {
                    lines.push('  - '+ d.file +' line '+ d.line +': requireController(<expression>)');
                }
            }
        }
        // the controller class name is cosmetic (gina loads by file path) — flagged, not rewritten
        lines.push('', 'Note — the controller file is moved and its requireController() calls rewritten,');
        lines.push('but the `'+ ns.className(local.bundle, local.old) +'` class name and any comments inside it are left as-is (cosmetic — gina loads by file path).');
        return lines;
    };

    /**
     * Builds the plan lines (moves + rewrites) shown in the dry-run / confirm /
     * success reports. `verb` is 'would'/'move'/'moved' etc. via the two args.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {number} tplCount - files in the template dir (0 when none)
     * @param {('plan'|'done')} mode
     * @returns {string[]}
     */
    var planLines = function(scan, tplCount, mode) {
        var moveVerb = (mode === 'done') ? 'moved' : 'move';
        var rwVerb   = (mode === 'done') ? 'rewrote' : 'rewrite';
        var lines = [];
        lines.push('  - '+ moveVerb +' '+ scan.controllerFile +' -> controllers/'+ ns.controllerFileName(local.neu));
        if ( scan.templateDir ) {
            lines.push('  - '+ moveVerb +' '+ scan.templateDir +'/ -> templates/html/'+ local.neu +'/ ('+ tplCount +' file'+ (tplCount === 1 ? '' : 's') +')');
        }
        if ( scan.routingRefs.length > 0 ) {
            lines.push('  - '+ rwVerb +' config/routing.json ('+ scan.routingRefs.length +' namespace value'+ (scan.routingRefs.length === 1 ? '' : 's') +')');
        }
        var byFile = requireByFile(scan.requireRefs);
        for (var i = 0; i < byFile.length; i++) {
            lines.push('  - '+ rwVerb +' '+ byFile[i].file +' ('+ byFile[i].count +' requireController call'+ (byFile[i].count === 1 ? '' : 's') +')');
        }
        return lines;
    };

    /**
     * Applies the rename all-or-nothing: rewrites routing.json + the flagged .js
     * files, moves the controller file, then moves the template tree. Every write
     * + move is snapshotted; any failure rolls the whole thing back.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {string} srcPath - absolute bundle source root
     * @returns {{routingRewrites: number, requireRewrites: Array<{file: string, count: number}>}}
     */
    var applyRename = function(scan, srcPath) {
        var oldCtrlAbs = scan.controllerPath;
        var newCtrlAbs = path.join(srcPath, 'controllers', ns.controllerFileName(local.neu));
        var newTplAbs  = scan.templatePath ? path.join(srcPath, 'templates', 'html', local.neu) : null;

        var snapshot = { moves: [], writes: [] };
        var result   = { routingRewrites: 0, requireRewrites: [] };

        var rollback = function(err) {
            // restore rewritten contents first (at their recorded paths)…
            for (var i = 0; i < snapshot.writes.length; i++) {
                try { lib.generator.createFileFromDataSync(snapshot.writes[i].original, snapshot.writes[i].path); } catch (e) {}
            }
            // …then reverse the moves LIFO
            for (var j = snapshot.moves.length - 1; j >= 0; j--) {
                try { fs.renameSync(snapshot.moves[j].to, snapshot.moves[j].from); } catch (e) {}
            }
            console.error('could not complete controller rename: '+ (err && (err.stack || err.message) || err));
            console.warn('rolled back — no changes kept.');
            process.exit(1);
        };

        try {
            // 1) rewrite routing.json (namespace values) — before the moves so a
            //    rollback of a later step can restore it in place
            if ( scan.routingRefs.length > 0 ) {
                var rAbs  = path.join(srcPath, 'config', 'routing.json');
                var rOrig = fs.readFileSync(rAbs, 'utf8');
                var rRes  = rewrite.rewriteRoutingNamespace(rOrig, local.old, local.neu);
                if ( rRes.content !== rOrig ) {
                    snapshot.writes.push({ path: rAbs, original: rOrig });
                    lib.generator.createFileFromDataSync(rRes.content, rAbs);
                }
                result.routingRewrites = rRes.count;
            }

            // 2) rewrite requireController('<old>') in each flagged .js file
            //    (still at their current paths — the controller file has NOT moved yet)
            var byFile = requireByFile(scan.requireRefs);
            for (var k = 0; k < byFile.length; k++) {
                var relf = byFile[k].file;
                var abs  = path.join(srcPath, relf);
                var orig = fs.readFileSync(abs, 'utf8');
                var res  = rewrite.rewriteRequireController(orig, local.old, local.neu);
                if ( res.content !== orig ) {
                    snapshot.writes.push({ path: abs, original: orig });
                    lib.generator.createFileFromDataSync(res.content, abs);
                }
                result.requireRewrites.push({ file: relf, count: res.count });
            }

            // 3) move the controller file (carries the rewritten self-references)
            fs.renameSync(oldCtrlAbs, newCtrlAbs);
            snapshot.moves.push({ from: oldCtrlAbs, to: newCtrlAbs });

            // 4) move the template tree
            if ( newTplAbs ) {
                fs.renameSync(scan.templatePath, newTplAbs);
                snapshot.moves.push({ from: scan.templatePath, to: newTplAbs });
            }
        } catch (err) {
            return rollback(err);
        }

        return result;
    };

    /**
     * Emits the machine-readable envelope and exits.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {number} tplCount
     * @param {{dryRun: boolean, force: boolean, renamed: boolean, applied: (object|null)}} opts
     */
    var emitJson = function(scan, tplCount, opts) {
        var requireRewrites = opts.applied ? opts.applied.requireRewrites : requireByFile(scan.requireRefs);
        fs.writeSync(1, JSON.stringify({
            old            : local.old,
            new            : local.neu,
            bundle         : local.bundle,
            project        : self.projectName,
            controllerMove : { from: scan.controllerFile, to: 'controllers/' + ns.controllerFileName(local.neu) },
            templateMove   : scan.templateDir ? { from: scan.templateDir, to: 'templates/html/' + local.neu } : null,
            routingRewrites: opts.applied ? opts.applied.routingRewrites : scan.routingRefs.length,
            requireRewrites: requireRewrites,
            dynamicRefs    : scan.dynamicRefs,
            dryRun         : !!opts.dryRun,
            force          : !!opts.force,
            renamed        : !!opts.renamed
        }));
        process.exit(0);
    };

    /**
     * Prints the dry-run preview (plan + residuals) without changing anything.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {number} tplCount
     */
    var reportDryRun = function(scan, tplCount) {
        var lines = ['', '[ dry-run ] would rename controller "'+ local.old +'" -> "'+ local.neu +'" in '+ local.bundle +'@'+ self.projectName +' (no changes written).'];
        lines = lines.concat(planLines(scan, tplCount, 'plan'));
        lines = lines.concat(residualNote(scan.dynamicRefs));
        lines.push('');
        fs.writeSync(1, lines.join('\n'));
        process.exit(0);
    };

    /**
     * Applies the rename, then prints what was done. Shared by `--force` and the
     * interactive yes-branch.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {number} tplCount
     * @param {string} srcPath
     */
    var doRenameAndReport = function(scan, tplCount, srcPath) {
        var applied = applyRename(scan, srcPath);
        var lines = ['', 'Renamed controller "'+ local.old +'" -> "'+ local.neu +'" in '+ local.bundle +'@'+ self.projectName +':'];
        lines = lines.concat(planLines(scan, tplCount, 'done'));
        lines = lines.concat(residualNote(scan.dynamicRefs));
        lines.push('', 'Then restart the bundle.', '');
        fs.writeSync(1, lines.join('\n'));
        process.exit(0);
    };

    /**
     * The interactive path: prints the full plan, prompts yes/no, applies on
     * confirmation. A non-TTY stdin aborts, naming `--force` / `--dry-run`.
     *
     * @inner
     * @private
     * @param {object} scan
     * @param {number} tplCount
     * @param {string} srcPath
     */
    var confirmThenRename = function(scan, tplCount, srcPath) {
        if ( !process.stdin.isTTY || rl.closed ) {
            console.error(
                'Renaming controller "'+ local.old +'" needs an interactive confirmation, and stdin is not a TTY.\n'
                + 'Re-run in an interactive terminal, or pass --force to apply non-interactively, or --dry-run to preview.'
            );
            return process.exit(1);
        }
        var plan = ['', 'Rename controller "'+ local.old +'" -> "'+ local.neu +'" in '+ local.bundle +'@'+ self.projectName +'?'];
        plan = plan.concat(planLines(scan, tplCount, 'plan'));
        plan = plan.concat(residualNote(scan.dynamicRefs));
        plan.push('');
        fs.writeSync(1, plan.join('\n'));

        rl.setPrompt('Proceed? (yes|no) > \n');
        rl.prompt();
        rl.on('line', function(line) {
            switch ( line.trim().toLowerCase() ) {
                case 'y':
                case 'yes':
                    doRenameAndReport(scan, tplCount, srcPath);
                    break;
                case 'n':
                case 'no':
                    console.log('Aborted — nothing renamed.');
                    process.exit(0);
                    break;
                default:
                    console.log('Please write "yes" to proceed or "no" to cancel.');
                    rl.prompt();
                    break;
            }
        }).on('close', function() {
            process.exit(0);
        });
    };

    /**
     * Validates the old/new names + bundle, refuses on a missing source or a
     * target collision, scans the OLD references, then routes to the JSON /
     * dry-run / force / interactive-confirm branch.
     *
     * @inner
     * @private
     */
    var run = function() {
        var p        = self.params || {}
            , dryRun   = !!p['dry-run']
            , force    = !!p['force']
            , format   = p['format'] || null
            , jsonMode = /^json?/.test(format || '')
            , oldN     = local.old
            , newN     = local.neu
            , bundle   = local.bundle
            , project  = self.projectName;

        // 1) both names valid + reserved guard, and they must differ
        if ( !ns.isValidNamespace(oldN) ) {
            console.error('[ '+ oldN +' ] is not a valid controller name (reserved: '+ ns.RESERVED.join(', ') +').');
            process.exit(1);
            return;
        }
        if ( !ns.isValidNamespace(newN) ) {
            console.error('[ '+ newN +' ] is not a valid new controller name. Use a lowercase letter followed by letters, digits or underscores ('+ ns.RESERVED.join(', ') +' is reserved).');
            process.exit(1);
            return;
        }
        if ( oldN === newN ) {
            console.error('Old and new names are identical (`'+ oldN +'`). Choose a different new name.');
            process.exit(1);
            return;
        }

        // 2) bundle registered + on disk
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

        // 3) scan the OLD namespace
        var scan = refScan.scan(srcPath, oldN);

        // 4) source controller must exist
        if ( !scan.controllerFile ) {
            console.error('Controller [ '+ ns.controllerFileName(oldN) +' ] does not exist in bundle [ '+ bundle +'@'+ project +' ]. Nothing to rename.');
            process.exit(1);
            return;
        }

        // 5) target must NOT collide (no overwrite — remove the target first)
        var newCtrl = path.join(srcPath, 'controllers', ns.controllerFileName(newN));
        var newTpl  = path.join(srcPath, 'templates', 'html', newN);
        if ( fs.existsSync(newCtrl) ) {
            console.error('Controller [ '+ ns.controllerFileName(newN) +' ] already exists in bundle [ '+ bundle +'@'+ project +' ]. Remove it first, or choose a different new name.');
            process.exit(1);
            return;
        }
        if ( scan.templateDir && fs.existsSync(newTpl) ) {
            console.error('Template directory [ templates/html/'+ newN +'/ ] already exists in bundle [ '+ bundle +'@'+ project +' ]. Remove it first, or choose a different new name.');
            process.exit(1);
            return;
        }

        var tplCount = scan.templatePath ? countFiles(scan.templatePath) : 0;

        // JSON mode is non-interactive: preview unless --force applies it.
        if ( jsonMode ) {
            if ( !dryRun && force ) {
                var applied = applyRename(scan, srcPath);
                return emitJson(scan, tplCount, { dryRun: false, force: true, renamed: true, applied: applied });
            }
            return emitJson(scan, tplCount, { dryRun: dryRun, force: force, renamed: false, applied: null });
        }

        // text mode
        if ( dryRun ) {
            return reportDryRun(scan, tplCount);
        }
        if ( force ) {
            return doRenameAndReport(scan, tplCount, srcPath);
        }
        confirmThenRename(scan, tplCount, srcPath);
    };

    init();
};

/**
 * Counts the files under a directory (for the template-move plan line).
 *
 * @inner
 * @private
 * @param {string} dir
 * @returns {number}
 */
function countFiles(dir) {
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

module.exports = Rename
