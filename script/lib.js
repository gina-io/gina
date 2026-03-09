var isWin32 = (process.platform === 'win32') ? true : false;

var scriptPath = __dirname;
var ginaPath = (scriptPath.replace(/\\/g, '/')).replace('/script', '');
var help        = require(ginaPath + '/utils/helper.js');
var pack        = ginaPath + '/package.json';
pack =  (isWin32) ? pack.replace(/\//g, '\\') : pack;

try {
    var packObj = require(pack);
    var version =  getEnvVar('GINA_VERSION') || packObj.version;
    var frameworkPath = ginaPath + '/framework/v' + version;
    setEnvVar('GINA_IS_WIN32', isWin32);
    setEnvVar('GINA_DIR', ginaPath);
    setEnvVar('GINA_FRAMEWORK', frameworkPath);
    setEnvVar('GINA_CORE', frameworkPath + '/core');
    setEnvVar('GINA_LIB', frameworkPath + '/lib');

    var lib = require(frameworkPath + '/lib');

    module.exports = lib;
} catch (err) {
    console.error(err.stack)
}