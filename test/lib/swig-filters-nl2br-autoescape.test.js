/**
 * #B359 prep + #B690 — nl2br under `settings.swig.autoescape`, and the asset placeholders the
 * default swig render delegate injects (real lib/swig-filters bytes, real @rhinostone/swig).
 *
 * With `settings.swig.autoescape: true` swig appends its `e` filter to every `{{ }}` unless a
 * filter in the chain is flagged `.safe` (swig-core tokenparser), so:
 *
 *   - nl2br's `<br/>` rendered as visible `&lt;br/&gt;` text. The fix: in that mode nl2br
 *     escapes its INPUT with swig's own html escape and is flagged `.safe`; with autoescape off
 *     (the default until 0.8.0) it neither escapes nor is flagged, so it is byte-identical.
 *     It must NEVER be flagged `.safe` in off mode: a `{% autoescape true %}` region would then
 *     emit its input raw (the "no naive .safe" rule from the #B359 design).
 *   - the `{{ page.view.stylesheets }}` / `{{ page.view.scripts }}` placeholders the delegate
 *     injects into the layout escaped every `<link>` / `<script>` it injected (#B690, measured
 *     on a booted scaffold). They are now injected with `| safe`, and a layout that already
 *     holds either form is not injected twice.
 *
 * The booted end-to-end arms (a real render through controller.render-swig.js, three boots:
 * autoescape true / false / absent) live in test/integration/container-boot-swig-autoescape.test.js.
 *
 * The factory needs two gina globals that only gna.js sets at bundle boot (`GINA_FRAMEWORK_DIR`,
 * `_`); they are shimmed as in render-context-b514.test.js and restored afterwards. The factory
 * is a first-call singleton (later calls return the first call's filters), so every case loads a
 * FRESH module instance.
 *
 * Seams for red-first: GINA_SWIG_FILTERS_SRC=<file> and GINA_RENDER_SWIG_SRC=<file> point the
 * arms at pre-change copies.
 *
 * Run standalone:
 *   node --test test/lib/swig-filters-nl2br-autoescape.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

var SF_PATH  = process.env.GINA_SWIG_FILTERS_SRC || path.join(FW, 'lib/swig-filters/src/main.js');
var RS_PATH  = process.env.GINA_RENDER_SWIG_SRC  || path.join(FW, 'core/controller/controller.render-swig.js');
var RSA_PATH = process.env.GINA_RENDER_SWIG_ASYNC_SRC || path.join(FW, 'core/controller/controller.render-swig-async.js');

var swigLib    = require('@rhinostone/swig');
var swigEscape = require('@rhinostone/swig/lib/filters').escape;

var priorGlobals = {};

/** A fresh factory module: the singleton lives on the exported function. */
function freshFactory() {
    delete require.cache[require.resolve(SF_PATH)];
    return require(SF_PATH);
}
function settingsWith(ae) {
    var s = { region: { culture: 'en_US' } };
    if (typeof ae !== 'undefined') { s.swig = { autoescape: ae }; }
    return s;
}
/** The boot call's shape: server.js initSwigEngine passes `{ options: <bundle env conf> }`. */
function bootArg(ae) { return { options: { content: { settings: settingsWith(ae) } }, isProxyHost: false }; }
/** The per-request call's shape: render-swig passes `{ options: <localOptions> }`. */
function requestArg(ae) {
    return { options: { conf: { content: { settings: settingsWith(ae) } } }, isProxyHost: false,
        throwError: function () {}, req: {}, res: {} };
}
/** nl2br as shipped before the change — the off-mode oracle. */
function nl2brBefore(text, replacement) {
    replacement = ( typeof( replacement ) != 'undefined' ) ? replacement : '<br/>';
    return text.replace(/(\n|\r)/g, replacement);
}

var CORPUS = [
    'line1\nline2',
    'a\r\nb',
    '<b>x</b>\n<i>y</i>',
    'Tom & Jerry\n"quoted" \'single\'',
    'already &amp; &lt;escaped&gt; &quot; &#39;\nend',
    '&nbsp;\n&copy; &unknown;',
    '<script>alert(1)</script>\n',
    'no newline at all',
    '\n\n',
    ''
];

describe('#B359 prep — nl2br under settings.swig.autoescape (real lib/swig-filters)', function () {

    before(function () {
        priorGlobals.FWDIR = global.GINA_FRAMEWORK_DIR;
        priorGlobals.under = global._;
        global.GINA_FRAMEWORK_DIR = FW;
        if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }
    });

    after(function () {
        if (typeof priorGlobals.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; }
        else { global.GINA_FRAMEWORK_DIR = priorGlobals.FWDIR; }
        if (typeof priorGlobals.under === 'undefined') { delete global._; }
        else { global._ = priorGlobals.under; }
        delete require.cache[require.resolve(SF_PATH)];
    });

    describe('01 - autoescape off or unset: byte-identical and never flagged .safe', function () {
        var offArgs = [
            ['boot, key absent', bootArg()], ['boot, false', bootArg(false)],
            ['request, key absent', requestArg()], ['request, false', requestArg(false)],
            ['explicit autoescape:false (async shape)', { options: {}, autoescape: false }],
            ['empty options', { options: {} }]
        ];
        offArgs.forEach(function (pair) {
            it(pair[0] + ': every corpus string renders as before, with the default and a custom replacement', function () {
                var f = freshFactory()(pair[1]);
                CORPUS.forEach(function (s) {
                    assert.equal(f.nl2br(s), nl2brBefore(s), JSON.stringify(s));
                    assert.equal(f.nl2br(s, '<br>'), nl2brBefore(s, '<br>'), JSON.stringify(s));
                });
                assert.notEqual(f.nl2br.safe, true, 'nl2br must not be flagged .safe when the bundle does not escape');
            });
        });
    });

    describe('02 - autoescape true: input escaped with swig\'s own escape, output flagged .safe', function () {
        var onArgs = [
            ['boot shape', bootArg(true)],
            ['request shape', requestArg(true)],
            ['explicit autoescape:true (async shape)', { options: {}, autoescape: true }]
        ];
        onArgs.forEach(function (pair) {
            it(pair[0] + ': nl2br(x) === swig escape(x) with newlines replaced; flagged .safe', function () {
                var f = freshFactory()(pair[1]);
                assert.equal(f.nl2br.safe, true, 'nl2br is flagged .safe so swig does not escape its <br/> again');
                CORPUS.forEach(function (s) {
                    assert.equal(f.nl2br(s), swigEscape(s).replace(/(\n|\r)/g, '<br/>'), JSON.stringify(s));
                });
            });
        });

        it('the replacement argument is template text and is used as written', function () {
            var f = freshFactory()(bootArg(true));
            assert.equal(f.nl2br('<b>a</b>\nb', '<br class="x">'), '&lt;b&gt;a&lt;/b&gt;<br class="x">b');
        });

        it('escaping is idempotent on the five entities swig produces, as the e filter is', function () {
            var f = freshFactory()(bootArg(true));
            assert.equal(f.nl2br('&amp; &lt; &gt; &quot; &#39;'), '&amp; &lt; &gt; &quot; &#39;');
            assert.equal(f.nl2br('&nbsp;'), '&amp;nbsp;', 'entities swig does not produce are escaped, like the e filter');
        });
    });

    describe('03 - non-string input keeps its old behaviour (a TypeError) in both modes', function () {
        it('off and on both throw for undefined and for a number', function () {
            [bootArg(), bootArg(true)].forEach(function (arg) {
                var f = freshFactory()(arg);
                assert.throws(function () { f.nl2br(undefined); }, TypeError);
                assert.throws(function () { f.nl2br(5); }, TypeError);
            });
        });
    });

    describe('04 - through a real swig engine', function () {
        var TPL = '{{ x | nl2br }}';
        var X   = '<b>x</b>\ny';

        it('autoescape on + nl2br from an autoescape bundle: the text is escaped once, the break stays markup', function () {
            var f = freshFactory()(bootArg(true));
            var engine = new swigLib.Swig({ autoescape: true, cache: false });
            engine.setFilter('nl2br', f.nl2br);
            assert.equal(engine.render(TPL, { locals: { x: X } }), '&lt;b&gt;x&lt;/b&gt;<br/>y');
        });

        it('CONTROL — the pre-change filter on an autoescape engine renders the break as text (the defect)', function () {
            var engine = new swigLib.Swig({ autoescape: true, cache: false });
            engine.setFilter('nl2br', nl2brBefore);
            assert.equal(engine.render(TPL, { locals: { x: X } }), '&lt;b&gt;x&lt;/b&gt;&lt;br/&gt;y');
        });

        it('autoescape on: `| nl2br | safe` no longer emits the input raw', function () {
            var f = freshFactory()(bootArg(true));
            var engine = new swigLib.Swig({ autoescape: true, cache: false });
            engine.setFilter('nl2br', f.nl2br);
            assert.equal(engine.render('{{ x | nl2br | safe }}', { locals: { x: X } }), '&lt;b&gt;x&lt;/b&gt;<br/>y');
        });

        it('autoescape off: unchanged — raw text, raw break', function () {
            var f = freshFactory()(bootArg());
            var engine = new swigLib.Swig({ autoescape: false, cache: false });
            engine.setFilter('nl2br', f.nl2br);
            assert.equal(engine.render(TPL, { locals: { x: X } }), '<b>x</b><br/>y');
        });

        it('autoescape off + a `{% autoescape true %}` region: still escaped (nl2br is not .safe in off mode)', function () {
            var f = freshFactory()(bootArg());
            var engine = new swigLib.Swig({ autoescape: false, cache: false });
            engine.setFilter('nl2br', f.nl2br);
            var out = engine.render('{% autoescape true %}' + TPL + '{% endautoescape %}', { locals: { x: X } });
            assert.equal(out, '&lt;b&gt;x&lt;/b&gt;&lt;br/&gt;y', 'the region asked for escaping; nl2br must not bypass it');
        });
    });

    describe('05 - the factory is a first-call singleton: the first argument decides the mode', function () {
        it('a later call with another mode returns the same nl2br', function () {
            var Factory = freshFactory();
            var first  = Factory(bootArg(true));
            var second = Factory(requestArg(false));
            assert.strictEqual(second.nl2br, first.nl2br);
            assert.equal(second.nl2br.safe, true);
        });
    });
});

describe('#B690 — the asset placeholders the default swig delegate injects', function () {
    var SRC = fs.readFileSync(RS_PATH, 'utf8');
    function stripComments(s) {
        return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, '');
    }
    var CODE = stripComments(SRC);
    function count(h, n) { return h.split(n).length - 1; }
    /** Lift a regex literal assigned to a module constant (a literal captures nothing). */
    function liftRegex(name) {
        var m = SRC.match(new RegExp('var ' + name + '\\s*=\\s*(\\/.+\\/[a-z]*);'));
        assert.ok(m, name + ' is declared as a regex literal');
        return new Function('return ' + m[1])();
    }

    it('the injected placeholders carry `| safe`', function () {
        assert.ok(CODE.indexOf("var STYLESHEETS_PLACEHOLDER = '{{ page.view.stylesheets | safe }}';") > -1);
        assert.ok(CODE.indexOf("var SCRIPTS_PLACEHOLDER     = '{{ page.view.scripts | safe }}';") > -1);
    });

    it('every injection site uses them: 1 stylesheets site, 6 scripts sites, no bare placeholder injected', function () {
        assert.equal(count(CODE, "'\\n\\t'+ STYLESHEETS_PLACEHOLDER +'\\n</head>'"), 1, 'the stylesheets site');
        assert.equal(count(CODE, 'SCRIPTS_PLACEHOLDER'), 1 + 6, 'the declaration + 6 sites');
        // anti-vacuity: the raw source still names the bare form (in comments / the dead replace calls)
        assert.ok(count(SRC, '{{ page.view.scripts }}') >= 1);
        assert.equal(count(CODE, "'\\t{{ page.view.scripts }}"), 0, 'no bare scripts placeholder is injected');
        assert.equal(count(CODE, "'\\n\\t{{ page.view.stylesheets }}"), 0, 'no bare stylesheets placeholder is injected');
    });

    it('the placement checks accept the bare and the `| safe` forms, and nothing else', function () {
        var css = liftRegex('STYLESHEETS_PLACED_RE');
        var js  = liftRegex('SCRIPTS_PLACED_RE');
        ['{{ page.view.stylesheets }}', '{{ page.view.stylesheets | safe }}', '{{ page.view.stylesheets|safe }}',
            '{{  page.view.stylesheets  }}'].forEach(function (s) { assert.ok(css.test(s), s); });
        ['{{ page.view.scripts }}', '{{ page.view.scripts | safe }}', '{{ page.view.scripts|safe }}']
            .forEach(function (s) { assert.ok(js.test(s), s); });
        ['{{ page.view.stylesheetsX }}', '{{ page.view.stylesheets | upper }}', '{{ page.view.title }}']
            .forEach(function (s) { assert.equal(css.test(s), false, s); });
        ['{{ page.view.scripts | raw }}', '{{ page.view.scriptsX }}']
            .forEach(function (s) { assert.equal(js.test(s), false, s); });
    });

    it('rendered: `| safe` placeholders emit the tags raw with autoescape on, and unchanged with it off', function () {
        var data = { page: { view: {
            stylesheets: '<link href="/a.css" rel="stylesheet">',
            scripts    : '<script src="/a.js"></script>'
        } } };
        var tpl = '<head>{{ page.view.stylesheets | safe }}</head><body>{{ page.view.scripts | safe }}</body>';
        var on  = new swigLib.Swig({ autoescape: true,  cache: false }).render(tpl, { locals: data });
        var off = new swigLib.Swig({ autoescape: false, cache: false }).render(tpl, { locals: data });
        var bare = new swigLib.Swig({ autoescape: false, cache: false })
            .render(tpl.replace(/ \| safe/g, ''), { locals: data });
        assert.equal(on, '<head><link href="/a.css" rel="stylesheet"></head><body><script src="/a.js"></script></body>');
        assert.equal(off, bare, 'with autoescape off the | safe form renders exactly as the bare form did');
        // CONTROL — the bare form with autoescape on is the defect
        var defect = new swigLib.Swig({ autoescape: true, cache: false }).render(tpl.replace(/ \| safe/g, ''), { locals: data });
        assert.ok(defect.indexOf('&lt;link') > -1 && defect.indexOf('&lt;script') > -1);
        // an absent value renders nothing in both forms
        var empty = { page: { view: {} } };
        assert.equal(new swigLib.Swig({ autoescape: true, cache: false }).render(tpl, { locals: empty }), '<head></head><body></body>');
    });
});

describe('#B359 prep — the async swig delegate passes its engine\'s autoescape mode to the filters', function () {
    var A = fs.readFileSync(RSA_PATH, 'utf8');

    it('getSwigEngine hands registerGinaFilters the engine\'s own mode, and the factory receives it', function () {
        assert.ok(A.indexOf('registerGinaFilters(engine, SwigFilters, throwError, (autoescape === true));') > -1);
        assert.ok(A.indexOf('function registerGinaFilters(engine, SwigFilters, throwError, autoescape) {') > -1);
        assert.ok(A.indexOf("SwigFilters({ options: {}, isProxyHost: false, throwError: throwError, autoescape: (autoescape === true) });") > -1);
    });

    it('driven: registerGinaFilters lifted from the source registers an nl2br that matches the engine (fresh factory each time)', function () {
        // The function body references only its parameters, so lifting it is faithful.
        var m = A.match(/function registerGinaFilters\(engine, SwigFilters, throwError, autoescape\) \{[\s\S]*?\n\}/);
        assert.ok(m, 'registerGinaFilters found');
        var registerGinaFilters = new Function('return ' + m[0])();
        var priorFW = global.GINA_FRAMEWORK_DIR, priorU = global._;
        global.GINA_FRAMEWORK_DIR = FW;
        if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }
        try {
            [true, false].forEach(function (ae) {
                delete require.cache[require.resolve(SF_PATH)];
                var Factory = require(SF_PATH);
                var engine  = new swigLib.Swig({ autoescape: ae, cache: false });
                registerGinaFilters(engine, Factory, function () {}, ae);
                var out = engine.render('{{ x | nl2br }}', { locals: { x: '<b>x</b>\ny' } });
                assert.equal(out, ae ? '&lt;b&gt;x&lt;/b&gt;<br/>y' : '<b>x</b><br/>y', 'engine autoescape ' + ae);
            });
        } finally {
            delete require.cache[require.resolve(SF_PATH)];
            if (typeof priorFW === 'undefined') { delete global.GINA_FRAMEWORK_DIR; } else { global.GINA_FRAMEWORK_DIR = priorFW; }
            if (typeof priorU === 'undefined') { delete global._; } else { global._ = priorU; }
        }
    });
});
