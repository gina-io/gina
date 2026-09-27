var console = lib.logger;
var fs      = require('fs');
var path    = require('path');
/**
 * @module gina/lib/cmd/framework/help
 */
/**
 * Prints the Gina CLI help.
 *
 * Handles `gina --help`, `gina -h`, and `gina help [<group>]` — all aliased to
 * `framework:help` (see `lib/cmd/aliases.json`). With no group it prints the
 * top-level command reference at `lib/cmd/framework/help.txt`; with a known
 * group (e.g. `gina help bundle`) it prints that group's `lib/cmd/<group>/help.txt`,
 * falling back to the framework help for an unknown group.
 *
 * Opening a Gina directory in the OS file manager is a separate concern handled
 * by the `open` command (`gina open <key>` / `gina -o <key>` — see `./open`).
 *
 * Usage:
 *  gina --help | -h
 *  gina help [<group>]
 *
 * @class Help
 * @constructor
 * @param {object} opt - Parsed command-line options (unused; help reads help.txt).
 *
 * @example
 *  $ gina --help
 *  $ gina -h
 *  $ gina help
 *  $ gina help bundle
 */
function Help(opt) {

    /**
     * Resolves which help.txt to print. `gina help <group>` targets
     * `lib/cmd/<group>/help.txt` when it exists; otherwise the framework help.
     *
     * The group is validated against a strict `[a-z][a-z0-9-]*` pattern (no `.`
     * or path separators) so it can never traverse outside `lib/cmd`; the
     * containment check is belt-and-suspenders.
     *
     * @inner
     * @private
     * @returns {string} Absolute path to the help.txt to print.
     */
    var resolveHelpFile = function() {
        var frameworkHelp = path.join(__dirname, 'help.txt');
        var group         = process.argv[3];

        if ( group && /^[a-z][a-z0-9-]*$/.test(group) ) {
            var cmdDir    = path.resolve(__dirname, '..');        // lib/cmd
            var candidate = path.join(cmdDir, group, 'help.txt');

            if ( candidate.indexOf(cmdDir + path.sep) === 0 && fs.existsSync(candidate) ) {
                return candidate;
            }
        }

        return frameworkHelp;
    };

    /**
     * Reads and prints the resolved help.txt to stdout, then exits.
     * @inner
     * @private
     */
    var init = function() {
        var file = resolveHelpFile();

        if ( !fs.existsSync(file) ) {
            console.error('gina: no CLI help available at the moment. Try `man gina`.');
            process.exit(1);
            return;
        }

        try {
            console.log( '\n' + fs.readFileSync(file, 'utf8') );
        } catch (err) {
            console.error( err.stack || err );
            process.exit(1);
            return;
        }

        process.exit(0);
    };

    init();
};
module.exports = Help;
