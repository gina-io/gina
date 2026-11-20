/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module multipart
 *
 * `multipart/form-data` body ENCODER (#B489) — the inverse of the request
 * parser. The nested text fields the server exposes on `req.body` /
 * `req[method]` and the `req.files` staging records come back out as ONE
 * RFC 7578 body under a fresh boundary, ready for `self.query()`'s `body`
 * option — which is how `self.forward()` relays an upload to another route.
 *
 * Contract:
 *  - fields are re-flattened to bracket notation (`a[b]`, `a[0]`, `a[0][c]`),
 *    the exact inverse of the parser's `nestBracketNotationKey` nesting, so
 *    the receiving bundle parses the same object back. An empty array or
 *    object has no wire form and is dropped; `null` / `undefined` become `""`;
 *    every other leaf travels as `String(value)`.
 *  - files are read from `record.path` (the staged temp file) and NEVER
 *    deleted here: the source bundle's cleanup timer, `self.store()` and the
 *    boot orphan sweep own that file. `record.originalFilename` is the wire
 *    filename, `record.type` the part Content-Type, `record.group` the
 *    `group` disposition param the receiving side's upload-group gate reads.
 *  - the body is a Buffer. `options.maxSize` (bytes) is checked against the
 *    files' ON-DISK sizes plus the field bytes BEFORE any file is read, so a
 *    breach allocates nothing. The boundary is CSPRNG-random and re-drawn
 *    until it occurs in no part.
 *  - names and filenames are escaped the way browsers do (the WHATWG
 *    multipart/form-data algorithm): `"` → `%22`, CR → `%0D`, LF → `%0A`;
 *    everything else travels as raw UTF-8, which a parser built with
 *    `defParamCharset: 'utf8'` decodes back verbatim.
 *
 * Errors carry a `code`: `MULTIPART_BAD_INPUT`, `MULTIPART_TOO_LARGE`
 * (`.size`, `.limit`), `MULTIPART_FILE_UNREADABLE` (`.path`, `.cause`),
 * `MULTIPART_BOUNDARY`.
 *
 * Server-side only (reads the filesystem); absent from the browser bundle.
 *
 * @example
 * var enc = lib.multipart.encode({ fields: req.post, files: req.files }, { maxSize: 16 * 1024 * 1024 });
 * self.query({ hostname: 'api@myproject', path: '/api/upload', method: 'post',
 *              headers: { 'content-type': enc.contentType }, body: enc.body }, {}, cb);
 */

var fs     = require('fs');
var crypto = require('crypto');

var CRLF = '\r\n';
/** @constant {RegExp} segments the parser drops (#B446) — never emitted either */
var RESERVED_SEGMENTS = /^(__proto__|constructor|prototype)$/;
/** @constant {number} RFC 2046 caps a boundary at 70 characters; `----gina` + 48 hex = 56 */
var BOUNDARY_ATTEMPTS = 8;

/**
 * Build an Error carrying a machine-readable `code` plus extra fields.
 *
 * @inner
 * @param {string} code
 * @param {string} message
 * @param {object} [extra] - own fields copied onto the error
 * @returns {Error}
 */
function codedError(code, message, extra) {
    var err  = new Error(message);
    err.code = code;
    if (extra) {
        var keys = Object.keys(extra);
        for (var i = 0; i < keys.length; ++i) {
            err[keys[i]] = extra[keys[i]];
        }
    }
    return err;
}

/**
 * Escape a Content-Disposition parameter value the way browsers do.
 *
 * @inner
 * @param {*} value
 * @returns {string}
 */
function escapeParam(value) {
    return String(value)
        .replace(/"/g, '%22')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

/**
 * Recursive worker for `flatten()`.
 *
 * @inner
 * @param {string} name  - the bracket-notation name so far
 * @param {*}      value
 * @param {Array}  out   - accumulator of `[name, value]` pairs
 * @returns {void}
 */
function walk(name, value, out) {
    if (value === null || typeof(value) == 'undefined') {
        out.push([name, '']);
        return;
    }
    if (Array.isArray(value)) {
        for (var i = 0, len = value.length; i < len; ++i) {
            walk(name + '[' + i + ']', value[i], out);
        }
        return;
    }
    if (typeof(value) == 'object' && !Buffer.isBuffer(value)) {
        var keys = Object.keys(value);
        for (var k = 0, kLen = keys.length; k < kLen; ++k) {
            if (RESERVED_SEGMENTS.test(keys[k])) {
                continue;
            }
            walk(name + '[' + keys[k] + ']', value[keys[k]], out);
        }
        return;
    }
    out.push([name, Buffer.isBuffer(value) ? value.toString('utf8') : String(value)]);
}

/**
 * Flatten a nested fields object into `[name, value]` pairs in bracket
 * notation — the inverse of the request parser's nesting, so that parsing
 * the emitted parts nests them back into the same object.
 *
 * @param {object} [fields] - the nested object (`req.post`, `req.body`, …)
 * @returns {Array<Array<string>>} ordered `[name, value]` pairs; values are strings
 * @throws {Error} `MULTIPART_BAD_INPUT` when `fields` is not a plain object
 *
 * @example
 * flatten({ user: { name: 'a', tags: ['x', 'y'] } })
 * // => [ ['user[name]', 'a'], ['user[tags][0]', 'x'], ['user[tags][1]', 'y'] ]
 */
function flatten(fields) {
    var out = [];
    if (fields === null || typeof(fields) == 'undefined') {
        return out;
    }
    if (typeof(fields) != 'object' || Array.isArray(fields) || Buffer.isBuffer(fields)) {
        throw codedError('MULTIPART_BAD_INPUT', 'multipart: `fields` must be a plain object');
    }
    var keys = Object.keys(fields);
    for (var i = 0, len = keys.length; i < len; ++i) {
        if (RESERVED_SEGMENTS.test(keys[i])) {
            continue;
        }
        walk(keys[i], fields[keys[i]], out);
    }
    return out;
}

/**
 * Draw a boundary that occurs in none of the parts.
 *
 * @inner
 * @param {Array<{head: string, data: Buffer}>} parts
 * @returns {string}
 * @throws {Error} `MULTIPART_BOUNDARY` after `BOUNDARY_ATTEMPTS` clashes
 */
function pickBoundary(parts) {
    for (var attempt = 0; attempt < BOUNDARY_ATTEMPTS; ++attempt) {
        var boundary = '----gina' + crypto.randomBytes(24).toString('hex');
        var needle   = Buffer.from('--' + boundary);
        var clash    = false;
        for (var i = 0, len = parts.length; i < len; ++i) {
            if (parts[i].data.indexOf(needle) > -1) {
                clash = true;
                break;
            }
        }
        if (!clash) {
            return boundary;
        }
    }
    throw codedError('MULTIPART_BOUNDARY', 'multipart: could not draw a boundary absent from every part');
}

/**
 * Encode fields and staged file records into one `multipart/form-data` body.
 *
 * @param {object}   [input]
 * @param {object}   [input.fields]  - nested text fields (`req.post` / `req.body`)
 * @param {Array}    [input.files]   - `req.files` records: `{ name, originalFilename, type, path, group }`
 * @param {object}   [options]
 * @param {number}   [options.maxSize]  - byte cap on the field bytes + on-disk file sizes, checked before any read
 * @param {string}   [options.boundary] - a fixed boundary (tests); a random one is drawn otherwise
 * @returns {{ contentType: string, body: Buffer, length: number, boundary: string }}
 * @throws {Error} coded: `MULTIPART_BAD_INPUT` · `MULTIPART_TOO_LARGE` · `MULTIPART_FILE_UNREADABLE` · `MULTIPART_BOUNDARY`
 *
 * @example
 * var enc = encode({ fields: { tag: 'x' }, files: req.files }, { maxSize: 2 * 1024 * 1024 });
 * // enc.contentType => 'multipart/form-data; boundary=----gina…', enc.length === enc.body.length
 */
function encode(input, options) {
    input   = input   || {};
    options = options || {};

    var pairs = flatten(input.fields);
    var files = ( input.files === null || typeof(input.files) == 'undefined' ) ? [] : input.files;
    if ( !Array.isArray(files) ) {
        throw codedError('MULTIPART_BAD_INPUT', 'multipart: `files` must be an array of request file records');
    }

    // size accounting BEFORE any read: field bytes + on-disk file sizes
    var total = 0;
    for (var p = 0, pLen = pairs.length; p < pLen; ++p) {
        total += Buffer.byteLength(pairs[p][1], 'utf8');
    }
    var stats = [];
    for (var f = 0, fLen = files.length; f < fLen; ++f) {
        var record = files[f];
        if ( !record || typeof(record) != 'object' || typeof(record.name) != 'string' || record.name === '' || typeof(record.path) != 'string' || record.path === '' ) {
            throw codedError('MULTIPART_BAD_INPUT', 'multipart: file record #' + f + ' needs a `name` and a `path`');
        }
        var stat = null;
        try {
            stat = fs.statSync(record.path);
        } catch (statErr) {
            throw codedError('MULTIPART_FILE_UNREADABLE', 'multipart: cannot read staged file `' + record.path + '`: ' + statErr.message, { path: record.path, cause: statErr });
        }
        if ( !stat.isFile() ) {
            throw codedError('MULTIPART_FILE_UNREADABLE', 'multipart: staged path `' + record.path + '` is not a file', { path: record.path });
        }
        stats.push(stat);
        total += stat.size;
    }
    if ( typeof(options.maxSize) == 'number' && options.maxSize >= 0 && total > options.maxSize ) {
        throw codedError('MULTIPART_TOO_LARGE', 'multipart: body of ' + total + ' bytes exceeds the ' + options.maxSize + '-byte limit', { size: total, limit: options.maxSize });
    }

    // parts — fields first, then files, both in their given order
    var parts = [];
    for (var q = 0, qLen = pairs.length; q < qLen; ++q) {
        parts.push({
            head: 'Content-Disposition: form-data; name="' + escapeParam(pairs[q][0]) + '"' + CRLF + CRLF,
            data: Buffer.from(pairs[q][1], 'utf8')
        });
    }
    for (var r = 0, rLen = files.length; r < rLen; ++r) {
        var rec      = files[r];
        var filename = ( typeof(rec.originalFilename) == 'string' ) ? rec.originalFilename : ( typeof(rec.filename) == 'string' ? rec.filename : '' );
        var type     = ( typeof(rec.type) == 'string' && rec.type !== '' ) ? rec.type.replace(/[\r\n]/g, '') : 'application/octet-stream';
        var head     = 'Content-Disposition: form-data; name="' + escapeParam(rec.name) + '"; filename="' + escapeParam(filename) + '"';
        if ( typeof(rec.group) == 'string' && rec.group !== '' ) {
            head += '; group="' + escapeParam(rec.group) + '"';
        }
        head += CRLF + 'Content-Type: ' + type + CRLF + CRLF;
        var data = null;
        try {
            data = fs.readFileSync(rec.path);
        } catch (readErr) {
            throw codedError('MULTIPART_FILE_UNREADABLE', 'multipart: cannot read staged file `' + rec.path + '`: ' + readErr.message, { path: rec.path, cause: readErr });
        }
        parts.push({ head: head, data: data });
    }

    var boundary = ( typeof(options.boundary) == 'string' && options.boundary !== '' ) ? options.boundary : pickBoundary(parts);

    var chunks = [];
    for (var c = 0, cLen = parts.length; c < cLen; ++c) {
        chunks.push(Buffer.from('--' + boundary + CRLF + parts[c].head, 'utf8'));
        chunks.push(parts[c].data);
        chunks.push(Buffer.from(CRLF));
    }
    chunks.push(Buffer.from('--' + boundary + '--' + CRLF));
    var body = Buffer.concat(chunks);

    return {
        contentType : 'multipart/form-data; boundary=' + boundary,
        body        : body,
        length      : body.length,
        boundary    : boundary
    };
}

module.exports = {
    encode  : encode,
    flatten : flatten
};
