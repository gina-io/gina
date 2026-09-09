/**
 * Log rotation for the logger's `file` container.
 *
 * The container is constructed inside a closure that needs a live framework
 * context and an MQ socket, so its internals are not directly callable from a
 * unit test — the established style for this container is source inspection
 * (see `logger-container-homedir.test.js`). Every source pin below was validated
 * RED against the pre-fix bytes at authoring time — the parent of the commit that
 * introduced them, `a1356ab54`. That validation is deliberately NOT shipped as an
 * assertion: a test that reads `git show HEAD:` inverts the moment the fix is
 * committed, which is exactly how these three pins passed locally and then failed
 * on CI. Re-validate by hand against that parent if a pin is ever reworked.
 *
 * The one genuinely functional test is §01: the framework's own
 * `Object.prototype.count` extension, which is what made the first
 * implementation of this feature refuse itself on a valid default.
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const FW_DIR = require('../fw');
const REL  = 'lib/logger/src/containers/file/index.js';
const FILE = path.join(FW_DIR, REL);

/** Strip comments so a pin can never be satisfied by prose describing the fix. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let CURRENT = '';

before(function () {
    CURRENT = stripComments(fs.readFileSync(FILE, 'utf8'));
});

describe('01 - Object.prototype.count makes a typeof guard unsafe for config objects', function () {
    it('the framework defines a non-enumerable `count` on Object.prototype', function () {
        require(path.join(FW_DIR, 'helpers/prototypes.js'));
        // Loading the helper is not enough on its own in every context, so assert
        // the property descriptor directly rather than a side effect of it.
        const src = fs.readFileSync(path.join(FW_DIR, 'helpers/prototypes.js'), 'utf8');
        assert.ok(src.indexOf("Object.defineProperty( Object.prototype, 'count'") > -1,
            'helpers/prototypes.js must still define Object.prototype.count — if this moved, ' +
            'the rationale for the hasOwnProperty guard below needs rechecking');
        assert.ok(src.indexOf('enumerable: false') > -1,
            'the extension is non-enumerable, which is why Object.keys() hides it from a probe');
    });

    it('config resolution uses hasOwnProperty, never a typeof guard', function () {
        assert.ok(CURRENT.indexOf('Object.prototype.hasOwnProperty.call') > -1,
            'rotation config must be resolved with an own-property check');
        assert.equal(CURRENT.indexOf("typeof(user.count)"), -1,
            'a typeof guard reads the inherited Object.prototype.count METHOD as the ' +
            'configured value, which coerces to 0 and refuses rotation on a valid default');
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
});

describe('03 - the sink holds one descriptor instead of reopening per line', function () {
    it('uses a persistent append stream', function () {
        assert.ok(CURRENT.indexOf("createWriteStream(entry.filename, { flags: 'a' })") > -1,
            'a rotation that renames needs an owned descriptor to reopen');
    });
    it('no longer calls fs.writeFile per line', function () {
        assert.equal(CURRENT.indexOf('fs.writeFile('), -1,
            'per-line writeFile reopened the file for every record and gave concurrent ' +
            'callbacks no ordering guarantee');
    });
});

describe('04 - the filename is resolved without the argv-derived bundle list', function () {
    it('falls back to the logger group when the argv list is empty', function () {
        assert.ok(CURRENT.indexOf('setup(opt.name, filenames, processProperties)') > -1,
            'core/gna.js splices process.argv to [node, appPath], so the argv-derived ' +
            'bundles[] is always empty in a bundle process and no filename was ever set');
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
