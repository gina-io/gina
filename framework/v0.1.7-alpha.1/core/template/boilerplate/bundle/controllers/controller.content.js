//Imports goes here.

/**
 * {Bundle}ContentController
 * Here are handled all contents
 * */
function {Bundle}ContentController() {
    var self = this;
    // get config/app.json content
    var appConf = this.getConfig('app');

    /**
     * Home action
     *
     * @param {object} req
     * @param {object} res
     * @callback [next]
     * */
    this.home = function(req, res) {
        var data = {
            msg: appConf.greeting
        };

        self.renderJSON(data);

        // use this to render errors
        // return self.throwError( new Error('Error sample') );
    }

    // The onReady Event is called when the controller is loaded
    // You can use this to define, overwrite and customise default controller methods & even swig filters
    //this.onReady = function(req, res, next){
    //    // e.g: Define a setup function that you call when the controller is ready
    //    //setup(req, res, next)
    //    // Or better, you can just complete and reuse the `setup.js` and call self.setup(req, res, next)
    //}
};

module.exports = {Bundle}ContentController