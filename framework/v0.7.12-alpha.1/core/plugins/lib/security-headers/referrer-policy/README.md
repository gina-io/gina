# Referrer-Policy Plugin (#HDR3)

Opt-in middleware that sets the `Referrer-Policy` response header on
every response, controlling how much referrer information the browser
includes when navigating away from the page or fetching sub-resources.

## Why

The `Referer` request header reveals the previous page's URL — including
path and query string — to the destination. That can leak sensitive
information: session tokens in URLs, internal page paths, account IDs,
search queries. The `Referrer-Policy` response header lets the page tell
the browser exactly how much referrer information to share for outbound
navigations and sub-resource requests.

Modern browsers (Chrome 85+, Firefox 87+, Safari 14.5+, Edge 85+) default
to `strict-origin-when-cross-origin` since ~2021 — a sensible privacy /
compatibility balance. Emitting the header explicitly locks the policy in
regardless of the user's browser default and signals intent.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp          = require('gina');
var referrerPolicy = require('gina').plugins.ReferrerPolicy();

myapp.onInitialize(function(event, app) {
    app.use(referrerPolicy);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "referrerPolicy": {
    "value": "strict-origin-when-cross-origin"
  }
}
```

| Field   | Type   | Default                              | Valid values         |
|---------|--------|--------------------------------------|----------------------|
| `value` | string | `strict-origin-when-cross-origin`    | One of the 8 tokens  |

The eight valid tokens per the [W3C Referrer Policy spec](https://www.w3.org/TR/referrer-policy/):

| Token                                | Behaviour                                                            |
|--------------------------------------|----------------------------------------------------------------------|
| `no-referrer`                        | Never send the Referer header.                                       |
| `no-referrer-when-downgrade`         | Strip Referer only on HTTPS→HTTP. Pre-2021 browser default.          |
| `origin`                             | Send origin only (no path / query).                                  |
| `origin-when-cross-origin`           | Full Referer same-origin; origin only cross-origin.                  |
| `same-origin`                        | Send Referer only on same-origin requests.                           |
| `strict-origin`                      | Send origin only; no Referer at all on HTTPS→HTTP.                   |
| `strict-origin-when-cross-origin`    | **Default**. Full Referer same-origin; origin only cross-origin; no Referer on HTTPS→HTTP. |
| `unsafe-url`                         | Always send the full URL. **Dangerous** — leaks paths and queries.   |

Caller-supplied options always win over settings:

```js
var referrerPolicy = require('gina').plugins.ReferrerPolicy({ value: 'no-referrer' });
```

Tokens are case-insensitive per the spec — values are normalised to
lowercase before validation and emission (so `"NO-REFERRER"` is
accepted and emitted as `no-referrer`).

## Choosing a policy

Quick guide:

- **Sites that handle authenticated user data** — `strict-origin-when-cross-origin` (default) or `same-origin`. The default leaks no path / query info cross-origin, which protects most session-token-in-URL anti-patterns.
- **Privacy-focused sites** — `no-referrer`. Maximum privacy at the cost of breaking some analytics flows that rely on referrer attribution.
- **Public marketing / documentation sites** — `strict-origin-when-cross-origin` is also a good default; only use `origin-when-cross-origin` if you have a specific cross-origin partner that needs full path info.
- **Never use `unsafe-url`** unless you've confirmed that every URL the page can link out to is safe to leak in full.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `strict-origin-when-cross-origin`        |
| `value` is not one of the 8 W3C tokens                   | Factory throws at call time (bundle won't start)     |
| Plugin not registered                                    | Header not emitted; browser uses its built-in default |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header (e.g.
a generic helmet-style upstream gate) — the first writer wins.
