'use strict';
/**
 * Upload groups — #B1089: a `group` that only resolves through `Object.prototype` is not a
 * configured group
 *
 * Before the fix the #B50 gate read `typeof(opt.groups[fileGroup]) == 'undefined'`, so a part
 * tagged `group="__proto__"` (or `constructor`, `hasOwnProperty`, any own name of
 * `Object.prototype`) resolved to the inherited member, passed the gate, and every rule read on
 * it (`allowedExtensions`, `isMultipleAllowed`, `path`) read `undefined`: the file streamed in
 * unchecked, around a restricted `untagged` group. The gate is now an own-property check.
 *
 * Strategy: source inspection + inline logic replica (the #B50 shape of upload-groups.test.js).
 * No live HTTP server; the booted arm (a real bundle, one multipart POST per group name) is a
 * local drive script that is not shipped.
 *
 * Suites:
 *  01 — server.js source: the gate inside the busboy 'file' listener is an own-property check,
 *       the old predicate is gone from the active code (with the raw-text control that keeps
 *       the pin from passing on a broken comment strip)
 *  02 — replica: every own name of `Object.prototype` is denied as unconfigured, `prototype`
 *       (which is not one) too, an own key is honoured whatever its name, and a configured
 *       group's rules still run
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW         = require('../fw');
var SERVER_SRC = path.join(FW, 'core/server.js');

// Full-line `//` comments stripped, as upload-groups.test.js does: the old predicate stays in
// the source as a comment, and the negative pin must not trip on it.
function stripLineComments(src) {
    return src.split('\n').filter(function(l) { return l.trim().indexOf('//') !== 0; }).join('\n');
}

var OLD_GATE = /typeof\(opt\.groups\[fileGroup\]\)\s*==\s*'undefined'/;
var NEW_GATE = /typeof\(opt\.groups\)\s*==\s*'undefined'\s*\|\|\s*!Object\.prototype\.hasOwnProperty\.call\(opt\.groups,\s*fileGroup\)/;

// ─── 01 — server.js source pins ───────────────────────────────────────────────
describe('01 - upload groups: the configured-group gate is an own-property check (#B1089)', function() {
    var raw, active, listener;
    before(function() {
        raw      = fs.readFileSync(SERVER_SRC, 'utf8');
        active   = stripLineComments(raw);
        var a    = active.indexOf("busboy.on('file', function(fieldname, file, info) {");
        var b    = active.indexOf("busboy.on('error', function onBusboyError", a);
        assert.ok(a > -1 && b > a, 'the busboy file listener is located');
        listener = active.slice(a, b);
    });

    it('gates on an own property of opt.groups, inside the file listener', function() {
        assert.match(listener, NEW_GATE);
        assert.equal((listener.match(/hasOwnProperty\.call\(opt\.groups,\s*fileGroup\)/g) || []).length, 1,
            'one own-property gate');
    });

    it('no longer reads the group with a bare typeof in the active code', function() {
        assert.doesNotMatch(listener, OLD_GATE);
        assert.doesNotMatch(active, OLD_GATE);
    });

    it('control: the raw source still carries the old predicate, as a comment', function() {
        // A strip that removed everything would make the negative pin pass vacuously.
        assert.match(raw, OLD_GATE);
        assert.match(raw, /#B1089/);
    });

    it('still resolves a missing group to `untagged` and answers an unknown group 400', function() {
        assert.match(listener, /var fileGroup\s*=\s*\(\s*typeof\(group\)\s*!=\s*'undefined'\s*&&\s*group\s*\)\s*\?\s*group\s*:\s*'untagged'/);
        assert.match(listener, /is not a configured upload group/);
    });
});

// ─── 02 — inline logic replica ────────────────────────────────────────────────
describe('02 - upload groups: own-property gate replica (#B1089)', function() {

    // mirror of the server.js busboy 'file' listener's group enforcement, post-#B1089
    function classifyUpload(group, opt, fileCount, fileExt) {
        var fileGroup = ( typeof(group) !== 'undefined' && group ) ? group : 'untagged';
        if ( typeof(opt.groups) === 'undefined' || !Object.prototype.hasOwnProperty.call(opt.groups, fileGroup) ) {
            return { action: 'deny-unconfigured', group: fileGroup };
        }
        var g = opt.groups[fileGroup];
        if ( typeof(g.allowedExtensions) !== 'undefined' && g.allowedExtensions !== '*' ) {
            var ext = g.allowedExtensions;
            if ( !Array.isArray(ext) ) ext = [ext];
            if ( ext.indexOf(fileExt) < 0 ) return { action: 'deny-ext', group: fileGroup };
        }
        if ( typeof(g.isMultipleAllowed) !== 'undefined' && !g.isMultipleAllowed && fileCount > 1 ) {
            return { action: 'deny-multiple', group: fileGroup };
        }
        return { action: 'allow', group: fileGroup };
    }

    // the drive's scene: `untagged` restricted to .txt
    var opt = { groups: {
        untagged: { allowedExtensions: ['txt'], isMultipleAllowed: true },
        avatars:  { allowedExtensions: ['jpg', 'png'], isMultipleAllowed: false }
    }};

    var protoNames = Object.getOwnPropertyNames(Object.prototype);

    it('the fixture enumerates the inherited names (twelve on Node.js and Bun, `__proto__` among them)', function() {
        assert.ok(protoNames.length >= 12, 'own names of Object.prototype: ' + protoNames.length);
        assert.ok(protoNames.indexOf('__proto__') > -1);
        assert.ok(protoNames.indexOf('constructor') > -1);
        assert.ok(protoNames.indexOf('hasOwnProperty') > -1);
    });

    it('control: the old predicate let every inherited name through', function() {
        protoNames.forEach(function(name) {
            assert.notEqual(typeof(opt.groups[name]), 'undefined', name + ' resolves through the prototype');
        });
    });

    protoNames.forEach(function(name) {
        it('denies `group="' + name + '"` as an unconfigured group', function() {
            assert.deepEqual(classifyUpload(name, opt, 1, 'bin'), { action: 'deny-unconfigured', group: name });
        });
    });

    it('denies `group="prototype"` too (not a member of Object.prototype: it was never a bypass)', function() {
        assert.equal(typeof(opt.groups.prototype), 'undefined');
        assert.deepEqual(classifyUpload('prototype', opt, 1, 'bin'), { action: 'deny-unconfigured', group: 'prototype' });
    });

    it('honours an own key whatever its name (JSON.parse makes `__proto__` an own key)', function() {
        var own = { groups: JSON.parse('{"__proto__": {"allowedExtensions": ["bin"]}, "untagged": {"allowedExtensions": ["txt"]}}') };
        assert.ok(Object.prototype.hasOwnProperty.call(own.groups, '__proto__'));
        assert.deepEqual(classifyUpload('__proto__', own, 1, 'bin'), { action: 'allow', group: '__proto__' });
    });

    it('a configured group still has its rules run', function() {
        assert.deepEqual(classifyUpload('untagged', opt, 1, 'bin'), { action: 'deny-ext', group: 'untagged' });
        assert.deepEqual(classifyUpload('untagged', opt, 1, 'txt'), { action: 'allow', group: 'untagged' });
        assert.deepEqual(classifyUpload(undefined, opt, 1, 'txt'), { action: 'allow', group: 'untagged' });
        assert.deepEqual(classifyUpload('avatars', opt, 2, 'png'), { action: 'deny-multiple', group: 'avatars' });
        assert.deepEqual(classifyUpload('nope', opt, 1, 'txt'), { action: 'deny-unconfigured', group: 'nope' });
    });

    it('a missing groups block denies everything', function() {
        assert.deepEqual(classifyUpload('untagged', {}, 1, 'txt'), { action: 'deny-unconfigured', group: 'untagged' });
    });
});
