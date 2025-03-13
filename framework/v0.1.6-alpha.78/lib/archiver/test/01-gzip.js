var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var archiver    = require(__dirname+'/../src/main');// Not needed if the framework installed
var helpers     = require(__dirname+'/../../../helpers/index');// Not needed if the framework installed

var target      = __dirname + '/output/';
var src         = __dirname + '/data/';
var filename    = src + 'Porting to ARM 64-bit.pdf';
var dirname     = src + 'Samples';
var files       = [];
var filesList   = ['humans.txt', 'css', 'img/android-chrome-512x512.png']
                    .forEach(function(val, key, arr){ 
                        files[key] = {
                            // source
                            input   : dirname + '/' + val,
                            // destination
                            output  : val
                        }
                    });

var options     = {};

exports['[ compress from file ] `'+ filename +'` using [ Gzip ] with default options'] = function(test) {
    
    archiver
        .compress(filename, target)
        .onComplete( function onCompressed(err, target) {
            
            if (err) {
                throw err;
            }
            
            original    = fs.statSync(filename);
            result      = fs.statSync(target);
            var file    = target.substr(target.lastIndexOf('/') +1);
            
            // target crearted
            test.equal( fs.existsSync(target) , true);
            // is file
            test.equal(result.isFile(), true);
            // original size  vs result size using default options
            test.equal( original.size > result.size, true);            
                        
            fs.unlinkSync(target);

            test.done()
        })
       
}


exports['[ compress from folder ] `'+ dirname +'` using [ Gzip ] with level 7'] = function(test) {
        
    archiver
        .compress(dirname, target, { level: 7})
        .onComplete( function onCompressed(err, target) {
            
            if (err) {
                throw err;
            }
            
            original    = fs.statSync(filename);
            result      = fs.statSync(target);
            
            // target crearted
            test.equal( fs.existsSync(target) , true);
            // is file
            test.equal(result.isFile(), true);
            // size matches default options
            test.equal( original.size > result.size, true);
            
            // TODO - for a later check, add a new test to unzip & check content
            //new _(target).rmSync();
            
            fs.unlinkSync(target);
            
            test.done()
        });  
       
}

exports['[ compress from array of filenames & dirnames ] `'+ dirname +'` using [ Gzip ] with level 7'] = function(test) {
        
    archiver
        .compress(files, target, { level: 7})
        .onComplete( function onCompressed(err, target) {
            
            if (err) {
                throw err;
            }
            
            original    = fs.statSync(filename);
            result      = fs.statSync(target);
            
            // target crearted
            test.equal( fs.existsSync(target) , true);
            // is file
            test.equal(result.isFile(), true);
            // size matches default options
            test.equal( original.size > result.size, true);
            
            // TODO - for a later check, add a new test to unzip & check content
            //new _(target).rmSync();
            
            fs.unlinkSync(target);
            
            
            test.done()
        });  
       
}



// for debug purpose
if (reporter)
    reporter.run(['test/01-gzip.js']);