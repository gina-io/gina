var fs      = require('fs');
var console = lib.logger;
var fmt     = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/connector/list
 */
/**
 * Lists connectors declared in a project's shared and/or bundle-level
 * `connectors.json` files. For each connector, shows the logical name,
 * driver type, source (`[shared]`, `[<bundle>]`, or `[<bundle> override]`),
 * the resolved npm driver package, and whether that package is installed
 * at `<project>/node_modules/<driver>`.
 *
 * Usage:
 *  gina connector:list
 *  gina connector:list @<project>
 *  gina connector:list <bundle> @<project>
 *  gina connector:list --format=json
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function List(opt, cmd) {
    var self = { format: null };

    /**
     * Connector driver registry — single source of truth for the
     * logical `connector` type → npm driver package + semver range
     * mapping (`DRIVER_MAP`) and the AI `protocol` scheme → npm driver
     * mapping (`AI_DRIVER_MAP`). Previously duplicated inline here and
     * in `lib/cmd/connector/add.js`; both now read from the shared
     * module. See `lib/connector-registry/src/main.js`.
     *
     * @inner
     * @constant
     */
    var registry = lib.connectorRegistry;

    /**
     * Parse --format, bundle-filter/project args (populated by CmdHelper),
     * gather rows, emit text or JSON.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1];
            }
        }

        // CmdHelper populates self.projectName from `@<name>` tokens and
        // self.name from the first positional bundle token.
        var bundleFilter = self.name || null;

        if ( typeof(self.projectName) == 'undefined' || self.projectName == null ) {
            // No project → iterate every registered project.
            if (bundleFilter) {
                console.error('`connector:list <bundle>` requires `@<project>`. Did you forget `@<project_name>`?');
                process.exit(1);
                return;
            }
            listAll();
            return;
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('Project @' + self.projectName + ' is not registered. Run `gina project:list` to see registered projects.');
            process.exit(1);
            return;
        }

        if (bundleFilter) {
            // Validate the bundle exists in the project's manifest.
            var manifest = loadManifest(self.projects[self.projectName].path);
            if (manifest && manifest.bundles && !manifest.bundles[bundleFilter]) {
                console.error('Bundle [ ' + bundleFilter + ' ] is not registered inside `@' + self.projectName + '`.');
                process.exit(1);
                return;
            }
            listBundleOnly(self.projectName, bundleFilter);
        } else {
            listProjectOnly(self.projectName);
        }

        process.exit(0);
    };

    /**
     * Reads a JSON file with tolerance for line and block comments via
     * `requireJSON` (routing/settings/connectors files routinely carry
     * comments). Returns `null` on any parse or I/O error.
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
     * Loads `<projectPath>/manifest.json`. Returns null on failure so the
     * caller can choose how to report.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @returns {object|null}
     */
    var loadManifest = function (projectPath) {
        return readJsonSafe(_(projectPath + '/manifest.json', true));
    };

    /**
     * Resolves the driver npm package for a connector entry. Uses
     * `entry.connector` when set, otherwise falls back to the logical key
     * (matches the lenient convention used by some projects — see
     * `admin/config/connectors.json` with key `"mongodb"` and no
     * `connector` field).
     *
     * For the `ai` connector, reads `entry.protocol` and resolves via
     * `registry.getAIDriver(scheme)`.
     *
     * @inner
     * @private
     * @param {object} entry - Connector config
     * @param {string} key - Logical connector key
     * @returns {{type: string, npm: string|null, range: string|null, builtin: boolean, note: string|null, unresolved: boolean}}
     */
    var resolveDriver = function (entry, key) {
        var type = (entry && entry.connector) ? entry.connector : key;

        if (type === 'ai') {
            var protocol = (entry && entry.protocol) ? String(entry.protocol) : '';
            var scheme   = protocol.split(':')[0].toLowerCase();
            var ai       = registry.getAIDriver(scheme);
            if (ai) {
                return {
                    type       : type,
                    npm        : ai.npm,
                    range      : ai.range,
                    builtin    : false,
                    note       : null,
                    unresolved : false
                };
            }
            return {
                type       : type,
                npm        : null,
                range      : null,
                builtin    : false,
                note       : 'unknown `ai` protocol — set `protocol` to one of: ' + registry.getAISchemes().map(function(k){ return k + '://'; }).join(', '),
                unresolved : true
            };
        }

        var entryInfo = registry.getDriver(type);
        if (!entryInfo) {
            return {
                type       : type,
                npm        : null,
                range      : null,
                builtin    : false,
                note       : 'unknown connector type — no driver mapping registered',
                unresolved : true
            };
        }
        if (entryInfo.builtin) {
            return {
                type       : type,
                npm        : null,
                range      : null,
                builtin    : true,
                note       : entryInfo.note || null,
                unresolved : false
            };
        }
        return {
            type       : type,
            npm        : entryInfo.npm,
            range      : entryInfo.range,
            builtin    : false,
            note       : null,
            unresolved : false
        };
    };

    /**
     * Probes `<projectPath>/node_modules/<driverNpm>/package.json` to report
     * install status and resolved version. Scoped packages (e.g.
     * `@anthropic-ai/sdk`) resolve naturally because the path already
     * includes the `@scope/` prefix.
     *
     * @inner
     * @private
     * @param {string} projectPath
     * @param {string|null} driverNpm - npm package name or null
     * @returns {{installed: boolean, version: string|null}}
     */
    var checkInstalled = function (projectPath, driverNpm) {
        if (!driverNpm) return { installed: false, version: null };
        var pkgPath = _(projectPath + '/node_modules/' + driverNpm + '/package.json', true);
        if ( !fs.existsSync(pkgPath) ) {
            return { installed: false, version: null };
        }
        var pkg = readJsonSafe(pkgPath);
        if (!pkg) return { installed: true, version: null };
        return { installed: true, version: pkg.version || null };
    };

    /**
     * Build rows for a single project: read shared/config/connectors.json
     * and each bundle's config/connectors.json, key-level merge with bundle
     * winning, stamp `source` on each row to indicate provenance.
     *
     * Shared-only entries are emitted once per project with source=`shared`.
     * Bundle-only entries appear under their bundle with source=`<bundle>`.
     * When a bundle overrides a shared key, source=`<bundle> override`.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @returns {{rows: object[], project: object, manifest: object|null, missingManifest: boolean}}
     */
    var gatherProjectRows = function (projectName) {
        var project    = self.projects[projectName];
        var manifest   = loadManifest(project.path);
        var rows       = [];

        var sharedPath  = _(project.path + '/shared/config/connectors.json', true);
        var sharedJson  = readJsonSafe(sharedPath) || {};
        var sharedKeys  = {};
        for (var k in sharedJson) {
            if (k === '$schema') continue;
            sharedKeys[k] = sharedJson[k];
        }

        // Track which shared keys have been overridden by a bundle so we
        // only emit a standalone shared row for keys no bundle touches.
        var sharedOverriddenBy = {};

        if (manifest && manifest.bundles) {
            var bundleNames = Object.keys(manifest.bundles).sort();
            for (var bi = 0; bi < bundleNames.length; bi++) {
                var bName = bundleNames[bi];
                var bSrc  = manifest.bundles[bName].src;
                if (!bSrc) continue;
                var bPath = _(project.path + '/' + bSrc + '/config/connectors.json', true);
                var bJson = readJsonSafe(bPath) || {};

                for (var bk in bJson) {
                    if (bk === '$schema') continue;
                    var entry    = bJson[bk];
                    var overrode = (typeof sharedKeys[bk] !== 'undefined');
                    if (overrode) {
                        sharedOverriddenBy[bk] = sharedOverriddenBy[bk] || [];
                        sharedOverriddenBy[bk].push(bName);
                    }
                    var mergedEntry = overrode ? merge(sharedKeys[bk], entry) : entry;
                    rows.push(buildRow(project, projectName, bName, bk, mergedEntry, overrode ? 'override' : 'bundle'));
                }
            }
        }

        for (var sk in sharedKeys) {
            if (sharedOverriddenBy[sk] && sharedOverriddenBy[sk].length > 0) continue;
            rows.push(buildRow(project, projectName, null, sk, sharedKeys[sk], 'shared'));
        }

        return { rows: rows, project: project, manifest: manifest, missingManifest: !manifest };
    };

    /**
     * Minimal shallow merge — right-side wins on conflicting keys. Mirrors
     * the bundle-wins semantics documented in `core/config.js:1754`.
     *
     * @inner
     * @private
     * @param {object} a
     * @param {object} b
     * @returns {object}
     */
    var merge = function (a, b) {
        var out = {};
        var k;
        for (k in a) { out[k] = a[k]; }
        for (k in b) { out[k] = b[k]; }
        return out;
    };

    /**
     * Build one row object for a single connector entry.
     *
     * @inner
     * @private
     * @param {object} project - projects.json entry
     * @param {string} projectName
     * @param {string|null} bundleName - null for shared-only rows
     * @param {string} key - Connector logical name
     * @param {object} entry - Connector config
     * @param {'shared'|'bundle'|'override'} source
     * @returns {object}
     */
    var buildRow = function (project, projectName, bundleName, key, entry, source) {
        entry = entry || {};
        var driver       = resolveDriver(entry, key);
        var install      = driver.builtin
            ? { installed: true, version: null }
            : checkInstalled(project.path, driver.npm);
        var pinnedRange  = (typeof entry.version == 'string') ? entry.version : null;

        return {
            project           : projectName,
            bundle            : bundleName,
            name              : key,
            connector         : driver.type,
            source            : source,
            driver            : driver.npm,
            builtin           : driver.builtin,
            range             : driver.range,
            version           : pinnedRange,
            installed         : install.installed,
            installedVersion  : install.version,
            note              : driver.note,
            unresolved        : driver.unresolved
        };
    };

    /**
     * Detect connector types where two or more bundles declare different
     * `version` pins. The npm `node_modules/<driver>/` folder resolves to a
     * single version per project, so the first install wins — the other
     * bundle's pin is aspirational. Returns an array of warning strings.
     *
     * @inner
     * @private
     * @param {object[]} rows
     * @returns {string[]}
     */
    var detectVersionDisagreements = function (rows) {
        var byDriver = {};
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.driver || !r.version) continue;
            byDriver[r.driver] = byDriver[r.driver] || {};
            byDriver[r.driver][r.version] = byDriver[r.driver][r.version] || [];
            byDriver[r.driver][r.version].push((r.bundle ? (r.bundle + '/') : 'shared/') + r.name);
        }
        var warnings = [];
        for (var d in byDriver) {
            var versions = Object.keys(byDriver[d]);
            if (versions.length > 1) {
                var parts = [];
                for (var v = 0; v < versions.length; v++) {
                    parts.push(versions[v] + ' (' + byDriver[d][versions[v]].join(', ') + ')');
                }
                warnings.push('driver `' + d + '` has conflicting `version` pins: ' + parts.join(' vs '));
            }
        }
        return warnings;
    };

    /**
     * Format a row for the text output. Kept in one place so listAll,
     * listProjectOnly, and listBundleOnly produce consistent output.
     *
     * @inner
     * @private
     * @param {object} r - Row from buildRow
     * @returns {string}
     */
    var formatRow = function (r) {
        var statusFlag;
        if (r.unresolved) {
            statusFlag = '[ ?? ]';
        } else if (r.builtin || r.installed) {
            statusFlag = '[ ok ]';
        } else {
            statusFlag = '[ ?! ]';
        }

        var sourceLabel;
        if (r.source === 'shared') {
            sourceLabel = '[shared]';
        } else if (r.source === 'override') {
            sourceLabel = '[' + r.bundle + ' override]';
        } else {
            sourceLabel = '[' + r.bundle + ']';
        }

        var line = statusFlag + ' ' + fmt.pad(r.name, 16) + ' ' + fmt.pad(r.connector, 12) + ' ' + fmt.pad(sourceLabel, 24);

        if (r.builtin) {
            line += r.note ? ('(' + r.note + ')') : '(built-in)';
        } else if (r.unresolved) {
            line += r.note ? ('(' + r.note + ')') : '(unresolved)';
        } else if (r.installed) {
            var pinned = r.version ? (' pin ' + r.version) : '';
            var resolved = r.installedVersion ? (' ' + r.installedVersion + ' installed') : ' installed';
            line += '(' + r.driver + (r.range ? '@' + r.range : '') + pinned + resolved + ')';
        } else {
            var pin2 = r.version ? (' pin ' + r.version) : '';
            line += '(' + r.driver + (r.range ? '@' + r.range : '') + pin2 + ' — run `npm install ' + r.driver + '`)';
        }
        return line;
    };

    /**
     * List connectors for every registered project.
     *
     * @inner
     * @private
     */
    var listAll = function () {
        var projectNames = [];
        for (var p in self.projects) { projectNames.push(p); }
        projectNames.sort();

        var json = [];
        var str  = '';

        for (var i = 0; i < projectNames.length; i++) {
            var pname = projectNames[i];
            var proj  = self.projects[pname];

            var jsonProject = { project: pname, status: 'ok', connectors: [] };

            if ( !fs.existsSync(proj.path) ) {
                jsonProject.status = '?!';
                str += '------------------------------------\n\r';
                str += '?! ' + pname + '\n\r';
                str += '------------------------------------\n\r';
                str += '(project path missing: ' + proj.path + ')\n\r\n\r';
                json.push(jsonProject);
                continue;
            }

            var collected = gatherProjectRows(pname);
            jsonProject.connectors = collected.rows;

            str += '------------------------------------\n\r';
            str += pname + '\n\r';
            str += '------------------------------------\n\r';

            if (collected.missingManifest) {
                str += '(manifest.json not found or unreadable at ' + proj.path + ')\n\r';
            } else if (collected.rows.length === 0) {
                str += '(no connectors declared)\n\r';
            } else {
                for (var r = 0; r < collected.rows.length; r++) {
                    str += formatRow(collected.rows[r]) + '\n\r';
                }
                var warnings = detectVersionDisagreements(collected.rows);
                for (var w = 0; w < warnings.length; w++) {
                    str += '[ !! ] ' + warnings[w] + '\n\r';
                }
            }
            str += '\n\r';
            json.push(jsonProject);
        }

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(json));
        }
        console.log(str);
    };

    /**
     * List connectors for one project, showing both shared and every
     * bundle's overlay.
     *
     * @inner
     * @private
     * @param {string} projectName
     */
    var listProjectOnly = function (projectName) {
        var collected = gatherProjectRows(projectName);
        var str       = '';
        var jsonOut   = { project: projectName, status: 'ok', connectors: collected.rows };

        str += '------------------------------------\n\r';
        str += projectName + '\n\r';
        str += '------------------------------------\n\r';

        if (collected.missingManifest) {
            str += '(manifest.json not found or unreadable at ' + self.projects[projectName].path + ')\n\r';
        } else if (collected.rows.length === 0) {
            str += '(no connectors declared)\n\r';
        } else {
            for (var r = 0; r < collected.rows.length; r++) {
                str += formatRow(collected.rows[r]) + '\n\r';
            }
            var warnings = detectVersionDisagreements(collected.rows);
            for (var w = 0; w < warnings.length; w++) {
                str += '[ !! ] ' + warnings[w] + '\n\r';
            }
        }

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(jsonOut));
        }
        console.log(str);
    };

    /**
     * List connectors visible to a single bundle — the merged shared+bundle
     * view that the framework actually loads at runtime.
     *
     * @inner
     * @private
     * @param {string} projectName
     * @param {string} bundleName
     */
    var listBundleOnly = function (projectName, bundleName) {
        var collected = gatherProjectRows(projectName);
        var filtered  = [];
        for (var i = 0; i < collected.rows.length; i++) {
            var r = collected.rows[i];
            if (r.bundle === bundleName || r.source === 'shared') {
                filtered.push(r);
            }
        }

        var jsonOut = { project: projectName, bundle: bundleName, status: 'ok', connectors: filtered };

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(jsonOut));
        }

        var str = '';
        str += '------------------------------------\n\r';
        str += bundleName + ' @ ' + projectName + '\n\r';
        str += '------------------------------------\n\r';
        if (filtered.length === 0) {
            str += '(no connectors declared — checked shared/config/connectors.json and ' + bundleName + '/config/connectors.json)\n\r';
        } else {
            for (var r2 = 0; r2 < filtered.length; r2++) {
                str += formatRow(filtered[r2]) + '\n\r';
            }
            var warnings = detectVersionDisagreements(filtered);
            for (var w = 0; w < warnings.length; w++) {
                str += '[ !! ] ' + warnings[w] + '\n\r';
            }
        }
        console.log(str);
    };

    init();
}

module.exports = List;
