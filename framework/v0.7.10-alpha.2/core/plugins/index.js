/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Gina.Core.Plugins Class
 *
 * @package    Gina.Core
 * @author     Rhinostone <contact@gina.io>
 */

function Plugins() {

    var _require = function(path) {
        var isCacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
        if (isCacheless) {
            try {
                delete require.cache[require.resolve(path)];
                return require(path)
            } catch (err) {
                throw err
            }

        } else {
            return require(path)
        }
    }


    var self =  {
        Validator           : _require('./lib/validator'),
        // #CSRF1 — hardened session-cookie wrapper around express-session.
        Session             : _require('./lib/session'),
        // #CSRF2 — signed double-submit token CSRF middleware.
        Csrf                : _require('./lib/csrf'),
        // #HDR1 — X-Content-Type-Options: nosniff response header.
        XContentTypeOptions : _require('./lib/security-headers/x-content-type-options'),
        // #HDR2 — X-Frame-Options clickjacking-defense response header.
        XFrameOptions       : _require('./lib/security-headers/x-frame-options'),
        // #HDR3 — Referrer-Policy response header.
        ReferrerPolicy      : _require('./lib/security-headers/referrer-policy'),
        // #HDR4 — HSTS (Strict-Transport-Security) response header.
        Hsts                : _require('./lib/security-headers/hsts'),
        // #HDR5 — Content-Security-Policy response header.
        Csp                 : _require('./lib/security-headers/csp'),
        // #HDR6 — Cross-Origin-Embedder-Policy response header.
        Coep                : _require('./lib/security-headers/coep'),
        // #HDR7 — Origin-Agent-Cluster response header (origin-keyed isolation).
        OriginAgentCluster  : _require('./lib/security-headers/origin-agent-cluster'),
        // #HDR8 — X-Powered-By response-header removal (helmet-parity gap-fill, opens Phase 1.5).
        HidePoweredBy       : _require('./lib/security-headers/hide-powered-by'),
        // #HDR9 — X-DNS-Prefetch-Control response header (helmet-parity gap-fill).
        XDnsPrefetchControl : _require('./lib/security-headers/x-dns-prefetch-control'),
        // #HDR10 — X-XSS-Protection: 0 response header — DISABLES Chrome legacy XSS auditor (helmet-parity).
        XXssProtection      : _require('./lib/security-headers/x-xss-protection'),
        // #HDR11 — X-Download-Options: noopen response header — IE-legacy (helmet-parity).
        XDownloadOptions    : _require('./lib/security-headers/x-download-options'),
        // #HDR12 — X-Permitted-Cross-Domain-Policies response header — Adobe Flash/PDF legacy (closes Phase 1.5).
        XPermittedCrossDomainPolicies : _require('./lib/security-headers/x-permitted-cross-domain-policies'),
        // #HDR13 — Cross-Origin-Opener-Policy response header.
        Coop                : _require('./lib/security-headers/coop'),
        // #HDR14 — Cross-Origin-Resource-Policy response header.
        Corp                : _require('./lib/security-headers/corp'),
        // #HDR15 — Security Headers combined wrapper (composes HDR1-7 + HDR5 + HDR6/13/14).
        SecurityHeaders     : _require('./lib/security-headers')
    };

    return self
};

module.exports = Plugins()