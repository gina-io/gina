# X-XSS-Protection Plugin (#HDR10)

Opt-in middleware that emits the literal header `X-XSS-Protection: 0`
on every response, **DISABLING** Chrome's legacy XSS auditor.

Part of **Phase 1.5** (helmet-parity gap-fill) of the gina security-
headers track.

## The value `0` is deliberate — not a typo

Chrome's `X-XSS-Protection` feature was a built-in XSS auditor in
older versions of the browser. Setting the header to `1` enabled it;
`1; mode=block` enabled it in block-rather-than-sanitise mode; `0`
disabled it. The naming suggests "0 means no protection" — counter-
intuitive for a security header.

**The auditor itself had its own vulnerabilities** that allowed cross-
site information disclosure. The modern security recommendation is to
DISABLE the auditor entirely (`0`) rather than rely on it. CSP
(`#HDR5`) covers the XSS-defense use case correctly without the
auditor's exfiltration risk.

The MDN reference is explicit on this:
[X-XSS-Protection — MDN Web Docs](https://developer.mozilla.org/docs/Web/HTTP/Headers/X-XSS-Protection)

> The non-standard `X-XSS-Protection` HTTP response header was a
> feature of Internet Explorer, Chrome, and Safari that stopped pages
> from loading when they detected reflected cross-site scripting
> attacks. These protections are largely unnecessary in modern
> browsers when sites implement a strong Content-Security-Policy that
> disables the use of inline JavaScript ('unsafe-inline'). … if you
> haven't set a strong CSP, the auditor's behavior can introduce its
> own XSS vulnerabilities.

helmet ships `xXssProtection` for the same reason — defense-in-depth
against the vanishing edge case of a legacy Chrome client (pre-v78)
or a security scanner that flags the absence of this header.

## Browser status in 2026

- **Chrome** dropped the XSS auditor entirely in v78 (October 2019).
- **Edge** follows Chrome.
- **Firefox** never implemented it.
- **Safari** never implemented it.
- **IE11** honoured it but is end-of-life as of 2022.

The header is effectively a no-op in modern browsers. The defense-in-
depth + helmet-parity narrative is why this ships.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp          = require('gina');
var xXssProtection = require('gina').plugins.XXssProtection();

myapp.onInitialize(function(event, app) {
    app.use(xXssProtection);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header
is emitted on the response, not consumed from the request.

## Configuration

No tunable options. The plugin emits a single fixed header value
(`X-XSS-Protection: 0`). Registering opts in; not registering opts
out.

A `settings.json > xXssProtection` slot is reserved for future fields
(e.g. per-route opt-out); leaving it empty `{}` keeps the default
behaviour.

```jsonc
{
  "xXssProtection": {}
}
```

There is no `value` field — the only behaviour is to emit `0`.

## Why not other values?

The `X-XSS-Protection` header historically accepted other values
(`1`, `1; mode=block`, `1; report=<uri>`). gina (matching helmet)
deliberately does NOT support those — the auditor mechanism is
unsafe regardless of mode. If you need a working XSS defense, use
the `Content-Security-Policy` (`#HDR5`) plugin with a strong policy
(in particular, ban `'unsafe-inline'` in `script-src`).

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| Plugin not registered                                    | Header not emitted; legacy Chrome pre-v78 may run the auditor (potential exfiltration risk on vulnerable pages) |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| Browser predates X-XSS-Protection (very old browsers)    | Header ignored silently — harmless                   |

The idempotent behaviour makes the plugin safe to register more than
once — the first writer wins. If an upstream middleware accidentally
emits `X-XSS-Protection: 1` (the unsafe enable mode), this plugin
will NOT override it; you'd need to remove the upstream middleware or
mount this plugin BEFORE the upstream one.
