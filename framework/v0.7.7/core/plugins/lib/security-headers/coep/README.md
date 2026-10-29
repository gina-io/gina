# Cross-Origin-Embedder-Policy Plugin (#HDR6)

Opt-in middleware that sets the `Cross-Origin-Embedder-Policy` (COEP)
response header on every response, controlling which cross-origin
resources the page may embed.

## Why

COEP is half of the "cross-origin isolation" pair (the other half is
`Cross-Origin-Opener-Policy` / #HDR13). Setting both to their strictest
values (`COEP: require-corp` + `COOP: same-origin`) unlocks features
that browsers gate behind cross-origin isolation:

- `SharedArrayBuffer` — required by WebAssembly threads, `OffscreenCanvas`
  with multi-threaded rendering, and any code that needs zero-copy
  shared memory between worker threads.
- High-resolution `performance.now()` — sub-millisecond timer precision
  needed for accurate performance profiling. Without isolation, browsers
  coarsen the resolution to mitigate Spectre side-channel attacks.

COEP also independently provides defense-in-depth against cross-site
script injection: with `require-corp` set, the browser refuses to
load any cross-origin resource that doesn't explicitly opt in via
`Cross-Origin-Resource-Policy` (CORP) or CORS. An attacker who can
inject a `<script src="https://evil.com/x.js">` tag can't load the
script unless evil.com returns the matching CORP or CORS header.

Browser support: Chrome 83+, Edge 83+, Firefox 79+, Safari 15.2+.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp = require('gina');
var coep  = require('gina').plugins.Coep();

myapp.onInitialize(function(event, app) {
    app.use(coep);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "coep": {
    "value": "require-corp"
  }
}
```

| Field   | Type   | Default        | Valid values                                       |
|---------|--------|----------------|----------------------------------------------------|
| `value` | string | `require-corp` | `require-corp`, `credentialless`, `unsafe-none`    |

### Three values per the W3C HTML spec

| Token            | Behaviour                                                                                  |
|------------------|--------------------------------------------------------------------------------------------|
| `require-corp`   | **Default**. Cross-origin resources must opt-in via CORP or CORS, otherwise blocked. Required (paired with `COOP: same-origin`) for `SharedArrayBuffer` and high-res `performance.now()`. |
| `credentialless` | Cross-origin no-CORS requests sent WITHOUT credentials (cookies, HTTP auth). Less restrictive than `require-corp` but still gates the cross-origin-isolation combo. |
| `unsafe-none`    | Browser default. No restrictions; equivalent to not setting the header. Use to explicitly opt OUT (e.g. to override a stricter upstream default). |

Caller-supplied options always win over settings:

```js
var coep = require('gina').plugins.Coep({ value: 'credentialless' });
```

Tokens are case-insensitive at this layer — values are normalised to
lowercase before validation and emission. The spec defines them as
lowercase enumerated strings; browsers parse case-sensitively, so the
emitted header is always lowercase.

## Tradeoff with the `require-corp` default

The strict default `require-corp` enables the SharedArrayBuffer +
cross-origin-isolation combo, but BREAKS pages that load cross-origin
resources (images, fonts, scripts on a CDN, embedded videos) that
don't carry the matching `Cross-Origin-Resource-Policy` (CORP) or
CORS header. Symptoms: blocked resources appear as failed network
requests in DevTools with a
`NotSameOriginAfterDefaultedToSameOriginByCoep` error.

Options when `require-corp` breaks an embed:

1. **Set CORP on the embedded resource** (preferred) — if you control
   the origin serving the embed, add `Cross-Origin-Resource-Policy:
   cross-origin` (or use #HDR14 `gina.plugins.Corp()` on that bundle).
2. **Downgrade to `credentialless`** — cookies and HTTP auth are
   stripped on cross-origin no-CORS requests, but no explicit CORP
   header is required. Compatible with most public CDN content
   (fonts, images) that don't need credentials.
3. **Downgrade to `unsafe-none`** — gives up cross-origin isolation
   entirely. The page can embed anything but loses SharedArrayBuffer
   and high-res timers.

## Pair with COOP for the SharedArrayBuffer combo

To enable `SharedArrayBuffer` and the rest of the
cross-origin-isolated-context features, register BOTH plugins together:

```js
var coep = require('gina').plugins.Coep();                          // require-corp (default)
var coop = require('gina').plugins.Coop({ value: 'same-origin' });  // default
app.use(coep);
app.use(coop);
```

The page becomes cross-origin-isolated and `window.crossOriginIsolated`
returns `true`. See the W3C HTML spec section on
[cross-origin isolation](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-isolated)
for the full feature gate.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `require-corp`                            |
| `value` is not one of the 3 W3C tokens                   | Factory throws at call time (bundle won't start)     |
| Plugin not registered                                    | Header not emitted; browser uses default behaviour   |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header — the
first writer wins.
