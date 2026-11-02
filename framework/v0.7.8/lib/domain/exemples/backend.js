var myBundle        = require('gina');
// gina lib samples
var lib             = myBundle.lib;
var Domain          = lib.Domain;

var conf        = myBundle.getConfig();
var isProxyHost = getContext('isProxyHost');
var rootDomain = ( /^true$/i.test(isProxyHost) )
    ? process.gina.PROXY_HOST || new Domain().getRootDomain(os.hostname()).value
    : new Domain().getRootDomain(conf.host).value;

// => mydomain.tld