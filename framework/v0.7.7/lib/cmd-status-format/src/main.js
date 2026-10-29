/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/cmd-status-format
 *
 * Shared run-state / port display primitives for the bundle- and project-level
 * CLI status commands (`bundle:list`, `service:list`, `bundle:status`,
 * `project:status`). Each of those handlers previously carried its own
 * byte-identical copy of `pad`, `pickPreferredPort`, and `readPidfile`; this
 * module is the single source of truth.
 *
 * This module is pure — it requires only node builtins (`fs`, `path`), does
 * not require `lib.*`, and does not read framework globals (`GINA_HOMEDIR`,
 * `_`). Callers pass the run directory in (see {@link readPidfile}), so the
 * module is unit-testable by a direct `require`. Same contract as
 * {@link module:gina/lib/routing-introspect}.
 *
 * @example
 * var fmt       = lib.cmdStatusFormat;
 * var preferred = fmt.pickPreferredPort(ports);          // {env,scheme,protocol,port} | null
 * var runState  = fmt.readPidfile(GINA_HOMEDIR + '/run', 'api', 'myproject');
 * var line      = fmt.pad('api', 16) + ' ' + (preferred ? preferred.port : '(no port)');
 */

var fs   = require('fs');
var path = require('path');

/**
 * Right-pads `s` with spaces to reach `width`. Used to align the port column
 * after the bundle / service name in the text output. Coerces a falsy input
 * to the empty string and never truncates (a string already at or beyond
 * `width` is returned unchanged).
 *
 * @memberof module:gina/lib/cmd-status-format
 * @param   {string} s
 * @param   {number} width
 * @returns {string}
 *
 * @example
 * pad('api', 8);   // 'api     '
 * pad('', 3);      // '   '
 * pad('toolong', 4); // 'toolong' (unchanged — already wider than 4)
 */
var pad = function(s, width) {
    var out = String(s || '');
    while (out.length < width) {
        out += ' ';
    }
    return out;
};

/**
 * Picks the "preferred" port to display for a bundle / service from its
 * `ports.reverse.json` record: the `dev` env when present (else the first env
 * key), then `http/2.0 https` → `http/1.1 https` → `http/1.1 http`. Returns
 * null when no port is allocated.
 *
 * @memberof module:gina/lib/cmd-status-format
 * @param   {object|null} ports - Port record from ports.reverse.json
 * @returns {{env: string, scheme: string, protocol: string, port: number}|null}
 *
 * @example
 * pickPreferredPort({ dev: { 'http/2.0': { https: 4208 } } });
 * // { env: 'dev', scheme: 'http/2.0', protocol: 'https', port: 4208 }
 *
 * @example
 * pickPreferredPort(null);  // null
 */
var pickPreferredPort = function(ports) {
    if (!ports) return null;
    var envKey = ports.dev ? 'dev' : Object.keys(ports)[0];
    if (!envKey) return null;
    var env = ports[envKey];
    if (!env) return null;

    if (env['http/2.0'] && env['http/2.0'].https) {
        return { env: envKey, scheme: 'http/2.0', protocol: 'https', port: env['http/2.0'].https };
    }
    if (env['http/1.1'] && env['http/1.1'].https) {
        return { env: envKey, scheme: 'http/1.1', protocol: 'https', port: env['http/1.1'].https };
    }
    if (env['http/1.1'] && env['http/1.1'].http) {
        return { env: envKey, scheme: 'http/1.1', protocol: 'http', port: env['http/1.1'].http };
    }
    return null;
};

/**
 * Reads `<runDir>/<bundleName>@<projectName>.pid` and probes the pid with
 * `process.kill(pid, 0)`. Returns `running: false` on a missing, unreadable,
 * non-numeric, non-positive, or stale pidfile — and never deletes the file
 * (clean-up stays with `bundle:stop`).
 *
 * `runDir` is passed in (rather than read from the `GINA_HOMEDIR` global) so
 * the module stays pure and unit-testable. CLI-daemon callers pass
 * `GINA_HOMEDIR + '/run'`; `service:list` passes `'gina'` as the project to
 * resolve `<name>@gina.pid`.
 *
 * @memberof module:gina/lib/cmd-status-format
 * @param   {string} runDir      - Directory holding the pidfiles (e.g. ~/.gina/run)
 * @param   {string} bundleName
 * @param   {string} projectName
 * @returns {{running: boolean, pid: number|null}}
 *
 * @example
 * readPidfile('/home/u/.gina/run', 'api', 'myproject');
 * // { running: true, pid: 12345 }  — when the process is alive
 */
var readPidfile = function(runDir, bundleName, projectName) {
    var pidPath = path.join(runDir, bundleName + '@' + projectName + '.pid');
    if ( !fs.existsSync(pidPath) ) {
        return { running: false, pid: null };
    }
    var raw;
    try {
        raw = fs.readFileSync(pidPath, 'utf8').trim();
    } catch (e) {
        return { running: false, pid: null };
    }
    var pid = parseInt(raw, 10);
    if ( isNaN(pid) || pid <= 0 ) {
        return { running: false, pid: null };
    }
    try {
        process.kill(pid, 0);
        return { running: true, pid: pid };
    } catch (e) {
        return { running: false, pid: null };
    }
};

module.exports = {
    pad               : pad,
    pickPreferredPort : pickPreferredPort,
    readPidfile       : readPidfile
};
