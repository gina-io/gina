'use strict';
var fs          = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
var util        = require('util');
var promisify   = util.promisify;

var CmdHelper   = require('./../helper');
var console = lib.logger;// jshint ignore:line
/**
 * Framework build command
 * e.g.
 *  gina framework:build
 *  or
 *  gina build
 *
 * @param {object} opt - Constructor options
 * */
function Build(opt, cmd){

    var self    = {};

    var init = function(opt, cmd) {
        console.log('Building framework, please wait ...');

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        begin(0);
    }
    /**
     * Bebin - Will run checking tasks in order of declaration
     * */
     var begin = async function(i) {
        var n = 0, funct = null, functName = null;
        for (let t in self) {
            if ( typeof(self[t]) == 'function') {
                if (n == i){
                    //let func = 'self.' + t + '()';
                    let func = 'self.' + t;
                    console.debug('Running [ ' + func + '() ]');
                    funct       = func;
                    functName   = t;
                    break;
                }
                n++;
            }
        }

        // to handle sync vs async to allow execution in order of declaration
        if (funct) {
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();');// jshint ignore:line
        } else {
            end();
        }
    }


    self.buildFrontPlugin = function(done) {
        var argv        = process.argv.slice(3);
        var bashScript  = _(GINA_CORE +'/asset/plugin/build', true);// jshint ignore:line
        if (Array.isArray(argv) && argv.length > 0) {
            bashScript += " "+argv.join(" ")
        }
        console.debug('Used arguments ', argv.join(" "));
        console.debug('Running: '+ bashScript);

        console.log(execSync(bashScript).toString());
        done()
    }

    var end = function (output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
                if ( messageOnly && type != 'log') {
                    console.log(output);
                }
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }

    init(opt, cmd)
}
module.exports = Build;