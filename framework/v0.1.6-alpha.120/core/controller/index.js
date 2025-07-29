var lib = require('../../lib') || require.cache[require.resolve('../../lib')];
var inherits = lib.inherits;
var helpers = lib.helpers;
var context = lib.context;

var isCacheless = ( /^false$/i.test(process.env.NODE_ENV_IS_DEV) ) ? false : true;
var mainPath = './controller';
var frameworkPath = './controller.framework';

if (isCacheless) {
    delete require.cache[require.resolve(mainPath)];
    // delete require.cache[require.resolve(frameworkPath)];
}
var Controller = null;
try {
    Controller = require(mainPath);
    // Controller.prototype.framework = require(frameworkPath);
} catch (controllerError) {
    throw controllerError
}


module.exports = Controller