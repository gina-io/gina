// Imports.
var fs = require('fs');
var helpers = require('helpers');
var inherits = require('inherits');

/**
 * Test Suite
 * PLEASE, DO NOT TOUCH IT
 *
 * @package     gina
 * @author      Rhinostone
 */
var TestSuite = function() {
    var self = this;

    this.root = __dirname;
    var d = _(__dirname).split(/\//);
    d.splice(d.length-1, 1);
    var gina = d.join('/');

    this.config = {
        root : this.root,
        gina : gina,
        target : this.root +'/workspace',
        nodeModules : this.root +'/node_modules'
    };

    var ignored = [
        /^\./ ,
        /node_modules/,
        /workspace/
    ];


    /**
     * Init
     * @constructor
     * */
    var init = function() {
        // load on startup
        loadScripts(self.root);
    }

    var loadScripts = function(path) {
        var files = fs.readdirSync(path);
        var file = '', filename = '';



        for (var f=0; f<files.length; ++f) {
            file = files[f].replace(/.js/, '');
            filename = path + '/' +files[f];

            var passed = true;
            for (var i in ignored) {

                if ( ignored[i].test(files[f]) ) {
                    passed = false
                }
            }

            if ( isDir(filename) &&
                !/node_modules/.test(filename.replace(self.root, '')) &&
                !/workspace/.test(filename.replace(self.root, '')) &&
                passed
            ) {
                //console.log('loading [ ' + filename +' ]\n');
                loadScripts(filename)
            } else if ( passed ) {
                //console.log('suite is : ', files[f]);
//                if (files[f] == '02-add_new_bundle.js') {

                if ( filename.substr(filename.length-3) == '.js') {
                    var Suite = require(filename);
                    if ( typeof(Suite) == 'function') {
                        Suite = inherits(Suite, self.Suite);
                        new Suite(self.config, exports)
                    }
                }
            }
        }
    }

    this.Suite = function(config, exports) {
        var self = this;

        this.hasFramework = function() {
             return self.hasWorkspace
        }
    }


    var isDir = function(path) {
        return fs.statSync(path).isDirectory()
    }

    init()
}()
