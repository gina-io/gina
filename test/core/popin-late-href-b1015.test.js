/**
 * #B1015 — an `<a>` with no `href` in popin content, which the page gives a real `href` after gina has bound
 * it, did nothing when clicked. #B1016 — a link carrying `download` was loaded into the popin by XHR, its file
 * written into the popin, instead of being saved. #B1018 — a link whose URL has a scheme other than http(s)
 * (`mailto:`, `tel:`, `javascript:`) was fetched by XHR, which failed with an error.
 *
 * popinBind's bind loop types an `<a>` with no `href` as an action (`href="#"`, a `popin.click.*` id,
 * `data-gina-popin-is-link="false"`), and register()'s click listener cancelled every click on it. Every link
 * clicked in popin content was loaded into the popin, whatever its `download` or its scheme. Now register()'s
 * listener leaves a link carrying `download`, or whose URL has a scheme other than http(s), to the browser,
 * and lets an action `<a>` the page has given a real `href` follow the link rules: it loads into the popin, or
 * it is left to the browser when it carries a `target`, a `download`, a `#` in its URL or such a scheme. The
 * link's own click listener (in the bind loop) returns for an `<a>` typed as an action (it gets that listener
 * when the content is bound again after the page gave it an `href`, a partial swap) and for a link left to the
 * browser, before it cancels the click or sets `$popin.isRedirecting`.
 *
 *   01 the source: register()'s click listener opens with the #B1016 / #B1018 test, then the #B1015 one, then
 *      the cancel it opened with before; the link's own click listener opens with its two returns
 *   02 the built bundles carry the change: gina.js (the same lines) and gina.min.js (their minified form)
 *
 * The browser flows (a late `href` loaded, downloaded or opened in its window, a `download` link, a `mailto:`
 * or `tel:` link, a partial swap) are driven in test/e2e/popin-late-href-b1015.spec.js.
 *
 * Seams, so the whole file runs against pre-fix bytes without touching the tree:
 *   GINA_B1015_POPIN_SRC=<a copy of popin/main.js>   (01)
 *   GINA_B1015_DIST_DIR=<a directory holding gina.js and gina.min.js>   (02)
 *
 * Usage: node --test test/core/popin-late-href-b1015.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC_PATH = process.env.GINA_B1015_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_DIR       = process.env.GINA_B1015_DIST_DIR || path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');

var popinSrc = fs.readFileSync(POPIN_SRC_PATH, 'utf8');

/**
 * Drops the full-line `//` comments, so a comment naming the old code cannot satisfy a pin.
 * @inner
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/**
 * Collapses every run of whitespace to one space, so the pins do not depend on line breaks or indentation.
 * @inner
 * @param {string} text
 * @returns {string}
 */
function flat(text) {
    return text.replace(/\s+/g, ' ');
}

/**
 * Non-overlapping occurrences of `needle` in `hay`.
 * @inner
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    var n = 0, i = hay.indexOf(needle);
    while (i > -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
}

// the lines the change adds, whitespace collapsed
var SCHEME = function (e) {
    return '/^[a-z][a-z0-9+.\\-]*:/i.test(' + e + '.currentTarget.getAttribute(\'href\')) && !/^https?:/i.test(' + e + '.currentTarget.getAttribute(\'href\'))';
};
var ENABLED = function (e) {
    return '( ' + e + '.currentTarget.getAttribute(\'disabled\') == null || ' + e + '.currentTarget.getAttribute(\'disabled\') == \'false\' )';
};
var REG_OPEN    = 'addListener(gina, $element, \'click\', function(event) {';
var REG_TO_BROWSER = REG_OPEN + ' if ( type == \'link\' && ( event.currentTarget.getAttribute(\'download\') != null || ' + SCHEME('event') + ' ) && ' + ENABLED('event') + ' ) { event.stopPropagation(); return; }';
var REG_LATE    = 'if ( type == \'action\' && /^false$/i.test(event.currentTarget.getAttribute(\'data-gina-popin-is-link\')) && !_rePopinClick.test(event.currentTarget.id)'
    + ' && event.currentTarget.getAttribute(\'href\') && event.currentTarget.getAttribute(\'href\') != \'#\' && ' + ENABLED('event') + ' ) {'
    + ' if ( event.currentTarget.getAttribute(\'target\') != null && event.currentTarget.getAttribute(\'target\') != \'\' || event.currentTarget.getAttribute(\'download\') != null'
    + ' || /#/.test(event.currentTarget.getAttribute(\'href\')) || ' + SCHEME('event') + ' ) { event.stopPropagation(); return; }'
    + ' cancelEvent(event); $popin.isRedirecting = true; triggerEvent(gina, event.target, event.currentTarget.id, $popin); return; } cancelEvent(event);';
var OWN_OPEN    = 'addListener(gina, $link[i], \'click\', function(linkEvent) {';
var OWN_RETURNS = OWN_OPEN + ' if ( /^false$/i.test(linkEvent.currentTarget.getAttribute(\'data-gina-popin-is-link\')) ) { return; }'
    + ' if ( ( linkEvent.currentTarget.getAttribute(\'download\') != null || ' + SCHEME('linkEvent') + ' ) && ' + ENABLED('linkEvent') + ' ) { return; }'
    + ' linkEvent.preventDefault();';
// the listeners' first statements before the change: present once in the pre-fix bytes
var REG_WAS = REG_OPEN + ' cancelEvent(event);';
var OWN_WAS = OWN_OPEN + ' linkEvent.preventDefault();';

/**
 * The pins shared by the source and gina.js.
 * @inner
 * @param {string} code - comment-stripped, whitespace-collapsed text
 */
function assertChange(code) {
    assert.equal(count(code, REG_WAS), 0, 'register()\'s click listener no longer opens with its cancel');
    assert.equal(count(code, REG_TO_BROWSER + ' ' + REG_LATE), 1, 'register()\'s click listener opens with the #B1016 / #B1018 test, then the #B1015 one, then its cancel');
    assert.equal(count(code, OWN_WAS), 0, 'the link\'s own click listener no longer opens with preventDefault()');
    assert.equal(count(code, OWN_RETURNS), 1, 'the link\'s own click listener returns for an action <a> and for a link left to the browser, before preventDefault()');
}

/**
 * The controls shared by the source and gina.js: true on the pre-fix bytes too.
 * @inner
 * @param {string} code - comment-stripped, whitespace-collapsed text
 */
function assertControls(code) {
    assert.equal(count(code, REG_OPEN), 1, 'register()\'s click listener is found once');
    assert.equal(count(code, OWN_OPEN), 1, 'the link\'s own click listener is found once');
    assert.equal(count(code, 'var _rePopinClick = new RegExp(\'^popin\\\\.click\\\\.gina-popin-\' + instance.id + \'-\');'), 1, 'the legacy-trigger id pattern is defined once');
    assert.equal(count(code, 'var _isClickTrigger = /^popin\\.click\\./.test(event.currentTarget.id);'), 1, 'the close branch\'s trigger test is found once');
}

var srcCode = flat(stripLineComments(popinSrc));

describe('#B1015 01 - the source: register()\'s listener and the link\'s own listener test their element first', function () {

    it('control: each listener, the legacy-trigger pattern and the close branch\'s test are found once', function () {
        assertControls(srcCode);
    });

    it('the two listeners open with the new tests (comments dropped first)', function () {
        assertChange(srcCode);
    });
});

describe('#B1015 02 - the built bundles carry the change', function () {

    var distJs  = fs.readFileSync(path.join(DIST_DIR, 'gina.js'), 'utf8');
    var distMin = fs.readFileSync(path.join(DIST_DIR, 'gina.min.js'), 'utf8').replace(/\n/g, '');
    var distCode = flat(stripLineComments(distJs));

    // Closure renames the variables and rewrites each test (De Morgan), so the minified pins are shaped from
    // the built file: «e» the event, «t» register()'s `type`, «r» `_rePopinClick`, «p» the popin, «el» the
    // element, «a» / «i» the bind loop's `$link` / index. A name's first use captures it, later uses must match.
    /**
     * Builds a RegExp from minified text with «name» placeholders.
     * @inner
     * @param {string} template
     * @returns {RegExp}
     */
    function shape(template) {
        var seen = {};
        var src = template.split(/(«\w+»)/).map(function (part) {
            var m = /^«(\w+)»$/.exec(part);
            if (!m) return part.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
            if (seen[m[1]]) return '\\k<' + m[1] + '>';
            seen[m[1]] = true;
            return '(?<' + m[1] + '>[\\w$]+)';
        }).join('');
        return new RegExp(src, 'g');
    }
    var M_SCHEME_NOT = '(!/^[a-z][a-z0-9+.\\-]*:/i.test(«e».currentTarget.getAttribute(\'href\'))||/^https?:/i.test(«e».currentTarget.getAttribute(\'href\')))';
    var M_DISABLED   = '«e».currentTarget.getAttribute(\'disabled\')!=null&&«e».currentTarget.getAttribute(\'disabled\')!=\'false\'';
    // …addListener(gina,Gb,'click',function(mb){if(ub!='link'||mb.currentTarget.getAttribute('download')==null&&(!/^[a-z]…:/i.test(…)||/^https?:/i.test(…))||…disabled…)if(ub!='action'||…){cancelEvent(mb);…
    var MIN_REG_OPEN = shape('addListener(gina,«el»,\'click\',function(«e»){if(«t»!=\'link\'||«e».currentTarget.getAttribute(\'download\')==null&&' + M_SCHEME_NOT + '||' + M_DISABLED + ')'
        + 'if(«t»!=\'action\'||!/^false$/i.test(«e».currentTarget.getAttribute(\'data-gina-popin-is-link\'))||«r».test(«e».currentTarget.id)||!«e».currentTarget.getAttribute(\'href\')'
        + '||«e».currentTarget.getAttribute(\'href\')==\'#\'||' + M_DISABLED + '){cancelEvent(«e»);');
    // …}else mb.currentTarget.getAttribute('target')!=null&&…||…download…||/#/.test(…)||…scheme…?mb.stopPropagation():(cancelEvent(mb),u.isRedirecting=!0,triggerEvent(gina,mb.target,mb.currentTarget.id,u));else mb.stopPropagation()})
    var MIN_REG_LATE = shape('}else «e».currentTarget.getAttribute(\'target\')!=null&&«e».currentTarget.getAttribute(\'target\')!=\'\'||«e».currentTarget.getAttribute(\'download\')!=null'
        + '||/#/.test(«e».currentTarget.getAttribute(\'href\'))||/^[a-z][a-z0-9+.\\-]*:/i.test(«e».currentTarget.getAttribute(\'href\'))&&!/^https?:/i.test(«e».currentTarget.getAttribute(\'href\'))'
        + '?«e».stopPropagation():(cancelEvent(«e»),«p».isRedirecting=!0,triggerEvent(gina,«e».target,«e».currentTarget.id,«p»));else «e».stopPropagation()})');
    // …addListener(gina,na[fa],'click',function(ub){if(!/^false$/i.test(…is-link…)&&(…download…==null&&(…scheme…)||…disabled…)){ub.preventDefault();…
    var MIN_OWN      = shape('addListener(gina,«a»[«i»],\'click\',function(«e»){if(!/^false$/i.test(«e».currentTarget.getAttribute(\'data-gina-popin-is-link\'))'
        + '&&(«e».currentTarget.getAttribute(\'download\')==null&&' + M_SCHEME_NOT + '||' + M_DISABLED + ')){«e».preventDefault();');
    // the pre-fix openings, each unique to its listener
    var MIN_REG_WAS  = shape('addListener(gina,«el»,\'click\',function(«e»){cancelEvent(«e»);if(!(\'disabled\'in «e».currentTarget)');
    var MIN_OWN_WAS  = shape('addListener(gina,«a»[«i»],\'click\',function(«e»){«e».preventDefault();var ');
    // controls: the close branch's trigger test and the link's #B1007 gate, in both the pre-fix and the fixed bytes
    var MIN_CLOSE_CTL = shape('=/^popin\\.click\\./.test(«e».currentTarget.id),');
    var MIN_B1007_CTL = shape('if(\'disabled\'in «v»||«v».getAttribute(\'disabled\')==null||«v».getAttribute(\'disabled\')==\'false\')');

    it('control: gina.js carries each listener once; gina.min.js carries the close branch\'s test and the #B1007 gate once', function () {
        assertControls(distCode);
        assert.equal((distMin.match(MIN_CLOSE_CTL) || []).length, 1);
        assert.equal((distMin.match(MIN_B1007_CTL) || []).length, 1);
    });

    it('gina.js: the same lines as the source', function () {
        assertChange(distCode);
    });

    it('gina.min.js: register()\'s listener opens with the two tests, and the late link\'s branch leaves a target, a download, a # or another scheme to the browser', function () {
        assert.equal((distMin.match(MIN_REG_WAS) || []).length, 0, 'the listener no longer opens with its cancel');
        assert.equal((distMin.match(MIN_REG_OPEN) || []).length, 1, 'the listener opens with the #B1016 / #B1018 test, then the #B1015 one');
        var open = new RegExp(MIN_REG_OPEN.source).exec(distMin);
        var late = new RegExp(MIN_REG_LATE.source).exec(distMin.slice(open.index));
        assert.ok(late, 'the late link\'s branch follows, in the same listener');
        assert.equal(late.groups.e, open.groups.e, 'it reads the same event');
        assert.equal((distMin.match(MIN_REG_LATE) || []).length, 1);
    });

    it('gina.min.js: the link\'s own listener returns for an action <a> and for a link left to the browser, before preventDefault()', function () {
        assert.equal((distMin.match(MIN_OWN_WAS) || []).length, 0, 'the listener no longer opens with preventDefault()');
        assert.equal((distMin.match(MIN_OWN) || []).length, 1);
    });
});
