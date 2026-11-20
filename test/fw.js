'use strict';
/**
 * The framework directory of the tree these tests belong to, derived from
 * package.json's version. Import this instead of hardcoding
 * 'framework/v0.x.y-alpha.z' in test files.
 *
 * Loading it also refuses a tree whose `node_modules/gina` is another
 * directory than the tree itself: a `node_modules` linked whole to another
 * clone's, a `gina` entry linked to another clone, or an installed copy. The
 * tests that `require('gina')` would then run that code beside this tree's,
 * and the run would describe neither. A tree without `node_modules/gina`, or
 * with a dangling one, is left as it was (CONTRIBUTING.md describes the
 * self-symlink).
 *
 * @module test/fw
 * @type {string}
 * @throws {Error} When `<tree>/node_modules/gina` is another directory than `<tree>`.
 * @example
 * var FW = require('../fw');
 * var source = fs.readFileSync(path.join(FW, 'core', 'router.js'), 'utf8');
 */
var fs   = require('fs');
var path = require('path');
var pkg  = require('../package.json');
var root = path.resolve(__dirname, '..');
var link = path.join(root, 'node_modules', 'gina');

/**
 * Stats a path, following links.
 * @inner
 * @private
 * @param {string} p - The path.
 * @returns {?fs.BigIntStats} The stats, or null when the path does not lead
 *   to a file (ENOENT, a dangling link, or ENOTDIR).
 * @throws {Error} Any other stat error.
 */
function statOrNull(p) {
    try {
        return fs.statSync(p, { bigint: true });
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
    }
}

var target = statOrNull(link);
if (target !== null) {
    var self = fs.statSync(root, { bigint: true });
    // The same device and inode: the same directory however its path is
    // spelt (letter case, links), as `test -ef` compares.
    if (target.dev !== self.dev || target.ino !== self.ino) {
        throw new Error('test/fw.js: ' + link + ' is ' + fs.realpathSync(link)
            + ', not the tree under test (' + fs.realpathSync(root) + '): the'
            + ' tests that require(\'gina\') would load that tree beside this one.'
            + ' Give this tree its own node_modules/gina: a real node_modules'
            + ' directory and `ln -sfn "$PWD" node_modules/gina` (CONTRIBUTING.md).');
    }
}

module.exports = path.resolve(root, 'framework', 'v' + pkg.version);
