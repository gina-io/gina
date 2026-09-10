var fs          = require('fs');
var CmdHelper   = require('./../helper');
var dto         = lib.dto;
var dtoTypes    = lib.dtoTypes;
var console     = lib.logger;

/**
 * @module gina/lib/cmd/bundle/types
 */
/**
 * Generates TypeScript declarations from a bundle's DTOs (#DTO3) — the fourth projection
 * of a DTO, alongside runtime validation (#DTO2) and the OpenAPI / MCP schemas (#DTO1c).
 * Every `dtos/<Name>.js` factory becomes two exported types, written to
 * `<bundle>/dtos/index.d.ts` by default or to a custom path via `--output`.
 *
 * The sibling of `bundle:openapi` / `bundle:mcp`: same inputs (the bundle's `dtos/`),
 * same offline resolver (`dto.load`), same `--output` flag.
 *
 * A DTO file that FAILS to load aborts the command rather than being skipped — unlike
 * `bundle:openapi`, whose spec still degrades usefully without one. A type surface does
 * not: emitting it minus a broken DTO would quietly ship an incomplete contract. The
 * bundle would refuse to boot on that DTO anyway (`core/server.js` registers them
 * fail-fast), so saying so now is strictly more useful than a warning buried in output.
 *
 * Usage:
 *  gina bundle:types <bundle_name> @<project_name>
 *  gina bundle:types @<project_name>                       (all bundles)
 *  gina bundle:types <bundle_name> @<project_name> --output=/tmp/dtos.d.ts
 *
 * @class Types
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Types(opt, cmd) {
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

        generateTypes();
    };


    /**
     * Iterates every requested bundle and emits its DTO declarations.
     *
     * @private
     */
    var generateTypes = function() {

        var manifest    = self.projectData
            , bundles   = self.bundles
            , outputArg = self.params['output'] || null
        ;

        for (var b = 0, len = bundles.length; b < len; b++) {
            var bundle      = bundles[b]
                , bundleSrc = manifest.bundles[bundle].src
                , srcPath   = _(self.projects[self.projectName].path + '/' + bundleSrc, true)
                , dtosPath  = _(srcPath + '/dtos', true)
            ;

            if ( !fs.existsSync(dtosPath) ) {
                console.warn('[ '+ bundle +' ] no dtos/ directory at '+ dtosPath +' — skipping');
                continue;
            }

            // Sorted: readdir order is filesystem-dependent, and the emitted artifact must
            // be byte-stable across machines (it is drift-checked).
            var names = null;
            try {
                names = fs.readdirSync(dtosPath)
                    .filter(function(f) { return /\.js$/.test(f) })
                    .map(function(f) { return f.replace(/\.js$/, '') })
                    .sort();
            } catch (readErr) {
                return end( new Error('Failed to read '+ dtosPath +': '+ readErr.message) );
            }

            if ( !names.length ) {
                console.warn('[ '+ bundle +' ] dtos/ carries no DTO — skipping');
                continue;
            }

            var dtos = [];
            for (var n = 0, nLen = names.length; n < nLen; n++) {
                var d = null;
                try {
                    d = dto.load(srcPath, names[n]);
                } catch (loadErr) {
                    return end( new Error('[ '+ bundle +' ] DTO `'+ names[n] +'` failed to load: '+ loadErr.message) );
                }
                if ( !d ) {
                    console.warn('[ '+ bundle +' ] dtos/'+ names[n] +'.js does not export a DTO factory — skipping');
                    continue;
                }
                dtos.push(d);
            }

            if ( !dtos.length ) {
                console.warn('[ '+ bundle +' ] no DTO resolved from dtos/ — skipping');
                continue;
            }

            var source = null;
            try {
                source = dtoTypes.emit(dtos, { bundle: bundle });
            } catch (emitErr) {
                return end( new Error('[ '+ bundle +' ] could not emit DTO types: '+ emitErr.message) );
            }

            var outputPath = outputArg
                ? _(outputArg, true)
                : _(dtosPath + '/index.d.ts', true);

            try {
                fs.writeFileSync(outputPath, source, 'utf8');
            } catch(writeErr) {
                return end( new Error('Failed to write '+ outputPath +': '+ writeErr.message) );
            }

            console.log('[ '+ bundle +' ] DTO types ('+ dtos.length +') written to '+ outputPath);
        }

        end();
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

module.exports = Types;
