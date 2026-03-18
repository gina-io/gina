
[ 0.0.9p1 => 0.0.9p2 ]
nothing to do

[ 0.0.9 => 0.0.9p1 ]
If exists, move statics definitions from /config/views.json to /config/statics.json
In your project.json, and for each bundle declaration, remove the key: [ target ] in bundle.release.target


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


[ 0.1.6 => 0.1.7 ]

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
