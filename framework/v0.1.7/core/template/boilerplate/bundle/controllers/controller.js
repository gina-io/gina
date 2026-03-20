//Imports goes here.

/**
 * {Bundle}Controller
 * This controller is inherited by all the namespace controllers.
 * This means that all public methods written here are reusable by the other controllers
 * without calling `require` in case you decide to add a namespace.
 * It is strongly advised to use namespaces to organize you code :
 * E.g.:
 *      gina namespace:add {bundle}/blogpost @{project}
 *      gina namespace:add {bundle}/account @{project}
 *      ...
 * */
function {Bundle}Controller() {
    var self = this;
    // get config/app.json content
    // var appConf = this.getConfig('app');

    

    // The onReady Event is called when the controller is loaded
    // You can use this to define, overwrite and customise default controller methods & swig filters
    this.onReady = function(req, res, next){
       // e.g: Define a `setup` function (inside this coontroller) that you can call when the controller is ready
       // Or better, you can just complete and reuse the `setup.js` and call self.setup(req, res, next)
       self.setup(req, res, next)
    }
};

module.exports = {Bundle}Controller