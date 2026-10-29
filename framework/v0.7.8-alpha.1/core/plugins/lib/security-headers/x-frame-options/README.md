# X-Frame-Options Plugin (#HDR2)

Opt-in middleware that sets the `X-Frame-Options` response header on
every response, defending against clickjacking by controlling whether
the page may be rendered inside a `<frame>`, `<iframe>`, `<embed>` or
`<object>`.

## Why

Clickjacking attacks load your page in a hidden / styled `<iframe>` on
an attacker's site and trick the user into interacting with elements
they can't see — submitting a transfer, granting OAuth consent, etc.
`X-Frame-Options` instructs the browser to refuse to render the page
inside a frame at all (`DENY`) or only when the framing page shares the
same origin (`SAMEORIGIN`).

`Content-Security-Policy: frame-ancestors` is the modern replacement
(more expressive, cross-browser since ~2015), but `X-Frame-Options` is
still emitted by every defensive HTTP stack because legacy clients and
some intermediaries honour the older header and ignore CSP.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp         = require('gina');
var xFrameOptions = require('gina').plugins.XFrameOptions();

myapp.onInitialize(function(event, app) {
    app.use(xFrameOptions);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "xFrameOptions": {
    "value": "SAMEORIGIN"
  }
}
```

| Field   | Type   | Default       | Valid values            |
|---------|--------|---------------|-------------------------|
| `value` | string | `SAMEORIGIN`  | `DENY` or `SAMEORIGIN`  |

Caller-supplied options always win over settings:

```js
var xFrameOptions = require('gina').plugins.XFrameOptions({ value: 'DENY' });
```

Values are normalised to uppercase before validation — `"deny"` is
accepted and emitted as `DENY`.

## Rejected: `ALLOW-FROM <uri>`

The legacy `ALLOW-FROM <uri>` value is rejected at factory call time.
Modern browsers ignore it: Chrome / Edge / Safari never supported it,
Firefox dropped it in 70 (October 2019). Use
`Content-Security-Policy: frame-ancestors <source-list>` instead — it
works cross-browser and accepts richer source expressions.

The factory throws with a message pointing at the MDN reference:

```
[gina.plugins.XFrameOptions] the legacy "ALLOW-FROM <uri>" value is no
longer supported by modern browsers (Chrome / Edge / Safari never
honoured it, Firefox dropped it in 70). Use
`Content-Security-Policy: frame-ancestors <source-list>` instead — see
https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors
```

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| `value` omitted                                          | Defaults to `SAMEORIGIN`                             |
| `value` is not "DENY" or "SAMEORIGIN" (or alias of)      | Factory throws at call time (bundle won't start)     |
| `value` starts with `ALLOW-FROM`                         | Factory throws with dedicated `frame-ancestors` hint |
| Plugin not registered                                    | Header not emitted; page is framable by any origin   |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header (e.g.
a generic helmet-style upstream gate) — the first writer wins.
