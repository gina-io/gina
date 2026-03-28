function BindingHelper(handlerContext) {
    
    var self = {};
    if ( typeof(handlerContext) != 'undefined' ) {
        self = handlerContext
    }
    
    /**
     * process bindings
     * 
     * e.g.:
     * result.bindings = 
     * [
     *     // close current popin
     *     {
     *         call: 'closeActivePopin'
     *     },
     *     // mark notification as read
     *     {
     *         call: 'onNotification',
     *         payload: {
     *             id: obj.notificationId,
     *             action: 'mark-as-read'
     *         }
     *     },
     *     {
     *         handler: 'DocumentHandler', // targeting another handler
     *         call: 'notify' // this method must be public
     *     }
     * ]
     * 
     * @param {array} bindings
     * @param {number} [len]
     * @param {number} [i] 
     */
    self.process = function(bindings, len, i) {
        // handle errors first
        if ( typeof(bindings) == 'undefined' || !Array.isArray(bindings) ) {
            throw new Error('`bindings` must be a defined array')
        }
        if ( typeof(len) == 'undefined' ) {
            len = bindings.length;
            i = 0;
        }
        
        if ( !bindings[i] )
            return;
        
        var handleObject = bindings[i];
        if ( typeof(handleObject.call) == 'undefined' )
            throw new Error('`bindings.['+ i +'].call` is required !');
        
        if ( typeof(self[ handleObject.call ]) != 'function' ) 
            throw new Error('`bindingContext.'+ handleObject.call +'` is not a function');
        
        // process the collection
        var hCall = handleObject.call;
        delete handleObject.call;
        
        try {
            
            // !! targeted handler instance must be exposed to the window object
            if ( typeof(handleObject.handler) != 'undefined' ) {
                
                if ( !window[ handleObject.handler ] )
                    throw new Error('`'+ handleObject.handler +'` could not be reached. You must expose it to the `window` do object before any call.');
                
                var hHandler = handleObject.handler;
                delete handleObject.handler;
                
                window[ hHandler ].apply( this, Object.values(handleObject) );
                //restore
                handleObject.handler = hHandler
            } else { // by default, will go to main handler or the one listening to xhr results
                self[ hCall ].apply( this, Object.values(handleObject) );
            }            
            
            //restore
            handleObject.call = hCall;
        } catch (err) {
            console.error('BindingHelper encountered error while trying to execute `'+ hCall +'`' + err.stack || err);
        }
        
        self.process(bindings, len, i+1)
    }
    
    
    return self
}
// Publish as AMD module
define( function() { return BindingHelper })