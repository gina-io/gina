var Class = function() {
    /**
     * Construct a Class from singleton to object
     *
     * Usage :
     *  var YourSingletonObject = {...};
     *  var YourClass = Utils.construct(YourSingletonObject);
     *
     * @param {object} Class
     * @param {boolean} [autoInit]
     *
     * @return {Object} instance - Class instance
     * */
    this.construct = function(Class, autoInit){
        var _this = this;
        return function() {
            //TODO - Check if exists before init.
            for (var prop in Class) {
                if ( Class.hasOwnProperty(prop) ){
                    this[prop] = Class[prop]
                }
            }
            //This one is optional.
            if (autoInit) {
                if (arguments.length > 0) {
                    this.init(arguments);
                } else {
                    this.init()
                }
            }

            return this
        }
    }
};