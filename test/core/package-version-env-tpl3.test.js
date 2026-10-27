/**
 * #TPL3 — `page.environment.packageVersion`: the `version` in the project's own `package.json`,
 * read once per project path by `readPackageVersion` (core/controller/controller.js) and set beside
 * `page.environment.project`; not set when the project has none.
 *
 * The reader is a module-level function closing over a module-level cache, so its shipped bytes are
 * sliced out of the source and run under `new Function` with a fresh cache and an `fs` stand-in.
 * The booted read (dev and prod) is test/integration/container-boot-setup-render-tpl3.test.js §04.
 *
 *  01 extraction controls
 *  02 the value: a string version; '' for a missing path, file, field, a non-string version, invalid JSON
 *  03 one read per project path
 *  04 source pins, comment-stripped: the set site
 *
 * Seam: GINA_CONTROLLER_SRC=<file> runs every arm against that text (red-first: the pre-change
 * bytes have no reader, so every arm reads RED).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW                = require('../fw');
var CONTROLLER_SOURCE = process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js');
var CONTROLLER_SRC    = fs.readFileSync(CONTROLLER_SOURCE, 'utf8');

function count(hay, needle) { return hay.split(needle).length - 1; }
function stripComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

/**
 * Slices a function expression by brace-matching from its unique declaration (the started-flag walk).
 *
 * @inner
 * @param {string} text - the source
 * @param {string} decl - the declaration, up to and including `function(...)`
 * @returns {{src: (string|null), depth: number, unique: boolean}}
 */
function extractFn(text, decl) {
    var at = text.indexOf(decl);
    if (at < 0) { return { src: null, depth: -1, unique: false }; }
    var unique = text.indexOf(decl, at + 1) === -1;
    var fnAt = text.indexOf('function', at);
    var depth = 0, started = false, i = fnAt;
    for (; i < text.length; i++) {
        var c = text[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return { src: text.slice(fnAt, i), depth: depth, unique: unique };
}

var FN = extractFn(CONTROLLER_SRC, 'var readPackageVersion = function(projectPath) {');

/**
 * The reader bound to a fresh cache and to `files` (path → text; absent path ⇒ ENOENT).
 *
 * @inner
 * @param {object} files - the package.json texts by absolute path
 * @returns {{read: function, reads: string[]}}
 */
function reader(files) {
    var reads = [];
    var fsStub = {
        readFileSync: function (p) {
            reads.push(p);
            if (!Object.prototype.hasOwnProperty.call(files, p)) {
                var e = new Error('ENOENT: no such file or directory, open \'' + p + '\''); e.code = 'ENOENT'; throw e;
            }
            return files[p];
        }
    };
    var read = new Function('_packageVersionByProject', 'fs', 'return (' + FN.src + ');')({}, fsStub);
    return { read: read, reads: reads };
}


describe('01 - extraction controls', function () {

    it('CONTROL — the reader is declared once and sliced with balanced braces', function () {
        assert.ok(FN.src, 'readPackageVersion must be found in ' + CONTROLLER_SOURCE);
        assert.equal(FN.unique, true);
        assert.equal(FN.depth, 0);
        assert.ok(FN.src.indexOf("+'/package.json'") > -1, 'the slice reaches the file name');
    });
});


describe('02 - the value', function () {

    it('the version in the project\'s package.json', function () {
        var r = reader({ '/srv/proj/package.json': '{ "name": "proj", "version": "3.1.4" }' });
        assert.equal(r.read('/srv/proj'), '3.1.4');
    });

    it('a trailing slash on the project path reads the same file', function () {
        var r = reader({ '/srv/proj/package.json': '{ "version": "3.1.4" }' });
        assert.equal(r.read('/srv/proj/'), '3.1.4');
        assert.deepEqual(r.reads, ['/srv/proj/package.json']);
    });

    it('\'\' when the project has no package.json', function () {
        assert.equal(reader({}).read('/srv/none'), '');
    });

    it('\'\' when the file has no version, or a non-string one', function () {
        var r = reader({ '/a/package.json': '{ "name": "a" }', '/b/package.json': '{ "version": 3 }' });
        assert.equal(r.read('/a'), '');
        assert.equal(r.read('/b'), '');
    });

    it('\'\' when the file is not JSON', function () {
        assert.equal(reader({ '/c/package.json': '{ version: oops' }).read('/c'), '');
    });

    it('\'\' and no read for a missing or non-string project path', function () {
        var r = reader({});
        [undefined, null, '', 42, {}].forEach(function (p) { assert.equal(r.read(p), ''); });
        assert.deepEqual(r.reads, []);
    });
});


describe('03 - one read per project path', function () {

    it('a found version is read once', function () {
        var r = reader({ '/srv/proj/package.json': '{ "version": "1.0.0" }' });
        r.read('/srv/proj'); r.read('/srv/proj'); r.read('/srv/proj');
        assert.equal(r.reads.length, 1);
    });

    it('a missing one is read once too', function () {
        var r = reader({});
        r.read('/srv/none'); r.read('/srv/none');
        assert.equal(r.reads.length, 1);
    });

    it('two projects are read once each', function () {
        var r = reader({ '/p1/package.json': '{ "version": "1.0.0" }', '/p2/package.json': '{ "version": "2.0.0" }' });
        assert.equal(r.read('/p1'), '1.0.0');
        assert.equal(r.read('/p2'), '2.0.0');
        assert.equal(r.read('/p1'), '1.0.0');
        assert.equal(r.reads.length, 2);
    });
});


describe('04 - source pins, comment-stripped', function () {

    var live = stripComments(CONTROLLER_SRC);

    it('the field is set from conf.projectPath, only when the reader returns a version, beside page.environment.project', function () {
        var read = 'var _packageVersion = readPackageVersion(options.conf.projectPath);';
        var set  = "set('page.environment.packageVersion', _packageVersion);";
        assert.equal(count(live, read), 1);
        assert.equal(count(live, set), 1);
        var project = live.indexOf("set('page.environment.project', options.conf.projectName);");
        var at = live.indexOf(read);
        assert.ok(project > -1 && at > project && at - project < 120, 'read right after page.environment.project');
        assert.ok(live.indexOf('if (_packageVersion) {', at) > at, 'set only when a version was found');
    });

    it('the cache is module-level and starts empty', function () {
        assert.equal(count(live, 'var _packageVersionByProject = {};'), 1);
    });
});
