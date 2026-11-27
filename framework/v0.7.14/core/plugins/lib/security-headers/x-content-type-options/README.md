# X-Content-Type-Options Plugin (#HDR1)

Opt-in middleware that sets the `X-Content-Type-Options: nosniff`
response header on every response.

## Why

Older browsers (and some modern browsers in compatibility modes) will
guess the actual content type of a response when the declared
`Content-Type` looks generic or wrong. A response declared `text/plain`
whose body starts with `<script>` can end up parsed as HTML and the
script executed in the page's origin — a "content sniffing" XSS vector.

The `X-Content-Type-Options: nosniff` header instructs the browser to
trust the declared `Content-Type` strictly. It is a defensive header
with no behavioural side effects on responses whose Content-Type is
already correct.

Per RFC 7034 and the WHATWG Fetch Standard, `nosniff` is the only valid
value. There is no `enabled` flag in the configuration surface —
register the plugin to opt in; do not register to opt out.

## Adoption

One block in the bundle bootstrap (`bundles/<name>/index.js`):

```js
var myapp               = require('gina');
var xContentTypeOptions = require('gina').plugins.XContentTypeOptions();

myapp.onInitialize(function(event, app) {
    app.use(xContentTypeOptions);
    event.emit('complete', app);
});
```

Order with other gina security plugins does not matter — the header is
emitted on the response, not consumed from the request.

## Configuration

In `bundles/<name>/config/settings.json`:

```jsonc
{
  "xContentTypeOptions": {}
}
```

The block is reserved for future use (e.g. per-route opt-out). Today the
plugin has no tunable options — the only valid header value is
`nosniff`, and the header is unconditionally emitted on every response
the middleware sees.

## Failure modes

| Condition                                                | Outcome                                  |
|----------------------------------------------------------|------------------------------------------|
| Plugin not registered                                    | Header not emitted; browser may sniff    |
| Header already set by an earlier middleware              | Existing value preserved (idempotent)    |
| Response already sent (`res.headersSent === true`)       | Node's `setHeader` no-ops; request resumes |

The idempotent behaviour makes the plugin safe to register more than
once or alongside another middleware that emits the same header (e.g. a
generic helmet-style upstream gate) — the first writer wins.
