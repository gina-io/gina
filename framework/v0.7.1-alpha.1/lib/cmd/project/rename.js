var fs          = require('fs');

var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * @module gina/lib/cmd/project/rename
 */
/**
 * Renames an existing project: moves the source directory, updates
 * manifest.json, package.json, ports.json, ports.reverse.json,
 * and projects.json.
 *
 * Usage:
 *  gina project:rename @<old_project> @<new_project>
 *
 * @class Rename
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Rename(opt, cmd) {

    var self    = {}
        , local = {
            source: null,
            target: null
        }
    ;

    /**
     * Validates that exactly two project tokens are provided, then delegates to rename.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if ( self.projectArgvList.length != 2 ) {
            console.error('This command line is expecting 2 arguments: @<old_project> and @<new_project>');
            process.exit(1)
        }

        local.source = self.projectName;
        local.target = self.projectArgvList[1];


        // #B651 — the check was inverted: it renamed only when the new name was
        // ALREADY registered (running the rename onto another project) and refused
        // every free name as taken
        // was: if ( isDefined('project', local.target) ) {
        if ( !isDefined('project', local.target) ) {
            rename()
        } else {
            console.error('New project name [ '+local.target+' ] is already taken !');
            process.exit(1)
        }
    }


    /**
     * Moves the source directory, updates all config files with the new name,
     * rewrites port entries, and calls end.
     *
     * The directory keeps its parent and takes the new project name. A rename
     * onto an existing directory is refused (exit 1) before anything moves.
     * Port entries are renamed only where their project part equals the source
     * name as a whole (#B651).
     *
     * @inner
     * @private
     */
    var rename = function() {

        self.projects[local.target] = JSON.clone(self.projects[local.source]);

        // renaming folder !
        if (!self.projects[local.source].path || self.projects[local.source].path == '') {
            console.error("It seems like this project does not have a path :'(");
            process.exit(1)
        }

        var folder = new _(self.projects[local.source].path)
            // #B651 — no RegExp built from the folder name (a name holding `(` or
            // `[` threw, and `.` matched any character)
            // was: , re = new RegExp("\/"+folder.toArray().last()+"$")
            // was: , target = folder.toUnixStyle().replace(re, '/'+ local.target)
            , target = folder.toUnixStyle().replace(/\/[^\/]+$/, '/'+ local.target)
            , project = {}// local manifest.json
            , pack = {};// local pakage.json

        // #B651 — never move the project onto an existing directory: the move is a
        // copy then a delete, so it would mix this project into whatever is there
        if ( fs.existsSync(target) ) {
            console.error('Cannot rename [ '+ local.source +' ]: [ '+ target +' ] already exists');
            process.exit(1)
        }



        folder.mv(target, function(err){
            console.debug('bundles => ', JSON.stringify(self.bundles, null, 4));
            console.debug('project => ', JSON.stringify(self.projects, null, 4));
            if (err) {
                console.error(err.stack);
                process.exit(1)
            }



            // renaming project in config files
            self.projects[local.target].path = target;

            if ( fs.existsSync( _(target +'/manifest.json') )) {
                project = require(_(target +'/manifest.json'));
                project['name'] = local.target;
                lib.generator.createFileFromDataSync(
                    project,
                    _(target +'/manifest.json')
                )
            }

            if ( fs.existsSync( _(target +'/package.json') )) {
                pack = require(_(target +'/package.json'));
                if ( typeof(pack['name']) != 'undefined' ) {
                    pack.name = local.target;
                    lib.generator.createFileFromDataSync(
                        pack,
                        _(target +'/package.json')
                    )
                }
            }

            // updating projects
            delete self.projects[local.source];




            // renaming & update ports
            // #B651 — rename exactly. A ports.json value is `<bundle>@<project>/<env>`
            // and a ports.reverse.json key `<bundle>@<project>`. The previous code
            // matched the source with an unescaped, unanchored RegExp and replaced
            // `@<source>` across the whole reverse file as a string, so another
            // project whose name starts with the source was renamed too; and it
            // wrote the new value at `ports[protocol][port]` (no scheme), which left
            // the old value in place and added a stray protocol-level key.
            // was:
            // var ports               = JSON.clone(self.portsData)
            //     , portsReverse      = JSON.clone(self.portsReverseData)
            //     , re                = null
            //     , projectValue      = null
            //     , portsReverseStr   = null
            // ;
            // portsReverseStr = JSON.stringify(portsReverse);
            // for (var protocol in ports) {
            //     for (var scheme in ports[protocol]) {
            //         for (var port in ports[protocol][scheme]) {
            //             re = new RegExp("\@"+ local.source +"\/");
            //             if ( re.test(ports[protocol][scheme][port]) ) {
            //                 projectValue = ( ports[protocol][scheme][port].split('/')[0] ).split('@')[1];
            //                 ports[protocol][port] = ports[protocol][scheme][port].replace(re, "@"+ local.target +"/");
            //                 portsReverseStr = portsReverseStr.replace( new RegExp('\@'+ projectValue, 'g'), '@'+ local.target );
            //             }
            //         }
            //     }
            // }
            // portsReverse = JSON.parse(portsReverseStr);
            var ports               = JSON.clone(self.portsData)
                , portsReverse      = renameReverseKeys(JSON.clone(self.portsReverseData), local.source, local.target)
            ;
            for (var protocol in ports) {
                for (var scheme in ports[protocol]) {
                    for (var port in ports[protocol][scheme]) {
                        ports[protocol][scheme][port] = renamePortValue(ports[protocol][scheme][port], local.source, local.target);
                    }
                }
            }


            // now writing
            lib.generator.createFileFromDataSync(ports, self.portsPath);
            lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

            end(true)
        })
    }

    /**
     * Renames the project part of one ports.json value, exactly.
     *
     * A value reads `<bundle>@<project>/<env>`; it is returned renamed only when its
     * project part equals `source` as a whole (#B651 — no prefix match), and as it
     * was otherwise, including any value that is not in that shape.
     *
     * @inner
     * @private
     * @param {*} value - A ports.json value
     * @param {string} source - Project name to replace
     * @param {string} target - New project name
     * @returns {*} The renamed value, or `value` unchanged
     *
     * @example
     *  renamePortValue('demo@app/dev', 'app', 'shop');  // 'demo@shop/dev'
     *  renamePortValue('web@app2/dev', 'app', 'shop');  // 'web@app2/dev'
     */
    var renamePortValue = function(value, source, target) {
        if ( typeof(value) != 'string' ) return value;
        var at      = value.indexOf('@')
            , slash = value.indexOf('/', at)
        ;
        if ( at < 0 || slash < 0 || value.substring(at + 1, slash) !== source ) return value;

        return value.substring(0, at + 1) + target + value.substring(slash);
    }

    /**
     * Renames the ports.reverse.json keys that belong to one project, exactly.
     *
     * A key reads `<bundle>@<project>`; only keys whose project part equals `source`
     * as a whole are renamed (#B651 — another project whose name merely starts with
     * `source` keeps its key). Key order is kept.
     *
     * @inner
     * @private
     * @param {object} portsReverse - Parsed ports.reverse.json
     * @param {string} source - Project name to replace
     * @param {string} target - New project name
     * @returns {object} A new object with the renamed keys
     *
     * @example
     *  renameReverseKeys({ 'demo@app': {}, 'web@app2': {} }, 'app', 'shop');
     *  // { 'demo@shop': {}, 'web@app2': {} }
     */
    var renameReverseKeys = function(portsReverse, source, target) {
        var renamed = {};
        for (var key in portsReverse) {
            var at = key.lastIndexOf('@');
            if ( at > -1 && key.substring(at + 1) === source ) {
                renamed[ key.substring(0, at + 1) + target ] = portsReverse[key];
            } else {
                renamed[key] = portsReverse[key];
            }
        }
        return renamed;
    }

    /**
     * Writes the updated projects.json and exits the process.
     *
     * @inner
     * @private
     * @param {boolean} [renamed] - When true, log the rename confirmation
     */
    var end = function(renamed) {
        var target = _(GINA_HOMEDIR + '/projects.json')
            , projects = self.projects;


        // writing file
        lib.generator.createFileFromDataSync(
            projects,
            target
        )

        if (renamed)
            console.log('project [ '+ local.source +' ] renamed to [ ' + local.target + ' ]');

        process.exit(0)
    }

    init()
};

module.exports = Rename