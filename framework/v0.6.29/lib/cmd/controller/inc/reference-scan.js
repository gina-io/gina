/**
 * @module gina/lib/cmd/controller/inc/reference-scan
 *
 * Pure reference scanner shared by `controller:remove` and `controller:rename`.
 * A controller is referenced ONLY by its namespace STRING (never an imported
 * identifier), so "who still points at this controller?" is answered by scanning
 * the four — and only four — structured reference sites (measured complete
 * against `core/router.js`):
 *
 *  1. the controller FILE itself: `controllers/controller.<ns>.js`;
 *  2. routing.json: a rule-level `"namespace": "<ns>"` (loads the controller
 *     file) AND a `"param": { "namespace": "<ns>" }` (overrides the view/template
 *     namespace) — router.js reads `params.param.namespace || namespace`;
 *  3. `requireController('<ns>')` literal calls (both quote styles) anywhere in
 *     the bundle's `.js` source (the API is exposed on controllers + middleware);
 *  4. the template tree `templates/html/<ns>/` (the namespace is a path segment).
 *
 * Two reference forms cannot be resolved statically and are surfaced as
 * ADVISORY `dynamicRefs` rather than silently cleared (a false "clean" verdict
 * would let a live reference through):
 *
 *  - a `param.namespace` whose value is a `:variable` (interpolated from the URL
 *    at request time — `router.js` resolves it per request, so it MIGHT target
 *    this namespace);
 *  - a `requireController(<expr>)` whose argument is not a string literal.
 *
 * Only node `fs`/`path` are used — no framework globals — so the whole module is
 * require-by-path unit-testable (drive it against a temp fixture tree).
 */

var fs   = require('fs');
var path = require('path');

/**
 * Escapes RegExp metacharacters so a namespace can be embedded literally in a
 * dynamically-built pattern. (Namespaces are charset-validated upstream, so this
 * is defence-in-depth.)
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips `//` line comments and block comments from JSON-with-comments text
 * WITHOUT corrupting `//` sequences inside string values (e.g. a `$schema` URL
 * like `"https://gina.io/..."`). The string alternative is matched first and
 * kept verbatim, so any comment marker inside a string is consumed as part of
 * the string. Mirrors what `requireJSON` does before parsing routing.json.
 *
 * @param {string} text
 * @returns {string}
 *
 * @example
 *  stripJsonComments('{ "$schema": "https://x/y", // c\n "a": 1 }');
 *  // '{ "$schema": "https://x/y", \n "a": 1 }'
 */
function stripJsonComments(text) {
    return String(text).replace(
        /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g,
        function (m, str) { return str ? str : ''; }
    );
}

/**
 * Finds every routing rule that references `namespace`, at the rule-level
 * `"namespace"` key and at `"param": { "namespace": ... }`. Top-level non-object
 * entries (`$schema`) are skipped — the same guard `config.js` applies. An
 * unparseable routing body yields empty lists (the caller surfaces the parse
 * failure separately).
 *
 * @param {string} routingText - Raw `routing.json` content (comments allowed)
 * @param {string} namespace
 * @returns {{refs: Array<{rule: string, site: ('namespace'|'param.namespace')}>, dynamic: Array<{rule: string, site: string, value: string}>, parseError: (string|null)}}
 *          `refs` — literal matches (blocking); `dynamic` — `:variable`
 *          `param.namespace` values that a static scan cannot resolve (advisory).
 *
 * @example
 *  findRoutingRefs('{ "r": { "namespace": "checkout", "param": {} } }', 'checkout');
 *  // { refs: [{ rule:'r', site:'namespace' }], dynamic: [], parseError: null }
 */
function findRoutingRefs(routingText, namespace) {
    var out = { refs: [], dynamic: [], parseError: null };
    var obj;
    try {
        obj = JSON.parse(stripJsonComments(routingText));
    } catch (e) {
        out.parseError = e.message || String(e);
        return out;
    }
    if ( !obj || typeof(obj) != 'object' ) {
        return out;
    }
    for (var rule in obj) {
        var r = obj[rule];
        // skip non-rule entries ($schema string, arrays, null) — config.js:2029
        if ( !r || typeof(r) != 'object' || Array.isArray(r) ) {
            continue;
        }
        // rule-level namespace (always literal — never URL-interpolated)
        if ( typeof(r.namespace) == 'string' ) {
            if ( r.namespace === namespace ) {
                out.refs.push({ rule: rule, site: 'namespace' });
            } else if ( r.namespace.charAt(0) === ':' ) {
                out.dynamic.push({ rule: rule, site: 'namespace', value: r.namespace });
            }
        }
        // param.namespace (may be a :variable resolved from the URL at request time)
        if ( r.param && typeof(r.param) == 'object' && typeof(r.param.namespace) == 'string' ) {
            if ( r.param.namespace === namespace ) {
                out.refs.push({ rule: rule, site: 'param.namespace' });
            } else if ( r.param.namespace.charAt(0) === ':' ) {
                out.dynamic.push({ rule: rule, site: 'param.namespace', value: r.param.namespace });
            }
        }
    }
    return out;
}

/**
 * Finds `requireController('<namespace>')` literal call sites in a `.js` file's
 * content (both quote styles), plus any `requireController(<expr>)` whose
 * argument is NOT a string literal (advisory — the runtime value is unknown).
 * A literal call naming a DIFFERENT namespace is ignored (it points elsewhere);
 * an empty `requireController()` is ignored (it loads the default controller).
 * Scanned per line, so a call split across lines is treated as dynamic.
 *
 * @param {string} content - The `.js` file content
 * @param {string} namespace
 * @returns {{refs: Array<{line: number}>, dynamic: Array<{line: number}>}}
 *          1-indexed line numbers; `refs` — literal `<namespace>` calls
 *          (blocking); `dynamic` — non-literal-argument calls (advisory).
 *
 * @example
 *  findRequireRefs("var c = self.requireController('checkout');", 'checkout');
 *  // { refs: [{ line: 1 }], dynamic: [] }
 */
function findRequireRefs(content, namespace) {
    var refs = [], dynamic = [];
    var lines  = String(content).split('\n');
    var litRe  = new RegExp('requireController\\(\\s*([\'"])' + escapeRegex(namespace) + '\\1\\s*\\)');
    var callRe = /requireController\(/;
    var strRe  = /requireController\(\s*['"]/;   // arg is a string literal (any ns)
    var emptyRe = /requireController\(\s*\)/;    // no arg → default controller
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if ( !callRe.test(line) ) {
            continue;
        }
        if ( litRe.test(line) ) {
            refs.push({ line: i + 1 });
        } else if ( strRe.test(line) || emptyRe.test(line) ) {
            // a literal string naming another namespace, or an empty call — not ours
            continue;
        } else {
            dynamic.push({ line: i + 1 });
        }
    }
    return { refs: refs, dynamic: dynamic };
}

/**
 * Recursively collects every `.js` file path under `dir`, skipping `node_modules`.
 *
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths
 */
function walkJsFiles(dir, acc) {
    acc = acc || [];
    var entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { return acc; }
    for (var i = 0; i < entries.length; i++) {
        if ( entries[i] === 'node_modules' ) {
            continue;
        }
        var full = path.join(dir, entries[i]);
        var st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if ( st.isDirectory() ) {
            walkJsFiles(full, acc);
        } else if ( /\.js$/i.test(full) ) {
            acc.push(full);
        }
    }
    return acc;
}

/**
 * @typedef {object} ReferenceScan
 * @property {(string|null)} controllerFile - bundle-relative `controllers/controller.<ns>.js`, or null if absent
 * @property {(string|null)} controllerPath - absolute path of the controller file, or null
 * @property {(string|null)} templateDir    - bundle-relative `templates/html/<ns>`, or null if absent
 * @property {(string|null)} templatePath   - absolute path of the template dir, or null
 * @property {Array<{file: string, rule: string, site: ('namespace'|'param.namespace')}>} routingRefs - literal routing references (blocking)
 * @property {Array<{file: string, line: number}>} requireRefs - literal `requireController('<ns>')` calls (blocking)
 * @property {Array<object>} dynamicRefs - unresolved-at-scan-time references (advisory; NEVER auto-cleared)
 * @property {(string|null)} routingParseError - a routing.json parse failure message, or null
 */

/**
 * Scans a bundle's source tree for every reference to `namespace`. The controller
 * file + template dir are the controller's OWN artefacts (deleted with it on
 * remove / moved on rename); the routing + requireController references are the
 * external pointers that make a bare delete a silent misdispatch (a stale
 * namespace falls back to `controller.js`).
 *
 * @param {string} bundleSrc - Absolute path of the bundle's source root
 * @param {string} namespace
 * @returns {ReferenceScan}
 *
 * @example
 *  var scan = require('./inc/reference-scan');
 *  var res  = scan.scan('/path/to/src/demo', 'checkout');
 *  // res.controllerFile -> 'controllers/controller.checkout.js'
 *  // res.routingRefs    -> [{ file:'config/routing.json', rule:'checkout-start', site:'namespace' }, ...]
 */
function scan(bundleSrc, namespace) {
    var result = {
        controllerFile   : null,
        controllerPath   : null,
        templateDir      : null,
        templatePath     : null,
        routingRefs      : [],
        requireRefs      : [],
        dynamicRefs      : [],
        routingParseError: null
    };

    // 1) the controller file itself
    var ctrlAbs = path.join(bundleSrc, 'controllers', 'controller.' + namespace + '.js');
    if ( isFile(ctrlAbs) ) {
        result.controllerPath = ctrlAbs;
        result.controllerFile = 'controllers/controller.' + namespace + '.js';
    }

    // 2) the template tree
    var tplAbs = path.join(bundleSrc, 'templates', 'html', namespace);
    if ( isDir(tplAbs) ) {
        result.templatePath = tplAbs;
        result.templateDir  = 'templates/html/' + namespace;
    }

    // 3) routing.json references (rule-level namespace + param.namespace)
    var routingAbs = path.join(bundleSrc, 'config', 'routing.json');
    if ( isFile(routingAbs) ) {
        var text = readText(routingAbs);
        if ( text != null ) {
            var rr = findRoutingRefs(text, namespace);
            result.routingParseError = rr.parseError;
            for (var a = 0; a < rr.refs.length; a++) {
                result.routingRefs.push({ file: 'config/routing.json', rule: rr.refs[a].rule, site: rr.refs[a].site });
            }
            for (var b = 0; b < rr.dynamic.length; b++) {
                result.dynamicRefs.push({
                    file: 'config/routing.json', kind: 'routing-namespace',
                    rule: rr.dynamic[b].rule, site: rr.dynamic[b].site, value: rr.dynamic[b].value
                });
            }
        }
    }

    // 4) requireController('<ns>') across the bundle .js tree
    var jsFiles = walkJsFiles(bundleSrc);
    for (var i = 0; i < jsFiles.length; i++) {
        var content = readText(jsFiles[i]);
        if ( content == null ) {
            continue;
        }
        var qr  = findRequireRefs(content, namespace);
        var rel = relPath(bundleSrc, jsFiles[i]);
        for (var c = 0; c < qr.refs.length; c++) {
            result.requireRefs.push({ file: rel, line: qr.refs[c].line });
        }
        for (var d = 0; d < qr.dynamic.length; d++) {
            result.dynamicRefs.push({ file: rel, kind: 'requireController', line: qr.dynamic[d].line });
        }
    }

    return result;
}

/** @inner @private */
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
/** @inner @private */
function isDir(p)  { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
/** @inner @private */
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
/** @inner @private */
function relPath(root, full) { return full.slice(root.length).replace(/^[\/\\]+/, ''); }

module.exports = {
    escapeRegex      : escapeRegex,
    stripJsonComments: stripJsonComments,
    findRoutingRefs  : findRoutingRefs,
    findRequireRefs  : findRequireRefs,
    walkJsFiles      : walkJsFiles,
    scan             : scan
};
