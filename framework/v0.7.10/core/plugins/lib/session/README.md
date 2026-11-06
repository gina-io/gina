# Session Plugin (#CSRF1)

Thin, opt-in wrapper around `express-session` that injects safe cookie
defaults before the middleware sees them.

## Why

`express-session` ships `HttpOnly: true`, `Secure: false`, no `SameSite`.
That is fine for local development but leaves production bundles exposed
to drive-by CSRF on older browsers that don't apply `SameSite=Lax`
automatically. Patching the `Set-Cookie` header after the fact is unsafe:
a bundle that intentionally set `httpOnly: false` to let client-side JS
read the session cookie looks identical to one that simply forgot the
flag. We can't tell them apart at the HTTP layer, and silent overrides
are regressions waiting to happen.

Instead, this plugin wraps the `session(options)` factory. Defaults come
from `settings.json > session.cookie.*`. Anything the bundle passes in
`options.cookie` overrides the default — intentional choices always win.

## Adoption

One-line swap in the bundle bootstrap (`bundles/<name>/index.js`):

```js
// Before
// var session = require('express-session');

// After
var session = require('gina').plugins.Session(require('express-session'));
```

No other changes. `session(options)` behaves exactly as before, but the
`cookie` object is merged with the framework defaults.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "session": {
    "cookie": {
      "sameSite": "lax",   // "lax" | "strict" | "none"  — default "lax"
      "httpOnly": true,    // default true
      "secure":   "auto"   // true | false | "auto"      — default "auto"
    }
  }
}
```

- `sameSite` — `"lax"` covers the common drive-by CSRF case. `"strict"`
  also blocks cross-origin navigation (e.g. click-through from an email
  link), which can break login flows. `"none"` permits cross-site
  sending and **requires** `secure: true`.
- `httpOnly` — `true` prevents `document.cookie` from reading the
  cookie. Set to `false` only when client-side JS has to read it
  (e.g. a custom validator or toolbar).
- `secure` — `"auto"` is express-session's idiom for "match the request
  security flag", typically paired with `app.set('trust proxy', 1)`.

## Browser-parity invariant

A cookie with `SameSite=None` without `Secure` is rejected by every
modern browser. The plugin refuses to start with that combination:

```
[gina session] invariant violation: SameSite=None cookies require
Secure=true (browser-parity). …
```

Set `secure: true` explicitly when you need `sameSite: "none"`.

## Interaction with `SessionStore`

`SessionStore` still receives the `express-session` module reference the
same way — `SessionStore` reads `session.name` and returns a backend
Store class. The plugin wraps only the `session()` factory; the Store
plumbing is untouched.

```js
var expressSession = require('express-session');
var session        = require('gina').plugins.Session(expressSession);
var StoreClass     = lib.SessionStore(expressSession); // unchanged
app.use(session({ store: new StoreClass({ /* … */ }), /* … */ }));
```
