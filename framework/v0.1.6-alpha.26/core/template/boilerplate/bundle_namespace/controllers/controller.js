//Imports goes here.

/**
 * {Bundle}{Namespace}Controller
 * */
function {Bundle}{Namespace}Controller() {
    var self = this;
    // get config/app.json content
    // var appConf = this.getConfig('app');

    /**
     * Default action
     *
     * @param {object} req
     * @param {object} res
     * @callback [next]
     * */
    this.default = function(req, res) {
        self.renderJSON({ status: '200', msg: 'hello world !' });

        // use this to render errors
        // self.throwError( new Error('Error sample') );
    }

    // The onReady Event is called when the controller is loaded
    // You can use this to define, overwrite and customise controller methods & even swig filters
    //this.onReady = function(req, res, next){
    //    // e.g: Define a setup function that you call when the controller is ready
    //    //setup(req, res, next)
    //    // Or you can just complete and reuse the `setup.js` and call self.setup(req, res, next)
    //}
};

module.exports = {Bundle}{Namespace}Controller