/**
 * @module gina/lib/cmd/controller/inc/scaffold
 *
 * Pure, dependency-free generators for `controller:add`: parse/validate the
 * `--controls` list, build the routing rule objects (+ their printable block),
 * render the controller `.js` source, and render a per-action view template.
 *
 * Nothing here touches `fs` or a framework global — every function is
 * string-in/string-out (or value-in/value-out), so it is require-by-path
 * unit-testable, and the printed output the command emits is asserted directly
 * against these builders (the printed rules ARE the docs sample).
 */

var ns = require('./namespace');

// House-convention starter action when `--controls` is omitted. Measured from
// the namespace-controller boilerplate seed
// (core/template/boilerplate/bundle_namespace/controllers/controller.js), whose
// single action is `this.default`.
var DEFAULT_ACTION = 'default';

/**
 * Parses the raw `--controls` value into a validated, de-duplicated action list.
 * Tolerates empty tokens from trailing / doubled commas. An omitted value
 * (`undefined`, boolean `true` from a bare `--controls`, or an all-blank string)
 * yields the single house-default action.
 *
 * @param {(string|boolean|undefined)} raw - `self.params.controls`
 * @returns {{actions: string[], invalid: string[], defaulted: boolean}}
 *          `actions` — the validated action names; `invalid` — tokens that
 *          failed the charset guard; `defaulted` — true when the default action
 *          was substituted for an omitted list.
 *
 * @example
 *  parseControls('start,confirm,cancel');
 *  // { actions: ['start','confirm','cancel'], invalid: [], defaulted: false }
 *
 * @example
 *  parseControls(undefined);
 *  // { actions: ['default'], invalid: [], defaulted: true }
 */
function parseControls(raw) {
    if ( typeof(raw) == 'undefined' || raw === true || raw === null || String(raw).trim() === '' ) {
        return { actions: [DEFAULT_ACTION], invalid: [], defaulted: true };
    }

    var parts   = String(raw).split(',')
        , actions = []
        , invalid = []
        , seen    = {};

    for (var i = 0; i < parts.length; i++) {
        var a = parts[i].trim();
        if ( a === '' ) {
            continue; // tolerate trailing / doubled commas (a,,b,)
        }
        if ( !ns.isValidAction(a) ) {
            if ( invalid.indexOf(a) < 0 ) invalid.push(a);
            continue;
        }
        if ( seen[a] ) {
            continue; // de-dupe, first occurrence wins
        }
        seen[a] = true;
        actions.push(a);
    }

    // an all-invalid / all-blank list falls back to the default action so the
    // caller can surface `invalid` while still having a coherent plan to show
    if ( actions.length === 0 && invalid.length === 0 ) {
        return { actions: [DEFAULT_ACTION], invalid: [], defaulted: true };
    }

    return { actions: actions, invalid: invalid, defaulted: false };
}

/**
 * Builds the routing rule objects for a namespace + action list. Each rule is
 * keyed `<namespace>-<action>`; the URL is the namespace root for the `default`
 * action, else `/<namespace>/<action>`. For the view flavor the rule carries an
 * explicit `param.file` (= the action) so gina resolves
 * `templates/html/<namespace>/<action>.html` WITHOUT emitting the
 * `<namespace>-`-prefix naming-convention warning (render-swig.js strips the
 * prefix from a defaulted `param.file` and warns; an explicit file skips both).
 * The API flavor omits `param.file` (renderJSON renders no template).
 *
 * @param {string} namespace
 * @param {string[]} actions
 * @param {('view'|'api')} flavor
 * @returns {Array<{name: string, url: string, method: string, namespace: string, control: string, file: (string|null)}>}
 *
 * @example
 *  buildRules('checkout', ['start'], 'view');
 *  // [{ name:'checkout-start', url:'/checkout/start', method:'GET',
 *  //    namespace:'checkout', control:'start', file:'start' }]
 */
function buildRules(namespace, actions, flavor) {
    var rules = [];
    for (var i = 0; i < actions.length; i++) {
        var action = actions[i];
        rules.push({
            name      : namespace + '-' + action,
            url       : (action === DEFAULT_ACTION) ? '/' + namespace : '/' + namespace + '/' + action,
            method    : 'GET',
            namespace : namespace,
            control   : action,
            file      : (flavor === 'view') ? action : null
        });
    }
    return rules;
}

/**
 * Renders the paste-ready routing.json block for a set of rules (2-space
 * indented, the routing.json house style). Rules are comma-separated with NO
 * trailing comma on the last, so the block drops cleanly between existing rules.
 *
 * @param {Array} rules - Output of {@link buildRules}
 * @returns {string} The printable rules block (no surrounding braces)
 *
 * @example
 *  formatRulesBlock(buildRules('checkout', ['start'], 'view'));
 *  //   "checkout-start": {
 *  //     "url": "/checkout/start",
 *  //     "method": "GET",
 *  //     "namespace": "checkout",
 *  //     "param": { "control": "start", "file": "start" }
 *  //   }
 */
function formatRulesBlock(rules) {
    var blocks = [];
    for (var i = 0; i < rules.length; i++) {
        var r     = rules[i]
            , param = ( r.file !== null )
                ? '{ "control": "' + r.control + '", "file": "' + r.file + '" }'
                : '{ "control": "' + r.control + '" }';
        blocks.push(
            '  "' + r.name + '": {\n' +
            '    "url": "' + r.url + '",\n' +
            '    "method": "' + r.method + '",\n' +
            '    "namespace": "' + r.namespace + '",\n' +
            '    "param": ' + param + '\n' +
            '  }'
        );
    }
    return blocks.join(',\n');
}

/**
 * Renders one JSDoc'd action-method stub. The view flavor builds a `data` object
 * and calls `self.render(data)`; the API flavor calls `self.renderJSON(...)`.
 * Both carry the commented `self.throwError(...)` hint the boilerplate uses.
 *
 * @inner
 * @private
 * @param {string} action
 * @param {string} namespace
 * @param {('view'|'api')} flavor
 * @returns {string}
 */
function renderAction(action, namespace, flavor) {
    var head = [
        '    /**',
        '     * ' + ns.capitalize(action) + ' action',
        '     *',
        '     * @param {object} req',
        '     * @param {object} res',
        '     * @callback [next]',
        '     * */',
        '    this.' + action + ' = function(req, res) {'
    ];

    var body;
    if ( flavor === 'view' ) {
        body = [
            '        var data = {',
            '            title: \'' + ns.capitalize(namespace) + ' · ' + action + '\'',
            '        };',
            '',
            '        self.render(data);',
            '',
            '        // use this to render errors',
            '        // return self.throwError( new Error(\'Error sample\') );'
        ];
    } else {
        body = [
            '        self.renderJSON({ status: \'200\', action: \'' + action + '\' });',
            '',
            '        // use this to render errors',
            '        // return self.throwError( new Error(\'Error sample\') );'
        ];
    }

    return head.concat(body).concat(['    }']).join('\n');
}

/**
 * Renders the full controller `.js` source for a namespace: the
 * `<Bundle><Namespace>Controller` constructor, one action stub per entry, the
 * commented `onReady` hook, and the `module.exports`. Mirrors the shape of the
 * `bundle_namespace` boilerplate seed.
 *
 * @param {string} bundle
 * @param {string} namespace
 * @param {string[]} actions
 * @param {('view'|'api')} flavor
 * @returns {string}
 *
 * @example
 *  renderController('demo', 'checkout', ['start'], 'view');
 *  // '//Imports goes here.\n\n/**\n * DemoCheckoutController ... '
 */
function renderController(bundle, namespace, actions, flavor) {
    var klass = ns.className(bundle, namespace)
        , stubs = [];

    for (var i = 0; i < actions.length; i++) {
        stubs.push(renderAction(actions[i], namespace, flavor));
    }

    return [
        '//Imports goes here.',
        '',
        '/**',
        ' * ' + klass,
        ' * Namespace controller for `' + namespace + '`.',
        ' * */',
        'function ' + klass + '() {',
        '    var self = this;',
        '    // get config/app.json content',
        '    // var appConf = this.getConfig(\'app\');',
        '',
        stubs.join('\n\n'),
        '',
        '    // The onReady event fires when the controller is loaded. Use it to define,',
        '    // override or customise controller methods & swig filters.',
        '    //this.onReady = function(req, res, next){',
        '    //    //setup(req, res, next)',
        '    //}',
        '};',
        '',
        'module.exports = ' + klass,
        ''
    ].join('\n');
}

/**
 * Renders a minimal per-action view template that extends the bundle layout and
 * prints the render data's `title`. Written to
 * `templates/html/<namespace>/<action>.html` (the path the view rule resolves).
 *
 * @param {string} namespace
 * @param {string} action
 * @returns {string}
 *
 * @example
 *  renderTemplate('checkout', 'start');
 *  // "{% extends 'layouts/main.html' %}\n\n{% set data = page.data %} ..."
 */
function renderTemplate(namespace, action) {
    return [
        '{% extends \'layouts/main.html\' %}',
        '',
        '{% set data = page.data %}',
        '{% block content %}',
        '    <div class="content">',
        '        <h1>{{ data.title }}</h1>',
        '        <p>Controller <code>' + namespace + '</code>, action <code>' + action + '</code>.</p>',
        '    </div>',
        '{% endblock %}',
        ''
    ].join('\n');
}

module.exports = {
    DEFAULT_ACTION   : DEFAULT_ACTION,
    parseControls    : parseControls,
    buildRules       : buildRules,
    formatRulesBlock : formatRulesBlock,
    renderController : renderController,
    renderTemplate   : renderTemplate
};
