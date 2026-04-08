var fs          = require('fs');
var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * @module gina/lib/cmd/bundle/openapi
 */
/**
 * Generates an OpenAPI 3.1.0 specification from routing.json for one or more
 * bundles in a project.  The spec is written to each bundle's config directory
 * as `openapi.json` by default, or to a custom path via `--output`.
 *
 * Usage:
 *  gina bundle:openapi <bundle_name> @<project_name>
 *  gina bundle:openapi @<project_name>                       (all bundles)
 *  gina bundle:openapi <bundle_name> @<project_name> --output=/tmp/spec.json
 *
 * @class OpenAPI
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function OpenAPI(opt, cmd) {
    var self = {};

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if ( typeof(self.projects[self.projectName]) == 'undefined' || typeof(self.projects[self.projectName].path) == 'undefined' ) {
            return end( new Error('project path not defined in ~/.gina/projects.json for [ '+ self.projectName + ' ]') );
        }

        if (!isDefined('project', self.projectName)) {
            return end( new Error('Missing argument @<project_name>') );
        }

        if (!self.bundles.length) {
            return end( new Error('No bundle found in your project `'+ self.projectName +'`') );
        }

        generateSpecs();
    };


    /**
     * Iterates every requested bundle and emits an OpenAPI spec for each.
     *
     * @private
     */
    var generateSpecs = function() {

        var manifest    = self.projectData
            , bundles   = self.bundles
            , outputArg = self.params['output'] || null
        ;

        for (var b = 0, len = bundles.length; b < len; b++) {
            var bundle      = bundles[b]
                , bundleSrc = manifest.bundles[bundle].src
                , srcPath   = _(self.projects[self.projectName].path + '/' + bundleSrc, true)
                , routingPath   = _(srcPath + '/config/routing.json', true)
                , settingsPath  = _(srcPath + '/config/settings.json', true)
            ;

            if ( !fs.existsSync(routingPath) ) {
                console.warn('[ '+ bundle +' ] routing.json not found at '+ routingPath +' — skipping');
                continue;
            }

            // Clear require cache to pick up latest edits
            if ( typeof(require.cache[routingPath]) != 'undefined' ) {
                delete require.cache[require.resolve(routingPath)];
            }

            var routing = null;
            try {
                routing = require(routingPath);
            } catch(parseErr) {
                return end( new Error('Failed to parse routing.json for bundle [ '+ bundle +' ]: '+ parseErr.message) );
            }

            // Optional: read settings.json for region info
            var settings = null;
            if ( fs.existsSync(settingsPath) ) {
                if ( typeof(require.cache[settingsPath]) != 'undefined' ) {
                    delete require.cache[require.resolve(settingsPath)];
                }
                try { settings = require(settingsPath) } catch(e) { /* ignore */ }
            }

            // Resolve port info for the server URL
            var portInfo = resolvePortInfo(bundle);

            var spec = buildSpec(bundle, routing, settings, portInfo);

            var outputPath = outputArg
                ? _(outputArg, true)
                : _(srcPath + '/config/openapi.json', true);

            try {
                fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
            } catch(writeErr) {
                return end( new Error('Failed to write '+ outputPath +': '+ writeErr.message) );
            }

            console.log('[ '+ bundle +' ] OpenAPI spec written to '+ outputPath);
        }

        end();
    };


    /**
     * Resolves port and scheme info for a bundle from the ports registry.
     *
     * @private
     * @param {string} bundle
     * @returns {{ port: number|null, scheme: string, protocol: string }}
     */
    var resolvePortInfo = function(bundle) {
        var result = { port: null, scheme: 'http', protocol: 'http/1.1' };
        var key = bundle + '@' + self.projectName;

        if ( typeof(self.portsReverseData) != 'undefined' && typeof(self.portsReverseData[key]) != 'undefined' ) {
            var entry = self.portsReverseData[key];
            result.port     = entry.port || null;
            result.scheme   = entry.scheme || 'http';
            result.protocol = entry.protocol || 'http/1.1';
        }

        return result;
    };


    /**
     * Builds an OpenAPI 3.1.0 specification object from a parsed routing.json.
     *
     * @private
     * @param {string} bundle - Bundle name
     * @param {object} routing - Parsed routing.json
     * @param {object|null} settings - Parsed settings.json (may be null)
     * @param {{ port: number|null, scheme: string, protocol: string }} portInfo
     * @returns {object} OpenAPI spec
     */
    var buildSpec = function(bundle, routing, settings, portInfo) {

        var spec = {
            openapi: '3.1.0',
            info: {
                title: bundle + ' API',
                version: self.projectData.bundles[bundle].version || '0.0.1',
                description: 'OpenAPI specification for the ' + bundle + ' bundle, generated from routing.json.'
            },
            servers: [],
            paths: {},
            tags: []
        };

        // Build server URL
        var serverUrl = portInfo.scheme + '://localhost';
        if (portInfo.port) {
            serverUrl += ':' + portInfo.port;
        }
        spec.servers.push({
            url: serverUrl,
            description: 'Local development server'
        });

        var tagSet = {};

        for (var routeName in routing) {
            if ( !routing.hasOwnProperty(routeName) ) continue;

            var route = routing[routeName];

            // Skip non-route entries
            if ( typeof(route) !== 'object' || route === null ) continue;

            // Skip $schema
            if ( routeName === '$schema' ) continue;

            // Parse URL(s)
            var urls = parseUrls(route.url || '/' + routeName);

            // Parse methods
            var methods = parseMethods(route.method);

            // Extract parameters from URL pattern + requirements
            var namespace = route.namespace || null;

            // Collect tag
            if (namespace) {
                if ( !tagSet[namespace] ) {
                    tagSet[namespace] = true;
                    spec.tags.push({ name: namespace });
                }
            }

            // Build an operation for each URL pattern x method combination
            for (var u = 0; u < urls.length; u++) {
                var urlInfo = urls[u];
                var oaPath  = urlInfo.openApiPath;

                if ( typeof(spec.paths[oaPath]) == 'undefined' ) {
                    spec.paths[oaPath] = {};
                }

                for (var m = 0; m < methods.length; m++) {
                    var method = methods[m];

                    // Avoid overwriting if the same path+method already exists
                    if ( typeof(spec.paths[oaPath][method]) != 'undefined' ) continue;

                    var operation = buildOperation(routeName, route, urlInfo.params, namespace, methods.length > 1);

                    spec.paths[oaPath][method] = operation;
                }
            }
        }

        // Remove tags array if empty
        if ( !spec.tags.length ) {
            delete spec.tags;
        }

        return spec;
    };


    /**
     * Parses a `url` field (string, comma-separated string, or array) into
     * an array of { openApiPath, params } objects.
     *
     * @private
     * @param {string|string[]} raw
     * @returns {{ openApiPath: string, params: string[] }[]}
     */
    var parseUrls = function(raw) {
        var patterns = [];

        if ( Array.isArray(raw) ) {
            patterns = raw;
        } else if ( typeof(raw) === 'string' ) {
            // Comma-separated URLs
            patterns = raw.split(',');
        }

        var results = [];
        for (var i = 0; i < patterns.length; i++) {
            var p = patterns[i].trim();
            if (!p) continue;

            var params = [];
            // Convert :param to {param} and collect parameter names
            var oaPath = p.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, function(match, name) {
                params.push(name);
                return '{' + name + '}';
            });

            // Normalise trailing slashes — OpenAPI paths should not have trailing slash
            // except for root "/"
            if (oaPath.length > 1 && oaPath.charAt(oaPath.length - 1) === '/') {
                oaPath = oaPath.slice(0, -1);
            }

            results.push({ openApiPath: oaPath, params: params });
        }

        return results;
    };


    /**
     * Parses the `method` field into an array of lowercase HTTP method strings.
     *
     * @private
     * @param {string} [raw]
     * @returns {string[]}
     */
    var parseMethods = function(raw) {
        if ( !raw || typeof(raw) !== 'string' ) return ['get'];

        return raw.split(',').map(function(m) {
            return m.trim().toLowerCase();
        }).filter(function(m) {
            return m.length > 0;
        });
    };


    /**
     * Builds a single OpenAPI operation object for a route.
     *
     * @private
     * @param {string} routeName - The route key in routing.json
     * @param {object} route - The route definition
     * @param {string[]} urlParams - Parameter names extracted from the URL pattern
     * @param {string|null} namespace - Controller namespace (used as tag)
     * @param {boolean} multiMethod - True when the route has multiple HTTP methods
     * @returns {object} OpenAPI operation object
     */
    var buildOperation = function(routeName, route, urlParams, namespace, multiMethod) {
        var param   = route.param || {};
        var reqs    = route.requirements || {};

        // operationId: namespace + control, or routeName as fallback
        var operationId = param.control || routeName;
        if (namespace && param.control) {
            operationId = namespace + '.' + param.control;
        }

        var operation = {
            operationId: operationId,
            responses: {}
        };

        // Summary from param.title or humanised route name
        if (param.title) {
            operation.summary = param.title;
        } else {
            operation.summary = humanise(routeName);
        }

        // Description from _comment
        if (route._comment) {
            operation.description = route._comment;
        }

        // Tags from namespace
        if (namespace) {
            operation.tags = [namespace];
        }

        // Parameters from URL segments
        if (urlParams.length > 0) {
            operation.parameters = [];
            for (var i = 0; i < urlParams.length; i++) {
                var pName = urlParams[i];
                var paramObj = {
                    name: pName,
                    in: 'path',
                    required: true,
                    schema: { type: 'string' }
                };

                // Apply requirement as pattern
                if ( typeof(reqs[pName]) !== 'undefined' ) {
                    var pattern = requirementToPattern(reqs[pName]);
                    if (pattern.type === 'pattern') {
                        paramObj.schema.pattern = pattern.value;
                    } else if (pattern.type === 'enum') {
                        paramObj.schema.enum = pattern.value;
                    }
                }

                operation.parameters.push(paramObj);
            }
        }

        // Middleware as extension
        if (route.middleware && route.middleware.length) {
            operation['x-middleware'] = route.middleware;
        }

        // Scopes as extension
        if (route.scopes && route.scopes.length) {
            operation['x-scopes'] = route.scopes;
        }

        // Sample URL as extension
        if (route._sample) {
            operation['x-sample-url'] = route._sample;
        }

        // Responses
        if (param.control === 'redirect') {
            var code = String(param.code || 301);
            operation.responses[code] = {
                description: 'Redirect to ' + (param.path || 'target URL')
            };
            if (param.path) {
                operation.responses[code].headers = {
                    Location: {
                        schema: { type: 'string' },
                        description: param.path
                    }
                };
            }
        } else {
            operation.responses['200'] = {
                description: 'Successful response'
            };

            // Add Cache-Control header hint when cache is configured
            if (route.cache) {
                var cacheHeader = buildCacheHeader(route.cache);
                if (cacheHeader) {
                    operation.responses['200'].headers = {
                        'Cache-Control': {
                            schema: { type: 'string' },
                            description: cacheHeader
                        }
                    };
                }
            }
        }

        return operation;
    };


    /**
     * Converts a routing.json `requirements` value to an OpenAPI-friendly
     * pattern or enum descriptor.
     *
     * @private
     * @param {string} raw - Requirement string (regex or pipe-separated alternatives)
     * @returns {{ type: string, value: * }}
     */
    var requirementToPattern = function(raw) {
        if ( typeof(raw) !== 'string' ) return { type: 'pattern', value: '.*' };

        // Validator references — pass through as extension-level info
        if ( raw.indexOf('validator::') === 0 ) {
            return { type: 'pattern', value: '.*' };
        }

        // Regex pattern: starts with "/"
        if ( raw.charAt(0) === '/' ) {
            // Strip leading "/" and trailing "/flags"
            var lastSlash = raw.lastIndexOf('/');
            if (lastSlash > 0) {
                return { type: 'pattern', value: raw.substring(1, lastSlash) };
            }
            return { type: 'pattern', value: raw.substring(1) };
        }

        // Simple pipe-separated alternatives → enum
        if ( raw.indexOf('|') !== -1 && !/[\\()\[\]{}^$.*+?]/.test(raw.replace(/\|/g, '')) ) {
            return { type: 'enum', value: raw.split('|') };
        }

        // Regex without delimiters (parenthesised groups, anchors, etc.)
        // Strip wrapping parens for cleaner pattern
        var cleaned = raw;
        if (cleaned.charAt(0) === '(' && cleaned.charAt(cleaned.length - 1) === ')') {
            cleaned = cleaned.substring(1, cleaned.length - 1);
        }

        return { type: 'pattern', value: cleaned };
    };


    /**
     * Builds a human-readable Cache-Control header description from a cache config.
     *
     * @private
     * @param {string|object} cache
     * @returns {string|null}
     */
    var buildCacheHeader = function(cache) {
        if ( typeof(cache) === 'string' ) {
            return 'private, cached (' + cache + ')';
        }
        if ( typeof(cache) === 'object' ) {
            var parts = [];
            parts.push(cache.visibility || 'private');
            if ( typeof(cache.ttl) !== 'undefined' ) {
                parts.push('max-age=' + cache.ttl);
            }
            return parts.join(', ');
        }
        return null;
    };


    /**
     * Converts a hyphenated route name to a human-readable title.
     * e.g. "user-get-profile" → "User get profile"
     *
     * @private
     * @param {string} name
     * @returns {string}
     */
    var humanise = function(name) {
        var words = name.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
        return words.charAt(0).toUpperCase() + words.slice(1);
    };


    var end = function(output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1 : 0 );
    };

    init();
}

module.exports = OpenAPI;
