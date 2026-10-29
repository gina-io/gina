"use strict";
var fs = require('fs');
var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;

// #CN8 — Couchbase SDK v2 session store removed (EOL 2021). Only SDK v3 and v4 are supported.
// Default to v3 when the project does not pin a couchbase version.
var version = 3; // by default
var dependenciesPath = getPath('project') + '/package.json';// jshint ignore:line
// #B203 — `|| {}`: a project package.json without a `dependencies` key used to
// TypeError on the `.couchbase` read below.
var dependencies = JSON.parse(fs.readFileSync(dependenciesPath)).dependencies || {};// jshint ignore:line
if ( dependencies.couchbase ) {
    // #B203 — the SDK major is the pin's FIRST integer: the former caret-only
    // strip mangled range pins (`~4.5.0` became `~4`, `>=4.5` became `>=4`),
    // which slipped past the #CN8 v2 floor (parseInt of the mangled token is
    // NaN) and died at the existsSync gate below with a misdirecting
    // "supported majors" error.
    var pinnedMajor = String(dependencies.couchbase).match(/\d+/);
    if ( !pinnedMajor ) {
        throw new Error('[ CONNECTOR ][ couchbase ] session-store could not derive the SDK major from the project package.json couchbase dependency pin: "'
            + dependencies.couchbase + '". Use a numeric range or exact version (e.g. ^4.6.1) — supported couchbase SDK majors are 3 and 4.');
    }
    version = pinnedMajor[0];
}
// #CN8 — fail fast on SDK v2 (or older). The migration is a driver bump, not a config edit:
// upgrade the `couchbase` dependency in your project package.json to ^3 or ^4.
if ( parseInt(version, 10) <= 2 ) {
    throw new Error('[ CONNECTOR ][ couchbase ] session-store SDK v2 is no longer supported — removed in gina 0.4.0 (#CN8). '
        + 'Upgrade the couchbase driver in your project package.json: npm install couchbase@^4 (or ^3).');
}

var filename = _(GINA_FRAMEWORK_DIR + '/core/connectors/couchbase/lib/session-store.v'+ version +'.js', true);// jshint ignore:line
if ( !fs.existsSync(filename) ) {
    throw new Error('[ CONNECTOR ][ couchbase ] session-store file not found: ' + filename
        + ' — supported couchbase SDK majors are 3 and 4.');
}

module.exports = require(filename);