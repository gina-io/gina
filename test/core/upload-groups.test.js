'use strict';
/**
 * Upload groups — #B50: deny unconfigured upload groups + enforce `untagged`'s own config
 *
 * Strategy: source inspection + inline logic replica. No live HTTP server, no
 * framework bootstrap, no project required (mirrors http-methods.test.js).
 *
 * Suites:
 *  01 — server.js source: group resolution + deny-unconfigured + untagged no longer hardcode-exempt
 *  02 — inline logic replica: classifyUpload (no-group->untagged, deny unconfigured, untagged enforced, ext/count)
 *  03 — shipped settings.json: untagged default ships isMultipleAllowed:true
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW           = require('../fw');
var SERVER_SRC   = path.join(FW, 'core/server.js');
var SETTINGS_TPL = path.join(FW, 'core/template/conf/settings.json');

// Strip full-line `//` comments so the negative pin does not trip on the
// commented-out old block (jsdoc.md: "a negative source-inspection pin trips on
// the file's own comment").
function stripLineComments(src) {
    return src.split('\n').filter(function(l) { return l.trim().indexOf('//') !== 0; }).join('\n');
}

// ─── 01 — server.js source: #B50 upload-group enforcement ─────────────────────
describe('01 - upload groups: server.js source pins (#B50)', function() {
    var active;
    before(function() {
        active = stripLineComments(fs.readFileSync(SERVER_SRC, 'utf8'));
    });

    it('resolves a missing group to the default `untagged`', function() {
        assert.match(active, /var fileGroup\s*=\s*\(\s*typeof\(group\)\s*!=\s*'undefined'\s*&&\s*group\s*\)\s*\?\s*group\s*:\s*'untagged'/);
    });

    it('denies an unconfigured upload group (400)', function() {
        // #B1089: an own key of opt.groups, not a name that resolves through Object.prototype
        assert.match(active, /!Object\.prototype\.hasOwnProperty\.call\(opt\.groups,\s*fileGroup\)/);
        assert.match(active, /is not a configured upload group/);
    });

    it('runs the extension + count checks against the resolved fileGroup', function() {
        assert.match(active, /opt\.groups\[fileGroup\]\.allowedExtensions/);
        assert.match(active, /opt\.groups\[fileGroup\]\.isMultipleAllowed/);
    });

    it('no longer hardcode-exempts `untagged` in active code', function() {
        // the only remaining `group != 'untagged'` lives in the commented-out old block
        assert.doesNotMatch(active, /group\s*!=\s*'untagged'/);
    });
});

// ─── 02 — inline logic replica ────────────────────────────────────────────────
describe('02 - upload groups: classification replica (#B50)', function() {

    // mirror of the server.js busboy 'file' handler group-enforcement logic
    function classifyUpload(group, opt, fileCount, fileExt) {
        var fileGroup = ( typeof(group) !== 'undefined' && group ) ? group : 'untagged';
        if ( typeof(opt.groups) === 'undefined' || !Object.prototype.hasOwnProperty.call(opt.groups, fileGroup) ) { // #B1089
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

    var opt = { groups: {
        untagged: { allowedExtensions: '*', isMultipleAllowed: true },
        avatars:  { allowedExtensions: ['jpg', 'png'], isMultipleAllowed: false }
    }};

    it('no group → resolves to untagged and is allowed', function() {
        assert.deepEqual(classifyUpload(undefined, opt, 1, 'png'), { action: 'allow', group: 'untagged' });
    });

    it('empty group → resolves to untagged', function() {
        assert.equal(classifyUpload('', opt, 1, 'png').group, 'untagged');
    });

    it('an unconfigured group name is denied', function() {
        assert.equal(classifyUpload('xyz', opt, 1, 'png').action, 'deny-unconfigured');
    });

    it('opt.groups missing → denied', function() {
        assert.equal(classifyUpload('untagged', {}, 1, 'png').action, 'deny-unconfigured');
    });

    it('untagged (default `*`) allows any extension', function() {
        assert.equal(classifyUpload('untagged', opt, 1, 'exe').action, 'allow');
    });

    it('untagged now ENFORCES its own isMultipleAllowed (was hardcode-bypassed)', function() {
        var strict = { groups: { untagged: { allowedExtensions: '*', isMultipleAllowed: false } } };
        assert.equal(classifyUpload('untagged', strict, 1, 'png').action, 'allow');
        assert.equal(classifyUpload('untagged', strict, 2, 'png').action, 'deny-multiple');
    });

    it('a configured group rejects a disallowed extension', function() {
        assert.equal(classifyUpload('avatars', opt, 1, 'exe').action, 'deny-ext');
    });

    it('a configured group allows a permitted extension', function() {
        assert.equal(classifyUpload('avatars', opt, 1, 'jpg').action, 'allow');
    });

    it('a single-only group rejects a second file', function() {
        assert.equal(classifyUpload('avatars', opt, 2, 'jpg').action, 'deny-multiple');
    });
});

// ─── 03 — shipped settings.json default ───────────────────────────────────────
describe('03 - upload groups: shipped untagged default (#B50)', function() {
    it('ships untagged with isMultipleAllowed:true (the permissive default)', function() {
        var text = fs.readFileSync(SETTINGS_TPL, 'utf8');
        assert.match(text, /"untagged":\s*\{[\s\S]*?"isMultipleAllowed":\s*true/);
    });
});
