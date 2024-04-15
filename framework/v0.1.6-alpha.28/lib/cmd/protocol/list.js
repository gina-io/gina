var fs = require('fs');

var CmdHelper = require('./../helper');
var console = lib.logger;

/**
 * List protocols for a given bundle, a given project & a given env
 *
 * e.g.
 *  gina protocol:list
 *  gina protocol:list @<project_name>
 *  gina protocol:list <bundle> @<project_name>
 *
 * */
function List(opt, cmd) {

    // self will be pre filled if you call `new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled })`
    var self = {}, local = {};

    var init = function() {
        //debugger;
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;


        if (!self.name && !self.projectName) {
            listAllByProject()
        } else if (self.projectName && isDefined(self.projectName) && !self.name) {
            listByBundle()
        } else if (typeof (self.name) != 'undefined' && isValidName(self.name) ) {
            listByBundle(self.name)
        } else {
            console.error('[ ' + self.name + ' ] is not a valid project name.');
            process.exit(1)
        }
    }

    //  check if bundle is defined
    var isDefined = function(name) {
        if (typeof (self.projects[name]) != 'undefined') {
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


    var listAllByProject = function() {

        var protocols       = null
            , schemes       = null
            , projects      = self.projects
            , list          = []
            , p             = null
            , i             = null
            , len           = null
            , str           = ''
            , schemeStr     = ''
            , protocolStr   = ''
            , indexObj      = null
            , index         = null
        ;

        for (p in projects) {
            list.push(p)
        }
        list.sort();

        p = 0;
        for (; p < list.length; ++p) {

            str += '------------------------------------\n\r';
            if (!projects[list[p]].exists) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';
            protocols = projects[list[p]].protocols;
            schemes = projects[list[p]].schemes;

            if (!protocols) continue;

            str += '      Protocol(s)        Scheme(s)\n\r';


            indexObj = {}; index = 2;
            i = 0; len = protocols.length;
            for (; i < len; ++i) {
                protocolStr = '';
                if (projects[list[p]].def_protocol == protocols[i]) {
                    protocolStr += '[ * ] ' + protocols[i]
                } else {
                    protocolStr += '[   ] ' + protocols[i]
                }

                if ( (index % 2) == 0 ){
                    indexObj[index] = protocolStr;
                    index += 2
                }
            }


            index = 3;
            i = 0; len = schemes.length;
            for (; i < len; ++i) {
                schemeStr = '';
                if (projects[list[p]].def_scheme == schemes[i]) {
                    schemeStr += '           [ * ] ' + schemes[i]
                } else {
                    schemeStr += '           [   ] ' + schemes[i]
                }

                if ( (index % 2) != 0 ){
                    indexObj[index] = schemeStr;
                    index += 2
                }
            }

            i = null;
            for (i in indexObj) {
                str += indexObj[i];
                if ( (~~i % 3) == 0 ){
                    str += '\n\r'
                }
            }

            str += '\n\r'
        }

        console.log(str);
        end();
    }

    var listByBundle = function(bundleName) {

        var protocols       = null
            , schemes       = null
            , bundles       = self.bundlesByProject[self.projectName]
            , list          = []
            , p             = null
            , i             = null
            , len           = null
            , str           = ''
            , schemeStr     = ''
            , protocolStr   = ''
            , indexObj      = null
            , index         = null
        ;

        if ( typeof(bundleName) != 'undefined' ) {
            list.push(bundleName)
        } else {
            for (p in bundles) {
                list.push(p)
            }
            list.sort();
        }



        p = 0;
        for (; p < list.length; ++p) {


            str += '------------------------------------\n\r';
            if (!bundles[list[p]].exists) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';

            protocols = bundles[list[p]].protocols;
            schemes = bundles[list[p]].schemes;
            if (!protocols || protocols.length == 0) continue;


            str += '      Protocol(s)        Scheme(s)\n\r';


            indexObj = {}; index = 2;
            i = 0; len = protocols.length;
            for (; i < len; ++i) {
                protocolStr = '';
                if (bundles[list[p]].def_protocol == protocols[i]) {
                    protocolStr += '[ * ] ' + protocols[i]
                } else {
                    protocolStr += '[   ] ' + protocols[i]
                }

                if ( (index % 2) == 0 ){
                    indexObj[index] = protocolStr;
                    index += 2
                }
            }


            index = 3;
            i = 0; len = schemes.length;
            for (; i < len; ++i) {
                schemeStr = '';
                if (bundles[list[p]].def_scheme == schemes[i]) {
                    schemeStr += '           [ * ] ' + schemes[i]
                } else {
                    schemeStr += '           [   ] ' + schemes[i]
                }

                if ( (index % 2) != 0 ){
                    indexObj[index] = schemeStr;
                    index += 2
                }
            }

            i = null;
            for (i in indexObj) {
                str += indexObj[i];
                if ( (~~i % 3) == 0 ){
                    str += '\n\r'
                }
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