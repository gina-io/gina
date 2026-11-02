/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

 var fs = require('fs');
 // #B928 — the logger is read when a function runs (getLogger), not bound when this file loads.
 // lib/logger requires the helpers, this file among them, before it assigns its exports, so the
 // binding taken here kept the logger's first, empty exports: in gina-container and gina-init
 // (whose only instance of this file is that one) a trailing comma was refused instead of
 // accepted with a warning, and so it was, in every process, in the files the logger reads while
 // it loads. The require stays, so nothing loads in a different order.
 // was: var console = require('./../../../lib/logger');
 require('./../../../lib/logger');

/**
 * The framework logger, or `null` while `lib/logger` is still loading (#B928).
 *
 * `lib/logger` requires the helpers, this file among them, before it assigns
 * its exports, and reads the framework `package.json`, the home
 * `settings.json` and its extension configs through `requireJSON` during that
 * load. Required when a function runs, it is the logger, or its first, empty
 * exports during those reads. An own property is tested: reading a missing
 * property on a module that is still loading makes node print « Accessing
 * non-existent property … inside circular dependency ». A logger that cannot
 * load at all returns `null` too, so the error being reported stays the
 * caller's.
 *
 * @private
 * @returns {object|null} the logger, or `null` while it is not loaded
 *
 * @example
 * var logger = getLogger();
 * if (logger) { logger.emerg(message); process.exit(1); }
 */
function getLogger() {
    try {
        var logger = require('./../../../lib/logger');
        return ( Object.prototype.hasOwnProperty.call(logger, 'emerg') ) ? logger : null;
    } catch (loggerErr) {
        return null;
    }
}

/**
 * Logs a warning through the logger, or through node's own console while the
 * logger is still loading (#B928): the logger's reads of its own files.
 *
 * @private
 * @param {string} message - the warning
 * @returns {void}
 *
 * @example
 * warn('[ requireJSON ] trailing comma in `/path/to/file.json` — parsed successfully but please fix the file');
 */
function warn(message) {
    var logger = getLogger();
    if (logger) {
        logger.warn(message);
    } else {
        // node's console, also where the process replaced the global one (bin/cli does)
        require('console').warn(message);
    }
}

/**
 * JSONHelper
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

/**
 * Strip `/* ... *\/` block comments from a JSON-with-comments source, linearly.
 *
 * Three states — default, inside a `"..."` string (honouring `\` escapes), and
 * inside a block comment. A `/*` inside a string value is data and is kept; a
 * `/*` anywhere else opens a block wherever it sits — including inside a `//`
 * line comment, which the regex this replaces also treated as an opener and
 * which a consumer configuration in the wild relies on. An unterminated block
 * is kept verbatim, as the regex left it, so a malformed file fails to parse
 * the way it did. Line comments are not this function's job: `requireJSON`
 * strips them per line afterwards, unchanged.
 *
 * Replaces `/(\/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+\/)/g` (#B568): its
 * `[^*]` and `[\r\n]` alternatives both match a newline, so against a `/*`
 * with no `*\/` after it — a glob or certificate path in a string value — the
 * match backtracks about 2x per LF line and 4x per CRLF line of tail, and a
 * bundle whose config carried such a path a few dozen lines from the bottom
 * hung at boot until the CLI's start-wait killed it. Non-newline characters
 * are unambiguous to that regex, which is why a short tail never showed it.
 *
 * @private
 * @param {string} s - raw file content
 * @returns {string} the content with block comments removed
 *
 * @example
 * stripBlockComments('/** doc *\/\n{ "ca": "/x/*.pem" }')
 * // → '\n{ "ca": "/x/*.pem" }'   (the in-string /* is data)
 */
function stripBlockComments(s) {
    var out = [], i = 0, n = s.length, st = 0, mark = 0; // st: 0 default, 1 string, 2 block
    while (i < n) {
        var c = s.charCodeAt(i);
        if (st === 0) {
            if (c === 34) { st = 1; i++; }                                                    // "
            else if (c === 47 && s.charCodeAt(i + 1) === 42) { out.push(s.slice(mark, i)); mark = i; st = 2; i += 2; } // /*
            else { i++; }
        } else if (st === 1) {
            if (c === 92) { i += 2; }                                                         // \x — skip the escaped char
            else if (c === 34) { st = 0; i++; }
            else { i++; }
        } else {
            if (c === 42 && s.charCodeAt(i + 1) === 47) { st = 0; i += 2; mark = i; }        // */ — drop [mark, i)
            else { i++; }
        }
    }
    out.push(s.slice(mark)); // trailing text — or an unterminated block, kept verbatim
    return out.join('');
}

/**
 * Strip `// ...` line comments from a JSON-with-comments source, per line, on
 * the leftmost `//` only. When that `//` is preceded by `:` (URL protocol),
 * `"` (inside a string value), or `\` (escape), the entire line is treated as
 * data and left alone — mirrors the original greedy-from-first-match heuristic
 * so values like "http://host//:rest" round-trip unchanged. Shared by
 * `requireJSON()` and `parseJSONWithComments()` (#B891).
 *
 * @private
 * @param {string} jsonStr - the source, block comments already stripped
 * @returns {string} the source with line comments removed
 *
 * @example
 * stripLineComments('{\n  // a note\n  "url": "http://x/y"\n}')
 * // → '{\n  \n  "url": "http://x/y"\n}'
 */
function stripLineComments(jsonStr) {
    return jsonStr.split('\n').map(function(line) {
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
}

module.exports = function(){

    // `JSON.clone()` is a prototype defined in `GINA_DIR//lib/prototypes.json_clone`

    /**
     * Load a JSON file, stripping line (`// ...`) comments and — when the file
     * carries a `/**` docblock — block (`/* ... *\/`) comments before parsing.
     * Block stripping is a linear, string-aware scan, so a `/*` inside a string
     * value is data and survives (#B568). Trailing commas before `}`/`]` are
     * tolerated with
     * a warning. Line-comment stripping is per-line on the leftmost `//`: when
     * that `//` is preceded by `:` (URL protocol), `"` (inside a string value),
     * or `\` (escape), the entire line is treated as data and left alone — so
     * values like `"http://host//:rest"` round-trip unchanged.
     *
     * On a real syntax error, or a file it cannot read, the helper logs via
     * `console.emerg` and exits with code 1; within the controller stack a
     * syntax error is thrown instead. While `lib/logger` is still loading (its
     * own reads of the framework `package.json`, the home `settings.json` and
     * its extension configs) both are thrown, and the trailing-comma warning
     * goes to node's console (#B928). When the engine reports the
     * error's position, the message carries an excerpt of the file from 200
     * characters before the error to 300 after it, the error marked
     * `--(ERROR !)--` (#B917); without a position it names the file only.
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
            // #B928 — the logger read now, not the empty exports bound when this file loaded
            // was: if ( typeof(console.emerg) != 'undefined' ) {
            // was:     console.emerg(err.stack);
            var readLogger = getLogger();
            if ( readLogger ) {
                readLogger.emerg(err.stack);
                process.exit(1);
            }
            throw err
        }


        /** block style comments — a linear, string-aware scan behind the same
         *  `/**` gate the regex had: a file without a docblock is untouched (#B568) */
        if ( /\/\*\*/.test(jsonStr) ) {
            jsonStr = stripBlockComments(jsonStr);
        }

        // line style comments — per-line, leftmost `//` only (stripLineComments)
        jsonStr = stripLineComments(jsonStr);

        try {
            return JSON.parse(jsonStr)
        } catch (firstErr) {
            // Trailing comma tolerance: strip ,} and ,] patterns and retry
            var _stripped = jsonStr.replace(/,(\s*[\}\]])/g, '$1');
            if (_stripped !== jsonStr) {
                try {
                    var _result = JSON.parse(_stripped);
                    // #B928 — on the empty exports, `console.warn` threw here and the retry fell through to the parse error
                    // was: console.warn('[ requireJSON ] trailing comma in `'+ filename +'` — parsed successfully but please fix the file');
                    warn('[ requireJSON ] trailing comma in `'+ filename +'` — parsed successfully but please fix the file');
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
                // #B917 — the excerpt runs from 200 characters before the error to 300 after it.
                // Its end was the fixed index 300, so for an error past character 500 the start
                // passed the end, substring() swapped the two, and the excerpt stopped 200
                // characters short of the error: the marker never showed, and a long file printed
                // almost whole. `pos` is the digit string read from the stack, so it is parsed
                // before the sum (a string plus 300 would concatenate).
                // was: msg     = (jsonStr.length > 400) ?  '...'+ jsonStr.substring(pos-200, 300) +'...' : jsonStr;
                var at  = parseInt(pos, 10);
                msg     = (jsonStr.length > 400) ?  '...'+ jsonStr.substring(Math.max(0, at - 200), at + 300) +'...' : jsonStr;
                error = new Error('[ requireJSON ] could not parse `'+ filename +'`:' +'\n\rSomething is wrong around this portion:\n\r'+msg+'<strong style="color:red">"</strong>\n\rPlease check your file: `'+ filename +'`'+ '\n\r<strong style="color:red">'+err.stack+'</strong>\n');
            } else {
                error = new Error('[ requireJSON ] could not parse `'+ filename +'`:' +'\n\rSomething is wrong with the content of your file.\n\rPlease check the syntax of your file : `'+ filename +'`'+ '\n\r<strong style="color:red">'+err.stack+'</strong>\n');
            }

            // #B928 — the logger read now: on the empty exports this threw where it should exit
            // was: if ( !/\/controllers/i.test(err.stack) && typeof(console.emerg) != 'undefined' ) {
            // was:     console.emerg(error.message);
            var parseLogger = getLogger();
            if ( !/\/controllers/i.test(err.stack) && parseLogger ) {
                parseLogger.emerg(error.message);
                process.exit(1);
            }
            throw error;
        }
    };

    /**
     * Parse JSON-with-comments text the way `requireJSON()` parses a file —
     * `//` line comments, `/* ... *\/` block comments when the text carries a
     * `/**` docblock, and a trailing comma before `}`/`]` (with a warning, sent
     * to node's console while `lib/logger` is still loading, #B928) —
     * but never exit the process: text that is still not JSON throws an Error
     * whose message names `filename`. For readers whose failure must stay on
     * their own error path: a CLI command, the framework daemon,
     * `gina-container` (#B891, the readers of a project's `manifest.json`).
     *
     * @param {string} text - the JSON-with-comments source
     * @param {string} [filename] - the file the text was read from, named in the error
     * @returns {*} the parsed value
     * @throws {Error} `could not parse \`<filename>\`: <reason>`, with the JSON
     *   SyntaxError as its `cause`
     *
     * @example
     * var file = root + '/manifest.json';
     * var manifest = parseJSONWithComments(fs.readFileSync(file, 'utf8'), file);
     * // a comment line in the file is ignored; a missing brace throws:
     * // Error: could not parse `/path/to/manifest.json`: Expected ',' or '}' …
     */
    parseJSONWithComments = function(text, filename) {

        var jsonStr = String(text);
        var name    = ( typeof(filename) != 'undefined' && filename !== null ) ? filename : 'the given text';

        if ( /\/\*\*/.test(jsonStr) ) {
            jsonStr = stripBlockComments(jsonStr);
        }
        jsonStr = stripLineComments(jsonStr);

        try {
            return JSON.parse(jsonStr);
        } catch (parseErr) {
            // trailing comma tolerance, as in requireJSON()
            var _stripped = jsonStr.replace(/,(\s*[\}\]])/g, '$1');
            if (_stripped !== jsonStr) {
                try {
                    var _result = JSON.parse(_stripped);
                    // #B928 — as in requireJSON(): the empty exports made a trailing comma a parse error
                    // was: console.warn('[ parseJSONWithComments ] trailing comma in `'+ name +'` — parsed successfully but please fix the file');
                    warn('[ parseJSONWithComments ] trailing comma in `'+ name +'` — parsed successfully but please fix the file');
                    return _result;
                } catch (_retryErr) {
                    // report the original error below
                }
            }
            var error = new Error('could not parse `'+ name +'`: '+ parseErr.message);
            error.cause = parseErr;
            throw error;
        }
    };

};//EO JSONHelper.
