# X-Permitted-Cross-Domain-Policies Plugin (#HDR12)

Opt-in middleware that sets the `X-Permitted-Cross-Domain-Policies`
response header on every response, restricting Adobe Flash and PDF
readers from honouring cross-domain policy files served from this
origin.

**Closes Phase 1.5** (helmet-parity gap-fill) of the gina security-
headers track.

## Why

Adobe Flash and Adobe Reader used a `crossdomain.xml` policy file
served at the origin to grant permission for SWF / PDF content to
load data from this origin into another. A misconfigured (or absent
`X-Permitted-Cross-Domain-Policies`) origin could allow malicious
Flash content on another site to read data from this one, bypassing
the same-origin policy.

`X-Permitted-Cross-Domain-Policies: none` (the default) instructs
the Flash / PDF reader to NOT honour any `crossdomain.xml` file
from this origin — defending against the cross-domain-data-read
shape regardless of what (if any) policy file is served.

Flash is end-of-life since December 2020. Adobe Reader historically
honoured the header but most modern PDF readers ignore it. helmet
still ships `xPermittedCrossDomainPolicies` for defense-in-depth +
security-scanner-parity narrative.

## Browser / reader status in 2026

- **Modern browsers** ignore the header entirely (no native Flash
  support since 2020).
- **Modern PDF readers** mostly ignore the header.
- **Adobe Reader (legacy)** historically honoured the header; users
  still on Adobe Reader for PDF rendering benefit from `none`.
- **Adobe Flash Player** end-of-life since 31 December 2020.

The header is therefore largely a no-op in 2026. Ships for defense-
in-depth + helmet-parity narrative.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp                         = require('gina');
var xPermittedCrossDomainPolicies = require('gina').plugins.XPermittedCrossDomainPolicies();

myapp.onInitialize(function(event, app) {
    app.use(xPermittedCrossDomainPolicies);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header
is emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "xPermittedCrossDomainPolicies": {
    "value": "none"
  }
}
```

| Field   | Type   | Default | Valid values                                                          |
|---------|--------|---------|-----------------------------------------------------------------------|
| `value` | string | `none`  | `none`, `master-only`, `by-content-type`, `all`                       |

### Four values per the Adobe Cross-Domain Policy File Specification

| Token              | Behaviour                                                                                |
|--------------------|------------------------------------------------------------------------------------------|
| `none`             | **Default**. No cross-domain policy files honoured; Flash / PDF cross-origin loading blocked. The most restrictive value; recommended unless you specifically need cross-domain Flash/PDF policy loading. |
| `master-only`      | Only the master policy file at `/crossdomain.xml` is honoured. Other policy files elsewhere on the origin are ignored. |
| `by-content-type`  | Only files served with `Content-Type: text/x-cross-domain-policy` are treated as policy files. Lighter than `master-only` — non-XML files can't accidentally be parsed as policies. |
| `all`              | ANY cross-domain policy file at any path is honoured. **NOT recommended** — the most permissive value, defeats the header's purpose. |

Caller-supplied options always win over settings:

```js
var xPermittedCrossDomainPolicies = require('gina').plugins.XPermittedCrossDomainPolicies({ value: 'master-only' });
```

Tokens are case-insensitive at the plugin layer — values are
normalised to lowercase before validation and emission. Unknown
tokens throw at factory call time.

## Mapping from helmet's API

helmet's `xPermittedCrossDomainPolicies` middleware uses a different
option-key name: `{ permittedPolicies: <enum> }`. gina uses
`{ value: <enum> }` matching the existing single-token-enum
convention of #HDR2 (XFrame), #HDR3 (ReferrerPolicy), #HDR6 (Coep),
#HDR9 (XDnsPrefetchControl), #HDR13 (Coop), and #HDR14 (Corp).

Migrating from helmet:

| helmet                                                              | gina                                                                          |
|---------------------------------------------------------------------|-------------------------------------------------------------------------------|
| `helmet.xPermittedCrossDomainPolicies()`                            | `gina.plugins.XPermittedCrossDomainPolicies()`                                |
| `helmet.xPermittedCrossDomainPolicies({ permittedPolicies: 'master-only' })` | `gina.plugins.XPermittedCrossDomainPolicies({ value: 'master-only' })`        |
| `helmet.xPermittedCrossDomainPolicies({ permittedPolicies: 'by-content-type' })` | `gina.plugins.XPermittedCrossDomainPolicies({ value: 'by-content-type' })`    |
| `helmet.xPermittedCrossDomainPolicies({ permittedPolicies: 'all' })` | `gina.plugins.XPermittedCrossDomainPolicies({ value: 'all' })`                |

Same emitted header, different option-key name. **Silent-fallback
gotcha for migrators**: passing `{ permittedPolicies: 'master-only' }`
to gina does NOT switch the emission — `merged.value` is undefined,
so the factory uses the default `"none"`. Pass `{ value: '...' }`
explicitly.

## Reference

[Adobe — Cross-Domain Policy File Specification](https://docs.adobe.com/content/dam/acom/en/devnet/articles/crossdomain_policy_file_spec/crossdomain_policy_file_specification.pdf)

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `none`                                    |
| `value` is not one of the 4 Adobe tokens                 | Factory throws at call time (bundle won't start)     |
| `value` is not a string                                  | Factory throws at call time                          |
| Plugin not registered                                    | Header not emitted; Flash / PDF readers fall back to their own default policy resolution |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| Modern browser (no Flash support)                        | Header ignored silently — harmless                   |
| `{ permittedPolicies: '...' }` passed (helmet shape)     | Silent fallback to default `none` — use `{ value: '...' }` |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header — the
first writer wins.
