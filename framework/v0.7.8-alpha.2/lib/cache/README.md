## Cache

In-process key/value cache backed by a `Map`. Shared across all subsystems
via `serverInstance._cached`. Each renderer attaches to that map with
`cache.from(serverInstance._cached)` before reading or writing.

---

### Cache config (routing.json)

Options can be passed per route via `routing.json` or set server-wide in
the server config. The `cache` field accepts either a shorthand string or a
full object:

```json
"cache": "memory"
```

```json
"cache": {
    "type"    : "memory",
    "ttl"     : 3600
}
```

#### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"memory"` \| `"fs"` | — | Storage backend. `memory` keeps the rendered output in the shared Map. `fs` writes it to disk and stores only the filename in the Map. |
| `ttl` | number (seconds, fractional ok) | server default | Expiry duration. Meaning depends on `sliding` — see below. |
| `sliding` | boolean | `false` | Enable sliding-window expiration. |
| `maxAge` | number (seconds, fractional ok) | — | Absolute lifetime ceiling. Only meaningful when `sliding: true`. |
| `invalidateOnEvents` | string[] | — | Event names that trigger invalidation of this entry. |

---

### Expiration modes

#### Absolute TTL (default)

```json
"cache": { "type": "memory", "ttl": 3600 }
```

The entry is evicted exactly `ttl` seconds after it was first written,
regardless of traffic. Simple to reason about: a cached page is at most
1 hour stale.

#### Sliding window

```json
"cache": { "type": "memory", "ttl": 300, "sliding": true }
```

`ttl` becomes an idle threshold. The entry stays alive as long as it receives
at least one request every `ttl` seconds. Each cache hit resets the clock.

A busy route stays warm indefinitely. A cold route dies after `ttl` seconds
of silence.

> **Note:** Without `maxAge`, a constantly-accessed entry never expires.
> This is intentional but means stale data can persist indefinitely on
> high-traffic routes. Use `maxAge` as a safety net unless you have a
> separate invalidation strategy.

#### Sliding window + absolute ceiling (recommended)

```json
"cache": { "type": "memory", "ttl": 300, "sliding": true, "maxAge": 3600 }
```

Combines both: the entry is evicted when it has been idle for `ttl` seconds
**or** when it reaches `maxAge` seconds of age — whichever comes first.

- `ttl` = idle eviction threshold (seconds since last access)
- `maxAge` = hard ceiling (seconds since creation, regardless of traffic)

This is the recommended pattern when `sliding` is enabled. It keeps popular
routes warm while guaranteeing that no entry lives longer than `maxAge`
seconds, bounding data staleness even under constant traffic.

#### Choosing between modes

| Scenario | Recommended config |
|----------|--------------------|
| Static asset, predictable staleness | `{ ttl }` |
| Popular page, keep warm, no freshness guarantee needed | `{ ttl, sliding: true }` |
| Popular page with a freshness guarantee | `{ ttl, sliding: true, maxAge }` |
| Data that must always be invalidated by an event | `{ ttl, invalidateOnEvents: [...] }` |

---

### ttl vs maxAge — what is the difference?

Both are durations in seconds, but they measure from different reference points:

| Field | Measures from | Active when |
|-------|--------------|-------------|
| `ttl` | Last **access** time (sliding) or creation time (non-sliding) | Always |
| `maxAge` | **Creation** time, always | `sliding: true` only |

Without `sliding`, `ttl` already defines the absolute lifetime — `maxAge`
is redundant and ignored.

With `sliding`, `ttl` is the sliding window and `maxAge` is the ceiling.
They are genuinely different: a page with `ttl: 300, maxAge: 3600` can
receive thousands of hits in an hour and still be evicted at the 1-hour
mark.

---

### Cache-Status response header

Every GET response carries a `Cache-Status` header indicating cache outcome:

| Value | Meaning |
|-------|---------|
| `gina-cache; fwd=uri-miss` | No cached entry for this URL (RFC 9211 §2.2 form) |
| `gina-cache; hit; ttl=NNN` | Hit — `NNN` seconds remaining (absolute TTL) |
| `gina-cache; hit; ttl=NNN; max-age=MMM` | Hit — `NNN` seconds in current idle window, `MMM` seconds until absolute ceiling |

`gina-cache` is the default identifier — `server.cache.name` (settings.json
`cache` block) replaces it with an operator-chosen RFC 8941 token (a letter,
then up to 63 of `[A-Za-z0-9._-]`); every parameter after it is unchanged.
When `server.hidePoweredBy` is true and the cache is enabled, leaving `name`
unset logs a boot warn (the wire still names the framework); set any token
(e.g. `cache`) to close the disclosure, or explicitly `gina-cache` to keep
the default wire and silence the warn.

---

### Storage backends

**`memory`** — rendered content is stored as a string in the shared Map.
Fast, but every cached page consumes heap. Use for the most frequently
accessed, session-independent pages.

**`fs`** — rendered content is written to disk under
`{cache.path}/{bundle}/html{url}.html` (HTML) or `.../data{url}.json`
(JSON). Only the filename is held in the Map. Slower reads (disk I/O) but
the heap footprint is minimal. When the entry is evicted the file is deleted
automatically.

---

### Event-driven invalidation

```json
"cache": {
    "type"              : "memory",
    "ttl"               : 3600,
    "invalidateOnEvents": ["invoice#saved", "account#updated"]
}
```

Fire it from a controller with `self.cache.invalidateByEvent(eventName)`. Every
entry registered to that event is evicted immediately, whatever its remaining
TTL, and the call returns how many were evicted. For an `fs` entry the cached
body and its `.meta` sidecar are removed from disk too.

```js
self.cache.invalidateByEvent('invoice#saved'); // => 2
```

Scope is the **calling process**. The `memory` store lives in the bundle's own
heap, so a controller can only invalidate its own bundle. To invalidate across
bundles — bundle A's write must evict bundle B's cached pages — use the external
trigger instead:

```tty
$ gina cache:clear @<project_name> --event=invoice#saved
```

or `POST /_gina/cache/clear?event=invoice#saved` (admin-gated, both engines).

---

## Debugging tests with nodeunit

```tty
node --inspect-brk=6959 `which nodeunit` test/node_modules/cache/test/01-cache.js
```
