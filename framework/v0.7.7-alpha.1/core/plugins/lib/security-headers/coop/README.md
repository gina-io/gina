# Cross-Origin-Opener-Policy Plugin (#HDR13)

Opt-in middleware that sets the `Cross-Origin-Opener-Policy` (COOP)
response header on every response, controlling how the page's browsing
context relates to popups and cross-origin `window.opener` references
on top-level navigation.

## Why

COOP is half of the "cross-origin isolation" pair (the other half is
`Cross-Origin-Embedder-Policy` / #HDR6). Setting both to their strictest
values (`COEP: require-corp` + `COOP: same-origin`) unlocks features
gated behind cross-origin isolation: `SharedArrayBuffer` (required by
WebAssembly threads, multi-threaded `OffscreenCanvas`) and high-resolution
`performance.now()` (sub-millisecond precision, coarsened otherwise to
mitigate Spectre side-channel attacks).

COOP also independently defends against side-channel attacks that abuse
`window.opener` references — a cross-origin popup that retains a live
opener reference can probe the opener's state (frame count, navigation
history length) to fingerprint or exfiltrate data. With `same-origin`,
the browser severs `window.opener` on every top-level cross-origin
navigation; the opener and popup live in different agent groups and
can't reach each other synchronously.

Browser support: Chrome 83+, Edge 83+, Firefox 79+, Safari 15.2+.
`noopener-allow-popups` (the newer fourth token) requires Chrome 119+
or Firefox 131+; older browsers ignore the token silently and fall
back to no isolation.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp = require('gina');
var coop  = require('gina').plugins.Coop();

myapp.onInitialize(function(event, app) {
    app.use(coop);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "coop": {
    "value": "same-origin"
  }
}
```

| Field   | Type   | Default       | Valid values                                                                    |
|---------|--------|---------------|---------------------------------------------------------------------------------|
| `value` | string | `same-origin` | `same-origin`, `same-origin-allow-popups`, `noopener-allow-popups`, `unsafe-none` |

### Four values per the W3C HTML spec

| Token                       | Behaviour                                                                                  |
|-----------------------------|--------------------------------------------------------------------------------------------|
| `same-origin`               | **Default**. Full isolation. Top-level navigation severs `window.opener` for any cross-origin opener. Required (paired with `COEP: require-corp`) for `SharedArrayBuffer` and high-res `performance.now()`. |
| `same-origin-allow-popups`  | Keeps `window.opener` for same-origin popups; cross-origin popups still get `null` opener. Compat-friendly for OAuth popup flows where the popup is on the same origin as the opener. |
| `noopener-allow-popups`     | Popups open normally but their `window.opener` is forced to `null` even for same-origin popups. Useful for OAuth flows that want isolation without breaking the popup window itself; the popup can still post results back via `BroadcastChannel` or `localStorage`. Spec addition (Chrome 119+, Firefox 131+). |
| `unsafe-none`               | Browser default. No isolation; equivalent to not setting the header. Use to explicitly opt OUT (e.g. to override a stricter upstream default). |

Caller-supplied options always win over settings:

```js
var coop = require('gina').plugins.Coop({ value: 'same-origin-allow-popups' });
```

Tokens are case-insensitive at this layer — values are normalised to
lowercase before validation and emission. The spec defines them as
lowercase enumerated strings; browsers parse case-sensitively, so the
emitted header is always lowercase.

## Tradeoff with the `same-origin` default

The strict default `same-origin` fully isolates `window.opener`
references across top-level navigation — the safest posture, and the
prerequisite for the `SharedArrayBuffer` combo when paired with
`Coep({ value: 'require-corp' })`. But it BREAKS legitimate OAuth / SSO
popup flows where the popup needs to call back into the opener via
`window.opener.postMessage(...)` or similar — the popup gets a `null`
opener and the call fails silently.

Three escape hatches when `same-origin` breaks an OAuth / SSO popup flow:

1. **Pick `same-origin-allow-popups`** (preferred when the popup is on
   the same origin as the opener) — keeps `window.opener` alive for
   same-origin popups, while still cutting opener for cross-origin
   popups. The most compat-friendly choice for OAuth flows where you
   control both the opener and the popup origin.
2. **Pick `noopener-allow-popups`** (when the popup must work but
   `window.opener` is not needed) — popups open normally, but
   `window.opener` is forced to `null`. The popup can still send
   results back via `BroadcastChannel`, `localStorage` events, or
   `window.postMessage(...)` to a known origin via a `MessageChannel`
   created before the navigation. Best for OAuth flows that just need
   the popup to complete a redirect chain without retaining a back
   reference.
3. **Pick `unsafe-none`** (last resort) — gives up cross-origin
   isolation entirely. The opener and popup share an agent group;
   `window.opener` is preserved cross-origin. Loses the
   `SharedArrayBuffer` combo and the side-channel defense.

## Pair with COEP for the SharedArrayBuffer combo

To enable `SharedArrayBuffer` and the rest of the
cross-origin-isolated-context features, register BOTH plugins together:

```js
var coep = require('gina').plugins.Coep();                          // require-corp (default)
var coop = require('gina').plugins.Coop();                          // same-origin (default)
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
| `value` omitted                                          | Defaults to `same-origin`                             |
| `value` is not one of the 4 W3C tokens                   | Factory throws at call time (bundle won't start)     |
| `value` is not a string                                  | Factory throws at call time                          |
| Plugin not registered                                    | Header not emitted; browser uses default behaviour   |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| OAuth popup flow with `same-origin`                      | Popup gets `null` opener; `window.opener.postMessage(...)` fails silently — see the three escape hatches above |
| Dev Inspector active under `same-origin`                 | View tab can't read client timing via `window.opener.performance` (opener severed under COOP). Server-side metrics fallback restores the **Weight** + **Load** badges; **FCP** (browser-only) stays unavailable. Dev-only — the Inspector is `NODE_ENV_IS_DEV`-gated. |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header — the
first writer wins.
