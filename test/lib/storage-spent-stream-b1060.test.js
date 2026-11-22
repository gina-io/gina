'use strict';
/**
 * lib/storage — a source stream that has already ended or been destroyed is refused (#B1060).
 *
 * Before the fix (measured on a booted bundle and at lib level): handed such a
 * source, put() stored an EMPTY object and reported success (sharded with size
 * tiering off, stream, cas) or never called back (sharded with tiering on), and
 * writeSegment() answered {length: 0} with no error (an ended source) or never
 * called back and kept the session's data file open (a destroyed one). The usual
 * way to hold such a source is a request whose body gina has already read.
 *
 * After: every write verb calls back at once with err.code STORAGE_STREAM_SPENT
 * and stores nothing; a live source still stores, an empty one included.
 *
 * Suites:
 *  01 — put() on sharded (tiering off and on), stream and cas: ended, destroyed and
 *       errored sources refused, nothing written; a fresh source stores (control)
 *  02 — put() on s3 (fake SDK): spent sources refused before any upload is built;
 *       a fresh source is uploaded (control)
 *  03 — writeSegment(): spent sources refused, nothing received, no descriptor left
 *       open; a fresh source writes and completes (control)
 *  04 — a plain-node request read to its end before the call: refused by put() and
 *       writeSegment()
 *  05 — a live source that delivers no bytes is NOT refused (a 0-byte object or
 *       segment is legitimate)
 *  06 — util.spentStreamError(): live and stateless sources → null; ended, destroyed
 *       and not-readable sources → an error coded STORAGE_STREAM_SPENT
 */
var { describe, it, after } = require('node:test');
var assert   = require('node:assert');
var fs       = require('node:fs');
var os       = require('node:os');
var http     = require('node:http');
var nodePath = require('node:path');
var crypto   = require('node:crypto');
var Readable = require('node:stream').Readable;

var FW  = require('../fw');
var SRC = nodePath.join(FW, 'lib', 'storage', 'src');

var util                    = require(nodePath.join(SRC, 'util.js'));
var createLocalDriver       = require(nodePath.join(SRC, 'local.js'));
var createLocalStreamDriver = require(nodePath.join(SRC, 'local-stream.js'));
var createLocalCasDriver    = require(nodePath.join(SRC, 'local-cas.js'));
var createS3                = require(nodePath.join(SRC, 's3.js'));
var createEmbeddedMetaStore = require(nodePath.join(SRC, 'meta-store.js'));

var SIZE    = 8192;
var BUF     = crypto.randomBytes(SIZE);
var WAIT_MS = 2000;   // the refusal is immediate; this only bounds a callback that never comes

/** temp roots created by tests, removed in one file-level after() @type {string[]} */
var roots = [];

after(function () {
    roots.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
});

/**
 * A fresh temp root, registered for teardown.
 *
 * @inner
 * @returns {string} Absolute path.
 */
function mkRoot() {
    var d = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gina-b1060-'));
    roots.push(d);
    return d;
}

/**
 * A driver of one strategy on a fresh root, with its embedded metadata store.
 *
 * @inner
 * @param {string} kind              - 'sharded', 'stream' or 'cas'.
 * @param {number} [inlineThreshold] - Size tiering threshold (sharded and cas); 0 turns it off.
 * @returns {{driver: object, root: string, name: string}}
 */
function local(kind, inlineThreshold) {
    var root  = mkRoot();
    var store = createEmbeddedMetaStore(nodePath.join(root, '.meta.db'));
    var base  = { root: root, maxObjectSize: 50 * 1024 * 1024 };
    if ( kind === 'sharded' ) {
        return { root: root, name: 'shardT', driver: createLocalDriver('shardT',
            Object.assign(base, { strategy: 'sharded', inlineThreshold: inlineThreshold || 0 }), store) };
    }
    if ( kind === 'stream' ) {
        return { root: root, name: 'streamT', driver: createLocalStreamDriver('streamT',
            Object.assign(base, { strategy: 'stream', chunkSize: 8 * 1024 * 1024, fsync: true,
                                  sessionTtl: 24 * 60 * 60 * 1000, sessionSweepInterval: 0 }), store) };
    }
    return { root: root, name: 'casT', driver: createLocalCasDriver('casT',
        Object.assign(base, { strategy: 'cas', hash: 'sha256', fsync: true, sweepInterval: 0,
                              sweepGrace: 60 * 60 * 1000, inlineThreshold: inlineThreshold || 0 }), store) };
}

/**
 * Every file under a root but the metadata store's own: what a put could have written.
 *
 * @inner
 * @param {string} root - The driver root.
 * @returns {string[]} Relative paths, sorted.
 */
function objectFiles(root) {
    var found = [];
    (function walk(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
            var p = nodePath.join(d, e.name);
            if ( e.isDirectory() ) { walk(p); }
            else if ( !/^\.meta\.db/.test(e.name) ) { found.push(nodePath.relative(root, p)); }
        });
    })(root);
    return found.sort();
}

/**
 * The fake @aws-sdk trio the s3 adapter loads through `requireModule`: its
 * Upload double counts constructions and consumes the body into a map.
 *
 * @inner
 * @returns {{driver: object, state: {uploads: number, objects: object}}}
 */
function fakeS3() {
    var state = { uploads: 0, objects: {} };
    function cmdClass(nm) {
        var C = function(input) { this.input = input; };
        Object.defineProperty(C, 'name', { value: nm });
        return C;
    }
    var ListMultipartUploadsCommand = cmdClass('ListMultipartUploadsCommand');
    var ListObjectsV2Command        = cmdClass('ListObjectsV2Command');
    function S3Client() {}
    S3Client.prototype.destroy = function() {};
    S3Client.prototype.send = function(cmd) {
        if ( cmd instanceof ListMultipartUploadsCommand ) { return Promise.resolve({ Uploads: [] }); }
        if ( cmd instanceof ListObjectsV2Command ) { return Promise.resolve({ Contents: [], KeyCount: 0, IsTruncated: false }); }
        return Promise.reject(new Error('fake S3: unexpected command ' + (cmd && cmd.constructor && cmd.constructor.name)));
    };
    function Upload(opts) { state.uploads++; this._params = opts.params; }
    Upload.prototype.done = function() {
        var p = this._params, chunks = [];
        return new Promise(function(resolveP, rejectP) {
            p.Body.on('data', function(c) { chunks.push(c); });
            p.Body.on('error', rejectP);
            p.Body.on('end', function() { state.objects[p.Key] = Buffer.concat(chunks); resolveP({}); });
        });
    };
    Upload.prototype.abort = function() { return Promise.resolve(); };
    var packages = {
        '@aws-sdk/client-s3' : {
            S3Client                    : S3Client,
            HeadObjectCommand           : cmdClass('HeadObjectCommand'),
            GetObjectCommand            : cmdClass('GetObjectCommand'),
            DeleteObjectCommand         : cmdClass('DeleteObjectCommand'),
            ListObjectsV2Command        : ListObjectsV2Command,
            ListMultipartUploadsCommand : ListMultipartUploadsCommand,
            AbortMultipartUploadCommand : cmdClass('AbortMultipartUploadCommand')
        },
        '@aws-sdk/lib-storage'          : { Upload: Upload },
        '@aws-sdk/s3-request-presigner' : { getSignedUrl: function() { return Promise.resolve('https://signed.test/x'); } }
    };
    var conf = { bucket: 'test-bucket', prefix: '', maxObjectSize: 100 * 1024 * 1024,
                 presignExpiry: 15 * 60 * 1000, sweepGrace: 60 * 60 * 1000 };
    var driver = createS3('remote', conf, null, { requireModule: function(pkg) {
        if ( !packages[pkg] ) { throw new Error('Cannot find module \'' + pkg + '\''); }
        return packages[pkg];
    } });
    return { driver: driver, state: state };
}

/** A readable read to its end: its 'end' has fired. @inner @returns {Promise<object>} */
function ended() {
    return new Promise(function (resolve) {
        var r = Readable.from([BUF]);
        r.on('data', function () {});
        r.on('end', function () { setImmediate(function () { resolve(r); }); });
    });
}
/** A readable destroyed before the call, without an error. @inner @returns {Promise<object>} */
function destroyed() {
    var r = new Readable({ read: function () {} });
    r.push(BUF);
    r.destroy();
    return new Promise(function (resolve) { setImmediate(function () { resolve(r); }); });
}
/** A readable destroyed with an error before the call. @inner @returns {Promise<object>} */
function errored() {
    var r = new Readable({ read: function () {} });
    r.on('error', function () {});
    r.push(BUF);
    r.destroy(new Error('the source failed'));
    return new Promise(function (resolve) { setImmediate(function () { resolve(r); }); });
}
var SPENT = [['ended', ended], ['destroyed', destroyed], ['errored', errored]];

/**
 * Run a callback-shaped verb, bounded: resolves `{err, res}`, or `{timeout: true}`
 * when no callback comes within WAIT_MS.
 *
 * @inner
 * @param {function(function)} start - Calls the verb with the callback it is given.
 * @returns {Promise<object>}
 */
function settle(start) {
    return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve({ timeout: true }); }, WAIT_MS);
        start(function (err, res) { clearTimeout(t); resolve({ err: err || null, res: res }); });
    });
}

/**
 * The refusal's shape: a callback, an error coded STORAGE_STREAM_SPENT, a
 * message naming the driver and the verb.
 *
 * @inner
 * @param {object} out  - `settle()` result.
 * @param {string} name - Driver name.
 * @param {string} verb - 'put' or 'writeSegment'.
 * @returns {void}
 */
function assertRefused(out, name, verb) {
    assert.ok(!out.timeout, verb + '() must call back for a spent source');
    assert.ok(out.err, verb + '() must refuse a spent source, it answered ' + JSON.stringify(out.res));
    assert.strictEqual(out.err.code, 'STORAGE_STREAM_SPENT');
    assert.strictEqual(out.err.message.indexOf('[storage:' + name + '] ' + verb + '()'), 0, out.err.message);
}

function fdCount() { try { return fs.readdirSync('/dev/fd').length; } catch (e) { return null; } }
function createUpload(d) {
    return new Promise(function (resolve, reject) {
        d.createUpload({ expectedSize: SIZE, originalName: 'x.bin' }, function (e, s) { return e ? reject(e) : resolve(s); });
    });
}
function statUpload(d, id) {
    return new Promise(function (resolve, reject) {
        d.statUpload(id, function (e, st) { return e ? reject(e) : resolve(st); });
    });
}

describe('01 — put() refuses a spent source on every local strategy', function () {
    var kinds = [['sharded, tiering off', 'sharded', 0], ['sharded, tiering on', 'sharded', 64 * 1024],
                 ['stream', 'stream', 0], ['cas', 'cas', 0]];
    kinds.forEach(function (k) {
        SPENT.forEach(function (s) {
            it(k[0] + ': an ' + s[0] + ' source is refused and nothing is written', async function () {
                var f = local(k[1], k[2]);
                var before = objectFiles(f.root);
                var src = await s[1]();
                var out = await settle(function (cb) { f.driver.put(src, { originalName: 'x.bin' }, cb); });
                assertRefused(out, f.name, 'put');
                assert.deepStrictEqual(objectFiles(f.root), before);
            });
        });
        it(k[0] + ': a fresh source stores ' + SIZE + ' bytes (control)', async function () {
            var f = local(k[1], k[2]);
            var out = await settle(function (cb) { f.driver.put(Readable.from([BUF]), { originalName: 'x.bin' }, cb); });
            assert.ok(!out.timeout, 'put() must call back');
            assert.ifError(out.err);
            assert.strictEqual(out.res.size, SIZE);
        });
    });
});

describe('02 — s3 put() refuses a spent source before any upload starts', function () {
    SPENT.forEach(function (s) {
        it('an ' + s[0] + ' source is refused and no Upload is built', async function () {
            var f = fakeS3();
            var src = await s[1]();
            var out = await settle(function (cb) { f.driver.put(src, { originalName: 'x.bin' }, cb); });
            assertRefused(out, 'remote', 'put');
            assert.strictEqual(f.state.uploads, 0);
            assert.deepStrictEqual(Object.keys(f.state.objects), []);
        });
    });
    it('a fresh source is uploaded (control)', async function () {
        var f = fakeS3();
        var out = await settle(function (cb) { f.driver.put(Readable.from([BUF]), { originalName: 'x.bin' }, cb); });
        assert.ok(!out.timeout, 'put() must call back');
        assert.ifError(out.err);
        assert.strictEqual(out.res.size, SIZE);
        assert.strictEqual(f.state.uploads, 1);
    });
});

describe('03 — writeSegment() refuses a spent source before the data file opens', function () {
    SPENT.forEach(function (s) {
        it('an ' + s[0] + ' source is refused, nothing is received, no descriptor is left open', async function () {
            var f = local('stream');
            var sess = await createUpload(f.driver);
            var src = await s[1]();
            var fd0 = fdCount();
            var out = await settle(function (cb) { f.driver.writeSegment(sess.uploadId, 0, src, cb); });
            var fd1 = fdCount();
            assertRefused(out, f.name, 'writeSegment');
            if ( fd0 !== null ) { assert.strictEqual(fd1, fd0, 'no descriptor left open'); }
            var st = await statUpload(f.driver, sess.uploadId);
            assert.deepStrictEqual(st.received, []);
            assert.strictEqual(st.complete, false);
        });
    });
    it('a fresh source writes ' + SIZE + ' bytes and completes the upload (control)', async function () {
        var f = local('stream');
        var sess = await createUpload(f.driver);
        var out = await settle(function (cb) { f.driver.writeSegment(sess.uploadId, 0, Readable.from([BUF]), cb); });
        assert.ok(!out.timeout, 'writeSegment() must call back');
        assert.ifError(out.err);
        assert.strictEqual(out.res.length, SIZE);
        assert.strictEqual((await statUpload(f.driver, sess.uploadId)).complete, true);
    });
});

describe('04 — a request read to its end before the call is refused', function () {
    it('put() and writeSegment() refuse it, and the response still goes out', async function () {
        var f = local('stream');
        var sess = await createUpload(f.driver);
        var verdict = function (o, field) {
            if ( o.timeout ) { return 'no callback'; }
            return o.err ? o.err.code : ('success ' + field + ' ' + (o.res && o.res[field]));
        };
        var result = await new Promise(function (resolve, reject) {
            var srv = http.createServer(function (req, res) {
                req.on('data', function () {});
                req.on('end', function () {
                    setImmediate(async function () {
                        var p = await settle(function (cb) { f.driver.put(req, { originalName: 'x.bin' }, cb); });
                        var w = await settle(function (cb) { f.driver.writeSegment(sess.uploadId, 0, req, cb); });
                        res.end(JSON.stringify({ put: verdict(p, 'size'), writeSegment: verdict(w, 'length') }));
                    });
                });
            });
            srv.listen(0, '127.0.0.1', function () {
                var c = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', agent: false,
                                       headers: { 'content-type': 'application/octet-stream', 'content-length': SIZE } }, function (r) {
                    var data = '';
                    r.setEncoding('utf8');
                    r.on('data', function (d) { data += d; });
                    r.on('end', function () { srv.close(); resolve(JSON.parse(data)); });
                });
                c.on('error', function (e) { srv.close(); reject(e); });
                c.end(BUF);
            });
        });
        assert.deepStrictEqual(result, { put: 'STORAGE_STREAM_SPENT', writeSegment: 'STORAGE_STREAM_SPENT' });
    });
});

describe('05 — a live source that delivers no bytes is not refused', function () {
    it('put() stores a 0-byte object', async function () {
        var f = local('sharded', 0);
        var out = await settle(function (cb) { f.driver.put(Readable.from([]), { originalName: 'empty.txt' }, cb); });
        assert.ok(!out.timeout, 'put() must call back');
        assert.ifError(out.err);
        assert.strictEqual(out.res.size, 0);
    });
    it('writeSegment() answers length 0 with no error (a segment that ends early)', async function () {
        var f = local('stream');
        var sess = await createUpload(f.driver);
        var out = await settle(function (cb) { f.driver.writeSegment(sess.uploadId, 0, Readable.from([]), cb); });
        assert.ok(!out.timeout, 'writeSegment() must call back');
        assert.ifError(out.err);
        assert.strictEqual(out.res.length, 0);
    });
});

describe('06 — util.spentStreamError()', function () {
    it('answers null for a live source and for a stream-like object that keeps no state', function () {
        assert.strictEqual(util.spentStreamError(Readable.from([BUF]), 'n', 'put'), null);
        assert.strictEqual(util.spentStreamError({ pipe: function () {} }, 'n', 'put'), null);
    });
    it('answers an error coded STORAGE_STREAM_SPENT for an ended, a destroyed or a not-readable source', async function () {
        var sources = [await ended(), await destroyed(), { pipe: function () {}, readable: false }];
        sources.forEach(function (s) {
            var e = util.spentStreamError(s, 'n', 'writeSegment');
            assert.ok(e instanceof Error);
            assert.strictEqual(e.code, 'STORAGE_STREAM_SPENT');
            assert.strictEqual(e.message.indexOf('[storage:n] writeSegment()'), 0, e.message);
        });
    });
});
