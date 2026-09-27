# Content-Security-Policy Plugin (#HDR5)

Opt-in middleware that sets the `Content-Security-Policy` (or
`Content-Security-Policy-Report-Only`) response header on every response,
limiting which resources the browser is allowed to load and from where.

## Why

CSP is the modern defense against cross-site scripting (XSS) and data
injection attacks. By declaring a policy of allowed sources for scripts,
styles, images, fonts, frames, connections, etc., the browser refuses to
execute any resource that doesn't match the policy — even if an attacker
manages to inject a `<script>` tag into the page via stored XSS, the script
won't load unless its source is on the allowlist.

CSP also defeats whole classes of clickjacking (via `frame-ancestors`),
mixed-content downgrade (via `upgrade-insecure-requests`), and base-tag
manipulation (via `base-uri`) attacks.

Opens Phase 2 of the gina security-headers track. Phase 1 (HDR1-4 + HDR7)
shipped in `0.3.15-alpha`; CSP is the most-requested helmet header that
wasn't yet covered.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp = require('gina');
var csp   = require('gina').plugins.Csp({
    directives: {
        'default-src': ["'self'"],
        'script-src':  ["'self'", 'https://cdn.example.com'],
        'style-src':   ["'self'", "'unsafe-inline'"],
        'img-src':     ["'self'", 'data:', 'https:'],
        'upgrade-insecure-requests': true
    }
});

myapp.onInitialize(function(event, app) {
    app.use(csp);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

Settings.json shape — caller-supplied options always win over settings:

```jsonc
{
  "csp": {
    "directives": {
      "default-src": ["'self'"],
      "script-src":  ["'self'", "https://cdn.example.com"],
      "style-src":   ["'self'", "'unsafe-inline'"],
      "img-src":     ["'self'", "data:", "https:"]
    },
    "reportOnly": false
  }
}
```

| Field        | Type    | Default | Notes                                                                |
|--------------|---------|---------|----------------------------------------------------------------------|
| `directives` | object  | —       | **Required.** Throws if missing or empty. See "Directives" below.   |
| `reportOnly` | boolean | `false` | When `true`, emits `Content-Security-Policy-Report-Only` instead.   |
| `reportOnlyOmit` | string[] | `[]` | Directives to *also* omit while `reportOnly` is `true`; emitted again automatically in enforce mode. See "reportOnlyOmit" below. |
| `useNonce`   | boolean | `false` | When `true`, generates a per-response nonce, stamps it on `req._ginaCspNonce`, and appends `'nonce-XXXX'` to `script-src` (fallback `default-src`). See "Per-response CSP nonce" below. |

There is no sensible cross-bundle default for `directives`. Every bundle
has its own resource graph; a default policy would either be too restrictive
(breaks every bundle that loads external resources) or too permissive
(gives no real protection). **The factory throws at call time if
`directives` is missing or empty.**

## Directives

The plugin enforces a **strict whitelist of CSP Level 3 standard
directives**. Unknown directive names throw at factory call time —
fail-fast is the only way to catch typos like `scrpt-src` (browsers
silently ignore unknown directives, so without the throw the page would
be unprotected with no error).

Each directive value can be:

- **Array of source-list tokens** (recommended) — joined with space:
  `['\'self\'', 'https:']` → `default-src 'self' https:`
- **String** (pre-formatted source list) — emitted as-is:
  `"'self' https:"` → `default-src 'self' https:`
- **`true`** — emit the directive name alone (boolean-only directives, or
  `sandbox` with no value).
- **`false`** — omit the directive entirely.

### Categories

**Source-list directives** (string / array / `false`):

`child-src`, `connect-src`, `default-src`, `font-src`, `frame-src`,
`img-src`, `manifest-src`, `media-src`, `object-src`, `prefetch-src`,
`script-src`, `script-src-attr`, `script-src-elem`, `style-src`,
`style-src-attr`, `style-src-elem`, `worker-src`, `base-uri`,
`form-action`, `frame-ancestors`, `report-to`, `report-uri`,
`require-trusted-types-for`, `trusted-types`

**Boolean-only directives** (`true` / `false` only):

`block-all-mixed-content`, `upgrade-insecure-requests`

**Hybrid directives** (string / array / `true` / `false`):

`sandbox` — `true` applies all sandbox restrictions; a string/array adds
specific exceptions (e.g. `sandbox allow-scripts`).

### Example — a typical strict policy

```js
require('gina').plugins.Csp({
    directives: {
        'default-src':                 ["'self'"],
        'script-src':                  ["'self'"],
        'style-src':                   ["'self'", "'unsafe-inline'"],
        'img-src':                     ["'self'", 'data:'],
        'font-src':                    ["'self'"],
        'connect-src':                 ["'self'"],
        'frame-ancestors':             ["'none'"],
        'base-uri':                    ["'self'"],
        'form-action':                 ["'self'"],
        'object-src':                  ["'none'"],
        'upgrade-insecure-requests':   true
    }
});
```

## `reportOnly` — non-enforcing migration testing

Setting `reportOnly: true` switches the response header name from
`Content-Security-Policy` to `Content-Security-Policy-Report-Only`.
Browsers report violations (to the configured `report-to` / `report-uri`
endpoint, or to the console) but do not block any resources. Useful when
rolling out a new policy: ship it as report-only first, collect violations
from real traffic for a few days, refine the policy, then flip to
enforcing.

```js
require('gina').plugins.Csp({
    reportOnly: true,
    directives: {
        'default-src': ["'self'"],
        'script-src':  ["'self'"],
        'report-uri':  ['/csp/report']
    }
});
```

### Report-only-inert directives are omitted automatically

The `sandbox` directive has **no effect** in a `Content-Security-Policy-Report-Only`
header — it applies a document-level restriction rather than a load decision, so
every engine ignores it there (the CSP Level 2 spec says it outright: *"The
sandbox directive will be ignored when monitoring a policy"*) and logs
*"Ignoring sandbox directive when delivered in a report-only policy"*. When `reportOnly: true`, the plugin therefore **omits**
`sandbox` from the emitted header and logs one line at startup naming what was
dropped. The omission is functionally identical (the directive does nothing in
report-only) and keeps the browser console clean. `sandbox` remains in your
configured `directives`, so an enforcing factory (`reportOnly: false`) built from
the same config still emits it — you can keep **one directive set across both
modes** without remove-then-re-add churn.

`frame-ancestors` is **not** omitted — its report-only behaviour is
**engine-divergent**: the CSP3 spec, Firefox (Gecko) and Chrome (Blink) evaluate
it and send violation reports without enforcing, while Safari (WebKit) ignores
it, logs *"The Content Security Policy directive 'frame-ancestors' is ignored
when delivered in a report-only policy"* and sends no report (WebKit retains the
CSP Level 2 rule — *"The frame-ancestors directive MUST be ignored when
monitoring a policy"* — which CSP Level 3 dropped; CSP3 only restricts `<meta>`
delivery, which a report-only policy never uses). The plugin keeps it so the
observation phase still reports on Chrome and Firefox. If you serve a
WebKit-heavy audience and want a clean Safari console, opt it out with
`reportOnlyOmit: ['frame-ancestors']` (next section) — clickjacking protection
stays enforced
by `X-Frame-Options` and/or an enforcing-mode `frame-ancestors`. (Chrome caveat:
frame-ancestors violation reports are delivered via `report-uri`; known Chromium
bugs leave them undelivered via `report-to`.) A report-only policy whose every
directive is report-only-inert (e.g. only `sandbox`) **throws at factory call
time**, since it would report nothing.

The omitted set is intentionally conservative — `sandbox` is the only directive
confirmed ignored in report-only across all engines.

### `reportOnlyOmit` — opt out engine-divergent directives in report-only

For the engine-divergent case above, `reportOnlyOmit` packages the
hand-managed omission: every directive named in it is omitted from the
report-only header and emitted again **automatically** when `reportOnly`
flips to `false` — one directive set across both modes, no
remove-then-re-add churn.

```js
require('gina').plugins.Csp({
    reportOnly: true,
    directives: {
        'script-src':      ["'self'"],
        'frame-ancestors': ["'self'"],
        'report-uri':      ['/csp/report']
    },
    reportOnlyOmit: ['frame-ancestors']
});
// report-only header:  script-src 'self'; report-uri /csp/report
// after the enforce flip (reportOnly: false): frame-ancestors 'self' returns
```

**The honest trade — the option packages the engine divergence, it does not
eliminate it.** Listing `frame-ancestors` in `reportOnlyOmit` forgoes its
Chrome + Firefox (Gecko + Blink) report-only monitoring signal in exchange
for a clean WebKit console. The header is engine-blind, so gina cannot do
better — the option just turns the hand-managed comment into an explicit,
per-bundle, lifecycle-managed choice. Clickjacking stays enforced by
`X-Frame-Options` and/or an enforcing-mode `frame-ancestors` regardless.

Mechanics:

- Entries are validated against the same CSP Level 3 whitelist as
  `directives` keys — unknown names throw at factory call time.
- A factory-time warning names what was dropped, with wording distinct from
  the browser-inert `sandbox` omission — these directives are *not* ignored
  by browsers; you are choosing to forgo their report signal.
- An entry not present in `directives` warns in report-only mode (likely a
  config mistake) and no-ops.
- With `reportOnly: false` the option is inert **and silent** — keeping it
  in an enforce-mode config is the expected lifecycle state, not a mistake.
- If the omissions empty the report-only directive set, the factory throws
  (same as the all-inert case).
- `useNonce: true` with the nonce-target directive (`script-src` /
  `default-src`) in `reportOnlyOmit` throws at factory call time — the
  nonce would be stamped on the request and the tags but never referenced
  by the emitted policy.

## Per-response CSP nonce (`useNonce`)

Set `useNonce: true` to drop `'unsafe-inline'` from `script-src` without
breaking the framework's injected inline scripts:

```js
require('gina').plugins.Csp({
    directives: { 'script-src': ["'self'"] },
    useNonce: true
});
// → Content-Security-Policy: script-src 'self' 'nonce-<base64>'
```

When enabled, the middleware generates a fresh cryptographically-random
nonce per response (`crypto.randomBytes(16).toString('base64')` — 128 bits,
the W3C CSP3 entropy floor), stamps it on `req._ginaCspNonce`, and appends
`'nonce-<value>'` to the `script-src` directive (falling back to
`default-src` when `script-src` is absent; the factory throws at call time
if neither is present, since the nonce would have nowhere to attach).

The swig and nunjucks render delegates read `req._ginaCspNonce` and set a
matching `nonce="<value>"` attribute on every framework-injected inline
`<script>` — the `onGinaLoaded` bootstrap (always emitted) plus the
dev-only Inspector blocks. No application template changes are required;
the framework injection sites carry the nonce automatically.

`req._ginaCspNonce` is the documented per-request carrier (it mirrors the
`req._ginaProxyPrefix` precedent). It is written **only** when gina is the
one setting the CSP header — the idempotent first-writer-wins guard means
that if an upstream proxy / ingress already set the header, no nonce is
generated and none is emitted on the tags, so the header and the tags stay
consistent.

`useNonce` defaults to `false`: the header value is then computed once at
factory time and reused per response (zero per-request allocation), no
`req` slot is written, and inline scripts require `'unsafe-inline'` (or
must be moved to external files served from a `script-src`-allowed origin).

## Spec note — strict whitelist tradeoff

The plugin's whitelist tracks the W3C CSP Level 3 spec
(https://www.w3.org/TR/CSP3/#csp-directives). Experimental / future
directives (`webrtc`, `fenced-frame-src`, etc.) are not yet supported —
users wanting them get a clear "unknown directive" error and can open an
issue to request inclusion in a future release.

This is a stricter posture than helmet's CSP middleware, which is more
permissive on directive names. The tradeoff: gina catches typos at
factory call time; helmet catches them only via reports / browser
console at runtime. Gina favours fail-fast.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `directives` omitted / null / non-object                 | Factory throws at call time                          |
| `directives` is an empty object                          | Factory throws with directives-list pointer          |
| `directives` contains an unknown directive name          | Factory throws with full whitelist in message        |
| Boolean-only directive given a non-boolean value         | Factory throws with directive name in message        |
| Source-list directive given `true` (and not `sandbox`)   | Factory throws with directive-category explanation   |
| Source-list directive array contains a non-string entry  | Factory throws with index in message                 |
| All directives resolve to `false` (omitted)              | Factory throws — empty CSP is invalid                |
| `reportOnly` is non-boolean                              | Factory throws                                       |
| `reportOnly:true` with only report-only-inert directives | Factory throws — a report-only policy would report nothing |
| `reportOnlyOmit` is non-array / has non-string entries   | Factory throws                                       |
| `reportOnlyOmit` contains an unknown directive name      | Factory throws with full whitelist in message        |
| `reportOnlyOmit` empties the report-only directive set   | Factory throws — the policy would report nothing     |
| `reportOnlyOmit` omits the nonce target while `useNonce:true` | Factory throws — the header would never reference the nonce |
| Plugin not registered                                    | Header not emitted; browser applies no CSP           |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than once
or alongside another middleware that emits the same header — the first
writer wins.
