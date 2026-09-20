'use strict';
/**
 * lib/loading-state — framework-owned loading state for submit-like triggers (#B247, slice 1)
 *
 * A submit-like trigger carries `data-gina-loading="true"` while the action it started is
 * running and `"false"` once that action completes OR is interrupted. The primitive is
 * stateless: it resolves the configured attribute NAME, writes the two values, and walks a
 * click target up to the trigger that owns it. Callers decide what is armed and remember it.
 *
 * Two contracts carry real risk and are pinned hard below:
 *
 *  - `disarm()` writes the STRING "false" instead of removing the attribute (an explicit
 *    divergence from `data-gina-form-loading`, which #B175 moved the other way). That makes
 *    a disarmed trigger attribute-PRESENT, so every reader must match on the VALUE. §03
 *    proves a bare presence check is wrong, and that `isArmed` is not one.
 *  - the attribute name is read LAZILY from `gina.config.loadingAttribute` on every call,
 *    because `gina.config` is populated after the bundle loads. §02 proves the read is not
 *    cached at definition time — a captured-once implementation passes a naive test and
 *    fails this one.
 *
 * Strategy: unlike the validator's closure-private helpers (which force the jsdom + replica +
 * source-pin idiom), this module is dual-published, so node can `require()` the SHIPPED code
 * and assert its real behaviour against a real jsdom DOM. §00 validates the instrument first;
 * §05 pins the bundle wiring, which is invisible to behaviour but is what actually ships the
 * module to a browser.
 */

var { describe, it, before, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW = require('../fw');
var LS = path.join(FW, 'lib/loading-state/src/main.js');

var loadingState = require(LS);

var BUILD_PATH     = path.join(FW, 'core/asset/plugin/src/vendor/gina/build.json');
var BUILD_DEV_PATH = path.join(FW, 'core/asset/plugin/src/vendor/gina/build.dev.json');
var CORE_PATH      = path.join(FW, 'core/asset/plugin/src/vendor/gina/core.js');
var VALIDATOR_PATH = path.join(FW, 'core/plugins/lib/validator/src/main.js');

var buildSrc, buildDevSrc, coreSrc, validatorSrc, lsSrc;

before(function () {
    buildSrc     = fs.readFileSync(BUILD_PATH, 'utf8');
    buildDevSrc  = fs.readFileSync(BUILD_DEV_PATH, 'utf8');
    coreSrc      = fs.readFileSync(CORE_PATH, 'utf8');
    validatorSrc = fs.readFileSync(VALIDATOR_PATH, 'utf8');
    lsSrc        = fs.readFileSync(LS, 'utf8');
});


var dom, document;

function mount(html) {
    dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
    document = dom.window.document;
    return document;
}

beforeEach(function () {
    // `getAttributeName` reads the global `gina`; keep every test starting from "unset".
    delete global.gina;
});

afterEach(function () {
    delete global.gina;
});


describe('00 - instrument', function () {

    it('the module under test is the SHIPPED file, and it really exports the API', function () {
        assert.ok(fs.existsSync(LS), 'lib/loading-state/src/main.js must exist at ' + LS);
        ['arm', 'disarm', 'isArmed', 'getAttributeName', 'resolveTrigger'].forEach(function (k) {
            assert.equal(typeof(loadingState[k]), 'function', k + ' must be exported as a function');
        });
    });

    it('the jsdom probe can BOTH fire and not-fire (a control that cannot fail is not a control)', function () {
        var d = mount('<button id="b" type="submit">Save</button>');
        var $b = d.getElementById('b');

        assert.equal($b.getAttribute('data-gina-loading'), null, 'known-negative: absent before arming');
        loadingState.arm($b);
        assert.equal($b.getAttribute('data-gina-loading'), 'true', 'known-positive: present after arming');
    });
});


describe('01 - arm / disarm write the two values', function () {

    it('arm writes "true"', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        assert.equal(loadingState.arm($b), true, 'arm reports it wrote');
        assert.equal($b.getAttribute('data-gina-loading'), 'true');
    });

    it('disarm writes the STRING "false" — it does NOT remove the attribute', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        loadingState.arm($b);
        assert.equal(loadingState.disarm($b), true, 'disarm reports it wrote');

        assert.equal($b.getAttribute('data-gina-loading'), 'false', 'value is the string "false"');
        assert.equal($b.hasAttribute('data-gina-loading'), true,
            'attribute stays PRESENT — this is the deliberate divergence from data-gina-form-loading (#B175)');
    });

    it('both are idempotent', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        loadingState.arm($b);
        loadingState.arm($b);
        assert.equal($b.getAttribute('data-gina-loading'), 'true');
        loadingState.disarm($b);
        loadingState.disarm($b);
        assert.equal($b.getAttribute('data-gina-loading'), 'false');
    });

    it('disarming a trigger that was never armed is a harmless write, not a throw', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        assert.doesNotThrow(function () { loadingState.disarm($b); });
        assert.equal($b.getAttribute('data-gina-loading'), 'false');
    });

    it('a non-element is a silent no-op — handlers must never throw on a stale/absent node', function () {
        [null, undefined, {}, 'button', 42, [] ].forEach(function (bad) {
            assert.equal(loadingState.arm(bad), false, 'arm(' + JSON.stringify(bad) + ') no-ops');
            assert.equal(loadingState.disarm(bad), false, 'disarm(' + JSON.stringify(bad) + ') no-ops');
            assert.equal(loadingState.isArmed(bad), false, 'isArmed(' + JSON.stringify(bad) + ') no-ops');
        });
    });
});


describe('02 - the attribute name is configurable, and read LAZILY', function () {

    it('defaults to data-gina-loading when gina.config is absent', function () {
        assert.equal(loadingState.getAttributeName(), 'data-gina-loading');
        assert.equal(loadingState.DEFAULT_ATTRIBUTE, 'data-gina-loading');
    });

    it('honours gina.config.loadingAttribute', function () {
        global.gina = { config: { loadingAttribute: 'data-loading' } };
        assert.equal(loadingState.getAttributeName(), 'data-loading');

        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        loadingState.arm($b);
        assert.equal($b.getAttribute('data-loading'), 'true', 'writes the configured name');
        assert.equal($b.hasAttribute('data-gina-loading'), false,
            'and ONLY that name — writing both would stack a consumer spinner on gina\'s own');
    });

    it('the read is NOT cached at definition time — config set AFTER load still applies', function () {
        // The failure this guards: `var attr = gina.config.loadingAttribute || DEFAULT` evaluated
        // once at module scope. gina.config is populated post-load via setOptions, so a cached
        // read is always the default and the config key silently does nothing.
        assert.equal(loadingState.getAttributeName(), 'data-gina-loading', 'default first');

        global.gina = { config: { loadingAttribute: 'data-loading' } };
        assert.equal(loadingState.getAttributeName(), 'data-loading', 'picked up without a reload');

        global.gina.config.loadingAttribute = 'data-busy';
        assert.equal(loadingState.getAttributeName(), 'data-busy', 're-read on every call');
    });

    it('falls back to the default for empty / non-string / partial config', function () {
        [
            { label: 'empty string',   gina: { config: { loadingAttribute: '' } } },
            { label: 'non-string',     gina: { config: { loadingAttribute: 42 } } },
            { label: 'null',           gina: { config: { loadingAttribute: null } } },
            { label: 'no such key',    gina: { config: {} } },
            { label: 'no config',      gina: {} }
        ].forEach(function (c) {
            global.gina = c.gina;
            assert.equal(loadingState.getAttributeName(), 'data-gina-loading', c.label);
        });
    });
});


describe('03 - isArmed matches the VALUE, never presence', function () {

    it('true only while armed', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');

        assert.equal(loadingState.isArmed($b), false, 'never armed');
        loadingState.arm($b);
        assert.equal(loadingState.isArmed($b), true, 'armed');
        loadingState.disarm($b);
        assert.equal(loadingState.isArmed($b), false, 'disarmed');
    });

    it('SUBTRACT: a presence check — the mistake this attribute shape invites — reads a disarmed trigger as loading', function () {
        var $b = mount('<button id="b" type="submit">Save</button>').getElementById('b');
        loadingState.arm($b);
        loadingState.disarm($b);

        // What a consumer writing `[data-gina-loading]` or `if (el.getAttribute(...))` gets:
        assert.equal(!!$b.getAttribute('data-gina-loading'), true,
            'presence/truthiness says LOADING on a disarmed trigger — this is why docs must say [data-gina-loading="true"]');
        // What isArmed gets:
        assert.equal(loadingState.isArmed($b), false, 'isArmed disagrees, correctly');
    });

    it('gina\'s own source never presence-checks the attribute', function () {
        // The guardrail from the design: the framework must not read this attribute for truthiness.
        var reads = lsSrc.match(/getAttribute\(getAttributeName\(\)\)/g) || [];
        assert.equal(reads.length, 1, 'exactly one read site (isArmed)');
        assert.ok(/getAttribute\(getAttributeName\(\)\)\s*===\s*ARMED/.test(lsSrc),
            'the only read compares === ARMED rather than testing truthiness');
    });
});


describe('04 - resolveTrigger climbs to the owning trigger', function () {

    it('returns the trigger itself when the trigger was clicked', function () {
        var d = mount('<form id="f"><button id="b" type="submit">Save</button></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('b'), d.getElementById('f')).id, 'b');
    });

    it('climbs from a wrapped label to the <button> — the common markup the click proxy misses', function () {
        var d = mount('<form id="f"><button id="b" type="submit"><span id="s">Save</span></button></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f')).id, 'b',
            'the state belongs on the button the user sees, not the inner span');
    });

    it('climbs from a nested node to an <a data-gina-form-submit>', function () {
        var d = mount('<form id="f"><a id="a" data-gina-form-submit="true"><span id="s"><i id="i">Go</i></span></a></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('i'), d.getElementById('f')).id, 'a');
    });

    it('recognises <input type="submit">', function () {
        var d = mount('<form id="f"><input id="i" type="submit" value="Save"></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('i'), d.getElementById('f')).id, 'i');
    });

    it('a bare <a> without data-gina-form-submit is NOT a trigger', function () {
        var d = mount('<form id="f"><a id="a" href="#"><span id="s">Go</span></a></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f')).id, 's',
            'falls back to the element it was handed');
    });

    it('stops at the boundary and never escapes the form', function () {
        var d = mount('<button id="outer" type="submit">Outer</button><form id="f"><span id="s">x</span></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f')).id, 's',
            'must not climb past the form and grab an unrelated submit button');
    });

    it('stops at <form> even without an explicit boundary', function () {
        var d = mount('<button id="outer" type="submit">Outer</button><form id="f"><span id="s">x</span></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s')).id, 's');
    });

    it('returns null for a non-element', function () {
        assert.equal(loadingState.resolveTrigger(null), null);
        assert.equal(loadingState.resolveTrigger(undefined), null);
    });

    it('terminates on a detached subtree (runaway guard)', function () {
        var d = mount('<div id="d"></div>');
        var $orphan = d.createElement('span');
        var $child  = d.createElement('em');
        $orphan.appendChild($child);
        assert.doesNotThrow(function () { loadingState.resolveTrigger($child); });
    });
});


describe('04b - resolveTrigger accepts a caller-supplied predicate (slice 2 blocker)', function () {

    // The default predicate recognises submit-like controls ONLY. link arms
    // `a[data-gina-link]` and popin arms `a[data-gina-dialog]`; neither matches, so
    // before this parameter existed the climb fell through to `form|body|html` and
    // returned the ORIGINAL clicked node — arming an inner <span> and leaving the
    // anchor unstyled. The predicate is the caller's because each plugin owns its
    // own notion of a trigger, and popin's set is about to change under the
    // deprecation/alias work.

    var isLink = function ($n) {
        return !!($n && $n.tagName && /^a$/i.test($n.tagName)
            && $n.getAttribute('data-gina-link') != null);
    };

    it('climbs to an <a data-gina-link> from a nested node', function () {
        var d = mount('<a id="a" data-gina-link="/x"><span id="s"><i id="i">Go</i></span></a>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('i'), null, isLink).id, 'a');
    });

    it('SUBTRACT: the SAME DOM without the predicate returns the clicked span — this is the defect the parameter fixes', function () {
        var d = mount('<a id="a" data-gina-link="/x"><span id="s"><i id="i">Go</i></span></a>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('i'), null).id, 'i',
            'the default predicate cannot see a link trigger; without the 3rd arg the span is armed');
    });

    it('works for popin\'s shape too — the predicate is the extension point, not a hardcoded list', function () {
        var isDialog = function ($n) {
            return !!($n && $n.tagName && /^a$/i.test($n.tagName)
                && $n.getAttribute('data-gina-dialog') != null);
        };
        var d = mount('<a id="a" data-gina-dialog="/x"><span id="s">Open</span></a>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), null, isDialog).id, 'a');
    });

    it('the default is UNCHANGED when no predicate is passed — submit shapes still resolve', function () {
        var d = mount('<form id="f"><button id="b" type="submit"><span id="s">Save</span></button></form>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f')).id, 'b');
    });

    it('a non-function 3rd arg falls back to the default rather than throwing', function () {
        var d = mount('<form id="f"><button id="b" type="submit"><span id="s">Save</span></button></form>');
        [null, undefined, 'nope', 42, {}].forEach(function (bad) {
            assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f'), bad).id, 'b',
                'a bad predicate must degrade to the documented default, not break the click handler');
        });
    });

    it('a predicate that never matches still terminates and returns the element it was handed', function () {
        var d = mount('<div id="d"><span id="s"><i id="i">x</i></span></div>');
        var never = function () { return false; };
        assert.equal(loadingState.resolveTrigger(d.getElementById('i'), null, never).id, 'i');
    });

    it('the boundary still wins over a matching ancestor outside it', function () {
        var d = mount('<a id="outer" data-gina-link="/x"><form id="f"><span id="s">x</span></form></a>');
        assert.equal(loadingState.resolveTrigger(d.getElementById('s'), d.getElementById('f'), isLink).id, 's',
            'a custom predicate must not be able to climb past the caller\'s boundary');
    });

    it('a THROWING predicate propagates — deliberately not swallowed', function () {
        var d = mount('<div id="d"><span id="s">x</span></div>');
        var boom = function () { throw new Error('caller bug'); };
        assert.throws(function () {
            loadingState.resolveTrigger(d.getElementById('s'), null, boom);
        }, /caller bug/,
            'all three callers are framework code; swallowing would hide a framework bug behind a silently unarmed trigger');
    });
});


describe('05 - bundle + validator wiring', function () {

    it('build.json carries the lib/loading-state alias', function () {
        assert.ok(buildSrc.indexOf('"lib/loading-state"') > -1, 'alias key missing from build.json');
        assert.ok(buildSrc.indexOf('lib/loading-state/src/main') > -1, 'alias target missing from build.json');
    });

    it('build.dev.json carries the SAME alias — the paths maps must stay identical', function () {
        assert.ok(buildDevSrc.indexOf('"lib/loading-state"') > -1, 'alias key missing from build.dev.json');
        assert.ok(buildDevSrc.indexOf('lib/loading-state/src/main') > -1, 'alias target missing from build.dev.json');
    });

    it('core.js requires lib/loading-state — r.js traces from `core`, an alias nothing requires never bundles', function () {
        assert.ok(coreSrc.indexOf('"lib/loading-state"') > -1, 'module id missing from the core.js require array');
    });

    it('the validator resolves it on BOTH sides of isGFFCtx and declares it as an AMD dep', function () {
        assert.ok(/var loadingState\s*=\s*\(isGFFCtx\)\s*\?\s*require\('lib\/loading-state'\)\s*:\s*require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/loading-state'\)/.test(validatorSrc),
            'the browser/node require dispatch is missing or malformed');
        assert.ok(/define\('gina\/validator',\s*\[[^\]]*'lib\/loading-state'[^\]]*\]/.test(validatorSrc),
            'lib/loading-state missing from the validator AMD dep array');
    });

    it('the UMD tail publishes on both sides', function () {
        assert.ok(/module\.exports\s*=\s*LoadingState\(\)/.test(lsSrc), 'CommonJS branch missing');
        assert.ok(/define\('lib\/loading-state',\s*function\(\)\s*\{\s*return LoadingState\(\)\s*\}\)/.test(lsSrc), 'AMD branch missing');
    });
});


describe('06 - validator arm/disarm call sites (source pins)', function () {

    // These pin the wiring the behavioural tests above cannot reach: the arm/disarm calls live
    // inside `ValidatorPlugin`'s closure and its browser-only branches, which node cannot enter.

    it('arms on the click path AFTER the #B246 disabled gate, never before', function () {
        var gate = validatorSrc.indexOf('isTriggerDisabled($el)');
        assert.ok(gate > -1, '#B246 gate not found');

        // Searched FROM the gate on purpose: the same call shape also appears earlier in
        // `armSubmitLoading`'s JSDoc @example, and anchoring on that doc comment made this
        // pin read "arm before gate" while the shipped call site was correctly after it.
        // Offset search means the result is either -1 (arm is NOT after the gate) or > gate.
        var arm = validatorSrc.indexOf('loadingState.resolveTrigger($el, $target)', gate);
        assert.ok(arm > gate,
            'the click-path arm must sit AFTER the #B246 disabled gate — arming before it would strand the state on a click that starts nothing');
    });

    it('arms on the native submit proxy for Enter-key / programmatic / wrapped-label submits', function () {
        assert.ok(/armSubmitLoading\(\s*\$formInstance,\s*\$loadingTrigger\s*\)/.test(validatorSrc),
            'native-submit-proxy arm not found');
        assert.ok(/if\s*\(\s*!isTriggerDisabled\(\$loadingTrigger\)\s*\|\|\s*isAwaitingQueryVerdictOnly\(\$loadingTrigger,\s*\$target,\s*\$formInstance\)\s*\)/.test(validatorSrc),
            'the live-node disabled re-check is missing — an aria-disabled trigger would flash armed '
            + '(the #B346 pending carve-out is the only sanctioned widening, and its own arms refuse authored marks)');
    });

    it('disarms on exactly the four terminal paths — and NOWHERE else', function () {
        // 1 JSDoc @example + 4 call sites. The count is the guard: a further release added
        // without thinking about in-flight ownership is how the mid-flight-clear bug returns.
        // It earned its keep at #gh76 slice 2, catching path (d) below releasing unconditionally.
        var sites = validatorSrc.match(/disarmSubmitLoading\(/g) || [];
        assert.equal(sites.length, 5,
            'expected the JSDoc example plus exactly 4 disarm call sites, found ' + sites.length);

        // (a) validation-rejected — the #B247 motivating path, which never reaches an XHR
        assert.ok(/disarmSubmitLoading\(_loadingForm\)/.test(validatorSrc),
            'validation-rejected disarm missing');
        // (b) loadend — covers success, error, timeout and abort alike  (c) readyState 4
        var settles = validatorSrc.match(/\$form\.target\.removeAttribute\('data-gina-form-loading'\);\n\s*\/\/ #B247[\s\S]{0,300}?disarmSubmitLoading\(\$form\)/g) || [];
        assert.equal(settles.length, 2, 'expected the loadend + readyState-4 disarms, found ' + settles.length);
        // (d) pre-send refusal (#gh76 slice 2) — a declared `data-gina-form-target` / `-swap`
        //     that cannot be honoured, refused before xhr.open. Gated on ownership: with
        //     `withRateLimit: false` a second attempt can be refused while the first is still
        //     running, and both the release and `isSending` belong to that first request.
        assert.ok(/if \( !ownedByEarlierSend \) \{[\s\S]{0,400}?disarmSubmitLoading\(\$form\);\n\s*\}/.test(validatorSrc),
            'the pre-send refusal release must be gated on ownership, or a refused later attempt '
            + 'clears the running request\'s loading state');
    });

    it('arming is FIRST-WINS — a second attempt mid-flight must not steal the stash', function () {
        // Without this, a multi-submit form re-arms onto the trigger whose submit the rate
        // limiter is about to refuse, and the trigger holding the real request strands.
        assert.ok(/if\s*\(\$formInstance\.loadingTrigger\)\s*\{\s*return false;/.test(validatorSrc),
            'armSubmitLoading must no-op while a trigger is already armed for this form');
    });

    it('the rejected path releases ONLY when nothing is in flight', function () {
        assert.ok(/if\s*\(\s*!\/\^true\$\/i\.test\(_loadingForm\.isSending\)\s*\)/.test(validatorSrc),
            'the rejected-path release must be gated on isSending, or a later failed attempt clears the running request\'s state');
    });

    it('send()\'s rate-limit early return does NOT release — the in-flight trigger still owns it', function () {
        var rl = validatorSrc.indexOf('// #B247 — deliberately NO loading-state release here.');
        assert.ok(rl > -1, 'the rate-limit rationale comment is missing');

        // Pin the absence: no release call between that comment and the `return;` it guards.
        var window_ = validatorSrc.substring(rl, rl + 600);
        assert.ok(window_.indexOf('return;') > -1, 'expected the early return within the window');
        assert.equal((window_.substring(0, window_.indexOf('return;')).match(/disarmSubmitLoading\(/g) || []).length, 0,
            'releasing on the rate-limit path would clear the state mid-request');
    });

    it('the stash is cleared on release so a settled form retains no detached node', function () {
        assert.ok(/\$formInstance\.loadingTrigger\s*=\s*null/.test(validatorSrc),
            'disarmSubmitLoading must null the stashed trigger');
    });
});
