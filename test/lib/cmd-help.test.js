/**
 * lib/cmd/framework/help.js — `gina --help` / `gina -h` / `gina help [<group>]`.
 *
 * All three are aliased to `framework:help` (lib/cmd/aliases.json) and must print
 * a command reference (lib/cmd/framework/help.txt by default, or a named group's
 * lib/cmd/<group>/help.txt for `gina help <group>`).
 *
 * Regression guard for the "shortcut not indexed [undefined]" bug: help.js used
 * to delegate to the `open` command (`open(GINA_DIR)`), but open.js's Open()
 * ignores its argument and switch()es on process.argv[3] — undefined for a bare
 * `--help`, so it fell into open.js's `default` branch and printed
 * `gina: shortcut not indexed [undefined]` instead of the help text.
 *
 * The handler reads the CLI globals (lib.logger) at module top, so it is not
 * require-safe; it is covered by source-inspection pins (same style as
 * cmd-man / framework-update), plus behavioural assertions on the help.txt
 * contract it prints.
 *
 * Pinned/tested:
 *   (a) help.js reads + prints lib/cmd/framework/help.txt, guarded + with exit codes
 *   (b) help.js no longer delegates to `open` (the bug) and never emits the
 *       "shortcut not indexed" message
 *   (c) module shape — exports Help(opt)
 *   (d) the help.txt contract — non-empty, advertises `gina --help | -h`
 *   (e) `gina help <group>` resolves lib/cmd/<group>/help.txt, traversal-safe,
 *       framework fallback for an unknown group
 *   (f) the shared getHelp() helper no longer prints the stray `file <path>`
 *       debug line (noise on every `gina <group>:help`)
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW        = require('../fw');
var commentStrip = require('../strip-comments');
var HELP_JS   = path.join(FW, 'lib/cmd/framework/help.js');
var HELP_TXT  = path.join(FW, 'lib/cmd/framework/help.txt');
var HELPER_JS = path.join(FW, 'lib/cmd/helper.js');
var CMD_DIR   = path.join(FW, 'lib/cmd');

var src       = fs.readFileSync(HELP_JS, 'utf8');
var helpTxt   = fs.readFileSync(HELP_TXT, 'utf8');
var helperSrc = fs.readFileSync(HELPER_JS, 'utf8');

// Groups that ship a help.txt (targets for `gina help <group>`).
var GROUPS = ['bundle', 'project', 'service', 'connector', 'env', 'secrets'];

// Comment-stripped source for the negative code-absence pins — the JSDoc
// legitimately names `./open` / `gina open` in prose, which would trip a raw
// code-absence check (jsdoc.md "negative pin trips on the file's own JSDoc" trap).
var srcNoComments = commentStrip.all(src);


// ---------------------------------------------------------------------------
// 01 — help.js reads and prints help.txt
// ---------------------------------------------------------------------------

describe('01 - help.js prints a framework help.txt by default', function () {

    it('resolves the framework help.txt relative to the handler dir', function () {
        assert.match(src, /path\.join\(\s*__dirname\s*,\s*['"]help\.txt['"]\s*\)/);
    });

    it('guards a missing help.txt before reading', function () {
        assert.match(src, /fs\.existsSync\(/);
    });

    it('reads the file and writes it to stdout', function () {
        assert.match(src, /fs\.readFileSync\(/);
        assert.match(src, /console\.log\(/);
    });

    it('exits 0 on success and 1 on failure', function () {
        assert.match(src, /process\.exit\(\s*0\s*\)/);
        assert.match(src, /process\.exit\(\s*1\s*\)/);
    });
});


// ---------------------------------------------------------------------------
// 02 — regression: no longer delegates to `open`, never emits the bad message
// ---------------------------------------------------------------------------

describe('02 - help.js no longer routes through the `open` command', function () {

    it('does not require ./open', function () {
        assert.doesNotMatch(srcNoComments, /require\(\s*['"]\.\/open['"]\s*\)/);
    });

    it('does not call open()', function () {
        assert.doesNotMatch(srcNoComments, /\bopen\s*\(/);
    });

    it('never emits the "shortcut not indexed" message (that belongs to `open`)', function () {
        assert.doesNotMatch(src, /shortcut not indexed/);
    });
});


// ---------------------------------------------------------------------------
// 03 — module shape
// ---------------------------------------------------------------------------

describe('03 - module shape', function () {

    it('exports a Help(opt) constructor', function () {
        assert.match(src, /function Help\s*\(\s*opt\s*\)/);
        assert.match(src, /module\.exports\s*=\s*Help/);
    });
});


// ---------------------------------------------------------------------------
// 04 — the framework help.txt contract that help.js prints
// ---------------------------------------------------------------------------

describe('04 - framework help.txt contract', function () {

    it('help.txt is present and non-empty', function () {
        assert.ok(helpTxt.length > 0, 'help.txt should carry the command reference');
    });

    it('help.txt advertises `gina --help | -h`, `gina help [<group>]` and a usage section', function () {
        assert.match(helpTxt, /gina --help \| -h/);
        assert.match(helpTxt, /gina help \[<group>\]/);
        assert.match(helpTxt, /usage:/i);
    });

    it('uses ASCII double-dash flags (no em-dash `—-` typos)', function () {
        assert.match(helpTxt, /gina --version/);
        assert.doesNotMatch(helpTxt, /—-/);
    });
});


// ---------------------------------------------------------------------------
// 05 — `gina help <group>` resolves the group's help.txt (traversal-safe)
// ---------------------------------------------------------------------------

describe('05 - per-group help resolution', function () {

    it('has a resolveHelpFile() that reads the group from process.argv[3]', function () {
        assert.match(src, /resolveHelpFile/);
        assert.match(src, /process\.argv\[3\]/);
    });

    it('validates the group with a traversal-safe [a-z][a-z0-9-]* pattern', function () {
        assert.match(src, /\[a-z\]\[a-z0-9-\]\*/);
    });

    it('resolves the candidate under lib/cmd and confines it there', function () {
        assert.match(src, /path\.resolve\(\s*__dirname\s*,\s*['"]\.\.['"]\s*\)/);
        assert.match(src, /path\.join\(\s*cmdDir\s*,\s*group\s*,\s*['"]help\.txt['"]\s*\)/);
        assert.match(src, /indexOf\(\s*cmdDir \+ path\.sep\s*\)\s*===\s*0/);
    });

    it('each advertised group actually ships a distinct, non-empty help.txt', function () {
        GROUPS.forEach(function (g) {
            var gp = path.join(CMD_DIR, g, 'help.txt');
            assert.ok(fs.existsSync(gp), g + '/help.txt should exist');
            var gTxt = fs.readFileSync(gp, 'utf8');
            assert.ok(gTxt.length > 0, g + '/help.txt should be non-empty');
            assert.notEqual(gTxt, helpTxt, g + '/help.txt should differ from the framework help');
        });
    });
});


// ---------------------------------------------------------------------------
// 06 — shared getHelp() helper no longer prints the stray debug line
// ---------------------------------------------------------------------------

describe('06 - getHelp() (helper.js) debug-noise removed', function () {

    it('getHelp() still exists and reads a group help.txt', function () {
        assert.match(helperSrc, /getHelp\s*=\s*function/);
        assert.match(helperSrc, /help\.txt/);
    });

    it('no longer console.log()s the stray `file <path>` debug line', function () {
        assert.doesNotMatch(helperSrc, /console\.log\(\s*['"]file /);
    });
});
