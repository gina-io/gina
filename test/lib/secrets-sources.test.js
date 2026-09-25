/**
 * Tests for the shared config-source walk:
 *   lib/secrets/src/sources.js                    — the walk (factory form)
 *   lib/secrets/src/main.js                       — its instantiation + re-export
 *
 * Split by coverage shape, deliberately:
 *   §01     — export surface + main.js wiring (behavioural + source pins)
 *   §02     — structural pins on sources.js. These are the walk pins that
 *             used to live in secrets-scan.test.js §03/§09 as per-handler
 *             assertions (scan.js AND check.js each carried a copy of the
 *             walk); the walk now has ONE home, so its structural pins do
 *             too. secrets-scan.test.js keeps the HANDLER-side pins
 *             (delegation to lib.secrets + no local walk).
 *   §03-§07 — behavioural arms driving the REAL composition over on-disk
 *             fixture projects. The walk previously had zero real-bytes
 *             behavioural coverage (the handlers need the CLI daemon
 *             context, so their suite pins source text); the extraction is
 *             what makes these arms possible.
 *
 * Fixture discipline: `requireJSON` caches by absolute path, so a fixture
 * file is written ONCE (in `before`) and never rewritten — an arm needing
 * different content uses a different file path. The fixture tree lives in
 * a fresh `mkdtemp` per run, so no cache staleness crosses runs.
 *
 * Globals: the walk resolves `_()` and `requireJSON` at call time (the
 * framework's injected global context). This file installs the REAL ones
 * by requiring the framework `helpers/` tree — shims would test shims, and
 * `requireJSON`'s comment tolerance is load-bearing walk semantics (§03
 * proves it through a commented fixture). Requiring helpers boots the
 * logger, whose MQ speaker may print one connection warn — harmless here.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert');
var fs     = require('node:fs');
var os     = require('node:os');
var path   = require('node:path');

var FRAMEWORK_ROOT = path.join(__dirname, '..', '..', 'framework');
var frameworkDir = fs.readdirSync(FRAMEWORK_ROOT).filter(function (d) {
    return /^v\d/.test(d) && fs.existsSync(path.join(FRAMEWORK_ROOT, d, 'lib/secrets/src/sources.js'));
}).sort().pop();
var FW  = path.join(FRAMEWORK_ROOT, frameworkDir);
var LIB = path.join(FW, 'lib/secrets/src');

// Install the real framework global context (`_`, `requireJSON`, JSON.clone).
require(path.join(FW, 'helpers'));

var secrets     = require(path.join(LIB, 'main.js'));
var MAIN_SRC    = fs.readFileSync(path.join(LIB, 'main.js'), 'utf8');
var SOURCES_SRC = fs.readFileSync(path.join(LIB, 'sources.js'), 'utf8');

/**
 * Strips line comments and block-comment lines so negative pins read code
 * only — the walk's own JSDoc legitimately names the constructs the
 * negatives forbid (the own-JSDoc pin trap).
 */
function codeOnly(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).map(function (l) {
        return l.replace(/\/\/.*$/, '');
    }).join('\n');
}

// ---------------------------------------------------------------------------
// 01 — export surface + main.js wiring
// ---------------------------------------------------------------------------

describe('01 - export surface and wiring', function () {

    it('lib/secrets exposes the walk and its leaf readers as functions', function () {
        assert.equal(typeof secrets.getProjectRequiredKeys, 'function');
        assert.equal(typeof secrets.loadManifest, 'function');
        assert.equal(typeof secrets.readJsonSafe, 'function');
        assert.equal(typeof secrets.resolveBundleSrc, 'function');
    });

    it('main.js instantiates the sources factory over its own getRequiredKeys + getMalformedReferences (no load cycle)', function () {
        // Realigned 2026-09-22 (operator-approved, #B583): the factory takes the
        // malformed-reference enumerator as a second primitive, so the CLI walk
        // reports what boot refuses without requiring ./main back.
        assert.match(MAIN_SRC, /var\s+sources\s*=\s*require\(\s*['"]\.\/sources['"]\s*\)\(\s*getRequiredKeys\s*,\s*getMalformedReferences\s*\)/);
    });

    it('main.js re-exports the four walk members from the sources instance', function () {
        assert.match(MAIN_SRC, /getProjectRequiredKeys:\s*sources\.getProjectRequiredKeys/);
        assert.match(MAIN_SRC, /loadManifest:\s*sources\.loadManifest/);
        assert.match(MAIN_SRC, /readJsonSafe:\s*sources\.readJsonSafe/);
        assert.match(MAIN_SRC, /resolveBundleSrc:\s*sources\.resolveBundleSrc/);
    });

    it('sources.js never requires ./main back and never touches the lib registry (code view)', function () {
        var code = codeOnly(SOURCES_SRC);
        // anti-vacuity: the stripped view still holds the module's real code
        assert.ok(code.indexOf('sourcesFactory') > -1, 'stripping emptied the corpus - the negatives below would pass vacuously');
        assert.equal(/require\(\s*['"]\.\/main['"]/.test(code), false, 'sources.js must not require ./main (load cycle)');
        assert.equal(/\blib\.(secrets|merge)\b/.test(code), false, 'sources.js must not read the lib registry');
    });

    it('module load stays free of the call-time globals (bare require needs no setup)', function () {
        // The two ambient globals are CALL-time only: they must appear inside
        // function bodies, never at module top level. Structural proxy: every
        // `requireJSON(` / `_(` occurrence in the code view sits after the
        // factory declaration line.
        var code       = codeOnly(SOURCES_SRC);
        var factoryIdx = code.indexOf('module.exports = function sourcesFactory');
        assert.ok(factoryIdx > -1);
        assert.ok(code.indexOf('requireJSON(') > factoryIdx, 'requireJSON is referenced before the factory body');
    });
});

// ---------------------------------------------------------------------------
// 02 — structural pins on the walk (single home; formerly per-handler in
//      secrets-scan.test.js §03/§09)
// ---------------------------------------------------------------------------

describe('02 - walk structure pins (sources.js)', function () {

    it('sources.js is a factory over the two enumeration primitives (keys + malformed references)', function () {
        // Realigned 2026-09-22 (operator-approved, #B583): the declaration form
        // of the same structural change the §01 call-site pin covers.
        assert.match(SOURCES_SRC, /module\.exports\s*=\s*function\s+sourcesFactory\s*\(\s*getRequiredKeys\s*,\s*getMalformedReferences\s*\)/);
    });

    it('sources.js requires lib/merge relatively (server-side only; installs JSON.clone)', function () {
        assert.match(SOURCES_SRC, /var\s+merge\s*=\s*require\(\s*['"]\.\.\/\.\.\/merge['"]\s*\)/);
    });

    it('resolves the bundle dir from manifest.bundles[name].src (openapi precedent)', function () {
        assert.match(SOURCES_SRC, /manifest\.bundles\[bundleName\]\.src/);
        assert.match(SOURCES_SRC, /return\s+manifest\.bundles\[bundleName\]\.src;/);
    });

    it('falls back to the bundle name when src is absent', function () {
        assert.match(SOURCES_SRC, /return\s+bundleName;/);
    });

    it('declares JSON_EXT = /\\.json$/', function () {
        assert.match(SOURCES_SRC, /var\s+JSON_EXT\s*=\s*\/\\\.json\$\//);
    });

    it('skips dotfiles and "* copy" siblings (matching loadBundleConfig)', function () {
        assert.match(SOURCES_SRC, /\/\^\\\.\/\.test\(name\)/);    // /^\./.test(name)
        assert.match(SOURCES_SRC, /\/\\s\+copy\/i\.test\(name\)/); // /\s+copy/i.test(name)
    });

    it('walks the project-level shared/config dir', function () {
        assert.match(SOURCES_SRC, /\/shared\/config/);
    });

    it('reads JSON via requireJSON (comment-tolerant), never plain require', function () {
        assert.match(SOURCES_SRC, /return\s+requireJSON\(filePath\)/);
        assert.equal(/require\(\s*filePath\s*\)/.test(SOURCES_SRC), false);
    });

    it('enumerates keys via the injected getRequiredKeys (on the effective merged config)', function () {
        assert.match(SOURCES_SRC, /getRequiredKeys\(effective\)/);
    });

    it('derives the config_<scope> sibling from absDir + "_" + scope (parameterised, not closure state)', function () {
        assert.match(SOURCES_SRC, /absDir\s*\+\s*['"]_['"]\s*\+\s*scopeName/);
        // the walk takes scope as an argument now — the CLI's self.scopeName
        // stays in the handlers, which pass it through the options object.
        assert.equal(/self\.scopeName/.test(SOURCES_SRC), false);
    });

    it('deep-merges scope over base via merge(JSON.clone(scopeContent), ..., false) (explicit override)', function () {
        assert.match(SOURCES_SRC, /merge\(\s*JSON\.clone\(scopeContent\)[^)]*,\s*false\s*\)/);
    });
});

// ---------------------------------------------------------------------------
// 03..07 — behavioural arms over an on-disk fixture project
// ---------------------------------------------------------------------------

var T;       // fixture project root
var T_BARE;  // manifest-less project root

function writeFixtureTree() {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-secsources-'));
    ['shared/config', 'shared/config_production', 'src/demo/config', 'src/demo/config_production', 'zz/config'].forEach(function (d) {
        fs.mkdirSync(path.join(T, d), { recursive: true });
    });
    fs.writeFileSync(path.join(T, 'manifest.json'), JSON.stringify({
        bundles: { demo: { src: 'src/demo' }, zz: {} }
    }));
    // comment line: proves the walk reads through requireJSON (plain JSON.parse would throw)
    fs.writeFileSync(path.join(T, 'shared/config/app.json'),
        '{\n// comment the reader must tolerate\n"db": { "password": "${secret:SHARED_KEY}" },\n"both": "${secret:BOTH_KEY}"\n}');
    // scope overlay: adds PROD_KEY, overrides db.password with a plain value
    // (so SHARED_KEY must VANISH from the production-effective set), and
    // re-authors BOTH_KEY (so its label must flip to the scope file).
    fs.writeFileSync(path.join(T, 'shared/config_production/app.json'),
        '{ "prod": "${secret:PROD_KEY}", "db": { "password": "plain-in-prod" }, "both": "${secret:BOTH_KEY}" }');
    fs.writeFileSync(path.join(T, 'src/demo/config/settings.json'),
        '{ "token": "${secret:APP_KEY}", "mixed": "https://${secret:NOT_BARE}/x" }');
    // second file requiring an already-seen key: provenance must accumulate both labels
    fs.writeFileSync(path.join(T, 'src/demo/config/connectors.json'),
        '{ "cred": "${secret:APP_KEY}" }');
    // #B583 — a MALFORMED whole-value reference (lowercase key): the walk must
    // list it with its file, never as a required key. No valid key in this
    // file, so every key / provenance assertion above stays untouched.
    fs.writeFileSync(path.join(T, 'src/demo/config/broken.json'),
        '{ "db": { "password": "${secret:db_password}" }, "fine": "literal" }');
    // scope-only file carrying one (a VALID key padded with whitespace):
    // attributed to the scope layer, and only visible to the scoped walk.
    fs.writeFileSync(path.join(T, 'shared/config_production/bad.json'),
        '{ "token": "${secret:PROD_TOKEN} " }');
    // skipped by the walk, present on disk (the can-fire controls read them raw)
    fs.writeFileSync(path.join(T, 'shared/config/.ghost.json'), '{ "g": "${secret:GHOST_KEY}" }');
    fs.writeFileSync(path.join(T, 'shared/config/app copy.json'), '{ "c": "${secret:COPYCAT_KEY}" }');
    fs.writeFileSync(path.join(T, 'shared/config/notes.txt'), '${secret:TEXTFILE_KEY}');

    T_BARE = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-secsources-bare-'));
    fs.mkdirSync(path.join(T_BARE, 'lone/config'), { recursive: true });
    fs.writeFileSync(path.join(T_BARE, 'lone/config/a.json'), '{ "k": "${secret:LONE_KEY}" }');
}

// file-level fixture lifecycle: §03..§07 all read the same tree
before(function () { writeFixtureTree(); });
after(function () {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    try { fs.rmSync(T_BARE, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('03 - the walk, no scope', function () {
    var r;
    before(function () { r = secrets.getProjectRequiredKeys(T, {}); });

    it('walks every manifest bundle, sorted by name', function () {
        assert.ok(r);
        assert.deepEqual(r.bundles.map(function (b) { return b.bundle; }), ['demo', 'zz']);
    });

    it('reads through requireJSON: a commented config file still contributes its keys', function () {
        assert.ok(r.bundles[0].byKey.SHARED_KEY, 'the commented shared file was not read');
    });

    it('folds shared/config keys into EVERY bundle', function () {
        assert.ok(r.bundles[0].byKey.SHARED_KEY);
        assert.ok(r.bundles[1].byKey.SHARED_KEY, 'shared keys missing from the second bundle');
    });

    it('labels each key with its project-relative source file', function () {
        assert.deepEqual(r.bundles[0].byKey.SHARED_KEY, ['shared/config/app.json']);
    });

    it('accumulates provenance across files (de-duplicated, insertion-ordered)', function () {
        assert.deepEqual(r.bundles[0].byKey.APP_KEY,
            ['src/demo/config/connectors.json', 'src/demo/config/settings.json']);
    });

    it('keeps byKey null-proto with shared keys first, then the bundle own keys', function () {
        assert.equal(Object.getPrototypeOf(r.bundles[0].byKey), null);
        assert.deepEqual(Object.keys(r.bundles[0].byKey), ['BOTH_KEY', 'SHARED_KEY', 'APP_KEY']);
    });

    it('excludes mixed-content strings (bare-placeholder rule), with the fixture carrying one', function () {
        // can-fire control: the literal IS on disk...
        assert.ok(fs.readFileSync(path.join(T, 'src/demo/config/settings.json'), 'utf8').indexOf('NOT_BARE') > -1);
        // ...and the walk correctly refuses it (mixed string, not a bare placeholder)
        assert.equal(r.bundles[0].byKey.NOT_BARE, undefined);
    });

    it('skips dotfiles, "* copy" siblings and non-JSON files, each carried by the fixture', function () {
        // can-fire controls: every skipped file really holds a would-be key
        assert.ok(fs.readFileSync(path.join(T, 'shared/config/.ghost.json'), 'utf8').indexOf('GHOST_KEY') > -1);
        assert.ok(fs.readFileSync(path.join(T, 'shared/config/app copy.json'), 'utf8').indexOf('COPYCAT_KEY') > -1);
        assert.ok(fs.readFileSync(path.join(T, 'shared/config/notes.txt'), 'utf8').indexOf('TEXTFILE_KEY') > -1);
        ['GHOST_KEY', 'COPYCAT_KEY', 'TEXTFILE_KEY'].forEach(function (k) {
            assert.equal(r.bundles[0].byKey[k], undefined, k + ' leaked through a skip rule');
            assert.equal(r.bundles[1].byKey[k], undefined, k + ' leaked through a skip rule');
        });
    });
});

describe('04 - the scope overlay', function () {
    var r;
    before(function () { r = secrets.getProjectRequiredKeys(T, { scope: 'production' }); });

    it('adds scope-only keys, labelled with the scope dir', function () {
        assert.deepEqual(r.bundles[0].byKey.PROD_KEY, ['shared/config_production/app.json']);
    });

    it('scope WINS on collisions: a path the scope overrides with a plain value loses its base key', function () {
        assert.equal(r.bundles[0].byKey.SHARED_KEY, undefined,
            'db.password is plain in the production overlay - SHARED_KEY must not survive the merge');
    });

    it('attributes a key authored in BOTH layers to the scope file (the layer that provides it)', function () {
        assert.deepEqual(r.bundles[0].byKey.BOTH_KEY, ['shared/config_production/app.json']);
    });

    it('base keys the scope does not touch survive (base back-fills)', function () {
        assert.deepEqual(r.bundles[0].byKey.APP_KEY,
            ['src/demo/config/connectors.json', 'src/demo/config/settings.json']);
    });

    it('is idempotent: the cached scope content is cloned, never mutated by the merge', function () {
        var again = secrets.getProjectRequiredKeys(T, { scope: 'production' });
        assert.deepEqual(again, r, 'a second walk diverged - the overlay mutated requireJSON-cached content');
    });
});

describe('05 - the bundle filter', function () {

    it('restricts the walk to the named bundle', function () {
        var r = secrets.getProjectRequiredKeys(T, { bundle: 'demo' });
        assert.equal(r.bundles.length, 1);
        assert.equal(r.bundles[0].bundle, 'demo');
    });

    it('is honoured VERBATIM: a name outside the manifest still walks (src falls back, shared folds in)', function () {
        var r = secrets.getProjectRequiredKeys(T, { bundle: 'unlisted' });
        assert.equal(r.bundles.length, 1);
        assert.equal(r.bundles[0].bundle, 'unlisted');
        assert.ok(r.bundles[0].byKey.SHARED_KEY, 'shared keys must fold into a fallback-src bundle too');
    });

    it('walks a manifest-less project when the bundle names the dir (the historical CLI shape)', function () {
        var r = secrets.getProjectRequiredKeys(T_BARE, { bundle: 'lone' });
        assert.ok(r);
        assert.deepEqual(r.bundles[0].byKey.LONE_KEY, ['lone/config/a.json']);
    });
});

describe('06 - null semantics (non-throwing family)', function () {

    it('returns null for a non-string or empty projectPath', function () {
        assert.equal(secrets.getProjectRequiredKeys('', {}), null);
        assert.equal(secrets.getProjectRequiredKeys(null, {}), null);
        assert.equal(secrets.getProjectRequiredKeys(42, {}), null);
    });

    it('returns null for a missing manifest when no bundle filter names the walk', function () {
        assert.equal(secrets.getProjectRequiredKeys(T_BARE, {}), null);
    });

    it('tolerates a missing options object', function () {
        var r = secrets.getProjectRequiredKeys(T);
        assert.ok(r && r.bundles.length === 2);
    });
});

describe('07 - the leaf readers', function () {

    it('loadManifest returns the parsed manifest, and null when absent', function () {
        var m = secrets.loadManifest(T);
        assert.ok(m && m.bundles && m.bundles.demo);
        assert.equal(secrets.loadManifest(T_BARE), null);
    });

    it('readJsonSafe is comment-tolerant, and null for an absent file', function () {
        var o = secrets.readJsonSafe(path.join(T, 'shared/config/app.json'));
        assert.ok(o && o.db, 'the commented fixture did not parse');
        assert.equal(secrets.readJsonSafe(path.join(T, 'nope.json')), null);
        // NOT driven here: a present-but-unparsable file. requireJSON's own
        // contract makes that path emerg-log + process.exit(1) whenever
        // console.emerg exists (helpers/json), which this file's helpers
        // require installs — driving it would kill the test child, and the
        // behaviour belongs to requireJSON, not to the walk.
    });

    it('resolveBundleSrc reads manifest src and falls back to the bundle name', function () {
        var m = secrets.loadManifest(T);
        assert.equal(secrets.resolveBundleSrc(m, 'demo'), 'src/demo');
        assert.equal(secrets.resolveBundleSrc(m, 'zz'), 'zz');
        assert.equal(secrets.resolveBundleSrc(null, 'demo'), 'demo');
    });
});

// ---------------------------------------------------------------------------
// 08 — #B583: malformed references ride the walk beside the keys
// ---------------------------------------------------------------------------

describe('08 - #B583 malformed references ride the walk beside the keys', function () {

    var BROKEN = { file: 'src/demo/config/broken.json', path: 'db.password', ref: '${secret:db_password}' };
    var SCOPED = { file: 'shared/config_production/bad.json', path: 'token', ref: '${secret:PROD_TOKEN} ' };

    it('every bundle entry carries a `malformed` list — empty for a clean bundle', function () {
        var r = secrets.getProjectRequiredKeys(T, {});
        assert.deepEqual(r.bundles[1].malformed, []);          // zz: clean
    });

    it('lists a malformed whole-value reference with its file + path + text, and NOT as a key', function () {
        // can-fire control: the literal IS on disk
        assert.ok(fs.readFileSync(path.join(T, 'src/demo/config/broken.json'), 'utf8').indexOf('db_password') > -1);
        var r = secrets.getProjectRequiredKeys(T, {});
        assert.deepEqual(r.bundles[0].malformed, [BROKEN]);
        assert.equal(r.bundles[0].byKey.db_password, undefined, 'a malformed reference is not a required key');
        assert.deepEqual(Object.keys(r.bundles[0].byKey), ['BOTH_KEY', 'SHARED_KEY', 'APP_KEY'], 'the key roster is untouched');
    });

    it('a scope-only file carrying one is attributed to the scope layer and folds into EVERY bundle (shared first)', function () {
        var r = secrets.getProjectRequiredKeys(T, { scope: 'production' });
        assert.deepEqual(r.bundles[0].malformed, [SCOPED, BROKEN]);
        assert.deepEqual(r.bundles[1].malformed, [SCOPED], 'shared entries fold into the second bundle too');
        assert.equal(r.bundles[0].byKey.PROD_TOKEN, undefined, 'a padded VALID key is still not a key');
    });

    it('the unscoped walk does not see the scope-only file (control for the arm above)', function () {
        var r = secrets.getProjectRequiredKeys(T, {});
        assert.deepEqual(r.bundles[1].malformed, []);
    });

    it('the bundle filter carries the list too, and repeated walks do not accumulate', function () {
        var first  = secrets.getProjectRequiredKeys(T, { bundle: 'demo' });
        var second = secrets.getProjectRequiredKeys(T, { bundle: 'demo' });
        assert.deepEqual(first.bundles[0].malformed, [BROKEN]);
        assert.deepEqual(second.bundles[0].malformed, [BROKEN]);
    });
});
