var fs       = require('fs');
var nodePath = require('path');

/**
 * @module gina/lib/cmd/man-render
 */
/**
 * Shared engine for the `gina <group>:man` commands (framework / project /
 * bundle / service). It runtime-renders a group's ronn-style manual page
 * (`lib/cmd/gina-<group>.1.md`) to the terminal — substituting the `{version}`
 * and `{year}` placeholders (the same template idiom `framework:version` uses
 * with `msg.json`) and stripping ronn markup so the output reads cleanly without
 * a build step or a markdown/man dependency. When a group has no `.1.md` source
 * yet (project / bundle / service today), the handler falls back to that group's
 * `help.txt`, so every advertised `:man` command works.
 *
 * Structure: the pure render helpers (`substitute` / `stripRonn` / `renderMan`)
 * take their inputs as arguments and touch no injected globals, so they are
 * unit-testable by a plain `require` of this file. The `Man` handler reads the
 * CLI globals (`getPath` / `GINA_VERSION` / `lib.logger`) LAZILY inside its body
 * — never at module load — so requiring this module in a test never trips on an
 * undefined global. Each `lib/cmd/<group>/man.js` is a one-line re-export of
 * this `Man` (the `bundle/cp.js` → `copy.js` alias idiom).
 *
 * @class Man
 * @constructor
 * @param {object} opt - Parsed command-line options. `opt.task.topic` is the
 *   group (`framework` / `project` / `bundle` / `service`), set by the CLI
 *   dispatcher (`framework/init.js` run()).
 */

/**
 * Replace the `{version}` and `{year}` placeholders carried by the `.1.md`
 * man-page templates. Pure — no globals.
 *
 * @inner
 * @param {string} content - Raw man-page text
 * @param {string} version - Framework version for `{version}`
 * @param {string|number} year - Calendar year for `{year}` (e.g. the copyright year)
 * @returns {string}
 * @example
 * substitute('release {version} (c) 2009-{year}', '0.5.5', 2026);
 * // → 'release 0.5.5 (c) 2009-2026'
 */
function substitute(content, version, year) {
    return String(content)
        .replace(/\{version\}/g, version)
        .replace(/\{year\}/g, String(year));
}

/**
 * Strip the ronn markup that does not read well as plain terminal text:
 * the `~~~`/`~~~tty` code-fence lines, the `===`/`---` title underline rules,
 * leading ATX heading markers (`## SECTION` → `SECTION`), and `**bold**`
 * emphasis markers (keeping the inner text). Conservative on purpose — link
 * angle brackets, lists, and prose are left intact. Pure — no globals.
 *
 * @inner
 * @param {string} content
 * @returns {string}
 * @example
 * stripRonn('## SYNOPSIS\n=====\n**gina** start\n~~~tty\n$ gina\n~~~');
 * // → 'SYNOPSIS\n\ngina start\n\n$ gina\n'
 */
function stripRonn(content) {
    return String(content)
        .replace(/^~~~.*$/gm, '')        // ronn code-fence delimiters (~~~ / ~~~tty)
        .replace(/^[=]{3,}\s*$/gm, '')   // ronn title underline (====)
        .replace(/^[-]{3,}\s*$/gm, '')   // horizontal rules (----)
        .replace(/^#{1,6}\s+/gm, '')     // ATX heading markers (## SECTION → SECTION)
        .replace(/\*\*(.+?)\*\*/g, '$1');// bold emphasis (**x** → x)
}

/**
 * Render a man-page body for the terminal: substitute the placeholders, then
 * strip the ronn markup. Pure — no globals.
 *
 * @inner
 * @param {string} content
 * @param {string} version
 * @param {string|number} year
 * @returns {string}
 */
function renderMan(content, version, year) {
    return stripRonn(substitute(content, version, year));
}

/**
 * The CLI handler. Resolves the group's `.1.md` under the framework lib `cmd/`
 * dir; renders it when present, otherwise falls back to the group's `help.txt`
 * with a one-line notice. Reads the injected globals lazily so this module
 * stays require-testable.
 *
 * @param {object} opt
 * @returns {void}
 * @example
 * // dispatched as `gina framework:man` → renders lib/cmd/gina-framework.1.md
 * // dispatched as `gina project:man`   → falls back to lib/cmd/project/help.txt
 */
function Man(opt) {
    var console = lib.logger;

    var group = (opt && opt.task && opt.task.topic) ? opt.task.topic : 'framework';
    var libDir = getPath('gina').lib;
    var version = (typeof(GINA_VERSION) != 'undefined') ? GINA_VERSION : '';
    var year = new Date().getFullYear();

    var manPath = _(libDir + '/cmd/gina-' + group + '.1.md', true);
    if (fs.existsSync(manPath)) {
        try {
            console.log(renderMan(fs.readFileSync(manPath, 'utf8'), version, year));
            process.exit(0);
            return;
        } catch (e) {
            console.error('Could not read the manual page for `' + group + '`: ' + (e.message || e));
            process.exit(1);
            return;
        }
    }

    // No .1.md source for this group yet — fall back to its help.txt.
    var helpPath = _(libDir + '/cmd/' + group + '/help.txt', true);
    if (fs.existsSync(helpPath)) {
        console.log('No manual page for `' + group + '` yet — showing `gina ' + group + ':help`:\n');
        try {
            console.log(fs.readFileSync(helpPath, 'utf8'));
            process.exit(0);
            return;
        } catch (e) {
            console.error('Could not read help for `' + group + '`: ' + (e.message || e));
            process.exit(1);
            return;
        }
    }

    console.error('No manual or help available for `' + group + '`.');
    process.exit(1);
}

module.exports = Man;
// Pure helpers exposed for unit tests (require-by-path; no globals touched here).
module.exports.substitute = substitute;
module.exports.stripRonn  = stripRonn;
module.exports.renderMan  = renderMan;
