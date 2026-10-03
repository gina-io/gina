/**
 * #P48 — `lib/sri` content tokens for versioned asset URLs (unit, no boot).
 *
 * The resource builder appends `?v=<token>` to every asset URL gina emits, where the token is the
 * first 10 hex characters of the sha384 of the file gina serves for that URL, so a consumer can
 * cache the URL for a year: the URL changes when the bytes do. The token shares the SRI module's
 * stat-validated digest cache (one read per file version), and resolves URLs the way the static
 * server does — exact `statics.json` file mappings, then the longest DIRECTORY mapping (how gina's
 * own `/js/vendor/gina/gina.min.js` is served), then the bundle public directory — while SRI's own
 * exact-match resolution stays as it was (`sri.test.js`).
 *
 * §01  computeVersion: 10 hex = the head of the file's sha384; null when there is no file.
 * §02  computeIntegrity is unchanged by the shared digest (the known vector) — the control.
 * §03  resolveServedFile: exact mapping, longest directory mapping, public fallback, webroot and
 *      query stripping, external URLs refused — and the two keys the server's prefix loop serves
 *      that a slash-only walk misses: a directory key holding a dot (config.js leaves it without a
 *      trailing slash) and a remapped root `/`.
 * §04  getVersionedUrl: `?v=` / `&v=`, fragments kept last, fail-open on anything unresolvable,
 *      an author's own `v=` left alone, the token follows a content change.
 * §05  the 8 MiB version cap: a larger file gets no token (fail-open), SRI is not capped, and a
 *      digest SRI cached for a larger file hands out no token.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const FWV     = require('../fw');   // the framework dir from package.json, never a picked or hardcoded one

const sri = require(path.join(FWV, 'lib', 'sri', 'src', 'main.js'));

const FIXTURE_CONTENT   = 'gina-sri-fixture-v1\n';
const FIXTURE_INTEGRITY = 'sha384-agv0K0aWLDzvDxoOWEsm2s7uAUYBgObriGygDyUIi7eQ/fZ00JWCG74nfkKG5qtv';
const hexHead = (s) => crypto.createHash('sha384').update(s).digest('hex').substring(0, 10);

let tmp = null, conf = null;

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-sri-version-test-'));
    fs.mkdirSync(path.join(tmp, 'public', 'js'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'vendor', 'js'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'vendor-deep', 'x'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'mapped'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'public', 'js', 'fixture.js'), FIXTURE_CONTENT);
    fs.writeFileSync(path.join(tmp, 'vendor', 'js', 'lib.min.js'), 'vendor-lib\n');
    fs.writeFileSync(path.join(tmp, 'vendor-deep', 'x', 'deep.js'), 'deep\n');
    fs.writeFileSync(path.join(tmp, 'mapped', 'other.js'), 'mapped-content\n');
    // §03.7 — a directory served through a key holding a dot; §03.8 — a root remapped away from
    // the public directory, with a DIFFERENT file at the same path under the public directory.
    fs.mkdirSync(path.join(tmp, 'dotted'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'altroot', 'js'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dotted', 'app.js'), 'dotted-app\n');
    fs.writeFileSync(path.join(tmp, 'altroot', 'js', 'root.js'), 'served-from-the-remapped-root\n');
    fs.writeFileSync(path.join(tmp, 'public', 'js', 'root.js'), 'NOT-served-public-copy\n');
    // The runtime shape config.js builds: leading slash, directory keys end with '/', and
    // `staticResources` sorted longest first.
    conf = {
        publicPath      : path.join(tmp, 'public'),
        content         : { statics: {
            '/exact/other.js'      : path.join(tmp, 'mapped', 'other.js'),
            '/js/vendor/'          : path.join(tmp, 'vendor', 'js'),
            '/js/vendor/deep/'     : path.join(tmp, 'vendor-deep'),
            '/'                    : path.join(tmp, 'public')
        } },
        staticResources : ['/js/vendor/deep/', '/exact/other.js', '/js/vendor/', '/']
    };
});

after(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); } });

describe('#P48 §01 — computeVersion: the head of the file\'s sha384', () => {
    it('01.1 10 lowercase hex characters, the first 10 of the sha384 hex digest', () => {
        const v = sri.computeVersion(path.join(tmp, 'public', 'js', 'fixture.js'));
        assert.match(v, /^[0-9a-f]{10}$/);
        assert.strictEqual(v, hexHead(FIXTURE_CONTENT));
    });
    it('01.2 null for a missing file and for a directory (fail-open)', () => {
        assert.strictEqual(sri.computeVersion(path.join(tmp, 'nope.js')), null);
        assert.strictEqual(sri.computeVersion(path.join(tmp, 'public')), null);
    });
});

describe('#P48 §02 — computeIntegrity is unchanged by the shared digest (control)', () => {
    it('02.1 the known sha384 vector, before and after a version lookup of the same file', () => {
        const f = path.join(tmp, 'public', 'js', 'fixture.js');
        assert.strictEqual(sri.computeIntegrity(f), FIXTURE_INTEGRITY);
        sri.computeVersion(f);
        assert.strictEqual(sri.computeIntegrity(f), FIXTURE_INTEGRITY);
    });
});

describe('#P48 §03 — resolveServedFile: the static server\'s resolution order', () => {
    it('03.1 an exact file mapping wins', () => {
        assert.strictEqual(sri.resolveServedFile('/exact/other.js', conf, '/'), path.join(tmp, 'mapped', 'other.js'));
    });
    it('03.2 a directory mapping resolves the rest of the path under its target', () => {
        assert.strictEqual(sri.resolveServedFile('/js/vendor/lib.min.js', conf, '/'), path.join(tmp, 'vendor', 'js') + '/lib.min.js');
    });
    it('03.3 the LONGEST directory mapping wins', () => {
        assert.strictEqual(sri.resolveServedFile('/js/vendor/deep/x/deep.js', conf, '/'), path.join(tmp, 'vendor-deep') + '/x/deep.js');
    });
    it('03.4 anything else falls back to the bundle public directory', () => {
        assert.strictEqual(sri.resolveServedFile('/js/fixture.js', conf, '/'), path.join(tmp, 'public') + '/js/fixture.js');
    });
    it('03.5 the webroot prefix and any query or fragment are stripped first', () => {
        assert.strictEqual(sri.resolveServedFile('/app/js/vendor/lib.min.js?x=1#y', conf, '/app/'), path.join(tmp, 'vendor', 'js') + '/lib.min.js');
    });
    it('03.6 external URLs and a missing configuration resolve to null', () => {
        assert.strictEqual(sri.resolveServedFile('https://cdn.example.com/a.js', conf, '/'), null);
        assert.strictEqual(sri.resolveServedFile('//cdn.example.com/a.js', conf, '/'), null);
        assert.strictEqual(sri.resolveServedFile('/js/fixture.js', null, '/'), null);
        assert.strictEqual(sri.resolveServedFile('/js/fixture.js', {}, '/'), null);
    });
    it('03.7 a directory key holding a dot (no trailing slash) resolves under its target, as the server serves it', () => {
        // config.js adds a trailing slash only to keys WITHOUT a dot, so `v1.2/js` stays
        // `/v1.2/js`; handleStatics' prefix loop still serves `/v1.2/js/app.js` from its target.
        const dconf = {
            publicPath      : path.join(tmp, 'public'),
            content         : { statics: { '/v1.2/js': path.join(tmp, 'dotted'), '/': path.join(tmp, 'public') } },
            staticResources : ['/v1.2/js', '/']
        };
        assert.strictEqual(path.normalize(sri.resolveServedFile('/v1.2/js/app.js', dconf, '/')), path.join(tmp, 'dotted', 'app.js'));
        assert.strictEqual(sri.getVersionedUrl('/v1.2/js/app.js', dconf, '/'), '/v1.2/js/app.js?v=' + hexHead('dotted-app\n'));
    });
    it('03.8 a remapped root `/` resolves under ITS target, never the public directory', () => {
        const rconf = {
            publicPath      : path.join(tmp, 'public'),
            content         : { statics: { '/': path.join(tmp, 'altroot') } },
            staticResources : ['/']
        };
        assert.strictEqual(path.normalize(sri.resolveServedFile('/js/root.js', rconf, '/')), path.join(tmp, 'altroot', 'js', 'root.js'));
        // The token names the served bytes, not the public copy at the same path.
        assert.strictEqual(sri.getVersionedUrl('/js/root.js', rconf, '/'), '/js/root.js?v=' + hexHead('served-from-the-remapped-root\n'));
    });
});

describe('#P48 §04 — getVersionedUrl', () => {
    it('04.1 appends ?v=<token> to a resolvable URL', () => {
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js', conf, '/'), '/js/fixture.js?v=' + hexHead(FIXTURE_CONTENT));
    });
    it('04.2 gina\'s own vendor assets are versioned through their DIRECTORY mapping', () => {
        assert.strictEqual(sri.getVersionedUrl('/js/vendor/lib.min.js', conf, '/'), '/js/vendor/lib.min.js?v=' + hexHead('vendor-lib\n'));
    });
    it('04.3 a webroot-prefixed URL keeps its prefix and gains the token', () => {
        assert.strictEqual(sri.getVersionedUrl('/app/js/fixture.js', conf, '/app/'), '/app/js/fixture.js?v=' + hexHead(FIXTURE_CONTENT));
    });
    it('04.4 &v= when the URL already has a query; a fragment stays last', () => {
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js?a=1', conf, '/'), '/js/fixture.js?a=1&v=' + hexHead(FIXTURE_CONTENT));
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js#top', conf, '/'), '/js/fixture.js?v=' + hexHead(FIXTURE_CONTENT) + '#top');
    });
    it('04.5 fail-open: external, unresolvable and non-string URLs come back unchanged', () => {
        assert.strictEqual(sri.getVersionedUrl('https://cdn.example.com/a.js', conf, '/'), 'https://cdn.example.com/a.js');
        assert.strictEqual(sri.getVersionedUrl('/js/missing.js', conf, '/'), '/js/missing.js');
        assert.strictEqual(sri.getVersionedUrl('', conf, '/'), '');
        assert.strictEqual(sri.getVersionedUrl(null, conf, '/'), null);
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js', null, '/'), '/js/fixture.js');
    });
    it('04.6 a URL the author already versioned (`v=`) is left alone', () => {
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js?v=mine', conf, '/'), '/js/fixture.js?v=mine');
        assert.strictEqual(sri.getVersionedUrl('/js/fixture.js?a=1&v=mine', conf, '/'), '/js/fixture.js?a=1&v=mine');
    });
    it('04.7 the token follows a content change (the stat-validated cache re-reads)', () => {
        const f = path.join(tmp, 'public', 'js', 'moving.js');
        fs.writeFileSync(f, 'first\n');
        const first = sri.getVersionedUrl('/js/moving.js', conf, '/');
        assert.strictEqual(first, '/js/moving.js?v=' + hexHead('first\n'));
        fs.writeFileSync(f, 'second, longer\n');   // size changes, so the cache cannot mistake it
        const second = sri.getVersionedUrl('/js/moving.js', conf, '/');
        assert.strictEqual(second, '/js/moving.js?v=' + hexHead('second, longer\n'));
        assert.notStrictEqual(first, second);
    });
});

describe('#P48 §05 — the 8 MiB version cap (a `?v=` request makes the static server hash the file it serves)', () => {
    const CAP = 8 * 1024 * 1024;
    const sparse = (name, size) => {
        const f = path.join(tmp, 'public', 'js', name);
        fs.writeFileSync(f, '');
        fs.truncateSync(f, size);   // sparse: the size is real, the disk cost is not
        return f;
    };
    it('05.1 a file of exactly 8 MiB gets a token; one byte more gets none (fail-open)', () => {
        const atCap   = sparse('at-cap.bin', CAP);
        const overCap = sparse('over-cap.bin', CAP + 1);
        assert.match(sri.computeVersion(atCap), /^[0-9a-f]{10}$/);
        assert.strictEqual(sri.computeVersion(overCap), null);
        assert.strictEqual(sri.getVersionedUrl('/js/over-cap.bin', conf, '/'), '/js/over-cap.bin');
    });
    it('05.2 the cap is on the token only: SRI still hashes the larger file, and that cached digest hands out no token', () => {
        const overCap = sparse('over-cap-sri.bin', CAP + 1);
        assert.match(sri.computeIntegrity(overCap), /^sha384-[A-Za-z0-9+/]{64}$/);
        assert.strictEqual(sri.computeVersion(overCap), null);
    });
});
