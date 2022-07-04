
//imports
var fs = require('fs');
var utils = require(__dirname + '/../../index');
var GINA_PATH = _( getPath('gina').core );
var readline = require('readline');
var rl = readline.createInterface(process.stdin, process.stdout);

function iniProject(name) {

    var self = this;
    self.task = 'init';//important for later in config init

    var init = function(name) {
        self.root = getPath('root');
        self.name = name;
        var err = false;

        if ( !isValidName() ) {
            console.error('[ '+name+' ] is not a valid project name. Please, try something else: [a-Z0-9].');
            process.exit(1)
        }

        // creating project file
        var file = new _(self.root + '/project.json');
        var exists = file.existsSync();
        if ( !exists ) {
            createProjectFile( file.toString() )
        } else {
            console.warn('a project already exists in this location: '+ file);
        }

        // creating package file
        file = new _(self.root + '/package.json');
        exists = file.existsSync();
        if ( !exists ) {
            createPackageFile( file.toString() )
        } else {
            console.warn('a package already exists in this location: '+ file);

            end()
        }

    }

    var isValidName = function() {
        var patt = /[a-z0-9]/gi;
        return patt.test(name)
    }

    var createProjectFile = function(target) {
        var conf = GINA_PATH +'/template/conf/project.json';
        var contentFile = require(conf);
        var dic = {
            "project" : self.name
        };

        contentFile = whisper(dic, contentFile);//data
        fs.writeFileSync(target, JSON.stringify(contentFile, null, 4))
    }

    var createPackageFile = function(target) {
        var conf = GINA_PATH +'/template/conf/package.json';
        var contentFile = require(conf);
        var dic = {
            "project" : self.name
        };

        contentFile = whisper(dic, contentFile);//data
        fs.writeFileSync(target, JSON.stringify(contentFile, null, 4));

        end()
    }

    var end = function() {
        // new _(self.root+'/common/'))
        console.log('project [ '+ self.name +' ] ready');
        process.exit(0)
    }

    init(name)
};
module.exports = iniProject