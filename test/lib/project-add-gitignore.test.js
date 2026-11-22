/**
 * project:add — the project `.gitignore` is finally written (#B258 / #B291).
 *
 * `core/template/_gitignore` shipped in every npm tarball with ZERO consumers:
 * the `_` → `.` rename the underscore prefix implies was never implemented, so
 * scaffolded projects received no `.gitignore` at all. The `.env` / `*.env`
 * globs added to that template were therefore protecting nothing — the
 * security-adjacent half of the defect, and the reason the ignore-glob commit
 * could not close the leak path on its own.
 *
 * The wiring is deliberately SKIP-IF-EXISTS. A project's `.gitignore` is the
 * user's file and routinely carries rules the framework knows nothing about,
 * so the scaffold may fill a gap but must never replace one. §02 is what
 * should stop anyone "simplifying" that into an overwrite.
 *
 * §02 runs the REAL function rather than a re-typed replica: the source slice
 * is compiled with its four free identifiers (`fs`, `_`, `getPath`, `console`)
 * injected as parameters, because a function lifted out of its closure would
 * otherwise throw ReferenceError regardless of whether it is correct. §02's
 * first arm doubles as the harness control — if the injection were wrong, the
 * write case would throw instead of returning true, so a green there means the
 * harness genuinely executed the shipped code.
 *
 * Run standalone:
 *   node --test test/lib/project-add-gitignore.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var os   = require('os');
var path = require('path');

var FW        = require('../fw');
var commentStrip = require('../strip-comments');
var ADD_PATH  = path.join(FW, 'lib/cmd/project/add.js');
var SRC       = fs.readFileSync(ADD_PATH, 'utf8');
var TEMPLATE  = path.join(FW, 'core/template/_gitignore');

// createGitignoreFile slice — declaration to the closing brace of its body.
var cgIdx = SRC.indexOf('var createGitignoreFile = function');
var CG    = (cgIdx > -1) ? SRC.slice(cgIdx, SRC.indexOf('\n    }', cgIdx) + 6) : '';

function stripComments(src) {
    return commentStrip.lines(src);
}

/**
 * Compile the shipped createGitignoreFile with its free identifiers injected.
 * `coreDir` stands in for `getPath('gina').core`.
 */
function build(coreDir, warnings) {
    var factory = new Function('fs', '_', 'getPath', 'console',
        stripComments(CG) + '; return createGitignoreFile;');
    return factory(
        fs,
        function (p) { return { toString: function () { return p; } }; },
        function () { return { core: coreDir }; },
        { warning: function (m) { warnings.push(m); } }
    );
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b258-'));
}


describe('01 - the template finally has a consumer, and it is wired into the scaffold', function () {

    it('createGitignoreFile is declared in project/add.js', function () {
        assert.ok(cgIdx > -1, 'createGitignoreFile must exist in add.js');
        assert.ok(CG.length > 0, 'the source slice must be non-empty');
    });

    it('the shipped template exists and is the source it reads', function () {
        assert.ok(fs.existsSync(TEMPLATE), 'core/template/_gitignore must ship');
        assert.match(stripComments(CG), /template\/_gitignore/);
    });

    it('it is CALLED from the scaffold path, not merely defined', function () {
        var code = stripComments(SRC);
        assert.match(code, /createGitignoreFile\(\s*_\(self\.projectLocation \+ '\/\.gitignore'/,
            'the call site must target <project>/.gitignore');
    });

    it('targets the dotted name — the whole point of the `_` prefix', function () {
        assert.match(stripComments(SRC), /'\/\.gitignore'/);
    });

    it('does NOT reuse createFileFromTemplateSync (it overwrites and chmods 0755)', function () {
        var code = stripComments(CG);
        // Slice control. An EMPTY slice satisfies an absence assertion for
        // entirely the wrong reason, so without this the pin passes on a tree
        // where the function does not exist at all — a pin that cannot fail is
        // not a pin. (Measured: it did exactly that during red-first.)
        assert.match(code, /createGitignoreFile/,
            'slice control: the function source must actually be present');
        assert.doesNotMatch(code, /createFileFromTemplateSync/,
            'that helper unlinks the target first, so it cannot express skip-if-exists');
    });

    it('writes 0644, not an executable 0755', function () {
        var code = stripComments(CG);
        assert.match(code, /chmodSync\([^,]+,\s*0o644\)/);
        assert.doesNotMatch(code, /0755/);
    });
});


describe('02 - behaviour: fills a gap, never replaces one', function () {

    it('writes .gitignore when the project has none (harness control: a throw here means the injection is wrong)', function () {
        var dir  = tmpdir();
        var warn = [];
        var target = path.join(dir, '.gitignore');
        var wrote  = build(path.join(FW, 'core'), warn)(target);

        assert.equal(wrote, true, 'must report that it wrote');
        assert.ok(fs.existsSync(target), 'the file must exist');
        assert.equal(warn.length, 0, 'the ordinary case must not warn');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('the written bytes are the shipped template verbatim', function () {
        var dir = tmpdir();
        var target = path.join(dir, '.gitignore');
        build(path.join(FW, 'core'), [])(target);

        assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(TEMPLATE, 'utf8'));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('SKIPS when a .gitignore already exists, leaving it byte-for-byte intact', function () {
        var dir  = tmpdir();
        var target = path.join(dir, '.gitignore');
        var mine   = '# my rules\nsecret-local/\n';
        fs.writeFileSync(target, mine);

        var wrote = build(path.join(FW, 'core'), [])(target);

        assert.equal(wrote, false, 'must report that it skipped');
        assert.equal(fs.readFileSync(target, 'utf8'), mine,
            'the user\'s .gitignore must never be replaced or appended to');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is idempotent — a second scaffold over the same project is a no-op', function () {
        var dir = tmpdir();
        var target = path.join(dir, '.gitignore');
        var fn = build(path.join(FW, 'core'), []);

        assert.equal(fn(target), true,  'first call writes');
        var after = fs.readFileSync(target, 'utf8');
        assert.equal(fn(target), false, 'second call skips');
        assert.equal(fs.readFileSync(target, 'utf8'), after, 'content unchanged');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('never throws when the template is missing — a scaffold must not die over an ignore file', function () {
        var dir  = tmpdir();
        var warn = [];
        var target = path.join(dir, '.gitignore');
        var wrote;

        assert.doesNotThrow(function () {
            wrote = build(path.join(dir, 'no-such-core'), warn)(target);
        });
        assert.equal(wrote, false);
        assert.equal(fs.existsSync(target), false, 'nothing should have been written');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});


describe('03 - the globs it delivers are the ones the leak path needed', function () {

    var tpl = fs.readFileSync(TEMPLATE, 'utf8');

    it('carries the secret-file globs, not just a bare `.env`', function () {
        assert.match(tpl, /^\.env$/m,   'the dot-name');
        assert.match(tpl, /^\.env\.\*$/m, 'dotted variants like .env.production');
        assert.match(tpl, /^\*\.env$/m, 'non-dot names like secrets.env — the one a catch-all misses');
    });

    it('keeps the example negations, so a committed sample stays possible', function () {
        assert.match(tpl, /^!\.env\.example$/m);
        assert.match(tpl, /^!\*\.example\.env$/m);
    });

    it('CONTROL: an unrelated pattern is absent, so the matches above discriminate', function () {
        assert.doesNotMatch(tpl, /^zzz-not-a-real-glob$/m);
    });
});
