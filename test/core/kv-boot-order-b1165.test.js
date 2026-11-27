/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * #B1165 — the kv namespaces are installed before the engine starts.
 *
 * `Server.start` resolves `server.rateLimit` (#MS6) and `server.idempotency`
 * (#FIN6) through `lib.kv.get()`. The #KV1 band that installs the namespaces
 * used to run in the started band (after `listen()`), so every bundle that
 * enabled either feature refused to boot with "[kv] not configured" (measured on
 * booted bundles, 2026-11-24 and 2026-11-25). The band now runs at the top of
 * gna.js's 'complete' handler, before the started band is registered and before
 * the engine starts, so a fatal kv error also exits before the port is bound.
 *
 * Source pins on core/gna.js; each needle is a code form that no comment in the
 * file carries. GINA_GNA_SRC, when set, points the file at another copy of
 * gna.js (a seam: the file runs red-first against a pre-fix copy):
 *
 *   GINA_GNA_SRC=/path/to/pre-fix/gna.js node --test test/core/kv-boot-order-b1165.test.js
 *
 * On the pre-fix copy, 02, 04 and 05 fail; 01 and 03 pass (03 guards the order
 * against the engine start, which already held).
 */

var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var nodePath = require('node:path');

var ROOT    = nodePath.join(__dirname, '..', '..');
var VERSION = require(nodePath.join(ROOT, 'package.json')).version;
var FW_DIR  = nodePath.join(ROOT, 'framework', 'v' + VERSION);
var GNA_SRC = fs.readFileSync(process.env.GINA_GNA_SRC || nodePath.join(FW_DIR, 'core', 'gna.js'), 'utf8');

// Code forms only: no comment in gna.js carries any of them.
var COMPLETE = "e.on('complete', function(instance){";
var KV_START = 'lib.kv.start(_kvSettings, ';
var STARTED  = "server.on('started', async function (conf) {";
var ENGINE   = 'server.start(instance);';
var KV_FATAL = "'[kv] invalid kv configuration — aborting boot: '";

/**
 * Counts the occurrences of a literal in a source text.
 *
 * @inner
 * @param {string} src    - The source text.
 * @param {string} needle - The literal to count.
 * @returns {number} How many times the literal occurs.
 *
 * @example
 * count('a.b a.b', 'a.b'); // => 2
 */
function count(src, needle) {
    var n = 0, i = src.indexOf(needle);
    while (i > -1) { n++; i = src.indexOf(needle, i + needle.length); }
    return n;
}

describe('#B1165 — kv installed before the engine starts (core/gna.js)', function () {

    it('01 - each anchor occurs exactly once (the instrument)', function () {
        [COMPLETE, KV_START, STARTED, ENGINE, KV_FATAL].forEach(function (needle) {
            assert.equal(count(GNA_SRC, needle), 1, 'expected exactly one `' + needle + '` in gna.js');
        });
    });

    it('02 - inside the \'complete\' handler, the kv band runs before the started band is registered', function () {
        var c  = GNA_SRC.indexOf(COMPLETE);
        var kv = GNA_SRC.indexOf(KV_START, c);
        var st = GNA_SRC.indexOf(STARTED, c);
        assert.ok(c > -1 && kv > c && st > c, 'the anchors follow the \'complete\' handler');
        assert.ok(kv < st, 'the kv band must precede the started-band registration');
    });

    it('03 - the kv band runs before the engine starts', function () {
        var c  = GNA_SRC.indexOf(COMPLETE);
        var kv = GNA_SRC.indexOf(KV_START, c);
        var en = GNA_SRC.indexOf(ENGINE, c);
        assert.ok(kv > c && en > kv, 'the kv band must precede the engine start');
    });

    it('04 - the started band no longer installs the namespaces (scoped to that band)', function () {
        var st   = GNA_SRC.indexOf(STARTED);
        var en   = GNA_SRC.indexOf(ENGINE, st);
        var band = GNA_SRC.slice(st, en);
        // control: the slice is the started band (the #MAINT1 store sync lives there)
        assert.ok(band.indexOf('lib.maintenance.resolveStoreSync(') > -1, 'the slice holds the started band');
        assert.equal(band.indexOf(KV_START), -1, 'the started band must not install the namespaces');
    });

    it('05 - a fatal kv configuration exits before the started band is registered', function () {
        var c    = GNA_SRC.indexOf(COMPLETE);
        var st   = GNA_SRC.indexOf(STARTED, c);
        var head = GNA_SRC.slice(c, st);
        assert.ok(head.indexOf(KV_FATAL) > -1, 'the kv fatal message sits in the \'complete\' handler, before the started band');
        assert.ok(head.indexOf('process.exit(1)') > -1, 'and the boot exits there');
    });
});
