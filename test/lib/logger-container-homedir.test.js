/**
 * Logger containers — GINA_HOMEDIR-aware settings resolution (#B160-sibling 3)
 *
 * Why source inspection + a composition replica instead of requiring the module:
 *   both containers are constructed by the logger at boot and read framework
 *   globals (getEnvVar, getUserHome) that only exist inside a running gina
 *   process — the same constraint framework-init-pids.test.js documents. The
 *   end-to-end behaviour is exercised by every CLI invocation.
 *
 * Background: the MQ speaker and the file container each resolve the framework
 * settings file to learn the MQ port / host / bind host. Both composed that path
 * as getUserHome() + '/.gina/' + shortVersion + '/settings.json', ignoring
 * GINA_HOMEDIR entirely — so a process pinned to an isolated home still read the
 * invoking user's real settings (wrong ports, and a harness that silently mixes
 * two homes). They now read GINA_HOMEDIR first, falling back to the previous
 * composition.
 *
 * The trap this file exists to lock down: GINA_HOMEDIR ALREADY CARRIES the
 * `/.gina` segment — bin/cli:175 and bin/gina-container:74 both write it as
 * `home + '/.gina'` — so the tier must replace that whole prefix. Appending
 * shortVersion to `GINA_HOMEDIR + '/.gina'` would yield `…/.gina/.gina/0.6`.
 *
 * Covers:
 *   (a) source structure — both containers, the guarded getEnvVar read, the
 *       corrected composition, and the absence of the old bare form
 *   (b) path composition (pure replica) — set / unset / empty / getEnvVar-absent,
 *       plus the double-`.gina` negative
 */
'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

/** The two containers that resolve the settings file this way. */
// The file container was the second entry here until it became an in-process
// sink (#B526/#B527): it no longer reads the settings file, because it no
// longer dials the MQ port those settings carry. The speaker still does, and
// keeps every assertion below, the double-`.gina` negative included.
var CONTAINERS = [
    { name: 'mq/speaker.js',  file: 'lib/logger/src/containers/mq/speaker.js' }
];

/** Strip block + line comments so negative code-absence pins don't trip on the
 *  file's own comments (the jsdoc.md "negative pin trips on the file's own
 *  comment" trap — this file's fix is DESCRIBED in a comment naming the old
 *  shape, so an unstripped negative pin would always fail). */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceOf(container) {
    return fs.readFileSync(path.join(FW, container.file), 'utf8');
}


// ---------------------------------------------------------------------------
// 01 — source structure, both containers
// ---------------------------------------------------------------------------
describe('01 - logger containers resolve the settings file via GINA_HOMEDIR', function() {

    CONTAINERS.forEach(function(container) {

        it(container.name + ' reads GINA_HOMEDIR behind a typeof guard', function() {
            var clean = stripComments(sourceOf(container));
            assert.ok(clean.indexOf("getEnvVar('GINA_HOMEDIR')") > -1,
                'expected a GINA_HOMEDIR read in ' + container.name);
            // The container can load before the framework globals exist, so the
            // read must be guarded rather than assumed.
            assert.ok(clean.indexOf("typeof getEnvVar === 'function'") > -1,
                'expected the getEnvVar availability guard in ' + container.name);
        });

        it(container.name + ' falls back to process.env before the default home', function() {
            // Load-bearing, not defensive: this container is constructed BEFORE
            // bin/cli imports the OS env into process.gina, so on the CLI path the
            // framework-env tier never fires and process.env is what carries the
            // value. Measured 2026-08-01: process.gina has 0 keys here while
            // process.env.GINA_HOMEDIR still holds it.
            var clean = stripComments(sourceOf(container));
            assert.ok(clean.indexOf('process.env.GINA_HOMEDIR') > -1,
                'expected the process.env tier in ' + container.name);
            // Ordering: framework env must be consulted first.
            var fwAt  = clean.indexOf("getEnvVar('GINA_HOMEDIR')");
            var envAt = clean.indexOf('process.env.GINA_HOMEDIR');
            assert.ok(fwAt > -1 && envAt > fwAt,
                'framework env must be read before process.env in ' + container.name);
        });

        it(container.name + ' keeps getUserHome() + /.gina as the last tier', function() {
            var clean = stripComments(sourceOf(container));
            assert.ok(clean.indexOf("getUserHome() + '/.gina'") > -1,
                'expected the getUserHome fallback tier in ' + container.name);
            var envAt  = clean.indexOf('process.env.GINA_HOMEDIR');
            var homeAt = clean.indexOf("getUserHome() + '/.gina'");
            assert.ok(homeAt > envAt, 'getUserHome must be the LAST tier in ' + container.name);
        });

        it(container.name + ' no longer composes the settings path from getUserHome alone', function() {
            var clean = stripComments(sourceOf(container));
            assert.ok(clean.indexOf("getUserHome() + '/.gina/' + shortVersion") < 0,
                'the pre-fix bare composition must be gone from ' + container.name);
            // ...and the surviving composition appends shortVersion to the RESOLVED
            // home, never re-adding `/.gina`.
            assert.ok(clean.indexOf("+ '/' + shortVersion + '/settings.json'") > -1,
                'expected shortVersion appended to the resolved home in ' + container.name);
            assert.ok(clean.indexOf("'/.gina/' + shortVersion") < 0,
                'expected NO second /.gina segment in ' + container.name);
        });

    });

});


// ---------------------------------------------------------------------------
// 02 — path composition (pure replica)
// ---------------------------------------------------------------------------
describe('02 - settings path composition', function() {

    /**
     * Mirror of both containers' resolution:
     *   ((typeof getEnvVar === 'function' && getEnvVar('GINA_HOMEDIR'))
     *      || process.env.GINA_HOMEDIR
     *      || (getUserHome() + '/.gina')) + '/' + shortVersion + '/settings.json'
     * @param {?function} getEnvVar    null models the global being absent
     * @param {?string}   procEnvValue models process.env.GINA_HOMEDIR
     * @param {function}  getUserHome
     * @param {string}    shortVersion
     * @returns {string}
     */
    function resolve(getEnvVar, procEnvValue, getUserHome, shortVersion) {
        var home = (typeof getEnvVar === 'function' && getEnvVar('GINA_HOMEDIR'))
            || procEnvValue
            || (getUserHome() + '/.gina');
        return home + '/' + shortVersion + '/settings.json';
    }

    var userHome = function() { return '/Users/someone'; };

    it('uses the framework env value verbatim when set', function() {
        var env = function() { return '/tmp/iso-home/.gina'; };
        assert.equal(resolve(env, undefined, userHome, '0.6'), '/tmp/iso-home/.gina/0.6/settings.json');
    });

    it('uses process.env when the framework env is not populated yet', function() {
        // The measured CLI shape: process.gina empty, process.env carrying it.
        var env = function() { return undefined; };
        assert.equal(resolve(env, '/tmp/iso-home/.gina', userHome, '0.6'),
            '/tmp/iso-home/.gina/0.6/settings.json');
    });

    it('framework env WINS over process.env when both are set', function() {
        var env = function() { return '/fw/.gina'; };
        assert.equal(resolve(env, '/os/.gina', userHome, '0.6'), '/fw/.gina/0.6/settings.json');
    });

    it('does NOT append a second /.gina — the variable already carries it', function() {
        // The regression this whole slice risks: GINA_HOMEDIR is written as
        // `home + '/.gina'`, so re-adding the segment would double it.
        var env = function() { return '/tmp/iso-home/.gina'; };
        var out = resolve(env, undefined, userHome, '0.6');
        assert.ok(out.indexOf('/.gina/.gina/') < 0, 'doubled /.gina segment: ' + out);
        assert.equal((out.match(/\/\.gina\//g) || []).length, 1, 'exactly one /.gina segment expected');
        // Same guarantee via the process.env tier.
        var out2 = resolve(function() { return undefined; }, '/tmp/iso-home/.gina', userHome, '0.6');
        assert.ok(out2.indexOf('/.gina/.gina/') < 0, 'doubled /.gina segment via process.env: ' + out2);
    });

    it('falls back to getUserHome() + /.gina when no tier is set', function() {
        var env = function() { return undefined; };
        assert.equal(resolve(env, undefined, userHome, '0.6'), '/Users/someone/.gina/0.6/settings.json');
    });

    it('falls back when both env tiers are the empty string', function() {
        // getEnvVar treats '' as unset; the || chain must agree rather than
        // composing a root-relative '/0.6/settings.json'.
        var env = function() { return ''; };
        assert.equal(resolve(env, '', userHome, '0.6'), '/Users/someone/.gina/0.6/settings.json');
    });

    it('falls back without throwing when getEnvVar does not exist yet', function() {
        // Early-boot shape: the container loads before the framework globals.
        assert.equal(resolve(null, undefined, userHome, '0.6'), '/Users/someone/.gina/0.6/settings.json');
        // ...and still honours process.env in that same shape.
        assert.equal(resolve(null, '/tmp/iso-home/.gina', userHome, '0.6'),
            '/tmp/iso-home/.gina/0.6/settings.json');
    });

    it('subtract: the pre-fix composition ignores GINA_HOMEDIR entirely', function() {
        function preFix(getUserHome, shortVersion) {
            return getUserHome() + '/.gina/' + shortVersion + '/settings.json';
        }
        var env = function() { return '/tmp/iso-home/.gina'; };
        assert.equal(preFix(userHome, '0.6'), '/Users/someone/.gina/0.6/settings.json',
            'pre-fix: the isolated home is never consulted (the bug)');
        assert.notEqual(resolve(env, undefined, userHome, '0.6'), preFix(userHome, '0.6'),
            'fix: the isolated home now wins');
        // And via the tier that actually fires on the CLI path.
        assert.notEqual(resolve(function() { return undefined; }, '/tmp/iso-home/.gina', userHome, '0.6'),
            preFix(userHome, '0.6'), 'fix: process.env tier also beats the pre-fix composition');
    });

});
