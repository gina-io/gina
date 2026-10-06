/**
 * lib/cmd/cache/clear.js — the `gina cache:clear` CLI (render/output-cache flush).
 *
 * Source-inspection tests (same style as minion-kill.test.js / cache-stats's
 * sibling handlers): clear.js runs inside the CLI daemon context — it needs the
 * global `lib`, the resolved CmdHelper state, and live-HTTP to a running bundle,
 * so replicating it end-to-end is heavy for a unit test (that is what the
 * daemonless boot smoke covers). These assertions prove the source structure of:
 *
 *   (a) module shape + CmdHelper wiring + the RenderCache require form
 *   (b) argv parsing — --format=<x> and --dry-run (mirrors minion:kill)
 *   (c) single-bundle vs all-bundle branch (mirrors cache:stats)
 *   (d) pass 1 — offline fs reclaim via clearFsBundle(projectCachePath, …, {dryRun})
 *   (e) pass 2 — in-heap: POST /_gina/cache/clear (real) / GET /_gina/cache/stats
 *       (dry-run reachability probe), port-candidate resolution + ECONNREFUSED skip
 *   (f) output — JSON envelope via fs.writeSync(1) (pipe-safe), text via opt.client
 *   (g) help.txt + arguments.json
 *
 * Section 08 is a pure-logic replica of buildEnvelope — the genuinely-new
 * collect/format bit. The source pins in sections 04-06 lock the operators so the
 * replica cannot silently drift.
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var CLEAR_SOURCE = path.join(require('../fw'), 'lib/cmd/cache/clear.js');
var HELP_TXT     = path.join(require('../fw'), 'lib/cmd/cache/help.txt');
var ARGS_FILE    = path.join(require('../fw'), 'lib/cmd/cache/arguments.json');

var src     = fs.readFileSync(CLEAR_SOURCE, 'utf8');
var helpTxt = fs.readFileSync(HELP_TXT, 'utf8');
var argsArr = JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8'));


// ---------------------------------------------------------------------------
// 01 — Module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports the Clear constructor', function () {
        assert.match(src, /module\.exports\s*=\s*Clear;?/);
    });

    it('declares a function Clear(opt, cmd)', function () {
        assert.match(src, /function\s+Clear\s*\(\s*opt\s*,\s*cmd\s*\)\s*\{/);
    });

    it('initialises self with null format, dryRun false, null event, and an empty results array', function () {
        assert.match(src, /var self\s*=\s*\{\s*format\s*:\s*null\s*,\s*dryRun\s*:\s*false\s*,\s*event\s*:\s*null\s*,\s*results\s*:\s*\[\]\s*\}/);
    });

    it('reaches RenderCache via the lib registry (require(../../index).RenderCache)', function () {
        // The bare `require('lib/render-cache')` does NOT resolve in bin/cmd daemon
        // scope (gna.js NODE_PATH injection never runs there); the registry form is
        // the correct reach — and `../../../render-cache/...` would overshoot the
        // version root (render-cache lives inside lib/).
        assert.ok(src.indexOf("require('../../index').RenderCache") > -1);
        assert.ok(src.indexOf("require('../../../render-cache") < 0);
    });

    it('wires CmdHelper with opt.client and debug flags', function () {
        assert.match(src, /new CmdHelper\(self, opt\.client, \{ port: opt\.debugPort, brkEnabled: opt\.debugBrkEnabled \}\)/);
    });

    it('gates on isCmdConfigured()', function () {
        assert.match(src, /if \(!isCmdConfigured\(\)\) return false;/);
    });
});


// ---------------------------------------------------------------------------
// 02 — argv parsing (mirrors minion:kill)
// ---------------------------------------------------------------------------

describe('02 - argv parsing', function () {

    it('captures --format=', function () {
        assert.match(src, /self\.format = process\.argv\[i\]\.split\(\/\\=\/\)\[1\]/);
    });

    it('captures the --dry-run boolean flag', function () {
        assert.match(src, /\/\^\\-\\-dry-run\$\/\.test\(process\.argv\[i\]\)/);
        assert.match(src, /self\.dryRun = true;/);
    });

    it('captures --event=<name>', function () {
        assert.match(src, /\/\^\\-\\-event\\=\/\.test\(process\.argv\[i\]\)/);
        assert.match(src, /self\.event\s*=\s*process\.argv\[i\]\.split\(\/\\=\/\)\[1\]/);
    });
});


// ---------------------------------------------------------------------------
// 03 — single-bundle vs all-bundle branch (mirrors cache:stats)
// ---------------------------------------------------------------------------

describe('03 - bundle branch', function () {

    it('clears all bundles when no positional bundle is given', function () {
        assert.match(src, /if \(!self\.name\) \{/);
        assert.match(src, /clearAll\(opt, cmd, 0\)/);
    });

    it('clears the one positional bundle otherwise', function () {
        assert.ok(src.indexOf('clearOne(self.name, opt, cmd, false)') > -1);
    });

    it('clearAll recurses over self.bundles', function () {
        assert.match(src, /if \(index >= self\.bundles\.length\)/);
        assert.match(src, /clearAll\(opt, cmd, index \+ 1\)/);
    });
});


// ---------------------------------------------------------------------------
// 04 — pass 1: offline fs reclaim
// ---------------------------------------------------------------------------

describe('04 - offline fs reclaim', function () {

    it('calls clearFsBundle(resolveBundleRoot(bundle), bundle, {dryRun}) on a fresh RenderCache', function () {
        assert.ok(src.indexOf('new RenderCache().clearFsBundle(resolveBundleRoot(bundle), bundle, { dryRun: self.dryRun })') > -1);
    });

    it('wraps the fs pass so a broken cache dir never aborts the run', function () {
        // Structural try -> call -> catch pin. Anchor on the code-unique
        // `new RenderCache().clearFsBundle` form so it can't match the module
        // JSDoc's bare `clearFsBundle` mention (the indexOf-on-a-JSDoc trap).
        assert.match(src, /try \{[\s\S]{0,220}?new RenderCache\(\)\.clearFsBundle\(resolveBundleRoot\(bundle\)[\s\S]{0,140}?\} catch/);
    });

    it('SKIPS the offline fs reclaim under --event', function () {
        // clearFsBundle is a bundle-wide directory reclaim that knows nothing about
        // events — running it on an --event run would wipe the bundle's ENTIRE on-disk
        // cache while the caller asked for one event's entries.
        assert.match(src, /if \(\s*!self\.event\s*\)\s*\{[\s\S]{0,400}?clearFsBundle\(/);
    });
});


// ---------------------------------------------------------------------------
// 05 — pass 2: in-heap flush / dry-run probe
// ---------------------------------------------------------------------------

describe('05 - in-heap flush / probe', function () {

    it('resolves the bundle port from portsReverseData + def_env', function () {
        assert.ok(src.indexOf("self.portsReverseData[bundle + '@' + self.projectName]") > -1);
        assert.ok(src.indexOf('self.projects[self.projectName].def_env') > -1);
    });

    it('POSTs /_gina/cache/clear on a real run, GETs /_gina/cache/stats on a dry-run', function () {
        assert.match(src, /var method\s*=\s*self\.dryRun\s*\?\s*'GET'\s*:\s*'POST'/);
        assert.ok(src.indexOf("'/_gina/cache/clear' + clearQuery") > -1);
        assert.ok(src.indexOf("'/_gina/cache/stats'") > -1);
    });

    it('selects ?event= over ?bundle= when --event is given', function () {
        // The registry has no bundle dimension, so an --event run sends the event
        // INSTEAD of the bundle (server-side, `event` also wins over `bundle`).
        assert.ok(src.indexOf("'?event='  + encodeURIComponent(self.event)") > -1);
        assert.ok(src.indexOf("'?bundle=' + encodeURIComponent(bundle)") > -1);
        assert.match(src, /var clearQuery\s*=\s*self\.event\s*\?/);
    });

    it('tries each candidate port, advancing on ECONNREFUSED', function () {
        assert.match(src, /if \(err\.code === 'ECONNREFUSED'\)/);
        assert.match(src, /return tryNext\(index \+ 1\)/);
    });

    it('dry-run drains the body and reports reachable WITHOUT a count', function () {
        // Slice the code-brace `if (self.dryRun) {` block (not the `?:` ternary) and
        // assert it drains + reports reachable but never parses a count.
        var i = src.indexOf('if (self.dryRun) {');
        assert.ok(i > -1, 'the dry-run response branch must exist');
        var blk = src.slice(i, i + 300);
        assert.ok(blk.indexOf('res.resume()') > -1, 'dry-run must drain the body');
        assert.ok(blk.indexOf('return done(null, true)') > -1, 'dry-run reports reachable');
        assert.ok(blk.indexOf('JSON.parse') < 0, 'dry-run must not parse a count');
    });

    it('real run parses the numeric {cleared} count from the response', function () {
        assert.ok(src.indexOf("typeof parsed.cleared === 'number'") > -1);
        assert.match(src, /done\(cleared, true\)/);
    });

    it('reports not-running (reachable=false) when no port responds', function () {
        assert.match(src, /return done\(null, false\)/);
    });
});


// ---------------------------------------------------------------------------
// 06 — output channel
// ---------------------------------------------------------------------------

describe('06 - output', function () {

    it('emits the JSON envelope via fs.writeSync(1) (pipe-safe vs process.exit)', function () {
        assert.match(src, /fs\.writeSync\(1, JSON\.stringify\(envelope\) \+ '\\n'\)/);
    });

    it('detects --format=json', function () {
        assert.ok(src.indexOf('/^json/i.test(String(self.format') > -1);
    });

    it('emits text via opt.client.write(formatText(...))', function () {
        assert.match(src, /opt\.client\.write\(formatText\(self\.results, self\.projectName, self\.dryRun, self\.event\)\)/);
    });

    it('terminates via opt.client end + process.exit', function () {
        assert.match(src, /if \(!opt\.client\.destroyed\) opt\.client\.emit\('end'\)/);
        assert.match(src, /process\.exit\(error \? 1 : 0\)/);
    });

    it('buildEnvelope flattens a single bundle and arrays all bundles', function () {
        assert.match(src, /base\.bundle\s*=\s*results\[0\]\.bundle/);
        assert.match(src, /base\.bundles\s*=\s*results\.map\(/);
    });
});


// ---------------------------------------------------------------------------
// 07 — help + arguments
// ---------------------------------------------------------------------------

describe('07 - help + arguments', function () {

    it('help.txt documents the clear + --dry-run + all-bundles forms', function () {
        assert.match(helpTxt, /gina cache:clear <bundle> @<project_name>/);
        assert.match(helpTxt, /--dry-run/);
        assert.match(helpTxt, /gina cache:clear @<project_name>/);
    });

    it('arguments.json declares --dry-run and --format', function () {
        assert.ok(Array.isArray(argsArr));
        assert.ok(argsArr.indexOf('--dry-run') > -1);
        assert.ok(argsArr.indexOf('--format') > -1);
    });

    it('arguments.json whitelists --event (else CmdHelper reads it as a bundle name)', function () {
        assert.ok(argsArr.indexOf('--event') > -1);
    });

    it('help.txt documents the --event form and that it is the in-heap pass only', function () {
        assert.match(helpTxt, /--event\=<event_name>/);
        assert.match(helpTxt, /IN-HEAP pass only/);
    });
});


// ---------------------------------------------------------------------------
// 08 — pure-logic replica of buildEnvelope
//      (mirrors clear.js; section 06 source-pins lock the shape)
// ---------------------------------------------------------------------------

describe('08 - buildEnvelope replica', function () {

    // Verbatim replica of clear.js buildEnvelope.
    function buildEnvelope(project, dryRun, results, singleBundle) {
        var base = { project: project, dryRun: dryRun };
        if (singleBundle && results.length === 1) {
            base.bundle        = results[0].bundle;
            base.fsRemoved     = results[0].fsRemoved;
            base.inHeapCleared = results[0].inHeapCleared;
            base.reachable     = results[0].reachable;
            return base;
        }
        base.bundles = results.map(function (r) {
            return {
                bundle        : r.bundle,
                fsRemoved     : r.fsRemoved,
                inHeapCleared : r.inHeapCleared,
                reachable     : r.reachable
            };
        });
        return base;
    }

    var one = [{ bundle: 'api', fsRemoved: ['/p/cache/api/html'], inHeapCleared: 5, reachable: true }];
    var two = [
        { bundle: 'api', fsRemoved: ['/p/cache/api/html'], inHeapCleared: 5, reachable: true },
        { bundle: 'web', fsRemoved: [],                     inHeapCleared: null, reachable: false }
    ];

    it('single bundle → flattened fields, no bundles array', function () {
        var e = buildEnvelope('myproject', false, one, 'api');
        assert.equal(e.project, 'myproject');
        assert.equal(e.dryRun, false);
        assert.equal(e.bundle, 'api');
        assert.deepEqual(e.fsRemoved, ['/p/cache/api/html']);
        assert.equal(e.inHeapCleared, 5);
        assert.equal(e.reachable, true);
        assert.ok(!('bundles' in e));
    });

    it('all bundles → bundles array, no top-level bundle', function () {
        var e = buildEnvelope('myproject', false, two, null);
        assert.ok(!('bundle' in e));
        assert.equal(e.bundles.length, 2);
        assert.equal(e.bundles[0].bundle, 'api');
        assert.equal(e.bundles[0].inHeapCleared, 5);
        assert.equal(e.bundles[1].bundle, 'web');
        assert.equal(e.bundles[1].inHeapCleared, null);
        assert.equal(e.bundles[1].reachable, false);
    });

    it('dryRun flag rides through to the envelope', function () {
        var e = buildEnvelope('myproject', true, one, 'api');
        assert.equal(e.dryRun, true);
    });

    it('a not-running bundle carries inHeapCleared=null + reachable=false', function () {
        var e = buildEnvelope('myproject', false, [two[1]], 'web');
        assert.equal(e.inHeapCleared, null);
        assert.equal(e.reachable, false);
    });
});
