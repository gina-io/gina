"use strict";
var lib         = require('./../../lib') || require.cache[require.resolve('./../../lib')];
var inherits    = lib.inherits;
var Controller  = require('./controller');


/**
 * FrameworkController
 *
 * Internal controller used by the framework itself (e.g. built-in documentation route).
 * Extends SuperController so it inherits the full request/response lifecycle.
 *
 * @class
 * @constructor
 * @this {FrameworkController}
 * @extends Controller
 *
 * @param {object} options - Per-request options injected by the router
 */
function FrameworkController(options) {
    this.name = "FrameworkController";
    var self = this;

    /**
     * Default init action — no-op placeholder.
     *
     * @memberof FrameworkController
     * @param {object} req - Incoming request
     * @param {object} res - Server response
     * @returns {void}
     */
    this.init = function(req, res) {}

    /**
     * Built-in documentation action.
     *
     * @memberof FrameworkController
     * @param {object} req - Incoming request
     * @param {object} res - Server response
     * @returns {void}
     */
    this.doc = function(req, res) {
        console.log('got doc action');
        var status = req.get.status || 'ok';
        var data = {
            status: status,
            msg: 'hello world !',
            page : { title: 'Documentation', content: 'home.html' }
        };
        render(data)
    }

    /**
     * Render the documentation page.
     *
     * @inner
     * @param {object} data - Template data
     * @returns {void}
     */
    var render = function(data) {
        //var views = self.getConfig('views');// ????
        var dir = getPath('gina').documentation;
        self.setViewsLocation(dir);
        //by default for all pages
        data['page']['lang'] = 'en';
        self.render(data)
    }
};

FrameworkController = inherits(FrameworkController, Controller);
module.exports = FrameworkController