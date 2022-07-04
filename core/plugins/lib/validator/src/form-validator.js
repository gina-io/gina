/**
 * FormValidatorUtil
 *
 * Dependencies:
 *  - utils/merge
 *  - utils/helpers
 *  - utils/helpers/dateFormat
 *
 * @param {object} data
 * @param {object} [ $fields ] - isGFFCtx only
 * */
function FormValidatorUtil(data, $fields) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;

    if (isGFFCtx && !$fields )
        throw new Error('No `Validator` instance found.\nTry:\nvar FormValidator = require("gina/validator"):\nvar formValidator = new FormValidator(...);')

    var merge           = (isGFFCtx) ? require('utils/merge') : require('../../../../utils/lib/merge');
    var helpers         = (isGFFCtx) ? {} : require('../../../../utils/helpers');
    var dateFormat      = (isGFFCtx) ? require('helpers/dateFormat') : helpers.dateFormat;

    var local = {
        'errors': {},
        'keys': {
            '%l': 'label', // %l => label: needs `data-gina-form-field-label` attribute (frontend only)
            '%n': 'name', // %n => field name
            '%s': 'size' // %s => length
        },
        'errorLabels': {},
        'data': {}, // output to send
        'excluded': []
    };

    local.errorLabels = {
        'is': 'Condition not satisfied',
        'isEmail': 'A valid email is required',
        'isRequired': 'Cannot be left empty',
        'isBoolean': 'Must be a valid boolean',
        'isNumber': 'Must be a number: allowed values are integers or floats',
        'isNumberLength': 'Must contain %s characters',
        'isNumberMinLength': 'Should be at least %s characters',
        'isNumberMaxLength': 'Should not be more than %s characters',
        'isInteger': 'Must be an integer',
        'isIntegerLength': 'Must have %s characters',
        'isIntegerMinLength': 'Should be at least %s characters',
        'isIntegerMaxLength': 'Should not be more than %s characters',
        'toInteger': 'Could not be converted to integer',
        'isFloat': 'Must be a proper float',
        'isFloatException': 'Float exception found: %n',
        'toFloat': 'Could not be converted to float',
        'toFloatNAN': 'Value must be a valid number',
        'isDate': 'Must be a valid Date',
        'isString': 'Must be a string',
        'isStringLength': 'Must have %s characters',
        'isStringMinLength': 'Should be at least %s characters',
        'isStringMaxLength': 'Should not be more than %s characters'
    };

    if (!data) {
        throw new Error('missing data param')
    } else {
        // cloning
        var self  = JSON.parse( JSON.stringify(data) );
        local.data = JSON.parse( JSON.stringify(data) )
    }


    var val = null, label = null;
    for (var el in self) {

        if ( typeof(self[el]) == 'object' ) {
            try {
                val = JSON.parse( JSON.stringify( self[el] ))
            } catch (err) {
                val = self[el]
            }
        } else {
            val = self[el]
        }

        label = '';
        if ( isGFFCtx && typeof($fields) != 'undefined' ) { // frontend only
            label = $fields[el].getAttribute('data-gina-form-field-label') || '';
        }

        // keys are stringyfied because of the compiler !!!
        self[el] = {
            'target': (isGFFCtx) ? $fields[el] : null,
            'name': el,
            'value': val,
            'valid': false,
            // is name by default, but you should use setLabe(name) to change it if you need to
            'label': label,
            // check as field to exclude while sending datas to the model
            'exclude': false
        };

        /**
         *
         * is(condition)       -> validate if value matches `condition`
         *
         *  When entered in a JSON rule, you must double the backslashes
         *
         *  e.g.:
         *       "/\\D+/"       -> like [^0-9]
         *       "!/^\\\\s+/"   -> not starting by white space allow
         *       "/^[0-9]+$/"   -> only numbers
         *       "$field === $fieldOther"   -> will be evaluated
         *
         * @param {object|string} condition - RegExp object, or condition to eval, or eval result
         * @param {string} [errorMessage] - error message
         * @param {string} [errorStack] - error stack
         *
         * */
        self[el]['is'] = function(condition, errorMessage, errorStack) {
            var valid   = false;
            var errors  = {};

            if ( /\$[-_\[\]a-z 0-9]+|^!\//i.test(condition) ) {

                var variables = condition.match(/\${0}[-_\[\]a-z0-9]+/ig); // without space(s)
                var compiledCondition = condition;
                var re = null
                for (var i = 0, len = variables.length; i < len; ++i) {
                    if ( typeof(self[ variables[i] ]) != 'undefined' && variables[i]) {
                        re = new RegExp("\\$"+ variables[i] +"(?!\\S+)", "g");
                        if ( self[ variables[i] ].value == "" ) {
                            compiledCondition = compiledCondition.replace(re, '"');
                        } else if ( typeof(self[ variables[i] ].value) == 'string' ) {
                            compiledCondition = compiledCondition.replace(re, '"'+ self[ variables[i] ].value +'"');
                        } else {
                            compiledCondition = compiledCondition.replace(re, self[ variables[i] ].value);
                        }
                    }
                }

                try {
                    // security checks
                    compiledCondition = compiledCondition.replace(/(\(|\)|return)/g, '');
                    valid = eval(compiledCondition+'.test("'+ this.value +'")')
                } catch (err) {
                    throw new Error(err.stack||err.message)
                }
            } else if ( condition instanceof RegExp ) {

                valid = condition.test(this.value) ? true : false;

            } else if( typeof(condition) == 'boolean') {

                valid = (condition) ? true : false;

            } else {
                try {
                    // TODO - motif /gi to pass to the second argument
                    valid = new RegExp(condition.replace(/\//g, '')).test(this.value)
                } catch (err) {
                    throw new Error(err.stack||err.message)
                }
            }

            if (!valid) {
                errors['is'] = replace(this.error || errorMessage || local.errorLabels['is'], this);
                if ( typeof(errorStack) != 'undefined' )
                    errors['stack'] = errorStack;
            }

            this.valid = valid;
            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this.name]
        }

        self[el]['isEmail'] = function() {


            this.value      = local['data'][this.name] = this.value.toLowerCase();

            var rgx         = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
            var isValid     = rgx.test(this['value']) ? true : false;
            var errors      = self[this['name']]['errors'] || {};

            if ( !errors['isRequired'] && this.value == '' ) {
                isValid = true;
            }

            if (!isValid) {
                errors['isEmail'] = replace(this['error'] || local.errorLabels['isEmail'], this)
            }

            this.valid = isValid;

            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this['name']]
        }

        /**
         * Check if boolean and convert to `true/false` booloean if value is a string or a number
         * Will include `false` value if isRequired
         * */
        self[el]['isBoolean'] = function() {
            var val     = null
                , errors = self[this['name']]['errors'] || {}
            ;

            if ( errors['isRequired'] && this.value == false ) {
                isValid = true;
                delete errors['isRequired'];
                this['errors'] = errors;
            }

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

            if (!valid) {
                errors['isBoolean'] = replace(this.error || local.errorLabels['isBoolean'], this)
            }

            this.valid = valid;
            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this.name]
        }

        /**
         * Check if value is an a Number.
         *  - valid if a number is found
         *  - cast into a number if a string is found
         *  - if string is blank, no transformation will be done: valid if not required
         *
         *  @param {number} minLength
         *  @param {number} maxLength
         *
         *  @return {object} result
         * */
        self[el]['isNumber'] = function(minLength, maxLength) {
            var val             = this.value
                , len           = 0
                , isValid       = false
                , isMinLength   = true
                , isMaxLength   = true
                , errors        = {}
                ;


            // test if val is a number
            try {
                // if val is a string replaces comas by points
                if ( typeof(val) == 'string' && /,/g.test(val) ) {
                    val = this.value = parseFloat( val.replace(/,/g, '.').replace(/\s+/g, '') );
                } else if ( typeof(val) == 'string' && val != '') {
                    val = this.value = parseInt( val );
                }

            } catch (err) {
                errors['isNumber'] = replace(this.error || local.errorLabels['isNumber'], this);
                this.valid = false;
                if ( errors.count() > 0 )
                    this['errors'] = errors;
            }

            if ( +val === +val ) {
                isValid = true;
                if ( !errors['isRequired'] && val != '' ) {
                    len = val.toString().length;
                    // if so also test max and min length if defined
                    if (minLength && typeof(minLength) == 'number' && len < minLength) {
                        isMinLength = false;
                        this['size'] = minLength;
                    }
                    if (maxLength && typeof(maxLength) == 'number' && len > maxLength) {
                        isMaxLength = false;
                        this['size'] = maxLength;
                    }
                }
            }

            // if val is invalid return error message
            if ( !isValid || !isMinLength || !isMaxLength ) {

                if ( !isValid )
                    errors['isNumber'] = replace(this.error || local.errorLabels['isNumber'], this);
                if ( !isMinLength || !isMaxLength ) {
                    if ( !isMinLength )
                        errors['isNumberLength'] = replace(this.error || local.errorLabels['isNumberMinLength'], this);
                    if ( !isMaxLength )
                        errors['isNumberLength'] = replace(this.error || local.errorLabels['isNumberMaxLength'], this);
                    if ( minLength === maxLength )
                        errors['isNumberLength'] = replace(this.error || local.errorLabels['isNumberLength'], this);
                }

                isValid = false;
            }

            this.valid = isValid;
            val = this.value = local.data[this.name] = ( val != '' ) ? Number(val) : val;
            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this.name]
        }

        self[el]['toInteger'] = function() {
            var val = this.value, errors = {};

            if (!val) {
                return self[this.name]
            } else {
                try {
                    //val = this.value = local.data[this.name] = ~~(val.match(/[0-9]+/g).join(''));
                    val = this.value = local.data[this.name] = Math.round(val);
                } catch (err) {

                    errors['toInteger'] = replace(this.error || local.errorLabels['toInteger'], this);
                    this.valid = false;
                    if ( errors.count() > 0 )
                        this['errors'] = errors;
                }

            }

            return self[this.name]
        }

        self[el]['isInteger'] = function(minLength, maxLength) {
            var val             = this.value
                , isValid       = false
                , isMinLength   = true
                , isMaxLength   = true
                , errors        = {}
                ;

            // test if val is a number
            if ( +val === +val && val % 1 === 0 ) {
                isValid = true;
                if ( !errors['isRequired'] && val != '' ) {
                    // if so also test max and min length if defined
                    if (minLength && typeof(minLength) == 'number' && val.length < minLength) {
                        isMinLength = false;
                        this['size'] = minLength;
                    }
                    if (maxLength && typeof(maxLength) == 'number' && val.length > maxLength) {
                        isMaxLength = false;
                        this['size'] = maxLength;
                    }
                }
            }
            // if val is invalid return error message
            if ( !isValid || !isMinLength || !isMaxLength ) {

                if ( !isValid )
                    errors['isInteger'] = replace(this.error || local.errorLabels['isInteger'], this);

                if ( !isMinLength || !isMaxLength ) {

                    if ( !isMinLength ) {
                        errors['isIntegerLength'] = replace(this.error || local.errorLabels['isIntegerMinLength'], this);
                        isValid = false;
                    }

                    if ( !isMaxLength ) {
                        errors['isIntegerLength'] = replace(this.error || local.errorLabels['isIntegerMaxLength'], this);
                        isValid = false;
                    }

                    if ( minLength === maxLength ) {
                        errors['isIntegerLength'] = replace(this.error || local.errorLabels['isIntegerLength'], this);
                        isValid = false;
                    }
                }
            }

            this.valid = isValid;
            val = this.value = local.data[this.name] = Number(val);

            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this.name]
        }


        self[el]['toFloat'] = function(decimals) {
            if ( typeof(this.value) == 'string' ) {
                this.value = this.value.replace(/\s+/g, '');
            }

            var val = this.value, errors = {}, isValid = true;

            if (decimals) {
                this['decimals'] = parseInt(decimals)
            } else if ( typeof(this['decimals']) == 'undefined' ) {
                this['decimals'] = 2
            }

            if (!val) {
                return self[this.name]
            } else {
                if ( this['isNumber']().valid ) {
                    try {

                        if ( !Number.isFinite(val) ) {
                            val = this.value = local.data[this.name] = new Number(parseFloat(val.match(/[0-9.,]+/g).join('').replace(/,/, '.')));// Number <> number
                        }

                        this.target.setAttribute('value', val);
                    } catch(err) {
                        isValid = false;
                        errors['toFloat'] = replace(this.error || local.errorLabels['toFloat'], this);
                        this.valid = false;
                        if ( errors.count() > 0 )
                            this['errors'] = errors;
                    }
                } else {
                    isValid = false;
                    errors['toFloat'] = replace(this.error || local.errorLabels['toFloatNAN'], this)
                }
            }

            if (this['decimals'] && val && !errors['toFloat']) {
                this.value = local.data[this.name] = parseFloat(this.value.toFixed(this['decimals']));
            }

            this.valid = isValid;
            if ( errors.count() > 0 )
                this['errors'] = errors;

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
         * @param {number} [ decimals ]
         *
         * TODO - decimals transformation
         * */
        self[el]['isFloat'] = function(decimals) {

            if ( typeof(this.value) == 'string' ) {
                this.value = this.value.replace(/\s+/g, '');
            }

            var val         = this.value
                , isValid   = false
                , errors    = {};


            if ( typeof(val) == 'string' && /\./.test(val) && Number.isFinite( Number(val) ) ) {
                isValid = true
            }

            // if string replaces comas by points
            if (typeof(val) == 'string' && /,/g.test(val)) {
                val =  this.value = local.data[this.name] = Number(val.replace(/,/g, '.'))
            }

            // test if val is strictly a float
            if ( Number(val) === val && val % 1 !== 0 ) {
                this.value = local.data[this.name] = Number(val);
                isValid = true
            } else {
                isValid = false
            }

            if ( !errors['isRequired'] && this.value == '' ) {
                isValid = true
            }

            if (!isValid) {
                errors['isFloat'] = replace(this.error || local.errorLabels['isFloat'], this)
            }

            this.valid = isValid;
            if ( errors.count() > 0 )
                this['errors'] = errors;

            return self[this.name]
        }

        self[el]['isRequired'] = function(isApplicable) {

            if ( typeof(isApplicable) == 'boolean' && !isApplicable ) {

                this.valid = true;

                return self[this.name]
            }

            // radio group case
            if ( isGFFCtx && this.target.tagName == 'INPUT' && typeof(this.target.type) != 'undefined' && this.target.type == 'radio' ) {
                var radios = document.getElementsByName(this.name);
                for (var i = 0, len = radios.length; i < len; ++i) {
                    if (radios[i].checked) {
                        if ( /true|false/.test(radios[i].value) ) {
                            this.value = local.data[this.name] = ( /true/.test(radios[i].value) ) ? true : false
                        } else {
                            this.value = local.data[this.name] = radios[i].value;
                        }

                        this.valid = true;
                        break;
                    }
                }
            }


            var isValid = ( typeof(this.value) != 'undefined' && this.value != null && this.value != '' && !/^\s+/.test(this.value) ) ? true : false;
            var errors  = {};


            if (!isValid) {
                errors['isRequired'] = replace(this.error || local.errorLabels['isRequired'], this)
            }

            this.valid = isValid;
            if (errors.count() > 0)
                this['errors'] = errors;

            return self[this.name]
        }
        /**
         *
         * isString()       -> validate if value is string
         * isString(10)     -> validate if value is at least 10 chars length
         * isString(0, 45)  -> no minimum length, but validate if value is maximum 45 chars length
         *
         * @param {number|undefined} [ minLength ]
         * @param {number} [ maxLength ]
         * */
        self[el]['isString'] = function(minLength, maxLength) {

            var val             = this.value
                , isValid       = false
                , isMinLength   = true
                , isMaxLength   = true
                , errors        = {}
                ;


            // test if val is a string
            if ( typeof(val) == 'string' ) {
                isValid = true;

                if ( !errors['isRequired'] && val != '' ) {
                    // if so also test max and min length if defined
                    if (minLength && typeof(minLength) == 'number' && val.length < minLength) {
                        isMinLength = false;
                        this['size'] = minLength;
                    }
                    if (maxLength && typeof(maxLength) == 'number' && val.length > maxLength) {
                        isMaxLength = false;
                        this['size'] = maxLength;
                    }
                }

            }

            // if val is invalid return error message
            if (!isValid || !isMinLength || !isMaxLength ) {

                if (!isValid && errors['isRequired'] && val == '') {
                    isValid = false;
                    errors['isString'] = replace(this['error'] || local.errorLabels['isString'], this);
                } else if (!isValid && !errors['isRequired']) {
                    isValid = true;
                }

                if ( !isMinLength || !isMaxLength) {
                    isValid = false;

                    if ( !isMinLength )
                        errors['isStringLength'] = replace(this['error'] || local.errorLabels['isStringMinLength'], this);
                    if ( !isMaxLength )
                        errors['isStringLength'] = replace(this['error'] || local.errorLabels['isStringMaxLength'], this);
                    if (minLength === maxLength)
                        errors['isStringLength'] = replace(this['error'] || local.errorLabels['isStringLength'], this);
                }

            }

            this.valid = isValid;
            if ( errors.count() > 0 )
                this['errors'] = errors;


            return self[this.name]
        }

        /**
         * Check if date
         *
         * @param {string} [mask] - by default "yyyy-mm-dd"
         *
         * @return {date} date - extended by gina::utils::dateFormat; an adaptation of Steven Levithan's code
         * */
        self[el]['isDate'] = function(mask) {
            var val         = this.value
                , isValid   = false
                , errors    = {}
                ;
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

            if ( date instanceof Date ) {
                isValid = true;
            } else {
                if ( !errors['isRequired'] && this.value == '' ) {
                    isValid = true
                } else {
                    errors['isDate'] = replace(this.error || local.errorLabels['isDate'], this);
                }

                this.valid = isValid;
                if ( errors.count() > 0 )
                    this['errors'] = errors;

                return self[this.name]
            }

            this.valid = isValid;

            return date
        }

        /**
         * Formating date using DateFormatHelper
         * Check out documentation in the helper source: `utils/helpers/dateFormat.js`
         * e.g.:
         *      d.start
         *        .isDate('dd/mm/yyyy')
         *        .format('isoDateTime');
         *
         *
         * */
        self[el]['format'] = function(mask, utc) {
            var val = this.value;
            if (!val) return self[this.name];

            return val.format(mask, utc)
        };

        /**
         * Set flash
         *
         * @param {str} flash
         * */
        self[el]['setFlash'] = function(regex, flash) {
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
        self[el]['setLabel'] = function(label) {
            if ( typeof(label) != 'undefined' && label != '') {
                this.label = label
            }
            return self[this.name]
        }

        /**
         * Exclude when converting back to datas
         *
         * @return {object} data
         * */
        self[el]['exclude'] = function(isApplicable) {

            if ( typeof(isApplicable) == 'boolean' && !isApplicable ) {

                local.data[this.name] = this.value;

                return self[this.name]
            }

            // list field to be purged
            local.excluded.push(this.name);
        }

    } // EO for (var el in self)

    /**
     * Check if errors found during validation
     *
     * @return {boolean}
     * */
    self['isValid'] = function() {

        var i = self['getErrors']().count();
        var valid = true;

        if (i > 0) {
            valid = false;
        }

        return valid
    }

    self['getErrors'] = function() {
        var errors = {};

        for (var field in self) {
            if ( typeof(self[field]) != 'function' && typeof(self[field]['errors']) != 'undefined' ) {
                if ( self[field]['errors'].count() > 0)
                    errors[field] = self[field]['errors'];
            }
        }

        return errors
    }

    self['toData'] = function() {

        // cleaning data
        if (local.excluded.length > 0) {
            for (var i = 0, len = local.excluded.length; i < len; ++i) {
                if ( typeof(local.data[ local.excluded[i] ]) != 'undefined' ) {
                    delete local.data[ local.excluded[i] ]
                }
            }
        }

        return local.data
    }

    var replace = function(target, fieldObj) {
        var keys = target.match(/%[a-z]+/gi);
        if (keys) {
            for (var k = 0, len = keys.length; k < len; ++k) {
                target = target.replace(new RegExp(keys[k], 'g'), fieldObj[local.keys[keys[k]]])
            }
        }

        return target
    }

    self['setErrorLabels'] = function (errorLabels) {
        if ( typeof(errorLabels) != 'undefined') {
            local.errorLabels = merge(errorLabels, local.errorLabels)
        }
    }

    return self
};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports  = FormValidatorUtil
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return FormValidatorUtil })
}