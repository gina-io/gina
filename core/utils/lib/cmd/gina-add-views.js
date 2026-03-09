var AddViews;
var fs = require('fs');
var utils = require(__dirname + '/../../index');
var GINA_PATH = _( getPath('gina').core );
var Config = require( _( GINA_PATH + '/config') );
var readline = require('readline');
var rl = readline.createInterface(process.stdin, process.stdout);

AddViews = function(bundle, env) {
    var self = this;

    var init = function(bundle, env) {
        self.task = 'add-views';
        self.bundle = bundle;
        self.env = env;
        self.root = getPath('root');
        self.project = require(self.root + '/project.json').bundles[bundle];
        console.log('adding views for [ ' + bundle + ' ]');

        var config = new Config({
            env             : self.env,
            executionPath   : self.root,
            startingApp     : self.bundle,
            ginaPath        : GINA_PATH,
            task            : self.task
        });
        config.onReady( function onConfigReady(err, config) {
            if (err) {
                console.warn(err.stack);
            }

            self.src = config.conf[self.bundle][self.env].bundlePath;
            addConfFile()
        })
    }

    var addConfFile = function() {

        var file = new _(GINA_PATH +'/template/conf/views.json');
        var target = _(self.src + '/config/views.json');
        var folder = _(self.src + '/views');

        if ( fs.existsSync(target) || fs.existsSync(folder) ) {
            rl.setPrompt('Found views for [ '+ self.bundle +' ]. Do you want to override ? (yes|no) > ');
            rl.prompt();

            rl.on('line', function(line) {
                switch( line.trim().toLowerCase() ) {
                    case 'y':
                    case 'yes':
                        createFile(file, target)
                        break;
                    case 'n':
                    case 'no':
                        process.exit(0);
                        break;
                    default:
                        console.log('Please, write "yes" to proceed or "no" to cancel. ');
                        rl.prompt();
                        break;
                }
            }).on('close', function() {
                console.log('exiting views installation');
                process.exit(0)
            })

        } else {
            createFile(file, target)
        }

    }
    
    var createFile = function(file, target) {
        file.cp(target, function(err) {
            if (err) {
                console.log(err.stack);
                process.exit(1)
            }
            copyFolder()
        })
    }

    var copyFolder = function() {
        var folder = new _(GINA_PATH +'/template/views');
        var target = _(self.src + '/views');

        folder.cp(target, function(err){
            if (err) {
                console.log(err.stack);
                process.exit(1)
            }
            console.log('views installed with success !')
            process.exit(0)
        })
    }

    init(bundle, env)
};

module.exports = AddViews;