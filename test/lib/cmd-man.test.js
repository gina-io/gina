/**
 * lib/cmd/man-render.js + the four lib/cmd/<group>/man.js re-exports —
 * `gina <group>:man` runtime-renders a group's manual page.
 *
 * The pure render helpers (substitute / stripRonn / renderMan) touch no injected
 * globals, so they are exercised BEHAVIOURALLY here via a plain require of
 * man-render.js (the strong coverage). The Man handler reads the CLI globals
 * (getPath / GINA_VERSION / lib.logger) lazily inside its body — never at module
 * load — so the require above does not trip; the handler itself is covered by
 * source-inspection pins (same style as connector-migrate / framework-update).
 *
 * Pinned/tested:
 *   (a) pure helpers — placeholder substitution + ronn stripping (behavioural)
 *   (b) module shape — exports Man + the three helpers; require-safe (no
 *       module-top global access; console is read lazily inside Man)
 *   (c) handler — group from opt.task.topic, gina-<group>.1.md resolution,
 *       help.txt fallback, exit codes
 *   (d) the four group re-exports delegate to ../man-render
 *   (e) framework help.txt advertises the four :man commands
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW            = require('../fw');
var commentStrip = require('../strip-comments');
var MAN_RENDER    = path.join(FW, 'lib/cmd/man-render.js');
var HELP_TXT      = path.join(FW, 'lib/cmd/framework/help.txt');
var GROUPS        = ['framework', 'project', 'bundle', 'service'];

var src     = fs.readFileSync(MAN_RENDER, 'utf8');
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');

// Comment-stripped source for the "no global at module top" negative pins — the
// JSDoc legitimately NAMES getPath / GINA_VERSION / lib.logger in prose, which
// would trip a raw code-absence check (jsdoc.md trap).
var srcNoComments = commentStrip.all(src);

// Require-by-path: safe because man-render.js touches no globals at module load.
var man = require(MAN_RENDER);


// ---------------------------------------------------------------------------
// 01 — Pure helper: substitute (behavioural)
// ---------------------------------------------------------------------------

describe('01 - substitute', function () {

    it('replaces {version} and {year}', function () {
        assert.equal(man.substitute('release {version} (c) 2009-{year}', '0.5.5-alpha.2', 2026),
            'release 0.5.5-alpha.2 (c) 2009-2026');
    });

    it('replaces every occurrence (global)', function () {
        assert.equal(man.substitute('{version} {version} {year} {year}', '1.2.3', 2026),
            '1.2.3 1.2.3 2026 2026');
    });

    it('leaves content without placeholders unchanged', function () {
        assert.equal(man.substitute('no placeholders here', '1.2.3', 2026), 'no placeholders here');
    });

    it('coerces a numeric year to a string', function () {
        assert.equal(man.substitute('{year}', 'x', 2026), '2026');
    });
});


// ---------------------------------------------------------------------------
// 02 — Pure helper: stripRonn (behavioural)
// ---------------------------------------------------------------------------

describe('02 - stripRonn', function () {

    it('removes ~~~ and ~~~tty code-fence lines', function () {
        assert.equal(man.stripRonn('a\n~~~tty\n$ gina\n~~~\nb'), 'a\n\n$ gina\n\nb');
    });

    it('removes the ronn === title underline', function () {
        assert.equal(man.stripRonn('gina(1) -- CLI\n=============\nbody'), 'gina(1) -- CLI\n\nbody');
    });

    it('removes --- horizontal rules', function () {
        assert.equal(man.stripRonn('a\n----\nb'), 'a\n\nb');
    });

    it('strips ATX heading markers but keeps the heading text', function () {
        assert.equal(man.stripRonn('## SYNOPSIS\n### Sub'), 'SYNOPSIS\nSub');
    });

    it('strips **bold** markers but keeps the inner text', function () {
        assert.equal(man.stripRonn('**gina** start and **stop**'), 'gina start and stop');
    });

    it('leaves plain prose and <url> links intact', function () {
        var prose = 'See the docs at <https://gina.io/> for details.';
        assert.equal(man.stripRonn(prose), prose);
    });
});


// ---------------------------------------------------------------------------
// 03 — Pure helper: renderMan (composed)
// ---------------------------------------------------------------------------

describe('03 - renderMan', function () {

    it('substitutes then strips ronn', function () {
        var input = '## TITLE\n=====\n**release {version}** (c) 2009-{year}\n~~~tty\n$ gina\n~~~';
        var out = man.renderMan(input, '0.5.5-alpha.2', 2026);
        assert.match(out, /TITLE/);
        assert.match(out, /release 0\.5\.5-alpha\.2 \(c\) 2009-2026/);
        assert.doesNotMatch(out, /\{version\}|\{year\}|~~~|\*\*|^={3,}/m);
    });
});


// ---------------------------------------------------------------------------
// 04 — Module shape + require-safety
// ---------------------------------------------------------------------------

describe('04 - module shape', function () {

    it('exports the Man handler as a function', function () {
        assert.equal(typeof man, 'function');
    });

    it('attaches the three pure helpers for reuse/tests', function () {
        assert.equal(typeof man.substitute, 'function');
        assert.equal(typeof man.stripRonn, 'function');
        assert.equal(typeof man.renderMan, 'function');
    });

    it('declares function Man(opt)', function () {
        assert.match(src, /function Man\s*\(\s*opt\s*\)\s*\{/);
    });

    it('reads console (lib.logger) lazily INSIDE Man, not at module top', function () {
        var manIdx = srcNoComments.indexOf('function Man');
        var topPortion = srcNoComments.slice(0, manIdx);
        assert.doesNotMatch(topPortion, /lib\.logger/, 'lib.logger must not be read at module load (keeps the file require-testable)');
        // and it IS read inside the handler
        assert.match(srcNoComments.slice(manIdx), /var console\s*=\s*lib\.logger;/);
    });

    it('the module top touches no injected globals (only fs + path)', function () {
        var topPortion = srcNoComments.slice(0, srcNoComments.indexOf('function substitute'));
        assert.doesNotMatch(topPortion, /getPath|GINA_|lib\./);
        assert.match(src, /var fs\s*=\s*require\('fs'\);/);
    });
});


// ---------------------------------------------------------------------------
// 05 — Handler behaviour (source pins)
// ---------------------------------------------------------------------------

describe('05 - handler', function () {

    it('derives the group from opt.task.topic (default framework)', function () {
        assert.match(src, /var group\s*=\s*\(opt && opt\.task && opt\.task\.topic\)\s*\?\s*opt\.task\.topic\s*:\s*'framework';/);
    });

    it('resolves the group man page as gina-<group>.1.md under the cmd dir', function () {
        assert.match(src, /getPath\('gina'\)\.lib/);
        assert.match(src, /'\/cmd\/gina-'\s*\+\s*group\s*\+\s*'\.1\.md'/);
    });

    it('renders the man page when it exists', function () {
        assert.match(src, /if \(fs\.existsSync\(manPath\)\)/);
        assert.match(src, /renderMan\(fs\.readFileSync\(manPath, 'utf8'\), version, year\)/);
    });

    it('substitutes {version} from GINA_VERSION and {year} from the current year', function () {
        assert.match(src, /var version\s*=\s*\(typeof\(GINA_VERSION\) != 'undefined'\)\s*\?\s*GINA_VERSION\s*:\s*'';/);
        assert.match(src, /var year\s*=\s*new Date\(\)\.getFullYear\(\);/);
    });

    it('falls back to the group help.txt when no man page exists', function () {
        assert.match(src, /'\/cmd\/'\s*\+\s*group\s*\+\s*'\/help\.txt'/);
        assert.match(src, /No manual page for `' \+ group \+ '` yet/);
    });

    it('exits 0 on success and 1 when nothing is available', function () {
        assert.match(src, /process\.exit\(0\)/);
        assert.match(src, /No manual or help available for/);
        assert.match(src, /process\.exit\(1\)/);
    });
});


// ---------------------------------------------------------------------------
// 06 — Group re-exports
// ---------------------------------------------------------------------------

describe('06 - group re-exports', function () {

    GROUPS.forEach(function (g) {
        it(g + '/man.js delegates to ../man-render', function () {
            var p = path.join(FW, 'lib/cmd/' + g + '/man.js');
            assert.ok(fs.existsSync(p), g + '/man.js must exist for the filename-based dispatch');
            var gsrc = fs.readFileSync(p, 'utf8');
            assert.match(gsrc, /module\.exports\s*=\s*require\('\.\.\/man-render'\);/);
        });
    });
});


// ---------------------------------------------------------------------------
// 07 — help.txt advertises the four :man commands
// ---------------------------------------------------------------------------

describe('07 - help.txt advertisement', function () {

    GROUPS.forEach(function (g) {
        it('framework help.txt advertises ' + g + ':man', function () {
            assert.match(helpTxt, new RegExp(g + ':man'));
        });
    });
});
