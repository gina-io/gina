# Security Headers Combined Wrapper (#HDR15)

Opt-in middleware that composes the fourteen per-header security
plugins into a single mount point with one `settings.json` block.
Closes Phase 2 of the gina Web Security Headers track; extended with
the Phase 1.5 helmet-parity plugins (HDR8-12) post-Phase-1.5-closure.

## Why

The individual `#HDR` plugins are deliberately single-concern — each
emits one response header, reads one settings.json key, has its own
README. That makes each plugin easy to reason about but verbose to
adopt: bundles wanting all fourteen end up with fourteen `require(...)`
calls, fourteen `app.use(...)` mounts, and fourteen settings.json
blocks.

`gina.plugins.SecurityHeaders({...})` is the one-mount + one-config
convenience layer over the fourteen. Mirrors helmet's `helmet()` shape
so bundles migrating from helmet find the API familiar.

## Adoption

### Default — batteries-included safe set

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp           = require('gina');
var securityHeaders = require('gina').plugins.SecurityHeaders();

myapp.onInitialize(function(event, app) {
    app.use(securityHeaders);
    event.emit('complete', app);
});
```

With no opts, mounts the **twelve non-footgun plugins** with their
per-plugin defaults:

| Sub-plugin                                | Header                              | Default value                                |
|-------------------------------------------|-------------------------------------|----------------------------------------------|
| `XContentTypeOptions` (HDR1)              | `X-Content-Type-Options`            | `nosniff`                                    |
| `XFrameOptions` (HDR2)                    | `X-Frame-Options`                   | `SAMEORIGIN`                                 |
| `ReferrerPolicy` (HDR3)                   | `Referrer-Policy`                   | `strict-origin-when-cross-origin`            |
| `Hsts` (HDR4)                             | `Strict-Transport-Security`         | `max-age=15552000` (180 days)                |
| `OriginAgentCluster` (HDR7)               | `Origin-Agent-Cluster`              | `?1`                                         |
| `HidePoweredBy` (HDR8)                    | `X-Powered-By`                      | **REMOVED** (Express engine only)            |
| `XDnsPrefetchControl` (HDR9)              | `X-DNS-Prefetch-Control`            | `off`                                        |
| `XXssProtection` (HDR10)                  | `X-XSS-Protection`                  | `0` (deliberately disables Chrome auditor)   |
| `XDownloadOptions` (HDR11)                | `X-Download-Options`                | `noopen` (IE-legacy)                         |
| `XPermittedCrossDomainPolicies` (HDR12)   | `X-Permitted-Cross-Domain-Policies` | `none` (Flash/PDF-legacy)                    |
| `Coop` (HDR13)                            | `Cross-Origin-Opener-Policy`        | `same-origin`                                |
| `Corp` (HDR14)                            | `Cross-Origin-Resource-Policy`      | `same-origin`                                |

The two **opt-in-only plugins** (#HDR5 Csp + #HDR6 Coep) are NOT
mounted by default because they have known footguns:

- **CSP** (#HDR5) throws on missing directives — there's no sensible
  cross-bundle default since every bundle has its own resource graph.
- **COEP** (#HDR6) default `require-corp` BREAKS pages that load
  cross-origin resources without matching CORP / CORS headers.

Bundles that want either must opt in explicitly (see below).

### Opt in to CSP and COEP

```js
var securityHeaders = require('gina').plugins.SecurityHeaders({
    csp: {
        directives: {
            'default-src': ["'self'"],
            'script-src':  ["'self'", 'https://cdn.example.com'],
            'style-src':   ["'self'", "'unsafe-inline'"],
            'img-src':     ["'self'", 'data:']
        }
    },
    coep: true                              // require-corp default
});
app.use(securityHeaders);
```

`csp: { directives: {...} }` is required when opting in — `csp: {}`
or `csp: true` will throw at factory call time (CSP needs directives,
this is a config error). Use `csp: false` (or omit the key) to keep
CSP off.

### Opt out of a safe-set plugin

```js
var securityHeaders = require('gina').plugins.SecurityHeaders({
    hsts: false                             // HTTP-only bundle — HSTS is a no-op anyway
});
app.use(securityHeaders);
```

Per-sub-config `false` (or `null`) skips that plugin even when it's
in the safe set. Useful for:

- HTTP-only bundles (skip HSTS)
- Bundles relying on `document.domain` (skip OriginAgentCluster)
- Multi-domain bundles with permissive cross-origin needs (skip Coop /
  Corp, set explicit policy elsewhere)

### Override defaults on a safe-set plugin

```js
var securityHeaders = require('gina').plugins.SecurityHeaders({
    xFrameOptions:  { value: 'DENY' },      // override SAMEORIGIN default
    referrerPolicy: { value: 'no-referrer' },
    hsts:           { maxAge: 31536000, includeSubDomains: true, preload: true }
});
app.use(securityHeaders);
```

Sub-config objects replace the per-plugin defaults wholesale (shallow
merge — the standalone plugins' own settings.json reads still apply
underneath, see "Settings precedence" below).

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "securityHeaders": {
    "xContentTypeOptions":           true,
    "xFrameOptions":                 { "value": "SAMEORIGIN" },
    "referrerPolicy":                { "value": "strict-origin-when-cross-origin" },
    "hsts":                          { "maxAge": 15552000, "includeSubDomains": false, "preload": false },
    "originAgentCluster":            true,
    "hidePoweredBy":                 true,
    "xDnsPrefetchControl":           { "value": "off" },
    "xXssProtection":                true,
    "xDownloadOptions":              true,
    "xPermittedCrossDomainPolicies": { "value": "none" },
    "coop":                          { "value": "same-origin" },
    "corp":                          { "value": "same-origin" },

    "csp":                           { "directives": { "default-src": ["'self'"] } },
    "coep":                          { "value": "require-corp" }
  }
}
```

All sub-config keys are optional. Sub-configs absent from `settings.json`
fall back to the per-plugin defaults (safe-set plugins are mounted;
CSP / COEP stay opt-in-only).

### Per-sub-config shapes

| Sub-config key                    | Value shape                                                                          | Mount behaviour                                                                  |
|-----------------------------------|--------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `xContentTypeOptions`             | `true` / `false` / `null` / `{}`                                                     | Default mount; `false` or `null` opts out                                        |
| `xFrameOptions`                   | `{ value: 'DENY' \| 'SAMEORIGIN' }` / `true` / `false` / `null` / `{}`                | Default mount with SAMEORIGIN                                                     |
| `referrerPolicy`                  | `{ value: '<one-of-8-W3C-tokens>' }` / `true` / `false` / `null` / `{}`              | Default mount with strict-origin-when-cross-origin                                |
| `hsts`                            | `{ maxAge, includeSubDomains, preload }` / `true` / `false` / `null` / `{}`           | Default mount with 180-day maxAge                                                 |
| `csp`                             | `{ directives: {...}, reportOnly: false }` / `false` / `null`                        | Opt-in only; throws on `{}` or `true` (no directives)                            |
| `coep`                            | `{ value: '<one-of-3-W3C-tokens>' }` / `true` / `false` / `null` / `{}`              | Opt-in only; default require-corp                                                 |
| `originAgentCluster`              | `true` / `false` / `null` / `{}`                                                     | Default mount                                                                    |
| `hidePoweredBy`                   | `true` / `false` / `null` / `{}`                                                     | Default mount (Express engine only; Isaac engine writeHead path unaffected)       |
| `xDnsPrefetchControl`             | `{ value: 'on' \| 'off' }` / `true` / `false` / `null` / `{}`                         | Default mount with `off`                                                          |
| `xXssProtection`                  | `true` / `false` / `null` / `{}`                                                     | Default mount (emits literal `0` to DISABLE Chrome legacy auditor)               |
| `xDownloadOptions`                | `true` / `false` / `null` / `{}`                                                     | Default mount (emits `noopen`; IE-legacy)                                         |
| `xPermittedCrossDomainPolicies`   | `{ value: '<one-of-4-Adobe-tokens>' }` / `true` / `false` / `null` / `{}`            | Default mount with `none`                                                         |
| `coop`                            | `{ value: '<one-of-4-W3C-tokens>' }` / `true` / `false` / `null` / `{}`              | Default mount with same-origin                                                    |
| `corp`                            | `{ value: '<one-of-3-W3C-tokens>' }` / `true` / `false` / `null` / `{}`              | Default mount with same-origin                                                    |

## Settings precedence

Three layers, lowest-to-highest:

1. **Per-plugin defaults** (in each plugin's source — e.g. `xFrameOptions` defaults to `SAMEORIGIN`).
2. **`settings.json > <key>.*`** (each standalone plugin reads its own settings key — e.g. `xFrameOptions.value` in `settings.json`).
3. **`settings.json > securityHeaders.<key>.*`** (the wrapper reads this and passes to the per-plugin factory).
4. **Wrapper opts (`SecurityHeaders({...})`)** (caller opts override everything).

The wrapper passes its resolved sub-config to each per-plugin factory
as `opts`. The per-plugin factory merges its own settings reads, then
those opts win.

## Power-user escape hatch — individual plugins still mountable

The standalone plugins continue to work independently:

```js
var csp = require('gina').plugins.Csp({
    directives: {
        'default-src': ["'self'"],
        'script-src':  ["'self'"]
    },
    useNonce: true   // per-response nonce → drop 'unsafe-inline'
});
app.use(csp);
```

Each plugin uses the **idempotent first-writer-wins** pattern (via
`res.getHeader`), so stacking the wrapper with an upstream individual
mount produces no double-emit — the first one to set the header wins,
the second skips.

This means you can mix-and-match: use `SecurityHeaders()` for the
seven safe-set plugins, mount `gina.plugins.Csp()` separately with a
per-request nonce, mount nothing for COEP. All three behaviours
coexist cleanly.

## Per-sub-plugin references

For the full details on each per-header plugin's behaviour, tradeoffs,
and failure modes, see the standalone READMEs:

- [`gina-core-plugin-x-content-type-options`](../x-content-type-options/README.md) (HDR1)
- [`gina-core-plugin-x-frame-options`](../x-frame-options/README.md) (HDR2)
- [`gina-core-plugin-referrer-policy`](../referrer-policy/README.md) (HDR3)
- [`gina-core-plugin-hsts`](../hsts/README.md) (HDR4)
- [`gina-core-plugin-csp`](../csp/README.md) (HDR5)
- [`gina-core-plugin-coep`](../coep/README.md) (HDR6)
- [`gina-core-plugin-origin-agent-cluster`](../origin-agent-cluster/README.md) (HDR7)
- [`gina-core-plugin-hide-powered-by`](../hide-powered-by/README.md) (HDR8)
- [`gina-core-plugin-x-dns-prefetch-control`](../x-dns-prefetch-control/README.md) (HDR9)
- [`gina-core-plugin-x-xss-protection`](../x-xss-protection/README.md) (HDR10)
- [`gina-core-plugin-x-download-options`](../x-download-options/README.md) (HDR11)
- [`gina-core-plugin-x-permitted-cross-domain-policies`](../x-permitted-cross-domain-policies/README.md) (HDR12)
- [`gina-core-plugin-coop`](../coop/README.md) (HDR13)
- [`gina-core-plugin-corp`](../corp/README.md) (HDR14)

## Failure modes

| Condition                                                                  | Outcome                                                                       |
|----------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| Plugin not registered                                                      | No security headers emitted; browsers apply their built-in defaults           |
| `SecurityHeaders()` with no opts                                           | Safe-set mounted (HDR1/2/3/4/7/13/14); CSP and COEP skipped                   |
| Sub-config = `false` or `null`                                             | That plugin skipped — explicit opt-out                                        |
| Sub-config = `true`                                                        | That plugin mounted with per-plugin defaults (boolean shorthand)              |
| Sub-config = `{}`                                                          | Same as `true` for safe-set plugins. CSP throws (directives required); COEP mounts with `require-corp` default. |
| Sub-config = object with invalid keys/values                               | Per-plugin factory throws at call time (matches standalone behaviour)         |
| Sub-config = string / number / array / function                            | Wrapper throws at call time with the offending sub-config key in the message  |
| Header already set by an earlier middleware                                | Existing value preserved (idempotent first-writer-wins, per-plugin)           |
| Response already sent (`res.headersSent === true`)                         | Node's `setHeader` no-ops; request resumes                                    |
| Stacked with an upstream individual `gina.plugins.<X>` mount               | First writer wins; the second skip is a no-op                                 |

The fail-fast posture (throws at factory call time for invalid
sub-configs) is inherited from each per-plugin factory. A
misconfigured bundle won't start — the throw points at the specific
sub-config that's wrong, with the plugin's standalone error message.
