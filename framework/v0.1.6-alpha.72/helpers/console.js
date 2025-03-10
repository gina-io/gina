/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * ConsoleHelper
 *
 * @package     Gina.Lib.Helpers
 * @namespace   Gina.Lib.Helpers.ConsoleHelper
 * @author      Rhinostone <contact@gina.io>
 * */

function ConsoleHelper() {
    /**
     * @function log
     * @param {string} content to be printed by the terminal
     * */
    log = function() {

        var args = arguments, content = '';
        //console.log("arg: ", args);
        //To handle logs with coma speparated arguments.

        for (let i=0; i<args.length; ++i) {

            if (args[i] instanceof Object) {
                //console.log("\n...", args[i], args[i].toString());
                content += JSON.stringify(args[i], null, '\t')
            } else {
                content += args[i]
            }
        }

        //console.log("hum ? ", content);
        if (content != '')
            process.stdout.write(content + '\n');
    };
    return false
};
module.exports = ConsoleHelper