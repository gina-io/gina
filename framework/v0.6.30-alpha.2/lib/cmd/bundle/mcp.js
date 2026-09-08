var fs          = require('fs');
var CmdHelper   = require('./../helper');
var introspect  = lib.routingIntrospect;
var dto         = lib.dto;
var console     = lib.logger;

/**
 * @module gina/lib/cmd/bundle/mcp
 */
/**
 * Generates a Model Context Protocol (MCP) tool manifest from `routing.json`
 * for one or more bundles in a project. The manifest is written to each
 * bundle's config directory as `mcp.json` by default, or to a custom path via
 * `--output`.
 *
 * The emitted file targets MCP specification revision `2025-06-18` and is a
 * static manifest — it is NOT a runtime MCP server. The file is intended to
 * be consumed directly by agent tooling, or wrapped later by an MCP server
 * implementation (#AI8b) that translates `tools/call` requests into Gina
 * controller dispatches.
 *
 * Usage:
 *  gina bundle:mcp <bundle_name> @<project_name>
 *  gina bundle:mcp @<project_name>                       (all bundles)
 *  gina bundle:mcp <bundle_name> @<project_name> --output=/tmp/mcp.json
 *
 * Source-of-truth is `routing.json`, not `openapi.json` — the two commands
 * are independent. Both call into `lib.routingIntrospect` for the URL and
 * parameter parsing primitives.
 *
 * @class MCP
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function MCP(opt, cmd) {
    var self = {};

    var MCP_PROTOCOL_VERSION = '2025-06-18';

    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

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

        generateManifests();
    };


    /**
     * Iterates every requested bundle and emits an MCP tool manifest for each.
     *
     * @private
     */
    var generateManifests = function() {

        var manifest    = self.projectData
            , bundles   = self.bundles
            , outputArg = self.params['output'] || null
            , bundleNames = {}
        ;

        for (var b = 0; b < bundles.length; b++) {
            bundleNames[bundles[b]] = true;
        }

        for (var b = 0, len = bundles.length; b < len; b++) {
            var bundle      = bundles[b]
                , bundleSrc = manifest.bundles[bundle].src
                , srcPath   = _(self.projects[self.projectName].path + '/' + bundleSrc, true)
                , routingPath   = _(srcPath + '/config/routing.json', true)
            ;

            if ( !fs.existsSync(routingPath) ) {
                console.warn('[ '+ bundle +' ] routing.json not found at '+ routingPath +' — skipping');
                continue;
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

            var portInfo = resolvePortInfo(bundle);

            var tools = buildTools(bundle, routing, bundleNames, srcPath);

            var doc = {
                '$schema': 'https://modelcontextprotocol.io/specification/' + MCP_PROTOCOL_VERSION + '/schema/',
                protocolVersion: MCP_PROTOCOL_VERSION,
                generatedBy: 'gina bundle:mcp',
                generatedAt: new Date().toISOString(),
                server: {
                    name: bundle,
                    version: self.projectData.bundles[bundle].version || '0.0.1',
                    description: 'MCP tool manifest for the ' + bundle + ' bundle, generated from routing.json.',
                    baseUrl: buildBaseUrl(portInfo)
                },
                capabilities: {
                    tools: {}
                },
                tools: tools
            };

            var outputPath = outputArg
                ? _(outputArg, true)
                : _(srcPath + '/config/mcp.json', true);

            try {
                fs.writeFileSync(outputPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
            } catch(writeErr) {
                return end( new Error('Failed to write '+ outputPath +': '+ writeErr.message) );
            }

            console.log('[ '+ bundle +' ] MCP manifest written to '+ outputPath +' ('+ tools.length +' tool'+ (tools.length === 1 ? '' : 's') +')');
        }

        end();
    };


    /**
     * Resolves port and scheme info for a bundle from the ports registry.
     *
     * @private
     * @param   {string} bundle
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
     * Builds the server baseUrl string shown in the manifest header.
     *
     * @private
     * @param   {{ port: number|null, scheme: string }} portInfo
     * @returns {string}
     */
    var buildBaseUrl = function(portInfo) {
        var url = portInfo.scheme + '://localhost';
        if (portInfo.port) url += ':' + portInfo.port;
        return url;
    };


    /**
     * Walks the routing manifest and produces one MCP Tool object per
     * (route × URL variant × HTTP method) combination.
     *
     * Skip rules:
     * - Framework-internal routes (`/_gina/*`) are excluded.
     * - HEAD / OPTIONS methods are excluded (no agent use case).
     * - Cross-bundle routes (`route.bundle` pointing outside the current
     *   emission set) are warned and skipped.
     *
     * @private
     * @param   {string} bundle
     * @param   {object} routing
     * @param   {object} bundleNames - Set of bundle names in the current emission
     * @param   {string} srcPath - Bundle source dir (resolves `param.dto` files)
     * @returns {object[]}
     */
    var buildTools = function(bundle, routing, bundleNames, srcPath) {

        var tools = [];
        var seenNames = {};

        introspect.eachRoute(routing, function(routeName, route) {

            if ( introspect.isFrameworkInternal(route) ) return;

            if ( route.bundle && typeof(bundleNames[route.bundle]) === 'undefined' ) {
                console.warn('[ '+ bundle +' ] route `'+ routeName +'` proxies to bundle `'+ route.bundle +'` which is not in the current emission — skipping');
                return;
            }

            var urls      = introspect.parseUrls(route.url || '/' + routeName);
            var methods   = introspect.parseMethods(route.method).filter(function(m) {
                return m !== 'head' && m !== 'options';
            });

            if ( !methods.length || !urls.length ) return;

            var baseName = introspect.toolName(routeName, route);

            for (var u = 0; u < urls.length; u++) {
                var urlInfo = urls[u];

                for (var m = 0; m < methods.length; m++) {
                    var method = methods[m];

                    var toolId = baseName;

                    // Suffix by method when the route accepts multiple verbs
                    if (methods.length > 1) {
                        toolId += '#' + method;
                    }

                    // Suffix by URL variant when the route declares multiple URL forms
                    if (urls.length > 1) {
                        toolId += '#' + (u + 1);
                    }

                    // Final uniqueness guard in case two routes collapse to the same id
                    var finalId = toolId;
                    var n = 2;
                    while ( seenNames[finalId] ) {
                        finalId = toolId + '#' + n;
                        n++;
                    }
                    seenNames[finalId] = true;

                    tools.push(buildTool(finalId, routeName, route, urlInfo, method, srcPath));
                }
            }
        });

        return tools;
    };


    /**
     * Builds a single MCP Tool object for one (route × URL × method) tuple.
     *
     * @private
     * @param   {string} toolId - Unique tool identifier within this manifest
     * @param   {string} routeName
     * @param   {object} route
     * @param   {{ openApiPath: string, mcpPath: string, params: string[] }} urlInfo
     * @param   {string} method - Lowercase HTTP method
     * @param   {string} srcPath - Bundle source dir (resolves `param.dto` files)
     * @returns {object} MCP Tool (2025-06-18 shape)
     */
    var buildTool = function(toolId, routeName, route, urlInfo, method, srcPath) {

        var param = route.param || {};
        var reqs  = route.requirements || {};

        var tool = {
            name: toolId,
            title: param.title || introspect.humanise(routeName),
            description: buildDescription(routeName, route, urlInfo, method),
            inputSchema: buildInputSchema(urlInfo.params, reqs, method, param, srcPath),
            annotations: buildAnnotations(route, method),
            _meta: buildMeta(routeName, route, urlInfo, method)
        };

        // Output schema from a declared response DTO (`param.responseDto`). The
        // runtime MCP server passes `outputSchema` through to tools/list unchanged.
        // `dropExcluded` — `.exclude()`d fields never reach the wire, so the tool
        // must not advertise them (#B110); the request-side inputSchema keeps them.
        if ( param.responseDto ) {
            var respDto = null;
            try {
                respDto = dto.load(srcPath, param.responseDto);
            } catch (respErr) {
                console.warn('[ '+ routeName +' ] response DTO `'+ param.responseDto +'` failed to load — omitting outputSchema: '+ respErr.message);
            }
            if ( respDto ) {
                tool.outputSchema = respDto.toJsonSchema('draft-07', { dropExcluded: true });
            }
        }

        return tool;
    };


    /**
     * Builds the human-oriented `description` field. Hosts often truncate,
     * so we keep it to one line: HTTP method + URL + optional _comment.
     *
     * @private
     * @param   {string} routeName
     * @param   {object} route
     * @param   {{ mcpPath: string }} urlInfo
     * @param   {string} method
     * @returns {string}
     */
    var buildDescription = function(routeName, route, urlInfo, method) {
        var parts = [method.toUpperCase() + ' ' + urlInfo.mcpPath];
        if (route._comment) {
            parts.push('— ' + String(route._comment).replace(/\s+/g, ' ').trim());
        }
        return parts.join(' ');
    };


    /**
     * Builds the `inputSchema` for a tool. Always a Draft-07 JSON Schema with
     * `type: "object"`. URL path params are required strings constrained by
     * the route's `requirements` (an inline `validator::` requirement is un-collapsed
     * into a real schema fragment). For non-GET methods the `body` property is the
     * declared `param.dto`'s schema when present, else a lenient `object` placeholder.
     *
     * @private
     * @param   {string[]} urlParams
     * @param   {object}   reqs - route.requirements
     * @param   {string}   method
     * @param   {object}   [param] - route.param (reads `param.dto` for the body)
     * @param   {string}   [srcPath] - Bundle source dir (resolves the DTO file)
     * @returns {object}
     */
    var buildInputSchema = function(urlParams, reqs, method, param, srcPath) {

        var schema = {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: true
        };

        for (var i = 0; i < urlParams.length; i++) {
            var name = urlParams[i];
            var prop = { type: 'string' };

            if ( typeof(reqs[name]) !== 'undefined' ) {
                var rawReq = reqs[name];
                if ( typeof(rawReq) === 'string' && rawReq.indexOf('validator::') === 0 ) {
                    var frag = introspect.requirementToSchema(rawReq);
                    for (var fk in frag) {
                        if ( frag.hasOwnProperty(fk) ) { prop[fk] = frag[fk]; }
                    }
                } else {
                    var p = introspect.requirementToPattern(rawReq);
                    if (p.type === 'pattern') {
                        prop.pattern = p.value;
                    } else if (p.type === 'enum') {
                        prop.enum = p.value;
                    }
                }
            }

            schema.properties[name] = prop;
            schema.required.push(name);
        }

        if ( method !== 'get' ) {
            var bodyDto = null;
            if ( param && param.dto ) {
                try {
                    bodyDto = dto.load(srcPath, param.dto);
                } catch (dtoErr) {
                    console.warn('request DTO `'+ param.dto +'` failed to load — using a lenient body: '+ dtoErr.message);
                }
            }
            schema.properties.body = bodyDto
                ? bodyDto.toJsonSchema('draft-07')
                : {
                    type: 'object',
                    description: 'Request body. Shape is controller-defined and not described in routing.json.',
                    additionalProperties: true
                };
        }

        if ( !schema.required.length ) {
            delete schema.required;
        }

        return schema;
    };


    /**
     * Builds the MCP `annotations` object. Annotations are hints, not trust
     * boundaries — callers should not gate security decisions on them.
     *
     * @private
     * @param   {object} route
     * @param   {string} method - Lowercase
     * @returns {object}
     */
    var buildAnnotations = function(route, method) {

        var annotations = {};
        var param = route.param || {};

        if (param.control === 'redirect') {
            annotations.readOnlyHint     = false;
            annotations.destructiveHint  = false;
            annotations.idempotentHint   = true;
            annotations.openWorldHint    = true;
        } else if (method === 'get') {
            annotations.readOnlyHint     = true;
            annotations.destructiveHint  = false;
            annotations.idempotentHint   = true;
            annotations.openWorldHint    = true;
        } else if (method === 'delete') {
            annotations.readOnlyHint     = false;
            annotations.destructiveHint  = true;
            annotations.idempotentHint   = true;
            annotations.openWorldHint    = true;
        } else if (method === 'put') {
            annotations.readOnlyHint     = false;
            annotations.destructiveHint  = true;
            annotations.idempotentHint   = true;
            annotations.openWorldHint    = true;
        } else {
            // POST, PATCH, and anything else
            annotations.readOnlyHint     = false;
            annotations.destructiveHint  = true;
            annotations.idempotentHint   = false;
            annotations.openWorldHint    = true;
        }

        return annotations;
    };


    /**
     * Builds the `_meta` object with the `io.gina.*` prefix. Preserves the
     * routing.json fields a runtime MCP server would need to dispatch the
     * call: URL, method, namespace, scopes, cache, middleware, bundle target.
     * Also preserves raw `requirements` so clients can re-validate input.
     *
     * @private
     * @param   {string} routeName
     * @param   {object} route
     * @param   {{ mcpPath: string, openApiPath: string }} urlInfo
     * @param   {string} method
     * @returns {object}
     */
    var buildMeta = function(routeName, route, urlInfo, method) {

        var meta = {
            'io.gina.routeName': routeName,
            'io.gina.url':       urlInfo.mcpPath,
            'io.gina.method':    method.toUpperCase()
        };

        if (route.namespace) meta['io.gina.namespace'] = route.namespace;
        if (route.param && route.param.control) meta['io.gina.control'] = route.param.control;
        if (route._sample) meta['io.gina.sample'] = route._sample;
        if (route.scopes && route.scopes.length) meta['io.gina.scopes'] = route.scopes;
        if (route.middleware && route.middleware.length) meta['io.gina.middleware'] = route.middleware;
        if (route.middlewareIgnored && route.middlewareIgnored.length) meta['io.gina.middlewareIgnored'] = route.middlewareIgnored;
        if (route.bundle) meta['io.gina.bundle'] = route.bundle;
        if (route.hostname) meta['io.gina.hostname'] = route.hostname;
        if (route.cache) meta['io.gina.cache'] = route.cache;
        if (route.requirements && Object.keys(route.requirements).length) {
            meta['io.gina.requirements'] = route.requirements;
        }

        return meta;
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

module.exports = MCP;
