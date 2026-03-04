var fs              = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
var CmdHelper       = require('./../helper');
var console        = lib.logger;
/**
 * @module gina/lib/cmd/framework/link
 */
/**
 * Creates a symlink from the globally installed `gina` package into the project's
 * `node_modules/gina`. Requires Gina to be installed globally (`GINA_GLOBAL_MODE=true`).
 *
 * Usage:
 *  gina framework:link @<project>
 *  gina link @<project>
 *  gina link @<project> --prefix=<path>
 *
 * @class Link
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
 function Link(opt, cmd) {

    var self    = {
        // destination prefix - usaually the project location
        prefix: null
    };

    /**
     * Guards against non-global installs, imports CmdHelper, and delegates to link().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var init = function(opt, cmd) {
        var err = false;
        if ( !/^true$/i.test(GINA_GLOBAL_MODE) ) {
            err = new Error('Gina is not installed globally: cannot proceed with linking.');
            return end(err, 'error', true);
        }

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.prefix = self.projectLocation;
        var a = [], k = null, v = null;
        for (let i=3; i<process.argv.length; ++i) {
            a = process.argv[i].split(/=/);
            k = a[0];
            v = a[1];
            // console.log('Preprocessing `framework:link '+ process.argv[i] +'` ['+k+'] -> ['+ v +']');
            if ( /^\-\-prefix$/.test(k) ) {
                self.prefix = _(v, true);
                continue
            }
        }
        // console.log(' prefix: ', self.prefix);

        link(opt, cmd);
    }


    /**
     * Creates or updates the gina symlink inside the project's node_modules directory.
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var link = function(opt, cmd) {
        console.debug('Linking framework');
        var err = null, folder = new _(self.projectLocation, true);

        if ( folder.isValidPath() && isValidName(self.projectName) ) {

            var destination = new _(self.prefix + '/node_modules', true);

            if ( !destination.existsSync() ) {
                err = destination.mkdirSync();
                if (err instanceof Error) {
                    return end(err, 'error')
                }
            }
            // Safety check for node_modules
            else if ( destination.isSymlinkSync() && !new _(destination.getSymlinkSourceSync()).existsSync() ) {
                // Means that the symlink is not up to date
                err = destination.mkdirSync();
                if (err instanceof Error) {
                    return end(err, 'error')
                }

                console.debug('[link] Running: gina link-node-modules @'+self.projectName);
                err = execSync('$(which gina) link-node-modules @'+self.projectName);
                if (err instanceof Error) {
                    console.warn('[link] ', err.stack);
                    return end(err, 'error')
                }
            }
            destination = new _(destination.toString() +'/gina', true);
            // var source = new _(GINA_PREFIX + '/lib/node_modules/gina', true);
            // replaced: resolve gina package root from this file's own location
            // instead of relying on GINA_PREFIX or npm prefix which may differ
            // from the actual install path (e.g. container with --prefix=$HOME/.npm-global)
            var source = new _(require('path').resolve(__dirname, '../../../../..'), true);




            console.debug('Link '+ source + ' -> '+destination + ' [ exists ] ? '+ destination.existsSync() );
            if ( destination.existsSync() ) {
                if ( destination.isSymlinkSync() && destination.getSymlinkSourceSync() == source.toString() ) {
                    console.debug('Skipping symlink: same source, not overriding.');
                    return end();
                }
                destination.rmSync();
                var ginaFileObj = new _(self.prefix + '/gina');
                if ( ginaFileObj.existsSync() ) {
                    ginaFileObj.rmSync()
                }
            }

            if (!source.existsSync()) {
                console.error('Link Error: Source `'+ source +'` (resolved from __dirname)');

                err = new Error('Link '+ source + ' not existing !!');
                return end(err, 'error');
            }

            console.debug('[ FRAMEWORK ][ link ] Linking ['+ source.toString() +'] to [ '+ destination.toString() +' ] ');
            err = source.symlinkSync(destination.toString());

            if (err instanceof Error) {
                return end(err, 'error')
            }
        }

        end()
    }

    var end = function (output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
                if ( messageOnly && type != 'log') {
                    console.log(output);
                }
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }

    init(opt, cmd)
 }

 module.exports = Link;