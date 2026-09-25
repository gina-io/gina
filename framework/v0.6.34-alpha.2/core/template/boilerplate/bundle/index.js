/**
 * ${Bundle} bundle
 *
 * */
var ${bundle} = require('gina');

// gina lib samples
// var lib             = ${bundle}.lib;
// var routing         = lib.routing;
// var console         = lib.logger;
// var operate         = lib.math.operate;
// var Collection      = lib.Collection;
// var SessionStore    = lib.SessionStore; // see: https://gina.io/docs/guides/sessions
// var Domain          = lib.Domain;


// Do whatever things you need to do before server starts
// e.g.: register session, set a shared path for your template engine ...
// This is mostly pre-start configuration
//${bundle}.onInitialize( function(event, app, express){//
//    var self = ${bundle};
//    // getting config/app.json would be: self.getConfig('app')
//    // or self.getConfig().app
//    var conf = self.getConfig();
//
//    // --- Session store (pick one backend) ---
//    // var expressSession = require('express-session');
//    //
//    // #CSRF1 — wrap express-session with hardened cookie defaults from
//    // settings.json > session.cookie.* (SameSite=Lax, HttpOnly, Secure="auto").
//    // The bundle's cookie options below still override the defaults.
//    // var session = ${bundle}.plugins.Session(expressSession);
//    //
//    // Redis — multi-pod / K8s (requires: npm install ioredis)
//    // Configure connectors.json: { "session": { "connector": "redis", "host": "...", "port": 6379, "ttl": 86400 } }
//    //
//    // SQLite — dev / staging / single-pod (requires: Node >= 22.5.0, zero npm deps)
//    // Configure connectors.json: { "session": { "connector": "sqlite", "database": ":memory:", "ttl": 86400 } }
//    //
//    // The store factory keys on express-session's function name — the literal
//    // "session", which is read-only and cannot be re-pointed — so the
//    // connectors.json entry MUST be named "session"; its `connector` field
//    // selects the backend (#B206).
//    // var StoreClass = new SessionStore(expressSession);  // returns connector-specific Store class
//    //
//    // Recommended: keep the session secret out of tracked source via the
//    // ${secret:KEY} placeholder pattern. Put it in bundle/config/session.json:
//    //   { "secret": "${secret:SESSION_SECRET}" }
//    // then read via self.getConfig('session').secret. lib/secrets fills
//    // the placeholder from process.env.SESSION_SECRET at config-load time.
//    // See https://gina.io/docs/guides/secrets for details.
//    //
//    // app.use(session({
//    //     secret           : self.getConfig('session').secret,  // ${secret:SESSION_SECRET}
//    //     resave           : false,
//    //     saveUninitialized: false,
//    //     store            : new StoreClass(),
//    //     cookie           : { maxAge: 86400000 }
//    // }));
//    //
//    // #CSRF2 — signed double-submit token middleware. Reads its HMAC secret
//    // from settings.json > csrf.secret (recommended; supports ${secret:KEY}
//    // placeholders), or falls back to process.env.GINA_CSRF_SECRET
//    // (back-compat). Generate the secret once with `openssl rand -base64 64`.
//    // MUST be registered AFTER the session middleware. Per-route opt-out
//    // for webhook receivers via `routing.json > "csrfExempt": true`.
//    // var csrf = ${bundle}.plugins.Csrf();
//    // app.use(csrf);
//
//    // #HDR1 — X-Content-Type-Options: nosniff response header. Blocks
//    // MIME-sniffing attacks by instructing browsers to trust the declared
//    // Content-Type strictly. No required configuration; nosniff is the
//    // only valid value per RFC 7034. Order with other gina security
//    // plugins does not matter — the header is emitted on the response,
//    // not consumed from the request.
//    // var xContentTypeOptions = ${bundle}.plugins.XContentTypeOptions();
//    // app.use(xContentTypeOptions);
//
//    // #HDR2 — X-Frame-Options clickjacking-defense response header.
//    // Reads its value from settings.json > xFrameOptions.value ("DENY"
//    // or "SAMEORIGIN"; default "SAMEORIGIN"). Caller options always win
//    // — pass { value: 'DENY' } here to override. Legacy
//    // "ALLOW-FROM <uri>" is rejected at factory call time; use CSP
//    // `frame-ancestors` for cross-browser allow-listing.
//    // var xFrameOptions = ${bundle}.plugins.XFrameOptions();
//    // app.use(xFrameOptions);
//
//    // #HDR3 — Referrer-Policy response header. Reads its value from
//    // settings.json > referrerPolicy.value (one of the 8 W3C tokens;
//    // default "strict-origin-when-cross-origin" — matches modern
//    // browsers since ~2021). Caller options always win — pass
//    // { value: 'no-referrer' } here for stricter privacy or
//    // { value: 'same-origin' } to suppress all cross-origin referrer
//    // leakage. Unknown tokens throw at factory call time.
//    // var referrerPolicy = ${bundle}.plugins.ReferrerPolicy();
//    // app.use(referrerPolicy);
//
//    // #HDR4 — HSTS (Strict-Transport-Security) response header.
//    // Reads its three fields from settings.json > hsts.{maxAge,
//    // includeSubDomains, preload} (defaults: 15552000 = 180 days,
//    // false, false). Caller options always win. Browser-parity
//    // invariant: preload:true requires includeSubDomains:true AND
//    // maxAge>=31536000 (1 year) per the HSTS preload-list submission
//    // requirements (https://hstspreload.org/); factory throws on
//    // invariant violations. Only register in HTTPS-only bundles —
//    // browsers ignore HSTS on HTTP responses anyway, but emitting on
//    // HTTP is technically RFC 6797 §7.2 noncompliant.
//    // var hsts = ${bundle}.plugins.Hsts();
//    // app.use(hsts);
//
//    // #HDR5 — Content-Security-Policy response header. Reads its
//    // directives + reportOnly from settings.json > csp.{directives,
//    // reportOnly}. **directives is required** — there is no sensible
//    // cross-bundle default; populate settings.json > csp.directives
//    // before mounting (see example in settings.json comment) or pass
//    // them directly here. Strict CSP Level 3 whitelist on directive
//    // names — typos throw at factory call time. reportOnly:true emits
//    // Content-Security-Policy-Report-Only for non-enforcing migration
//    // testing. useNonce:true generates a per-response nonce, appends it
//    // to script-src, and stamps it on every framework-injected inline
//    // <script> so the bundle can drop 'unsafe-inline' from script-src.
//    // var csp = ${bundle}.plugins.Csp();
//    // app.use(csp);
//
//    // #HDR6 — Cross-Origin-Embedder-Policy response header. Reads its
//    // value from settings.json > coep.value (one of "require-corp",
//    // "credentialless", "unsafe-none"; default "require-corp"). Caller
//    // options always win — pass { value: 'credentialless' } for less
//    // restrictive embed-without-credentials behaviour, or
//    // { value: 'unsafe-none' } to opt out. Required (paired with
//    // #HDR13 gina.plugins.Coop() at "same-origin") to enable
//    // SharedArrayBuffer and high-resolution performance.now().
//    // BREAKS cross-origin embeds without matching CORP/CORS headers —
//    // know your resource graph before enabling at "require-corp".
//    // var coep = ${bundle}.plugins.Coep();
//    // app.use(coep);
//
//    // #HDR7 — Origin-Agent-Cluster: ?1 response header. Requests
//    // origin-keyed agent clustering — same-site cross-origin pages
//    // get isolated agents (can no longer reach in via document.domain).
//    // Mitigates one class of Spectre side-channel attack. No required
//    // configuration; ?1 is the only useful value per the HTML spec.
//    // Browser support: Chrome 88+, Edge 88+, Firefox 109+, Safari 15+;
//    // older browsers ignore silently. Don't register if the bundle
//    // relies on document.domain to bridge same-site origins.
//    // var originAgentCluster = ${bundle}.plugins.OriginAgentCluster();
//    // app.use(originAgentCluster);
//
//    // #HDR8 — X-Powered-By response-header REMOVAL. Opens Phase 1.5
//    // (helmet-parity gap-fill). Removes the X-Powered-By: Gina/<ver>
//    // header that the framework emits by default, reducing the
//    // attacker's reconnaissance surface (they no longer learn the
//    // server stack identity from the response header). Different
//    // SHAPE from the other HDR plugins: REMOVE not SET. No tunable
//    // options. Express engine: middleware intercepts setHeader cleanly.
//    // Isaac engine: middleware is a no-op (writeHead commits headers
//    // before middleware runs); set `settings.json > server.hidePoweredBy:
//    // true` to gate the `_setPoweredByHeader()` helper that backs every
//    // Isaac emit site (~15 writeHead + 1 setHeader). README documents
//    // the per-engine split.
//    // var hidePoweredBy = ${bundle}.plugins.HidePoweredBy();
//    // app.use(hidePoweredBy);
//
//    // #HDR9 — X-DNS-Prefetch-Control response header. Phase 1.5
//    // (helmet-parity). Controls whether the browser proactively
//    // resolves DNS for links/images/CSS/JS referenced by the page.
//    // "off" (default) is the privacy-respecting choice. "on" enables
//    // prefetching for perceived-performance gains at the cost of
//    // leaking the page's link surface to the DNS resolver.
//    //   value — one of "on" / "off" (default "off").
//    // helmet uses { allow: boolean }; gina uses { value: 'on'|'off' }
//    // matching the single-token-enum convention.
//    // var xDnsPrefetchControl = ${bundle}.plugins.XDnsPrefetchControl();
//    // app.use(xDnsPrefetchControl);
//
//    // #HDR10 — X-XSS-Protection: 0 response header. Phase 1.5
//    // (helmet-parity). Emits the literal "0" to DISABLE Chrome's
//    // legacy XSS auditor (the auditor itself had vulnerabilities;
//    // disabling is the modern recommendation per MDN). The "0" is
//    // deliberate — do NOT change to "1". Use #HDR5 Csp for actual
//    // XSS defense. Effectively no-op in modern browsers; defense-
//    // in-depth + helmet-parity narrative. No tunable options.
//    // var xXssProtection = ${bundle}.plugins.XXssProtection();
//    // app.use(xXssProtection);
//
//    // #HDR11 — X-Download-Options: noopen response header. Phase 1.5
//    // (helmet-parity). IE-legacy: prevents IE8+ from opening
//    // downloads in the site's security context (an old IE vuln
//    // shape). Modern browsers ignore the header; only IE10/IE11
//    // honour it (both EOL since 2022). Effectively no-op in modern
//    // browsers; defense-in-depth + helmet-parity. "noopen" is the
//    // only valid value per MSDN. No tunable options.
//    // var xDownloadOptions = ${bundle}.plugins.XDownloadOptions();
//    // app.use(xDownloadOptions);
//
//    // #HDR12 — X-Permitted-Cross-Domain-Policies response header.
//    // Phase 1.5 (helmet-parity) — CLOSES Phase 1.5. Restricts
//    // Adobe Flash and PDF readers from honouring cross-domain
//    // policy files served from this origin.
//    //   value — one of "none" (default) / "master-only" /
//    //           "by-content-type" / "all".
//    // helmet uses { permittedPolicies }; gina uses { value }
//    // matching the single-token-enum convention.
//    // Flash EOL since December 2020; mostly no-op in modern
//    // PDF readers. Defense-in-depth + helmet-parity.
//    // var xPermittedCrossDomainPolicies = ${bundle}.plugins.XPermittedCrossDomainPolicies();
//    // app.use(xPermittedCrossDomainPolicies);
//
//    // #HDR13 — Cross-Origin-Opener-Policy response header. Reads its
//    // value from settings.json > coop.value (one of "same-origin",
//    // "same-origin-allow-popups", "noopener-allow-popups",
//    // "unsafe-none"; default "same-origin"). Caller options always
//    // win — pass { value: 'same-origin-allow-popups' } if the bundle
//    // hosts OAuth popups that need same-origin opener references, or
//    // { value: 'noopener-allow-popups' } (Chrome 119+ / Firefox 131+)
//    // to sever opener while keeping the popup window open.
//    // Required (paired with #HDR6 gina.plugins.Coep() at
//    // "require-corp") to enable SharedArrayBuffer and high-resolution
//    // performance.now(). The "same-origin" default BREAKS OAuth /
//    // SSO popup flows where the popup needs to call
//    // window.opener.postMessage(...) back — pick an
//    // -allow-popups variant for those.
//    // var coop = ${bundle}.plugins.Coop();
//    // app.use(coop);
//
//    // #HDR14 — Cross-Origin-Resource-Policy response header. Reads
//    // its value from settings.json > corp.value (one of "same-origin",
//    // "same-site", "cross-origin"; default "same-origin"). Caller
//    // options always win — pass { value: 'cross-origin' } for
//    // resources intended to be publicly embeddable (CDN fonts,
//    // analytics images, public APIs), or { value: 'same-site' } for
//    // first-party multi-subdomain setups (app.example.com embedding
//    // cdn.example.com assets while still blocking evil.com).
//    // Resource-side complement to #HDR6 gina.plugins.Coep() —
//    // cross-origin embeds under Coep: require-corp need the embed-
//    // target bundle to set Corp: cross-origin (or wider) to load.
//    // var corp = ${bundle}.plugins.Corp();
//    // app.use(corp);
//
//    // #HDR15 — Security Headers combined wrapper. Composes the full
//    // HDR1-14 set in a single mount + one settings.json block. With
//    // no opts emits the SAFE-SET (xContentTypeOptions, xFrameOptions,
//    // referrerPolicy, hsts, originAgentCluster, hidePoweredBy,
//    // xDnsPrefetchControl, xXssProtection, xDownloadOptions,
//    // xPermittedCrossDomainPolicies, coop, corp — 12 plugins with
//    // per-plugin defaults). CSP (#HDR5) and COEP (#HDR6) are opt-in
//    // only (must pass { csp: { directives: {...} } } or { coep: true }).
//    // Per-sub-config opt-out via { csp: false } / { hsts: false } /
//    // etc. Reads settings.json > securityHeaders.* for sub-configs;
//    // caller opts win. The individual plugins (#HDR1-14) remain
//    // mountable independently as power-user escape hatches; the
//    // idempotent first-writer-wins pattern means no double-emit when
//    // stacking the wrapper with an upstream individual mount.
//    // var securityHeaders = ${bundle}.plugins.SecurityHeaders();
//    // app.use(securityHeaders);
//
//    // you can also use express middleware components directly (no #CSRF1 hardening)
//    // eg.: app.use( expressSession({secret: process.env.SESSION_SECRET}) );
//
//    //then notify the server that startup sequence can be resumed
//    event.emit('complete', app);// this is important !
//});

// If you need to do something once the server has started
// e.g.: start a cron or a watcher
// ${bundle}.onStarted(function(){
//     console.info('${bundle} has started ! ');
// });

// Catch unhandled errors
${bundle}.onError(function(err, req, res, next){
    console.error('[ BOOTSTRAP ] <${bundle}> fatal error: ' + err.message + '\nstack:\n'+ err.stack);
    next(err);
});

${bundle}.start();