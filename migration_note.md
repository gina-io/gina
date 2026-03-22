# Migration Notes

---

## 0.1.7 → 0.1.8

### Config interpolation — `${variable}` syntax required (breaking change)

`whisper()` — the engine that substitutes variables in config files (`env.json`,
`settings.json`, `app.json`, `templates.json`, `statics.json`, etc.) — now
requires the `${variable}` syntax. The legacy `{variable}` (no dollar sign) is
no longer replaced.

**Action required** if your project's config files use bare `{variable}` placeholders:

```jsonc
// Before (no longer works)
"logDir": "{GINA_HOMEDIR}/logs/{scope}/{bundleName}"

// After
"logDir": "${GINA_HOMEDIR}/logs/${scope}/${bundleName}"
```

All built-in framework templates shipped with gina have already been updated.
User-managed config files under your bundle's `config/` directory must be
updated manually.

Variables with dots (`{gina.core}`, `{gina.utils}`) and the `{src:...}` wrapper
syntax in `templates.json` are not processed by whisper and are unaffected.

---

## 0.1.6 → 0.1.7

### Cache — Sliding window and absolute ceiling

Two optional fields added to per-route cache config in `routing.json`.
Existing configs with only `ttl` are unchanged (additive, backward compatible).

| Field | Type | Default | Description |
|---|---|---|---|
| `sliding` | boolean | `false` | When `true`, the TTL resets on every request that hits the cached entry. The entry stays warm as long as it keeps receiving traffic. |
| `maxAge` | number (seconds, fractional ok) | — | Absolute lifetime ceiling from creation time. Only meaningful when `sliding: true`. The entry is evicted at `createdAt + maxAge` regardless of traffic. Strongly recommended whenever sliding is enabled. |

The meaning of `ttl` changes depending on `sliding`:

| `sliding` | `ttl` meaning |
|---|---|
| `false` (default) | Absolute duration from creation — unchanged behaviour |
| `true` | Idle eviction threshold (seconds since last access); `maxAge` is the hard ceiling |

**Examples**

```jsonc
// Unchanged — absolute TTL of 1 hour from first cache write
{ "type": "memory", "ttl": 3600 }

// Evict if not accessed for 5 minutes.
// No hard ceiling — entry may live indefinitely on busy routes. Use with care.
{ "type": "memory", "ttl": 300, "sliding": true }

// Evict if idle for 5 minutes OR after 1 hour from creation, whichever comes first.
// Recommended pattern.
{ "type": "memory", "ttl": 300, "sliding": true, "maxAge": 3600 }
```

**`Cache-Status` response header format**

```
# Non-sliding (unchanged)
gina-cache; hit; ttl=NNN

# Sliding
gina-cache; hit; ttl=NNN; max-age=MMM
```

- `ttl=` — remaining seconds in the current idle window
- `max-age=` — remaining seconds until the absolute ceiling

---

### Cache — `Cache-Control` header and `visibility` field

The framework now emits `Cache-Control` on cached routes, synchronised with the server-side TTL.

**New optional field** in per-route cache config (`routing.json`):

| Field | Type | Default | Description |
|---|---|---|---|
| `visibility` | `"public"` \| `"private"` | `"private"` | Controls the `Cache-Control` visibility directive sent to browsers and CDNs. Use `"public"` only for routes that serve the same content to all users. Default `"private"` prevents accidental CDN caching of session-bearing responses. |

**Miss path** (first request, response written by the controller):
```
Cache-Control: private, max-age=3600
```
(or `public` when `visibility: "public"` is set)

**Hit path** (subsequent requests served from server cache):
```
Cache-Control: private, max-age=<remaining_seconds>
```
The `max-age` decrements with time so downstream caches do not over-serve stale content.

**No action required** for existing configs — `visibility` defaults to `"private"`.
To opt a route into CDN/shared caching add `"visibility": "public"` to its cache block:

```jsonc
// routing.json — example
"cache": { "type": "memory", "ttl": 3600, "visibility": "public" }
```

---

### Cache — Sub-second TTL and maxAge values

`ttl` and `maxAge` now accept fractional seconds (e.g. `0.5` for 500 ms).
Previously, fractional values were silently truncated to zero, causing immediate eviction.
Integer values are unchanged — no action required on existing configs.

---

### Timeout config — human-readable string format

All timeout fields in `settings.json` and `app.json` now accept duration strings
in addition to millisecond integers (backward compatible).

Accepted units: `ms`, `s`, `m`, `h`

```jsonc
"keepAliveTimeout": "5s",      // was 5000
"headersTimeout":   "5500ms",  // was 5500
"pingInterval":     "5s",      // was 5000
"pingTimeout":      "45s",     // was 45000
"timeout":          "30s"      // was 30000 (proxy config)
```

> **Note:** `autoTmpCleanupTimeout` string format (`"10m"` etc.) was documented since
> 0.1.x but silently broken (parsed as `NaN`). It is correctly parsed as of 0.1.7.

Plain integers (ms) continue to work unchanged.

---

## 0.1.x → 0.1.6

### Node.js

Minimum version bumped to **18**. Maximum `< 26`.
Drop support for Node 16 and 17.

---

### Docker / Kubernetes

Use the new `gina-container` binary for foreground bundle launch in containers.
It handles `SIGTERM` gracefully and does not use the background daemon mode.

In your Dockerfile / K8s spec, replace:

```sh
gina bundle:start <bundle> @<project>
```

with:

```sh
gina-container bundle:start <bundle> @<project>
```

---

### Upload config (`settings.json`)

`autoTmpCleanupTimeout` is now available to schedule automatic removal of uploaded tmp files.

```jsonc
"upload": {
  "autoTmpCleanupTimeout": false  // false | 0 to disable, or a duration e.g. "10m"
}
```

Default is `false` (disabled).

---

### Security — swig CVE-2023-25345 (directory traversal)

Patched in-place in the vendored swig 1.4.2. **No user action required.**
Template paths using `{% extends %}` or relative/absolute file paths are now
validated against the template root before being read.

---

### Security — dead framework version removed

`v0.1.1-alpha.1` declared `sanitize-html ^2.5.0` (CVE-2021-26539/26540, XSS)
and `busboy ^0.2.14` (dicer ReDoS). If your project declared a dependency on
that framework version, update to `0.1.6`.

---

## 0.0.9p2 → 0.1.x

### Node.js

Minimum version is now **16**. Drop support for Node < 16.

---

### `settings.json` — new server fields

Add to every bundle:

```jsonc
"server": {
  "engine": "isaac",         // or "express" for the legacy adapter
  "keepAliveTimeout": 5000,  // ms; keep-alive idle timeout
  "headersTimeout":   5500,  // ms; must be > keepAliveTimeout
  "http2Options": {
    "maxConcurrentStreams": 128
  }
}
```

---

### HTTP/2 (isaac engine only)

```jsonc
"server": {
  "protocol":   "http/2.0",
  "scheme":     "https",
  "allowHTTP1": true,
  "credentials": {
    "privateKey":  "${GINA_HOMEDIR}/certificates/scopes/${scope}/${host}/private.key",
    "certificate": "${GINA_HOMEDIR}/certificates/scopes/${scope}/${host}/certificate.crt",
    "ca":          "${GINA_HOMEDIR}/certificates/scopes/${scope}/${host}/ca_bundle.crt"
  }
}
```

TLS certificates are required. HTTP/1.1 fallback is kept with `allowHTTP1: true`.

---

### `app.json` — proxy config new fields

```jsonc
"proxy": {
  "<service>": {
    "ca":       "<path to CA bundle>",
    "hostname": "<bundle>@<project>",
    "port":     "<bundle>@<project>",
    "path":     "<base path>"
  }
}
```

---

### engine.io / WebSocket (optional)

If using `ioServer`, add to `settings.json`:

```jsonc
"ioServer": {
  "integrationMode": "attach",
  "transports":      ["websocket", "polling"],
  "pingInterval":    5000,  // ms
  "pingTimeout":     10000  // ms
}
```

---

## 0.0.9 → 0.0.9p1

- Move statics definitions from `/config/views.json` to `/config/statics.json`.
- In `project.json`, for each bundle declaration, remove the `target` key from `bundle.release.target`.

---

## 0.0.9p1 → 0.0.9p2

Nothing to do.
