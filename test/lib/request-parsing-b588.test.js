'use strict';
/**
 * #B588 / #B589 / #B592 — the urlencoded and document parsing contract of the
 * data helper (`formatDataFromString`) and its server call sites.
 *
 *   #B588  a urlencoded body was percent-decoded as a WHOLE (server site + helper),
 *          BEFORE the split on `&` and `=`, so an encoded `&` or `=` inside one value
 *          became a separator and could add or override any other field; a value was
 *          decoded up to four times (`100%2525` -> `100%`).
 *   #B589  a `{`-leading document (the GET/HEAD re-parse, `inheritedData`, and the
 *          browser validator's stringified form fields) was percent-decoded as a whole
 *          too, so a value whose TEXT held `%22`/`%0A`/`%5C` produced invalid JSON and
 *          the WHOLE input was dropped, while `%25`/`%20` text silently changed.
 *   #B592  a top-level `__proto__` key swapped the prototype of the RESULT object.
 *
 * Post-fix: the standard form algorithm — split on `&`, then at the FIRST `=`, decode
 * each key and value exactly ONCE, no decode at all on a document — plus the whole-key
 * guard. The quoted-token coercion (`"true"`/`"false"`/`"on"`/`"null"`) is a DOCUMENT
 * feature: it still applies to a `{`-leading input and to object input (the client
 * validator's contract), never to a urlencoded pair.
 *
 * Seams (red-first against `git show HEAD:` copies, no shared-tree touch):
 *   B588_DATA_SRC / B588_SERVER_SRC / B588_ISAAC_SRC
 *
 * Run standalone: node --test test/lib/request-parsing-b588.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var FW     = require('../fw');

var DATA_SRC   = process.env.B588_DATA_SRC   || path.join(FW, 'helpers', 'data', 'src', 'main.js');
var SERVER_SRC = process.env.B588_SERVER_SRC || path.join(FW, 'core', 'server.js');
var ISAAC_SRC  = process.env.B588_ISAAC_SRC  || path.join(FW, 'core', 'server.isaac.js');

// §05 drives lib/dto-pipe, whose validator engine needs the prototypes, the helper
// registry and a gina context (the test/lib/dto-pipe.test.js setup). They load BEFORE
// the seam, so the DATA_SRC copy is the formatDataFromString every arm — and the pipe — sees.
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', { forms: null }); }
setContext('bundle', 'b588TestBundle');

require(path.resolve(DATA_SRC))();                       // installs the implicit globals
var formatDataFromString = global.formatDataFromString;

var FORM = 'application/x-www-form-urlencoded';

/**
 * Faithful replica of what the POST/PUT/PATCH urlencoded sites do BEFORE handing the
 * body to the helper after #B588: the gated `+` -> space, the leading-`?` strip, and
 * nothing else (no whole-body decode, no quoted-token pass). §04 pins that shape.
 */
function serverUrlencodedSite(rawBody, contentType) {
    var body = rawBody;
    if ( /application\/x\-www\-form\-urlencoded/.test(contentType) && /\+/.test(body) ) {
        body = body.replace(/\+/g, ' ');
    }
    if ( body.substring(0, 1) == '?' ) { body = body.substring(1); }
    return formatDataFromString(body);
}

function codeOnly(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); })
              .map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

// the pre-fix document arms log [365]; keep the runner quiet
var origError = null;
before(function () { origError = console.error; console.error = function () {}; });
after(function () { console.error = origError; });


describe('01 - #B588: a urlencoded value is decoded exactly once, AFTER the split (real helper behind the new server site)', function () {

    it('P1  an encoded & inside a value is data, not a separator', function () {
        assert.deepEqual(serverUrlencodedSite('field=a%26b&other=1', FORM), { field: 'a&b', other: '1' });
    });

    it('P3  an encoded &/= in a LATER value can no longer override an earlier field', function () {
        assert.deepEqual(serverUrlencodedSite('role=user&bio=hi%26role%3Dadmin', FORM), { role: 'user', bio: 'hi&role=admin' });
    });

    it('P4  a genuine later field still wins (last wins is unchanged)', function () {
        assert.deepEqual(serverUrlencodedSite('bio=hi%26role%3Dadmin&role=user', FORM), { bio: 'hi&role=admin', role: 'user' });
    });

    it('P6  an encoded = inside a value is data — the pair splits at the FIRST raw =', function () {
        assert.deepEqual(serverUrlencodedSite('field=a%3Db&other=1', FORM), { field: 'a=b', other: '1' });
        assert.deepEqual(serverUrlencodedSite('token=YWJj%3D%3D&d=1', FORM), { token: 'YWJj==', d: '1' }, 'a base64 value keeps its padding');
    });

    it('P9  a value is decoded ONCE: a typed `100%25` (sent 100%2525) stays 100%25', function () {
        assert.deepEqual(serverUrlencodedSite('field=100%2525&other=1', FORM), { field: '100%25', other: '1' });
        assert.equal(serverUrlencodedSite('a=%2541', FORM).a, '%41', 'was decoded to "A" (twice)');
    });

    it('P2/P7/P8  the space, plus and percent controls are unchanged', function () {
        assert.equal(serverUrlencodedSite('field=a%20b', FORM).field, 'a b');
        assert.equal(serverUrlencodedSite('field=a%2Bb', FORM).field, 'a+b');
        assert.equal(serverUrlencodedSite('field=a+b', FORM).field, 'a b', '+ is a space on a urlencoded-labelled body');
        assert.equal(serverUrlencodedSite('field=a+b', 'text/plain').field, 'a+b', 'and stays a plus otherwise');
        assert.equal(serverUrlencodedSite('?a=1&b=2', FORM).a, '1', 'the leading ? strip is unchanged');
    });

    it('a malformed % in ONE value no longer changes how the OTHER values decode', function () {
        // pre-fix the whole-body decode threw and fell back to raw, so a malformed escape
        // anywhere switched decoding off for every field (then the per-part decodes ran)
        assert.deepEqual(serverUrlencodedSite('a=100%&b=x%26y', FORM), { a: '100%', b: 'x&y' });
        assert.deepEqual(serverUrlencodedSite('a=%E0%A&b=x%20y', FORM), { a: '%E0%A', b: 'x y' });
        // the discriminating pair: pre-fix the same `a` came out 'A' beside b=1 and '%41'
        // beside a malformed b (the whole-string decode either ran or threw)
        assert.equal(serverUrlencodedSite('a=%252541&b=1', FORM).a, '%2541');
        assert.equal(serverUrlencodedSite('a=%252541&b=100%', FORM).a, '%2541');
    });

    it('P11  bare true/false/on/null stay STRINGS on a urlencoded body (unchanged; the docs example was wrong)', function () {
        assert.deepEqual(serverUrlencodedSite('a=true&b=false&c=on&d=null&e=TRUE', FORM),
            { a: 'true', b: 'false', c: 'on', d: 'null', e: 'TRUE' });
    });

    it('P13  a quoted token in a value keeps its quotes (%22true%22 is six characters)', function () {
        var out = serverUrlencodedSite('a=%22true%22&b=1', FORM);
        assert.equal(out.a, '"true"');
        assert.equal(out.a.length, 6);
    });

    it('raw quoted tokens in free text are kept verbatim (hand-built bodies)', function () {
        assert.equal(serverUrlencodedSite('msg=Turn it "on" please, it is "null"', 'text/plain').msg, 'Turn it "on" please, it is "null"');
    });

    it('P12  bracket nesting, the [] shape, a value-less segment and an empty value are unchanged', function () {
        assert.deepEqual(serverUrlencodedSite('user%5Bname%5D=Alice&b%5B%5D=x&b%5B%5D=y&k&z=', FORM),
            { user: { name: 'Alice' }, b: { '': 'y' }, z: '' });
        assert.deepEqual(serverUrlencodedSite('a=1&a=2', FORM), { a: '2' }, 'repeated key: last wins');
        assert.deepEqual(serverUrlencodedSite('=1', FORM), { '': '1' });
    });

    it('a value that merely STARTS with { or [ and is not JSON is kept verbatim (was dropped)', function () {
        assert.deepEqual(serverUrlencodedSite('title=[DRAFT] Report&note={name}&f=a=[b]&ok=1', FORM),
            { title: '[DRAFT] Report', note: '{name}', f: 'a=[b]', ok: '1' });
    });

    it('a value containing "[object " is kept (was silently dropped)', function () {
        assert.deepEqual(serverUrlencodedSite('a=x[object Object]&b=1', FORM), { a: 'x[object Object]', b: '1' });
    });

    it('a JSON value still parses — raw, or percent-encoded once', function () {
        assert.deepEqual(serverUrlencodedSite('h={"k":"v=1"}&ok=1', FORM), { h: { k: 'v=1' }, ok: '1' }, 'a raw = inside the value is data');
        // a RAW & is a separator by the form algorithm, JSON or not — a sender must encode it
        assert.deepEqual(serverUrlencodedSite('h={"k":"v=1&w"}&ok=1', FORM), { h: '{"k":"v=1', ok: '1' });
        assert.deepEqual(serverUrlencodedSite('h=%7B%22k%22%3A%22v%22%7D&ok=1', FORM), { h: { k: 'v' }, ok: '1' });
        assert.deepEqual(serverUrlencodedSite('l=%5B1%2C2%5D', FORM), { l: [1, 2] });
    });

    it('D1  a JSON value inside a field is parsed as JSON — its quoted tokens are NOT cast (casting is a document feature)', function () {
        assert.deepEqual(serverUrlencodedSite('f=%7B%22t%22%3A%22true%22%2C%22n%22%3A%22null%22%2C%22o%22%3A%22on%22%7D&y=1', FORM),
            { f: { t: 'true', n: 'null', o: 'on' }, y: '1' }, 'was { t: true, n: null, o: true } (the site\'s whole-body text pass)');
        assert.deepEqual(serverUrlencodedSite('f=%7B%22t%22%3Atrue%2C%22n%22%3Anull%7D', FORM), { f: { t: true, n: null } }, 'real JSON types are unchanged');
    });

    it('D2  a JSON value under a bracket key nests like any other value (it was assigned under the literal key "items[0]")', function () {
        assert.deepEqual(serverUrlencodedSite('items%5B0%5D=%7B%22a%22%3A%221%22%7D&y=1', FORM), { items: [ { a: '1' } ], y: '1' });
    });

    it('D3  a RAW = inside a value is data — the pair splits at the FIRST = (it was cut at the second)', function () {
        assert.deepEqual(serverUrlencodedSite('a=b=c&d=1', FORM), { a: 'b=c', d: '1' });
        assert.deepEqual(serverUrlencodedSite('token=YWJj==&d=1', FORM), { token: 'YWJj==', d: '1' }, 'a raw base64 value keeps its padding');
    });

    it('D4  an encoded & or = inside a KEY is data — a key can no longer add or override a field either', function () {
        assert.deepEqual(serverUrlencodedSite('role=user&a%26role%3Dadmin=x', FORM), { role: 'user', 'a&role=admin': 'x' }, 'was { role: "admin" }');
        assert.deepEqual(serverUrlencodedSite('a%3Db=c', FORM), { 'a=b': 'c' });
    });

    it('a value-less {-leading segment is dropped like any value-less segment (it used to REPLACE the whole body)', function () {
        assert.deepEqual(serverUrlencodedSite('a=1&{"x":"y"}&c=3', FORM), { a: '1', c: '3' });
    });

    it('a percent-encoded bracket key still nests, and the #B446 encoded-key guard still fires', function () {
        assert.deepEqual(serverUrlencodedSite('user%5Bname%5D=Ada', FORM), { user: { name: 'Ada' } });
        serverUrlencodedSite('%5F%5Fproto%5F%5F[polluted]=OWNED', FORM);
        assert.strictEqual({}.polluted, undefined);
    });
});


describe('02 - #B589: a document is never percent-decoded (GET/HEAD re-parse, inheritedData, object input)', function () {

    it('G1/G2  a serialized value whose TEXT holds %0A or %22 keeps every parameter', function () {
        assert.deepEqual(formatDataFromString('{"x":"line %0A break","y":"1"}'), { x: 'line %0A break', y: '1' });
        assert.deepEqual(formatDataFromString('{"x":"say %22hi%22","y":"1"}'),   { x: 'say %22hi%22', y: '1' });
        assert.deepEqual(formatDataFromString('{"x":"C:%5Cpath","y":"1"}'),      { x: 'C:%5Cpath', y: '1' });
    });

    it('G3  percent text is not silently changed (100%2525 sure stays as typed)', function () {
        assert.deepEqual(formatDataFromString('{"x":"100%2525 sure"}'), { x: '100%2525 sure' });
        assert.deepEqual(formatDataFromString('{"x":"a%20b"}'), { x: 'a%20b' });
    });

    it('object input (the browser validator / DTO routes) keeps typed percent-escapes and never drops the set', function () {
        assert.deepEqual(formatDataFromString({ a: 'a%20b', b: '1' }), { a: 'a%20b', b: '1' });
        assert.deepEqual(formatDataFromString({ url: 'https://x/?q=say%22hi%22', other: 'kept' }), { url: 'https://x/?q=say%22hi%22', other: 'kept' });
    });

    it('PRESERVED: the quoted-token coercion still applies to documents and to object input', function () {
        assert.deepEqual(formatDataFromString('{"t":"true","f":"false","o":"on","n":"null","N":"NULL"}'),
            { t: true, f: false, o: true, n: null, N: null });
        assert.deepEqual(formatDataFromString({ t: 'true', n: 'null', s: 'kept' }), { t: true, n: null, s: 'kept' });
        assert.deepEqual(formatDataFromString('{"note":"it said \\"true\\" here"}'), { note: 'it said "true" here' }, 'an embedded escaped occurrence is not a token');
    });

    it('PRESERVED: bracket keys nest inside a document, and a fully percent-encoded document still parses', function () {
        assert.deepEqual(formatDataFromString('{"user[name]":"Ada","page":"2"}'), { user: { name: 'Ada' }, page: '2' });
        assert.deepEqual(formatDataFromString('%7B%22a%22%3A%221%22%2C%22t%22%3A%22true%22%7D'), { a: '1', t: true });
    });

    it('a document that is genuinely invalid still yields undefined (the disposition is unchanged)', function () {
        assert.equal(formatDataFromString('{"x":"a'), undefined);
    });
});


describe('03 - #B592: a top-level __proto__ / constructor / prototype key cannot swap the result\'s prototype', function () {

    it('urlencoded: a JSON-valued __proto__ pair is dropped, the prototype stays Object.prototype', function () {
        var out = serverUrlencodedSite('__proto__={"polluted":1}&a=1', FORM);
        assert.deepEqual(Object.keys(out), ['a']);
        assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
        assert.strictEqual(out.polluted, undefined);
        assert.strictEqual({}.polluted, undefined);
    });

    it('urlencoded: a plain-valued __proto__ / constructor / prototype pair is dropped too', function () {
        var out = serverUrlencodedSite('__proto__=x&constructor=y&prototype=z&a=1', FORM);
        assert.deepEqual(Object.keys(out), ['a']);
        assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
    });

    it('document: an own __proto__ key (JSON.parse produces one) is dropped', function () {
        var out = formatDataFromString('{"__proto__":{"polluted":1},"a":"1"}');
        assert.deepEqual(Object.keys(out), ['a']);
        assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
        assert.strictEqual(out.polluted, undefined);
    });

    it('CONTROL: look-alike keys are ordinary fields', function () {
        assert.deepEqual(serverUrlencodedSite('proto=1&__proto=2&constructor_id=3', FORM), { proto: '1', __proto: '2', constructor_id: '3' });
    });
});


describe('04 - source pins (comment-stripped; the `// was:` records cannot trip them)', function () {
    var helperRaw = fs.readFileSync(path.resolve(DATA_SRC), 'utf8'),  helperCode = codeOnly(helperRaw);
    var serverRaw = fs.readFileSync(path.resolve(SERVER_SRC), 'utf8'), serverCode = codeOnly(serverRaw);
    var isaacRaw  = fs.readFileSync(path.resolve(ISAAC_SRC), 'utf8'),  isaacCode  = codeOnly(isaacRaw);

    it('helpers/data: formatDataFromString neither decodes nor coerces — it stringifies object input and delegates', function () {
        var s = helperCode.indexOf('formatDataFromString = function');
        var e = helperCode.indexOf('var parseCollection', s);
        assert.ok(s > -1 && e > s, 'formatDataFromString body not isolatable');
        var body = helperCode.slice(s, e);
        assert.doesNotMatch(body, /decodeURIComponent/, 'the whole-string decode must not return');
        assert.doesNotMatch(body, /replace\(\/\\"false\\"\/g/, 'the quoted-token pass lives in the document branch now');
        assert.match(body, /JSON\.stringify\(bodyStr\)/);
        assert.match(body, /return parseBody\(bodyStr\)/);
        // anti-vacuity: the raw file still carries the retired line in its was: record
        assert.ok(helperRaw.indexOf('bodyStr = decodeURIComponent(bodyStr);') > -1);
    });

    it('helpers/data: the document branch coerces AFTER its %7B decode and BEFORE JSON.parse; the urlencoded branch never does', function () {
        var s = helperCode.indexOf('var parseBody = function');
        var docStart = helperCode.indexOf('if ( /^(\\{|\\[|\\%7B|\\%5B)/.test(body) )', s);
        var docEnd   = helperCode.indexOf('} else {', docStart);
        assert.ok(s > -1 && docStart > s && docEnd > docStart, 'document branch not isolatable');
        var doc = helperCode.slice(docStart, docEnd);
        var iDecode = doc.indexOf('decodeURIComponent(body)'), iCoerce = doc.indexOf('replace(/\\"false\\"/g'), iParse = doc.lastIndexOf('JSON.parse(body)');
        assert.ok(iDecode > -1 && iCoerce > iDecode && iParse > iCoerce, 'order: %7B decode < coercion < JSON.parse — got ' + [iDecode, iCoerce, iParse]);
        var urlencoded = helperCode.slice(docEnd, helperCode.indexOf('var parseLocalObj', docEnd));
        assert.doesNotMatch(urlencoded, /replace\(\/\\"false\\"\/g/, 'no coercion on urlencoded pairs');
        assert.doesNotMatch(urlencoded, /\/\\\[object \//, 'the [object skip is gone');
        assert.match(urlencoded, /indexOf\('='\)/, 'the pair splits at the FIRST =');
    });

    it('server.js: the three urlencoded sites hand the body over verbatim (no live whole-body decode, no coercion pass)', function () {
        var verbatim = serverCode.match(/bodyStr = request\.body;/g) || [];
        assert.equal(verbatim.length, 3, 'POST + PUT + PATCH');
        assert.doesNotMatch(serverCode, /bodyStr = decodeURIComponent\(request\.body\)/, 'the whole-body decode must not return');
        // the quoted-token pass survives ONLY on the GET/HEAD document sites (case-insensitive form) and the object-body branches
        var live = serverCode.match(/\.replace\(\/\\"false\\"\/g, false\)/g) || [];
        assert.equal(live.length, 3, 'the three object-body branches keep theirs; the three string sites lost theirs — got ' + live.length);
        assert.ok(serverRaw.indexOf('bodyStr = decodeURIComponent(request.body)') > -1, 'anti-vacuity: the was: records name the retired line');
        // #B28 untouched: the JSON fallbacks still decode
        assert.equal((serverCode.match(/JSON\.parse\(decodeURIComponent\(request\.body\)\)/g) || []).length, 3);
    });

    it('server.isaac.js: both query branches decode the KEY once beside the value', function () {
        assert.equal((isaacCode.match(/safeDecodeURIComponent\(a\[0\]\)/g) || []).length, 2);
        assert.equal((isaacCode.match(/safeDecodeURIComponent\(a\[1\]\)/g) || []).length, 2, 'the #B30 value decodes are untouched');
        assert.doesNotMatch(isaacCode, /(?<![A-Za-z])decodeURIComponent\(a\[1\]\)/);
    });
});


describe('05 - #B589 on a route declaring a DTO: the validated payload is never re-decoded (lib/dto-pipe → the validator → this helper)', function () {
    var pipe = require(path.join(FW, 'lib', 'dto-pipe', 'src', 'main.js'));
    var dto  = require(path.join(FW, 'lib', 'dto', 'src', 'main.js'));
    dto.object({ q: dto.string().required(), c: dto.string() }, 'B589PipeProbe');

    /** One request through the pipe, the way router.js dispatches it (test/lib/dto-pipe.test.js shape). */
    function drive(post) {
        var ctl = { thrown: null, throwError: function (e) { ctl.thrown = e; return false; } };
        var r   = { method: 'POST', routing: { rule: 'b589', param: { dto: 'B589PipeProbe' } }, body: {}, post: post };
        var ok  = pipe.validateRequestPayload(ctl, r, {});
        return { ok: ok, post: r.post, thrown: ctl.thrown };
    }

    it('a JSON body value holding %20 reaches the action as sent (it was decoded to a space)', function () {
        var out = drive({ q: 'a%20b', c: 'plain' });
        assert.equal(out.ok, true, 'the pipe must validate: ' + JSON.stringify(out.thrown));
        assert.deepEqual(out.post, { q: 'a%20b', c: 'plain' });
    });

    it('a JSON body value holding %22 no longer leaves the action with NO payload (req.post came back undefined)', function () {
        var out = drive({ q: 'say %22hi%22', c: 'plain' });
        assert.equal(out.ok, true, 'the pipe must validate: ' + JSON.stringify(out.thrown));
        assert.deepEqual(out.post, { q: 'say %22hi%22', c: 'plain' });
    });
});
