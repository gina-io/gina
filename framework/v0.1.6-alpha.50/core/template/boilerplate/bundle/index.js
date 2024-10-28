/**
 * {Bundle} bundle
 *
 * */
//import sample
//var session = require('express-session');
var {bundle} = require('gina');

// gina lib samples
// var lib             = {bundle}.lib;
// var routing         = lib.routing;
// var console         = lib.logger;
// var operate         = lib.math.operate;
// var Collection      = lib.Collection;
// var SessionStore    = lib.SessionStore(session);
// var Domain          = lib.Domain;


// Do whatever things you need to do before server starts
// e.g.: register session, set a shared path for your template engine ...
// This is mostly pre-start configuration
//{bundle}.onInitialize( function(event, app, express){//
//    var self = {bundle};
//    // getting config/app.json would be: self.getConfig('app')
//    // or self.getConfig().app
//    var conf = self.getConfig();
//    // you can use express middleware components
//    // eg.: app.use( session({secret: '1234567890QWERTY'}) );
//
//    //then notify the server that startup sequence can be resumed
//    event.emit('complete', app);// this is important !
//});

// If you need to do something once the server has started
// e.g.: start a cron or a watcher
// {bundle}.onStarted(function(){
//     console.info('{bundle} has started ! ');
// });

// Catch unhandled errors
{bundle}.onError(function(err, req, res, next){
    console.error('[ BOOTSTRAP ] <{bundle}> fatal error: ' + err.message + '\nstack:\n'+ err.stack);
    next(err);
});

{bundle}.start();