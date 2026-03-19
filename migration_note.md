[ 0.1.6 => 0.1.7 ]

Cache config — sliding window and absolute ceiling (additive, backward compatible):
  Two optional fields added to per-route cache config in routing.json.
  Existing configs with only `ttl` are unchanged.

  New fields:
    "sliding"  (boolean, default false) — when true, the ttl resets on every
               request that hits the cached entry. The entry stays warm as long
               as it keeps receiving traffic.
    "maxAge"   (number, seconds) — absolute lifetime ceiling from creation time.
               Only meaningful when sliding is true. The entry is evicted at
               createdAt + maxAge regardless of traffic. Strongly recommended
               whenever sliding is enabled.

  The meaning of "ttl" changes depending on "sliding":
    sliding: false (default)  → ttl is absolute duration from creation (unchanged)
    sliding: true             → ttl is the idle eviction threshold (seconds since
                                last access); maxAge is the hard ceiling

  Examples:
    { "type": "memory", "ttl": 3600 }
      Unchanged — absolute TTL of 1 hour from first cache write.

    { "type": "memory", "ttl": 300, "sliding": true }
      Evict if not accessed for 5 minutes. No hard ceiling — entry may live
      indefinitely on busy routes. Use with care.

    { "type": "memory", "ttl": 300, "sliding": true, "maxAge": 3600 }
      Evict if idle for 5 minutes OR after 1 hour from creation, whichever
      comes first. Recommended pattern.

  Cache-Status response header format updated:
    Non-sliding: gina-cache; hit; ttl=NNN          (unchanged)
    Sliding:     gina-cache; hit; ttl=NNN; max-age=MMM
      ttl=    remaining seconds in the current idle window
      max-age= remaining seconds until absolute ceiling


Timeout config — human-readable string format:
  All timeout fields in settings.json and app.json now accept duration strings
  in addition to millisecond integers (backward compatible).
  Accepted units: "500ms", "5s", "1m", "1h"
  Examples:
    "keepAliveTimeout": "5s"        // was 5000
    "headersTimeout":   "5500ms"    // was 5500
    "pingInterval":     "5s"        // was 5000
    "pingTimeout":      "45s"       // was 45000
    "timeout":          "30s"       // was 30000 in proxy config
  Plain integers (ms) continue to work unchanged.
  Note: autoTmpCleanupTimeout string format ("10m" etc.) was documented since
  0.1.x but silently broken (NaN). It is correctly parsed as of 0.1.7.


[ 0.1.x => 0.1.6 ]

Node.js:
  Minimum version bumped to 18. Maximum < 26.
  Drop support for Node 16 and 17.

Docker / Kubernetes:
  Use the new `gina-container` binary for foreground bundle launch in containers.
  It handles SIGTERM gracefully and does not use the background daemon mode.
  In your Dockerfile / K8s spec replace:
    gina bundle:start <bundle> @<project>
  with:
    gina-container bundle:start <bundle> @<project>

upload config (settings.json):
  autoTmpCleanupTimeout is now available to schedule automatic removal of
  uploaded tmp files. Set to false (default) to disable, or a duration:
    "upload": {
      "autoTmpCleanupTimeout": false   // false | 0 to disable, or e.g. "10m"
    }

Security — swig CVE-2023-25345 (directory traversal):
  Patched in-place in the vendored swig 1.4.2. No user action required.
  Template paths using {% extends %} or relative/absolute file paths are now
  validated against the template root before being read.

Security — dead framework version removed:
  v0.1.1-alpha.1 declared sanitize-html ^2.5.0 (CVE-2021-26539/26540, XSS)
  and busboy ^0.2.14 (dicer ReDoS). If your project declared a dependency on
  that framework version, update to 0.1.6.


[ 0.0.9p2 => 0.1.x ]

Node.js:
  Minimum version is now 16. Drop support for Node < 16.

settings.json — new server fields (add to every bundle):
  "server": {
    "engine": "isaac",            // or "express" for the legacy adapter
    "keepAliveTimeout": 5000,     // ms; keep-alive idle timeout
    "headersTimeout": 5500,       // ms; must be > keepAliveTimeout
    "http2Options": {
      "maxConcurrentStreams": 128
    }
  }

HTTP/2 (isaac engine only):
  In settings.json set:
    "server": {
      "protocol": "http/2.0",
      "scheme": "https",
      "allowHTTP1": true,
      "credentials": {
        "privateKey":   "{GINA_HOMEDIR}/certificates/scopes/{scope}/{host}/private.key",
        "certificate":  "{GINA_HOMEDIR}/certificates/scopes/{scope}/{host}/certificate.crt",
        "ca":           "{GINA_HOMEDIR}/certificates/scopes/{scope}/{host}/ca_bundle.crt"
      }
    }
  TLS certificates are required. HTTP/1.1 fallback is kept with allowHTTP1: true.

app.json proxy config — new fields per upstream service:
  "proxy": {
    "<service>": {
      "ca":       "<path to CA bundle>",
      "hostname": "<bundle>@<project>",
      "port":     "<bundle>@<project>",
      "path":     "<base path>"
    }
  }

engine.io / WebSocket (optional):
  If using ioServer, add to settings.json:
    "ioServer": {
      "integrationMode": "attach",
      "transports": ["websocket", "polling"],
      "pingInterval": 5000,   // ms
      "pingTimeout":  10000   // ms
    }


[ 0.0.9 => 0.0.9p1 ]
If exists, move statics definitions from /config/views.json to /config/statics.json
In your project.json, and for each bundle declaration, remove the key: [ target ] in bundle.release.target

[ 0.0.9p1 => 0.0.9p2 ]
nothing to do
