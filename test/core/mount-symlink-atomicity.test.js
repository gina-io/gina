/**
 * #B381 — boot-time bundle mount concurrency: call-site pins + a two-process
 * contention proof.
 *
 * Before the fix, every boot rewrote every declared bundle's mount symlink as
 * unlink-then-create — two non-atomic steps, per bundle, per config load, with
 * no mutual exclusion anywhere — so N processes booting one shared project
 * tree issued N×M unserialised rewrites of the same directory entries. A lost
 * race killed the boot (gna.mount exits on a mount error), and one contended
 * link aborted the whole shared config load. The mkdir walks on the same path
 * carried the same check-then-create race, uncaught.
 *
 * §01-§03 pin the converted call sites (comment-stripped ACTIVE corpus for
 * negatives — the replace-code convention keeps the old shapes as comments —
 * with raw-presence controls so a broken strip cannot pass a pin vacuously).
 * §04 is the behavioural core: two REAL child processes hammering the same
 * link name. The replica of the old sequence is the harness's firing control
 * (it MUST collide — proving the harness can see the race); the real helper
 * under the same drive must never fail. The replica holds the name-absent
 * window open ~1ms, standing in for the latency a network filesystem adds to
 * the very same window in production.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawn = require('child_process').spawn;

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var commentStrip = require('../strip-comments');
var FW = path.join(ginaRoot, 'framework', 'v' + version);

var GNA_RAW = fs.readFileSync(path.join(FW, 'core', 'gna.js'), 'utf8');
var CONF_RAW = fs.readFileSync(path.join(FW, 'core', 'config.js'), 'utf8');
var GEN_RAW = fs.readFileSync(path.join(FW, 'lib', 'generator', 'index.js'), 'utf8');

// line-based comment strip: block comments + whole-line `//` comments — the
// `// was:` blocks keep the pre-fix shapes as comments, so negatives MUST
// strip first, and each stripped-away negative gets a raw-presence control.
function stripComments(src) {
    return commentStrip.lines(src);
}
var GNA = stripComments(GNA_RAW);
var CONF = stripComments(CONF_RAW);
var GEN = stripComments(GEN_RAW);

// ---------------------------------------------------------------------------
// 01 — gna.js: the mount path
// ---------------------------------------------------------------------------
describe('01 - gna.js mount converts to the idempotent atomic publish', function () {

    it('strip validity: the stripped corpus still holds the mount', function () {
        assert.ok(GNA.indexOf('gna.mount = process.mount = function') > -1,
            'stripComments must not have destroyed the corpus');
    });

    it('the mount publishes through ensureSymlinkSync', function () {
        assert.ok(GNA.indexOf('new _(source).ensureSymlinkSync(target, type)') > -1,
            'the atomic idempotent publish call is missing');
    });

    it('no ACTIVE code removes the mount target any more (raw keeps the record)', function () {
        assert.equal(GNA.indexOf('targetObj.rmSync()'), -1,
            'the in-mount unlink half must be gone from active code');
        assert.equal(GNA.indexOf('fs.unlinkSync(target)'), -1,
            'the early unlink (whose catch also missed its return) must be gone from active code');
        assert.equal(GNA.indexOf('manifest.bundles[bundle].link ).rmSync()'), -1,
            'isBundleMounted must not pre-unlink the mount before calling gna.mount');
        // raw-presence controls: the old shapes survive as `// was:` comments,
        // so a broken stripComments would be visible here
        assert.ok(GNA_RAW.indexOf('targetObj.rmSync()') > -1, 'strip control (rm)');
        assert.ok(GNA_RAW.indexOf('fs.unlinkSync(target)') > -1, 'strip control (unlink)');
        assert.ok(GNA_RAW.indexOf('manifest.bundles[bundle].link ).rmSync()') > -1, 'strip control (pre-unlink)');
    });

    it('the restart path still forces the mount call (repair stays possible)', function () {
        var gateIdx = GNA.indexOf('if (!gna.started && isMounted) {');
        assert.ok(gateIdx > -1, 'the not-yet-started remount gate is missing');
        var forceIdx = GNA.indexOf('isMounted = false;', gateIdx);
        assert.ok(forceIdx > gateIdx && forceIdx - gateIdx < 200,
            'the gate must still force isMounted=false so gna.mount runs and can repair a wrong link');
    });

    it('the three project folders are created race-free', function () {
        assert.ok(GNA.indexOf('fs.mkdirSync(mountingPath, { recursive: true })') > -1, 'bundles/');
        assert.ok(GNA.indexOf('fs.mkdirSync(tmpPath, { recursive: true })') > -1, 'tmp/');
        assert.ok(GNA.indexOf('fs.mkdirSync(cachePath, { recursive: true })') > -1, 'cache/');
        assert.equal(GNA.indexOf('new _(mountingPath).mkdirSync()'), -1,
            'the check-then-create pair must be gone (it threw uncaught on a lost race)');
    });
});

// ---------------------------------------------------------------------------
// 02 — config.js: the every-bundle loop
// ---------------------------------------------------------------------------
describe('02 - config.js bundle-link loop converts to the idempotent atomic publish', function () {

    it('both env branches publish through ensureSymlinkSync (exactly two sites)', function () {
        var m = CONF.match(/\.ensureSymlinkSync\(appPath\)/g);
        assert.ok(m, 'no ensureSymlinkSync call in the loop');
        assert.equal(m.length, 2, 'expected the dev branch and the release branch, nothing else');
    });

    it('no ACTIVE code unlinks a bundle link any more (raw keeps the record)', function () {
        assert.equal(CONF.indexOf('targetAppPathObj.rmSync()'), -1,
            'the per-bundle unlink half must be gone from active code');
        assert.ok(CONF_RAW.indexOf('targetAppPathObj.rmSync()') > -1, 'strip control');
        assert.equal(CONF.indexOf('targetAppPathObj.symlinkSync(appPath)'), -1,
            'the bare two-step create must be gone from active code');
    });

    it('the releaseError contract is untouched: genuine failures still abort by name', function () {
        // the #B372 catch (named-bundle abort) must still be the failure sink
        var catchIdx = CONF.indexOf('} catch (releaseError) {');
        assert.ok(catchIdx > -1, 'the releaseError catch is missing');
        assert.ok(CONF.indexOf('return callback(_releaseError)', catchIdx) > catchIdx,
            'a genuine publish failure must still abort the shared config load, named');
    });
});

// ---------------------------------------------------------------------------
// 03 — generator: createPathSync
// ---------------------------------------------------------------------------
describe('03 - generator.createPathSync creates recursively, without the per-segment race', function () {

    it('the per-segment walk is gone; a single recursive create remains', function () {
        var declIdx = GEN.indexOf('createPathSync : function');
        assert.ok(declIdx > -1, 'declaration missing');
        var body = GEN.substring(declIdx, declIdx + 600);
        assert.ok(body.indexOf('recursive: true') > -1, 'recursive create missing');
        assert.equal(GEN.indexOf('for (var p=0; p<t.length; ++p)'), -1,
            'the segment loop (check-then-create per segment) must be gone');
        // callback contract unchanged
        assert.ok(body.indexOf('callback(false)') > -1, 'success callback shape');
        assert.ok(body.indexOf('callback(err)') > -1, 'error callback shape');
    });
});

// ---------------------------------------------------------------------------
// 04 — two-process contention: replica control vs the real helper
// ---------------------------------------------------------------------------
describe('04 - two real processes on one link name', function () {

    var root = null;
    var srcA = null;
    var srcB = null;
    var ITERS = 200;

    // Replica of the PRE-fix sequence (unlink if present, then create). The
    // 1ms hold widens the same absent-name window that filesystem latency
    // widens in production; this replica is the FIRING CONTROL — if it cannot
    // collide, the harness cannot certify the real helper's zero.
    var CHILD_OLD =
        "var fs = require('fs');\n" +
        "var srcA = process.argv[2], srcB = process.argv[3], dst = process.argv[4], iters = +process.argv[5];\n" +
        "function holdMs(ms){ var t = Date.now(); while (Date.now() - t < ms) {} }\n" +
        "var failures = 0;\n" +
        "for (var i = 0; i < iters; i++) {\n" +
        "    var src = (i % 2) ? srcB : srcA;\n" +
        "    try {\n" +
        "        if (fs.existsSync(dst)) { fs.unlinkSync(dst); }\n" +
        "        holdMs(1);\n" +
        "        fs.symlinkSync(src, dst);\n" +
        "    } catch (e) { failures++; }\n" +
        "}\n" +
        "process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ failures: failures }) + '@@END@@');\n";

    // The real helper under the same alternating drive — every iteration is a
    // genuine rewrite (the sibling keeps flipping the target), so this
    // exercises the atomic-replace path itself, not just the kept fast path.
    var CHILD_NEW =
        "var path = require('path');\n" +
        "var FW = process.argv[6];\n" +
        "require('module').Module._initPaths();\n" +
        "require(path.join(FW, 'helpers'));\n" +
        "var srcA = process.argv[2], srcB = process.argv[3], dst = process.argv[4], iters = +process.argv[5];\n" +
        "var failures = 0;\n" +
        "for (var i = 0; i < iters; i++) {\n" +
        "    var src = (i % 2) ? srcB : srcA;\n" +
        "    try { new _(src).ensureSymlinkSync(dst); } catch (e) { failures++; }\n" +
        "}\n" +
        "process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ failures: failures }) + '@@END@@');\n";

    // Replica of the PRE-fix createPathSync (exists/mkdir per segment) — the
    // mkdir-side firing control.
    var CHILD_OLD_MKDIR =
        "var fs = require('fs');\n" +
        "var base = process.argv[2], iters = +process.argv[3];\n" +
        "function holdMs(ms){ var t = Date.now(); while (Date.now() - t < ms) {} }\n" +
        "var failures = 0;\n" +
        "for (var i = 0; i < iters; i++) {\n" +
        "    var t = (base + '/run-' + i + '/a/b').split('/');\n" +
        "    var cur = '';\n" +
        "    try {\n" +
        "        for (var s = 0; s < t.length; s++) {\n" +
        "            if (!t[s]) { continue; }\n" +
        "            cur += '/' + t[s];\n" +
        "            if (!fs.existsSync(cur)) { holdMs(1); fs.mkdirSync(cur); }\n" +
        "        }\n" +
        "    } catch (e) { failures++; }\n" +
        "}\n" +
        "process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ failures: failures }) + '@@END@@');\n";

    // The real createPathSync under the same drive.
    var CHILD_NEW_MKDIR =
        "var path = require('path');\n" +
        "var FW = process.argv[4];\n" +
        "var G = require(path.join(FW, 'lib', 'generator'));\n" +
        "var base = process.argv[2], iters = +process.argv[3];\n" +
        "var failures = 0;\n" +
        "var done = 0;\n" +
        "for (var i = 0; i < iters; i++) {\n" +
        "    G.createPathSync(base + '/run-' + i + '/a/b', function (err) { if (err) { failures++; } done++; });\n" +
        "}\n" +
        "process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ failures: failures, done: done }) + '@@END@@');\n";

    function runPair(script, args) {
        // two concurrent children, same arguments — the shared-tree shape
        return Promise.all([0, 1].map(function () {
            return new Promise(function (resolve, reject) {
                var out = '';
                var child = spawn(process.execPath, args.slice(0, 1).concat(args.slice(1)), { stdio: ['ignore', 'pipe', 'ignore'] });
                child.stdout.on('data', function (d) { out += d; });
                child.on('error', reject);
                child.on('close', function () {
                    // The gina logger writes its levelled output to STDOUT too
                    // (children that load helpers emit e.g. an MQSpeaker
                    // connect warn there), so the result is sentinel-delimited
                    // rather than parsed from raw stdout.
                    var m = out.match(/@@RESULT@@([\s\S]*?)@@END@@/);
                    if (!m) { return reject(new Error('child emitted no result sentinel: ' + out.slice(0, 200))); }
                    try { resolve(JSON.parse(m[1])); }
                    catch (e) { reject(new Error('child result is not JSON: ' + m[1].slice(0, 200))); }
                });
            });
        }));
    }

    before(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-mount-atomicity-'));
        srcA = path.join(root, 'release-a');
        srcB = path.join(root, 'release-b');
        fs.mkdirSync(srcA);
        fs.mkdirSync(srcB);
        fs.writeFileSync(path.join(root, 'child-old.js'), CHILD_OLD);
        fs.writeFileSync(path.join(root, 'child-new.js'), CHILD_NEW);
        fs.writeFileSync(path.join(root, 'child-old-mkdir.js'), CHILD_OLD_MKDIR);
        fs.writeFileSync(path.join(root, 'child-new-mkdir.js'), CHILD_NEW_MKDIR);
    });

    after(function () {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
    });

    it('FIRING CONTROL: the pre-fix unlink-then-create sequence collides under two processes', { timeout: 60000 }, async function () {
        var dst = path.join(root, 'mount-old');
        var results = await runPair(CHILD_OLD, [path.join(root, 'child-old.js'), srcA, srcB, dst, String(ITERS)]);
        var total = results[0].failures + results[1].failures;
        assert.ok(total >= 1,
            'the replica of the old sequence must collide at least once across ' + (ITERS * 2) +
            ' contended rewrites — if it cannot, this harness cannot certify the fix (control failed to fire)');
    });

    it('the real helper survives the identical drive with ZERO failures', { timeout: 60000 }, async function () {
        var dst = path.join(root, 'mount-new');
        var results = await runPair(CHILD_NEW, [path.join(root, 'child-new.js'), srcA, srcB, dst, String(ITERS), FW]);
        assert.equal(results[0].failures, 0, 'child 1 must never fail');
        assert.equal(results[1].failures, 0, 'child 2 must never fail');
        var finalTarget = fs.readlinkSync(dst);
        assert.ok(finalTarget === srcA || finalTarget === srcB,
            'the surviving link must point at one of the two contended targets (last atomic winner)');
    });

    it('MKDIR FIRING CONTROL: the pre-fix per-segment walk collides under two processes', { timeout: 60000 }, async function () {
        var base = path.join(root, 'walk-old');
        fs.mkdirSync(base);
        var results = await runPair(CHILD_OLD_MKDIR, [path.join(root, 'child-old-mkdir.js'), base, '60']);
        var total = results[0].failures + results[1].failures;
        assert.ok(total >= 1,
            'the per-segment replica must collide at least once — otherwise the mkdir arm cannot certify anything');
    });

    it('the real createPathSync survives the identical drive with ZERO failures', { timeout: 60000 }, async function () {
        var base = path.join(root, 'walk-new');
        fs.mkdirSync(base);
        var results = await runPair(CHILD_NEW_MKDIR, [path.join(root, 'child-new-mkdir.js'), base, '60', FW]);
        assert.equal(results[0].failures + results[1].failures, 0,
            'concurrent recursive creates of the same paths must all succeed');
        assert.equal(results[0].done, 60, 'child 1 must have completed every callback');
        assert.equal(results[1].done, 60, 'child 2 must have completed every callback');
        assert.ok(fs.existsSync(path.join(base, 'run-59', 'a', 'b')), 'the last path must exist');
    });
});
