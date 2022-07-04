//Imports goes here.

/**
 * {Bundle}Controller
 * */
function {Bundle}Controller() {
    var self = this;
    // get config/app.json content
    // var appConf = this.getConfig('app');

    /**
     * Init default action
     *
     * @param {object} req
     * @param {object} res
     * @callback [next]
     * */
    this.init = function(req, res) {
        console.log('got init action');
        self.renderJSON({ status: '200', msg: 'hello world !' })
    }

    // The onReady Event is called when the controller is loaded
    // You can use this to define, overwrite and customise controller methods & even swig filters
    //this.onReady = function(req, res, next){
    //    // e.g: Define a setup function that you call when the controller is ready
    //    //setup(req, res, next)
    //    // Or you can just complete and reuse the `setup.js` and call self.setup(req, res, next)
    //}
};

module.exports = {Bundle}Controller