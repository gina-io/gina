var fs      = require('fs');
var path    = require('path');
var console = lib.logger;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/remove
 */
/**
 * Removes a connector entry from a project's shared or bundle-level
 * `connectors.json`. Positional-absence scoping:
 *
 *   gina connector:rm <name> @<project>           → shared/config/connectors.json
 *   gina connector:rm <name> <bundle> @<project>  → <bundle>/config/connectors.json
 *
 * Project-level removal additionally scans every bundle for usages of the
 * same logical key (inherited from shared, overriding shared, or same
 * driver type) and refuses unless `--force` is passed. The removal never
 * uninstalls the npm driver — siblings may still depend on it.
 *
 * Bundle-level removal only touches the bundle's own file. A separate
 * hint reports which other scopes still reference the same driver so the
 * user can decide whether to keep the driver installed.
 *
 * Leading header comments at the top of an existing `connectors.json`
 * (everything before the first non-comment `{`) are preserved verbatim. Mid-body
 * `//` or `/* * /` comments are lost — the body is rewritten from the
 * parsed object graph. Same caveat as `connector:add`.
 *
 * Flags:
 *   --dry-run        Print what would be removed, do not touch files.
 *                    Includes the sibling-usage hint.
 *   --force          Skip the project-level guard that blocks removal when
 *                    other bundles still reference the logical key.
 *
 * Usage:
 *   gina connector:rm session @myproject
 *   gina connector:rm session api @myproject
 *   gina connector:rm session @myproject --dry-run
 *   gina connector:rm session @myproject --force
 *
 * @class Remove
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Remove(opt, cmd) {
    var self = {};

    /**
     * Allowed `connector` driver types — mirrors the enum in
     * `schema/connectors.json`. Kept in sync with `list.js` and `add.js`
     * by hand.
     *
     * @inner
     * @constant
     * @type {string[]}
     */
    var ALLOWED_CONNECTOR_TYPES = ['couchbase', 'mysql', 'postgresql', 'sqlite', 'redis', 'ai', 'scylladb', 'mongodb', 'duckdb'];

    /**
     * Parse positionals, validate scope, scan for usages, write the
     * updated `connectors.json` (or print the dry-run preview), then
     * print a driver-retention hint.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        var positionals = extractPositionals(process.argv);
        var connectorName = positionals[0] || null;
        var bundleName    = positionals[1] || null;

        if (!connectorName) {
            console.error('Usage: gina connector:rm <name> [<bundle>] @<project> [--dry-run] [--force]');
            process.exit(1);
            return;
        }

        if ( !/^[a-z0-9_\-]+$/i.test(connectorName) ) {
            console.error('Connector name `' + connectorName + '` is not valid. Use [a-zA-Z0-9_-] only.');
            process.exit(1);
            return;
        }

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            console.error('`connector:rm` requires `@<project>`. Did you forget `@<project_name>`?');
            process.exit(1);
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        var projectPath = self.projects[self.projectName].path;
        var manifest    = loadManifest(projectPath);
        if (!manifest || !manifest.bundles) {
            console.error('Cannot read `' + projectPath + '/manifest.json`. Project is missing or malformed.');
            process.exit(1);
            return;
        }

        var target = resolveTarget(projectPath, manifest, bundleName);
        if (!target) return;

        var p       = self.params || {};
        var dryRun  = !!p['dry-run'];
        var force   = !!p['force'];

        var parsed  = readExistingFile(target);
        if (!parsed) return;

        var existing = parsed.data[connectorName];
        if (typeof existing == 'undefined') {
            // Not in the target file. For bundle-level rm, check whether it
            // only lives in shared so we can point at the right command.
            if (bundleName) {
                var sharedPath  = _(projectPath + '/shared/config/connectors.json', true);
                var sharedJson  = readJsonSafe(sharedPath) || {};
                if (typeof sharedJson[connectorName] != 'undefined') {
                    console.error('Connector `' + connectorName + '` is not declared in `' + bundleName + '/config/connectors.json` — it is inherited from shared/config/connectors.json. Use `gina connector:rm ' + connectorName + ' @' + self.projectName + '` to remove it from shared.');
                } else {
                    console.error('Connector `' + connectorName + '` not found in ' + target + '.');
                }
            } else {
                console.error('Connector `' + connectorName + '` not found in ' + target + '.');
            }
            process.exit(1);
            return;
        }

        var removedEntry = existing;
        var driverType   = resolveConnectorType(removedEntry, connectorName);
        var siblings     = scanSiblings(projectPath, manifest, connectorName, driverType, bundleName);

        if (dryRun) {
            printDryRun(target, connectorName, removedEntry, bundleName, siblings);
            process.exit(0);
            return;
        }

        if (!bundleName && siblings.sameKey.length > 0 && !force) {
            console.error(
                'Removing shared connector `' + connectorName + '` would break ' + siblings.sameKey.length + ' bundle(s) that still reference it: ' +
                siblings.sameKey.map(function (s) { return s.bundle + (s.source === 'override' ? ' (override)' : ''); }).join(', ') +
                '. Re-run with --force to remove anyway, or remove from each bundle first.'
            );
            process.exit(1);
            return;
        }

        var out = removeKey(parsed.data, connectorName);
        writeFile(target, parsed.header, out);

        console.log(
            'Removed connector `' + connectorName + '`' +
            (bundleName ? ' from bundle `' + bundleName + '`' : ' from shared scope') +
            ' at ' + target
        );

        var hint = buildDriverRetentionHint(driverType, connectorName, bundleName, siblings);
        if (hint) {
            console.log(hint);
        }

        process.exit(0);
    };

    /**
     * Walks `process.argv` from index 3 and returns every non-flag,
     * non-`@<project>` token in order. Mirrors add.js::extractPositionals.
     *
     * @inner
     * @private
     * @param {string[]} argv - process.argv
     * @returns {string[]}
     */
    var extractPositionals = function (argv) {
        var out = [];
        for (var i = 3, len = argv.length; i < len; i++) {
            var tok = argv[i];
            if ( typeof(tok) != 'string' ) continue;
            if ( /^\-\-/.test(tok) ) continue;
            if ( /^\-/.test(tok)  ) continue;
            if ( /^\@/.test(tok)  ) continue;
            out.push(tok);
        }
        return out;
    };

    /**
     * Loads `<projectPath>/manifest.json` with comment tolerance.
     * Returns null on missing or malformed file.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        try {
            var p = _(projectPath + '/manifest.json', true);
            if ( !fs.existsSync(p) ) return null;
            return requireJSON(p);
        } catch (e) {
            return null;
        }
    };

    /**
     * Resolves the target `connectors.json` path. For bundle-scoped
     * removal, validates the bundle exists in the manifest. Exits on
     * error and returns null.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {object} manifest - Parsed manifest.json
     * @param {string|null} bundleName
     * @returns {string|null}
     */
    var resolveTarget = function (projectPath, manifest, bundleName) {
        if (!bundleName) {
            return _(projectPath + '/shared/config/connectors.json', true);
        }
        if ( !manifest.bundles[bundleName] ) {
            console.error('Bundle [ ' + bundleName + ' ] is not registered inside `@' + self.projectName + '`.');
            process.exit(1);
            return null;
        }
        var bundleSrc = manifest.bundles[bundleName].src;
        if (!bundleSrc) {
            console.error('Bundle [ ' + bundleName + ' ] has no `src` entry in manifest.json.');
            process.exit(1);
            return null;
        }
        return _(projectPath + '/' + bundleSrc + '/config/connectors.json', true);
    };

    /**
     * Reads a JSON file with tolerance for `//` and `/* * /` comments
     * via `requireJSON`. Returns null on any parse or I/O error.
     *
     * @inner
     * @private
     * @param {string} filePath
     * @returns {object|null}
     */
    var readJsonSafe = function (filePath) {
        try {
            if ( !fs.existsSync(filePath) ) return null;
            return requireJSON(filePath);
        } catch (e) {
            return null;
        }
    };

    /**
     * Reads the existing `connectors.json`, preserves the leading comment
     * header (everything before the first non-comment `{`), and parses the body with
     * comment tolerance. Exits on parse or I/O failure. Returns null when
     * the target file does not exist at all — that's an error for
     * `connector:rm` because there's nothing to remove.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to connectors.json
     * @returns {{header: string, data: object}|null}
     */
    var readExistingFile = function (target) {
        if ( !fs.existsSync(target) ) {
            console.error('File `' + target + '` does not exist — nothing to remove.');
            process.exit(1);
            return null;
        }
        var raw;
        try {
            raw = fs.readFileSync(target, 'utf8');
        } catch (e) {
            console.error('Cannot read `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        // Comment-aware: the scaffolded template's `// "couchbase": {` puts a
        // brace inside a comment, so a naive first-brace scan lands there and
        // corrupts the rewrite. splitHeader finds the first STRUCTURAL `{`.
        var header = lib.jsonConfigHeader.splitHeader(raw).header;
        var data;
        try {
            data = requireJSON(target) || {};
        } catch (e) {
            console.error('Cannot parse `' + target + '`: ' + e.message);
            process.exit(1);
            return null;
        }
        return { header: header, data: data };
    };

    /**
     * Resolves the driver type identifier for an entry — mirrors the
     * lenient convention used in `list.js::resolveDriver`. Entries may
     * omit `connector` when the logical name matches the driver type
     * (e.g. `"mongodb"` key with no `connector` field).
     *
     * @inner
     * @private
     * @param {object} entry
     * @param {string} key
     * @returns {string}
     */
    var resolveConnectorType = function (entry, key) {
        if (entry && typeof entry.connector == 'string') return entry.connector;
        return key;
    };

    /**
     * Scans the rest of the project for other declarations of the same
     * logical key and other declarations of the same driver type. Used
     * to (a) decide whether project-level rm needs --force, and (b)
     * build the driver-retention hint.
     *
     * `sameKey` lists every other scope that declares the same logical
     * name. `sameDriver` lists every other scope using the same driver
     * type regardless of logical name.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {object} manifest - Parsed manifest.json
     * @param {string} connectorName
     * @param {string} driverType
     * @param {string|null} excludeBundle - When rm is bundle-scoped, skip
     *                                      the bundle being modified.
     * @returns {{sameKey: Array<{scope: string, bundle: string|null, source: string, connector: string}>,
     *            sameDriver: Array<{scope: string, bundle: string|null, key: string, connector: string}>}}
     */
    var scanSiblings = function (projectPath, manifest, connectorName, driverType, excludeBundle) {
        var sameKey    = [];
        var sameDriver = [];

        var sharedPath  = _(projectPath + '/shared/config/connectors.json', true);
        var sharedJson  = readJsonSafe(sharedPath) || {};

        // Shared file — only relevant when we're removing from a bundle
        // (project-level rm is removing from shared itself).
        if (excludeBundle) {
            for (var sk in sharedJson) {
                if (sk === '$schema') continue;
                var sEntry   = sharedJson[sk];
                var sDriver  = resolveConnectorType(sEntry, sk);
                if (sk === connectorName) {
                    sameKey.push({ scope: 'shared', bundle: null, source: 'shared', connector: sDriver });
                }
                if (sDriver === driverType && sk !== connectorName) {
                    sameDriver.push({ scope: 'shared', bundle: null, key: sk, connector: sDriver });
                } else if (sDriver === driverType && sk === connectorName && excludeBundle) {
                    sameDriver.push({ scope: 'shared', bundle: null, key: sk, connector: sDriver });
                }
            }
        }

        var bundleNames = manifest.bundles ? Object.keys(manifest.bundles) : [];
        for (var bi = 0; bi < bundleNames.length; bi++) {
            var bName = bundleNames[bi];
            if (excludeBundle && bName === excludeBundle) continue;

            var bSrc = manifest.bundles[bName].src;
            if (!bSrc) continue;
            var bPath = _(projectPath + '/' + bSrc + '/config/connectors.json', true);
            var bJson = readJsonSafe(bPath) || {};

            for (var bk in bJson) {
                if (bk === '$schema') continue;
                var bEntry  = bJson[bk];
                var bDriver = resolveConnectorType(bEntry, bk);
                if (bk === connectorName) {
                    var source = (typeof sharedJson[bk] != 'undefined') ? 'override' : 'bundle';
                    sameKey.push({ scope: bName, bundle: bName, source: source, connector: bDriver });
                }
                if (bDriver === driverType && bk !== connectorName) {
                    sameDriver.push({ scope: bName, bundle: bName, key: bk, connector: bDriver });
                }
            }
        }

        return { sameKey: sameKey, sameDriver: sameDriver };
    };

    /**
     * Returns a new object with `connectorName` removed, preserving
     * `$schema` at the top and every remaining key's original order.
     *
     * @inner
     * @private
     * @param {object} existing
     * @param {string} connectorName
     * @returns {object}
     */
    var removeKey = function (existing, connectorName) {
        var out = {};
        if (existing.$schema) {
            out.$schema = existing.$schema;
        }
        for (var k in existing) {
            if (k === '$schema') continue;
            if (k === connectorName) continue;
            out[k] = existing[k];
        }
        return out;
    };

    /**
     * Writes the updated config back to disk. Preserves the leading
     * comment header verbatim, serialises with 4-space indentation, and
     * appends a trailing newline. Mirrors add.js::writeFile.
     *
     * @inner
     * @private
     * @param {string} target
     * @param {string} header
     * @param {object} data
     */
    var writeFile = function (target, header, data) {
        var body = JSON.stringify(data, null, 4);
        var text = (header || '') + body + '\n';
        lib.generator.createFileFromDataSync(text, target);
    };

    /**
     * Prints the dry-run preview — what would be removed, from which
     * file, plus the full sibling hint.
     *
     * @inner
     * @private
     * @param {string} target
     * @param {string} connectorName
     * @param {object} entry
     * @param {string|null} bundleName
     * @param {object} siblings
     */
    var printDryRun = function (target, connectorName, entry, bundleName, siblings) {
        var label = bundleName ? ('bundle `' + bundleName + '`') : 'shared scope';
        var out = '';
        out += '[dry-run] Would remove connector `' + connectorName + '` from ' + label + ' at ' + target + '.\n';
        out += '[dry-run] Current entry:\n' + JSON.stringify(entry, null, 4) + '\n';

        if (!bundleName && siblings.sameKey.length > 0) {
            out += '[dry-run] Warning: ' + siblings.sameKey.length + ' bundle(s) still reference `' + connectorName + '`: ' +
                siblings.sameKey.map(function (s) { return s.bundle + (s.source === 'override' ? ' (override)' : ''); }).join(', ') +
                '. Re-run without --dry-run and with --force to proceed.\n';
        }
        var retention = buildDriverRetentionHint(resolveConnectorType(entry, connectorName), connectorName, bundleName, siblings);
        if (retention) out += '[dry-run] ' + retention + '\n';
        console.log(out);
    };

    /**
     * Builds the "driver package is NOT uninstalled" hint line, naming
     * any siblings that still use the same driver so the user knows
     * whether it is safe to `npm uninstall` it themselves.
     *
     * For bundle-level rm with no siblings using the driver, the hint
     * is shorter — the driver is no longer referenced anywhere but gina
     * still will not uninstall it automatically.
     *
     * @inner
     * @private
     * @param {string} driverType
     * @param {string} connectorName
     * @param {string|null} bundleName
     * @param {object} siblings
     * @returns {string|null}
     */
    var buildDriverRetentionHint = function (driverType, connectorName, bundleName, siblings) {
        if (ALLOWED_CONNECTOR_TYPES.indexOf(driverType) < 0) {
            return 'Note: gina does not uninstall npm packages. Review `' + driverType + '` usage before `npm uninstall`.';
        }
        if (driverType === 'sqlite') {
            return null;
        }

        var stillUsed = [];
        for (var i = 0; i < siblings.sameDriver.length; i++) {
            var s = siblings.sameDriver[i];
            stillUsed.push(s.scope + (s.key !== connectorName ? ' (' + s.key + ')' : ''));
        }
        for (var j = 0; j < siblings.sameKey.length; j++) {
            var k = siblings.sameKey[j];
            if (k.scope !== 'shared' || bundleName) {
                stillUsed.push(k.scope + (k.source === 'override' ? ' (override)' : ''));
            }
        }
        // Unique-ify while preserving order.
        var seen = {};
        var unique = [];
        for (var u = 0; u < stillUsed.length; u++) {
            if (!seen[stillUsed[u]]) {
                seen[stillUsed[u]] = true;
                unique.push(stillUsed[u]);
            }
        }

        if (unique.length > 0) {
            return 'Note: gina does not uninstall npm packages. Driver `' + driverType + '` is still referenced by: ' + unique.join(', ') + '.';
        }
        return 'Note: gina does not uninstall npm packages. If no other project needs `' + driverType + '`, you can `npm uninstall` it yourself.';
    };

    init();
}

module.exports = Remove;
