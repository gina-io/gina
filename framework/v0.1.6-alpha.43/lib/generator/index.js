/* Gina.Lib.Generator
 *
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs = require('fs');

/**
 * @class Generator
 *
 * Generator Class
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Generator
 * @author      Rhinostone <contact@gina.io>
 * */
var Generator = {
    createFileFromTemplate : function(source, target, callback){

        fs.readFile(source, function(err, data){
            if (err) throw err;
            //Removing existing files.
            if(fs.existsSync(target)){
                //Just in case.
                fs.chmodSync(target, 0755);

                if ( fs.unlinkSync ) {
                    fs.unlinkSync(target)
                } else {
                    fs.unlink(target);
                }
            }
            fs.writeFile(target, data, function(err, data){
                setTimeout( function onChmod(){
                    if (err) throw err;
                    //Setting permission.
                    fs.chmodSync(target, 0755);
                    if ( typeof(callback) != 'undefined') callback(err)
                }, 1000)
            });
        });
    },
    /**
     * Create file form template sync
     * Added to support node v5.5.0
     * */
    createFileFromTemplateSync : function(source, target) {
        var data = fs.readFileSync(source);
        if (data instanceof Error) {
            throw data
        } else {
            if (fs.existsSync(target)) {
                //Just in case.
                fs.chmodSync(target, 0755);

                if ( fs.unlinkSync ) {
                    fs.unlinkSync(target)
                } else {
                    fs.unlink(target);
                }
            }

            fs.writeFileSync(target, data);

            //Setting permission.
            try {
                fs.chmodSync(target, 0755)
            } catch (err) {} // file not found
        }
    },
    createFileFromDataSync : function(data, target){
        data = (typeof(data) == "object") ? JSON.stringify(data, null, 4) : data;
        fs.writeFileSync(target, data);
        fs.chmodSync(target, 0755)
    },
    // createFoldersFromStructureSync : function(structure){
    // },
    createPathSync : function(path, callback) {
        var t = path.replace(/\\/g, '\/').split('/');
        var path = '';
        //creating folders
        try {
            for (var p=0; p<t.length; ++p) {
                if (process.platform == 'win32' && p === 0) {
                    path += t[p];
                } else {
                    path += '/' + t[p];
                }
                if ( !fs.existsSync(path) ) {
                    fs.mkdirSync(path);
                }
            }
            callback(false);
        } catch (err) {
            callback(err);
        }
    }
};

module.exports = Generator