var fs          = require('fs');
var CmdHelper   = require('./../helper');
var introspect  = lib.routingIntrospect;
var dto         = lib.dto;
var console     = lib.logger;

/**
 * @module gina/lib/cmd/bundle/openapi
 */
/**
 * Generates an OpenAPI 3.1.0 specification from routing.json for one or more
 * bundles in a project.  The spec is written to each bundle's config directory
 * as `openapi.json` by default, or to a custom path via `--output`.
 *
 * Gated routes (`param.requireAuth` / `param.roles` / `param.policy`) carry
 * their authorization contract: a `401` response entry (+ a `403` when
 * roles/policy add authorization beyond authentication), and — when
 * machine-caller auth (`settings.json > auth.machine`) is effectively
 * configured — a `components.securitySchemes.bearerAuth` scheme plus a
 * per-operation `security` requirement. Role and policy names are never
 * emitted into the spec.
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

            // requireJSON strips `//` and `/* */` comments that routing.json
            // files routinely carry (e.g. `// bundle needs to be restarted`).
            // Plain `require()` would throw SyntaxError on these.
            var routing = null;
            try {
                routing = requireJSON(routingPath);
            } catch(parseErr) {
                return end( new Error('Failed to parse routing.json for bundle [ '+ bundle +' ]: '+ parseErr.message) );
            }

            // Optional: read settings.json — `auth.machine` drives securitySchemes
            // emission. requireJSON, not a plain require: real settings.json files
            // carry comment lines that would make a plain require throw, silently
            // leaving `settings` null.
            var settings = null;
            if ( fs.existsSync(settingsPath) ) {
                if ( typeof(require.cache[settingsPath]) != 'undefined' ) {
                    delete require.cache[require.resolve(settingsPath)];
                }
                try {
                    settings = requireJSON(settingsPath)
                } catch(e) {
                    // The spec's security emission depends on settings.json —
                    // a parse failure is worth a warning, not a silent null.
                    console.warn('[ '+ bundle +' ] Failed to parse settings.json — emitting spec without securitySchemes: '+ e.message);
                }
            }

            // Resolve port info for the server URL
            var portInfo = resolvePortInfo(bundle);

            var spec = buildSpec(bundle, routing, settings, portInfo, srcPath);

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
     * Tells whether machine-caller authentication (`settings.json > auth.machine`,
     * the #MS3 shape) is effectively configured for the bundle.
     *
     * Mirrors the runtime's fail-closed reading: true only when `enabled` is
     * strictly `true` (the boot lint's boolean rule — a truthy string emits
     * nothing) AND at least one credential source exists: a non-empty `callers`
     * map, or a custom `authenticator` module name.
     *
     * @private
     * @param {object|null} settings - Parsed settings.json (may be null)
     * @returns {boolean} True when the `bearerAuth` scheme should be emitted
     */
    var hasMachineAuth = function(settings) {
        if ( !settings || typeof(settings.auth) != 'object' || settings.auth === null ) {
            return false;
        }
        var machine = settings.auth.machine;
        if ( !machine || typeof(machine) != 'object' ) {
            return false;
        }
        if ( machine.enabled !== true ) {
            return false;
        }

        var hasCallers = ( typeof(machine.callers) == 'object'
                            && machine.callers !== null
                            && Object.keys(machine.callers).length > 0 );
        var hasAuthenticator = ( typeof(machine.authenticator) == 'string'
                            && machine.authenticator !== '' );

        return ( hasCallers || hasAuthenticator );
    };


    /**
     * #COMPLY10 — reads `auth.requireAuthByDefault`, the deny-by-default mode.
     *
     * The published spec has to agree with the runtime, and under this mode an
     * UN-annotated route is gated. Without reading it here the spec would declare
     * those routes unauthenticated while every call to them answers 401 — a
     * published contract that lies about its own security, which is worse than
     * publishing none.
     *
     * Strict `=== true`, matching the boot lint: a truthy string does not enable
     * the mode at runtime, so it must not enable it in the spec either.
     *
     * @private
     * @param {object|null} settings - Parsed settings.json (may be null)
     * @returns {boolean} True when un-annotated routes are gated by default
     */
    var hasRequireAuthByDefault = function(settings) {
        if ( !settings || typeof(settings.auth) != 'object' || settings.auth === null ) {
            return false;
        }
        return ( settings.auth.requireAuthByDefault === true );
    };


    /**
     * Applies the authorization contract to an operation when its route is
     * gated. A route is gated exactly when the runtime authz gate would act:
     * `param.requireAuth === true`, a non-empty `param.roles` array, or a
     * non-empty `param.policy` string (roles/policy imply requireAuth) — or,
     * under #COMPLY10 deny-by-default, when the route declares none of those and
     * is not marked `param.public: true`.
     *
     * Emits the observable contract only: a `401` response on every gated
     * route (+ a `403` when roles/policy add authorization beyond
     * authentication), and — when machine-caller auth is configured — the
     * per-operation `security` requirement referencing the `bearerAuth`
     * scheme. Role and policy names are deliberately never emitted: the
     * runtime keeps them off the wire (generic 403 bodies, client-map
     * stripping), and the published spec follows the same rule.
     *
     * @private
     * @param {object} operation - The OpenAPI operation object (mutated in place)
     * @param {object} param - The route's `param` block (`route.param || {}`)
     * @param {boolean} machineAuth - True when the `bearerAuth` scheme is emitted
     * @param {boolean} defaultDeny - True when `auth.requireAuthByDefault` is on (#COMPLY10)
     * @returns {undefined}
     */
    var applyAuthContract = function(operation, param, machineAuth, defaultDeny) {
        var hasRoles    = ( Array.isArray(param.roles) && param.roles.length > 0 );
        var hasPolicy   = ( typeof(param.policy) == 'string' && param.policy !== '' );
        // #COMPLY10 — under deny-by-default an un-annotated route is gated unless it
        // is explicitly `public`, so the spec must treat it as gated too. Mirrors the
        // gate's own precedence (lib/authz-gate): `public` only ever exempts a route
        // that declares no explicit key, so it can never un-gate an annotated one.
        var byDefault   = ( defaultDeny === true && param.public !== true );
        var isGated     = ( param.requireAuth === true || hasRoles || hasPolicy || byDefault );

        if ( !isGated ) return;

        if (machineAuth) {
            operation.security = [ { bearerAuth: [] } ];
            operation.responses['401'] = {
                description: 'Authentication required'
            };
        } else {
            operation.responses['401'] = {
                description: 'Authentication required — this route needs an authenticated session (cookie name is application-defined)'
            };
        }

        if ( hasRoles || hasPolicy ) {
            operation.responses['403'] = {
                description: 'Forbidden — the caller lacks the required authorization'
            };
        }
    };


    /**
     * Builds an OpenAPI 3.1.0 specification object from a parsed routing.json.
     *
     * @private
     * @param {string} bundle - Bundle name
     * @param {object} routing - Parsed routing.json
     * @param {object|null} settings - Parsed settings.json (may be null; `auth.machine` drives securitySchemes emission)
     * @param {{ port: number|null, scheme: string, protocol: string }} portInfo
     * @param {string} srcPath - Bundle source dir (resolves `param.dto` files)
     * @returns {object} OpenAPI spec
     */
    var buildSpec = function(bundle, routing, settings, portInfo, srcPath) {

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

        // Machine-caller auth (`settings.json > auth.machine`) is the describable
        // credential: `Authorization: Bearer <key>`. The scheme is emitted only
        // when machine auth is effectively configured, so an un-configured
        // bundle's spec gains no components block. The scheme matches the wire's
        // own advertisement — the machine 401 challenges with
        // `WWW-Authenticate: Bearer`.
        var defaultDeny = hasRequireAuthByDefault(settings);
        var machineAuth = hasMachineAuth(settings);
        if (machineAuth) {
            spec.components = {
                securitySchemes: {
                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        description: 'Machine-caller authentication (settings.json > auth.machine): present `Authorization: Bearer <key>` with a configured caller key. A custom authenticator, when configured, may accept additional credential shapes. An authenticated session also satisfies gated routes (session wins).'
                    }
                }
            };
        }

        var tagSet = {};

        introspect.eachRoute(routing, function(routeName, route) {

            var urls      = introspect.parseUrls(route.url || '/' + routeName);
            var methods   = introspect.parseMethods(route.method);
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

                    var operation = buildOperation(routeName, route, urlInfo.params, namespace, methods.length > 1, method, srcPath);

                    // Authorization contract for gated routes
                    applyAuthContract(operation, route.param || {}, machineAuth, defaultDeny);

                    spec.paths[oaPath][method] = operation;
                }
            }
        });

        // Remove tags array if empty
        if ( !spec.tags.length ) {
            delete spec.tags;
        }

        return spec;
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
     * @param {string} method - Lowercase HTTP method (gates `requestBody`)
     * @param {string} srcPath - Bundle source dir (resolves `param.dto` files)
     * @returns {object} OpenAPI operation object
     */
    var buildOperation = function(routeName, route, urlParams, namespace, multiMethod, method, srcPath) {
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
            operation.summary = introspect.humanise(routeName);
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

                // Apply requirement to the param schema. Un-collapse an inline
                // `validator::{...}` rule into a real schema fragment (format/enum/
                // bounds); keep pattern/enum handling for regex + pipe requirements.
                if ( typeof(reqs[pName]) !== 'undefined' ) {
                    var rawReq = reqs[pName];
                    if ( typeof(rawReq) === 'string' && rawReq.indexOf('validator::') === 0 ) {
                        var frag = introspect.requirementToSchema(rawReq);
                        for (var fk in frag) {
                            if ( frag.hasOwnProperty(fk) ) { paramObj.schema[fk] = frag[fk]; }
                        }
                    } else {
                        var pattern = introspect.requirementToPattern(rawReq);
                        if (pattern.type === 'pattern') {
                            paramObj.schema.pattern = pattern.value;
                        } else if (pattern.type === 'enum') {
                            paramObj.schema.enum = pattern.value;
                        }
                    }
                }

                operation.parameters.push(paramObj);
            }
        }

        // Request body from a declared DTO (`param.dto`) on a mutating method. The
        // DTO file resolves to a real JSON Schema (OpenAPI 3.1 == JSON Schema 2020-12),
        // closing the historical "requestBody never generated" gap.
        var reqDto = null;
        if ( param.dto && /^(post|put|patch)$/i.test(method) ) {
            try {
                reqDto = dto.load(srcPath, param.dto);
            } catch (dtoErr) {
                console.warn('[ '+ routeName +' ] request DTO `'+ param.dto +'` failed to load — omitting requestBody: '+ dtoErr.message);
            }
            if ( reqDto ) {
                operation.requestBody = {
                    required: true,
                    content: {
                        'application/json': { schema: reqDto.toJsonSchema('2020-12') }
                    }
                };
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

            // Response body schema from a declared response DTO (`param.responseDto`).
            // `dropExcluded` — the framework strips `.exclude()`d fields from every JSON
            // response before it reaches the wire, so the 200 schema must not advertise
            // them (#B110). Request-side emission above keeps them: the client sends them.
            if ( param.responseDto ) {
                var respDto = null;
                try {
                    respDto = dto.load(srcPath, param.responseDto);
                } catch (respErr) {
                    console.warn('[ '+ routeName +' ] response DTO `'+ param.responseDto +'` failed to load — omitting 200 schema: '+ respErr.message);
                }
                if ( respDto ) {
                    operation.responses['200'].content = {
                        'application/json': { schema: respDto.toJsonSchema('2020-12', { dropExcluded: true }) }
                    };
                }
            }

            // A request DTO implies default-on input validation -> a 422 is possible
            if ( reqDto ) {
                operation.responses['422'] = { description: 'Validation failed' };
            }

            // Add Cache-Control header hint when cache is configured
            if (route.cache) {
                var cacheHeader = introspect.buildCacheHeader(route.cache);
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
