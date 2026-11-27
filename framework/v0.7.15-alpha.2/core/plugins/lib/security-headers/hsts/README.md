# HSTS Plugin (#HDR4)

Opt-in middleware that sets the `Strict-Transport-Security` response
header on every response, instructing browsers to access the host
exclusively over HTTPS for the next `maxAge` seconds.

## Why

Once a browser receives a valid HSTS policy from a host, it refuses to
make plain HTTP requests to that host for the duration of `maxAge` —
attempts get upgraded to HTTPS before the network even sees them. This
defeats SSL-stripping attacks where an active MITM intercepts the
client's first HTTP request and prevents it from ever escalating to
HTTPS. Once the policy is in place, the attacker has no opportunity to
sit between the client and the server in plaintext.

The fourth and final Phase 1 plugin on the gina security headers
track (#HDR1–#HDR4).

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp = require('gina');
var hsts  = require('gina').plugins.Hsts();

myapp.onInitialize(function(event, app) {
    app.use(hsts);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "hsts": {
    "maxAge":            15552000,
    "includeSubDomains": false,
    "preload":           false
  }
}
```

| Field               | Type    | Default     | Notes                                      |
|---------------------|---------|-------------|--------------------------------------------|
| `maxAge`            | number  | `15552000`  | Seconds. Default = 180 days.               |
| `includeSubDomains` | boolean | `false`     | Apply HSTS to all sub-domains as well.     |
| `preload`           | boolean | `false`     | Opt into the HSTS preload list.            |

Caller-supplied options always win over settings:

```js
var hsts = require('gina').plugins.Hsts({
    maxAge:            63072000,
    includeSubDomains: true,
    preload:           true
});
```

## Browser-parity invariant on `preload`

`preload: true` requires `includeSubDomains: true` AND `maxAge >=
31536000` (1 year) per the [HSTS preload-list submission requirements](https://hstspreload.org/#deployment-recommendations).
The factory throws at call time when the combination is invalid:

```
[gina.plugins.Hsts] preload=true requires includeSubDomains=true per the
HSTS preload-list submission requirements — see
https://hstspreload.org/#deployment-recommendations
```

```
[gina.plugins.Hsts] preload=true requires maxAge>=31536000 (1 year)
per the HSTS preload-list submission requirements; received
maxAge=15552000. See https://hstspreload.org/#deployment-recommendations
```

This mirrors the #CSRF1 `SameSite=None`+`Secure` lock and the #HDR2
`ALLOW-FROM` rejection — fast-fail at bootstrap, the bundle won't start
with a misconfigured header.

**Why the invariant matters**: the HSTS preload list is the browsers'
hard-coded HSTS database. Once your hostname is in it, all browsers
treat HSTS as active from the moment they install the browser update,
regardless of whether they've ever fetched a response from your host.
Removal from the preload list takes months and isn't guaranteed —
opting in is a one-way operation in practical terms. The submission
requirements exist to keep operators from accidentally locking
themselves out.

## Choosing values

- **`maxAge`** — start small (`300` = 5 minutes) during initial rollout
  to bound the blast radius of a mistake; ramp to `15552000` (180 days)
  for steady state; `63072000` (2 years) is the conventional value for
  preload-list submission.
- **`includeSubDomains`** — only enable if you're certain *every*
  sub-domain (including ones added in the future) will be HTTPS-only.
  Common foot-gun: `app.example.com` enabling `includeSubDomains` and
  breaking `legacy.example.com` that's stuck on HTTP.
- **`preload`** — only opt in once you've run stable in steady-state for
  weeks, audited every sub-domain, and accepted that removal is slow.

## Spec note — emission gating

This plugin emits the header on **every** response regardless of
transport. RFC 6797 §7.2 says "An HSTS Host MUST NOT include the STS
header field in HTTP responses conveyed over non-secure transport".
However, §8.1 also says the user agent "MUST ignore any present STS
header field(s)" received over insecure transport — the receiver
enforces the policy correctly regardless of what the server sends.

The plugin's design favours **proxy-deployment robustness** (no
dependency on `x-forwarded-proto` being preserved by intermediaries)
over sender-side spec purity. helmet's `Strict-Transport-Security`
middleware takes the same approach, so adopters migrating from helmet
see identical wire behaviour.

Bundles that need strict §7.2 compliance can simply not register the
plugin in non-HTTPS bundles — the `registration = opt-in` discipline
covers that case.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| All fields omitted                                       | Emits `max-age=15552000`                             |
| `maxAge` is not a non-negative integer                   | Factory throws at call time                          |
| `preload=true` with `includeSubDomains=false`            | Factory throws with hstspreload.org pointer          |
| `preload=true` with `maxAge<31536000`                    | Factory throws with hstspreload.org pointer          |
| `maxAge=0`                                               | Emits `max-age=0` (clears existing HSTS policy)      |
| Plugin not registered                                    | Header not emitted; browser uses no HSTS policy      |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header (e.g.
a generic helmet-style upstream gate) — the first writer wins.
