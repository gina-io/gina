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
    'test/bin/cli-home-files-b938.test.js',
    'test/bin/gina-restart-pid-b689.test.js',
    'test/bin/gina-start-held-port-b761.test.js',
    'test/core/config-env-load-error-propagation.test.js',
    'test/core/controller-push-recipient.test.js',
    'test/core/controller-redirect-inheritedData.test.js',
    'test/core/controller-set-dot-split.test.js',
    'test/core/controller-set-path.test.js',
    'test/core/couchbase-connector.test.js',
    'test/core/manifest-bundle-scopes.test.js',
    'test/core/render-json.test.js',
    'test/core/render-stream.test.js',
    'test/core/render-swig-inspector-data-freeze.test.js',
    'test/core/render-swig.test.js',
    'test/core/server-isaac-cache-read-gate.test.js',
    'test/core/validator-autofill-livecheck.test.js',
    'test/core/validator-upload-popin-containment.test.js',
    'test/lib/api-error-field-stack.test.js',
    'test/lib/cmd-help.test.js',
    'test/lib/cmd-man.test.js',
    'test/lib/context-merge-binding.test.js',
    'test/lib/framework-add.test.js',
    'test/lib/framework-init-pids.test.js',
    'test/lib/framework-list.test.js',
    'test/lib/framework-remove.test.js',
    'test/lib/framework-reset.test.js',
    'test/lib/framework-update.test.js',
    'test/lib/helpers-json-block-comments-b568.test.js',
    'test/lib/helpers-json-excerpt-b917.test.js',
    'test/lib/job-render-store-b811.test.js',
    'test/lib/job-request-context.test.js',
    'test/lib/job-urgency.test.js',
    'test/lib/kv-import-boundary.test.js',
    'test/lib/kv-parity.test.js',
    'test/lib/kv-store-redis.test.js',
    'test/lib/lane.test.js',
    'test/lib/logger-container-homedir.test.js',
    'test/lib/logger-file-rotation.test.js',
    'test/lib/merge-m22.test.js',
    'test/lib/model-reload-scope-b624.test.js',
    'test/lib/money.test.js',
    'test/lib/nunjucks-filters.test.js',
    'test/lib/post-install-allow-scripts-env.test.js',
    'test/lib/priority.test.js',
    'test/lib/project-add-gitignore.test.js',
    'test/lib/project-add-link.test.js',
    'test/lib/project-lifecycle.test.js',
    'test/lib/sqlite-driver.test.js',
    'test/lib/storage-import-boundary.test.js',
    'test/lib/swig-filters-nl2br-autoescape.test.js',
    'test/lib/swig-filters.test.js',
    'test/lib/validator-isinteger-number-bounds.test.js',
    'test/lib/validator-m21d.test.js',
    'test/lib/validator-scs1f.test.js',
    'test/lib/validator-scs1g.test.js',
    'test/lib/validator-scs1h.test.js',
    'test/lib/validator-scs1i.test.js'
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
