/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

 var fs = require('fs');
 var console = require('./../../../lib/logger');
/**
 * JSONHelper
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

module.exports = function(){

    // `JSON.clone()` is a prototype defined in `GINA_DIR//lib/prototypes.json_clone`

    /**
     * Load a JSON file, stripping JS-style block (`/* ... *\/`) and line (`// ...`)
     * comments before parsing. Trailing commas before `}`/`]` are tolerated with
     * a warning. Line-comment stripping is per-line on the leftmost `//`: when
     * that `//` is preceded by `:` (URL protocol), `"` (inside a string value),
     * or `\` (escape), the entire line is treated as data and left alone — so
     * values like `"http://host//:rest"` round-trip unchanged.
     *
     * On a real syntax error the helper logs via `console.emerg` and exits with
     * code 1; on unexpected I/O failure it rethrows.
     *
     * @param {string} filename - absolute or relative path to the JSON-with-comments file
     *
     * @return {object} parsed JSON object
     *
     * @example
     * // file: app.json
     * //   {
     * //     "url": "https://example.com/foo",
     * //     // a bare line-comment separator
     * //     "value": 1
     * //   }
     * var config = requireJSON(__dirname + '/app.json');
     * // → { url: 'https://example.com/foo', value: 1 }
     * */
    requireJSON = function(filename){

        //console.debug('[ Helpers ][ requireJSON ] ', filename);

        var jsonStr = null;

        try {
            if (
                typeof(process.env.NODE_ENV_IS_DEV) != 'undefined'
                && /true/i.test(process.env.NODE_ENV_IS_DEV)
            ) {
                delete require.cache[require.resolve(filename)];
            }
            jsonStr = fs.readFileSync(filename).toString();

        } catch (err) {
            if ( typeof(console.emerg) != 'undefined' ) {
                console.emerg(err.stack);
                process.exit(1);
            }
            throw err
        }


        /** block style comments */
        if ( /\/\*\*/.test(jsonStr) ) {
            jsonStr   = jsonStr.replace(/(\/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+\/)/g, '');
        }

        // line style comments — per-line, leftmost `//` only. When the leftmost
        // `//` on a line is preceded by `:` (URL protocol), `"` (inside a string
        // value), or `\` (escape), the entire line is treated as data and left
        // alone — mirrors the original greedy-from-first-match heuristic so
        // values like "http://host//:rest" round-trip unchanged.
        jsonStr = jsonStr.split('\n').map(function(line) {
            var idx = line.indexOf('//');
            if (idx === -1) {
                return line;
            }
            if (idx > 0) {
                var prev = line.charAt(idx - 1);
                if (prev === ':' || prev === '"' || prev === '\\') {
                    return line;
                }
            }
            return line.substring(0, idx);
        }).join('\n');

        try {
            return JSON.parse(jsonStr)
        } catch (firstErr) {
            // Trailing comma tolerance: strip ,} and ,] patterns and retry
            var _stripped = jsonStr.replace(/,(\s*[\}\]])/g, '$1');
            if (_stripped !== jsonStr) {
                try {
                    var _result = JSON.parse(_stripped);
                    console.warn('[ requireJSON ] trailing comma in `'+ filename +'` — parsed successfully but please fix the file');
                    return _result;
                } catch (_retryErr) {
                    // fall through to the original error reporting below
                }
            }

            var err = firstErr;
            var pos     = null
                , msg   = null
                , error = null
            ;
            var stack   = err.stack.match(/position(\s|\s+)\d+/);
            if ( Array.isArray(stack) && stack.length > 0) {
                pos     = stack[0].replace(/[^\d+]/g, '');
                jsonStr = jsonStr.substring(0, pos) + '--(ERROR !)--\n' + jsonStr.substring(pos);
                msg     = (jsonStr.length > 400) ?  '...'+ jsonStr.substring(pos-200, 300) +'...' : jsonStr;
                error = new Error('[ requireJSON ] could not parse `'+ filename +'`:' +'\n\rSomething is wrong around this portion:\n\r'+msg+'<strong style="color:red">"</strong>\n\rPlease check your file: `'+ filename +'`'+ '\n\r<strong style="color:red">'+err.stack+'</strong>\n');
            } else {
                error = new Error('[ requireJSON ] could not parse `'+ filename +'`:' +'\n\rSomething is wrong with the content of your file.\n\rPlease check the syntax of your file : `'+ filename +'`'+ '\n\r<strong style="color:red">'+err.stack+'</strong>\n');
            }

            if ( !/\/controllers/i.test(err.stack) && typeof(console.emerg) != 'undefined' ) {
                console.emerg(error.message);
                process.exit(1);
            }
            throw error;
        }
    };

};//EO JSONHelper.
