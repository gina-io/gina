// Deprecated
function Url(env, routes) {
    var self = this;

    var init = function() {
        self.base = '';
        self.routes = JSON.clone(routes);

        if (typeof(env.fqdn) != 'undefined' && env.fqdn != null) {
            self.base = (/^http:\/\//.test(env.fqdn)) ? env.fqdn : 'http://'+env.fqdn
        } else if (typeof(env.host) != 'undefined' && env.host != null && typeof(env.port) != 'undefined' && env.port != null) {
            var portList = Object.keys(env.port);
            self.base = portList[0]+'://'+env.host;
            self.base = self.base + ':' + env.port[portList[0]]
        }
    }

    // ON going, will return full url.
    url = function(route, args) {
        return self.base+path(route, args)
    }

    // Give route + arguments, Return url filled with argument.
    path = function(route, args) {
        var url = 'undefined';

        // If the route exists.
        if (routeValidation(route)) {
            // If there are no arguments with url or first url in the array.
            if (url != null && (args == null || Object.keys(args).length == 0)) {
                if (typeof(self.routes[route].url) == 'object') {
                    url = self.routes[route].url[0]
                } else if (typeof(self.routes[route].url) == 'string') {
                    url = self.routes[route].url
                }
            } else {
                // If there are arguments, check if they are valid.
                argumentsValidation(route, args);

                // Check if there is an array of URL.
                if (typeof(self.routes[route].url) == 'object') {
                    var countBest = -1;
                    var i = 0;
                    var tmpUrl;

                    // Create url with url + arguments for each url in the array.
                    for (; i < self.routes[route].url.length; ++i) {
                        tmpUrl = createURL(self.routes[route].url[i], self.routes[route].param, args);
                        // Check which url use the more argument in the url (no get, only parameter).
                        if (tmpUrl.count > countBest) {
                            countBest = tmpUrl.count;
                            url = tmpUrl.url
                        }
                    }
                } else if (typeof(self.routes[route].url) == 'string') {
                    // Just return create url with url + arguments.
                    url = createURL(self.routes[route].url, self.routes[route].param, args).url
                }
            }
        }

        return url
    }

    // Create a new URL filled with arguments (parameter or get).
    var createURL = function(url, param, args) {
        var index;
        var name;
        var urlArgs = '?';

        var i;
        var oldCount;
        var arrayUrl = url.split('/');

        var res = {
            url : '',
            count : 0
        };

        // For each arguments.
        for (index in args) {
            // Create the name, :argument or name from param in routing.
            name = (typeof(param[index]) != 'undefined') ? param[index] : ':'+index;
            i = 0;
            // Saving count each iteration.
            oldCount = res.count;
            for (; i < arrayUrl.length; ++i) {
                // If an argument match.
                if (arrayUrl[i] == name) {
                    // Replace data with the argument value.
                    arrayUrl[i] = args[index];
                    ++res.count
                }
            }
            // If equal, the argument was not a param url, add in get request.
            if (oldCount == res.count) {
                urlArgs = urlArgs + index + '=' + args[index] + '&'
            }
        }
        // Remove the last character '?' if empty or '&' if filled.
        urlArgs = urlArgs.slice(0, -1);
        // Create the new url.
        res.url = arrayUrl.join('/');
        // Add get arguments.
        res.url = res.url+urlArgs;

        // Return result.
        return res
    }

    // Check if the route name exists in routing.
    var routeValidation = function(route) {
        return (route != null && self.routes != null && typeof(self.routes[route]) != 'undefined' && self.routes[route] != null)
    }

    // Check if each arguments given has a requirement and check if it is fulfilled.
    var argumentsValidation = function(route, args) {
        var index;

        // There is a requirement for this route.
        if (typeof(self.routes[route].requirements) != 'undefined') {
            // For each arguments.
            for (index in args) {
                // If there is a requirement.
                if (self.routes[route].requirements[index] != null) {
                    // Check if it is fulfilled.
                    var regTest = (new RegExp(self.routes[route].requirements[index]));
                    // If not, replace data with :argument.
                    if (!regTest.test(args[index])) {
                        args[index] = ':' + index
                    }
                }
            }
        }
        return args
    }

    init()
};

module.exports = Url