/**
 * {Bundle} Main handler
 */

// requires are put here
 
 var {Bundle}Handler = ( function on{Bundle}MainHandled() {
     var self                = {}
     ;
 
     var init = function() {
 
         // Define global handlers/bindings here
         
         handle();
     }
 
 
     var handle = function () {
         console.debug('Main {Bundle} handler loaded !');         
     };
     
     init();
 })();