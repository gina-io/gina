# Hide X-Powered-By Plugin (#HDR8)

Opt-in middleware that removes the `X-Powered-By` response header.
Opens Phase 1.5 (helmet-parity gap-fill) of the gina Web Security
Headers track.

## Why

gina emits `X-Powered-By: Gina/<version>` on every response by default
— `core/server.js:2425` on the Express engine, and the
`_setPoweredByHeader()` helper at `core/server.isaac.js:572-577` on
the Isaac engine. The header reveals the framework identity AND the
version to anyone inspecting the response — useful intel for attackers
scanning for known-vulnerable stacks.

Removing the header costs zero bytes (the response is smaller) and
reduces the attacker's reconnaissance surface by one fact: they no
longer know what server software answered the request. They can still
fingerprint via behaviour (response timing, error pages, header order,
TLS fingerprint, etc.) — this isn't a silver bullet — but it raises
the floor a notch.

helmet ships `hidePoweredBy` for the same reason; this plugin mirrors
that shape so bundles migrating from helmet find the API familiar.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp         = require('gina');
var hidePoweredBy = require('gina').plugins.HidePoweredBy();

myapp.onInitialize(function(event, app) {
    app.use(hidePoweredBy);
    event.emit('complete', app);
});
```

Order with other gina middlewares: mount AFTER any middleware that
might explicitly set `X-Powered-By` (otherwise the explicit set would
fire after this removal and re-add the header). In practice, the
gina framework sets the header in its early middleware before any
user `app.use()` mount runs, so registering `HidePoweredBy` anywhere
in the user middleware chain works on the Express engine.

## Configuration

No tunable options. The plugin has a single behaviour: remove the
`X-Powered-By` header. Registering opts in; not registering opts out.

A `settings.json > hidePoweredBy` slot is reserved for future fields
(e.g. a per-route opt-out list); leaving it empty `{}` keeps the
default behaviour.

```jsonc
{
  "hidePoweredBy": {}
}
```

## Effectiveness — Express vs Isaac engines

**Express engine (`server.express.js`)**: the plugin works as
expected. The framework's `response.setHeader('X-Powered-By', ...)`
at `server.js:2425` runs before any user-mounted middleware, so by
the time `HidePoweredBy`'s middleware fires, the header is set and
`res.removeHeader('x-powered-by')` removes it cleanly before the
response is written.

**Isaac engine (`server.isaac.js`) — use `server.hidePoweredBy: true`
instead of (or in addition to) this middleware**: Isaac emits
`X-Powered-By` via the `_setPoweredByHeader(headers)` helper at
`server.isaac.js:572-577`, which writes the header into the headers
object passed to `writeHead(...)` at every `/_gina/*` built-in endpoint
(~15 sites: health, metrics, info, cache stats, inspector SSE, agent,
indexes, reveal, etc.), plus one direct `setHeader` site at L1188 for
the routing.json asset endpoint. `writeHead` commits its headers
object before any user middleware runs, so this plugin's
`removeHeader('x-powered-by')` cannot intercept on Isaac (the call
runs, but the header was never set on the `res` object at middleware
time). The middleware is a no-op on Isaac.

ALL of the Isaac emit sites are gated on `options.hidePoweredBy`, so
flipping the setting closes the gap across the entire surface in one
edit. Set it in your bundle's `config/settings.json`:

```jsonc
{
  "server": {
    "engine": "isaac",
    "hidePoweredBy": true
  }
}
```

The flag (default `false`) makes the Isaac engine skip the
`X-Powered-By` write at every site at once. It is a no-op on the
Express engine — use `gina.plugins.HidePoweredBy()` middleware
there. Bundles that want belt-and-suspenders coverage across both
engines can set the flag AND register the middleware (each is a no-op
on the engine the other handles).

To check which engine your bundle uses, look at
`bundles/<name>/config/settings.json > server.engine` (defaults to
the Isaac engine when absent on most installs).

## Failure modes

| Condition                                                          | Outcome                                                                          |
|--------------------------------------------------------------------|----------------------------------------------------------------------------------|
| Plugin not registered                                              | `X-Powered-By: Gina/<version>` continues to be emitted                            |
| Plugin registered on Express engine                                | Header removed cleanly                                                            |
| Plugin registered on Isaac engine (no `server.hidePoweredBy` flag) | Header still emitted via `_setPoweredByHeader()` into every `writeHead` + setHeader site — set `settings.json > server.hidePoweredBy: true` |
| Isaac engine + `server.hidePoweredBy: true`                        | `_setPoweredByHeader()` skips the write at every site; this middleware is a no-op (safe redundancy)                                          |
| User middleware sets `X-Powered-By` AFTER this plugin runs         | Re-added; mount HidePoweredBy LAST in the chain to prevent                        |
| Response already sent (`res.headersSent === true`)                 | Node's `removeHeader` no-ops; request resumes                                    |

The plugin is safe to register more than once — `removeHeader` is
idempotent (no-op when the header is already absent), so a second
call has no effect.

## What this does NOT cover (#B238)

`server.hidePoweredBy` suppresses the `X-Powered-By` header — nothing
else. Two other response surfaces can still name the framework:

- **`Cache-Status` identifier** — when the render/output cache is
  enabled, every GET carries `Cache-Status: gina-cache; …` (RFC 9211).
  The identifier never changes implicitly (it is a documented-stable
  wire value); instead, a boot warn fires when `server.hidePoweredBy`
  is true, the cache is enabled, and no `server.cache.name` is set.
  Set any RFC 8941 token there (e.g. `"cache"`) to close the
  disclosure, or explicitly `"gina-cache"` to keep the wire and
  silence the warn.
- **`Vary: X-Gina-Navigate`** — routes with `negotiate: true` emit it
  so shared caches key fragment vs full-page responses correctly.
  This is caching-correctness metadata, not a banner: suppressing or
  renaming it would corrupt intermediary caches / break the client
  contract, so it is not configurable. Routes without `negotiate`
  never emit it.
