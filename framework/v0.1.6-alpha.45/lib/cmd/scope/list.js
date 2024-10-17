var fs = require('fs');
var console = lib.logger;
/**
 * List all environments
 * TODO - add selected icon (green check) for selected env
 * */
function List(opt, cmd){
    var self = {};

    var init = function(){

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));
        var err = null;

        if ( typeof(process.argv[3]) != 'undefined') {
            if (process.argv[3] === '--all') {
                listAll()
            } else if ( !isValidName(process.argv[3]) ) {
                err = new Error('[ '+process.argv[3]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
                end(err, 'log', true);
            }
        } else {
            // is current path == project path ?
            var root = process.cwd();
            var name = new _(root).toArray().last();
            if ( isDefined(name) ) {
                self.name = name
            }
        }

        if ( typeof(self.name) == 'undefined' ) {
            listAll()
        } else if ( typeof(self.name) != 'undefined' && isDefined(self.name) ) {
            listProjectOnly()
        } else {
            err = new Error('[ '+self.name+' ] is not a valid project name.');
            end(err, 'log', true);
        }
    }

    var isDefined = function(name) {
        if ( typeof(self.projects[name]) != 'undefined' ) {
            return true
        }
        return false
    }

    var isValidName = function(name) {
        if (name == undefined) return false;

        self.name = name.replace(/\@/, '');
        var patt = /^[a-z0-9_.]/;
        return patt.test(self.name)
    }

    var listAll = function() {
        var projects = self.projects
            , list = []
            , str = '';

        for (let p in projects) {
            list.push(p)
        }
        list.sort();


        for (let p = 0; p<list.length; ++p) {
            projects[list[p]].scopes.sort();
            str += '------------------------------------\n\r';
            if ( !fs.existsSync(projects[list[p]].path) ) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';
            for (let e=0; e<projects[list[p]].scopes.length; e++) {
                if (projects[list[p]].scopes[e] === projects[list[p]].def_scope) {
                    str += '[ * ] ' + projects[list[p]].scopes[e]
                } else {
                    str += '[   ] ' + projects[list[p]].scopes[e]
                }
                str += '\n\r'
            }
            str += '\n\r'
        }

        console.log(str);
        end();
    }

    var listProjectOnly = function (){
        var projects    = self.projects
            , p         = self.name
            , str       = ''
        ;
        console.debug('scopes ', projects[p].scopes);
        str += '------------------------------------\n\r';
        if ( !fs.existsSync(projects[p].path) ) {
            str += '?! '
        }
        str += p + '\n\r';
        str += '------------------------------------\n\r';
        for (let e = 0; e<projects[p].scopes.length; e++) {
            if (!projects[p].def_scope) continue;

            if (projects[p].scopes[e] === projects[p].def_scope) {
                str += '[ * ] ' + projects[p].scopes[e]
            } else {
                str += '[   ] ' + projects[p].scopes[e]
            }
            str += '\n\r'
        }

        console.log(str);
        end();
    };

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

    init()
};

module.exports = List