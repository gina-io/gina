'use strict';
/**
 * #B1129 (F1b) — a protocol-relative `X-Forwarded-Prefix` is refused.
 *
 * The isaac engine turns the `X-Forwarded-Prefix` request header into the
 * per-request slot `request._ginaProxyPrefix`, and the controller composes the
 * public webroot from it (`prefix + '/' + server.webroot`). That webroot is
 * whispered into the client loader as `window.__ginaWebroot` /
 * `gina.config.webroot`, and the browser builds requests from it: the routing
 * table fetch (`<webroot>_gina/assets/routing.json`, on every page load) and the
 * gina stylesheet link. The #B367 charset gate admits `/`, so a value opening
 * with two slashes passed it: `//evil.example` became the webroot
 * `//evil.example/web/`, which a browser resolves against ANOTHER host. Combined
 * with the shared-layout render race of the same ticket, one client's header
 * reached other clients' pages, whose browsers then installed a routing table
 * served by that host.
 *
 * Sections:
 *   01 — source pin: the prefix block refuses a value opening with two slashes
 *        (comment-stripped, with an anti-vacuity control).
 *   02 — the SHIPPED prefix block, extracted from server.isaac.js and executed:
 *        protocol-relative values leave no slot; legitimate prefixes keep
 *        theirs; the #B367 refusals still hold (proof the extraction runs the
 *        real gate).
 *   03 — the SHIPPED webroot composition, extracted from controller.js and
 *        executed on each slot: every accepted value resolves to the page's own
 *        origin; CONTROL — the same composition on a raw `//evil.example` slot
 *        resolves to evil.example (the instrument can see a foreign origin).
 *
 * Red-first: `GINA_ISAAC_SRC=<pre-fix server.isaac.js> node --test <this file>`
 * runs 01 and 02 against the pre-fix bytes (03 reads controller.js, which this
 * fix does not change; its accepted-values arm goes red through 02's slots).
 */

var assert   = require('node:assert/strict');
var fs       = require('fs');
var path     = require('path');
var describe = require('node:test').describe;
var it       = require('node:test').it;

var FW = require('../fw');
// Module-path seam: point the whole file at a pre-change copy of the engine.
var ISAAC_SOURCE = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var isaacSrc = fs.readFileSync(ISAAC_SOURCE, 'utf8');
var ctrlSrc  = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');

var BLOCK_OPENER = "if (request.headers['x-forwarded-prefix']) {";
var COMPOSE_START = 'var _publicWebroot = options.conf.server.webroot;';
var COMPOSE_END   = "set('page.environment.webroot', _publicWebroot);";

/**
 * Drop full-line `//` comments (the block's prose names the very tokens a pin reads).
 *
 * @inner
 * @param {string} s - Source text
 * @returns {string} The text without full-line comments
 */
function stripLineComments(s) {
    return s.replace(/^[ \t]*\/\/[^\n]*/mg, '');
}

/**
 * The shipped x-forwarded-prefix block, from its opener to its matching brace.
 * Full-line comments are dropped before the brace walk, so a brace in prose
 * cannot end the block early; the code itself holds no brace inside a string or
 * a regex literal (checked by the balance assertion).
 *
 * @inner
 * @param {string} src - server.isaac.js source
 * @returns {string} The block, comment-stripped
 */
function prefixBlock(src) {
    var i = src.indexOf(BLOCK_OPENER);
    assert.ok(i > -1, 'x-forwarded-prefix block opener not found');
    assert.equal(src.indexOf(BLOCK_OPENER, i + 1), -1, 'the block opener must be unique');
    var rest = stripLineComments(src.slice(i));
    var depth = 0, j = 0;
    for (; j < rest.length; j++) {
        if (rest[j] === '{') { depth++; }
        else if (rest[j] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, 'the block braces do not balance');
    return rest.slice(0, j + 1);
}

/**
 * Runs the shipped block on one header value and returns the slot it leaves.
 *
 * @inner
 * @param {string} block - The extracted block
 * @param {string} value - The X-Forwarded-Prefix header value
 * @returns {string|undefined} `request._ginaProxyPrefix`
 */
function slotFor(block, value) {
    var request = { headers: { 'x-forwarded-prefix': value } };
    new Function('request', block)(request);
    return request._ginaProxyPrefix;
}

/**
 * The shipped public-webroot composition from controller.js, executed on one slot.
 *
 * @inner
 * @param {string|undefined} slot - `request._ginaProxyPrefix`
 * @param {string} internal - The bundle's `server.webroot`
 * @returns {string} The whispered `page.environment.webroot`
 */
function composeWebroot(slot, internal) {
    var i = ctrlSrc.indexOf(COMPOSE_START);
    var j = ctrlSrc.indexOf(COMPOSE_END, i);
    assert.ok(i > -1 && j > i, 'webroot composition anchors not found in controller.js');
    var code = ctrlSrc.slice(i, j + COMPOSE_END.length);
    var out = {};
    new Function('options', 'local', 'set', code)(
        { conf: { server: { webroot: internal } } },
        { req: ( typeof(slot) == 'undefined' ) ? {} : { _ginaProxyPrefix: slot } },
        function (k, v) { out[k] = v; }
    );
    return out['page.environment.webroot'];
}

/**
 * The origin a browser on https://app.example/page fetches the routing table from.
 *
 * @inner
 * @param {string} webroot - The whispered webroot
 * @returns {string} The resolved origin
 */
function routingFetchOrigin(webroot) {
    return new URL(webroot + '_gina/assets/routing.json', 'https://app.example/page').origin;
}

var REFUSED = [
    '//evil.example',
    '//evil.example/',
    '//evil.example/app',
    '///evil.example',
    '  //evil.example  ',
    '//'
];

var ACCEPTED = [
    ['/admin', '/admin'],
    ['admin', '/admin'],
    ['/app/v1/', '/app/v1'],
    ['/a//b', '/a//b'],
    ['/%2F%2Fevil.example', '/%2F%2Fevil.example'],
    ['/~user', '/~user']
];

describe('01 - #B1129 F1b source pin', function () {

    var block = prefixBlock(isaacSrc);

    it('anti-vacuity: the extracted block still holds the #B367 charset gate and the slot write', function () {
        assert.ok(block.indexOf('_xfp.length > 255') > -1, 'the charset gate must be inside the extracted block');
        assert.ok(block.indexOf('request._ginaProxyPrefix = _xfp;') > -1, 'the slot write must be inside the extracted block');
    });

    it('the block refuses a value whose first two characters are slashes', function () {
        assert.ok(block.indexOf("_xfp.charAt(0) === '/' && _xfp.charAt(1) === '/'") > -1,
            'expected the protocol-relative refusal in the x-forwarded-prefix block');
    });
});

describe('02 - #B1129 F1b the shipped prefix block, executed', function () {

    var block = prefixBlock(isaacSrc);

    REFUSED.forEach(function (value) {
        it('refuses ' + JSON.stringify(value) + ' (no slot: the internal webroot stays)', function () {
            assert.equal(slotFor(block, value), undefined);
        });
    });

    ACCEPTED.forEach(function (pair) {
        it('CONTROL - keeps ' + JSON.stringify(pair[0]) + ' as ' + JSON.stringify(pair[1]), function () {
            assert.equal(slotFor(block, pair[0]), pair[1]);
        });
    });

    it('CONTROL - the #B367 refusals still hold (the extraction runs the real gate)', function () {
        ["/a'", '/a"', '/a<b>', '/a evil'].forEach(function (value) {
            assert.equal(slotFor(block, value), undefined, JSON.stringify(value));
        });
    });
});

describe('03 - #B1129 F1b the composed webroot stays on the page origin', function () {

    var block = prefixBlock(isaacSrc);

    it('every accepted or refused value composes a webroot the browser resolves to the page origin', function () {
        REFUSED.concat(ACCEPTED.map(function (p) { return p[0]; })).forEach(function (value) {
            var webroot = composeWebroot(slotFor(block, value), '/web/');
            assert.equal(routingFetchOrigin(webroot), 'https://app.example',
                JSON.stringify(value) + ' composed ' + JSON.stringify(webroot));
        });
    });

    it('a refused value falls back to the internal webroot exactly', function () {
        assert.equal(composeWebroot(slotFor(block, '//evil.example'), '/web/'), '/web/');
    });

    it('CONTROL - a raw protocol-relative slot composes a webroot the browser resolves to ANOTHER origin', function () {
        var webroot = composeWebroot('//evil.example', '/web/');
        assert.equal(webroot, '//evil.example/web/');
        assert.equal(routingFetchOrigin(webroot), 'https://evil.example');
    });
});
