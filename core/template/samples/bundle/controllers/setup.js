/**
 * Setup Class
 * Allows you to extend setup to all your controllers
 *
 * E.g.: use it inside the controller `onReady` by calling `self.setup(req, res, next)`
 *
 * N.B.:
 *  Setup Class will only inherit from a few members from the SuperController.
 *  If you want all member from the SuperController, you need still can inherit from it this way:
 *
 *      var utils       = require('gina').utils;
 *      var inherits    = utils.inherits;
 *
 *  then right before exporting SetupClass
 *
 *      var Controller  = require('./controller.js');
 *      SetupClass      = inherits(SetupClass, Controller);
 *      module.exports  = SetupClass
 *
 * @param {object} req
 * @param {object} res
 * @callback next
 * */
function SetupClass(req, res, next){
    // get `app` config
    // var conf = this.getConfig('app')

    // defining filters
    //var swig = this.engine;

};

module.exports = SetupClass