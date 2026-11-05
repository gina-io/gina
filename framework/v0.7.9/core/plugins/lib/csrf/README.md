# Csrf Plugin (#CSRF2)

Signed double-submit token CSRF middleware. Stateless defense aligned
with OWASP ASVS 4.0 V4.2.1.

## Why

Cookie hardening (`#CSRF1`, `gina.plugins.Session`) raises the bar for
drive-by CSRF on modern browsers, but `SameSite=Lax` does not block
same-site form posts and is ignored by older browsers. The token
middleware closes that window: every mutating request (POST/PUT/PATCH/
DELETE) must carry a token tied to the session, verified in constant
time. Safe methods (GET/HEAD/OPTIONS) pass through.

The token is signed (HMAC-SHA256), so a sibling subdomain that can set
cookies on the parent domain cannot forge a usable value — the verify
step catches tokens that were not minted with this server's secret.

## Adoption

Two lines in the bundle bootstrap, **after** the session middleware:

```js
var csrf    = require('gina').plugins.Csrf();
var session = require('gina').plugins.Session(require('express-session'));

app.use(session({ /* … */ }));   // must register session FIRST
app.use(csrf);                   // verify gate runs once routing is matched
```

## Server secret

The plugin reads `process.env.GINA_CSRF_SECRET` and refuses to start
when it is missing — there is no dev fallback. Generate once and store
it in `env.json` or your shell profile:

```sh
openssl rand -base64 64
```

Rotate the secret to invalidate every outstanding token.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "csrf": {
    "cookieName":  "gina-csrf-token",        // cookie name issued on safe methods
    "headerName":  "X-Gina-CSRF-Token",      // header name verified on mutations
    "fieldName":   "_csrf",                  // form field name verified on mutations
    "rotate":      "per-session",            // "per-session" | "per-request"
    "safeMethods": ["GET", "HEAD", "OPTIONS"]
  }
}
```

The secret is **never** stored in `settings.json` — env var only.

## Per-route opt-out

Webhook receivers (Stripe, GitHub, etc.) are not browser-driven and do
not benefit from CSRF defense. Mark those routes exempt in
`routing.json`:

```jsonc
{
  "stripe-webhook": {
    "url":        "/webhooks/stripe",
    "method":     "POST",
    "csrfExempt": true,
    "param":      { "control": "@webhook:stripe", "file": "stripe.js" }
  }
}
```

The opt-out is positive — `csrfExempt: true` — so a misread leaves a
webhook broken (obvious) rather than an endpoint silently
CSRF-vulnerable.

## Token shape

```
<nonce_b64url>.<mac_b64url>
mac = HMAC-SHA256(sessionId + ':' + nonce_b64url, GINA_CSRF_SECRET)
```

- `nonce` is 16 random bytes from `crypto.getRandomValues`.
- Both halves are encoded with `base64url` (Node 16+).
- The verify path uses `crypto.timingSafeEqual` with a length guard.

## Failure modes

| Condition                                 | Outcome                                      |
|-------------------------------------------|----------------------------------------------|
| `GINA_CSRF_SECRET` missing                | Factory throws at call time                  |
| Csrf registered before Session            | First request throws via `next(err)`         |
| `req.session.id` missing (no auth flow)   | Mutating request throws via `next(err)`      |
| Mutating request without token            | 403 Forbidden + log line                     |
| Token / cookie mismatch                   | 403 Forbidden + log line                     |
| HMAC mismatch (forged or stale token)     | 403 Forbidden + log line                     |
| Route marked `csrfExempt: true`           | Bypass, no token check                       |

The error message on session misorder is identical to the sessionless
case so the same fix (register Session first) covers both.

## Token availability for templates

The middleware sets `req.csrfToken` on every request that issues or
verifies a token. Subsequent commits expose it in the controller render
context as `gina.csrfToken` and a pre-formatted hidden input
`gina.csrfInput` for `<form>` consumers.
