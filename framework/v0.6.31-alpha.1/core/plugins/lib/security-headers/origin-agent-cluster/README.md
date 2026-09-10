# Origin-Agent-Cluster Plugin (#HDR7)

Opt-in middleware that sets the `Origin-Agent-Cluster: ?1` response
header on every response, requesting that the browser place this page's
origin in its own agent cluster (origin-keyed) rather than the default
site-keyed (eTLD+1) cluster.

## Why

By default, two same-site cross-origin pages (e.g. `app.example.com`
and `marketing.example.com`) share an agent cluster — they can
synchronously script each other if either page sets `document.domain`.
Origin-Agent-Cluster opts the page out of this: it gets its own agent,
isolated from sibling-origin pages, and `document.domain` becomes a
no-op.

Two benefits:

1. **Spectre mitigation** — origin-keyed agents are placed in their own
   OS process where possible, limiting the blast radius of side-channel
   attacks that leak memory across same-site pages.
2. **Cleaner isolation contract** — defends against the rare-but-real
   pattern where a less-trusted same-site origin tries to reach into a
   trusted page's documents via `document.domain` tricks.

Cost is small: same-site cross-origin pages can no longer use
`document.domain` to share a same-origin context. Pages that rely on
this legacy pattern (rare in modern apps) should not opt in.

Per the [HTML spec](https://html.spec.whatwg.org/multipage/document-sequences.html#origin-keyed-agent-clusters)
and helmet convention, `?1` (boolean true per Structured Header Values
syntax) is the only value worth emitting. `?0` is the browser default;
emitting it is a no-op. There is no `enabled` flag in the configuration
surface — register the plugin to opt in, don't register to opt out.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp              = require('gina');
var originAgentCluster = require('gina').plugins.OriginAgentCluster();

myapp.onInitialize(function(event, app) {
    app.use(originAgentCluster);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "originAgentCluster": {}
}
```

The block is reserved for future use (e.g. per-route opt-out). Today the
plugin has no tunable options — the only useful header value is `?1`,
and the header is unconditionally emitted on every response the
middleware sees.

## Browser support

Chrome 88+, Edge 88+, Firefox 109+, Safari 15+. Older browsers ignore
the header silently — safe to register unconditionally.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| Plugin not registered                                    | Header not emitted; browser uses default site-keyed agent |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| Browser predates the feature                             | Header ignored silently — harmless                   |
| Same-origin policy relies on `document.domain`           | Will break; do not register the plugin               |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header (e.g.
a generic helmet-style upstream gate) — the first writer wins.
