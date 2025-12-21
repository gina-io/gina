var fs = require('fs');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * List bundles for a given project
 *
 * e.g.
 *  gina bundle:list [ @<project_name> ]
 *  gina bundle:list --all
 *
 * */
function List(opt, cmd) {
    var self = { format: null};

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));
        for (let i=3, len=process.argv.length; i<len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1]
            }
            if ( /^\-\-all\=/.test(process.argv[i]) || !self.projectName ) {
                return listAll()
            }
        }

        // if ( typeof(process.argv[3]) != 'undefined') {
        //     if (process.argv[3] === '--all') {
        //         listAll()
        //     } else if ( !isValidName(process.argv[3]) ) {
        //         console.error('[ '+process.argv[3]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
        //         process.exit(1);
        //     }
        // } else {
        //     // is current path == project path ?
        //     var root = process.cwd();
        //     var name = new _(root).toArray().last();
        //     if ( isDefined(name) ) {
        //         self.projectName = name
        //     }
        // }

        if ( typeof(self.projectName) == 'undefined' ) {
            listAll()
        } else if ( typeof(self.projectName) != 'undefined' && isDefined(self.projectName) ) {
            listProjectOnly()
        } else {
            console.error('[ '+self.projectName+' ] is not a valid project name.');
            process.exit(1)
        }

        process.exit(0)
    }

    var isDefined = function(name) {
        if ( typeof(self.projects[name]) != 'undefined' ) {
            return true
        }
        return false
    }

    var isValidName = function(name) {
        if (name == undefined) return false;

        self.projectName = name.replace(/\@/, '');
        var patt = /^[a-z0-9_.]/;
        return patt.test(self.projectName)
    }


    var listAll = function() {
        var projects = self.projects
            , list = []
            , p = ''
            , path
            , bundles
            , b
            , str = ''
            , json = []
        ;

        for (p in projects) {
            list.push(p)
        }
        list.sort();

        p = 0;
        for (; p<list.length; ++p) {
            let jsonProject  = { project: list[p], status: 'ok' }
            try {
                path = projects[list[p]].path;
                bundles = require( _(path +'/manifest.json')).bundles;
                bundles = orderBundles(bundles);

                str += '------------------------------------\n\r';
                if ( !fs.existsSync(projects[list[p]].path) ) {
                    str += '?! ';
                    jsonProject.status = '?!'
                }
                str += list[p] + '\n\r';
                str += '------------------------------------\n\r';
                jsonProject.bundles = [];
                for (b in bundles) {
                    let jsonBundle  = {bundle: b, project: list[p]}
                    if ( fs.existsSync(_(path + '/'+ bundles[b].src)) ) {
                        str += '[ ok ] ' + b;
                        jsonBundle.status = 'ok'
                    } else {
                        str += '[ ?! ] ' + b;
                        jsonBundle.status = '?!'
                    }
                    str += '\n\r'
                    jsonProject.bundles.push(jsonBundle);
                }
                str += '\n\r';

            } catch (err) {
                str += '------------------------------------\n\r';
                if ( !fs.existsSync(projects[list[p]].path) ) {
                    str += '?! ';
                    jsonProject.status = '?!'
                }
                str += list[p] + '\n\r';
                str += '------------------------------------\n\r';
            }

            json.push(jsonProject);
        }

        // console.log( (/^json?/.test(self.format)) ? JSON.stringify(json) : str )
        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(json));
        }
        console.log(str);
    }

    var listProjectOnly = function () {
        var path = self.projects[self.projectName].path
            , bundles = require( _(path +'/manifest.json')).bundles
            , b
            , str = ''
            , json = []
        ;

        bundles = orderBundles(bundles);
        for (b in bundles) {
            let jsonBundle  = {bundle: b, project: self.projectName}
            if ( fs.existsSync(_(path + '/'+ bundles[b].src)) ) {
                str += '[ ok ] ' + b;
                jsonBundle.status = 'ok'
            } else {
                str += '[ ?! ] ' + b;
                jsonBundle.status = '?!'
            }
            str += '\n\r';
            json.push(jsonBundle);
        }

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(json));
        }
        console.log(str);
    };

    init()
};

module.exports = List