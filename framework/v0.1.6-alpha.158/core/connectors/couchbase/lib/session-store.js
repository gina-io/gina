"use strict";
var fs = require('fs');
var gina            = require('../../../../core/gna');
var lib             = gina.lib;
var console         = lib.logger;

var version = 2; // by default
var dependenciesPath = getPath('project') + '/package.json';// jshint ignore:line
var dependencies = JSON.parse(fs.readFileSync(dependenciesPath)).dependencies;// jshint ignore:line
if ( dependencies.couchbase ) {
    version = JSON.parse(fs.readFileSync(dependenciesPath)).dependencies.couchbase;// jshint ignore:line
    version = version.replace(/\^/, '').split(/\./)[0];
}

var filename = _(GINA_FRAMEWORK_DIR + '/core/connectors/couchbase/lib/session-store.v'+ version +'.js', true);// jshint ignore:line
if ( !fs.existsSync(filename) ) {
    console.warn('Couchbase session-store file not found: ', filename);
    filename = filename = _(GINA_FRAMEWORK_DIR + '/core/connectors/couchbase/lib/session-store.v'+ version +'.js', true);// jshint ignore:line
    console.warn('Couchbase session-store will instead use: ', filename);
}

module.exports = require(filename);