'use strict';

/**
 * Tiny static server for the gina-dialog RUNTIME e2e harness.
 *
 * Unlike the framework-free `fixtures/popin-dialog.html` (which reimplements the
 * a11y contract in vanilla JS), this server boots the REAL built gina bundle so
 * the full-runtime scenarios — AJAX load, partial slot replace, hover preload,
 * legacy/deprecation — run against the actual delegated `data-gina-dialog*`
 * handlers in popin/main.js. It is what the `popin-dialog.runtime.spec.js`
 * webServer (playwright.config.js) starts.
 *
 * What it serves:
 *   GET /                              -> fixtures/popin-dialog.runtime.html
 *   GET /a11y                          -> fixtures/popin-dialog.html (framework-free
 *                                         a11y harness; its stylesheet link resolves
 *                                         through this server's /css route)
 *   GET /js/gina.min.js                -> built bundle (dist)
 *   GET /js/gina.onload.js             -> built onload (dist), whisper tokens
 *                                         substituted with harness stub values
 *   GET /css/vendor/gina/gina.min.css  -> built stylesheet (dist)
 *   GET /_gina/assets/routing.json     -> {} for every fixture EXCEPT the nav one,
 *                                         which gets the #SPA1 routing table (keyed
 *                                         off the Referer — see the handler)
 *   GET /_gina/inspector[/...]         -> Inspector SPA off the committed dist —
 *                                         same tree, path handling and mime map as
 *                                         the real handler (core/server.js:4622)
 *   GET /_gina/agent                   -> SSE stub: connected `data` frame (bundle
 *                                         identity e2e@dev) + one `log` frame; no
 *                                         `upgrade` listener, so the SPA's WS
 *                                         attempt fails into its real SSE fallback
 *   GET /_gina/logs                    -> SSE stub, one canned log frame
 *   GET /_gina/indexes                 -> { connectors: {} } (zero-connector shape)
 *   GET /_gina/reveal                  -> 404 no-snapshot shape
 *   GET /inspector-host                -> a page carrying the REAL statusbar
 *                                         (dist html/statusbar.html, nonce tags
 *                                         stripped) + a window.__ginaData script,
 *                                         in the render-swig injection order
 *   GET /nav[/one|two|bare|plain]      -> the nav shell for a normal navigation, or
 *                                         the layoutless region when the request
 *                                         carries `X-Gina-Navigate` (`bare` answers
 *                                         2xx WITHOUT `Vary`, the defect arm)
 *   GET /autocomplete                  -> fixtures/validator-autocomplete.html
 *                                         (#B389 caret-integrity harness: a
 *                                         live-checked autocomplete="off" text
 *                                         input — webkit-only spec, #B135 gate)
 *   GET /js/gina.onload.autocomplete.js-> built onload with the acform rules
 *                                         whisper, /ac-sink answers {}
 *   GET /autofill                      -> fixtures/validator-autofill.html (#B478
 *                                         autofill-signal harness: a rule-bound form
 *                                         whose fields get the SERVED
 *                                         `gina-autofill-start` keyframe through a
 *                                         harness class; /af-sink answers {})
 *   GET /js/gina.onload.autofill.js    -> built onload with the afform rules whisper
 *   GET /hidden-first                  -> fixtures/validator-hidden-first.html (#B510
 *                                         hidden-first error paint harness: same-name
 *                                         control pairs whose hidden twin comes first;
 *                                         /hidden-first-sink answers 422 { error, fields })
 *   GET /js/gina.onload.b510.js        -> built onload with the b510form rules whisper
 *   GET /upload-preview                -> fixtures/validator-upload-preview.html (#B459
 *                                         staged-upload preview-fields harness: two file
 *                                         inputs, one form declaring [preview][...] hidden
 *                                         inputs and one not; POST /upload-stage answers a
 *                                         nested-preview JSON, /upload-save and /upload-unstage
 *                                         acknowledge, /upload-tmp/*.png serves a 1x1 PNG)
 *   GET /js/gina.onload.b459.js        -> built onload with the b459 rules whisper
 *   GET /link-gate                     -> fixtures/link-disabled-gate.html (#B310
 *                                         link disabled-gate harness; same sink)
 *   GET /link-shared                   -> fixtures/link-same-url.html (#B287
 *                                         same-url attribution harness; same sink)
 *   GET /frag/<name>.html              -> in-memory AJAX fragments (below)
 *   GET /components                    -> fixtures/web-components.html (client
 *                                         components: SSR hydration + raw-HTML
 *                                         crawler-equivalence fixture)
 *   GET /components-csp                -> fixtures/web-components.csp.html with a
 *                                         per-request script nonce substituted and
 *                                         a REAL Content-Security-Policy header
 *   GET /css/web-components.css        -> fixtures/web-components.css
 *   GET /js/components/x-checklist.js  -> the REAL reference component from the
 *                                         view-scaffold boilerplate (specs exercise
 *                                         the shipped artifact, not a copy)
 *
 * The framework dir is resolved from package.json `version` (same idiom as the
 * bundle-freshness CI gate) so it tracks version bumps without edits here.
 *
 * Run standalone:  GINA_E2E_PORT=3179 node test/e2e/runtime-server.js
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT        = path.join(__dirname, '..', '..');
const VERSION     = require(path.join(ROOT, 'package.json')).version;
const PLUGIN_DIST = path.join(ROOT, 'framework', 'v' + VERSION, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina');
// Inspector SPA assets — the SAME committed dist the real bundle serves
// (core/server.js:4622-4656 reads this exact tree with zero templating, so
// the bytes the specs drive are byte-identical to a booted bundle's).
const INSPECTOR_DIST = path.join(PLUGIN_DIST, 'inspector');
// Identity the stubbed agent stream reports; specs assert `e2e@dev` on
// `#bm-label`, so keep the two in sync.
const AGENT_ENV = { bundle: 'e2e', env: 'dev' };
const BOILERPLATE_PUBLIC = path.join(ROOT, 'framework', 'v' + VERSION, 'core', 'template', 'boilerplate', 'bundle_public');
const FIXTURES    = path.join(__dirname, 'fixtures');
const PORT        = process.env.GINA_E2E_PORT ? parseInt(process.env.GINA_E2E_PORT, 10) : 3179;

// Harness stub values for the onload whisper tokens. JSON tokens are
// URI-encoded ('%7B%7D' === encodeURIComponent('{}')) because the onload
// does JSON.parse(decodeURIComponent(token)). Session tokens are left empty
// (the onload coerces '' -> null and getTimeout() early-returns on a null
// lastModified, so no Date math runs).
const ONLOAD_TOKENS = {
    'page.environment.webroot'            : '/',
    'page.environment.bundle'             : 'e2e',
    'page.environment.env'                : 'prod',
    'page.environment.envIsDev'           : 'false',
    'page.environment.scope'              : 'local',
    'page.environment.scopeIsLocal'       : 'true',
    'page.environment.scopeIsProduction'  : 'false',
    'page.environment.isProxyHost'        : 'false',
    'page.environment.proxyHost'          : '',
    'page.environment.proxyHostname'      : '',
    'page.environment.hostname'           : 'localhost',
    'page.environment.protocol'           : 'http/1.1',
    'page.environment.version'            : VERSION,
    'page.environment.routing'            : '%7B%7D',
    'page.environment.reverseRouting'     : '%7B%7D',
    'page.environment.forms'              : '%7B%7D',
    'page.data.session.id'                : '',
    'page.data.session.timeout'           : '',
    'page.data.session.createdAt'         : '',
    'page.data.session.lastModified'      : ''
};

// In-memory AJAX fragments. Kept tiny and identifiable. NB: these are HTML
// fragments (not full documents) — the popin load tail injects them as the
// dialog body. Each `partial` fragment carries a `#slot` so the partial
// (data-gina-dialog-target="#slot") re-load can swap just the slot.
const FRAGMENTS = {
    'ajax':      '<div id="ajax-frag"><h2 id="ajax-frag-title">AJAX loaded</h2><p>cold AJAX body</p></div>',
    'partial-1': '<div id="partial-root"><h2 id="partial-chrome">Chrome stays</h2><div id="slot">SLOT-ONE</div></div>',
    'partial-2': '<div id="partial-root"><h2 id="partial-chrome">REPLACED chrome</h2><div id="slot">SLOT-TWO</div></div>',
    'preload':   '<div id="preload-frag"><h2 id="preload-frag-title">Preloaded body</h2></div>',
    'legacy':    '<div id="legacy-frag"><h2 id="legacy-frag-title">Legacy body</h2></div>',
    // #A11Y8 — two popin bodies, each carrying a focusable control, for the inert
    // spec. The unit replica (test/core/popin-nonmodal-inert.test.js) runs in jsdom,
    // which implements NO `inert`, so it can only assert that the marker attribute
    // was set. Proving the browser actually makes the superseded dialog
    // keyboard-unreachable needs a real engine and a real focusable target.
    'inert-a':   '<div id="inert-a-frag"><h2 id="inert-a-title">First body</h2><button id="inert-a-btn" type="button">A action</button></div>',
    'inert-b':   '<div id="inert-b-frag"><h2 id="inert-b-title">Second body</h2><button id="inert-b-btn" type="button">B action</button></div>',
    // client-components fixture (a): a popin body carrying a custom element.
    // Mirrors the reference component's server-rendered light DOM (the view
    // scaffold's x-checklist partial); 'component-script' additionally carries
    // its own external definition <script src> (popinOpen re-creates it in
    // <head>, deduped via parentScripts).
    'component':
        '<div id="component-frag"><h2 id="component-frag-title">Body with a component</h2>' +
        '<x-checklist data-x-checklist=\'{ "statusText": "%s / %s" }\'>' +
        '<p data-role="status" hidden></p>' +
        '<ul>' +
        '<li><label><input type="checkbox" checked> alpha</label></li>' +
        '<li><label><input type="checkbox"> beta</label></li>' +
        '</ul>' +
        '<template data-role="item"><li><label><input type="checkbox"> <span data-role="item-label"></span></label></li></template>' +
        '<form data-role="add" action="#" method="get"><input type="text" name="label" aria-label="New item"><button type="submit">Add</button></form>' +
        '</x-checklist></div>',
    'component-script':
        '<div id="component-script-frag"><h2 id="component-script-frag-title">Body with a component + its definition</h2>' +
        '<x-checklist data-x-checklist=\'{ "statusText": "%s / %s" }\'>' +
        '<p data-role="status" hidden></p>' +
        '<ul>' +
        '<li><label><input type="checkbox" checked> alpha</label></li>' +
        '<li><label><input type="checkbox"> beta</label></li>' +
        '</ul>' +
        '<template data-role="item"><li><label><input type="checkbox"> <span data-role="item-label"></span></label></li></template>' +
        '<form data-role="add" action="#" method="get"><input type="text" name="label" aria-label="New item"><button type="submit">Add</button></form>' +
        '</x-checklist>' +
        '<script src="/js/components/x-checklist.js"></script></div>'
};

// #CC2 — a non-empty forms whisper for the FACE-participation fixture. core.js only
// scans + binds forms when gina.forms.rules is non-empty (it stays byte-identical /
// inert otherwise), so the validator needs a rule set to activate. The `agree` field
// is a form-associated custom element (<x-agree>); the reassociated `note` input is
// intentionally rule-less (it rides the payload untrusted — the hazard-b posture).
const FACE_FORMS_JSON = JSON.stringify({ rules: { faceform: { agree: { isRequired: true } } } });

// #R8 slice 2 — a non-empty forms whisper for the upload-dropzone fixture. Same
// reason as FACE above: core.js only scans + binds forms when gina.forms.rules is
// non-empty, and bindUploadDropzone() runs as part of that bind. The rule sits on
// `title` rather than on the file input so the dropzone binding is not entangled
// with a validity state the drag assertions do not care about.
const UPLOAD_FORMS_JSON = JSON.stringify({ rules: { uploadform: { title: { isRequired: true } } } });

// #B389 (gh issue #63) — a non-empty forms whisper for the autocomplete-caret
// fixture. Same reason as FACE above: core.js only scans + binds forms when
// gina.forms.rules is non-empty. The rule sits on the `ref` text input itself:
// a LIVE-CHECKED field is the reported scene (the live check is part of the
// main-thread work occupying the window between keystrokes), and
// autocomplete="off" in the fixture markup is what routes the field through
// handleAutoComplete's keydown interception on a REAL-Safari UA.
const AC_FORMS_JSON = JSON.stringify({ rules: { acform: { ref: { isRequired: true } } } });

// #B478 - a non-empty forms whisper for the autofill-signal fixture. Same reason as
// AC_FORMS_JSON: core.js only scans + binds forms when gina.forms.rules is non-empty.
// Two live-checked text-like fields, so the spec can drive a readable fill, an
// invalid fill and a withheld (Chrome-shaped) fill against the real gate.
const AF_FORMS_JSON = JSON.stringify({ rules: { afform: { email: { isRequired: true, isEmail: true }, secret: { isRequired: true } } } });

// #B447 — a non-empty forms whisper for the hform-channel fixture. Same reason as
// AC_FORMS_JSON: core.js only scans + binds forms when gina.forms.rules is non-empty.
// The isRequired rule matters for a second reason here — an empty field fails
// validation and blocks the submit CLIENT-SIDE, so without a filled field the XHR
// never fires and the arm would read "no hform event" for the wrong reason.
const HFORM_FORMS_JSON = JSON.stringify({ rules: { hformform: { ref: { isRequired: true } } } });

// #B510 — a non-empty forms whisper for the hidden-first error-paint fixture. Same reason
// as AC_FORMS_JSON: core.js only scans + binds forms when gina.forms.rules is non-empty.
// `lone` carries the one real rule (pre-filled, so the bind-time pass leaves the trigger
// open and the click POSTs); the shared-name pairs carry `exclude: false`, the directive the
// plugin's own source recommends for a hidden twin of a disabled control. The sink, not a
// client rule, is what puts every field in error.
const B510_FORMS_JSON = JSON.stringify({ rules: {
    b510form: {
        lone: { isRequired: true },
        shared: { exclude: false }, plain: { exclude: false }, split: { exclude: false }, visfirst: { exclude: false }
    },
    // the second form's pair fails a CLIENT rule, so its refused submit paints through the
    // whole-form (3-argument) call instead of the per-field XHR one (spec arm 08)
    b510form2: { wf: { exclude: false, isString: [50, 90] } }
} });

// #B459 — a non-empty forms whisper for the staged-upload preview-fields fixture. Same
// reason as AC_FORMS_JSON: core.js only scans + binds forms when gina.forms.rules is
// non-empty, and the upload layer binds as part of form binding. One pre-filled rule per
// form keeps the save trigger open.
const B459_FORMS_JSON = JSON.stringify({ rules: {
    b459form:     { title: { isRequired: true } },
    b459declared: { title: { isRequired: true } }
} });
// The staging answer the client consumes (guide: `files[]` entries; the NESTED
// `preview` object is the app-provided variant the client renders from `preview.tmpUri`).
const B459_STAGE_JSON = JSON.stringify({ files: [{
    name: 'staged-me.png', group: 'untagged', originalFilename: 'me.png', ext: 'png', encoding: '7bit',
    size: 69, width: 1, height: 1, location: '/tmp/uploads/staged-me.png', mime: 'image/png',
    tmpUri: '/upload-tmp/staged-me.png',
    preview: { location: '/tmp/uploads/staged-me-preview.png', uri: '/media/previews/staged-me-preview.png',
               tmpUri: '/upload-tmp/staged-me-preview.png', width: 1, height: 1 }
}] });
// a 1x1 transparent PNG, so preview <img> loads answer 200 and the console stays clean
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// #SPA1 Tier 1 — the routing table gina/nav matches clicks against. Shape mirrors the
// served map: `param` must be present (getCompiled skips paramless routes), `bundle`
// must equal the `page.environment.bundle` whisper ('e2e'), and only `negotiate: true`
// routes may be intercepted. `plain` is the subtract arm — same shape, no negotiate.
//
// NB the whisper route is a dead end here: core.js:518 has the routing whisper
// COMMENTED OUT, and loadRoutingConf overwrites gina.config.routing with the fetched
// body regardless. The fetch below is the only channel that reaches nav.
const NAV_ROUTING = {
    'nav-one'  : { bundle: 'e2e', method: 'get', url: '/nav/one',   param: {}, negotiate: true },
    'nav-two'  : { bundle: 'e2e', method: 'get', url: '/nav/two',   param: {}, negotiate: true },
    'nav-bare' : { bundle: 'e2e', method: 'get', url: '/nav/bare',  param: {}, negotiate: true },
    'nav-plain': { bundle: 'e2e', method: 'get', url: '/nav/plain', param: {} }
};

// Region content per /nav* URL. The same string is served as a layoutless FRAGMENT to
// an `X-Gina-Navigate` request and inlined into the shell for a normal navigation —
// the production contract, and what makes a fallback land on a real document.
// Every region carries the same `#frag-title` id so assertions do not care which
// section rendered, only which one is showing.
const NAV_REGIONS = {
    'home' : '<div id="frag-home" data-gina-nav-title="Nav home"><h2 id="frag-title">HOME</h2>'
           + '<a id="to-one" href="/nav/one">to one</a> <a id="to-bare" href="/nav/bare">to bare</a> '
           + '<a id="to-plain" href="/nav/plain">to plain</a></div>',
    'one'  : '<div id="frag-one" data-gina-nav-title="Section one"><h2 id="frag-title">ONE</h2>'
           + '<a id="to-two" href="/nav/two">to two</a></div>',
    'two'  : '<div id="frag-two" data-gina-nav-title="Section two"><h2 id="frag-title">TWO</h2>'
           + '<a id="to-one" href="/nav/one">to one</a></div>',
    'bare' : '<div id="frag-bare"><h2 id="frag-title">BARE</h2></div>',
    'plain': '<div id="frag-plain"><h2 id="frag-title">PLAIN</h2></div>'
};

// Only these advertise `Vary: X-Gina-Navigate`. `bare` is the defect arm: a 2xx HTML
// answer WITHOUT the header, which nav must refuse to swap (a server/client matching
// disagreement) and degrade to a full page load.
const NAV_NEGOTIATED = { 'home': true, 'one': true, 'two': true };

/**
 * renderOnload — read the built onload and substitute its `{{ token }}` whispers
 * with the harness stub values above. An optional raw forms-JSON string overrides
 * the (empty) `page.environment.forms` whisper so a fixture can activate the
 * validator; it is URI-encoded here because the onload does
 * JSON.parse(decodeURIComponent(token)).
 * @param {string} [formsJson] raw JSON for the forms whisper (defaults to '{}').
 * @returns {string}
 */
function renderOnload(formsJson) {
    var src = fs.readFileSync(path.join(PLUGIN_DIST, 'js', 'gina.onload.min.js'), 'utf8');
    var tokens = formsJson
        ? Object.assign({}, ONLOAD_TOKENS, { 'page.environment.forms': encodeURIComponent(formsJson) })
        : ONLOAD_TOKENS;
    Object.keys(tokens).forEach(function (key) {
        var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var re = new RegExp('\\{\\{\\s*' + escaped + '\\s*\\}\\}', 'g');
        src = src.replace(re, tokens[key]);
    });
    return src;
}

/**
 * renderCspFixture — read the CSP fixture and substitute its `{{ nonce }}`
 * tokens with a fresh per-request script nonce (fixture (c) of the client
 * components specs: the policy must arrive as a REAL response header with a
 * per-request nonce, mirroring the deployed Csp-plugin shape — not a <meta>
 * policy).
 * @returns {{ nonce: string, body: string }}
 */
function renderCspFixture() {
    var nonce = crypto.randomBytes(16).toString('base64');
    var src = fs.readFileSync(path.join(FIXTURES, 'web-components.csp.html'), 'utf8');
    return { nonce: nonce, body: src.replace(/\{\{\s*nonce\s*\}\}/g, nonce) };
}

/**
 * renderNav — the /nav shell with its `{{ region }}` token replaced. One shell for
 * every /nav* URL, so a fallback navigation renders a real document.
 * @param {string} region raw region HTML
 * @returns {string}
 */
function renderNav(region) {
    var src = fs.readFileSync(path.join(FIXTURES, 'nav.html'), 'utf8');
    return src.replace(/\{\{\s*region\s*\}\}/g, region);
}

/**
 * refererPath — pathname of a Referer header, or '' when absent/unparseable. Used to
 * decide which routing table a routing.json fetch should receive.
 * @param {string} [referer]
 * @returns {string}
 */
function refererPath(referer) {
    try {
        return new URL(referer).pathname;
    } catch (err) {
        return '';
    }
}

/**
 * send — write a response with the right content-type and no-cache headers.
 */
function send(res, status, type, body) {
    res.writeHead(status, {
        'Content-Type'  : type,
        'Cache-Control' : 'no-store'
    });
    res.end(body);
}

const server = http.createServer(function (req, res) {
    var url = req.url.split('?')[0];

    try {
        if (url === '/' || url === '/index.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'popin-dialog.runtime.html')));
        }
        if (url === '/a11y' || url === '/a11y.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'popin-dialog.html')));
        }
        if (url === '/js/gina.onload.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload());
        }
        // #CC2 — same onload, but with a non-empty forms whisper so the validator binds
        // (the FACE-participation fixture, /face, references this).
        if (url === '/js/gina.onload.face.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(FACE_FORMS_JSON));
        }
        // #R8 slice 2 — same onload with a non-empty forms whisper so the validator
        // binds and bindUploadDropzone() runs (the /upload fixture references this).
        if (url === '/js/gina.onload.upload.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(UPLOAD_FORMS_JSON));
        }
        // #B389 — same onload with a non-empty forms whisper so the validator binds
        // the live-checked autocomplete="off" field (the /autocomplete fixture
        // references this).
        if (url === '/js/gina.onload.autocomplete.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(AC_FORMS_JSON));
        }
        if (url === '/autocomplete' || url === '/autocomplete.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'validator-autocomplete.html')));
        }
        if (url === '/ac-sink') {
            return send(res, 200, 'application/json; charset=utf-8', '{}');
        }
        // #B478 - same onload with a non-empty forms whisper so the validator binds
        // the autofill-signal fixture's rule-bound form (the /autofill fixture
        // references this).
        if (url === '/js/gina.onload.autofill.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(AF_FORMS_JSON));
        }
        if (url === '/autofill' || url === '/autofill.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'validator-autofill.html')));
        }
        if (url === '/af-sink') {
            return send(res, 200, 'application/json; charset=utf-8', '{}');
        }
        // #B447 — the hform-channel fixture. Deliberately a SEPARATE page from
        // /autocomplete: declaring data-gina-form-event-on-submit-error there would
        // flip hFormIsRequired on a scene shared with the autocomplete-caret specs.
        if (url === '/js/gina.onload.hform.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(HFORM_FORMS_JSON));
        }
        if (url === '/hform' || url === '/hform.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'validator-transport-error-hform.html')));
        }
        if (url === '/hform-sink') {
            return send(res, 200, 'application/json; charset=utf-8', '{}');
        }
        // #B510 — the hidden-first error-paint fixture. The sink answers the validator's
        // XHR with the `{ error, fields }` shape a server-side field-validation failure
        // produces; the client forwards each `fields` entry to handleErrorsDisplay.
        if (url === '/js/gina.onload.b510.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(B510_FORMS_JSON));
        }
        if (url === '/hidden-first' || url === '/hidden-first.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'validator-hidden-first.html')));
        }
        // #B459 — the staged-upload preview-fields fixture and its three endpoints.
        if (url === '/js/gina.onload.b459.js') {
            return send(res, 200, 'application/javascript; charset=utf-8', renderOnload(B459_FORMS_JSON));
        }
        if (url === '/upload-preview' || url === '/upload-preview.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'validator-upload-preview.html')));
        }
        if (url === '/upload-stage') {
            // drain the multipart body, then answer the nested-preview JSON
            req.on('data', function () {});
            req.on('end', function () { send(res, 200, 'application/json; charset=utf-8', B459_STAGE_JSON); });
            return;
        }
        if (url === '/upload-save' || url === '/upload-unstage') {
            req.on('data', function () {});
            req.on('end', function () { send(res, 200, 'application/json; charset=utf-8', '{}'); });
            return;
        }
        if (/^\/upload-tmp\/[\w.-]+\.png$/.test(url)) {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            return res.end(PNG_1X1);
        }
        if (url === '/hidden-first-sink') {
            return send(res, 422, 'application/json; charset=utf-8', JSON.stringify({
                error: 'validation failed',
                fields: {
                    shared: 'shared error', plain: 'plain error', split: 'split error',
                    visfirst: 'visfirst error', lone: 'lone error',
                    hidonly: 'hidonly error', wrapped: 'wrapped error'
                }
            }));
        }
        if (url === '/upload' || url === '/upload.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'upload-dropzone.html')));
        }
        if (url === '/js/gina.min.js') {
            return send(res, 200, 'application/javascript; charset=utf-8',
                fs.readFileSync(path.join(PLUGIN_DIST, 'js', 'gina.min.js')));
        }
        if (url === '/css/vendor/gina/gina.min.css') {
            return send(res, 200, 'text/css; charset=utf-8',
                fs.readFileSync(path.join(PLUGIN_DIST, 'css', 'gina.min.css')));
        }
        if (url === '/_gina/assets/routing.json') {
            // Keyed off the REFERRING page. core.js fetches this URL unconditionally at
            // boot, so serving the nav table to everyone would silently become a new
            // input to nine unrelated specs; every non-nav fixture keeps the empty table
            // it has always had. A missing Referer degrades to '{}', which makes nav
            // inert and fails its specs loudly rather than passing them for a wrong
            // reason.
            var isNavPage = /^\/nav(\/|$)/.test(refererPath(req.headers.referer));
            return send(res, 200, 'application/json; charset=utf-8',
                isNavPage ? JSON.stringify(NAV_ROUTING) : '{}');
        }

        // ── Inspector SPA + data-endpoint stubs ─────────────────────────────
        // Assets come off the committed dist through the same path handling as
        // the real handler (core/server.js:4622-4656: prefix strip, index.html
        // default, mime map, #B179 confinement) — byte-identical by
        // construction. The DATA endpoints are stubs whose frame shapes are
        // pinned to the real handlers (line refs on each); they feed the
        // standalone `?target=` acquisition path. Server-frame DRIFT is not
        // caught here — the real handlers are covered by test/core/
        // inspector.test.js; if that contract moves, move these stubs with it.
        // No `upgrade` listener exists on this server, so the SPA's default
        // WebSocket agent attempt fails and its documented WS→SSE fallback
        // (inspector.js tryAgentWS → tryAgent) runs for real against the stub.
        if (/^\/_gina\/inspector(\/.*)?$/.test(url)) {
            var insPath = url.replace(/^.*\/_gina\/inspector\/?/, '');
            if (!insPath) insPath = 'index.html';
            var insFile = path.normalize(path.join(INSPECTOR_DIST, insPath));
            // #B179 mirror — reject anything canonicalising outside the asset
            // root BEFORE any fs access; same 404 as a missing file.
            if (insFile.indexOf(INSPECTOR_DIST + path.sep) !== 0 || !fs.existsSync(insFile)) {
                return send(res, 404, 'text/plain; charset=utf-8', 'Not found: ' + url);
            }
            var insExt  = insPath.split('.').pop();
            var insMime = {
                'html':  'text/html; charset=utf8',
                'js':    'application/javascript; charset=utf8',
                'css':   'text/css; charset=utf8',
                'svg':   'image/svg+xml',
                'woff2': 'font/woff2',
                'woff':  'font/woff'
            };
            var insBinary = /^(woff2?|png|ico|gif|jpe?g)$/.test(insExt);
            return send(res, 200, insMime[insExt] || 'application/octet-stream',
                fs.readFileSync(insFile, insBinary ? undefined : 'utf8'));
        }
        if (url === '/_gina/agent') {
            // SSE agent stub — mirrors the real handler's connect sequence
            // (core/server.js:4732-4760): `:ok` preamble, then the no-snapshot
            // "connected" `data` frame carrying the bundle identity, then one
            // `log` frame in the shape of core/server.js:4765-4780.
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-store',
                'connection': 'keep-alive',
                'access-control-allow-origin': '*'
            });
            res.write(':ok\n\n');
            var agentInit = { gina: { environment: AGENT_ENV }, user: { environment: AGENT_ENV } };
            res.write('event: data\ndata: ' + JSON.stringify(agentInit) + '\n\n');
            // Second `data` frame — the render-emit path (`inspector#data`,
            // core/server.js:4758-4762 fires the FULL payload on every HTML
            // render). `user.data` is what the SPA's data tab renders
            // (inspector.js renderTab `case 'data'`); the root-level `engine`
            // primitive gives specs a deterministic `.bm-copyable` leaf that
            // is visible without expanding any fold.
            var agentRender = {
                gina: { environment: AGENT_ENV },
                user: {
                    environment: AGENT_ENV,
                    data: {
                        engine: 'e2e-harness',
                        page:   { title: 'e2e fixture' },
                        order:  { id: 42, ref: 'A-1' }
                    }
                }
            };
            res.write('event: data\ndata: ' + JSON.stringify(agentRender) + '\n\n');
            res.write('event: log\ndata: ' + JSON.stringify({
                t: Date.now(), l: 'info', b: AGENT_ENV.bundle, s: 'agent stream ready', src: 'server'
            }) + '\n\n');
            var agentKa = setInterval(function () {
                try { res.write(':ka\n\n'); } catch (e) { /* closing */ }
            }, 15000);
            req.on('close', function () { clearInterval(agentKa); });
            return; // keep the connection open — no res.end()
        }
        if (url === '/_gina/logs') {
            // SSE log stream stub — frame shape of core/server.js:4657-4700.
            // Bound mode (`tryServerLogs`) reads this endpoint; the agent path
            // above carries logs itself.
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-store',
                'connection': 'keep-alive',
                'access-control-allow-origin': '*'
            });
            res.write(':ok\n\n');
            res.write('data: ' + JSON.stringify({
                t: Date.now(), l: 'info', b: AGENT_ENV.bundle, s: 'log stream ready', src: 'server'
            }) + '\n\n');
            var logsKa = setInterval(function () {
                try { res.write(':ka\n\n'); } catch (e) { /* closing */ }
            }, 15000);
            req.on('close', function () { clearInterval(logsKa); });
            return; // keep the connection open — no res.end()
        }
        if (url === '/_gina/indexes') {
            // Zero-connector shape of core/server.js:4831-4838.
            return send(res, 200, 'application/json; charset=utf-8',
                JSON.stringify({ connectors: {} }));
        }
        if (url === '/inspector-host') {
            // A page carrying the REAL statusbar — mirrors the render-swig
            // injection (controller.render-swig.js ~1524: reads
            // dist/vendor/gina/html/statusbar.html per render and splices it
            // into the layout after the __ginaData script). The only swig tags
            // in that template are the {% if page.cspNonce %} nonce pair (the
            // #TPL2 leaf-template guarantee), so a no-CSP fixture renders it
            // by stripping the tags. The statusbar bails without
            // window.__ginaData.user (statusbar.html:4-5), so the data script
            // must precede it — same order as the real injection.
            var sbTpl = fs.readFileSync(path.join(PLUGIN_DIST, 'html', 'statusbar.html'), 'utf8')
                .replace(/\{%[^%]*%\}/g, '')
                .replace(/\{\{[^}]+\}\}/g, '');
            var hostData = {
                gina: { environment: AGENT_ENV },
                user: { environment: AGENT_ENV, data: { engine: 'e2e-harness' } }
            };
            return send(res, 200, 'text/html; charset=utf-8',
                '<!doctype html><html><head><meta charset="utf-8"><title>inspector host</title></head><body>\n'
                + '<h1>inspector host page</h1>\n'
                + '<script>window.__ginaData = ' + JSON.stringify(hostData) + ';</script>\n'
                + sbTpl
                + '\n</body></html>');
        }
        if (url === '/_gina/reveal') {
            // No-snapshot branch of core/server.js:4896-4901.
            return send(res, 404, 'application/json; charset=utf-8',
                JSON.stringify({ error: 'no snapshot available' }));
        }
        // #B302 — the link preset-id harness. `/link/sink` is the request the plugin's XHR
        // lands on; the specs assert on the REQUEST, so the body only has to be valid.
        if (url === '/link' || url === '/link.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'link-preset-id.html')));
        }
        if (url === '/link/sink') {
            return send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
        }
        // #B310 — the link disabled-gate harness. Same sink as /link.
        if (url === '/link-gate' || url === '/link-gate.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'link-disabled-gate.html')));
        }
        // #B287 — the same-url attribution harness. Same sink as /link.
        if (url === '/link-shared' || url === '/link-shared.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'link-same-url.html')));
        }
        // #SPA1 — the nav harness. One shell per URL (full document), or the layoutless
        // region when the request carries the negotiation header.
        var nav = url.match(/^\/nav(?:\/(one|two|bare|plain))?$/);
        if (nav) {
            var section = nav[1] || 'home';
            if (/fragment/i.test(req.headers['x-gina-navigate'] || '')) {
                var navHeaders = {
                    'Content-Type' : 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                };
                if (NAV_NEGOTIATED[section]) {
                    navHeaders['Vary'] = 'X-Gina-Navigate';
                }
                res.writeHead(200, navHeaders);
                return res.end(NAV_REGIONS[section]);
            }
            return send(res, 200, 'text/html; charset=utf-8', renderNav(NAV_REGIONS[section]));
        }
        // client components — framework-free fixtures + the shipped reference
        // component (see the header comment)
        if (url === '/components') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'web-components.html')));
        }
        if (url === '/components-csp') {
            var csp = renderCspFixture();
            res.writeHead(200, {
                'Content-Type'            : 'text/html; charset=utf-8',
                'Cache-Control'           : 'no-store',
                'Content-Security-Policy' : "default-src 'none'; script-src 'nonce-" + csp.nonce + "'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'"
            });
            return res.end(csp.body);
        }
        if (url === '/css/web-components.css') {
            return send(res, 200, 'text/css; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'web-components.css')));
        }
        if (url === '/js/components/x-checklist.js') {
            return send(res, 200, 'application/javascript; charset=utf-8',
                fs.readFileSync(path.join(BOILERPLATE_PUBLIC, 'js', 'components', 'x-checklist.js')));
        }
        // #CC2 — the FACE-participation harness: fixture page + its FACE definition +
        // the always-XHR submit sink (the validator posts application/json; the sink just
        // acknowledges so the submit path completes and the spec can read the request body).
        if (url === '/face' || url === '/face.html') {
            return send(res, 200, 'text/html; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'web-components.face.html')));
        }
        if (url === '/js/x-agree.js') {
            return send(res, 200, 'application/javascript; charset=utf-8',
                fs.readFileSync(path.join(FIXTURES, 'x-agree.js')));
        }
        if (url === '/face-sink') {
            return send(res, 200, 'application/json; charset=utf-8', '{}');
        }
        // #B80 — a legacy popin trigger whose GET returns an XHR redirect (application/json),
        // not an HTML fragment. A hover/focus preload must NOT cache + inject this JSON as
        // popin content; the click-time popinLoad's _self tunnel must load `location` instead.
        if (url === '/redirect-frag') {
            return send(res, 200, 'application/json; charset=utf-8',
                JSON.stringify({ isXhrRedirect: true, location: '/frag/ajax.html' }));
        }
        var frag = url.match(/^\/frag\/([\w-]+)\.html$/);
        if (frag && FRAGMENTS.hasOwnProperty(frag[1])) {
            return send(res, 200, 'text/html; charset=utf-8', FRAGMENTS[frag[1]]);
        }
    } catch (err) {
        return send(res, 500, 'text/plain; charset=utf-8', String(err && err.stack || err));
    }

    return send(res, 404, 'text/plain; charset=utf-8', 'not found: ' + url);
});

server.listen(PORT, function () {
    // eslint-disable-next-line no-console
    console.log('[gina-e2e] runtime harness on http://localhost:' + PORT + '/  (framework v' + VERSION + ')');
});
