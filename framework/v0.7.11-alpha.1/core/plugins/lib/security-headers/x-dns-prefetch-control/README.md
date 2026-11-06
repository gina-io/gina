# X-DNS-Prefetch-Control Plugin (#HDR9)

Opt-in middleware that sets the `X-DNS-Prefetch-Control` response
header on every response, controlling whether the browser proactively
resolves DNS for links, images, CSS, and JavaScript referenced by the
page.

Part of **Phase 1.5** (helmet-parity gap-fill) of the gina security-
headers track.

## Why

DNS prefetching is a browser optimisation: the browser kicks off DNS
lookups for hostnames referenced by the page (in `<link>`, `<img>`,
external scripts, etc.) before the user clicks the link. Faster
navigation when the link is clicked; leaks the user's "intent surface"
to the DNS resolver — typically the ISP, plus any caching resolver in
between — even for links the user never visits.

`off` (the default) is the privacy-respecting choice: the browser does
not pre-resolve DNS for unclicked links, so the resolver only sees the
hostnames the user actually navigates to. `on` is the perceived-
performance choice when DNS lookups are slow relative to the rest of
the page load.

Marginal practical value in 2026 — modern Chrome / Firefox have their
own DNS-prefetch heuristics that mostly ignore the header. The
defense-in-depth + helmet-parity rationale is why this ships.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp               = require('gina');
var xDnsPrefetchControl = require('gina').plugins.XDnsPrefetchControl();

myapp.onInitialize(function(event, app) {
    app.use(xDnsPrefetchControl);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header
is emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "xDnsPrefetchControl": {
    "value": "off"
  }
}
```

| Field   | Type   | Default | Valid values |
|---------|--------|---------|--------------|
| `value` | string | `off`   | `on`, `off`   |

Caller-supplied options always win over settings:

```js
var xDnsPrefetchControl = require('gina').plugins.XDnsPrefetchControl({ value: 'on' });
```

Tokens are case-insensitive at the plugin layer — values are
normalised to lowercase before validation and emission. Unknown tokens
throw at factory call time.

## Mapping from helmet's API

helmet's `xDnsPrefetchControl` middleware uses a different option
shape: `{ allow: boolean }` where `allow: true` emits `on` and
`allow: false` emits `off`. gina uses `{ value: 'on' | 'off' }`
matching the existing single-token-enum convention of #HDR2 (XFrame),
#HDR3 (ReferrerPolicy), #HDR6 (Coep), #HDR13 (Coop), and #HDR14 (Corp).

Migrating from helmet:

| helmet                                    | gina                                                 |
|-------------------------------------------|------------------------------------------------------|
| `helmet.xDnsPrefetchControl()`            | `gina.plugins.XDnsPrefetchControl()`                  |
| `helmet.xDnsPrefetchControl({ allow: true })`  | `gina.plugins.XDnsPrefetchControl({ value: 'on' })`   |
| `helmet.xDnsPrefetchControl({ allow: false })` | `gina.plugins.XDnsPrefetchControl({ value: 'off' })`  |

Same emitted header, different option shape.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `off`                                     |
| `value` is not one of `on` / `off`                       | Factory throws at call time (bundle won't start)     |
| `value` is not a string                                  | Factory throws at call time                          |
| Plugin not registered                                    | Header not emitted; browser uses its built-in DNS prefetch heuristics |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header — the
first writer wins.
