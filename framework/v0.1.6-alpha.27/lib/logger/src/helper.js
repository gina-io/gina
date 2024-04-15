/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * LoggerHelper
 *
 * @package     Gina.Lib.Logger
 * @namespace   Gina.Lib.Logger.LoggerHelper
 * @author      Rhinostone <contact@gina.io>
 * */

 function LoggerHelper(opt, loggers) {

    // BO - publishing hack
    if ( typeof(new Date().format) == 'undefined' ) {
        // trying to load prototypes if not loaded
        var dateFormatInstance = require(__dirname +'/../../../helpers/dateFormat')();
        require(__dirname +'/../../../helpers/prototypes')({ dateFormat: dateFormatInstance });
    }
    // EO - publishing hack
    var self = {};


    /**
     * @function format
     *
     * @param {string} group
     * @param {string} s
     * @param {string} content - to be formated
     * @param {boolean} skipFormating
     * */
    self.format = function(group, s, content, skipFormating) {

        if (
            s == 'catch'
            || typeof(skipFormating) != 'undefined' && /true/i.test(skipFormating)
        ) {
            return content
        }

        if (content != '') {
            var colors = null;
            try {
                // hack for loggers['bundle@project'] not found in this context
                // so we just clone gina's
                if ( typeof(loggers[ group ]) == 'undefined' ) {
                    loggers[ group ] = JSON.clone(loggers.gina);
                }
                colors = loggers[ group ].colors
            } catch(colorsErr) {
                // Leave it just in case we need to detect bugs right from the log output
                content += '\nNot able to define colors. Please check logger‘s group: `'+ group +'`\n';
                process.stdout.write('--['+ s +'/'+ skipFormating +']-> '+content +'\n');
                throw new Error('Not able to define colors. Please check logger‘s group: `'+ group +'`\n')
            }


            var now = new Date().format('logger');
            var sCount = s.length;
            if ( sCount < opt._maxLevelLen ) {
                for (; sCount < opt._maxLevelLen; ++sCount ) {
                    s +=' ';
                }
            }
            sCount = null;

            var repl = {
                '%a': group, // application or service name
                '%s': s, // severity or level
                '%d': now, // date
                '%m': content // message
            };

            var patt = opt.template.match(/\%[a-z A-Z]/g);


            var colorCode = opt.levels[s.replace(/\s+/, '')].color;
            var _color = colors[colorCode];
            //process.stdout.write('colors code '+ colorCode  +'\n');
            //process.stdout.write('colors '+ JSON.stringify(colors[colorCode], null, 2)  +'\n');



            if ( typeof(_color) != 'undefined' && _color) {
                //process.stdout.write('colors code '+ JSON.stringify(colors, null, 2)  +'\n');
                content = _color.open + opt.template + _color.close;
            } else { // system styles
                content = opt.template;
            }



            // formating output
            for (let p=0; p<patt.length; ++p) {
                content = content.replace(new RegExp(patt[p], 'g'), repl[patt[p]])
            }


        }

        // test only
        // process.stdout.write('--['+ s +'/'+ skipFormating +']->'+content +'\n');


        // We should be using `\r` instead of `\n`
        // But it is not yet possible because of weird console.*() stdout when we are on the CLI or Framework side
        return content +'\n'
    };

    self.getProcessProperties = function() {
        var processProperties = {bundles: []};
        var argv = process.argv;
        if ( /bundle\:(start|stop|restart)/.test(argv.join(',')) ) {
            var foundBundle = false;
            for (let i = 0, len = argv.length; i < len; i++) {
                if ( /bundle\:(start|stop|restart)/.test(argv[i]) ) {
                    foundBundle = true;
                    continue;
                }

                if ( /^\@/.test(argv[i]) ) {
                    foundBundle = false;
                    processProperties.project = argv[i].replace(/\@/, '');
                }
                if (foundBundle) {
                    processProperties.bundles.push(argv[i])
                }
            }
            if (
                processProperties.bundles
                && processProperties.bundles.length > 0
            ) {
                var b = -1, bLen = processProperties.bundles.length-1;
                while (b < bLen) {
                    b++;
                    processProperties.bundles[b] = processProperties.bundles[b] +'@'+ processProperties.project;
                }
            }
            return processProperties;
        }

        return processProperties;
    }

    return self
}
module.exports = LoggerHelper;