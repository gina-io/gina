'use strict';
/**
 * #B1157 guard — a source-pin test strips comments with `test/strip-comments.js`, never with a
 * block regex run before anything else.
 *
 * Such a regex opens a phantom block at any `/*` outside a real comment (inside a `//` comment, a
 * string, a regex or a template) and deletes live code up to the next real comment end, so a
 * negative pin can pass whatever the code holds. The files in ALLOW predate the shared helper and
 * migrate in batches; a migrated file leaves the list. A new test file with such a strip fails
 * here, and so does a listed file that no longer has one.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var ROOT = path.join(__dirname, '..', '..');

// `.replace(`, optional spaces, then the block-comment regex literal itself (no flags on DETECT, so
// `.test()` keeps no state between files).
var DETECT = /\.replace\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\/\/g/;

// The test files that had such a strip on 2026-11-21 (develop c6ae36900); remove each one as it
// migrates to the shared helper.
var ALLOW = [
    'test/core/validator-autofill-livecheck.test.js'
];

/**
 * Lists the `*.test.js` files under `test/` and the framework's own `test/`, as paths relative to
 * the repository root with `/` separators; symlinks, `node_modules` and dot directories skipped.
 *
 * @inner
 * @returns {string[]}
 */
function testFiles() {
    var out = [];
    var walk = function (dir) {
        if ( !fs.existsSync(dir) ) { return; }
        fs.readdirSync(dir).forEach(function (name) {
            var p = path.join(dir, name);
            var st = fs.lstatSync(p);
            if ( st.isSymbolicLink() || name === 'node_modules' || name.charAt(0) === '.' ) { return; }
            if ( st.isDirectory() ) { walk(p); return; }
            if ( /\.test\.js$/.test(name) ) { out.push(path.relative(ROOT, p).split(path.sep).join('/')); }
        });
    };
    walk(path.join(ROOT, 'test'));
    walk(path.join(FW, 'test'));
    return out;
}

describe('#B1157 guard — no new block-regex comment strip in a test file', function () {

    var files = testFiles();
    var hits = files.filter(function (f) { return DETECT.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); });

    it('01 control: the scan sees the test tree and the detector fires on the listed files', function () {
        assert.ok(files.length > 500, 'test files scanned: ' + files.length);
        assert.ok(hits.length > 0, 'the detector fires');
    });

    it('02 every test file with such a strip is listed (a new test uses test/strip-comments.js)', function () {
        var extra = hits.filter(function (f) { return ALLOW.indexOf(f) < 0; });
        assert.deepEqual(extra, [], "use require('../strip-comments') instead: " + extra.join(', '));
    });

    it('03 every listed file still has one (drop a migrated file from ALLOW)', function () {
        var gone = ALLOW.filter(function (f) { return hits.indexOf(f) < 0; });
        assert.deepEqual(gone, [], 'migrated or removed, drop from ALLOW: ' + gone.join(', '));
    });
});
