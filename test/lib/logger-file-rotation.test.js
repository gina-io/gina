/**
 * The logger's `file` container — in-process sink, rotation, and the guards
 * around both.
 *
 * The container is now REQUIREABLE and DRIVEABLE in isolation, which the
 * previous MQ-coupled shape was not: it listens on the `logger#file` event that
 * `main.js emit()` raises, so a test can construct it with a hand-built option
 * set, emit payloads, and read what lands on disk. That is why most of this file
 * is behavioural rather than source pins.
 *
 * ⚠️ The behavioural arms CANNOT be validated red-first against the pre-fix
 * bytes, and the reason is the defect itself: constructing the old container
 * opened an MQ socket, and its error handler called `process.exit(0)` — so the
 * old file kills the test RUNNER rather than failing an assertion. The source
 * pins in §06 were validated against those bytes in a child process instead
 * (`node -e` over the blob from `git show v0.6.29:…`), which is the only way to
 * read that file without loading it.
 *
 * Background: `audit/2026-09-09-b523-logrot-review.md` (#B523 / #B526–#B531).
 */
'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const FW_DIR = require('../fw');
const REL    = 'lib/logger/src/containers/file/index.js';
const FILE   = path.join(FW_DIR, REL);

/** Strip comments so a pin can never be satisfied by prose describing the fix. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ESC = String.fromCharCode(27);

let CURRENT = '';
let FileContainer = null;
let TMP = '';
const PREV_LOGDIR = process.env.GINA_LOGDIR;

/**
 * A minimal but faithful logger option set: enough for `helper.js format()` to
 * render, with real colour codes so the ANSI-stripping arm has something to
 * strip. `hierarchy` deliberately excludes `debug`, so constructing the
 * container does not emit its own load notice into the arms below.
 *
 * @param {object} [over] - Keys to override, e.g. `{ rotate: {...} }`.
 * @returns {object} The option set.
 */
function makeOpt(over) {
    const opt = {
        name        : 'gina',
        flows       : ['default', 'file'],
        template    : '[%d] [%s][%a] %m',
        _maxLevelLen: 7,
        hierarchy   : 'info',
        hierarchies : { info: [0, 3, 4, 6] },
        levels      : {
            info : { code: 6, color: 'cyan' },
            warn : { code: 4, color: 'yellow' },
            err  : { code: 3, color: 'red' },
            debug: { code: 7, color: 'gray' }
        }
    };
    return Object.assign(opt, over || {});
}

/** The registry `format()` reads its colours from. */
function makeLoggers() {
    const colors = {
        cyan  : { open: ESC + '[36m', close: ESC + '[39m' },
        yellow: { open: ESC + '[33m', close: ESC + '[39m' },
        red   : { open: ESC + '[31m', close: ESC + '[39m' },
        gray  : { open: ESC + '[90m', close: ESC + '[39m' }
    };
    return {
        'gina'       : { colors: colors },
        'web@proj'   : { colors: colors },
        'api@proj'   : { colors: colors }
    };
}

/** Emit one line the way `main.js emit()` does. */
function emitLine(group, level, content) {
    process.emit('logger#file', JSON.stringify({
        group: group, level: level, content: content, skipFormating: false
    }));
}

/** Collect everything the container reports onto the `default` flow. */
function captureReports() {
    const seen = [];
    const onDefault = function (payload) {
        try { seen.push(JSON.parse(payload)); } catch (e) { /* not ours */ }
    };
    process.on('logger#default', onDefault);
    return {
        lines: seen,
        stop : function () { process.removeListener('logger#default', onDefault); }
    };
}

/** Let the deferred reports and the stream writes land. */
function settle(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 60); });
}

before(function () {
    CURRENT = stripComments(fs.readFileSync(FILE, 'utf8'));
    FileContainer = require(FILE);
});

beforeEach(function () {
    // Each arm constructs its own container; without this they would stack on
    // the shared process event and every arm would write N times. Production
    // constructs exactly one (loadContainers guards on `containers[flow]`).
    process.removeAllListeners('logger#file');
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-filesink-'));
    process.env.GINA_LOGDIR = TMP;
});

after(function () {
    process.removeAllListeners('logger#file');
    if (typeof PREV_LOGDIR === 'undefined') {
        delete process.env.GINA_LOGDIR;
    } else {
        process.env.GINA_LOGDIR = PREV_LOGDIR;
    }
});


describe('01 - Object.prototype.count makes a typeof guard unsafe for config objects', function () {
    it('the repo-root utils/prototypes.js is the actual installer, unguarded', function () {
        // NOT `helpers/prototypes.js`. That file declares `count` too, but its guard
        // is `typeof(Object.count) == 'undefined'` — and `Object` inherits through
        // Function.prototype to Object.prototype, so once utils/ has defined
        // Object.prototype.count the guard reads 'function' and the declaration is
        // SKIPPED. The trap defeats its own guard, which makes helpers:169 dead code
        // and makes it the wrong file to cite or to aim a fix at. Measured: the live
        // `({}).count.toString()` matches utils/, not helpers/.
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'prototypes.js'), 'utf8');
        assert.ok(src.indexOf("Object.defineProperty( Object.prototype, 'count'") > -1,
            'utils/prototypes.js must still define Object.prototype.count — if this moved, ' +
            'the rationale for the hasOwnProperty guard below needs rechecking');
        assert.ok(src.indexOf("Object.defineProperty( Object.prototype, 'functionCount'") > -1,
            'functionCount is declared ONLY here, which is what proves the attribution');
        assert.ok(src.indexOf('enumerable: false') > -1,
            'the extensions are non-enumerable, which is why Object.keys() hides them from a probe');
    });

    it('config resolution uses hasOwnProperty, never a typeof guard', function () {
        assert.ok(CURRENT.indexOf('Object.prototype.hasOwnProperty.call') > -1,
            'rotation config must be resolved with an own-property check');
        assert.equal(CURRENT.indexOf("typeof(user.count)"), -1,
            'a typeof guard reads the inherited Object.prototype.count METHOD as the ' +
            'configured value, which coerces to 0 and refuses rotation on a valid default');
    });

    it('BEHAVIOURAL: a default rotation config is not refused by the inherited method', async function () {
        // The arm that would have caught the first implementation of this feature:
        // `{}` answers `typeof x.count === 'function'`, and `~~(function)` is 0.
        const cap = captureReports();
        new FileContainer(makeOpt({ rotate: {} }), makeLoggers());
        emitLine('web@proj', 'info', 'hello');
        await settle();
        cap.stop();
        const refusals = cap.lines.filter(l => /rotation DISABLED/.test(l.content || ''));
        assert.equal(refusals.length, 0,
            'a partial rotate block must inherit the defaults, not be refused: ' +
            JSON.stringify(refusals.map(r => r.content)));
    });
});

describe('02 - rotation renames, it does not copy-and-truncate', function () {
    it('renames the live file and reopens', function () {
        assert.ok(CURRENT.indexOf('renameSync') > -1, 'rotation must rename');
    });
    it('never copies-then-truncates (the retired vendored rotator lost every line in the copy window)', function () {
        assert.equal(CURRENT.indexOf('createReadStream'), -1, 'no copy step');
        assert.equal(CURRENT.indexOf('fs.truncate'), -1, 'no truncate step');
    });

    it('BEHAVIOURAL: rotates by size, keeps `count` files, and loses no line', async function () {
        new FileContainer(makeOpt({ rotate: { when: null, size: '1KB', count: 3 } }), makeLoggers());
        for (let i = 1; i <= 60; i++) {
            emitLine('web@proj', 'info', 'ROT-' + i + ' ' + 'x'.repeat(40));
        }
        await settle(150);

        const live = path.join(TMP, 'web@proj.log');
        assert.ok(fs.existsSync(live + '.1'), 'expected a rotated .1');
        assert.equal(fs.existsSync(live + '.4'), false, 'must keep at most `count` rotated files');

        // Every line still on disk, and CONTIGUOUS: a rotation that dropped a
        // write would leave a gap, which a bare "some markers survive" assertion
        // could not distinguish from correct pruning.
        const all = [live, live + '.1', live + '.2', live + '.3']
            .filter(f => fs.existsSync(f))
            .map(f => fs.readFileSync(f, 'utf8'))
            .join('');
        const kept = (all.match(/ROT-(\d+)/g) || []).map(m => parseInt(m.slice(4), 10)).sort((a, b) => a - b);
        assert.ok(kept.length > 0, 'nothing was written at all');
        assert.equal(kept[kept.length - 1], 60, 'the newest line must survive');
        for (let i = 1; i < kept.length; i++) {
            assert.equal(kept[i], kept[i - 1] + 1,
                'retained lines must be contiguous — a gap at ' + kept[i - 1] + '..' + kept[i] +
                ' means a write was lost across a rotation');
        }
    });
});

describe('03 - the sink holds one descriptor instead of reopening per line', function () {
    it('uses a persistent append stream over a synchronously-opened descriptor', function () {
        // Sync open, then wrap: createWriteStream(path) opens asynchronously, so a
        // burst logged in one tick reaches a size trigger before the file exists
        // and the rename cascade throws ENOENT. The behavioural arm in §02 is what
        // caught it.
        assert.ok(CURRENT.indexOf("fs.openSync(entry.filename, 'a')") > -1,
            'the file must exist the moment the entry does, or rotation cannot rename it');
        assert.ok(CURRENT.indexOf('fs.createWriteStream(null, { fd: fd })') > -1,
            'a rotation that renames needs an owned descriptor to reopen');
    });
    it('no longer calls fs.writeFile per line', function () {
        assert.equal(CURRENT.indexOf('fs.writeFile('), -1,
            'per-line writeFile reopened the file for every record and gave concurrent ' +
            'callbacks no ordering guarantee');
    });
});

describe('04 - the sink is IN-PROCESS: it writes this process\'s own lines only', function () {
    it('listens on the logger#file event rather than an MQ socket', function () {
        assert.ok(CURRENT.indexOf("process.on('logger#'+ self.name, onLine)") > -1,
            'the container must consume the event emit() already raises');
    });

    it('opens no socket, and cannot exit the process', function () {
        // #B526 — the old container dialled the MQ port at construction and ran
        // `process.exit(0)` from the socket error handler, so enabling this flow
        // killed `gina start` (3/3) and any daemonless bundle.
        assert.equal(CURRENT.indexOf('net.createConnection'), -1, 'no dial');
        assert.equal(CURRENT.indexOf("require('net')"), -1, 'net must not be required at all');
        assert.equal(CURRENT.indexOf('process.exit('), -1,
            'a logging transport must never terminate its host process');
    });

    it('resolves its filename without instantiating Config', function () {
        // #B527 — resolving through `new Config()` is what made a process build a
        // FOREIGN bundle's configuration, and what crashed the bundle:start CLI.
        assert.equal(CURRENT.indexOf('new Config('), -1, 'no Config instantiation');
        assert.ok(CURRENT.indexOf("dir + '/' + group + '.log'") > -1,
            'the filename comes from the group, so one process owns one file');
    });

    it('BEHAVIOURAL: two groups produce two files, one line each', async function () {
        // The anti-#B527 arm. Under the MQ shape every process wrote every group,
        // so this same drive produced two copies of each line in ONE shared file.
        new FileContainer(makeOpt(), makeLoggers());
        emitLine('web@proj', 'info', 'MARK-web');
        emitLine('api@proj', 'info', 'MARK-api');
        await settle();

        const web = fs.readFileSync(path.join(TMP, 'web@proj.log'), 'utf8');
        const api = fs.readFileSync(path.join(TMP, 'api@proj.log'), 'utf8');
        assert.equal((web.match(/MARK-web/g) || []).length, 1, 'exactly one copy in the web file');
        assert.equal((api.match(/MARK-api/g) || []).length, 1, 'exactly one copy in the api file');
        assert.equal(web.indexOf('MARK-api'), -1, 'a group must not receive the other group\'s lines');
        assert.equal(api.indexOf('MARK-web'), -1, 'a group must not receive the other group\'s lines');
    });

    it('BEHAVIOURAL: a group with no `@` is not filed (the CLI/daemon guard)', async function () {
        new FileContainer(makeOpt(), makeLoggers());
        emitLine('gina', 'info', 'MARK-cli');
        emitLine('web@proj', 'info', 'MARK-bundle');
        await settle();

        assert.equal(fs.existsSync(path.join(TMP, 'gina.log')), false,
            'the CLI/daemon group has no file — those lines stay on stdout, as before');
        assert.ok(fs.readFileSync(path.join(TMP, 'web@proj.log'), 'utf8').indexOf('MARK-bundle') > -1,
            'CONTROL: the bundle group IS filed, so the negative above is not a dead probe');
    });

    it('BEHAVIOURAL: a group carrying a path separator is refused, not sanitised', async function () {
        const cap = captureReports();
        new FileContainer(makeOpt(), makeLoggers());
        emitLine('../escape@proj', 'info', 'MARK-escape-1');
        emitLine('../escape@proj', 'info', 'MARK-escape-2');
        emitLine('../escape@proj', 'info', 'MARK-escape-3');
        await settle();
        cap.stop();
        assert.equal(fs.existsSync(path.join(TMP, '../escape@proj.log')), false, 'nothing outside the log dir');
        const refusals = cap.lines.filter(l => /path separator/.test(l.content || ''));
        assert.equal(refusals.length, 1,
            'the refusal is reported ONCE and the group remembered — storing a falsy ' +
            'marker would re-report it per line; got ' + refusals.length);
    });
});

describe('05 - the vendored logrotator is retired', function () {
    it('the vendored copy is gone from disk', function () {
        assert.equal(fs.existsSync(path.join(FW_DIR, 'lib/logger/src/containers/file/lib/logrotator')), false,
            'the vendored rotator was size-only, copy-truncate, undeclared as a dependency ' +
            '(so invisible to CVE scanners) and unreachable — its require path did not resolve');
    });
    it('nothing references it any more', function () {
        const listener = fs.readFileSync(path.join(FW_DIR, 'lib/logger/src/containers/mq/listener.js'), 'utf8');
        assert.equal(listener.indexOf('logrotator'), -1, 'no dangling reference');
        assert.equal(listener.indexOf('startLogRotator'), -1, 'the dead entry point is gone');
        assert.ok(listener.indexOf('self.report') > -1, 'CONTROL: the listener itself is intact');
    });
});

describe('06 - what reaches the file, and what reaches the operator', function () {
    it('reports go through the flows, never raw stdout', function () {
        // #B528 — a raw process.stdout.write reaches nobody under a daemon:
        // start.js consumes the child's stdout and relays nothing after start.
        // Measured: an invalid rotate.size appeared ONLY on a gina-container
        // launcher's own stdout — 0 in the daemon log, 0 at a tail client, 0 in
        // the file, 0 in the CLI output.
        assert.equal(CURRENT.indexOf('process.stdout.write'), -1,
            'the container must report through the logger, not the raw pipe');
        assert.ok(CURRENT.indexOf("process.emit('logger#'+ flows[i], payload)") > -1,
            'reporting emits one payload per flow, which is what emit() itself does');
    });

    it('BEHAVIOURAL: an invalid rotate.size is refused, and the refusal is reported', async function () {
        const cap = captureReports();
        new FileContainer(makeOpt({ rotate: { when: null, size: '10', count: 3 } }), makeLoggers());
        emitLine('web@proj', 'info', 'MARK-refused');
        await settle();
        cap.stop();

        const refusal = cap.lines.find(l => /rotation DISABLED/.test(l.content || ''));
        assert.ok(refusal, 'the refusal must reach the flows');
        assert.ok(/"10"/.test(refusal.content), 'the refusal names the offending value');
        assert.ok(/explicit unit/.test(refusal.content), 'the refusal says what was expected');
        assert.ok(fs.readFileSync(path.join(TMP, 'web@proj.log'), 'utf8').indexOf('MARK-refused') > -1,
            'logging itself continues when rotation is refused');
    });

    it('BEHAVIOURAL: the file carries no ANSI escapes, though format() emits them', async function () {
        // #B529 — a log file is not a terminal. The colours are real here (the
        // registry supplies open/close codes), so this arm discriminates: it
        // fails if the strip is removed.
        new FileContainer(makeOpt(), makeLoggers());
        emitLine('web@proj', 'info', 'MARK-plain');
        await settle();

        const written = fs.readFileSync(path.join(TMP, 'web@proj.log'), 'utf8');
        assert.ok(written.indexOf('MARK-plain') > -1, 'the line was written');
        assert.equal(written.indexOf(ESC), -1, 'no escape sequences on disk');

        // CONTROL: the same rendering path DOES colour, so the assertion above is
        // not passing because colours were never produced.
        const helper = require(path.join(FW_DIR, 'lib/logger/src/helper.js'))(makeOpt(), makeLoggers());
        assert.ok(helper.format('web@proj', 'info', 'MARK-plain').indexOf(ESC) > -1,
            'CONTROL FAILED: format() produced no escapes, so the strip assertion proves nothing');
    });

    it('BEHAVIOURAL: an unopenable file is reported once and never throws', async function () {
        // #B530 — the open/write failure path. A regular FILE as the log directory
        // makes every openSync fail with ENOTDIR, which is the cheapest way to
        // drive it deterministically. What must hold: no throw, one report, and
        // the sink stays quiet rather than reporting per line.
        const notADir = path.join(TMP, 'this-is-a-file');
        fs.writeFileSync(notADir, 'x');
        process.env.GINA_LOGDIR = notADir;

        const cap = captureReports();
        new FileContainer(makeOpt(), makeLoggers());
        assert.doesNotThrow(function () {
            emitLine('web@proj', 'info', 'MARK-unopenable-1');
            emitLine('web@proj', 'info', 'MARK-unopenable-2');
            emitLine('web@proj', 'info', 'MARK-unopenable-3');
        }, 'a broken log path must never throw into the caller that logged');
        await settle();
        cap.stop();

        const failures = cap.lines.filter(l => /cannot open/.test(l.content || ''));
        assert.equal(failures.length, 1,
            'one report per outage, not one per line — got ' + failures.length);
        assert.ok(/ENOTDIR|ENOENT|EACCES/.test(failures[0].content),
            'the report carries the underlying errno: ' + failures[0].content);
    });

    it('BEHAVIOURAL: json mode writes one parseable object per line', async function () {
        new FileContainer(makeOpt({ format: 'json' }), makeLoggers());
        emitLine('web@proj', 'info', 'MARK-json');
        await settle();

        const written = fs.readFileSync(path.join(TMP, 'web@proj.log'), 'utf8').trim().split('\n');
        const parsed  = JSON.parse(written[written.length - 1]);
        assert.equal(parsed.message, 'MARK-json');
        assert.equal(parsed.bundle, 'web@proj');
        assert.equal(parsed.level, 'info');
        assert.equal(parsed.msg, 'MARK-json', '`msg` is kept as a back-compat alias');
        assert.equal(parsed.group, 'web@proj', '`group` is kept as a back-compat alias');
    });
});
