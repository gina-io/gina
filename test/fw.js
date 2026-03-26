'use strict';
// Derives the current framework directory from package.json version.
// Import this instead of hardcoding 'framework/v0.x.y-alpha.z' in test files.
var path = require('path');
var pkg  = require('../package.json');
module.exports = path.resolve(__dirname, '..', 'framework', 'v' + pkg.version);
