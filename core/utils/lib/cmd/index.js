/*!
 * Gina.Utils.cmd
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, extend, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var fs      = require('fs');
var helpers = require('../../helpers');

var cmd = {},
    argCount = process.argv.length - 2;

cmd.option = [];
cmd.setOption = function(option){
    if (option instanceof Array) {
        for (var i=0; i<option.length; ++i) {
            cmd.option[option[i].name] = option[i].content;
        }
    } else {
        cmd.option[options.name] = option.content;
    }
};
cmd.getString = function() {
    var cmd = process.argv.toString()
            .replace(/,/g,' ')
            .replace(/node/g, 'gina');
    var cmdArr = cmd.split('/');
    cmd = cmdArr[cmdArr.length-1];
    return cmd;
};
cmd.getOption = function(name) {
    return cmd.option[name];
};

cmd.getOptions = function() {
    return cmd.option;
};

cmd.onExec = function() {
    cmd.msg = require( _(__dirname + '/msg.json') );

    var _this = this, ignore = function(){
        console.log(_this.msg.default[0].replace("%command%", cmd.getString()));
        return
    };

    if (argCount <= 0) {
        console.log("Command gina must have argument(s) !"
                +"\nTry this to get help: gina -h")
    } else if (argCount == 1) {
        var p = _(__dirname + '/basic.js');
        cmd.Basic = require(p).run(cmd.getOptions(), cmd.msg)
    } else if (argCount >= 2 && argCount <4 || argCount == 4) {
        var longcmd = (argCount>2) ? true : false;
        if (argCount == 4 && process.argv[2] != '-s' && process.argv[2] != '--start') {
            ignore()
        } else {
            var p = _(__dirname + '/app.js');
            cmd.App = require(p).run( cmd.getOptions(), cmd.msg, longcmd )
        }

    } else if ( process.argv[2] == '-s' && argCount > 2 || process.argv[2] == '--start' && argCount > 2 ) {
        var p = _(__dirname + '/app.js');
        cmd.App = require(p).run( cmd.getOptions(), cmd.msg, true )
    } else {
        ignore()
    }
};

cmd.load = function(root, package){

    //Setting root for helpers.
    setPath('root', root);

    //Getting package.
    var p = require( _(root + package) ),
        ginaPath = _(root + package.replace('/package.json', '')),
        middleware = fs.readFileSync(_(ginaPath + '/MIDDLEWARE')).toString() || 'none';


    cmd.setOption([
        {
            'name' : 'version',
            'content' : p.version
        },
        {
            'name' : 'copyright',
            'content' : p.copyright
        },
        {
            'name' : 'root',
            'content' : root
        },
        {
            'name' : 'core',
            'content' : _(ginaPath +'/core')
        },
        {
            'name' : 'middleware',
            'content': middleware
        }
    ]);

    //Set gina path.
    setPath('gina.root', ginaPath);
    setPath('gina.core', _(ginaPath +'/core'));
    setPath('gina.utils', _(ginaPath +'/core/utils/lib'));
    setPath('gina.utils', _(ginaPath +'/core/utils/lib'));
    setPath('gina.plugins', _(ginaPath +'/core/plugins/lib'));
    setPath('gina.documentation', _(ginaPath +'/documentation'));

    var defaultConf = require( _(ginaPath + '/core/template/conf/env.json') );
    //mountPath
    var bundlesPath = defaultConf['mountPath'];
    bundlesPath = _(bundlesPath.replace('{executionPath}', root));

    //Set path for the global tmp repertory.
    var gTmpPath = defaultConf['globalTmpPath'];
    gTmpPath = _(gTmpPath.replace('{executionPath}', root));

    var logsPath = defaultConf['logsPath'];
    logsPath = _(logsPath .replace('{executionPath}', root));

    //To make it globally accessible when you are in the gina process.
    var globalPaths = {
        "logsPath"      : logsPath,
        "globalTmpPath" : gTmpPath,
        "mountPath"     : bundlesPath
    };

    setPath(globalPaths);
    cmd.onExec()
};


cmd.respawn = function(){

};

module.exports = cmd;