var fs        = require('fs');
var console   = lib.logger;

var CmdHelper = require('./../helper');
var args      = require('./inc/args');
var ns        = require('./inc/namespace');
var scaffold  = require('./inc/scaffold');

/**
 * @module gina/lib/cmd/controller/add
 */
/**
 * Scaffolds a NAMESPACE controller inside an existing bundle and PRINTS the
 * paste-ready routing.json rules for it. Never edits routing.json (the rule
 * wiring is print-only by design — the user pastes the printed rules and
 * restarts the bundle).
 *
 * A controller is referenced purely by its namespace string
 * (`controllers/controller.<name>.js`); this command generates that file with
 * one JSDoc'd action stub per `--controls` entry (or a single house-default
 * `default` action when `--controls` is omitted). The bundle FLAVOR is
 * auto-detected: a view bundle (has `config/templates.json`) gets `self.render()`
 * stubs plus one template per action at `templates/html/<name>/<action>.html`; an
 * API-only bundle gets `self.renderJSON()` stubs and no templates. `--api` /
 * `--views` force the flavor.
 *
 * Bundle-scoped, same-project: `gina controller:add <name> <bundle> @<project>`.
 *
 * Usage:
 *  gina controller:add <name> <bundle> @<project>
 *  gina controller:add <name> <bundle> @<project> --controls=<a,b,c>
 *  gina controller:add <name> <bundle> @<project> --api      // force renderJSON stubs, no templates
 *  gina controller:add <name> <bundle> @<project> --views    // force render stubs + templates
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // scaffold a `checkout` controller with three actions in view bundle `demo`
 *  $ gina controller:add checkout demo @myproject --controls=start,confirm,cancel
 *  Creating controllers/controller.checkout.js
 *    + action start()    + templates/html/checkout/start.html
 *    ...
 */
function Add(opt, cmd) {
    var self  = {};
    var local = { name: null, bundle: null };

    /**
     * Wires CmdHelper, parses the two positionals (controller name + bundle),
     * validates the project, then runs the scaffold.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        // controller:add takes TWO positionals (name + bundle). CmdHelper's clean
        // positional list only runs for `bundle:` tasks, so parse them from argv
        // via the group's own pure parser (see inc/args.js).
        var positionals = args.positionals(opt.argv);
        if ( positionals.length !== 2 ) {
            console.error('controller:add requires a controller name AND a bundle: gina controller:add <name> <bundle> @<project>');
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
     * Builds the human-readable scaffold report (the paste-ready output that IS
     * the docs sample): the created controller file, one line per action (with
     * the created template for the view flavor), the routing.json rules block,
     * and the restart hint.
     *
     * @inner
     * @private
     * @param {string} fileName - `controller.<name>.js`
     * @param {string[]} actions
     * @param {('view'|'api')} flavor
     * @param {string} routingRel - project-relative routing.json path
     * @param {string} rulesBlock - the formatted rules block
     * @returns {string}
     */
    var buildReport = function(fileName, actions, flavor, routingRel, rulesBlock) {
        var name  = local.name
            , lines = ['Creating controllers/' + fileName];

        if ( flavor === 'view' ) {
            // align the `+ templates/...` column across the action lines
            var segs = [], maxLen = 0, i;
            for (i = 0; i < actions.length; i++) {
                var seg = '  + action ' + actions[i] + '()';
                segs.push(seg);
                if ( seg.length > maxLen ) maxLen = seg.length;
            }
            for (i = 0; i < actions.length; i++) {
                var pad = new Array((maxLen - segs[i].length) + 5).join(' ');
                lines.push(segs[i] + pad + '+ templates/html/' + name + '/' + actions[i] + '.html');
            }
        } else {
            for (var a = 0; a < actions.length; a++) {
                lines.push('  + action ' + actions[a] + '()');
            }
        }

        lines.push('');
        lines.push('Add these rules to ' + routingRel + ':');
        lines.push('');
        lines.push(rulesBlock);
        lines.push('');
        lines.push('Then restart the bundle.');
        lines.push('');
        return lines.join('\n');
    };

    /**
     * Validates the namespace / bundle / controls, refuses if the controller
     * already exists, resolves the flavor, generates the controller file (and
     * view templates), then prints the paste-ready rules.
     *
     * @inner
     * @private
     */
    var run = function() {
        var p       = self.params || {}
            , name    = local.name
            , bundle  = local.bundle
            , project = self.projectName;

        // 1) namespace charset + reserved guard (runs BEFORE any path is built —
        //    the value is interpolated into file paths, RegExps and a JS class name)
        if ( !ns.isValidNamespace(name) ) {
            console.error('[ '+ name +' ] is not a valid controller name. Use a lowercase letter followed by letters, digits or underscores (reserved: '+ ns.RESERVED.join(', ') +').');
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
        var srcRel  = srcEntry.src;
        var srcPath = _(self.projects[project].path + '/' + srcRel, true).toString();
        if ( !fs.existsSync(srcPath) ) {
            console.error('Bundle directory `'+ srcPath +'` does not exist.');
            process.exit(1);
            return;
        }

        // 3) refuse if the controller file already exists (no --force overwrite:
        //    remove it explicitly or edit it in place)
        var fileName       = ns.controllerFileName(name);
        var controllerPath = _(srcPath + '/controllers/' + fileName, true).toString();
        if ( fs.existsSync(controllerPath) ) {
            console.error('Controller [ '+ fileName +' ] already exists in bundle [ '+ bundle +'@'+ project +' ].');
            console.error('Remove it first: gina controller:remove '+ name +' '+ bundle +' @'+ project +' — or edit the file directly.');
            process.exit(1);
            return;
        }

        // 4) parse + validate --controls
        var parsed = scaffold.parseControls(p['controls']);
        if ( parsed.invalid.length > 0 ) {
            console.error('Invalid action name(s) in --controls: '+ parsed.invalid.join(', ') +'. Use a lowercase letter followed by letters, digits or underscores.');
            process.exit(1);
            return;
        }
        var actions = parsed.actions;

        // 5) resolve the flavor (auto-detect, overridable)
        var forceApi   = !!p['api']
            , forceViews = !!p['views'];
        if ( forceApi && forceViews ) {
            console.error('Pass only one of --api / --views.');
            process.exit(1);
            return;
        }
        var flavor;
        if ( forceApi ) {
            flavor = 'api';
        } else if ( forceViews ) {
            flavor = 'view';
        } else {
            // A view bundle carries config/templates.json (view:add creates it;
            // bundle:add strips it for an API-only bundle). config.js's hasViews
            // gate is driven by that templates config, so it is the faithful
            // offline signal — no boot needed.
            var templatesConf = _(srcPath + '/config/templates.json', true).toString();
            flavor = fs.existsSync(templatesConf) ? 'view' : 'api';
        }

        // 6) generate the controller file
        var controllerSrc = scaffold.renderController(bundle, name, actions, flavor);
        lib.generator.createFileFromDataSync(controllerSrc, controllerPath);

        // 6b) view flavor → one template per action at templates/html/<name>/<action>.html
        if ( flavor === 'view' ) {
            var nsDir = _(srcPath + '/templates/html/' + name, true).toString();
            fs.mkdirSync(nsDir, { recursive: true });
            for (var i = 0; i < actions.length; i++) {
                var tplPath = _(nsDir + '/' + actions[i] + '.html', true).toString();
                lib.generator.createFileFromDataSync(scaffold.renderTemplate(name, actions[i]), tplPath);
            }
        }

        // 7) print the paste-ready report (raw stdout, flush-safe — the printed
        //    rules ARE documentation and must land byte-clean on a pipe)
        var rules      = scaffold.buildRules(name, actions, flavor);
        var rulesBlock = scaffold.formatRulesBlock(rules);
        var report     = buildReport(fileName, actions, flavor, srcRel + '/config/routing.json', rulesBlock);
        fs.writeSync(1, report);
        process.exit(0);
    };

    init();
};

module.exports = Add
