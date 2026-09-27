/**
 * #B359 prep + #B690 + #B360 — a real swig render through a booted bundle, with
 * `settings.swig.autoescape` set to true, set to false, and left unset (three boots).
 *
 * Swig's `autoescape` default flips to true in 0.8.0; 0.7.0 ships the non-breaking prep. This
 * scene boots the REAL `bin/gina-container` (isaac, http/1.1) on a scaffolded bundle with views
 * (`project:add` + `bundle:add` + `view:add`) and renders one page through the default
 * delegate, controller.render-swig.js. Arms, per boot:
 *
 *   01  the framework's own injected assets — the scaffold's `<link>` and `<script>` tags —
 *       render as markup in every mode. Before #B690 the `true` boot rendered every one of them
 *       as visible text (the injected `{{ page.view.* }}` placeholders were escaped).
 *   02  a data value (`<i>m</i>`) is escaped only in the `true` boot — the positive control
 *       that proves the `true` boot really escapes.
 *   03  `nl2br`: raw in off mode (unchanged); in the `true` boot the text is escaped once and
 *       the `<br/>` stays markup (before the fix it rendered as `&lt;br/&gt;`).
 *   04  `gina.csrfInput`, produced by the REAL controller path (a bundle middleware sets
 *       `req.csrfToken`, the value the Csrf plugin sets): `{{ gina.csrfInput }}` is raw in off
 *       mode and escaped in the `true` boot — the 0.8.0 flip hazard every template must adapt to —
 *       while `{{ gina.csrfInput | safe }}` is raw in every mode (the documented form).
 *   05  the #B359 boot warning ("settings.swig.autoescape is not set …, the default becomes
 *       true in 0.8.0") is printed exactly once when the key is unset, never when it is set.
 *   06  (once) a freshly scaffolded bundle's settings.json sets `swig.autoescape: true`.
 *   07  (#B360) each boot prints ONE unanchored-requirements record naming the route whose
 *       requirement is `/[0-9]+/` and not the one whose requirement is `/^[0-9]+$/`.
 *   08  (#B360) the contract that warning describes, live: `/[0-9]+/` lets `123abc` through
 *       (a partial match), `/^[0-9]+$/` answers 404 for it and 200 for `123` (the control).
 *
 * Isolation: the container-boot-head-b675.test.js shape — a throwaway HOME under os.tmpdir(),
 * its own port window (10200; a bundle takes six ports), project:rm + rmSync at teardown. Seam:
 * `B359_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT
 * tree's CLI (red-first against a pre-change tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-swig-autoescape.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ae-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ae' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10200;
var TOKEN      = 'b359tok';

var BOOT_TIMEOUT_MS  = 30000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B359_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

/** The three boots: the settings.swig block each one writes (null = the key is absent). */
var MODES = [
    { name: 'true',   swig: { autoescape: true } },
    { name: 'false',  swig: { autoescape: false } },
    { name: 'absent', swig: null }
];

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var results = {};   // mode name -> { status, body, out }
var scaffoldSettings = null;   // the bundle's settings.json exactly as bundle:add wrote it

/** The #B359 boot warning a swig bundle gets when settings.swig.autoescape is unset. */
var UNSET_WARNING = '[ SWIG ] settings.swig.autoescape is not set for [ ' + BUNDLE + ' ]';
/** The #B360 boot warning: one line for the bundle, listing its unanchored requirements. */
var ANCHOR_WARNING = '[CONFIG][loadBundleConfig] [ ' + BUNDLE + ' ] 1 routing requirement is not anchored at both ends';
/** Requested after the page in every boot: the partial match the #B360 warning is about. */
var EXTRA_PATHS = ['b360/loose/123abc', 'b360/tight/123abc', 'b360/tight/123'];


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function (resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function () { sock.destroy(); resolve(true); });
        sock.on('error',   function () { resolve(false); });
        sock.on('timeout', function () { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

function get(reqPath) {
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: webroot + reqPath, method: 'GET', agent: false }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, body: data }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, body: '', err: e.message }); });
        req.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 90000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
/** The scaffold's JSON files carry whole-line `//` comments only. */
function stripLineComments(raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }

/** A route + an action rendering a template that exercises every arm, and a middleware setting `req.csrfToken`. */
function installFixture() {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);

    var rf = path.join(src, 'config', 'routing.json');
    var r = JSON.parse(stripLineComments(fs.readFileSync(rf, 'utf8')));
    r.b359page = { namespace: 'content', url: '/b359/page', method: 'GET', param: { control: 'b359page' } };
    // #B360 — one requirement a partial match can satisfy, one anchored at both ends
    r.b360loose = { namespace: 'content', url: '/b360/loose/:id', method: 'GET', requirements: { id: '/[0-9]+/' },   param: { control: 'b360item', id: ':id' } };
    r.b360tight = { namespace: 'content', url: '/b360/tight/:id', method: 'GET', requirements: { id: '/^[0-9]+$/' }, param: { control: 'b360item', id: ':id' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(src, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = "    this.b359page = function(req, res) { self.render({ msg: '<i>m</i>', text: '<b>x</b>\\ny' }); };\n"
        + "    this.b360item = function(req, res) { self.renderJSON({ id: req.get.id }); };\n";
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));

    fs.writeFileSync(path.join(src, 'templates', 'html', 'content', 'b359page.html'), [
        "{% extends 'layouts/main.html' %}",
        '{% set data = page.data %}',
        '{% block content %}',
        '<div id="b359-msg">{{ data.msg }}</div>',
        '<div id="b359-nl2br">{{ data.text | nl2br }}</div>',
        '<div id="b359-csrf-bare">{{ gina.csrfInput }}</div>',
        '<div id="b359-csrf-safe">{{ gina.csrfInput | safe }}</div>',
        '{% endblock %}',
        ''
    ].join('\n'));

    // The shape of boot-smoke-recipes' working onInitialize fixture: the callback's `app`
    // shadows nothing because the module is named `gina` here.
    fs.writeFileSync(path.join(src, 'index.js'), [
        "var gina = require('gina');",
        'gina.onInitialize(function(event, app, express){',
        "    app.use(function(req, res, next){ req.csrfToken = '" + TOKEN + "'; next(); });",
        "    event.emit('complete', app);",
        '});',
        'gina.onError(function(err, req, res, next){ next(err); });',
        'gina.start();',
        ''
    ].join('\n'));
}

/** Write the bundle's settings.json with the swig block of `mode` (or without one). */
function writeSettings(mode) {
    var sf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.json');
    var obj = JSON.parse(stripLineComments(fs.readFileSync(sf, 'utf8')));
    delete obj.swig;
    if (mode.swig) { obj.swig = mode.swig; }
    fs.writeFileSync(sf, JSON.stringify(obj, null, 2));
}

async function bootRenderStop() {
    var out = '', exit = null;
    var child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { out += d; });
    child.on('exit', function (code, signal) { exit = { code: code, signal: signal }; });
    var alive = function () { return child.exitCode === null && child.signalCode === null; };
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while (Date.now() < deadline && !exit) {
        if (await isTcpPortOpen(bundlePort)) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    var res = { status: null, body: '', err: 'the bundle did not come up: exit ' + JSON.stringify(exit) + '\n' + out.slice(-2000) };
    var extra = {};
    if (up) {
        await sleep(300);
        res = await get('b359/page');
        for (var i = 0; i < EXTRA_PATHS.length; ++i) { extra[EXTRA_PATHS[i]] = await get(EXTRA_PATHS[i]); }
    }
    res.extra = extra;
    if (alive()) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 12000;
        while (Date.now() < until && alive()) { await sleep(150); }
        if (alive()) {
            // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
            var m = out.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
            if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
    // the next boot reuses the port: wait until it is free
    var free = Date.now() + 8000;
    while (Date.now() < free && await isTcpPortOpen(bundlePort)) { await sleep(150); }
    res.out = out;
    return res;
}

/** The inner HTML of `<div id="<id>">…</div>` in a rendered body, or null. */
function part(body, id) {
    var m = String(body || '').match(new RegExp('<div id="' + id + '">([\\s\\S]*?)</div>'));
    return m ? m[1] : null;
}
function count(haystack, needle) { return String(haystack || '').split(needle).length - 1; }

var RAW_INPUT = '<input type="hidden" name="_csrf" value="' + TOKEN + '">';
var ESC_INPUT = '&lt;input type=&quot;hidden&quot; name=&quot;_csrf&quot; value=&quot;' + TOKEN + '&quot;&gt;';


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('27 - container-boot-swig-autoescape — a real swig render with settings.swig.autoescape true / false / unset (#B359 prep, #B690)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
        try { scaffoldSettings = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.json'), 'utf8'); } catch (e) { scaffoldSettings = null; }
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (!fs.existsSync(path.join(PROJ_DIR, 'src', BUNDLE, 'templates', 'html', 'layouts', 'main.html'))) {
            setupError = 'view:add did not install the templates: ' + (va.stdout + va.stderr).slice(-800); return;
        }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        try { installFixture(); } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }
        try {
            var ss = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr = (ss.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }

        for (var i = 0; i < MODES.length; ++i) {
            writeSettings(MODES[i]);
            results[MODES[i].name] = await bootRenderStop();
        }
    });

    after(async function () {
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    function ready(t) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        return true;
    }
    function rendered(mode) {
        var r = results[mode];
        assert.ok(r, 'the ' + mode + ' boot ran');
        assert.equal(r.status, 200, mode + ': ' + (r.err || r.body.slice(0, 400)));
        return r.body;
    }

    MODES.forEach(function (mode) {
        it('01 - ' + mode.name + ': the injected <link> and <script> tags render as markup, never as escaped text (#B690)', function (t) {
            if (!ready(t)) { return; }
            var body = rendered(mode.name);
            assert.ok(/<link [^>]*href="[^"]*default\.css"/.test(body), 'the scaffold stylesheet link is markup');
            assert.ok(/<script [^>]*src="[^"]*handlers\/main\.js"/.test(body), 'the scaffold script tag is markup');
            assert.equal(count(body, '&lt;link'), 0, 'no escaped <link>');
            assert.equal(count(body, '&lt;script'), 0, 'no escaped <script>');
        });

        it('02 - ' + mode.name + ': a data value is escaped only when autoescape is true (the positive control)', function (t) {
            if (!ready(t)) { return; }
            var msg = part(rendered(mode.name), 'b359-msg');
            assert.equal(msg, mode.name === 'true' ? '&lt;i&gt;m&lt;/i&gt;' : '<i>m</i>');
        });

        it('03 - ' + mode.name + ': nl2br keeps its line break as markup', function (t) {
            if (!ready(t)) { return; }
            var out = part(rendered(mode.name), 'b359-nl2br');
            assert.equal(out, mode.name === 'true' ? '&lt;b&gt;x&lt;/b&gt;<br/>y' : '<b>x</b><br/>y');
        });

        it('04 - ' + mode.name + ': gina.csrfInput is raw with | safe in every mode; bare, it is escaped only when autoescape is true', function (t) {
            if (!ready(t)) { return; }
            var body = rendered(mode.name);
            assert.equal(part(body, 'b359-csrf-safe'), RAW_INPUT);
            assert.equal(part(body, 'b359-csrf-bare'), mode.name === 'true' ? ESC_INPUT : RAW_INPUT);
        });

        it('05 - ' + mode.name + ': the "autoescape is not set" boot warning appears ' + (mode.name === 'absent' ? 'exactly once' : 'never'), function (t) {
            if (!ready(t)) { return; }
            rendered(mode.name);
            var out = results[mode.name].out;
            assert.ok(/\[ SERVER \]|\[ FRAMEWORK \]/.test(out), 'the boot output was captured (control)');
            // count log RECORDS (lines): a JSON record carries the text twice, in `message` and `msg`
            var records = out.split('\n').filter(function (l) { return l.indexOf(UNSET_WARNING) > -1; });
            assert.equal(records.length, mode.name === 'absent' ? 1 : 0, out.slice(-1500));
            if (mode.name === 'absent') {
                assert.ok(out.indexOf('The default becomes true in 0.8.0') > -1, 'the warning names the flip release');
            }
        });
    });

    it('06 - a freshly scaffolded bundle sets settings.swig.autoescape: true (#B359 prep)', function (t) {
        if (!ready(t)) { return; }
        assert.ok(scaffoldSettings, 'bundle:add wrote settings.json');
        var parsed = JSON.parse(stripLineComments(scaffoldSettings));
        assert.deepEqual(parsed.swig, { autoescape: true });
    });

    it('07 - the unanchored-requirement boot warning: one record, naming only the unanchored requirement (#B360)', function (t) {
        if (!ready(t)) { return; }
        MODES.forEach(function (mode) {
            rendered(mode.name);
            var records = results[mode.name].out.split('\n').filter(function (l) { return l.indexOf(ANCHOR_WARNING) > -1; });
            assert.equal(records.length, 1, mode.name + ': ' + results[mode.name].out.slice(-1500));
            // the routing table keys carry their `@<bundle>` suffix by the time the loader judges them
            assert.ok(records[0].indexOf('b360loose@' + BUNDLE + ' { id: /[0-9]+/ }') > -1, records[0]);
            assert.equal(records[0].indexOf('b360tight'), -1, 'the anchored requirement is not named');
        });
    });

    it('08 - the contract the warning describes, live: /[0-9]+/ accepts 123abc, /^[0-9]+$/ answers 404 (#B360)', function (t) {
        if (!ready(t)) { return; }
        var extra = results.absent.extra;
        assert.equal(extra['b360/loose/123abc'].status, 200, JSON.stringify(extra['b360/loose/123abc']));
        assert.equal(JSON.parse(extra['b360/loose/123abc'].body).id, '123abc', 'the partial match let the whole value through');
        assert.equal(extra['b360/tight/123abc'].status, 404, 'the anchored requirement refuses it');
        assert.equal(extra['b360/tight/123'].status, 200, 'CONTROL — the anchored route matches a whole-digit value');
    });
});
