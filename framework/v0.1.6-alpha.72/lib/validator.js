var helpers     = require('./../helpers');
var merge       = require('./merge');
var dateFormat  = helpers.dateFormat;

/**
 * @class Validator
 * Backend validator
 * e.g.:
 *  var data = req.post;
 *  var d = new Validator(data);
 *
 *  if ( data.count() > 0 ) {
 *      d.username
 *           .isRequired()
 *           .isString(0, 10)
 *           .isEmail();
 *  }
 *
 *  TODO - validate date against country_code or pattern yyyy-mm-dd
 *  dateObj
 *      [ .format('timestamp') ]
 *      .isDate('fr_FR')
 *
 * */
function Validator(data, errorLabels) {

    var local = {
        errors: {},
        keys: {
            '%n': 'label', // %f => field name
            '%s': 'size' // %l => length
        },
        errorLabels: {
            is: 'condition not satisfied',
            isEmail: '%n is not a valid email',
            isRequired: '%n is required',
            isBoolean: '%n is not a valid boolean',
            isNumber: '%n is not a number',
            isNumberLength: '%n must have %s characters',
            isNumberMinLength: '%n should be at least %s characters',
            isNumberMaxLength: '%n should not be more than %s characters',
            isInteger: '%n is not an integer',
            isIntegerLength: '%n must have %s characters',
            isIntegerMinLength: '%n should be at least %s characters',
            isIntegerMaxLength: '%n should not be more than %s characters',
            toInteger: '%n cannot be converted to an integer',
            isFloat: '%n is not a proper float',
            isFloatException: 'Exception found: %n',
            toFloat: '%n cannot be converted to a float',
            isDate: '%n is an invalid Date',
            isString: '%n must be an instance of a string',
            isStringLength: '%n must have %s characters',
            isStringMinLength: '%n should be at least %s characters',
            isStringMaxLength: '%n should not be more than %s characters'
        },
        data: {} // output to send
    };

    if (!data) {
        throw new Error('missing data param');
        return false
    } else {
        // cloning
        var self  = JSON.parse( JSON.stringify(data) );
        local.data = JSON.parse( JSON.stringify(data) )
    }

    if ( typeof(errorLabels) != 'undefined') {
        local.errorLabels = merge(errorLabels, local.errorLabels)
    }

    for (var el in self) {
        var val;
        if ( typeof(self[el]) == 'object' ) {
            try {
                val = JSON.parse( JSON.stringify( self[el] ))
            } catch (err) {
                val = self[el]
            }
        } else {
            val = self[el]
        }


        self[el] = {
            value: val,
            name: el,
            valid: false,
            // is name by default, but you should use setLabe(name) to change it if you need to
            label: el,
            // check as field to exclude while sending datas to the model
            exclude: false
        };

        /**
         *
         * is(regex)       -> validate if value matches regex
         *
         * @param {object|string} regex - RegExp oject or condition to eval
         *
         * */
        self[el].is = function(regex, flash) {
            var valid = true;
            if ( regex instanceof RegExp ) {
                valid = regex.test(this.value) ? true : false;
            } else {
                try {
                    valid = regex
                } catch (err) {
                    throw new Error(err.stack||err.message)
                }
            }

            this.valid = valid;
            if (!valid) {
                if ( !(local.errors[this.name]) )
                    local.errors[this.name] = {};

                local.errors[this.name].is = replace(this.error || flash || local.errorLabels.is, this)
            }

            return self[this.name]
        }

        self[el].isEmail = function() {
            this.value  = local.data[this.name] = this.value.toLowerCase();
            var rgx     = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
            var valid   = rgx.test(this.value) ? true : false;
            this.valid  = valid;

            if (!valid) {
                if ( !(local.errors[this.name]) )
                    local.errors[this.name] = {};

                local.errors[this.name].isEmail = replace(this.error || local.errorLabels.isEmail, this)
            }

            return self[this.name]
        }

        /**
         * Check if boolean and convert to `true/false` booloean if value is a string or a number
         * */
        self[el].isBoolean = function() {
            var val = null;
            switch(this.value) {
                case 'true':
                case true:
                case 1:
                    val = this.value = local.data[this.name] = true;
                    break;
                case 'false':
                case false:
                case 0:
                    val = this.value = local.data[this.name] = false;
                    break;
            }
            var valid = (val !== null) ? true : false;
            this.valid = valid;
            if (!valid) {
                if ( !(local.errors[this.name]) )
                    local.errors[this.name] = {};

                local.errors[this.name].isBoolean = replace(this.error || local.errorLabels.isBoolean, this)
            }
            return self[this.name]
        }

        /**
         * Check if value is an a Number. No transformation is done here.
         * */
        self[el].isNumber = function(minLength, maxLength) {
            var val = this.value
              , isValid = false
              , isMinLength = true
              , isMaxLength = true
            ;
            // if val is a string replaces comas by points
            if (typeof(val) == 'string' && /,/g.test(val)) {
                val = val.replace(/,/g, '.');
            }
            // test if val is a number
            if ( +val === +val ) {
                isValid = true;
                // if so also test max and min length if defined
                if (minLength && typeof(minLength) == 'number' && val.length < minLength) {
                    isMinLength = false;
                    this.size = minLength;
                }
                if (maxLength && typeof(maxLength) == 'number' && val.length > maxLength) {
                    isMaxLength = false;
                    this.size = maxLength;
                }
            }
            // if val is invalid return error message
            if ( !isValid || !isMinLength || !isMaxLength ) {
                if ( !local.errors[this.name] )
                    local.errors[this.name] = {};
                if ( !isValid )
                    local.errors[this.name].isNumber = replace(this.error || local.errorLabels.isNumber, this);
                if ( !isMinLength || !isMaxLength ) {
                    if ( !isMinLength )
                        local.errors[this.name].isNumberLength = replace(this.error || local.errorLabels.isNumberMinLength, this);
                    if ( !isMaxLength )
                        local.errors[this.name].isNumberLength = replace(this.error || local.errorLabels.isNumberMaxLength, this);
                    if ( minLength === maxLength )
                        local.errors[this.name].isNumberLength = replace(this.error || local.errorLabels.isNumberLength, this);
                }
                isValid = false;
            }
            this.valid = isValid;
            return self[this.name]
        }

        self[el].toInteger = function() {
            var val = this.value;

            if (!val) {
                return self[this.name]
            } else {
                try {
                    val = this.value = local.data[this.name] = ~~(val.match(/[0-9]+/g).join(''));
                } catch (err) {
                    if ( !(local.errors[this.name]) )
                        local.errors[this.name] = {};

                    local.errors[this.name].toInteger = replace(this.error || local.errorLabels.toInteger, this)
                }

            }
            return self[this.name]
        }

        self[el].isInteger = function(minLength, maxLength) {
            var val = this.value
              , isValid = false
              , isMinLength = true
              , isMaxLength = true
            ;
            // test if val is a number
            if ( +val === +val && val % 1 === 0 ) {
                isValid = true;
                // if so also test max and min length if defined
                if (minLength && typeof(minLength) == 'number' && val.length < minLength) {
                    isMinLength = false;
                    this.size = minLength;
                }
                if (maxLength && typeof(maxLength) == 'number' && val.length > maxLength) {
                    isMaxLength = false;
                    this.size = maxLength;
                }
            }
            // if val is invalid return error message
            if ( !isValid || !isMinLength || !isMaxLength ) {
                if ( !local.errors[this.name] )
                    local.errors[this.name] = {};
                if ( !isValid )
                    local.errors[this.name].isInteger = replace(this.error || local.errorLabels.isInteger, this);
                if ( !isMinLength || !isMaxLength ) {
                    if ( !isMinLength )
                        local.errors[this.name].isIntegerLength = replace(this.error || local.errorLabels.isIntegerMinLength, this);
                    if ( !isMaxLength )
                        local.errors[this.name].isIntegerLength = replace(this.error || local.errorLabels.isIntegerMaxLength, this);
                    if ( minLength === maxLength )
                        local.errors[this.name].isIntegerLength = replace(this.error || local.errorLabels.isIntegerLength, this);
                }
                isValid = false;
            }
            this.valid = isValid;
            return self[this.name]
        }


        self[el].toFloat = function(decimals) {
            var val = this.value;

            if (decimals) {
                this.decimals = parseInt(decimals)
            } else if ( typeof(this.decimals) == 'undefined' ) {
                this.decimals = 2
            }

            if (!val) {
                return self[this.name]
            } else {
                try {
                    val = this.value = local.data[this.name] = new Number(parseFloat(val.match(/[0-9.,]+/g).join('').replace(/,/, '.')));// Number <> number
                } catch (err) {
                    if ( !(local.errors[this.name]) )
                        local.errors[this.name] = {};

                    local.errors[this.name].toFloat = replace(this.error || local.errorLabels.toFloat, this)
                }
            }

            if (this.decimals && val) {
                this.value = local.data[this.name] = this.value.toFixed(this.decimals)
            }

            return self[this.name]
        }

        /**
         * Check if value is float. No transformation is done here.
         * Can be used in combo preceded by *.toFloat(2) to transform data if needed:
         *  1 => 1.0
         *  or
         *  3 500,5 => 3500.50
         *
         *
         * @param {number} decimals
         * */
        self[el].isFloat = function() {
            var val = this.value, isValid = false;

            // if string replaces comas by points
            if (typeof(val) == 'string' && /,/g.test(val)) {
                val = val.replace(/,/g, '.');
            }
            // test if val can be a number and if it is a float
            if ( Number(val) && val % 1 !== 0) {
                isValid = true;
            }

            this.valid = isValid;

            if (!isValid) {
                if ( !(local.errors[this.name]) ) {
                    local.errors[this.name] = {};
                }
                local.errors[this.name].isFloat = replace(this.error || local.errorLabels.isFloat, this)
            }

            return self[this.name]
        }

        self[el].isRequired = function() {
            var isValid = (typeof(this.value) != 'undefined' && this.value != null && this.value != '') ? true : false;

            this.valid = isValid;
            if (!isValid) {
                if ( !(local.errors[this.name]) )
                    local.errors[this.name] = {};

                local.errors[this.name].isRequired = replace(this.error || local.errorLabels.isRequired, this)
            }

            return self[this.name]
        }
        /**
         *
         * isString()       -> validate if value is string
         * isString(10)     -> validate if value is at least 10 chars length
         * isString(0, 45)  -> no minimum length, but validate if value is maximum 45 chars length
         *
         * @param {number|undefined} minLen
         * @param {number} [ maxLen ]
         * */
        self[el].isString = function(minLength, maxLength) {
            var val = this.value
              , isValid = false
              , isMinLength = true
              , isMaxLength = true
            ;
            // test if val is a string
            if ( typeof(val) == 'string' ) {
                isValid =  true;
                // if so also test max and min length if defined
                if (minLength && typeof(minLength) == 'number' && val.length < minLength) {
                    isMinLength = false;
                    this.size = minLength;
                }
                if (maxLength && typeof(maxLength) == 'number' && val.length > maxLength) {
                    isMaxLength = false;
                    this.size = maxLength;
                }
            }
            // if val is invalid return error message
            if ( !isValid || !isMinLength || !isMaxLength ) {
                if ( !local.errors[this.name] )
                    local.errors[this.name] = {};
                if ( !isValid )
                    local.errors[this.name].isString = replace(this.error || local.errorLabels.isString, this);
                if ( !isMinLength || !isMaxLength) {
                    if ( !isMinLength )
                        local.errors[this.name].isStringLength = replace(this.error || local.errorLabels.isStringMinLength, this);
                    if ( !isMaxLength )
                        local.errors[this.name].isStringLength = replace(this.error || local.errorLabels.isStringMaxLength, this);
                    if (minLength === maxLength)
                        local.errors[this.name].isStringLength = replace(this.error || local.errorLabels.isStringLength, this);
                }
                isValid = false
            }
            this.valid = isValid;
            return self[this.name]
        }

        /**
         * Check if date
         *
         * @param {string} [mask] - by default "yyyy-mm-dd"
         *
         * @returns {date} date - extended by gina::lib::helpers::dateFormat; an adaptation of Steven Levithan's code
         * */
        self[el].isDate = function(mask) {
            var val = this.value;
            if (!val) return self[this.name];

            var m = mask.match(/[^\/\- ]+/g);
            val = val.match(/[^\/\- ]+/g);
            var dic = {}, d, len;
            for (d=0, len=m.length; d<len; ++d) {
                dic[m[d]] = val[d]
            }
            var newMask = 'yyyy-mm-dd';
            for (var v in dic) {
                newMask = newMask.replace(new RegExp(v, "g"), dic[v])
            }

            var date = this.value = local.data[this.name] = new Date(newMask);

            this.valid = ( date instanceof Date ) ? true : false;

            if ( date instanceof Date  === false ) {
                local.errors[this.name].isDate = replace(this.error || local.errorLabels.isDate, this)
            }

            //return self[this.name]
            return date
        }

        /**
         * Formating date using DateFormatHelper
         * Check out documentation in the helper source: `lib/helpers/dateFormat.js`
         * e.g.:
         *      d.start
         *        .isDate('dd/mm/yyyy')
         *        .format('isoDateTime');
         *
         *
         * */
        self[el].format = function(mask, utc) {
            var val = this.value;
            if (!val) return self[this.name];

            return val.format(mask, utc)
        };

        /**
         * Set flash
         *
         * @param {str} flash
         * */
        self[el].setFlash = function(regex, flash) {
            if ( typeof(flash) != 'undefined' && flash != '') {
                this.error = flash
            }
            return self[this.name]
        }

        /**
         * Set label
         *
         * @param {str} label
         * */
        self[el].setLabel = function(label) {
            if ( typeof(label) != 'undefined' && label != '') {
                this.label = label
            }
            return self[this.name]
        }

        /**
         * Exclude when converting back to datas
         *
         * @returns {object} data
         * */
        self[el].exclude = function() {
            //if (!this.value) return self[this.name];
            //clonning
            for (var d in local.data) {
                if (d === this.name) { //cleaning
                    delete local.data[d]
                }
            }

            return self[this.name]
        }

    } // EO for (var el in self)

    /**
     * Check if errors found during validation
     *
     * @returns {boolean}
     * */
    self.isValid = function() {
        var i = local.errors.count();
        var valid = true;

        if (i > 0) {
            valid = false;
            // exporting errors
            self.errors = local.errors
        }

        return valid
    }

    self.toData = function() {
        return local.data
    }

    var replace = function(target, fieldObj) {
        var keys = target.match(/%[a-z]+/gi);
        if (keys) {
            for (var k=0; k<keys.length; ++k) {
                target = target.replace(new RegExp(keys[k], 'g'), fieldObj[local.keys[keys[k]]])
            }
        }
        return target
    }

    return self
};

module.exports = Validator;