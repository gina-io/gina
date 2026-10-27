/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/domain
 * @description Thin wrapper around the `psl` npm package (MIT, Public Suffix List).
 *
 * Preserves the historical `new Domain()` / `new Domain(cb)` instantiation shapes
 * and the single public method `getRootDomain(hostOrUrl, [jsonFormat])` that returns
 * `{ value, isSLD, isRegisteredTldOrSld }`.
 *
 * Semantics derived from `psl.parse(host)`:
 *   - `value`              : psl's `.domain` if non-null; otherwise hostname with the
 *                            last 2 labels joined (matches today's lib when psl has
 *                            no matching rule, e.g. `api.svc.cluster.local` -> `cluster.local`).
 *   - `isSLD`              : true when psl's suffix (`.tld`) is multi-label (e.g. `co.uk`).
 *   - `isRegisteredTldOrSld`: true when psl actually matched a rule (`.listed`).
 *
 * Reserved / pseudo TLDs (`.local`, `.localhost`, IPs, single-label) take the fallback
 * branch, matching today's behaviour exactly on the lib/domain test fixtures.
 */

var _isNode = ( typeof(module) !== 'undefined' && module.exports );
var _psl = null;
if ( _isNode ) {
    _psl = require('psl');
}

function parseHostname(input) {
    var hostname = String(input == null ? '' : input).trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');    // strip protocol
    hostname = hostname.split(/[\/?#]/)[0];          // strip path/query/hash
    if ( hostname.charAt(0) === '[' ) {
        var end = hostname.indexOf(']');
        if ( end !== -1 ) {
            hostname = hostname.slice(1, end);       // IPv6 literal: [::1] -> ::1
        }
    } else {
        var colon = hostname.lastIndexOf(':');
        if ( colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1)) ) {
            hostname = hostname.slice(0, colon);     // strip :port
        }
    }
    return hostname;
}

function lastTwoLabels(hostname) {
    if ( !hostname ) return hostname;
    var parts = hostname.split('.');
    if ( parts.length <= 2 ) return hostname;
    return parts.slice(-2).join('.');
}

function Domain(options, cb) {

    var self = this;
    this.name = 'Domain';

    if ( typeof(arguments[0]) === 'function' ) {
        cb = arguments[0];
        options = undefined;
    }

    this.getRootDomain = function(urlOrHostname, jsonFormat) {
        var hostname = parseHostname(urlOrHostname);

        // IPv4 literal short-circuit — psl would strip to last two octets.
        if ( /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ) {
            return { value: hostname, isSLD: false, isRegisteredTldOrSld: false };
        }

        // psl is resolved lazily: assigned at module load in Node, via AMD factory in the browser.
        var psl = _psl || ( typeof(window) !== 'undefined' && window.psl ? window.psl : null );
        var parsed = null;
        if ( psl && hostname ) {
            try { parsed = psl.parse(hostname); } catch (e) { parsed = null; }
        }

        var value, isSLD = false, isRegisteredTldOrSld = false;
        if ( parsed && parsed.domain ) {
            value = parsed.domain;
            isSLD = !!(parsed.listed && parsed.tld && parsed.tld.indexOf('.') > -1);
            isRegisteredTldOrSld = !!parsed.listed;
        } else {
            // psl returned no rule match (reserved pseudo-TLDs, IPs, single-label).
            value = lastTwoLabels(hostname);
        }

        return { value: value, isSLD: isSLD, isRegisteredTldOrSld: isRegisteredTldOrSld };
    };

    // Kept for backwards compatibility — no-op now that psl ships PSL data in-package.
    this.updatePSL = function(done) { if (done) done(false); };

    if ( _isNode ) {
        this.getFQDN = async function(hostname) {
            var os       = require('os');
            var dns      = require('dns');
            var util     = require('util');
            var host = ( typeof(hostname) !== 'undefined' && hostname !== '' ) ? hostname : os.hostname();
            if ( /\./.test(host) ) return host;
            var ipObj = await util.promisify(dns.lookup)(host, { hints: dns.ADDRCONFIG || dns.V4MAPPED });
            var svc   = await util.promisify(dns.lookupService)(ipObj.address, 0);
            if ( !/\./.test(svc.hostname) ) {
                throw new Error('[DOMAIN][getFQDN] `' + svc.hostname + '` is not a FQDN !');
            }
            return svc.hostname;
        };
    }

    // `new Domain(cb)` — callback form used by the browser plugins (link/popin) + test harness.
    // psl data ships synchronously; callback fires on next tick for API compatibility.
    if ( cb ) {
        setTimeout(function() { cb(false, self); }, 0);
    }

    return self;
}

if ( _isNode ) {
    module.exports = Domain;
} else if ( typeof(define) === 'function' && define.amd ) {
    // RequireJS resolves `vendor/gina/psl` (the vendored psl UMD) before this factory runs,
    // and assigns it to the module-level `_psl` so `getRootDomain` can use it synchronously.
    define(['vendor/gina/psl'], function(pslDep) {
        _psl = pslDep;
        return Domain;
    });
}
