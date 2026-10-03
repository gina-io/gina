# Cross-Origin-Resource-Policy Plugin (#HDR14)

Opt-in middleware that sets the `Cross-Origin-Resource-Policy` (CORP)
response header on every response, restricting which other origins
may load this resource as a no-CORS / `<img>` / `<script>` / `<link>`
etc. embed.

## Why

CORP is the resource-side complement to #HDR6 Cross-Origin-Embedder-Policy:
COEP says "I'll only load cross-origin resources that opt in"; CORP is
the opt-in signal on the response. The pair together unlocks
cross-origin isolation (`SharedArrayBuffer`, high-res
`performance.now()`) when used alongside #HDR13 COOP.

Independently, CORP defends against side-channel attacks that load a
resource cross-origin to measure its size, dimensions, or load
timing for fingerprinting / exfiltration. With `same-origin`, only
the exact same origin (scheme + host + port) may embed the resource;
the browser refuses any cross-origin no-CORS request.

CORP is also the natural defense against XSSI (cross-site script
inclusion) attacks: a sensitive JSON or JS response loaded cross-origin
as a `<script>` could leak data via global side effects; `same-origin`
blocks that load.

Browser support: Chrome 73+, Edge 79+, Firefox 74+, Safari 12+.
Older browsers ignore the header silently — safe to register
unconditionally.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp = require('gina');
var corp  = require('gina').plugins.Corp();

myapp.onInitialize(function(event, app) {
    app.use(corp);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "corp": {
    "value": "same-origin"
  }
}
```

| Field   | Type   | Default       | Valid values                              |
|---------|--------|---------------|-------------------------------------------|
| `value` | string | `same-origin` | `same-origin`, `same-site`, `cross-origin` |

### Three values per the W3C HTML spec

| Token          | Behaviour                                                                                  |
|----------------|--------------------------------------------------------------------------------------------|
| `same-origin`  | **Default**. Only the exact same origin (scheme + host + port) may embed this resource. The most restrictive practical posture; the natural mate of #HDR6 Coep's `require-corp` enforcement. |
| `same-site`    | Any same-site origin (eTLD+1 match) may embed. Allows `app.example.com` to embed resources served by `cdn.example.com` (same eTLD+1 `example.com`) while still blocking `evil.com`. |
| `cross-origin` | Any origin may embed. Required for resources intended to be publicly embeddable (CDN fonts, analytics images, shared assets, public APIs). |

Tokens are case-insensitive at this layer — values are normalised to
lowercase before validation and emission. The spec defines them as
lowercase enumerated strings; browsers parse case-sensitively, so the
emitted header is always lowercase.

Caller-supplied options always win over settings:

```js
var corp = require('gina').plugins.Corp({ value: 'cross-origin' });
```

## Tradeoff with the `same-origin` default

The strict default `same-origin` is the safest posture — an attacker
on another origin cannot embed this resource to probe its size,
dimensions, or load timing for fingerprinting / side-channel attacks,
and XSSI shapes are blocked. But it BREAKS legitimate cross-origin
embeds when the resource serves at a separate origin from the
embedding page.

Three escape hatches when `same-origin` breaks a legitimate embed:

1. **Pick `same-site`** (preferred for first-party multi-subdomain
   setups) — `app.example.com` can embed assets served by
   `cdn.example.com`, `static.example.com`, etc. (any same eTLD+1)
   while still blocking arbitrary third-party origins.
2. **Pick `cross-origin`** (required for publicly-embeddable assets)
   — for CDN fonts, analytics images, public API JSON responses, or
   any resource intended to be loaded by third-party sites. Use only
   when the resource is genuinely safe to embed anywhere.
3. **Per-bundle scoping** — typically the page-serving bundle keeps
   `same-origin` (or `same-site`) and the CDN / static-asset bundle
   adopts `cross-origin`. Each bundle picks the right value for the
   class of resources it serves.

## Pair with COEP for the cross-origin isolation combo

CORP is the response-side signal that satisfies COEP's `require-corp`
requirement on the embedding page. For a page that:

- Sets `Coep({ value: 'require-corp' })` (#HDR6) on its own responses,
- Sets `Coop({ value: 'same-origin' })` (#HDR13) on its own responses,
- Embeds cross-origin resources (CDN fonts, etc.),

those embedded resources MUST carry a matching CORP header (e.g. their
serving bundle uses `Corp({ value: 'cross-origin' })`) or the embeds
will be blocked with a `NotSameOriginAfterDefaultedToSameOriginByCoep`
error.

See the W3C HTML spec section on
[cross-origin isolation](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-isolated)
for the full feature gate.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `same-origin`                             |
| `value` is not one of the 3 W3C tokens                   | Factory throws at call time (bundle won't start)     |
| `value` is not a string                                  | Factory throws at call time                          |
| Plugin not registered                                    | Header not emitted; browser uses default behaviour (varies by request mode — `no-cors` requests typically default to same-origin too in modern browsers) |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| Cross-origin embed with `same-origin`                    | Embed BLOCKED — pick `same-site` or `cross-origin` for the embed-target bundle |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header — the
first writer wins.
