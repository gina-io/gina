/**
 * Suite-under-Bun gate — `script/check_bun_suite.js` (measured 2026-09-17).
 *
 * The gate reads TWO artifacts of one `bun test --isolate --reporter=junit`
 * run, because neither alone can see everything:
 *   - the JUnit XML carries every REGISTERED test with a stable key
 *     (`file :: classname :: name`, classname joined deepest-first by bun);
 *   - the console summary carries ` N errors` — load-time errors (a throwing
 *     describe body, a top-level throw) which the JUnit reporter is BLIND to:
 *     the describe-body case shows as a smaller suite, the top-level case
 *     omits the FILE entirely. Hence the every-file-on-disk-has-a-suite check.
 *
 * Verdict contract, one arm each: green on an exact match; red on a NEW
 * failing test, on any load-time error, on a test file absent from the XML,
 * and on an empty run (a control that cannot fire is not a control); a
 * VANISHED expected failure is a warning, not a red (the fix landed — update
 * the file); `--update` rewrites the expected file from the actual set.
 */
var { describe, it } = require('node:test');
var assert  = require('node:assert');
var path    = require('path');
var fs      = require('fs');
var os      = require('os');
var { spawnSync } = require('child_process');

var REPO    = path.resolve(__dirname, '../..');
var SCRIPT  = path.join(REPO, 'script/check_bun_suite.js');
var FX      = 'test/fixtures/bun-suite';
var FILES   = FX + '/files';

function run(args) {
    var r = spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: REPO, encoding: 'utf8' });
    return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function base(junit, consoleLog, expected) {
    return ['--junit', FX + '/' + junit, '--console', FX + '/' + consoleLog, '--expected', FX + '/' + expected, '--files', FILES];
}

describe('01 - green: actual failing set == expected set', function () {
    it('exits 0 and reports the match', function () {
        var r = run(base('junit-baseline.xml', 'console-clean.txt', 'expected-match.txt'));
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /expected failures: 1 .*matched/);
    });
});

describe('02 - red: a NEW failing test', function () {
    it('exits 1 and names the new failure by its key', function () {
        var r = run(base('junit-baseline.xml', 'console-clean.txt', 'expected-empty.txt'));
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /NEW failure/);
        assert.match(r.out, /b\.test\.js :: suite :: fails deliberately/);
    });
});

describe('03 - warn: a VANISHED expected failure is not a red', function () {
    it('exits 0 with a warning naming the stale entry', function () {
        var r = run(base('junit-baseline.xml', 'console-clean.txt', 'expected-stale.txt'));
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /VANISHED/);
        assert.match(r.out, /used to fail/);
    });
});

describe('04 - red: load-time errors reported by the console summary', function () {
    it('exits 1 when the console carries a non-zero errors line', function () {
        var r = run(base('junit-baseline.xml', 'console-errors.txt', 'expected-match.txt'));
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /2 load-time error/);
    });
});

describe('05 - red: a test file on disk that produced no suite (silent registration loss)', function () {
    it('exits 1 naming the missing file', function () {
        var r = run(base('junit-missing-file.xml', 'console-clean.txt', 'expected-match.txt'));
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /MISSING from the JUnit report/);
        assert.match(r.out, /a\.test\.js/);
    });
});

describe('06 - red: an empty run is not a green run', function () {
    it('exits 1 on tests="0"', function () {
        var r = run(base('junit-empty.xml', 'console-clean.txt', 'expected-empty.txt'));
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /zero tests/i);
    });
});

describe('07 - --update rewrites the expected file from the actual set', function () {
    it('writes one sorted key per line and exits 0', function () {
        var tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bun-gate-')), 'expected.txt');
        fs.writeFileSync(tmp, '# nothing expected\n');
        var r = run(['--junit', FX + '/junit-baseline.xml', '--console', FX + '/console-clean.txt', '--expected', tmp, '--files', FILES, '--update']);
        assert.equal(r.status, 0, r.out);
        var lines = fs.readFileSync(tmp, 'utf8').split('\n').filter(function (l) { return l && l[0] !== '#'; });
        assert.deepEqual(lines, [FILES + '/b.test.js :: suite :: fails deliberately']);
    });
});

describe('08 - usage', function () {
    it('exits 2 without the required arguments', function () {
        var r = run([]);
        assert.equal(r.status, 2, r.out);
        assert.match(r.out, /--junit/);
    });
});
