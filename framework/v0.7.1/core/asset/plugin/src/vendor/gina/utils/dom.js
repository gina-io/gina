/**
 * Operations on selectors
 * */

function insertAfter(referenceNode, newNode) {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling)
}

function getElementsByAttribute(attribute) {
    var matching = [], m = 0;
    var els = document.getElementsByTagName('*');

    for (var i = 0, n = els.length; i < n; ++i) {
        if (els[i].getAttribute(attribute) !== null) {
            // Element exists with attribute. Add to array.
            matching[m] = els[i];
            ++m
        }
    }

    return matching
}

/*
 * DOMParser HTML extension
 * 2012-09-04
 * 
 * By Eli Grey, http://eligrey.com
 * Public domain.
 * 
 * Added in gina on: 2020-12-12
 * 
 */

/*! @source https://gist.github.com/eligrey/1129031 */
/*global document, DOMParser*/
(function(DOMParser) {
	"use strict";

	var proto = DOMParser.prototype, 
        nativeParse = proto.parseFromString;

	// Firefox/Opera/IE trigger errors for unsupported types
	try {
		// WebKit returns null for unsupported types
		if ((new DOMParser()).parseFromString("", "text/html")) {
			// text/html natvely supported
			return;
		}
	} catch (ex) {}

	proto.parseFromString = function(markup, type) {
		if (/^\s*text\/html\s*(?:;|$)/i.test(type)) {
			var doc = document.implementation.createHTMLDocument("");
			
			if (markup.toLowerCase().indexOf('<!doctype') > -1) {
				doc.documentElement.innerHTML = markup;
			}
			else {
				doc.body.innerHTML = markup;
			}
			return doc;
		} else {
			return nativeParse.apply(this, arguments);
		}
	};
}(DOMParser));
/**
 * bindRegion
 *
 * Binds a freshly injected HTML region — ONE policy, shared by fragment navigation
 * (`gina/nav`) and by the validator's form-answer swaps (#gh76 slice 2), so a third
 * copy of "what happens to injected content" never has to be written:
 *  - `<script src>` elements the document does not already have OUTSIDE the region are
 *    re-created in `<head>` (a `<script>` inserted through innerHTML never runs); a src the
 *    document already carries elsewhere — the page's own bundles, a copy an earlier swap or a
 *    popin injected — is not re-created, so a fragment may safely re-declare the page's
 *    scripts. Inline scripts are never executed: innerHTML semantics, the contract popin
 *    and nav content have always had;
 *  - `<link rel="stylesheet">` elements are left alone — inserted through innerHTML they are
 *    already live;
 *  - forms that opt in (#B549: a `data-gina-form-*` attribute, an id naming a registered rule,
 *    or a `gina-upload-*` id) are bound through the live validator's own `bindRegion`; a bare
 *    form keeps its native submit, exactly as on the initial page;
 *  - `<a data-gina-link>` anchors are bound through the live link plugin when one is active;
 *  - declarative `data-gina-dialog` triggers are document-delegated (nothing to bind); legacy
 *    `data-gina-popin-*` triggers are inert in injected content; custom elements upgrade
 *    natively.
 *
 * @param {HTMLElement} $root - the injected region: the swapped element, or the parent of
 *      nodes inserted beside it
 * @param {object} [options]
 * @param {string} [options.deferFormId] - a form id to SKIP: the submitting form of a swap
 *      that replaced it keeps its listeners until the swap's own events are delivered, so
 *      its replacement is bound by the caller afterwards
 * @param {boolean} [options.forms=true] - bind opted-in forms
 * @param {boolean} [options.links=true] - bind `data-gina-link` anchors
 *
 * @returns {{scripts: number, forms: number, links: number}} what was bound
 *
 * @example
 * $region.innerHTML = fragment;
 * bindRegion($region); // => { scripts: 1, forms: 2, links: 0 }
 */
function bindRegion($root, options) {
    var out = { scripts: 0, forms: 0, links: 0 };
    if ( !$root || typeof($root.getElementsByTagName) != 'function' ) {
        return out;
    }
    options = options || {};
    var _gina = ( typeof(window) != 'undefined' && window.gina ) ? window.gina : null;

    // scripts — dedup against every src the DOCUMENT carries outside the region: the
    // fragment's own copies are inert (innerHTML) and must not count as "already loaded"
    var known       = []
        , docScripts = document.getElementsByTagName('script')
        , scripts   = $root.getElementsByTagName('script')
        , src       = null
        , $s        = null
        , i         = 0
        , len       = docScripts.length
    ;
    for (; i < len; ++i) {
        if ( docScripts[i].src && !$root.contains(docScripts[i]) ) {
            known.push(docScripts[i].src);
        }
    }
    for (i = 0, len = scripts.length; i < len; ++i) {
        src = scripts[i].src; // the resolved absolute URL
        if ( !src || known.indexOf(src) > -1 ) continue;
        $s     = document.createElement('script');
        $s.src = src;
        document.head.appendChild($s);
        known.push(src);
        out.scripts++;
    }

    // forms — the validator owns the opt-in gate (#B549)
    if (
        options.forms !== false
        && _gina && _gina.hasValidator && _gina.validator
        && typeof(_gina.validator.bindRegion) == 'function'
    ) {
        try {
            out.forms = _gina.validator.bindRegion($root, { deferFormId: options.deferFormId || null });
        } catch (formsErr) {
            if ( typeof(console) != 'undefined' && console.warn ) {
                console.warn('[gina][bindRegion] form binding failed: ' + (formsErr.message || formsErr));
            }
        }
    }

    // links — the link plugin binds the anchors that opt in
    if (
        options.links !== false
        && _gina && _gina.hasLinkHandler && _gina.link
        && typeof(_gina.link.bindLinks) == 'function'
    ) {
        try {
            _gina.link.bindLinks($root);
            out.links = $root.querySelectorAll('a[data-gina-link]:not([data-gina-link="false"])').length;
        } catch (linksErr) {
            if ( typeof(console) != 'undefined' && console.warn ) {
                console.warn('[gina][bindRegion] link binding failed: ' + (linksErr.message || linksErr));
            }
        }
    }

    return out;
}
