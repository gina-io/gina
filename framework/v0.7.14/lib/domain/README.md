# Domain Helper

Get the root domain from a URL or hostname. Supports SLDs (Second Level Domains).
Works in both Node.js and the browser.

Backed by the [`psl`](https://www.npmjs.com/package/psl) npm package (MIT),
which ships the [Public Suffix List](https://publicsuffix.org/) as compiled data —
no `.dat` fetch, no network access required at runtime.

### Backend

```js
var Domain = require('lib/domain');
var getRootDomain = new Domain().getRootDomain;

console.log( getRootDomain('https://camtel.cm/').value )
// => camtel.cm

console.log( getRootDomain('http://google.co.jp/').value )
// => google.co.jp

console.log( getRootDomain('ftp://localhost.localdomain:21/').value )
// => localhost.localdomain
```

### Frontend

Loaded via RequireJS as part of the Gina asset bundle — no separate inclusion
needed. The wrapper resolves `vendor/gina/psl` (the vendored psl UMD) at module-
load time.

```js
define(['lib/domain'], function (Domain) {
    new Domain(function (err, instance) {
        var rootDomain = instance.getRootDomain(window.location.hostname).value;
    });
});
```

The callback form (`new Domain(cb)`) is preserved for API compatibility with
pre-psl versions of the library; `psl` resolves synchronously, so the callback
fires on the next tick.

## License
[MIT](./LICENSE)
