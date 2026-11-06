# X-Download-Options Plugin (#HDR11)

Opt-in middleware that emits the literal header
`X-Download-Options: noopen` on every response. IE-legacy header
designed to prevent Internet Explorer 8+ from opening downloads in
the site's security context.

Part of **Phase 1.5** (helmet-parity gap-fill) of the gina security-
headers track.

## Why

The vulnerability shape (IE-specific): in old IE versions, the "Open"
button on a download dialog opened the file in the security context
of the SITE that served it, rather than the local filesystem. An
attacker could trick a user into "opening" a malicious HTML file
from a trusted site, and the resulting page would inherit the site's
origin — XSS-equivalent from a downloaded file.

`noopen` tells IE to remove the "Open" button entirely, forcing the
user to "Save" the download first. The saved file then opens in the
local-filesystem security context (which has its own protections).

helmet ships `xDownloadOptions` for defense-in-depth against the
vanishingly-rare IE11 holdout — typically an enterprise legacy
intranet that has not upgraded. helmet-parity narrative.

## Browser status in 2026

- **Chrome, Edge, Firefox, Safari** — all ignore the header silently.
- **IE10 / IE11** — honour the header. Both are end-of-life as of
  June 2022.

The header is effectively a no-op in 2026. Ships for defense-in-depth
+ helmet-parity narrative.

## Reference

[MSDN — `X-Download-Options: noopen` for files](https://learn.microsoft.com/previous-versions/windows/internet-explorer/ie-developer/compatibility/jj542450(v=vs.85))

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp            = require('gina');
var xDownloadOptions = require('gina').plugins.XDownloadOptions();

myapp.onInitialize(function(event, app) {
    app.use(xDownloadOptions);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header
is emitted on the response, not consumed from the request.

## Configuration

No tunable options. The plugin emits a single fixed header value
(`X-Download-Options: noopen`). Registering opts in; not registering
opts out.

A `settings.json > xDownloadOptions` slot is reserved for future
fields (e.g. per-route opt-out, particularly for routes that serve
intended-to-be-opened-inline content); leaving it empty `{}` keeps
the default behaviour.

```jsonc
{
  "xDownloadOptions": {}
}
```

`noopen` is the only valid value per the MSDN spec — there is no
"open" or "allow" alternative.

## Failure modes

| Condition                                                | Outcome                                              |
|----------------------------------------------------------|------------------------------------------------------|
| Plugin not registered                                    | Header not emitted; IE10/IE11 use default "Open"-allowed dialog |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)                |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes           |
| Modern browser (Chrome / Firefox / Safari / Edge)        | Header ignored silently — harmless                   |

The idempotent behaviour makes the plugin safe to register more than
once — the first writer wins.
