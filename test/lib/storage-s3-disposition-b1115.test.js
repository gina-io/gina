'use strict';
/**
 * #B1115 — the `s3` adapter's offload `Content-Disposition`.
 *
 * `self.serveFromStorage()` on an offload-capable driver answers a 307 to a presigned URL, and the
 * `s3` adapter signs the attachment name as the `response-content-disposition` override, which the
 * provider copies into its response header. Up to 0.7.10 the adapter's `formatDisposition`
 * (lib/storage/src/s3.js) wrote the name raw in `filename="…"`. Measured 2026-11-11 with signed
 * GETs: MinIO sent the UTF-8 bytes back unchanged; AWS S3 re-encoded a Latin-1 name as ISO-8859-1,
 * which Chromium 156 and WebKit 27.2 save with U+FFFD in place of each such letter (#B1113), and
 * refused every name with a character above U+00FF with `400 InvalidArgument` (« Header value
 * cannot be represented using ISO-8859-1 »), so the download failed after gina's 307.
 *
 * The fix: after its control strip, the adapter builds the value the in-process path builds
 * (`formatAttachmentDisposition` in core/controller/controller.js, #B1113): a name of printable
 * ASCII keeps the plain quoted-string; any other name gets an all-ASCII `filename` fallback, then
 * `filename*=UTF-8''<percent-encoded>`. lib/storage may not import gina core
 * (test/lib/storage-import-boundary.test.js), so the adapter holds a lib-local twin: this file pins
 * the twin to controller.js's builder, and the offload value to the in-process header.
 *
 * Red-first: run against a tree whose s3.js predates the fix. The 7 tests whose names start with
 * CONTROL pass there too; the other 10 fail.
 *
 * Suites:
 *  01 — resolve(): the signed value, for printable-ASCII names and for names outside ASCII
 *  02 — the twin: resolve()'s value equals controller.js's builder on the name, controls stripped
 *  03 — serveFromStorage(): the offload 307 signs the header the in-process path sends
 */
var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var nodePath = require('node:path');
var Readable = require('node:stream').Readable;

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');

var CONTROLLER_SRC = nodePath.join(FW, 'core/controller/controller.js');
var SRC = fs.readFileSync(CONTROLLER_SRC, 'utf8');

// ─── bootstrap (controller.js needs the framework globals to load) ───────────
process.env.NODE_PATH = (process.env.NODE_PATH || '') + nodePath.delimiter + FW;
require('node:module').Module._initPaths();
require(nodePath.join(FW, 'helpers'));
require(nodePath.join(ROOT, 'utils', 'prototypes'));
setPath('gina', { core: nodePath.join(FW, 'core') });

var storageLib      = require(nodePath.join(FW, 'lib', 'storage'));
var SuperController = require(CONTROLLER_SRC);

// started-flag brace walker (the house extraction shape): formatAttachmentDisposition carries no
// brace inside a string, a regex literal or a comment
function extractFunction(src, decl) {
    var declIdx = src.indexOf(decl);
    if (declIdx === -1) { throw new Error('declaration `' + decl + '` not found'); }
    if (src.indexOf(decl, declIdx + 1) !== -1) { throw new Error('declaration `' + decl + '` is not unique'); }
    var i = declIdx, depth = 0, started = false;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    if (!started || depth !== 0) { throw new Error('brace walk did not terminate balanced'); }
    return src.slice(declIdx, i);
}

// the in-process builder (#B1113), real bytes from controller.js
var FORMAT_SRC = extractFunction(SRC, 'function formatAttachmentDisposition(');
var format = new Function('return (' + FORMAT_SRC + ');')();

// what the facade and the adapter both strip before building the value
function stripControls(name) {
    return String(name).replace(/[\x00-\x1f\x7f]/g, '');
}

// the property AWS needs: a header value it can write as ISO-8859-1, and one browsers read the
// same whatever charset they assume
function printableAscii(value) {
    return /^[\x20-\x7e]*$/.test(value);
}

// ─── fake SDK (the serve-from-storage-offload.test.js shape) ─────────────────

var objects  = {};   // providerKey -> { body, contentType, metadata, lastModified }
var presigns = [];

function sdkErr(nm, status) {
    var e = new Error(nm);
    e.name = nm;
    e.$metadata = { httpStatusCode: status };
    return e;
}
function cmdClass(nm) {
    var C = function(input) { this.input = input; };
    Object.defineProperty(C, 'name', { value: nm });
    return C;
}
var HeadObjectCommand           = cmdClass('HeadObjectCommand');
var GetObjectCommand            = cmdClass('GetObjectCommand');
var ListMultipartUploadsCommand = cmdClass('ListMultipartUploadsCommand');

function S3Client() {}
S3Client.prototype.destroy = function() {};
S3Client.prototype.send = function(cmd) {
    if ( cmd instanceof HeadObjectCommand ) {
        var oH = objects[cmd.input.Key];
        if ( !oH ) { return Promise.reject(sdkErr('NotFound', 404)); }
        return Promise.resolve({
            ContentLength : oH.body.length,
            ContentType   : oH.contentType || undefined,
            LastModified  : oH.lastModified,
            Metadata      : oH.metadata || {}
        });
    }
    if ( cmd instanceof GetObjectCommand ) {
        var oG = objects[cmd.input.Key];
        if ( !oG ) { return Promise.reject(sdkErr('NoSuchKey', 404)); }
        return Promise.resolve({ Body: Readable.from([oG.body]) });
    }
    if ( cmd instanceof ListMultipartUploadsCommand ) {
        return Promise.resolve({ Uploads: [] });
    }
    throw new Error('fake SDK: unimplemented command ' + (cmd && cmd.constructor && cmd.constructor.name));
};

function Upload(opts) { this._params = opts.params; }
Upload.prototype.done = function() {
    var p = this._params;
    return new Promise(function(resolveP, rejectP) {
        var chunks = [];
        p.Body.on('data', function(c) { chunks.push(c); });
        p.Body.on('error', rejectP);
        p.Body.on('end', function() {
            objects[p.Key] = { body: Buffer.concat(chunks), contentType: p.ContentType || null, metadata: p.Metadata || {}, lastModified: new Date(1700000000000) };
            resolveP({});
        });
    });
};
Upload.prototype.abort = function() { return Promise.resolve(); };

var PACKAGES = {
    '@aws-sdk/client-s3' : {
        S3Client                    : S3Client,
        HeadObjectCommand           : HeadObjectCommand,
        GetObjectCommand            : GetObjectCommand,
        ListMultipartUploadsCommand : ListMultipartUploadsCommand,
        DeleteObjectCommand         : cmdClass('DeleteObjectCommand'),
        ListObjectsV2Command        : cmdClass('ListObjectsV2Command'),
        AbortMultipartUploadCommand : cmdClass('AbortMultipartUploadCommand')
    },
    '@aws-sdk/lib-storage' : { Upload: Upload },
    '@aws-sdk/s3-request-presigner' : {
        // records the signed input; the URL is not encoded, so a raw value reaches the assertions
        getSignedUrl: function(client, cmd, opts) {
            presigns.push({ input: cmd.input, expiresIn: opts.expiresIn });
            return Promise.resolve('https://signed.test/' + cmd.input.Bucket + '/' + cmd.input.Key + '?sig=test');
        }
    }
};

// ─── helpers ─────────────────────────────────────────────────────────────────

var KEYS = {};   // stored name id -> opaque key, seeded through the real put()

/**
 * The `response-content-disposition` value one `resolve()` call signs.
 *
 * @inner
 * @param {object} opts - resolve() options.
 * @returns {Promise<string>} The signed `ResponseContentDisposition`.
 */
function signed(opts) {
    return new Promise(function(resolveP, rejectP) {
        var at = presigns.length;
        storageLib.get('remote').resolve(KEYS.ascii, opts, function(err) {
            if (err) { return rejectP(err); }
            if (presigns.length !== at + 1) { return rejectP(new Error('expected one presign, got ' + (presigns.length - at))); }
            resolveP(presigns[at].input.ResponseContentDisposition);
        });
    });
}

/**
 * Drive the real facade against a mock response (the serve-from-storage-offload.test.js shape);
 * settles on end() or throwError.
 *
 * @inner
 * @param {object} spec - `{driver, key, opts}`.
 * @returns {Promise<object>} `{status, headers, presign}` — `presign` is the input signed by this
 *                            call, or null.
 */
function serve(spec) {
    return new Promise(function(resolveP) {
        var headers = {}, settled = false, at = presigns.length;
        var settle = function(threw) {
            if (settled) { return; }
            settled = true;
            resolveP({ status: res.statusCode, headers: headers, threw: threw || null, presign: presigns.length > at ? presigns[at].input : null });
        };
        var res = {
            getHeaders : function() { var o = {}; for (var k in headers) { o[k] = headers[k]; } return o; },
            setHeader  : function(k, v) { headers[k.toLowerCase()] = v; },
            write      : function() {},
            end        : function() { setTimeout(function() { settle(); }, 20); },
            statusCode : 200, headersSent: false, writableEnded: false, destroyed: false
        };
        var inst = SuperController.createTestInstance({
            req : { method: 'GET', headers: {} },
            res : res
        });
        inst.throwError = function(r, code, e) { res.statusCode = code; settle({ code: code, err: e }); };
        inst.serveFromStorage(spec.driver, spec.key, spec.opts);
        setTimeout(function() { if (!settled) { settled = true; resolveP({ status: 'TIMEOUT', headers: headers, threw: null, presign: null }); } }, 3000);
    });
}

/**
 * The offload 307's signed value and the in-process header for one stored object.
 *
 * @inner
 * @param {string} id - KEYS id.
 * @returns {Promise<{offload: string, inProcess: string}>}
 */
function bothPaths(id) {
    return serve({ driver: 'remote', key: KEYS[id], opts: { download: true } }).then(function(off) {
        assert.equal(off.status, 307, 'the offload path redirects');
        assert.ok(off.presign, 'the offload path presigned');
        return serve({ driver: 'remote', key: KEYS[id], opts: { download: true, offload: false } }).then(function(inp) {
            assert.equal(inp.status, 200, 'the in-process path serves the bytes');
            return { offload: off.presign.ResponseContentDisposition, inProcess: inp.headers['content-disposition'] };
        });
    });
}

// names outside printable ASCII, with the value the fixed adapter signs for each
var OUTSIDE = [
    ['résumé.pdf',          'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'],
    ['résumé.pdf',        'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'],
    ['naïve © ñ.pdf',  'attachment; filename="naive ? n.pdf"; filename*=UTF-8\'\'na%C3%AFve%20%C2%A9%20%C3%B1.pdf'],
    ['café’s.pdf',          'attachment; filename="cafe?s.pdf"; filename*=UTF-8\'\'caf%C3%A9%E2%80%99s.pdf'],
    ['日本語.pdf',        'attachment; filename="???.pdf"; filename*=UTF-8\'\'%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf'],
    ['📄.pdf',              'attachment; filename="??.pdf"; filename*=UTF-8\'\'%F0%9F%93%84.pdf'],
    ['l’offre (v2)*.pdf',        'attachment; filename="l?offre (v2)*.pdf"; filename*=UTF-8\'\'l%E2%80%99offre%20%28v2%29%2A.pdf'],
    ['a\ud800b.pdf',                  'attachment; filename="a?b.pdf"; filename*=UTF-8\'\'a%EF%BF%BDb.pdf'],
    ['é"x\\.pdf',                'attachment; filename="e\\"x\\\\.pdf"; filename*=UTF-8\'\'%C3%A9%22x%5C.pdf'],
    ['ßæø.txt',        'attachment; filename="???.txt"; filename*=UTF-8\'\'%C3%9F%C3%A6%C3%B8.txt']
];
// printable-ASCII names (after the control strip), whose value does not change
var INSIDE = ['proof.pdf', 'monthly report 2026.pdf', 'it\'s (final)*.pdf', 'a"b\\c.pdf', 'safe\r\nname.pdf', 'tab\tname.pdf'];

before(function(t, done) {
    var ok = storageLib.start({
        drivers : {
            remote : { adapter: 's3', bucket: 'b1115-bucket', prefix: 'app/' }
        },
        default : 'remote',
        requireProjectModule : function(pkg) {
            if ( !PACKAGES[pkg] ) { throw new Error('Cannot find module \'' + pkg + '\''); }
            return PACKAGES[pkg];
        }
    });
    assert.ok(ok, 'storage must adopt the test driver');
    // seed through the REAL put(), so the stored name rides the shipped metadata encoding
    var seeds = [['ascii', 'proof.pdf'], ['latin1', 'résumé.pdf'], ['cjk', '日本語.pdf']];
    var left = seeds.length;
    seeds.forEach(function(s) {
        storageLib.get('remote').put(Readable.from([Buffer.from('%PDF-1.4 ' + s[0])]), {
            originalName: s[1], contentType: 'application/pdf'
        }, function(err, r) {
            assert.ifError(err);
            KEYS[s[0]] = r.key;
            if ( --left === 0 ) { done(); }
        });
    });
});

after(function() {
    try { storageLib.reset(); } catch (e) { /* already closed */ }
});

// ─── 01 — resolve(): the signed value ────────────────────────────────────────

describe('01 - resolve(): the signed response-content-disposition', function() {

    it('CONTROL - a printable-ASCII name keeps the plain quoted-string', async function() {
        assert.equal(await signed({ download: true, filename: 'monthly report 2026.pdf' }), 'attachment; filename="monthly report 2026.pdf"');
        assert.equal(await signed({ download: true, filename: 'it\'s (final)*.pdf' }), 'attachment; filename="it\'s (final)*.pdf"');
    });

    it('CONTROL - a quote and a backslash are escaped', async function() {
        assert.equal(await signed({ download: true, filename: 'a"b\\c.pdf' }), 'attachment; filename="a\\"b\\\\c.pdf"');
    });

    it('CONTROL - control characters are stripped, a tab included', async function() {
        assert.equal(await signed({ download: true, filename: 'safe\r\nname.pdf' }), 'attachment; filename="safename.pdf"');
        assert.equal(await signed({ download: true, filename: 'tab\tname.pdf' }), 'attachment; filename="tabname.pdf"');
    });

    it('CONTROL - download without a filename is named download', async function() {
        assert.equal(await signed({ download: true }), 'attachment; filename="download"');
    });

    it('a Latin-1 name: an all-ASCII filename, then filename* (AWS re-encoded the raw name as ISO-8859-1)', async function() {
        assert.equal(await signed({ download: true, filename: 'résumé.pdf' }), OUTSIDE[0][1]);
        assert.equal(await signed({ download: true, filename: 'naïve © ñ.pdf' }), OUTSIDE[2][1]);
    });

    it('a decomposed accent signs the precomposed name\'s value', async function() {
        assert.equal(await signed({ download: true, filename: 'résumé.pdf' }), OUTSIDE[0][1]);
    });

    it('a name above U+00FF (AWS answered 400 for the raw name)', async function() {
        assert.equal(await signed({ download: true, filename: 'café’s.pdf' }), OUTSIDE[3][1]);
    });

    it('CJK and a character outside the BMP', async function() {
        assert.equal(await signed({ download: true, filename: '日本語.pdf' }), OUTSIDE[4][1]);
        assert.equal(await signed({ download: true, filename: '📄.pdf' }), OUTSIDE[5][1]);
    });

    it('\' ( ) * are percent-encoded in filename* (RFC 8187 attr-char)', async function() {
        assert.equal(await signed({ download: true, filename: 'l’offre (v2)*.pdf' }), OUTSIDE[6][1]);
    });

    it('a lone surrogate is signed as U+FFFD', async function() {
        assert.equal(await signed({ download: true, filename: 'a\ud800b.pdf' }), OUTSIDE[7][1]);
    });

    it('every value signed for a name outside ASCII is printable ASCII', async function() {
        var bad = [];
        for (var i = 0; i < OUTSIDE.length; i++) {
            var v = await signed({ download: true, filename: OUTSIDE[i][0] });
            if ( !printableAscii(v) ) { bad.push(JSON.stringify(OUTSIDE[i][0]) + ' -> ' + JSON.stringify(v)); }
        }
        assert.deepEqual(bad, [], 'values outside printable ASCII');
    });
});

// ─── 02 — the twin ───────────────────────────────────────────────────────────

describe('02 - the twin: resolve() signs what controller.js formatAttachmentDisposition builds', function() {

    it('CONTROL - the extraction is controller.js\'s #B1113 builder (real bytes, no replica)', function() {
        assert.equal(typeof format, 'function');
        assert.ok(FORMAT_SRC.split('\n').length > 10, 'the walk stopped inside the function');
        assert.equal(format('proof.pdf'), 'attachment; filename="proof.pdf"');
        // a builder from before #B1113 kept this name raw: the twin pin needs the current one
        assert.equal(format('résumé.pdf'), OUTSIDE[0][1]);
    });

    it('CONTROL - printable-ASCII names: the signed value is the builder\'s', async function() {
        var diff = [];
        for (var i = 0; i < INSIDE.length; i++) {
            var v = await signed({ download: true, filename: INSIDE[i] });
            var want = format(stripControls(INSIDE[i]));
            if ( v !== want ) { diff.push(JSON.stringify(INSIDE[i]) + ': signed ' + JSON.stringify(v) + ', builder ' + JSON.stringify(want)); }
        }
        assert.deepEqual(diff, []);
    });

    it('names outside ASCII: the signed value is the builder\'s, name by name', async function() {
        var diff = [];
        for (var i = 0; i < OUTSIDE.length; i++) {
            var v = await signed({ download: true, filename: OUTSIDE[i][0] });
            var want = format(stripControls(OUTSIDE[i][0]));
            if ( v !== want ) { diff.push(JSON.stringify(OUTSIDE[i][0]) + ': signed ' + JSON.stringify(v) + ', builder ' + JSON.stringify(want)); }
            // the table above and the builder agree, so a drift in either reads here
            assert.equal(want, OUTSIDE[i][1], 'the expected table drifted from the builder for ' + JSON.stringify(OUTSIDE[i][0]));
        }
        assert.deepEqual(diff, []);
    });
});

// ─── 03 — serveFromStorage(): offload vs in-process ──────────────────────────

describe('03 - serveFromStorage(): the offload 307 signs the header the in-process path sends', function() {

    it('CONTROL - an ASCII stored name: one value on both paths', async function() {
        var r = await bothPaths('ascii');
        assert.equal(r.inProcess, 'attachment; filename="proof.pdf"');
        assert.equal(r.offload, r.inProcess);
    });

    it('a Latin-1 stored name: one value on both paths, with filename*', async function() {
        var r = await bothPaths('latin1');
        assert.equal(r.inProcess, OUTSIDE[0][1]);
        assert.equal(r.offload, r.inProcess);
    });

    it('a stored name above U+00FF: one value on both paths, printable ASCII', async function() {
        var r = await bothPaths('cjk');
        assert.equal(r.inProcess, OUTSIDE[4][1]);
        assert.equal(r.offload, r.inProcess);
        assert.ok(printableAscii(r.offload), 'the signed value is printable ASCII');
    });
});
