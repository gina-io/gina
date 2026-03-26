# Domain Helper

Get the root domain from an url. Supports SLD (Second Level Domain).
You can use the script as well for your frontend as for your backend.

### Frontend sample

Load the script from your HTML then from your source

```tty
// You should for production, cache the file in your own website (http://localhost/psl/public_suffix_list.dat)
var pslUrl = "https://publicsuffix.org/list/public_suffix_list.dat";
var getRootDomain = new DomainHelper(pslUrl).getRootDomain;

console.log( getRootDomain("https://camtel.cm/") )
// => camtel.cm

console.log( getRootDomain("http://google.co.jp/") )
// => google.co.jp

console.log( getRootDomain("ftp://localhost.localdomain:21/") )
// => localhost.localdomain
```

### Backend sample
```tty
npm install require('domain-helper')
```

From your source
```tty
var DomainHelper = require('domain-helper')
var getRootDomain = new DomainHelper().getRootDomain;

console.log( getRootDomain("https://camtel.cm/") )
// => camtel.cm

console.log( getRootDomain("http://google.co.jp/") )
// => google.co.jp

console.log( getRootDomain("ftp://localhost.localdomain:21/") )
// => localhost.localdomain
```

## License
[MIT](./LICENSE)