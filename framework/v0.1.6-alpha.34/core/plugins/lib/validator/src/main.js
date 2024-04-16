/**
 * ValidatorPlugin
 *
 * Dependencies:
 *  - lib/form-validator
 *  - lib/merge
 *  - utils/events
 *  - utils/data
 *  - vendor/uuid
 *
 * Additional helpers for the backend are located in framwework/v{version}/helpers/plugins/validator-*.js
 *
 *  At Form Level
 *      - data-gina-form-live-check-enabled
 *      - data-gina-form-required-before-submit
 *
 * @param {object} rule
 * @param {object} [ data ] // from request
 * @param {string} [ formId ]
 * */
 function ValidatorPlugin(rules, data, formId) {

    this.plugin = 'validator';

    /**
     * validator event handler - isGFFCtx only
     * */
    var events      = [
        'init', // form or popin init
        'ready',
        'registered',
        'success',
        'error',
        'progress',
        'submit',
        'reset',
        'change',
        'changed',
        'keydown', // for autocomplete
        'keyup', // for autocomplete
        'focusout',
        'focusin',
        'validate', // for form livecheck (validation)
        'validated', // for form livecheck (validation)
        'destroy',
        'asyncCompleted'
    ];

    // See: https://developer.mozilla.org/fr/docs/Web/HTML/Element/Input
    var allowedLiveInputTypes = [
        'radio',
        'checkbox',

        'text',
        'hidden',
        'password',
        'number', // not supporting float
        'date',
        'email',
        // extended types
        'search',
        'color',
        'tel',
        'range',
        'time',
        'datetime-local',
        'datetime', // deprecated
        'month',
        'week',
        'url'
    ];

    /** imports */
    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var envIsDev        = null;
    if (isGFFCtx) {
        require('utils/events');
        registerEvents(this.plugin, events);

        require('utils/dom');
        require('utils/effects');
        require('utils/data');

        envIsDev = gina.config.envIsDev;
    } else {
        envIsDev   = (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false;
        if (envIsDev) {
            delete require.cache[require.resolve('./form-validator')];
            delete require.cache[require.resolve('../../../../../helpers/data')];
        }

        require('../../../../../helpers/data');
    }

    var uuid            = (isGFFCtx) ? require('vendor/uuid') : require('uuid');
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../../../lib/merge');
    var inherits        = (isGFFCtx) ? require('lib/inherits') : require('../../../../../lib/inherits');
    var FormValidator   = (isGFFCtx) ? require('lib/form-validator') : require('./form-validator');
    //var Collection      = (isGFFCtx) ? require('lib/collection') : require('../../../../../lib/collection');
    var routing         = (isGFFCtx) ? require('lib/routing') : require('../../../../../lib/routing');

    /** definitions */
    var instance    = {
        'id'                : 'validator-' + uuid.v4(),

        'plugin'            : this.plugin,
        'on'                : (isGFFCtx) ? on : null,
        'eventData'         : {},
        'target'            : (isGFFCtx) ? document : null, // by default
        'errors'            : {},
        'initialized'       : false,
        'isReady'           : false,
        'rules'             : {},
        '$forms'            : {},
        'getFormById'       : null,
        'validateFormById'  : null,
        'setOptions'        : null,
        'resetErrorsDisplay': null,
        'resetFields'       : null
    };

    // validator proto
    var $validator      = { // isGFFCtx only
        'id'                    : null, // form id

        'plugin'                : this.plugin,
        'on'                    : (isGFFCtx) ? on : null,
        'eventData'             : {},
        'target'                : (isGFFCtx) ? document : null, // by default
        'cachedErrors'          : {},
        'binded'                : false,
        'unbinded'              : false,
        'withUserBindings'      : false,
        'rules'                 : {},
        'setOptions'            : null,
        'send'                  : null,
        'isValidating'          : null,
        'isSubmitting'          : null,
        'submit'                : null,
        'destroy'               : null,
        'resetErrorsDisplay'    : null,
        'resetFields'           : null
    };
    /**@js_externs local*/
    var local = {
        'rules': {}
    };

    var keyboardMapping = {};

    /**
     * XML Request - isGFFCtx only
     * */
    var xhr         = null;
    var xhrOptions  = {
        'url'           : '',
        'method'        : 'GET',
        'isSynchrone'   : false,
        'withCredentials': false,
        'headers'       : {
            // to upload, use `multipart/form-data` for `enctype`
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
            'X-Requested-With': 'XMLHttpRequest' // in case of cross domain origin

        }
    };

    /**
     * backend definitions
     * */
    var setCustomRules = function (customRules) {
        // parsing rules
        if ( typeof(customRule) != 'undefined' ) {
            try {
                parseRules(customRule, '');
                customRule = checkForRulesImports(customRule);
            } catch (err) {
                throw err
            }
        }
    }

    var backendProto = {
        'setCustomRules': setCustomRules
    };


    /**
     * Backend init
     *
     * @param {object} rules
     * @param {object} [customRule]
     * */
    var backendInit = function (rules, data, formId) {

        var $form = ( typeof(formId) != 'undefined' ) ? { 'id': formId } : null;
        var fields = {};

        for (var field in data) {
            fields[field] = data[field]
        }


        // parsing rules
        if ( typeof(rules) != 'undefined' && rules.count() > 0 ) {

            try {
                parseRules(rules, '');
                rules = checkForRulesImports(rules);
            } catch (err) {
                throw err
            }

            backendProto.rules = instance.rules;

            return validate($form, fields, null, instance.rules)

        } else {
            // without rules - by hand
            return new FormValidator(fields)
        }
    }


    /**
     * GFF definitions
     * */
    var setOptions = function (options) {
        options = merge(options, xhrOptions);
        xhrOptions = options;
    }


    var getFormById = function(formId) {
        var $form = null, _id = formId;

        if ( !instance['$forms'] )
            throw new Error('`$forms` collection not found');

        if ( typeof(_id) == 'undefined') {
            throw new Error('[ FormValidator::getFormById(formId) ] `formId` is missing')
        }

        _id = _id.replace(/\#/, '');

        // in case form is created on the fly and is not yet registered
        if (document.getElementById(_id) != null && typeof (instance['$forms'][_id]) == 'undefined') {
            initForm( document.getElementById(_id) );
        }

        if ( typeof(instance.$forms[_id]) != 'undefined' ) {
            instance['$forms'][_id].withUserBindings = true;

            if ( typeof(this.$forms) != 'undefined' && typeof(this.$forms[_id]) == 'undefined' ) {
                $form = this.$forms[_id] = instance['$forms'][_id];
            } else {
                $form = instance.$forms[_id];
            }
        }

        if (!$form) {
            throw new Error('Validator::getFormById(...) exception: could not retrieve form `'+ _id +'`');
        }

        if ( !$form.binded) {
            var $target = $form.target;
            bindForm($target);
            $form = instance.$forms[_id];
        }



        // update toolbar
        if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
            // update toolbar
            if (!gina.forms.errors)
                gina.forms.errors = {};

            var objCallback = {
                id      : _id,
                rules   : instance.$forms[_id].rules
            };
            if ( typeof(instance.$forms[_id].errors) != 'undefined' ) {
                objCallback.errors = instance.$forms[_id].errors
            }

            window.ginaToolbar.update('forms', objCallback);
        }

        return $form;
    }

    /**
     * isPopinContext
     *
     * @returns {boolean} isPopinContext
     */
    var isPopinContext = function() {
        var isPopinInUse = false, $activePopin = null;

        if ( gina.hasPopinHandler && gina.popinIsBinded ) {
            $activePopin = gina.popin.getActivePopin();
        }

        if ( $activePopin && $activePopin.isOpen ) {
            isPopinInUse = true;
        }

        return isPopinInUse;
    }


    /**
     * validateFormById
     *
     * @param {string} formId
     * @param {object} [customRule]
     *
     * @returns {object} $form
     * */
    var validateFormById = function(formId, customRule) {
        var $form = null
            , _id = formId
            , rules = ( typeof(local.rules.count() > 0 ) ) ? local.rules : instance.rules
            , $target = null
        ;

        if ( !instance['$forms'] ) {
            throw new Error('`$forms` collection not found')
        }
        // Return existing when available
        if ( typeof(_id) != 'undefined' && typeof(instance.$forms[_id]) != 'undefined' ) {
            return instance.$forms[_id];
        }

        if ( typeof(_id) == 'undefined' ) {
            if ( typeof(this.id) != 'undefined' && this.id != '' && this.id != null ) {
                _id = this.id
            } else {
                throw new Error('[ FormValidator::validateFormById(formId, customRule) ] `formId` is missing')
            }
        }

        if ( typeof(_id) == 'string') {
            _id = _id.replace(/\#/, '')
        } else if ( typeof(_id) == 'object' && !Array.isArray(_id) ) { // weird exception

            $target = _id.form;
            _id = $target.getAttribute('id') || 'form.'+uuid.v4();

            $target.setAttribute('id', _id);// just in case

        } else {
            throw new Error('[ FormValidator::validateFormById(formId[, customRule]) ] `formId` should be a `string`');
        }

        checkForDuplicateForm(_id);

        if ( typeof(this.$forms) != 'undefined' && typeof(instance['$forms'][_id]) != 'undefined' ) {
            $form   = this.$forms[_id] = instance['$forms'][_id];
        } else { // binding a form out of context (outside of the main instance)
            $target             = document.getElementById(_id);
            $validator.id           = _id;
            $validator.target       = $target;

            $form = this.$forms[_id] = instance.$forms[_id] = merge({}, $validator);

            var rule    = null;
            if ( typeof(customRule) == 'undefined') {
                rule = _id.replace(/\-/g, '.');

                if ( typeof(rules) != 'undefined' ) {
                    $form['rule'] = customRule = getRuleObjByName(rule)
                } else if ( typeof($form.target) != 'undefined' && $form.target !== null && $form.target.getAttribute('data-gina-form-rule') ) {
                    rule = $form.target.getAttribute('data-gina-form-rule').replace(/\-|\//g, '.');

                    if ( typeof(rules) != 'undefined' ) {
                        $form['rule'] = getRuleObjByName(rule)
                    } else {
                        throw new Error('[ FormValidator::validateFormById(formId) ] using `data-gina-form-rule` on form `'+$form.target+'`: no matching rule found')
                    }
                } // no else to allow form without any rule
            } else {
                rule = customRule.replace(/\-|\//g, '.');

                if ( typeof(rules) != 'undefined' ) {
                    $form['rule'] = getRuleObjByName(rule)
                } else {
                    throw new Error('[ FormValidator::validateFormById(formId, customRule) ] `'+customRule+'` is not a valid rule')
                }
            }

            if ( $target && typeof(this.isPopinContext) != 'undefined' && /true/i.test(this.isPopinContext) ) {
                $target.isPopinContext = this.isPopinContext;
            }

            if ($target && !$form.binded)
                bindForm($target, rule);
        }



        if (!$form) throw new Error('[ FormValidator::validateFormById(formId, customRule) ] `'+_id+'` not found');

        return $form || null;

    }

    var refreshWarning = function($el) {
        var formId = $el.form.getAttribute('id');
        if ( /^true$/i.test(instance.$forms[formId].isValidating) ) {
            return;
        }

        var $parent = $el.parentNode, isErrorMessageHidden = false;
        var $children = $parent.getElementsByTagName('div');

        if ( /form\-item\-warning/.test($parent.className) ) {
            $parent.className = $parent.className.replace(/form\-item\-warning/, 'form-item-error');

        } else if (/form\-item\-error/.test($parent.className) ) {
            $parent.className = $parent.className.replace(/form\-item\-error/, 'form-item-warning');
            isErrorMessageHidden = true;
        }


        for (var c = 0, cLen = $children.length; c<cLen; ++c) {
            if ( /form\-item\-error\-message/.test($children[c].className) ) {
                if (isErrorMessageHidden) {
                    // hide error messages
                    $children[c].className = $children[c].className +' hidden';
                } else {
                    // display error messages
                    $children[c].className = $children[c].className.replace(/(\s+hidden|hidden)/, '');
                }
                break
            }
        }
    }

    /**
     * handleErrorsDisplay
     * Attention: if you are going to handle errors display by hand, set data to `null` to prevent Toolbar refresh with empty data
     * @param {object} $form - Target (HTMLFormElement)
     * @param {object} errors
     * @param {object|null} data
     * @param {object|null} [fileName]
     */
    var liveCheckErrors = {}; // Per Form & Per Element
    var handleErrorsDisplay = function($form, errors, data, fieldName) {

        // Toolbar errors display
        if ( envIsDev )
            var formsErrors = null;

        var errorClass  = 'form-item-error' // by default
            , isWarning = false
        ;
        // catch reset
        if (
            typeof($form.dataset.ginaFormIsResetting) != 'undefined'
            && /^(true)$/i.test($form.dataset.ginaFormIsResetting)
        ) {
            errors = {};
            liveCheckErrors = {};
            // restore default
            $form.dataset.ginaFormIsResetting = false;
        } else {
            // Live check enabled ?
            if (
                /^(true)$/i.test($form.dataset.ginaFormLiveCheckEnabled)
                && typeof(fieldName) != 'undefined'
            ) {
                var formId = ( typeof($form.id) != 'string' ) ? $form.getAttribute('id') : $form.id;
                if ( typeof(liveCheckErrors[formId]) == 'undefined') {
                    liveCheckErrors[formId] = {};
                }
                if (errors.count() > 0) {
                    // reset field name
                    liveCheckErrors[formId][fieldName] = {};
                    // override
                    liveCheckErrors[formId][fieldName] = merge(errors[fieldName], liveCheckErrors[formId][fieldName]);
                    if (liveCheckErrors[formId][fieldName].count() == 0) {
                        delete liveCheckErrors[formId][fieldName]
                    }
                    errors = liveCheckErrors[formId];
                    // only if the form has not been sent yet
                    if (!instance.$forms[formId].sent || instance.$forms[formId].isValidating) {
                        isWarning = true;
                    }
                } else {
                    if ( typeof(liveCheckErrors[formId][fieldName]) != 'undefined') {
                        delete liveCheckErrors[formId][fieldName];
                        if (
                            typeof(window.gina.validator.$forms[formId].errors) != 'undefined'
                            && typeof(window.gina.validator.$forms[formId].errors[fieldName]) != 'undefined'
                        ) {
                            delete window.gina.validator.$forms[formId].errors[fieldName];
                        }
                    }
                    if (
                        typeof(instance.$forms) != 'undefined'
                        && typeof(instance.$forms[formId]) != 'undefined'
                        && typeof(instance.$forms[formId].errors) != 'undefined'
                        && instance.$forms[formId].errors.count() == 0
                        ||
                        typeof(instance.$forms) != 'undefined'
                        && typeof(instance.$forms[formId]) != 'undefined'
                        && !instance.$forms[formId].errors
                    ) {
                        // update submit trigger state
                        updateSubmitTriggerState( $form, true );
                    }

                    if ( typeof(liveCheckErrors[formId]) != 'undefined' && liveCheckErrors[formId].count() == 0 ) {
                        delete liveCheckErrors[formId]
                    } else {
                        errors = liveCheckErrors[formId];
                    }


                }
            }
        }


        var name    = null, errAttr = null;
        var $err    = null, $msg = null;
        var $el     = null, $parent = null, $target = null;
        var id      = $form.getAttribute('id');
        // TODO - Refacto on this may be done later since we are doing nothing with it
        data    = ( typeof(data) != 'undefined' ) ? data : {};

        for (var i = 0, len = $form.length; i<len; ++i) {

            $el     = $form[i];

            if (typeof(fieldName) != 'undefined' && fieldName != $el.name) continue;

            if ( /form\-item\-wrapper$/.test($el.parentNode.className) ) {
                $parent = $el.parentNode.parentNode;
                $target = $el.parentNode;
            } else {
                $parent = $el.parentNode;
                $target = $el;
            }

            name    = $el.getAttribute('name');
            errAttr = $el.getAttribute('data-gina-form-errors');

            if (!name) continue;

            if ( typeof(errors[name]) != 'undefined' && !/(form\-item\-error|form\-item\-warning)/.test($parent.className) ) {

                if (isWarning) {
                    // adding warning class
                    $parent.className += ($parent.className == '' ) ? 'form-item-warning' : ' form-item-warning';
                } else {
                    //$parent.className = $parent.className.replace(/(\s+form\-item\-warning|form\-item\-warning)/, '');
                    $parent.className += ($parent.className == '' ) ? 'form-item-error' : ' form-item-error';
                }
                $err = document.createElement('div');
                if (isWarning) {
                    //$err.setAttribute('class', 'form-item-error-message hidden');
                    $err.className = 'form-item-error-message hidden';
                } else {
                    //$err.setAttribute('class', 'form-item-error-message');
                    $err.className = 'form-item-error-message';
                }

                // injecting error messages
                for (var e in errors[name]) {

                    if (e != 'stack') { // ignore stack for display
                        $msg = document.createElement('p');
                        $msg.appendChild( document.createTextNode(errors[name][e]) );
                        $err.appendChild($msg);
                    }

                    if ( envIsDev ) {
                        if (!formsErrors) formsErrors = {};
                        if ( !formsErrors[ name ] )
                            formsErrors[ name ] = {};

                        formsErrors[ name ][e] = errors[name][e]
                    }
                }

                if ($target.type != 'hidden')
                    insertAfter($target, $err);



            } else if ( typeof(errors[name]) == 'undefined' && /(form\-item\-error|form\-item\-warning)/.test($parent.className) || typeof(errors[name]) != 'undefined' && errors[name].count() == 0 && /(form\-item\-error|form\-item\-warning)/.test($parent.className) ) {
                // reset when not in error
                // remove child elements
                var $children = $parent.getElementsByTagName('div');
                for (var c = 0, cLen = $children.length; c<cLen; ++c) {
                    if ( /form\-item\-error\-message/.test($children[c].className) ) {
                        $children[c].parentElement.removeChild($children[c]);
                        break
                    }

                }

                $parent.className = $parent.className.replace(/(\s+form\-item\-error|form\-item\-error|\s+form\-item\-warning|form\-item\-warning)/, '');

            } else if ( typeof(errors[name]) != 'undefined' && errAttr) {
                // refreshing already displayed error on msg update
                var $divs = $parent.getElementsByTagName('div');
                for (var d = 0, dLen = $divs.length; d<dLen; ++d) {
                    if ($divs[d].className == 'form-item-error-message') {

                        $divs[d].parentElement.removeChild($divs[d]);
                        $err = document.createElement('div');
                        $err.setAttribute('class', 'form-item-error-message');

                        // injecting error messages
                        // {
                        //     field: {
                        //         rule: errorMsg
                        //     }
                        // }
                        for (var e in errors[name]) {
                            $msg = document.createElement('p');
                            $msg.appendChild( document.createTextNode(errors[name][e]) );
                            $err.appendChild($msg);

                            if ( envIsDev ) {
                                if (!formsErrors) formsErrors = {};
                                if ( !formsErrors[ name ] )
                                    formsErrors[ name ] = {};

                                formsErrors[ name ][e] = errors[name][e]
                            }
                        }

                        break;
                    }
                }

                if ($err && $target.type != 'hidden')
                    insertAfter($target, $err);

            }

            if (typeof(fieldName) != 'undefined' && fieldName === $el.name) break;
        }


        var objCallback = null;
        if ( formsErrors ) {

            triggerEvent(gina, $form, 'error.' + id, errors)

            if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                // update toolbar
                if (!gina.forms.errors)
                    gina.forms.errors = {};

                objCallback = {
                    id      : id,
                    errors  : formsErrors
                };

                window.ginaToolbar.update('forms', objCallback);
            }
        } else if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar) { // reset toolbar form errors
            if (!gina.forms.errors)
                gina.forms.errors = {};

            objCallback = {
                id: id,
                errors: {}
            };
            if (isGFFCtx)
                window.ginaToolbar.update('forms', objCallback);
        }

        if (
            gina
            && isGFFCtx
            && envIsDev
            && instance.$forms[id].isSubmitting
            && /^true$/i.test(instance.$forms[id].isSubmitting)
            && typeof(window.ginaToolbar) != 'undefined'
            && window.ginaToolbar
            && data
        ) {

            try {
                // update toolbar
                window.ginaToolbar.update('data-xhr', data);

            } catch (err) {
                throw err
            }
        }

    }


    /**
     * Reset errors display
     *
     * @param {object|string} $formOrFormId [$formInstance|$formInstance.target|$formInstance.id]
     *
     * */
    var resetErrorsDisplay = function($formOrFormId) {
        var _id = null, $form = null;
        if ( typeof($formOrFormId) == 'undefined' && typeof(this.id) != 'undefined' ) {
            $formOrFormId = this.id;
        }
        if ( /^string$/i.test(typeof($formOrFormId)) ) {
            _id = $formOrFormId.replace(/\#/, '');
            $form = document.getElementById(_id);
        } else if ( $formOrFormId instanceof HTMLFormElement ) {
            $form = $formOrFormId
        } else if ( /^object$/i.test(typeof($formOrFormId)) ) {
            $form = $formOrFormId.target;
        }

        if (!$form) {
            throw new Error('[ FormValidator::resetErrorsDisplay([ formId | <form> ]) ] `'+$formOrFormId+'` not found')
        }

        // Resetting error display
        $form.dataset.ginaFormIsResetting = true;
        handleErrorsDisplay($form, {});


        return $form
    }

    /**
     * Reset fields
     *
     * @param {object|string} [$form|formId]
     *
     * */
    var resetFields = function($form) {
        var _id = null;
        if ( typeof($form) == 'undefined' ) {
            if ( typeof(this.target) != 'undefined' ) {
                _id = this.target.getAttribute('id');
            } else {
                _id = this.getAttribute('id');
            }

            $form = instance.$forms[_id]
        } else if ( typeof($form) == 'string' ) {
            _id = $form;
            _id = _id.replace(/\#/, '');

            if ( typeof(instance.$forms[_id]) == 'undefined') {
                throw new Error('[ FormValidator::resetErrorsDisplay([formId]) ] `'+$form+'` not found')
            }

            $form = instance.$forms[_id]
        }

        if ($form.fieldsSet) {

            var elId            = null
                , $element      = null
                , tagName       = null
                , type          = null
                , value         = null // current value
                , defaultValue  = null
            ;

            for (var f in $form.fieldsSet) {

                $element    = document.getElementById(f);
                type        = $element.tagName.toLowerCase();
                tagName     = $element.tagName;

                if ( /textarea/i.test(tagName) ) {
                    defaultValue = $form.fieldsSet[f].defaultValue;
                    $element.value = defaultValue;
                    triggerEvent(gina, $element, 'change');
                    continue;
                }

                if (type == 'input') {

                    defaultValue = $form.fieldsSet[f].defaultValue;

                    if (/$(on|true|false)$/i.test(defaultValue)) {
                        defaultValue = (/$(on|true)$/i.test(defaultValue)) ? true : false;
                    }

                    if ( /^(checkbox|radio)$/i.test($element.type) ) {
                        $element.checked = $form.fieldsSet[f].defaultChecked;
                    } else if ( !/^(checkbox|radio)$/i.test($element.type) ) {
                        $element.value = defaultValue;
                    }
                    triggerEvent(gina, $element, 'change');

                } else if ( type == 'select' ) {
                    defaultValue = $form.fieldsSet[f].selectedIndex || 0;
                    $element.selectedIndex = defaultValue;
                    $element.dataset.value = $element.options[ $element.selectedIndex ].value;
                    triggerEvent(gina, $element, 'change');
                }

            }
        }

        return $form
    }

    var submit = function () {

        var $form = null, _id = null, $target = null;

        if ( typeof(this.getAttribute) != 'undefined' ) {
            _id = this.getAttribute('id');
            $target = this;
        } else if ( typeof(this.target) != 'undefined' && this.target != null && typeof(this.target.getAttribute) != 'undefined' ) {
            _id = this.target.getAttribute('id');
            $target = this.target
        }

        if ( typeof(instance.$forms[_id]) == 'undefined') {
            throw new Error('[ FormValidator::submit() ] not `$form` binded. Use `FormValidator::getFormById(id)` or `FormValidator::validateFormById(id)` first ')
        }

        triggerEvent(gina, $target, 'submit');

        return this;
    }



    /**
     * send
     * N.B.: no validation here; if you want to validate against rules, use `.submit()` or `.validateFormById(formId)` before
     *
     *
     * @param {object} data - FormData object (https://developer.mozilla.org/en-US/docs/Web/API/FormData/Using_FormData_Objects)
     * @param {object} [ options ] : { isSynchrone: true, withCredentials: true }
     * */
    var send = function(data, options) {


        var $target = this.target , id = $target.getAttribute('id');
        var $form   = instance.$forms[id] || this;
        var result  = null;
        var XHRData = null;
        var isAttachment = null; // handle download
        var hFormIsRequired = null;

        if (
            typeof($form.isSending) != 'undefined'
            && /^true$/i.test($form.isSending)
            ||
            typeof($form.sent) != 'undefined'
            && /^true$/i.test($form.sent)
        ) {
            return;
        }
        instance.$forms[id].isSending = true;


        options = (typeof (options) != 'undefined') ? merge(options, xhrOptions) : xhrOptions;
        // `x-gina-form`definition
        //options.headers['X-Gina-Form-Location'] = gina.config.bundle;
        if ( typeof($form.id) != 'undefined' ) {
            options.headers['X-Gina-Form-Id'] = $form.id;
            if (
                typeof(gina.forms.rules) != 'undefined'
                && $form.rules.count() > 0
                && typeof($form.rules[$form.id]) != 'undefined'
            ) {
                options.headers['X-Gina-Form-Rule'] = $form.id +'@'+ gina.config.bundle;
            }
        }
        // if ( typeof($form.name) != 'undefined' ) {
        //     options.headers['X-Gina-Form-Name'] = $form.name;
        // }
        if ( typeof($form.target.dataset.ginaFormRule) != 'undefined' ) {
            options.headers['X-Gina-Form-Rule'] = $form.target.dataset.ginaFormRule +'@'+ gina.config.bundle;
        }

        if (isPopinContext()) {
            // select popin current active popin
            $activePopin = gina.popin.getActivePopin();
            if ( $activePopin.isOpen ) {
                if ( typeof($activePopin.id) != 'undefined' )
                    options.headers['X-Gina-Popin-Id'] = $activePopin.id;

                if ( typeof($activePopin.name) != 'undefined' )
                    options.headers['X-Gina-Popin-Name'] = $activePopin.name;
            }
        }


        // forward callback to HTML data event attribute through `hform` status
        hFormIsRequired = ( $target.getAttribute('data-gina-form-event-on-submit-success') || $target.getAttribute('data-gina-form-event-on-submit-error') ) ? true : false;
        // success -> data-gina-form-event-on-submit-success
        // error -> data-gina-form-event-on-submit-error
        if (hFormIsRequired)
            listenToXhrEvents($form);

        var url         = $target.getAttribute('action') || options.url;
        var method      = $target.getAttribute('method') || options.method;
        method          = method.toUpperCase();
        options.method  = method;
        options.url     = url;

        if (!xhr) {
            xhr = setupXhr(options);
        }

        // to upload, use `multipart/form-data` for `enctype`
        var enctype = $target.getAttribute('enctype') || options.headers['Content-Type'];


        if ( options.withCredentials ) {

            if ('withCredentials' in xhr) {
                // XHR for Chrome/Firefox/Opera/Safari.
                if (options.isSynchrone) {
                    xhr.open(options.method, options.url, options.isSynchrone)
                } else {
                    xhr.open(options.method, options.url)
                }
            } else if ( typeof XDomainRequest != 'undefined' ) {
                // XDomainRequest for IE.
                xhr = new XDomainRequest();
                xhr.open(options.method, options.url);
            } else {
                // CORS not supported.
                xhr = null;
                result = 'CORS not supported: the server is missing the header `"Access-Control-Allow-Credentials": true` ';
                triggerEvent(gina, $target, 'error.' + id, result);

                return
            }

            if ( typeof(options.responseType) != 'undefined' ) {
                xhr.responseType = options.responseType;
            } else {
                xhr.responseType = '';
            }

            xhr.withCredentials = true;
        } else {
            if (options.isSynchrone) {
                xhr.open(options.method, options.url, options.isSynchrone)
            } else {
                xhr.open(options.method, options.url)
            }
        }

        // setting up headers -    all but Content-Type ; it will be set right before .send() is called
        for (var hearder in options.headers) {
             //if ( hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '') {
             //    options.headers[hearder] = enctype
             //}
            if (hearder == 'Content-Type' && typeof (enctype) != 'undefined' && enctype != null && enctype != '')
                continue;

            xhr.setRequestHeader(hearder, options.headers[hearder]);
        }

        if (xhr) {
            // catching ready state cb
            //handleXhrResponse(xhr, $target, id, $form, hFormIsRequired);
            xhr.onreadystatechange = function onValidationCallback(event) {
                $form.isSubmitting = false;
                $form.isSending = false;

                // limit send trigger to 1 sec to prevent from double clicks
                setTimeout( function onSent() {
                    $form.sent = false;
                }, 1000);

                // In case the user is also redirecting
                var redirectDelay = (/Google Inc/i.test(navigator.vendor)) ? 50 : 0;

                if (xhr.readyState == 2) { // responseType interception
                    isAttachment    = ( /^attachment\;/.test( xhr.getResponseHeader("Content-Disposition") ) ) ? true : false;
                    // force blob response type
                    if ( !xhr.responseType && isAttachment ) {
                        xhr.responseType = 'blob';
                    }
                }

                if (xhr.readyState == 4) {
                    var $popin          = null;
                    var blob            = null;
                    var contentType     = xhr.getResponseHeader("Content-Type");

                    // 200, 201, 201' etc ...
                    if( /^2/.test(xhr.status) ) {

                        try {

                            // handling blob xhr download
                            if ( /blob/.test(xhr.responseType) || isAttachment ) {
                                if ( typeof(contentType) == 'undefined' || contentType == null) {
                                    contentType = 'application/octet-stream';
                                }

                                blob = new Blob([this.response], { type: contentType });

                                //Create a link element, hide it, direct it towards the blob, and then 'click' it programatically
                                var a = document.createElement('a');
                                a.style = "display: none";
                                document.body.appendChild(a);
                                //Create a DOMString representing the blob and point the link element towards it
                                var url = window.URL.createObjectURL(blob);
                                a.href = url;
                                var contentDisposition = xhr.getResponseHeader("Content-Disposition");
                                a.download = contentDisposition.match('\=(.*)')[0].substr(1);
                                //programatically click the link to trigger the download
                                a.click();

                                //release the reference to the file by revoking the Object URL
                                window.URL.revokeObjectURL(url);

                                // If you get `Failed to load resource: Frame load interrupted`,
                                // add to your download link the attribute `data-gina-link`
                                // This will convert the regular HTTP Request to an XML Request

                                result = {
                                    status : xhr.status,
                                    statusText: xhr.statusText,
                                    responseType: blob.type,
                                    type : blob.type,
                                    size : blob.size
                                }

                            } else { // normal case
                                result = xhr.responseText;
                            }



                            if ( /\/json/.test( contentType ) ) {
                                result = JSON.parse(xhr.responseText);

                                if ( typeof(result.status) == 'undefined' )
                                    result.status = xhr.status;

                            }

                            if ( /\/html/.test( contentType ) ) {

                                result = {
                                    contentType : contentType,
                                    content     : xhr.responseText
                                };

                                if ( typeof(result.status) == 'undefined' )
                                    result.status = xhr.status;

                                // if hasPopinHandler & popinIsBinded
                                if ( typeof(gina.popin) != 'undefined' && gina.hasPopinHandler ) {
                                    // select popin current active popin
                                    $popin = gina.popin.getActivePopin();

                                    if ($popin) {

                                        XHRData = {};
                                        // update toolbar

                                        try {
                                            XHRData = new DOMParser().parseFromString(result.content, 'text/html').getElementById('gina-without-layout-xhr-data');
                                            XHRData = JSON.parse(decodeURIComponent(XHRData.value));

                                            XHRView = new DOMParser().parseFromString(result.content, 'text/html').getElementById('gina-without-layout-xhr-view');
                                            XHRView = JSON.parse(decodeURIComponent(XHRView.value));

                                            // update data tab
                                            if ( gina && envIsDev && typeof(window.ginaToolbar) && typeof(XHRData) != 'undefined' ) {
                                                window.ginaToolbar.update("data-xhr", XHRData);
                                            }

                                            // update view tab

                                            if ( gina && envIsDev && typeof(window.ginaToolbar) && typeof(XHRView) != 'undefined' ) {
                                                window.ginaToolbar.update("view-xhr", XHRView);
                                            }

                                        } catch (err) {
                                            throw err
                                        }


                                        $popin.loadContent(result.content);

                                        result = XHRData;
                                        triggerEvent(gina, $target, 'success.' + id, result);

                                        return;
                                    }
                                }
                            }

                            $form.eventData.success = result;

                            XHRData = result;
                            // update toolbar
                            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                                try {
                                    // don't refresh for html datas
                                    if ( envIsDev && typeof(XHRData) != 'undefined' && !/\/html|\/json/.test(contentType) ) {
                                        window.ginaToolbar.update("data-xhr", XHRData);
                                    }

                                } catch (err) {
                                    throw err
                                }
                            }

                            // intercepts upload
                            if ( /^gina\-upload/i.test(id) )
                                onUpload(gina, $target, 'success', id, result);

                            // intercepts result.popin & popin redirect (from SuperController::redirect() )
                            var isXhrRedirect = false;
                            if (
                                typeof(result.isXhrRedirect) != 'undefined'
                                && /^true$/i.test(result.isXhrRedirect)
                            ) {
                                isXhrRedirect = true;
                            }
                            if (
                                typeof(gina.popin) != 'undefined'
                                && gina.hasPopinHandler
                                && typeof(result.popin) != 'undefined'
                                ||
                                typeof(gina.popin) != 'undefined'
                                && gina.hasPopinHandler
                                && typeof(result.location) != 'undefined'
                                && isXhrRedirect
                            ) {
                                $popin = gina.popin.getActivePopin();
                                if ( !$popin && typeof(result.popin) != 'undefined' ) {
                                    if ( typeof(result.popin) != 'undefined' && typeof(result.popin.name) == 'undefined' ) {
                                        throw new Error('To get a `$popin` instance, you need at list a `popin.name`.');
                                    }
                                    $popin = gina.popin.getPopinByName(result.popin.name);
                                    if ( !$popin ) {
                                        throw new Error('Popin with name: `'+ result.popin.name +'` not found.')
                                    }
                                }

                                if (
                                    typeof(result.popin) != 'undefined'
                                    && typeof(result.popin.close) != 'undefined'
                                ) {
                                    $popin.isRedirecting = false;
                                    $popin.close();
                                    var _reload = (result.popin.reload) ? result.popin.reload : false;
                                    if ( !result.popin.location && !result.popin.url) {
                                       delete result.popin;
                                       // only exception
                                       if (_reload) {
                                        result.popin = { reload: _reload };
                                       }
                                    }
                                }

                                if (
                                    typeof(result.popin) != 'undefined'
                                    && typeof(result.popin.location) != 'undefined'
                                    ||
                                    typeof(result.popin) != 'undefined'
                                    && typeof(result.popin.url) != 'undefined'
                                    ||
                                    typeof(result.location) != 'undefined'
                                    && isXhrRedirect
                                ) {
                                    var popinName = null;
                                    if ( $popin ) {
                                        popinName = $popin.name; // by default
                                        $popin.isRedirecting = true;
                                    }

                                    var _target = '_self'; // by default
                                    if ( typeof(result.popin) != 'undefined' && typeof(result.popin.target) != 'undefined' ) {
                                        if ( /^(blank|self|parent|top)$/ ) {
                                            result.popin.target = '_'+result.popin.target;
                                        }
                                        _target = result.popin.target
                                    }

                                    //var popinUrl = (typeof(result.popin) != 'undefined') ? result.popin.location : result.location;
                                    var popinUrl = result.location || result.popin.location || result.popin.url;
                                    if (
                                        typeof(result.popin) != 'undefined'
                                        && typeof(result.popin.name) != 'undefined'
                                        && popinName != result.popin.name
                                    ) {
                                        if ($popin && $popin.isOpen)
                                            $popin.close();

                                        popinName = result.popin.name;
                                        $popin = gina.popin.getPopinByName(popinName);
                                        if ( !$popin ) {
                                            throw new Error('Popin with name `'+ popinName+'` not found !');
                                        }
                                        console.debug('Validator::Popin now redirecting [1-c]');
                                        $popin.load($popin.name, popinUrl, $popin.options);
                                    } else if ($popin) {
                                        console.debug('Validator::Popin now redirecting [1-d]');
                                        if ($popin && $popin.isOpen)
                                            $popin.close();
                                        $popin.load($popin.name, popinUrl, $popin.options);
                                    }
                                    if ($popin && !$popin.isOpen) {
                                        return setTimeout( function onPopinredirect($popin){
                                            if (!$popin.isOpen) {
                                                $popin.open();
                                                return;
                                            }
                                        }, 50, $popin);
                                    }
                                }
                            }

                            triggerEvent(gina, $target, 'success.' + id, result);

                            if (hFormIsRequired)
                                triggerEvent(gina, $target, 'success.' + id + '.hform', result);

                        } catch (err) {

                            result = {
                                status:  422,
                                error : err.message,
                                stack : err.stack

                            };

                            $form.eventData.error = result;


                            XHRData = result;
                            // update toolbar
                            if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                                try {

                                    if ( envIsDev && typeof(XHRData) != 'undefined' ) {
                                        window.ginaToolbar.update("data-xhr", XHRData);
                                    }

                                } catch (err) {
                                    throw err
                                }
                            }

                            // intercept upload
                            if ( /^gina\-upload/i.test(id) )
                                onUpload(gina, $target, 'error', id, result);

                            triggerEvent(gina, $target, 'error.' + id, result);

                            if (hFormIsRequired)
                                triggerEvent(gina, $target, 'error.' + id + '.hform', result);
                        }



                        // handle redirect
                        if ( typeof(result) != 'undefined' && typeof(result.location) != 'undefined' ) {
                            window.location.hash = ''; //removing hashtag

                            // if ( window.location.host == gina.config.hostname && /^(http|https)\:\/\//.test(result.location) ) { // same origin
                            //     result.location = result.location.replace( new RegExp(gina.config.hostname), '' );
                            // } else { // external - need to remove `X-Requested-With` from `options.headers`
                                result.location = (!/^http/.test(result.location) && !/^\//.test(result.location) ) ? location.protocol +'//' + result.location : result.location;
                            //}
                            // isProxyHost ?
                            if (
                                result.location.replace(/^http(.*)\:\d+/, '$1').replace(/^\:\/\//, '').split(/\//g)[0] == gina.config.hostname
                                && gina.config.hostname == window.location.host
                            ) {
                                result.location = location.protocol  + result.location.replace(/^http(.*)\:\d+/, '$1').replace(/^\:/, '')
                            }

                            return setTimeout(() => {
                                window.location.href = result.location;
                            }, redirectDelay);
                        }

                    } else if ( xhr.status != 0) {
                        // XHR Error
                        result = { 'status': xhr.status };
                        // handling blob xhr error
                        if ( /blob/.test(xhr.responseType) ) {

                            blob = new Blob([this.response], { type: 'text/plain' });

                            var reader = new FileReader(), blobError = '';


                            // This fires after the blob has been read/loaded.
                            reader.addEventListener('loadend', (e) => {

                                if ( /string/i.test(typeof(e.srcElement.result)) ) {
                                    blobError += e.srcElement.result;
                                    // try {
                                    //     result = merge( result, JSON.parse(blobError) )
                                    // } catch (err) {
                                    //     result = merge(result, err)
                                    // }

                                } else if ( typeof(e.srcElement.result) == 'object' ) {
                                    result = merge(result, e.srcElement.result)
                                } else {
                                    result.message += e.srcElement.result
                                }

                                // once ready
                                if ( /2/.test(reader.readyState) ) {

                                    if ( /^(\{|\[)/.test( blobError ) ) {
                                        try {
                                            result = merge( result, JSON.parse(blobError) )
                                        } catch(err) {
                                            result = merge(result, err)
                                        }
                                    }

                                    if (!result.message)
                                        delete result.message;
                                    // forward appplication errors to validator when available
                                    $form.eventData.error = result;

                                    // update toolbar
                                    XHRData = result;
                                    if ( gina && envIsDev && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                                        try {
                                            // update toolbar
                                            window.ginaToolbar.update('data-xhr', XHRData );

                                        } catch (err) {
                                            throw err
                                        }
                                    }

                                    // intercept upload
                                    if ( /^gina\-upload/i.test(id) )
                                        onUpload(gina, $target, 'error', id, result);

                                    triggerEvent(gina, $target, 'error.' + id, result);
                                    if (hFormIsRequired)
                                        triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                                    return;
                                }


                            });

                            // Start reading the blob as text.
                            reader.readAsText(blob);

                        } else { // normal case

                            if ( /^(\{|\[)/.test( xhr.responseText ) ) {

                                try {
                                    result = merge(JSON.parse(xhr.responseText), result )
                                } catch (err) {
                                    result = merge(err, result)
                                }

                            } else if ( typeof(xhr.responseText) == 'object' ) {
                                result = merge(xhr.responseText, result)
                            } else {
                                result.message = xhr.responseText
                            }

                            // xhr error response (caching)
                            //$form.eventData.error = result;
                            // Forward appplication errors to forms.errors when available
                            // This api error is meant for the Frontend Validation Errors Handling
                            if ( typeof(result) != 'undefined' && typeof(result.error) != 'undefined' &&  result.fields && typeof(result.fields) == 'object') {

                                var apiMessage = ( typeof(result.message) != 'undefined') ? result.message : null;
                                var newResultfields = {};
                                for (let f in result.fields) {
                                    let errorObject = {};
                                    errorObject[f] = {};
                                    errorObject[f].isApiError = result.fields[f];
                                    if ( apiMessage && !errorObject[f].isApiError) {
                                        errorObject[f].isApiError = result.error; // Generic error
                                    }
                                    newResultfields[f] = errorObject[f];
                                    handleErrorsDisplay($form.target, errorObject, data, f);

                                }
                                result.fields = newResultfields
                            }
                            $form.eventData.error = result;


                            // update toolbar
                            XHRData = result;
                            if ( gina && envIsDev && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                                try {
                                    // update toolbar
                                    window.ginaToolbar.update('data-xhr', XHRData );

                                } catch (err) {
                                    throw err
                                }
                            }


                            // intercept upload
                            if ( /^gina\-upload/i.test(id) )
                                onUpload(gina, $target, 'error', id, result);

                            triggerEvent(gina, $target, 'error.' + id, result);
                            if (hFormIsRequired)
                                triggerEvent(gina, $target, 'error.' + id + '.hform', result);



                        }


                    } /**else if ( xhr.readyState == 4 && xhr.status == 0 ) { // unknown error
                        // Consider also the request timeout
                        // Modern browser return readyState=4 and status=0 if too much time passes before the server response.
                        result = { 'status': 408, 'message': 'XMLHttpRequest Exception: unkown error' };
                        XHRData = result;
                        // update toolbar
                        if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                            try {
                                // don't refresh for html datas
                                if ( envIsDev && typeof(XHRData) != 'undefined' && /\/html/.test(contentType) ) {
                                    window.ginaToolbar.update("data-xhr", XHRData);
                                }

                            } catch (err) {
                                throw err
                            }
                        }

                        // intercept upload
                        if ( /^gina\-upload/i.test(id) ) {
                            result.message = 'XMLHttpRequest Exception: trying to render an unknwon file.'
                            onUpload(gina, $target, 'error', id, result);
                        }
                        triggerEvent(gina, $target, 'error.' + id, result);

                        if (hFormIsRequired)
                            triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                        return;
                    }*/
                }

            };

            // catching request progress
            xhr.onprogress = function(event) {

                var percentComplete = '0';
                if (event.lengthComputable) {
                    percentComplete = event.loaded / event.total;
                    percentComplete = parseInt(percentComplete * 100);

                }

                //var percentComplete = (event.position / event.totalSize)*100;
                var result = {
                    'status': 100,
                    'progress': percentComplete
                };

                //console.debug('xhr progress ', percentComplete);

                $form.eventData.onprogress = result;

                triggerEvent(gina, $target, 'progress.' + id, result)
            };

            // catching timeout
            xhr.ontimeout = function (event) {
                result = {
                    'status': 408,
                    'error': 'Request Timeout'
                };

                $form.eventData.ontimeout = result;

                // intercept upload
                if ( /^gina\-upload/i.test(id) )
                    onUpload(gina, $target, 'error', id, result);

                triggerEvent(gina, $target, 'error.' + id, result);

                if (hFormIsRequired)
                    triggerEvent(gina, $target, 'error.' + id + '.hform', result);
            };


            // sending
            if (!data)
                data = event.detail.data;

            if (data) {

                var hasBinaries = false;

                if ( typeof(data) == 'object' ) {

                    var binaries    = []
                        , b         = 0
                        , newData   = {};

                    try {
                        if ( !(data instanceof FormData) ) {
                            data = JSON.stringify(data)
                        } else {
                            var uploadGroup   = event.currentTarget.getAttribute('data-gina-form-upload-group') || 'untagged';
                            for (var [key, value] of data.entries() ) {
                                // file upload case
                                if (value instanceof File) {
                                    if (!hasBinaries)
                                        hasBinaries = true;

                                    binaries[b] = {
                                        key: key,
                                        group: uploadGroup, // `untagged` by default
                                        file: value,
                                        bin: ''
                                    };

                                    ++b;
                                } else {
                                    newData[key] = value
                                }
                            }
                        }


                        if (hasBinaries && binaries.length > 0) {

                            // We need a separator to define each part of the request
                            var boundary = '--ginaWKBoundary' + uuid.v4().replace(/\-/g, '');


                            return processFiles(binaries, boundary, '', 0, function onComplete(err, data, done) {

                                if (err) {
                                    //throw err
                                    // intercept upload
                                    if ( /^gina\-upload/i.test(id) )
                                        onUpload(gina, $target, 'error', id, err);

                                    triggerEvent(gina, $target, 'error.' + id, err);

                                    if (hFormIsRequired)
                                        triggerEvent(gina, $target, 'error.' + id + '.hform', err);
                                } else {

                                    if (done) {
                                        xhr.setRequestHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
                                        xhr.send(data);

                                        $form.sent = true;
                                        if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                            // update toolbar
                                            if (!gina.forms.sent)
                                                gina.forms.sent = {};

                                            var objCallback = {
                                                id      : id,
                                                sent    : data
                                                //sent    : ( typeof(data) == 'string' ) ? JSON.parse(data) : data
                                            };

                                            window.ginaToolbar.update('forms', objCallback);
                                        }
                                    }

                                    done = false;

                                    return false;
                                }
                            });

                        } else if ( typeof(newData) != 'undefined' && newData.count() > 0 ) { // without file
                            data = JSON.stringify(newData)
                        }


                    } catch (err) {
                        // intercept upload
                        if ( /^gina\-upload/i.test(id) )
                            onUpload(gina, $target, 'error', id, err);

                        triggerEvent(gina, $target, 'error.' + id, err);

                        if (hFormIsRequired)
                            triggerEvent(gina, $target, 'error.' + id + '.hform', err);
                    }
                }
                //console.debug('sending -> ', data);
                if (!hasBinaries) {
                    if (typeof (enctype) != 'undefined' && enctype != null && enctype != '') {
                        xhr.setRequestHeader('Content-Type', enctype);
                    }
                    xhr.send(data)
                }

            } else {

                if ( typeof(enctype) != 'undefined' && enctype != null && enctype != ''){
                    xhr.setRequestHeader('Content-Type', enctype);
                }
                xhr.send()
            }

            $form.sent = true;
            if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                // update toolbar
                if (!gina.forms.sent)
                    gina.forms.sent = {};

                var objCallback = {
                    id      : id,
                    sent    : ( typeof(data) == 'string' ) ? JSON.parse(data) : data
                };

                window.ginaToolbar.update('forms', objCallback);
            }
        }
    }

    var onUpload = function(gina, $target, status, id, data) {

        var uploadProperties = $target.uploadProperties || null;
        // FYI
        // {
        //     id              : String,
        //     $form           : $Object,
        //     mandatoryFields : Array,
        //     uploadFields    : ObjectList
        //     hasPreviewContainer : Boolean,
        //     previewContainer : $Object
        // }

        if ( !uploadProperties )
            throw new Error('No uploadProperties found !!');
        // parent form
        // var $mainForm = uploadProperties.$form;
        var $uploadTriger = document.getElementById(uploadProperties.uploadTriggerId);
        var searchArr   = null
            , name      = null
            , $previewContainer     = null
            , files                 = data.files || []
            , $error                = null
        ;
        // reset previewContainer
        if ( uploadProperties.hasPreviewContainer ) {
            $previewContainer = document.getElementById(uploadProperties.previewContainer.id);
            if ($previewContainer)
                $previewContainer.innerHTML = '';
        }

        if (uploadProperties.errorField) {
            $error = document.getElementById(uploadProperties.errorField)
        }


        //reset errors
        if ($error)
            $error.style.display = 'none';

        if ($error && status != 'success') { // handle errors first
           // console.error('[ mainUploadError ] ', status, data)
            var errMsg = data.message || data.error;

            $error.innerHTML = '<p>'+ errMsg +'</p>';
            fadeIn($error);
        } else if(!$error && status != 'success') {
            throw new Error(errMsg)
        } else {

            var fieldsObjectList = null
                , $li   = null
                , maxWidth = null
                , ratio = null
            ;
            for (var f = 0, fLen = files.length; f<fLen; ++f) {

                // creating reset link
                let resetLinkId = $previewContainer.id.replace(/\-preview/, '-'+f+'-reset-trigger');
                let resetLinkNeedToBeAdded = false;
                let $resetLink = document.getElementById(resetLinkId);
                let defaultClassNameArr = ['reset','js-upload-reset'];
                if (!$resetLink) {
                    resetLinkNeedToBeAdded      = true;
                    $resetLink                  = document.createElement('A');
                    $resetLink.href             = '#';
                    $resetLink.innerHTML        = $uploadTriger.getAttribute('data-gina-form-upload-reset-label') || 'Reset';
                    $resetLink.className        = defaultClassNameArr.join(' ');
                    $resetLink.id               = resetLinkId;
                } else {
                    if ( /a/i.test($resetLink.tagName) ) {
                        $resetLink.href             = '#';
                    }
                    if ( !$resetLink.innerHTML || $resetLink.innerHTML == '' ) {
                        $resetLink.innerHTML        = $uploadTriger.getAttribute('data-gina-form-upload-reset-label') || 'Reset';
                    }
                    if ( typeof($resetLink.className) == 'undefined' ) {
                        $resetLink.className = "";
                    }
                    let classNameArr = merge($resetLink.className.split(/\s+/g), defaultClassNameArr);
                    $resetLink.className    = classNameArr.join(' ');
                }
                $resetLink.style.display    = 'none';

                // image preview
                if ( typeof(files[f].preview) == 'undefined'
                    && uploadProperties.hasPreviewContainer
                    && /^image/.test(files[f].mime)
                    && files[f].location != ''
                ) {
                    let $img    = document.createElement('IMG');
                    $img.src    = files[f].tmpUri;
                    $img.style.display = 'none';
                    $img.setAttribute('data-upload-original-filename', files[f].originalFilename);
                    $img.setAttribute('data-upload-reset-link-id', $resetLink.id);

                    // TODO - Remove this; we don't want it by default, the dev can force it by hand if needed
                    // if (files[f].width) {
                    //     $img.width  = files[f].width;
                    // }
                    // if (files[f].height) {
                    //     $img.height = files[f].height;
                    // }

                    maxWidth = $previewContainer.getAttribute('data-preview-max-width') || null;
                    if ( $img.width && maxWidth && $img.width > maxWidth ) {
                        ratio = $img.width / maxWidth;
                        $img.width = maxWidth;
                        $img.height = $img.height / ratio;
                    } else if (!$img.width && maxWidth ) {
                        $img.width = maxWidth
                    }

                    if ( /ul/i.test(uploadProperties.previewContainer.tagName) ) {
                        $li = document.createElement('LI');
                        $li.className = 'item';
                        $li.appendChild($img);
                        $previewContainer.appendChild($li);
                    } else {
                        $previewContainer.appendChild($img);
                    }
                    fadeIn($img);
                }
                // fill the fields to be saved ;)
                fieldsObjectList = uploadProperties.uploadFields[f];
                var $elIgnored = null;
                for (var key in fieldsObjectList) {
                    // update field value
                    if (
                        key == 'name' && fieldsObjectList[key].value != ''
                        || !files[f][key]
                        || key == 'preview' && typeof(files[f][key]) == 'undefined'
                        || /(height|width)/i.test(key) && !/^image/.test(files[f].mime)
                    ) {
                        if ( /(preview|height|width)/i.test(key) ) {
                            $elIgnored = document.getElementById(fieldsObjectList[key].id);
                            if ( $elIgnored )
                                $elIgnored.parentNode.removeChild($elIgnored);
                        }
                        continue;
                    }
                    //fieldsObjectList[key].value = (/object/i.test(typeof(files[f][key])) ) ? JSON.stringify( files[f][key] ) : files[f][key];
                    fieldsObjectList[key].value = files[f][key];
                    // update submited $fields ??

                    // handle preview
                    if ( key == 'preview' ) {

                        for (var previewKey in files[f][key]) {
                            if ( typeof(files[f][key][previewKey]) != 'undefined' && typeof(fieldsObjectList[key][previewKey]) != 'undefined' ) {
                                fieldsObjectList[key][previewKey].value = files[f][key][previewKey];
                            }

                            // with preview
                            if ( previewKey == 'tmpUri' && uploadProperties.hasPreviewContainer ) {

                                // // creating reset link
                                // let resetLinkId = $previewContainer.id.replace(/\-preview/, '-'+f+'-reset-trigger');
                                // let resetLinkNeedToBeAdded = false;
                                // let $resetLink = document.getElementById(resetLinkId);
                                // let defaultClassNameArr = ['reset','js-upload-reset'];
                                // if (!$resetLink) {
                                //     resetLinkNeedToBeAdded      = true;
                                //     $resetLink                  = document.createElement('A');
                                //     $resetLink.href             = '#';
                                //     $resetLink.innerHTML        = $uploadTriger.getAttribute('data-gina-form-upload-reset-label') || 'Reset';
                                //     $resetLink.className        = defaultClassNameArr.join(' ');
                                //     $resetLink.id               = resetLinkId;
                                // } else {
                                //     if ( /a/i.test($resetLink.tagName) ) {
                                //         $resetLink.href             = '#';
                                //     }
                                //     if ( !$resetLink.innerHTML || $resetLink.innerHTML == '' ) {
                                //         $resetLink.innerHTML        = $uploadTriger.getAttribute('data-gina-form-upload-reset-label') || 'Reset';
                                //     }
                                //     if ( typeof($resetLink.className) == 'undefined' ) {
                                //         $resetLink.className = "";
                                //     }
                                //     let classNameArr = merge($resetLink.className.split(/\s+/g), defaultClassNameArr);
                                //     $resetLink.className    = classNameArr.join(' ');
                                // }
                                // $resetLink.style.display    = 'none';


                                // creating IMG tag
                                let $img = document.createElement('IMG');
                                $img.src = files[f][key].tmpUri;
                                $img.style.display = 'none';
                                // retrieve img `originalFilename` (not the preview img[key] `originalFilename`)
                                // these 2 metadatas will be used to remove files from the server
                                $img.setAttribute('data-upload-original-filename', files[f].originalFilename);
                                $img.setAttribute('data-upload-preview-original-filename', files[f][key].originalFilename);
                                // in order to retrieve and remove reset link
                                $img.setAttribute('data-upload-reset-link-id', $resetLink.id);

                                maxWidth = $previewContainer.getAttribute('data-preview-max-width') || null;
                                if ( maxWidth ) {
                                    $img.width = maxWidth
                                }

                                if ( /ul/i.test(uploadProperties.previewContainer.tagName) ) {
                                    $li = document.createElement('LI');
                                    $li.className = 'item';
                                    $li.appendChild($img);
                                    // if (resetLinkNeedToBeAdded)
                                    //     $li.appendChild($resetLink);

                                    $previewContainer.appendChild($li);
                                } else {
                                    $previewContainer.appendChild($img);
                                    // if (resetLinkNeedToBeAdded)
                                    //     $previewContainer.appendChild($resetLink);
                                }
                                fadeIn($img);
                                // // bind reset trigger
                                // bindUploadResetOrDeleteTrigger('reset', $uploadTriger, f);
                                // fadeIn($resetLink);
                            }
                        }
                    }
                } // EO for

                if (uploadProperties.hasPreviewContainer) {
                    if ( /ul/i.test(uploadProperties.previewContainer.tagName) ) {
                        $li = document.createElement('LI');
                        $li.className = 'item';
                        if (resetLinkNeedToBeAdded)
                            $li.appendChild($resetLink);
                        $previewContainer.appendChild($li);
                    } else {
                        if (resetLinkNeedToBeAdded)
                            $previewContainer.appendChild($resetLink);
                    }
                }
                // bind reset trigger
                bindUploadResetOrDeleteTrigger('reset', $uploadTriger, f);
                fadeIn($resetLink);
            } // EO for f
        }
    }

    /**
     * onUploadResetOrDelete
     *
     * @param {object} $uploadTrigger
     * @param {string} bindingType - `reset` or `delete`
     * @returns
     */
    var onUploadResetOrDelete = function($uploadTrigger, bindingType) {
        console.debug(bindingType + ' input files');
        var isOnResetMode       = ( /reset/i.test(bindingType) ) ? true : false
            , uploadPreviewId   = $uploadTrigger.id +'-preview'
            , $uploadPreview    = document.getElementById(uploadPreviewId);

        var childNodeFile           = null
            , childNodeFilePreview  = null
            , childNodes            = $uploadPreview.childNodes
            , $resetLink            = null
            , files                 = $uploadTrigger.customFiles
            , filesToBeRemoved      = []
        ;

        for (let i = 0, len = childNodes.length; i < len; i++) {
            // only look for IMG tags
            if ( /img/i.test(childNodes[i].tagName) ) {
                if (isOnResetMode) {
                    childNodeFile           =  childNodes[i].getAttribute('data-upload-original-filename');
                    filesToBeRemoved.push(childNodeFile);
                    childNodeFilePreview    = childNodes[i].getAttribute('data-upload-preview-original-filename');
                    if (childNodeFilePreview) {
                        filesToBeRemoved.push(childNodeFilePreview);
                    }
                } else {
                    let file = childNodes[i].src.substr(childNodes[i].src.lastIndexOf('/')+1);
                    childNodeFile = file;
                    filesToBeRemoved.push(childNodeFile);
                }

                // remove file from input.files
                for (let f = 0, fLen = files.length; f < fLen; f++) {
                    if (files[f].name == childNodeFile) {
                        // get resetLink element
                        if (isOnResetMode) {
                            $resetLink      = document.getElementById( childNodes[i].getAttribute('data-upload-'+ bindingType +'-link-id') );
                        } else {
                            $resetLink      = document.getElementById( files[f].deleteLinkId );
                        }

                        // hide reset or delete link & image
                        $resetLink.style.display = 'none';
                        childNodes[i].style.display = 'none';

                        // remove file from input.files
                        files.splice(f, 1);
                        // Since `$uploadTrigger.files` isFrozen & isSealed
                        $uploadTrigger.customFiles  = files;
                        if (isOnResetMode) {
                            $uploadTrigger.value        = files.join(', C:\\fakepath\\');
                        }

                        // update form files for validation & submit/send
                        let re = new RegExp('^'+($uploadTrigger.name+'['+f+']').replace(/\-|\[|\]|\./g, '\\$&'));
                        for ( let d = 0, dLen = $uploadTrigger.form.length; d < dLen; d++) {
                            // data-gina-form-upload-is-locked
                            // this exception prevent `tagged datas` to be deleted on image delete
                            let isLocked = $uploadTrigger.form[d].dataset.ginaFormUploadIsLocked || false;
                            if ( re.test($uploadTrigger.form[d].name) && !/true/i.test(isLocked) ) {
                                $uploadTrigger.form[d].remove();
                                dLen--;
                                d--;
                                //update toolbar
                                if (gina && envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                    try {
                                        // update toolbar
                                        window.ginaToolbar.update('data-xhr', {files: files});
                                    } catch (err) {
                                        throw err
                                    }
                                }
                            }
                        }
                        // remove file from the server - filesToBeRemoved
                        let url = $uploadTrigger.getAttribute('data-gina-form-upload-'+ bindingType +'-action');
                        if ( !url || typeof(url) == 'undefined' || url == '' || /404/.test(url) ) {
                            throw new Error('input file `'+ $uploadTrigger.id +'` error: `data-gina-form-upload-'+bindingType+'-action` is required. You need to provide a valide url.');
                        }
                        let method = $uploadTrigger.getAttribute('data-gina-form-upload-'+ bindingType +'-method');
                        if ( !method || typeof(method) == 'undefined' || method == '') {
                            if (isOnResetMode) {
                                method = 'POST';
                            } else {
                                method = (filesToBeRemoved.length > 1) ? 'POST': 'DELETE';
                                console.warn('`data-gina-form-upload-'+ bindingType +'-method` was not defined. Switching to `'+ method +'` by default.');
                            }
                        } else {
                            method = method.toUpperCase();
                        }
                        let isSynchrone = $uploadTrigger.getAttribute('data-gina-form-upload-'+ bindingType +'-is-synchrone');
                        if ( /null/i.test(isSynchrone) || typeof(method) == 'undefined' || method == '' ) {
                            isSynchrone = true;
                        }

                        let xhrOptions = {
                            url: url,
                            method: method,
                            isSynchrone: isSynchrone,
                            headers : {
                                // to upload, use `multipart/form-data` for `enctype`
                                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
                                'X-Requested-With': 'XMLHttpRequest' // in case of cross domain origin
                            }
                        };
                        let xhr = setupXhr(xhrOptions);
                        //handleXhr(xhr);
                        if ( /GET|DELETE/i.test(method) ) {
                            xhr.send();
                        } else {
                            xhr.send(JSON.stringify({ files: filesToBeRemoved }));
                        }

                        // when there is no more files to preview, restore input file visibility
                        // display upload input
                        if ( /none/i.test(window.getComputedStyle($uploadTrigger).display) ) {
                            // eg.: visibility could be delegated to a parent element such as label or a div
                            if ( /none/i.test($uploadTrigger.parentElement.style.display) ) {
                                $uploadTrigger.parentElement.style.display = 'block';
                                return;
                            }
                            $uploadTrigger.style.display = 'block';
                        }

                        // remove reset link event
                        removeListener(gina, $uploadResetTrigger, 'click', function onUploadResetTriggerEventRemoved() {
                            // remove link & image - must be done last
                            $resetLink.remove();
                            childNodes[i].remove();
                        });
                        len--;
                        i--;
                        break;
                    }
                } // EO for
            }
        }
    }

    /**
     * Convert <Uint8Array|Uint16Array|Uint32Array> to <String>
     * @param {array} buffer
     * @param {number} [byteLength] e.g.: 8, 16 or 32
     *
     * @returns {string} stringBufffer
     */
    var ab2str = function(event, buf, byteLength) {

        var str = '';
        var ab = null;

        if ( typeof(byteLength) == 'undefined' ) {
            var byteLength = 8;
        }


        var bits = (byteLength / 8)


        switch (byteLength) {
            case 8:
                ab = new Uint8Array(buf);
                break;
            case 16:
                ab = new Uint16Array(buf);
                break;

            case 32:
                ab = new Uint32Array(buf);
                break;

            default:
                ab = new Uint8Array(buf);
                break;

        }

        var abLen = ab.length;
        var CHUNK_SIZE = Math.pow(2, 8) + bits;
        var offset = 0, len = null, subab = null;

        for (; offset < abLen; offset += CHUNK_SIZE) {
            len = Math.min(CHUNK_SIZE, abLen - offset);
            subab = ab.subarray(offset, offset + len);
            str += String.fromCharCode.apply(null, subab);
        }

        return str;
    }


    var processFiles = function(binaries, boundary, data, f, onComplete) {

        var reader = new FileReader();

        // progress
        // reader.addEventListener('progress', (e) => {
        //     var percentComplete = '0';
        //     if (e.lengthComputable) {
        //         percentComplete = e.loaded / e.total;
        //         percentComplete = parseInt(percentComplete * 100);

        //     }

        //     // var result = {
        //     //     'status': 100,
        //     //     'progress': percentComplete
        //     // };

        //     console.debug('progress', percentComplete);

        //     //$form.eventData.onprogress = result;

        //     //triggerEvent(gina, $target, 'progress.' + id, result)
        // });

        reader.addEventListener('load', function onReaderLoaded(e) {

            e.preventDefault();

            // var percentComplete = '0';
            // if (e.lengthComputable) {
            //     percentComplete = e.loaded / e.total;
            //     percentComplete = parseInt(percentComplete * 100);

            //     console.debug('progress', percentComplete);
            // }


            try {

                var bin = ab2str(e, this.result);
                ;
                binaries[this.index].bin += bin;

                if (!binaries[this.index].file.type) {
                    binaries[this.index].file.type = 'application/octet-stream'
                }

            } catch (err) {
                return onComplete(err, null, true);
            }

            // Start a new part in our body's request
            data += "--" + boundary + "\r\n";

            // Describe it as form data
            data += 'Content-Disposition: form-data; '
                // Define the name of the form data
                + 'name="' + binaries[this.index].key + '"; '
                // Define the upload group
                + 'group="' + binaries[this.index].group + '"; '
                // Provide the real name of the file
                + 'filename="' + binaries[this.index].file.name + '"\r\n'
                // And the MIME type of the file
                + 'Content-Type: ' + binaries[this.index].file.type + '\r\n'
                // File length
                + 'Content-Length: ' + binaries[this.index].bin.length + '\r\n'
                // There's a blank line between the metadata and the data
                + '\r\n';

            // Append the binary data to our body's request
            data += binaries[this.index].bin + '\r\n';

            ++this.index;
            // is last file ?
            if (this.index == binaries.length) {
                // Once we are done, "close" the body's request
                data += "--" + boundary + "--";

                onComplete(false, data, true);

            } else { // process next file
                processFiles(binaries, boundary, data, this.index, onComplete)
            }
        }, false);

        reader.index = f;
        binaries[f].bin = '';

        reader.readAsArrayBuffer(binaries[f].file);
        //reader.readAsBinaryString(binaries[f].file);
    }


    var listenToXhrEvents = function($form) {

        //data-gina-form-event-on-submit-success
        var htmlSuccesEventCallback =  $form.target.getAttribute('data-gina-form-event-on-submit-success') || null;
        if (htmlSuccesEventCallback != null) {

            if ( /\((.*)\)/.test(htmlSuccesEventCallback) ) {
                eval(htmlSuccesEventCallback)
            } else {
                $form.on('success.hform',  window[htmlSuccesEventCallback])
            }
        }
        //data-gina-form-event-on-submit-error
        var htmlErrorEventCallback =  $form.target.getAttribute('data-gina-form-event-on-submit-error') || null;
        if (htmlErrorEventCallback != null) {
            if ( /\((.*)\)/.test(htmlErrorEventCallback) ) {
                eval(htmlErrorEventCallback)
            } else {
                $form.on('error.hform', window[htmlErrorEventCallback])
            }
        }

    }


    var destroy = function(formId) {
        var $form = null, _id = formId;

        if ( !instance['$forms'] )
            throw new Error('`$forms` collection not found');


        if ( typeof(_id) == 'undefined') {
            if ( typeof(this.id) != 'undefined' && this.id != '' && this.id != null ) {
                _id  = this.id
            } else {
                throw new Error('[ FormValidator::destroy(formId) ] `formId` is missing')
            }
        }

        if ( typeof(_id) == 'string') {
            _id = _id.replace(/\#/, '')
        } else if ( typeof(_id) == 'object' && !Array.isArray(_id) ) { // weird exception
            var $target = _id.form;
            _id = $target.getAttribute('id') || 'form.'+uuid.v4();

            $target.setAttribute('id', _id);// just in case

        } else {
            throw new Error('[ FormValidator::destroy(formId) ] `formId` should be a `string`');
        }

        if ( typeof(instance['$forms'][_id]) != 'undefined' ) {
            $form = instance['$forms'][_id]
        } else if ( typeof(this.binded) != 'undefined' ) {
            $form = this;
        }

        if ($form) {

            addListener(gina, $form.target, 'destroy.' + _id, function(event) {

                cancelEvent(event);

                delete instance['$forms'][_id];
                removeListener(gina, event.currentTarget, event.type);
                removeListener(gina, event.currentTarget,'destroy');
            });

            // remove existing listeners
            $form = unbindForm($form);

            //triggerEvent(gina, instance['$forms'][_id].target, 'destroy.' + _id);
            triggerEvent(gina, $form.target, 'destroy.' + _id);

        } else {
            throw new Error('[ FormValidator::destroy(formId) ] `'+_id+'` not found');
        }

    }

    /**
     * cleanupInstanceRules
     * Will remove _case_ condition for empty rules
     * Used to remove empty `@import` after `checkForRulesImports` is called
     *
     */
    var cleanupInstanceRules = function() {
        var rule = ( typeof(arguments[0]) != 'undefined' ) ? arguments[0] : instance.rules;
        for (let r in rule) {
            let props = Object.getOwnPropertyNames(rule[r]);
            let p = 0, pLen = props.length;
            let hasCases = false, caseName = null;
            while (p < pLen) {
                if ( /^\_case\_/.test(props[p]) ) {
                    hasCases = true;
                    caseName = props[p];
                    break;
                }
                p++
            }

            if ( !hasCases && typeof(rule[r]) == 'object') {
                cleanupInstanceRules(rule[r]);
            }

            if (caseName && Array.isArray(rule[r][caseName].conditions) && rule[r][caseName].conditions.length > 0) {
                let c = 0, len = rule[r][caseName].conditions.length;
                while (c < len) {
                    if (
                        typeof(rule[r][caseName].conditions[c].rules) != 'undefined'
                        && rule[r][caseName].conditions[c].rules.count() == 0
                    ) {
                        rule[r][caseName].conditions.splice(c, 1);
                        len--;
                        c--;
                    }
                    c++;
                }
            }
        }
    }

    var checkForRulesImports = function (rules) {
        // check if rules has imports & replace
        var rulesStr        = JSON.stringify(rules);
        var importedRules   = rulesStr.match(/(\"@import\s+[-_a-z A-Z 0-9/.]+\")/g) || [];
        // remove duplicate
        var filtered = [];
        for (let d = 0, dLen = importedRules.length; d < dLen; d++) {
            if (filtered.indexOf(importedRules[d]) < 0) {
                filtered.push(importedRules[d])
            }
        }
        importedRules = filtered;
        // TODO - complete mergingRules integration
        var mergingRules     = rulesStr.match(/(\"_merging(.*))(\s+\:|\:)(.*)(\",|\")/g)
        var isMerging       = false;
        if (!instance.rules) {
            instance.rules = {}
        }
        if (importedRules && importedRules.length > 0) {
            var ruleArr = [], rule = {}, tmpRule = null, re = null;
            for (let r = 0, len = importedRules.length; r<len; ++r) {
                let importPath = importedRules[r].replace(/(@import\s+|\"|\')/g, '');
                ruleArr = importPath.replace(/(@import\s+|\"|\')/g, '').split(/\s/g);
                // [""@import client/form", ""@import project26/edit demo/edit"]
                //console.debug('ruleArr -> ', ruleArr, importedRules[r]);
                for (let i = 0, iLen = ruleArr.length; i<iLen; ++i) {
                    tmpRule = ruleArr[i].replace(/\//g, '.').replace(/\-/g, '.');
                    if ( typeof(instance.rules[ tmpRule ]) != 'undefined' ) {
                        let rule = JSON.stringify(instance.rules[ tmpRule ]);
                        let strRule = JSON.parse(rule);
                        if ( typeof(strRule['_comment']) != 'undefined' ) {
                            strRule['_comment'] += '\n';
                        } else {
                            strRule['_comment'] = '';
                        }
                        strRule['_comment'] += 'Imported from `'+ importPath +'`';
                        rule = JSON.stringify(strRule);
                        rulesStr = rulesStr.replace(new RegExp(importedRules[r], 'g'), rule);
                        // also need to replace in instance.rules
                        instance.rules = JSON.parse(JSON.stringify(instance.rules).replace(new RegExp(importedRules[r], 'g'), '{}'));
                    } else {
                        console.warn('[formValidator:rules] <@import error> on `'+importedRules[r]+'`: rule `'+ruleArr[i]+'` not found. Ignoring.');
                        continue;
                    }
                }
                //console.debug('replacing ', importedRules[r]);
                re = new RegExp(importedRules[r]);
                isMerging = ( mergingRules && re.test(mergingRules.join()) ) ? true : false;
                if( isMerging ) {

                    for (let m = 0, mLen = mergingRules.length; m < mLen; m++) {
                        if ( re.test(mergingRules[m]) ) {
                            let tmpStr = JSON.stringify(rule);
                            tmpStr = tmpStr.substr(1, tmpStr.length-1);// removing ->{ ... }<-
                            // is last ?
                            if (m < mLen-1) {
                                tmpStr += ','
                            }
                            try {
                                rulesStr = rulesStr.replace( new RegExp(mergingRules[m], 'g'), tmpStr);
                                // also need to replace in instance.rules
                                instance.rules = JSON.parse(JSON.stringify(instance.rules).replace(new RegExp(mergingRules[m], 'g'), '{}'));
                            } catch (error) {
                                throw error
                            }
                        }
                    }

                }
                rule = {}
            }

            rules = JSON.parse(rulesStr);
            parseRules(rules, '');

            try {
                cleanupInstanceRules();
            } catch (err) {
                console.error(err.stack);
            }
        }

        return rules;
    }

    var init = function (rules) {

        if (gina.hasValidator) {

            instance = merge(instance, gina.validator);
            instance.on('init', function(event) {
                instance.isReady = true;
                triggerEvent(gina, instance.target, 'ready.' + instance.id, instance)
            })
        } else {
            setupInstanceProto();
            instance.on('init', function onValidatorInit(event) {
                // parsing rules
                if ( typeof(rules) != 'undefined' && rules.count() ) {
                    try {
                        parseRules(rules, '');
                        rules = checkForRulesImports(rules);
                        // making copy
                        if ( typeof(gina.forms.rules) == 'undefined' || !gina.forms.rules) {
                            gina.forms.rules = rules
                        } else { // inherits
                            gina.forms.rules = merge(gina.forms.rules, rules, true);
                        }
                        // update instance.rules
                        instance.rules = merge(instance.rules, JSON.clone(gina.forms.rules), true);
                    } catch (err) {
                        throw (err)
                    }
                }

                if ( !local.rules.count() ) {
                    local.rules = JSON.clone(instance.rules);
                }


                $validator.setOptions           = setOptions;
                $validator.getFormById          = getFormById;
                $validator.validateFormById     = validateFormById;
                $validator.resetErrorsDisplay   = resetErrorsDisplay;
                $validator.resetFields          = resetFields;
                $validator.handleErrorsDisplay  = handleErrorsDisplay;
                $validator.submit               = submit;
                $validator.send                 = send;
                $validator.unbind               = unbindForm;
                $validator.bind                 = bindForm;
                $validator.reBind               = reBindForm;
                $validator.destroy              = destroy;

                var id          = null
                    , $target   = null
                    , i         = 0
                    , $forms    = []
                    , $allForms = document.getElementsByTagName('form');


                // form has rule ?
                for (var f=0, len = $allForms.length; f<len; ++f) {
                    // preparing prototype (need at least an ID for this)

                    if ($allForms[f].getAttribute) {
                        id = $allForms[f].getAttribute('id') || 'form.' + uuid.v4();
                        if ( id !== $allForms[f].getAttribute('id') ) {
                            $allForms[f].setAttribute('id', id)
                        }
                    } else {
                        id = 'form.' + uuid.v4();
                        $allForms[f].setAttribute('id', id)
                    }

                    //$allForms[f]['id'] = $validator.id = id;
                    $validator.id = id;

                    //if ( typeof($allForms[f].getAttribute('id')) != 'undefined' && $allForms[f].id != 'null' && $allForms[f].id != '') {

                        $validator.target = $allForms[f];
                        instance.$forms[id] = merge({}, $validator);

                        var customRule = $allForms[f].getAttribute('data-gina-form-rule');

                        if (customRule) {
                            customRule = customRule.replace(/\-|\//g, '.');
                            if ( typeof(rules) != 'undefined' ) {
                                instance.$forms[id].rules[customRule] = instance.rules[customRule] = local.rules[customRule] = merge(JSON.clone( eval('gina.forms.rules.'+ customRule)), instance.rules[customRule]);
                                // instance.$forms[id].rules[customRule] = instance.rules[customRule] = local.rules[customRule] = merge(eval('gina.forms.rules.'+ customRule), instance.rules[customRule]);
                            }
                            if ( typeof(local.rules[customRule]) == 'undefined' ) {
                                throw new Error('['+id+'] no rule found with key: `'+customRule+'`. Please check if json is not malformed @ /forms/rules/' + customRule.replace(/\./g, '/') +'.json');
                            }
                            customRule = instance.rules[customRule];
                        }

                        // finding forms handled by rules
                        if (
                            typeof(id) == 'string'
                            && typeof(local.rules[id.replace(/\-/g, '.')]) != 'undefined'
                            ||
                            typeof(customRule) == 'object'
                        ) {
                            $target = instance.$forms[id].target;
                            if (customRule) {
                                bindForm($target, customRule)
                            } else {
                                bindForm($target)
                            }

                            ++i
                        }
                        // TODO - remove this
                        // migth not be needed anymore
                        else {
                            // weird exception when having in the form an element with name="id"
                            if ( typeof($allForms[f].id) == 'object' ) {
                                delete instance.$forms[$allForms[f].id];

                                var _id = $allForms[f].attributes.getNamedItem('id').nodeValue || 'form.'+uuid.v4();

                                $allForms[f].setAttribute('id', _id);
                                $allForms[f]['id'] = _id;

                                $validator.target = $allForms[f];
                                instance.$forms[_id] = merge({}, $validator);

                                $target = instance.$forms[_id].target;
                                if (customRule) {
                                    bindForm($target, customRule)
                                } else {
                                    bindForm($target)
                                }
                            } else {

                                $target = instance.$forms[$allForms[f].id].target;
                                if (customRule) {
                                    bindForm($target, customRule)
                                } else {
                                    bindForm($target)
                                }
                            }
                        }
                    //}

                }


                // setting up AJAX
                if (window.XMLHttpRequest) { // Mozilla, Safari, ...
                    xhr = new XMLHttpRequest();
                } else if (window.ActiveXObject) { // IE
                    try {
                        xhr = new ActiveXObject("Msxml2.XMLHTTP");
                    } catch (e) {
                        try {
                            xhr = new ActiveXObject("Microsoft.XMLHTTP");
                        }
                        catch (e) {}
                    }
                }



                instance.isReady = true;
                gina.hasValidator = true;
                gina.validator = instance;
                triggerEvent(gina, instance.target, 'ready.' + instance.id, instance);
            });

        }

        instance.initialized = true;
        return instance
    }

    var initForm = function ($form) {

        var customRule = null
            , rules = ( typeof(local.rules.count() > 0 ) ) ? local.rules : instance.rules
        ;

        if ($form.getAttribute) {
            id = $form.getAttribute('id') || 'form.' + uuid.v4();
            if (id !== $form.getAttribute('id')) {
                $form.setAttribute('id', id)
            }
        } else {
            id = 'form.' + uuid.v4();
            $form.setAttribute('id', id)
        }

        $form.id = $validator.id = id;

        if (typeof ($form.id) != 'undefined' && $form.id != 'null' && $form.id != '') {

            $validator.target = $form;
            instance.$forms[$form.id] = merge({}, $validator);

            customRule = $form.getAttribute('data-gina-form-rule');

            if (customRule) {
                customRule = customRule.replace(/\-|\//g, '.');
                if ( typeof(rules[customRule]) == 'undefined') {
                    customRule = null;
                    throw new Error('[' + $form.id + '] no rule found with key: `' + customRule + '`');
                } else {
                    customRule = rules[customRule]
                }
            }

            // finding forms handled by rules
            if (typeof ($form.id) == 'string' && typeof (rules[$form.id.replace(/\-/g, '.')]) != 'undefined') {
                $target = instance.$forms[$form.id].target;
                if (customRule) {
                    bindForm($target, customRule)
                } else {
                    bindForm($target)
                }

            } else {
                // weird exception when having in the form an element with name="id"
                if (typeof ($form.id) == 'object') {
                    delete instance.$forms[$form.id];

                    var _id = $form.attributes.getNamedItem('id').nodeValue || 'form.' + uuid.v4();

                    $form.setAttribute('id', _id);
                    $form.id = _id;

                    $validator.target = $form;
                    instance.$forms[_id] = merge({}, $validator);

                    $target = instance.$forms[_id].target;
                    if (customRule) {
                        bindForm($target, customRule)
                    } else {
                        bindForm($target)
                    }
                } else {

                    $target = instance.$forms[$form.id].target;
                    if (customRule) {
                        bindForm($target, customRule)
                    } else {
                        bindForm($target)
                    }
                }
            }
        }
    }

    /**
     * parseRules - Preparing rules paths
     *
     * @param {object} rules
     * @param {string} tmp - path
     * */
    var parseRules = function(rules, tmp) {
        var _r = null;
        for (var r in rules) {

            if ( typeof(rules[r]) == 'object' && typeof(instance.rules[tmp + r]) == 'undefined' ) {

                _r = r;
                if (/\[|\]/.test(r) ) { // must be a real path
                    _r = r.replace(/\[/g, '.').replace(/\]/g, '');
                }

                instance.rules[tmp + _r] = rules[r];

                //delete instance.rules[r];
                parseRules(rules[r], tmp + _r +'.');
            }
        }
    }

    var getRuleObjByName = function(ruleName) {

        if ( typeof(local.rules[ruleName]) != 'undefined' ) {
            return local.rules[ruleName]
        }
        var rules = null;
        // just in case : many ways to access this method
        if ( typeof(instance.rules[ruleName]) == 'undefined' ) {
            parseRules(local.rules, '');
            local.rules = checkForRulesImports(local.rules);
            rules = local.rules[ruleName];
            if ( !rules ) {
                return {}
            }
        } else {
            rules = instance.rules[ruleName]
        }

        var ruleObj = JSON.clone(rules)
            , re = new RegExp('^'+ruleName)
            , propRe = new RegExp('^'+ruleName +'.')
            , propName = null
        ;

        var rulesFromPath = function(obj, keys, val, originalRuleObj, field, i, len) {
            if (!keys.length) {
                return
            }

            var _id = Object.getOwnPropertyNames(obj)[0];
            var _key = keys[0];
            var nextFieldName = null;
            if ( field == '') {
                field += _key;
                nextFieldName = field
            } else {
                nextFieldName =  field + '['+ _key + ']'
            }

            if ( keys.length == 1) {
                // obj[ _key ] =  (
                //     typeof(obj[ _key ]) == 'undefined'
                //     && typeof(val) == 'object'
                //     && Array.isArray(val)
                // ) ? [] : {} ;

                obj[ _id ] = merge(obj[ _id ], val, true);

                // if (
                //     typeof(originalRuleObj[nextFieldName]) != 'undefined'
                //     //&& typeof(originalRuleObj[nextFieldName][_key]) != 'undefined'
                // ) {

                //     originalRuleObj[nextFieldName] = val//merge(originalRuleObj[nextFieldName], val, true);
                //     //if ( typeof(originalRuleObj[nextFieldName][_key]) != 'undefined' ) {
                //     //    originalRuleObj[nextFieldName][_key] = val
                //     //}// else {
                //       //  originalRuleObj[nextFieldName][_key] = merge(originalRuleObj[nextFieldName][_key], val, true);
                //     //}


                // } else if (
                //     typeof(originalRuleObj[field]) != 'undefined'
                //     //&& typeof(originalRuleObj[field][_key]) != 'undefined'
                // ) {
                //     originalRuleObj[field] = val
                //     //originalRuleObj[field] = merge(originalRuleObj[field], val, true);
                //     //if ( typeof(originalRuleObj[field][_key]) != 'undefined' ) {
                //     //    originalRuleObj[field][_key] = val//merge(originalRuleObj[field][_key], val, true);
                //     //} //else {
                //      //   originalRuleObj[field] = merge(originalRuleObj[field], val, true);
                //     //}

                // }  else if ( typeof(originalRuleObj[_key]) != 'undefined' ) {
                //     originalRuleObj[_key] = val
                //    //originalRuleObj[_key] = merge(originalRuleObj[_key], val, true)
                // }


            } //else if ( typeof(originalRuleObj[nextFieldName]) != 'undefined' ) {
            //    field = nextFieldName;
            //}

            keys.splice(0,1);
            if (nextFieldName == _id) {
                rulesFromPath(obj[ _id ], keys, val, originalRuleObj, nextFieldName, i, len)
            } else if ( typeof(obj[ _id ]) != 'undefined' ) {
                rulesFromPath(obj[ _id ], keys, val, originalRuleObj, nextFieldName, i, len)
            } else {
                rulesFromPath(obj, keys, val, originalRuleObj, field, i, len)
            }

        }

        for (var prop in instance.rules) {
            if ( prop != ruleName && re.test(prop) ) {

                propName = prop.replace(propRe, '');
                if ( /\./.test(propName) ) {
                    var keys = propName.split(/\./g);
                    rulesFromPath( ruleObj, keys, instance.rules[prop], ruleObj, '',  0, ruleObj.count()-1 )
                }
            }
        }
        //cache rules
        local.rules[ruleName] = ruleObj;
        return ruleObj
    }


    /**
     * makeObjectFromArgs
     *
     *
     * @param {string} root
     * @param {array} args
     * @param {object} obj
     * @param {number} len
     * @param {number} i
     * @param {string|object} value
     * @param {object} [rootObj]
     *
     * @returns {Object} rootObj
     */
    var makeObjectFromArgs = function(_root, args, _obj, len, i, _value, _rootObj) {

        // Closure Compiler requirements
        var _global = window['gina']['_global'];
        // js_externs
        _global.register({
            'root'      : _root || null,
            'obj'       : _obj || null,
            'value'     : _value || null,
            'rootObj'   : _rootObj || null
        });


        if (i == len) { // end
            eval(root +'=value');
            // backup result
            var result = JSON.clone(rootObj);
            // cleanup _global
            _global.unregister(['root', 'obj', 'rootObj', 'value', 'valueType']);
            return result
        }

        var key = args[i].replace(/^\[|\]$/g, '');

        // init root object
        if ( typeof(rootObj) == 'undefined' || !rootObj ) {
            rootObj = {};
            root = 'rootObj';

            root += (/^\d+$/.test(key)) ? '['+ key + ']' : '["'+ key +'"]';
            eval(root +'=obj');
        } else {
            root += (/^\d+$/.test(key)) ? '['+ key + ']' : '["'+ key +'"]';
        }


        var nextKey = ( typeof(args[i + 1]) != 'undefined' ) ? args[i + 1].replace(/^\[|\]$/g, '') : null;
        var valueType = ( nextKey && parseInt(nextKey) == nextKey ) ? [] : {};
        _global.register({
            'valueType' : valueType
        });
        if ( nextKey ) {
            eval(root +' = valueType');
        }

        if ( typeof(obj[key]) == 'undefined' ) {

            if (/^\d+$/.test(nextKey)) { // collection index ?
                obj[key] = [];
            } else {
                obj[key] = {};
            }

            ++i;
            return makeObjectFromArgs(root, args, obj[key], len, i, value, rootObj);
        }

        ++i;
        return makeObjectFromArgs(root, args, obj[key], len, i, value, rootObj);
    }



    /**
     * makeObject - Preparing form data
     *
     * @param {object} obj - data
     * @param {string\number\boolean} value
     * @param {array} string
     * @param {number} len
     * @param {number} i
     *
     * */
    var makeObject = function (obj, value, args, len, i) {

        if (i >= len) {
            return false
        }

        var key     = args[i].replace(/^\[|\]$/g, '');
        var nextKey = ( i < len-1 && typeof(args[i+1]) != 'undefined' ) ?  args[i+1].replace(/^\[|\]$/g, '') : null;

        if ( typeof(obj[key]) == 'undefined' ) {
            if (nextKey && /^\d+$/.test(nextKey)) {
                nextKey = parseInt(nextKey);
                obj[key] = []
            } else {
                obj[key] = {}
            }
        }

        var tmpObj = null;
        if ( Array.isArray(obj[key]) ) {
            //makeObjectFromArgs(obj[key], args, obj[key], args.length, 1, value);
            tmpObj = makeObjectFromArgs(key, args, obj[key], args.length, 1, value, null);
            obj[key] = merge(obj[key], tmpObj);
            makeObject(obj[key], value, args, len, i + 1);
        } else {
            if (i == len - 1) {
                obj[key] = value;
            }// else {
                makeObject(obj[key], value, args, len, i + 1)
            //}
        }
    }

    var formatData = formatDataFromString;

    // var formatData = function (data) {

    //     var args        = null
    //         , obj       = {}
    //         , key       = null
    //         , fields    = {}
    //         , altName   = null
    //     ;

    //     var makeFields = function(fields, isObject, data, len, i) {
    //         if (i == len ) { // exit
    //             return fields
    //         }

    //         var name = (isObject) ? Object.keys(data)[i] : i;

    //         if ( /\[(.*)\]/.test(name) ) {
    //             // backup name key
    //             key = name;
    //             // properties
    //             args    = name.match(/(\[[-_\[a-z 0-9]*\]\]|\[[-_\[a-z 0-9]*\])/ig);
    //             // root
    //             name    = name.match(/^[-_a-z 0-9]+\[{0}/ig);
    //             //altName = name.replace(/.*\[(.+)\]$/, "$1");

    //             if ( typeof(fields[name]) == 'undefined' ) {
    //                 fields[name] = ( Array.isArray(data[key]) ) ? [] : {};
    //             }
    //             // building object tree
    //             makeObject(obj, data[key], args, args.length, 0);

    //             fields[name] = merge(fields[name], obj);
    //             obj = {};

    //         } else { // normal case
    //             fields[name] = data[name];
    //         }
    //         name = null;
    //         altName = null;

    //         ++i;
    //         return makeFields(fields, isObject, data, len, i);
    //     }

    //     var len = ( typeof(data) == 'undefined' ) ? 0 : 1;// by default
    //     var isObject = false;
    //     if (Array.isArray(data)) {
    //         len = data.length;
    //     } else if ( typeof(data) == 'object' ) {
    //         len = data.count();
    //         isObject = true;
    //     }

    //     return makeFields(fields, isObject, data, len, 0);
    //     //return fields
    // }

    var checkForDuplicateForm = function(id) {
        // check for duplicate form ids
        var $allForms = document.getElementsByTagName('form');
        var dID = null, duplicateFound = {};
        for (var d = 0, dLen = $allForms.length; d < dLen; ++d) {
            dID = $allForms[d].getAttribute('id') || null;
            if ( typeof(duplicateFound[dID]) == 'undefined'  ) {
                duplicateFound[dID] = true;
            } else {
                if ( typeof(instance.$forms[dID]) != 'undefined' && !instance.$forms[dID].warned) {
                    if (gina.popinIsBinded) {
                        console.warn('Popin/Validator::bindForm($target, customRule): `'+ dID +'` is a duplicate form ID. If not fixed, this could lead to an undesirable behaviour.\n Check inside your popin content');
                    } else {
                        console.warn('Validator::bindForm($target, customRule): `'+ dID +'` is a duplicate form ID. If not fixed, this could lead to an undesirable behaviour.');
                    }
                    instance.$forms[dID].warned = true;
                }
            }
        }
    }


    var setObserver = function ($el) {
        var $formInstance = instance.$forms[$el.form.getAttribute('id')];
        var isDisabled = ( /^true$/i.test($el.disabled) ) ? true : false;
        if (
            isDisabled
            && typeof($formInstance.rule) != 'undefined'
            && typeof($formInstance.rule[$el.name]) != 'undefined'
            && typeof($formInstance.rule[$el.name].exclude) != 'undefined'
            && /^false$/i.test($formInstance.rule[$el.name].exclude)
        ) {
            isDisabled = false;
        }
        // var allowedTypes = allowedLiveInputTypes.slice();
        if (!/^(radio|text|hidden|password|number|date|email)$/i.test($el.type) || isDisabled) {
            return;
        }

        // Credits to `Maciej Swist` @https://stackoverflow.com/questions/42427606/event-when-input-value-is-changed-by-javascript
        var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        var inputSetter = descriptor.set;

        //Then modify the "setter" of the value to notify when the value is changed:
        descriptor.set = function(val) {

            //changing to native setter to prevent the loop while setting the value
            Object.defineProperty(this, 'value', {set:inputSetter});

            var _evt = 'change.' + this.id;
            if ( val === this.value && val === this.defaultValue) {
                Object.defineProperty(this, 'value', descriptor);
                return;
            }
            if ( val === this.value) {
                //changing back to custom setter
                Object.defineProperty(this, 'value', descriptor);
                return;
            }

            this.value = val;
            // if (document.getElementById(this.id).value !== this.value) {
            //     document.getElementById(this.id).value = this.value;
            // }

            //Custom code triggered when $el.value is set
            console.debug('Value set: '+val);

            if ( typeof(gina.events[_evt]) != 'undefined' ) {
                console.debug('trigger event on: ', this.name, _evt);
                triggerEvent(gina, this, _evt, val);
            }
            //changing back to custom setter
            Object.defineProperty(this, 'value', descriptor);
        }

        //Last add the new "value" descriptor to the $el element
        Object.defineProperty($el, 'value', descriptor);
    }

    var addLiveForInput = function($form, $el, liveCheckTimer, isOtherTagAllowed) {

        if (typeof(isOtherTagAllowed) == 'undefined' ) {
            isOtherTagAllowed = false;
        }
        var rules = $form.rules;
        var $formInstance = instance.$forms[$el.form.getAttribute('id')];
        var isDisabled = ( /^true$/i.test($el.disabled) ) ? true : false;
        if (
            isDisabled
            && typeof($formInstance.rule) != 'undefined'
            && typeof($formInstance.rule[$el.name]) != 'undefined'
            && typeof($formInstance.rule[$el.name].exclude) != 'undefined'
            && /^false$/i.test($formInstance.rule[$el.name].exclude)
        ) {
            isDisabled = false;
        }
        // allowedLiveInputTypes
        if ( /^(radio|checkbox|text|hidden|password|number|date|email)$/i.test($el.type) && !isDisabled  || isOtherTagAllowed && !isDisabled ) {
            var field = $el.name;
            var localRule = rules[field] || null;
            if ( !localRule ) {
                checkForRuleAlias(rules, $el);

                if ( typeof(rules[field]) == 'undefined' )
                    return;
            }
            // data-gina-form-live-check-enabled
            // with local rule
            if ( $form.target.dataset.ginaFormLiveCheckEnabled && localRule) {

                var eventsList = [], _evt = null, _e = 0;
                if ( !/^(radio|checkbox)$/i.test($el.type) ) {
                    addEventListener(gina, $el, 'focusout.'+$el.id, function(event) {
                        event.preventDefault();
                        clearTimeout(liveCheckTimer);
                    });

                    // BO Livecheck local events
                    _evt = 'change.'+$el.id;
                    if ( typeof(gina.events[_evt]) == 'undefined' ) {
                        eventsList[_e] = _evt;
                        ++_e;
                    }

                    _evt = 'keyup.'+$el.id;
                    if ( typeof(gina.events[_evt]) == 'undefined' ) {
                        eventsList[_e] = _evt;
                        ++_e;
                    }
                    _evt = 'focusin.'+$el.id;
                    if ( typeof(gina.events[_evt]) == 'undefined' ) {
                        eventsList[_e] = _evt;
                        ++_e;
                    }
                    _evt = 'focusout.'+$el.id;
                    if ( typeof(gina.events[_evt]) == 'undefined' ) {
                        eventsList[_e] = _evt;
                        ++_e;
                    }
                    // EO Livecheck local events
                } else {
                    if ( /^(radio|checkbox)$/i.test($el.type) ) {
                        _evt = 'changed.'+$el.id;
                    } else {
                        _evt = 'change.'+$el.id;
                    }

                    if ( typeof(gina.events[_evt]) == 'undefined' ) {
                        eventsList[_e] = _evt;
                        ++_e;
                    }
                }

                if (eventsList.length > 0) {
                    var once = false;
                    addListener(gina, $el, eventsList, function(event) {
                        event.preventDefault();
                        clearTimeout(liveCheckTimer);
                        if ( !once && /^changed\./i.test(event.type) || !once && /^(radio|checkbox)$/i.test(event.target.type) ) {
                            once = true;
                        } else if (once && /^changed\./i.test(event.type) || once && /^(radio|checkbox)$/i.test(event.target.type) ) {
                            return false;
                        }

                        if (
                            typeof(instance.$forms[event.target.form.getAttribute('id')].isSubmitting) != 'undefined'
                            && /true/i.test(instance.$forms[event.target.form.getAttribute('id')].isSubmitting)
                        ) {
                            return false;
                        }

                        var processEvent = function() {

                            console.debug('processing: ' + event.target.name+ '/'+ event.target.id);

                            // Do not validate `onChange` if `input value` === `orignal value`
                            // Or else, you will get an endless loop
                            if (
                                // ignoring checkbox & radio because value for both have already changed
                                !/^(radio|checkbox)$/i.test(event.target.type)
                                && event.target.value === event.target.defaultValue
                                && event.target.value != ''
                            ) {
                                //resetting error display
                                var errors = instance.$forms[event.target.form.getAttribute('id')].errors;
                                if (!errors || errors.count() == 0) {
                                    handleErrorsDisplay(event.target.form, {}, null, event.target.name);
                                    return cancelEvent(event);
                                } else {
                                    handleErrorsDisplay(event.target.form, errors, null, event.target.name);
                                }
                                //return cancelEvent(event);
                            }


                            var localField = {}, $localField = {};
                            localField[event.target.name]     = event.target.value;
                            $localField[event.target.name]    = event.target;

                            instance.$forms[event.target.form.getAttribute('id')].isValidating = true;
                            validate(event.target, localField, $localField, $form.rules, function onLiveValidation(result){
                                instance.$forms[event.target.form.getAttribute('id')].isValidating = false;
                                //console.debug('validation on processEvent(...) ', result);

                                var isFormValid = result.isValid();
                                //console.debug('onSilentPreGlobalLiveValidation: '+ isFormValid, result);
                                if (isFormValid) {
                                    //resetting error display
                                    handleErrorsDisplay(event.target.form, {}, result.data, event.target.name);
                                } else {
                                    handleErrorsDisplay(event.target.form, result.error, result.data, event.target.name);
                                }
                                //updateSubmitTriggerState( event.target.form, isFormValid );
                                // data-gina-form-required-before-submit
                                //console.debug('====>', result.isValid(), result);

                                // Global check required: on all fields
                                var $gForm = event.target.form, gFields = null, $gFields = null, gRules = null;
                                var gValidatorInfos = getFormValidationInfos($gForm, rules);
                                gFields  = gValidatorInfos.fields;
                                $gFields = gValidatorInfos.$fields;
                                var formId = $gForm.getAttribute('id');
                                gRules   = instance.$forms[formId].rules;
                                // Don't be tempted to revome fields that has already been validated
                                instance.$forms[formId].isValidating = true;
                                validate($gForm, gFields, $gFields, gRules, function onSilentGlobalLiveValidation(gResult){
                                    instance.$forms[formId].isValidating = false;
                                    console.debug('['+ formId +'] onSilentGlobalLiveValidation: '+ gResult.isValid(), gResult);
                                    var isFormValid = gResult.isValid();
                                    if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                        // update toolbar
                                        if (!gina.forms.errors)
                                            gina.forms.errors = {};

                                        var objCallback = {
                                            id      : formId,
                                            errors  :  gResult.error || {}
                                        };

                                        window.ginaToolbar.update('forms', objCallback);
                                    }


                                    updateSubmitTriggerState( $gForm, isFormValid);

                                    once = false;
                                })

                            });


                            return;
                        }

                        // radio & checkbox only
                        if (
                            /^changed\./i.test(event.type)
                            ||
                            /^change\./i.test(event.type)
                            && event.target.type == 'radio'
                        ) {
                            var i = 0;
                            return function(once, i) {
                                if (i > 0) return;
                                ++i;
                                return setTimeout(() => {
                                    console.debug(' changed .... '+$el.id);
                                    processEvent();
                                }, 0);

                            }(once, i)

                        }
                        // other inputs & textareas
                        else if ( /^focusin\./i.test(event.type) ) {
                            if ( /\-error/.test($el.parentNode.className) ) {
                                console.debug('#1 you just focusin ....'+$el.id, $el.value);
                                refreshWarning($el);
                            }
                        }
                        else if ( /^focusout\./i.test(event.type) ) {
                            if ( /\-warning/.test($el.parentNode.className) ) {
                                console.debug('#1 you just focusout ....'+$el.id, $el.value);
                                refreshWarning($el);
                                // in case error context is changed by another task
                                handleErrorsDisplay($el.form, instance.$forms[ $el.form.getAttribute('id') ].errors, null, $el.name);
                            }
                        }
                        else if ( /^keyup\./i.test(event.type) ) {
                            $el.ginaFormValidatorTestedValue = $el.value;
                            liveCheckTimer = setTimeout( function onLiveCheckTimer() {
                                // do not trigger for copy/paste event
                                if ( ['91', '17'].indexOf(''+event.keyCode) > -1  && keyboardMapping.count() == 0) {
                                    //console.debug('mapping ', keyboardMapping);
                                    return;
                                }
                                console.debug(' keyup ('+ event.keyCode +') .... '+$el.id, $el.value, ' VS ',$el.ginaFormValidatorTestedValue + '(old)');
                                processEvent();
                            }, 1000);
                        }
                        else if (/^change\./i.test(event.type) && !/^(checkbox)$/i.test(event.target.type) ) {
                            console.debug(' change .... '+$el.id);
                            processEvent();
                        }
                    });
                }
            }
        }
        return;
    }



    var setSelectionRange = function($el, selectionStart, selectionEnd) {
        if ($el.setSelectionRange) {
            $el.focus();
            $el.setSelectionRange(selectionStart, selectionEnd);
        }
        else if ($el.createTextRange) {
            var range = $el.createTextRange();
            range.collapse(true);
            range.moveEnd  ('character', selectionEnd  );
            range.moveStart('character', selectionStart);
            range.select();
        }
    }
    /**
     * setCaretToPos
     * If called after change of `readonly`, use `$el.blur()` before the call
     *
     * @param {object} $el - HTMLElement
     * @param {number} pos
     */
    var setCaretToPos = function ($el, pos) {
        setSelectionRange($el, pos, pos);
    }

    var isElementVisible = function($el) {
        return ($el.offsetWidth > 0 || $el.offsetHeight > 0 || $el === document.activeElement) ? true : false;
    }

    var focusNextElement = function($el, isGoingBackward) {
        // Add all elements we want to include in our selection
        // Checkboxes and radios are just ignored: like for the default behavior
        var focussableElements = 'a:not([disabled]), button:not([disabled]), input[type=text]:not([disabled]), select:not([disabled]), [tabindex]:not([disabled]):not([tabindex="-1"])';
        if (document.activeElement && document.activeElement.form) {
            var focussable = Array.prototype.filter.call(document.activeElement.form.querySelectorAll(focussableElements),
            function (element) {
                //Check for visibility while always include the current activeElement
                return element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement
            });
            var index = focussable.indexOf(document.activeElement);
            if(index > -1) {
                var direcion = focussable[index + 1]; // By default, going forward
                if (isGoingBackward) {
                    direcion = focussable[index - 1]
                }
                var nextElement = direcion || focussable[0];
                nextElement.focus();
            }
        }
    }
    /**
     * handleAutoComplete
     * This is a temporary fix to handle safari autocomplete/autosuggest
     * Will be removed when Safari honores autocomplete="off"
     * @param {object} $el HTMLElement
     */
    var handleAutoComplete = function($el, liveCheckTimer) {
        $el.setAttribute('readonly', 'readonly');
        addListener(gina, $el, 'focusout.'+ $el.id, function(event) {
            event.preventDefault();
            clearTimeout(liveCheckTimer);

            var $_el = event.currentTarget;
            triggerEvent(gina, $_el, 'change.'+ $_el.id);
            $_el.setAttribute('readonly', 'readonly');
        });
        addListener(gina, $el, 'focusin.'+ $el.id, function(event) {
            event.preventDefault();
            event.currentTarget.removeAttribute('readonly');

            var evtName = 'keydown.'+ event.currentTarget.id;
            // add once
            if ( typeof(gina.events[evtName]) == 'undefined' ) {
                addListener(gina, event.currentTarget, evtName, function(e) {
                    e.preventDefault();
                    clearTimeout(liveCheckTimer);

                    var $_el = e.currentTarget;
                    var str = e.currentTarget.value;
                    var posStart = $_el.selectionStart, posEnd = $_el.selectionEnd;
                    $_el.removeAttribute('readonly');
                    //console.debug('pressed: '+ e.key+'('+ e.keyCode+')', ' S:'+posStart, ' E:'+posEnd, ' MAP: '+ JSON.stringify(keyboardMapping));
                    switch (e.keyCode) {
                        case 46: //Delete
                        case 8: //Backspace
                            if (posStart != posEnd) {
                                $_el.value = str.substr(0, posStart) + str.substr(posEnd);
                                if (posStart == 0) {
                                    $_el.value = str.substr(posEnd);
                                }
                            } else if (posStart == 0) {
                                $_el.value = str.substring(posStart+1);
                            } else {
                                $_el.value = str.substr(0, posStart-1) + str.substr(posEnd);
                            }

                            e.currentTarget.setAttribute('readonly', 'readonly');
                            setTimeout(() => {
                                $_el.removeAttribute('readonly');
                                setTimeout(() => {
                                    if (posStart != posEnd) {
                                        setCaretToPos($_el, posStart);
                                    } else if (posStart == 0) {
                                        setCaretToPos($_el, posStart);
                                    } else {
                                        setCaretToPos($_el, posStart-1);
                                    }
                                }, 0)

                            }, 0);
                            break;
                        case 9: // Tab
                            if (keyboardMapping[16] && keyboardMapping[9]) {
                                focusNextElement($_el, true);
                            } else {
                                focusNextElement($_el);
                            }
                            break;
                        case 13: // Enter
                        case 16: // Shift
                            break;
                        case 37: // ArrowLeft
                            console.debug('moving left ', posStart-1);
                            setCaretToPos($_el, posStart-1);
                            break;
                        case 39: // ArrowRight
                            if (posStart+1 < str.length+1) {
                                setCaretToPos($_el, posStart+1);
                            }
                            break;
                        // Shortcuts
                        case 17: //CTRL
                        case 91: //CMD
                            console.debug("CMD hit");
                            e.preventDefault();
                            break;
                        case 67: // to handle CMD+C (copy)
                            if (
                                keyboardMapping[67] && keyboardMapping[91] // mac osx
                                ||
                                keyboardMapping[67] && keyboardMapping[17] // windows
                            ) {
                                $_el.setSelectionRange(posStart, posEnd);
                                document.execCommand("copy");
                                break;
                            }
                        case 86: // to handle CMD+V (paste)
                            if (
                                keyboardMapping[86] && keyboardMapping[91] // mac osx
                                ||
                                keyboardMapping[86] && keyboardMapping[17] // windows
                            ) {
                                if (posStart != posEnd) {
                                    $_el.value = $_el.value.replace(str.substring(posStart, posEnd), '');
                                }
                                setCaretToPos($_el, posStart);
                                document.execCommand("paste");
                                break;
                            }
                        case 88: // to handle CMD+X (cut)
                            if (
                                keyboardMapping[88] && keyboardMapping[91] // mac osx
                                ||
                                keyboardMapping[88] && keyboardMapping[17] // windows
                            ) {
                                $_el.setSelectionRange(posStart, posEnd);
                                document.execCommand("cut");
                                break;
                            }
                        case 90: // to handle CMD+Z (undo)
                            if (
                                keyboardMapping[90] && keyboardMapping[91] // mac osx
                                ||
                                keyboardMapping[90] && keyboardMapping[17] // windows
                            ) {
                                $_el.value = $_el.defaultValue;
                                break;
                            }
                        default:
                            // Replace selection
                            if (posStart != posEnd) {
                                $_el.value = str.substr(0, posStart) + e.key;
                                if (posEnd-1 < str.length) {
                                    $_el.value += str.substring(posEnd)
                                }
                            } else if (posStart == 0) {
                                $_el.value = e.key + str.substring(posStart);
                            } else {
                                $_el.value = str.substr(0, posStart) + e.key + str.substr(posEnd);
                            }
                            e.currentTarget.setAttribute('readonly', 'readonly');
                            // Force restore last caret position
                            setTimeout(() => {
                                $_el.removeAttribute('readonly');
                                setTimeout(() => {
                                    setCaretToPos($_el, posStart+1);
                                }, 0);

                            }, 0);
                            break;
                    } //EO Switch
                });
            }

        });
    }

    var registerForLiveChecking = function($form, $el) {
        // Filter supported elements
        if (
            !/^(input|textarea)$/i.test($el.tagName)
            ||
            typeof(gina.events['registered.' + $el.id]) != 'undefined'
        ) {
            return
        }
        // Mutation obeserver - all but type == files
        if ( !/^file$/i.test($el.type) ) {
            setObserver($el);
        }
        var liveCheckTimer = null
        switch ($el.tagName.toLowerCase()) {

            case 'textarea':
                addLiveForInput($form, $el, liveCheckTimer, true);
                break;
            default:
                addLiveForInput($form, $el, liveCheckTimer);
                // Bypass Safari autocomplete
                var isAutoCompleteField = $el.getAttribute('autocomplete');
                if (
                    /safari/i.test(navigator.userAgent)
                    && isAutoCompleteField
                    && /^(off|false)/i.test(isAutoCompleteField)
                ) {
                    handleAutoComplete($el, liveCheckTimer)
                }
                break;
        }
        gina.events['registered.' + $el.id] = $el.id;
    }

    /**
     * bindUploadResetOrDeleteTrigger
     *
     * @param {string} bindingType - `reset`or `delete`
     * @param {object} $uploadTrigger - HTMLFormElement
     * @param {number} index
     *
     */
     var bindUploadResetOrDeleteTrigger = function(bindingType, $uploadTrigger, index) {

        // Binding upload reset or delete trigger
        // var $currentForm = $uploadTrigger.form;
        // for (let i = 0, len = $currentForm.length; )
        // trigger is by default you {input.id} + '-delete-trigger'
        // e.g.: <input type="file" id="my-upload" name="my-upload">
        // => <a href="/path/to/tmpfile/delete-action" id="my-upload-delete-trigger">Remove</a>
        // But you can use atrtibute `data-gina-form-upload-delete-trigger` to override it
        var uploadResetOrDeleteTriggerId = $uploadTrigger.id + '-' +index+ '-'+bindingType+'-trigger';
        var $uploadResetOrDeleteTrigger = document.getElementById(uploadResetOrDeleteTriggerId);
        if (!$uploadResetOrDeleteTrigger) {
            uploadResetOrDeleteTriggerId = $uploadTrigger.getAttribute('data-gina-form-upload-'+ '-' +index+ +bindingType+'-trigger');
            $uploadResetOrDeleteTrigger = document.getElementById(uploadResetOrDeleteTriggerId);
        }

        if (
            $uploadResetOrDeleteTrigger
            && typeof($uploadResetOrDeleteTrigger.isBinded) == 'undefined'
            ||
            $uploadResetOrDeleteTrigger
            && typeof($uploadResetOrDeleteTrigger.isBinded) != 'undefined'
            && !/true/i.test($uploadResetOrDeleteTrigger.isBinded)
        ) {
            addListener(gina, $uploadResetOrDeleteTrigger, 'click', function onUploadResetOrDeleteTriggerClick(e) {
                e.preventDefault();

                onUploadResetOrDelete($uploadTrigger, bindingType);
            });
            $uploadResetOrDeleteTrigger.isBinded = true;
        } else {
            console.warn('[FormValidator::bindForm][upload]['+$uploadTrigger.id+'] : did not find `upload '+bindingType+' trigger`.\nPlease, make sure that your delete element ID is `'+ uploadResetOrDeleteTriggerId +'-'+bindingType+'-trigger`, or add to your file input ('+ $uploadTrigger.id +') -> `data-gina-form-upload-'+bindingType+'-trigger="your-custom-id"` definition.');
        }
    }

    var checkUploadUrlActions = function($el, $errorContainer) {

        var checkAction = function($el, action, $errorContainer) {
            var defaultRoute = null;
            switch (action) {
                case 'data-gina-form-upload-action':
                    defaultRoute = 'upload-to-tmp-xml';
                    break;
                case 'data-gina-form-upload-reset-action':
                    defaultRoute = 'upload-delete-from-tmp-xml';
                    break;
            }
            var uploadActionUrl = $el.getAttribute(action);
            if (!uploadActionUrl || uploadActionUrl == '' ) {
                if (!defaultRoute)
                    console.warn('`'+ action +'` definition not found for `'+ $el.id + '`. Trying to get default route.');
                var additionalErrorDetails = null;
                try {
                    if (defaultRoute)
                        uploadActionUrl = routing.getRoute(defaultRoute);
                } catch (err) {
                    additionalErrorDetails = err;
                }

                if (uploadActionUrl) {
                    console.info('Ignore previous warnings regarding upload. I have found a default `'+action+'` route: `'+ defaultRoute +'@'+ uploadActionUrl.bundle +'`');
                    $el.setAttribute('data-gina-form-upload-action', uploadActionUrl.toUrl());
                } else {
                    var errMsg = '`'+ action +'` needs to be defined to proceed for your `input[type=file]` with ID `'+ $el.id +'`\n'+ additionalErrorDetails +'\n';
                    if ($errorContainer) {
                        $errorContainer.innerHTML += errMsg.replace(/(\n|\r)/g, '<br>');
                    }
                    console.error(errMsg);
                }
            }
        }
        // checking upload-action
        checkAction($el, 'data-gina-form-upload-action', $errorContainer);
        // checking upload-reset-action
        checkAction($el, 'data-gina-form-upload-reset-action', $errorContainer);
        // checking upload-delete-action
        checkAction($el, 'data-gina-form-upload-delete-action', $errorContainer);
    }

    /**
     * reBindForm - This is a WIP
     *
     * @param {object} HTMLElement
     * @param {object} rules
     * @returns {object} formValidatorInstance
     */
    var reBindForm = function($target, rules, cb) {
        // Unbind form
        var formInstance = unbindForm($target);
        // reset errors
        //resetErrorsDisplay(formInstance.id);
        // Bind
        bindForm(formInstance.target, rules);

        if ( cb ) {
            return cb(formInstance);
        }
        return formInstance;
    }

    var unbindForm = function($target) {
        var $form   = null
            , _id   = null
        ;

        try {
            if ( $target.getAttribute && $target.getAttribute('id') ) {
                _id = $target.getAttribute('id');
                if ( typeof(instance.$forms[_id]) != 'undefined')
                    $form = instance.$forms[_id];
                else
                    throw new Error('form instance `'+ _id +'` not found');

            } else if ( typeof($target.target) != 'undefined' ) {
                $form = $target;
                _id = $form.id;
            } else {
                throw new Error('Validator::unbindForm($target): `$target` must be a DOM element\n'+err.stack )
            }
        } catch(err) {
            throw new Error('Validator::unbindForm($target) could not unbind form `'+ $target +'`\n'+err.stack )
        }

        // No need to unbind if not binded
        if ( typeof($form) != 'undefined' && !$form.binded) {
            return $form
        }

        // form events
        removeListener(gina, $form, 'success.' + _id);
        removeListener(gina, $form, 'error.' + _id);

        if ($form.target.getAttribute('data-gina-form-event-on-submit-success'))
            removeListener(gina, $form, 'success.' + _id + '.hform');

        if ($form.target.getAttribute('data-gina-form-event-on-submit-error'))
            removeListener(gina, $form, 'error.' + _id + '.hform');

        removeListener(gina, $form, 'validate.' + _id);
        removeListener(gina, $form, 'validated.' + _id);
        removeListener(gina, $form, 'submit.' + _id);
        removeListener(gina, $form, 'reset.' + _id);



        // binded elements
        var $el         = null
            //, evt       = null
            , $els      = []
            , $elTMP    = [];

        // submit buttons
        $elTMP = $form.target.getElementsByTagName('button');
        if ( $elTMP.length > 0 ) {
            for(let i = 0, len = $elTMP.length; i < len; ++i) {
                // if button is != type="submit", you will need to provide : data-gina-form-submit
                // TODO - On button binding, you can then provide data-gina-form-action & data-gina-form-method
                $els.push($elTMP[i])
            }
        }

        // submit links
        $elTMP = $form.target.getElementsByTagName('a');
        if ( $elTMP.length > 0 ) {
            for(let i = 0, len = $elTMP.length; i < len; ++i) {
                $els.push($elTMP[i])
            }
        }

        // checkbox, radio, file, text, number, hidden, date .. ALL BUT hidden
        $elTMP = $form.target.getElementsByTagName('input');
        if ( $elTMP.length > 0 ) {
            for (let i = 0, len = $elTMP.length; i < len; ++i) {

                if ( !/^(hidden)$/i.test($elTMP[i].type) )
                    $els.push( $elTMP[i] );


                if (/^(file)$/i.test($elTMP[i].type)) {
                    // special case
                    // vForm has to be handle here, it does not exist in the document context
                    let vFormId = $elTMP[i].getAttribute('data-gina-form-virtual');
                    if ( vFormId ) {
                        let $vForm = getFormById(vFormId).target;
                        if ($vForm) {
                            $els.push( $vForm );
                            // `events` is defined on top of this file
                            // It is the list of allowed events
                            for (let e = 0, eLen = events.length; e < eLen; e++) {
                                let evt = events[e];
                                if ( typeof(gina.events[ evt +'.'+ vFormId + '.hform' ]) != 'undefined' && gina.events[ evt +'.'+ vFormId + '.hform' ] == vFormId ) {
                                    removeListener(gina, $vForm, evt +'.'+ vFormId + '.hform')
                                }
                            }
                        }
                    }
                } else { // other types
                    // `events` is defined on top of this file
                    // It is the list of allowed events
                    for (let e = 0, eLen = events.length; e < eLen; e++) {
                        let evt = events[e] +'.'+ $elTMP[i].id;
                        if ( typeof(gina.events[ evt ]) != 'undefined' && gina.events[ evt ] == $elTMP[i].id ) {
                            removeListener(gina, $elTMP[i], evt);
                        }
                        evt = events[e];
                        if ( typeof(gina.events[ evt ]) != 'undefined' && gina.events[ evt ] == $elTMP[i].id ) {
                            removeListener(gina, $elTMP[i], evt);
                        }
                        evt = $elTMP[i].id;
                        if ( typeof(gina.events[ evt ]) != 'undefined' && gina.events[ evt ] == $elTMP[i].id ) {
                            removeListener(gina, $elTMP[i], evt);
                        }
                    }
                }
            }
        }

        // textarea
        $elTMP = $form.target.getElementsByTagName('textarea');
        if ( $elTMP.length > 0 ) {
            for(let i = 0, len = $elTMP.length; i < len; ++i) {
                $els.push( $elTMP[i] )
            }
        }


        // forms inside main form
        $elTMP = $form.target.getElementsByTagName('form');
        if ( $elTMP.length > 0 ) {
            for(let i = 0, len = $elTMP.length; i < len; ++i) {
                $els.push( $elTMP[i] )
            }
        }
        // main form
        $els.push( $form.target );
        for (let i = 0, len = $els.length; i < len; ++i) {

            $el = $els[i];
            let eId = $el.getAttribute('id');
            for (let e = 0, eLen = events.length; e < eLen; e++) {
                let evt = events[e];
                let eventName = evt;
                // remove proxy
                // if ( typeof(gina.events[ evt ]) != 'undefined' ) {
                //     removeListener(gina, $el, evt);
                // }

                if ( typeof(gina.events[ eventName ]) != 'undefined' && gina.events[ eventName ] == eId ) {
                    removeListener(gina, $el, eventName);
                }

                // eventName = evt +'._case_'+ $el.name;
                // if ( typeof(gina.events[ eventName ]) != 'undefined') {
                //     removeListener(gina, $el, eventName);
                // }

                eventName = eId;
                if ( typeof(gina.events[ eventName ]) != 'undefined' && gina.events[ eventName ] == eId ) {
                    removeListener(gina, $el, eventName);
                }

                eventName = evt +'.'+ eId;
                if ( typeof(gina.events[ eventName ]) != 'undefined' && gina.events[ eventName ] == eId ) {
                    removeListener(gina, $el, eventName);
                }

                eventName = evt +'.'+ eId;
                if ( typeof(gina.events[ eventName ]) != 'undefined' && gina.events[ eventName ] == eventName ) {
                    removeListener(gina, $el, eventName);
                }

                eventName = evt +'.'+ eId + '.hform';
                if ( typeof(gina.events[ eventName ]) != 'undefined' && gina.events[ eventName ] == eId ) {
                    removeListener(gina, $el, eventName);
                }
            }// EO for events
        } //EO for $els

        $els = null; $el = null; $elTMP = null; evt = null;
        // reset error display
        //resetErrorsDisplay($form);
        // or
        // $form.target.dataset.ginaFormIsResetting = true;
        // handleErrorsDisplay($form.target, {});
        $form.binded = false;

        return $form;
    }

    var checkForRuleAlias = function(formRules, $el) {
        var field = $el.name;
        var localRule = formRules[field] || null;
        if ( !localRule ) {
            // looking for regexp aliases from rules
            for (let _r in formRules) {
                if ( /^\//.test(_r) ) { // RegExp found
                    re      = _r.match(/\/(.*)\//).pop();
                    flags   = _r.replace('/'+ re +'/', '');
                    // fix escaping "[" & "]"
                    re      = re.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                    re      = new RegExp(re, flags);
                    if ( re.test(field)  ) {
                        // create new entry
                        localRule = formRules[field] = formRules[_r];
                        break;
                    }
                }
            }
        }
    }

    /**
     * bindForm
     *
     * @param {object} $target - DOM element
     * @param {object} [customRule]
     * */
    var bindForm = function($target, customRule) {

        var $form   = null
            , _id   = null
            , rules = ( typeof(local.rules.count() > 0 ) ) ? local.rules : instance.rules
        ;

        try {
            if ( $target.getAttribute && $target.getAttribute('id') ) {
                _id = $target.getAttribute('id');
                if ( typeof(instance.$forms[_id]) != 'undefined')
                    $form = instance.$forms[_id];
                else
                    throw new Error('form instance `'+ _id +'` not found');

            } else {
                throw new Error('Validator::bindForm($target, customRule): `$target` must be a DOM element\n'+err.stack )
            }
        } catch(err) {
            throw new Error('Validator::bindForm($target, customRule) could not bind form `'+ $target +'`\n'+err.stack )
        }

        if ( typeof($form) != 'undefined' && $form.binded) {
            return false
        }

        console.debug('binding for: '+ _id);


        var withRules = false, rule = null, evt = '', proceed = null;

        if (
            typeof(customRule) != 'undefined'
            ||
            typeof(_id) == 'string'
                && typeof(rules[_id.replace(/\-|\//g, '.')]) != 'undefined'
        ) {
            withRules = true;

            if ( customRule && typeof(customRule) == 'object' ) {
                rule = customRule
            } else if (
                customRule
                && typeof(customRule) == 'string'
                && typeof(rules[customRule.replace(/\-|\//g, '.')]) != 'undefined'
            ) {
                rule = getRuleObjByName(customRule.replace(/\-|\//g, '.'))
            } else {
                rule = getRuleObjByName(_id.replace(/\-|\//g, '.'))
            }

            $form.rules = rule;
            if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                // update toolbar
                if (!gina.forms.rules)
                    gina.forms.rules = {};

                objCallback = {
                    id      : _id,
                    rules  : $form.rules
                };

                window.ginaToolbar.update('forms', objCallback);
            }
        } else { // form without any rule binded
            $form.rules = {}
        }

        // Live check by default - data-gina-form-live-check-enabled
        if (
            typeof($form.target.dataset.ginaFormLiveCheckEnabled) == 'undefined'
            && $form.rules.count() > 0
        ) {
            $form.target.dataset.ginaFormLiveCheckEnabled = true;
        } else if( typeof($form.target.dataset.ginaFormLiveCheckEnabled) != 'undefined' ) {
            $form.target.dataset.ginaFormLiveCheckEnabled = ( /^true$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) ? true : false;
        } else {
            $form.target.dataset.ginaFormLiveCheckEnabled = false;
        }

        // form fields collection
        if (!$form.fieldsSet)
            $form.fieldsSet = {};

        // binding form elements
        var type            = null
            , id            = null

            // a|links
            , $a            = $target.getElementsByTagName('a')
            // input type: checkbox, radio, hidden, text, files, number, date ...
            , $inputs       = $target.getElementsByTagName('input')
            // textarea
            , $textareas    = $target.getElementsByTagName('textarea')
            // select
            , $select       = $target.getElementsByTagName('select')
            , allFormGroupedElements = {}
            , allFormGroupNames = []
            , formElementGroup = {}
            , formElementGroupTmp = null
            , formElementGroupItems = {}
            // file upload
            , $htmlTarget = null
            , $progress = null
        ;

        var elId = null;

        // BO Binding a - not needed anymore since popin is binding link before binding child forms
        // for (let f = 0, len = $a.length; f < len; ++f) {
        //     let isPopinClick = false, hrefAttr = $a[f].getAttribute('href');
        //     if ( !hrefAttr || hrefAttr == '' ) {
        //         // Preventing popin auto to redirect to current/host page url
        //         $a[f].setAttribute('href', '#');
        //         isPopinClick = true;
        //     }
        //     elId = $a[f].getAttribute('id');
        //     if (!elId || elId == '') {
        //         elId = 'click.'; // by default
        //         if ( $target.isPopinContext ) {
        //             elId = ( isPopinClick ) ? 'popin.click.' : 'popin.link.';
        //         }
        //         elId += uuid.v4();
        //         $a[f].setAttribute('id', elId)
        //     }
        // }
        // EO Binding a

        // BO Binding textarea
        for (let f = 0, len = $textareas.length; f < len; ++f) {
            checkForRuleAlias($form.rules, $textareas[f]);
            elId = $textareas[f].getAttribute('id');
            if (!elId || elId == '') {
                elId = 'textareas.' + uuid.v4();
                $textareas[f].setAttribute('id', elId)
            }
            if (!$form.fieldsSet[ elId ]) {
                let defaultValue = $textareas[f].value || '';
                // // just in case
                // if (
                //     typeof($form.fieldsSet[elId]) != 'undefined'
                //     && typeof($form.fieldsSet[elId].defaultValue) != 'undefined'
                // ) {
                //     defaultValue = $form.fieldsSet[elId].defaultValue;
                // }
                $form.fieldsSet[elId] = {
                    id: elId,
                    name: $textareas[f].name || null,
                    value: $textareas[f].value || '',
                    defaultValue: defaultValue
                }
            }
            // Adding live check
            if (/^true$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) {
                registerForLiveChecking($form, $textareas[f]);
            }

        }
        // EO Binding textarea

        // BO Binding input
        for (let f = 0, len = $inputs.length; f < len; ++f) {
            checkForRuleAlias($form.rules, $inputs[f]);
            elId = $inputs[f].getAttribute('id');
            if (!elId || elId == '') {
                elId = 'input.' + uuid.v4();
                $inputs[f].setAttribute('id', elId)
            }

            if (!$form.fieldsSet[ elId ]) {
                let defaultValue = $inputs[f].value;
                if (/$(on|true|false)$/i.test(defaultValue)) {
                    defaultValue = (/$(on|true)$/i.test(defaultValue)) ? true : false;
                }
                // just in case
                // if (
                //     typeof($form.fieldsSet[elId]) != 'undefined'
                //     && typeof($form.fieldsSet[elId].defaultValue) != 'undefined'
                // ) {
                //     defaultValue = $form.fieldsSet[elId].defaultValue;
                // }

                $form.fieldsSet[elId] = {
                    id: elId,
                    name: $inputs[f].name || null,
                    value: defaultValue || ( !/^(checkbox|radio)$/i.test($inputs[f].type) ) ? "" : $inputs[f].checked,
                    defaultValue: ( !/^(checkbox|radio)$/i.test($inputs[f].type) ) ? defaultValue : $inputs[f].checked
                }

                if ( /^(checkbox|radio)$/i.test($inputs[f].type) && typeof($form.fieldsSet[elId].defaultChecked) == 'undefined' ) {


                    $form.fieldsSet[elId].defaultChecked = (
                                                            /^(true|on)$/i.test($inputs[f].checked)
                                                            ||
                                                            /^(true|on)$/.test(defaultValue)
                                                            && /^(checkbox)$/i.test($inputs[f].type)
                                                        ) ? true : false;

                    if (/^radio$/i.test($inputs[f].type) ) {
                        $form.fieldsSet[elId].value = $inputs[f].value;
                        $form.fieldsSet[elId].defaultValue = $inputs[f].value;
                    }
                }
            }

            // Adding live check
            if (/^true$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) {
                registerForLiveChecking($form, $inputs[f]);
            }

            formElementGroupTmp = $inputs[f].getAttribute('data-gina-form-element-group');
            if (formElementGroupTmp) {
                // recording group names
                if ( allFormGroupNames.indexOf(formElementGroupTmp) < 0 ) {
                    allFormGroupNames.push(formElementGroupTmp);
                }

                let _name = $inputs[f].getAttribute('name') || elId;
                if (_name === elId) {
                    $inputs[f].setAttribute('name', elId)
                }
                allFormGroupedElements[elId] = {
                    id      : elId,
                    name    : _name,
                    group   : formElementGroupTmp,
                    target  : $inputs[f]
                };
                formElementGroup[ $inputs[f].name ] = new RegExp('^'+formElementGroupTmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                // Attention, this means that all dependening field will be
                // ignored on validation, unless you write a rule that
                // will override this behavior or else your fields won't be submited
                // this behaviour only applies to Form Grouped Elements
                if (withRules) {
                    if ( typeof($form.rules[ $inputs[f].name ]) == 'undefined') {
                        $form.rules[ $inputs[f].name ] = {}
                    }
                    // By default exclude groups only if not required
                    // Those will be included if member of selected group
                    // See : handleGroupDependencies()
                    if (
                        typeof($form.rules[ $inputs[f].name ].isRequired) == 'undefined'
                        ||  !$form.rules[ $inputs[f].name ].isRequired
                    ) {
                        $form.rules[ $inputs[f].name ].exclude = true;
                    }
                }
            }
            // handling groups dependencies
            if ( formElementGroup.count() > 0 ) {
                var formElementGroupName = null, formElementGroupType = null, formElementIsIgnored = null;
                for ( var g in formElementGroup ) {
                    if ($inputs[f].name == g) continue;
                    // checkbox group init
                    formElementGroupName =  $inputs[f].getAttribute('data-gina-form-element-group') || null;
                    if ( formElementGroup[g].test($inputs[f].name) ) {
                        $inputs[f].disabled = true; // by default
                        if ( typeof(formElementGroupItems[ g ]) == 'undefined' ) {
                            formElementGroupItems[ g ] = {}
                        }
                        formElementGroupItems[ g ][ $inputs[f].name ] = $inputs[f];
                    }

                }
            }
            // Binding upload file
            // todo : data-gina-file-autosend="false" when false, don't trigger the sending to the backend
            // todo : progress bar
            // todo : on('success') -> preview
            if ( /^file$/i.test($inputs[f].type) ) {
                // Binding upload trigger
                // trigger is by default you {input.id} + '-trigger'
                // e.g.: <input type="file" id="my-upload" name="my-upload">
                // => <button type="button" id="my-upload-trigger">Choose a file</button>
                // But you can use atrtibute `data-gina-form-upload-trigger` to override it
                var uploadTriggerId = $inputs[f].getAttribute('data-gina-form-upload-trigger');
                if (!uploadTriggerId)
                    uploadTriggerId = $inputs[f].id;

                var $upload             = null
                    , $uploadTrigger    = null
                ;
                // `$htmlTarget` cannot be used if you need to add a listner on the searched element
                $htmlTarget = new DOMParser().parseFromString($target.innerHTML, 'text/html');
                if (uploadTriggerId) {
                    $uploadTrigger = document.getElementById(uploadTriggerId);
                    //$uploadTrigger = $htmlTarget.getElementById(uploadTriggerId);
                }
                var $errorContainer = document.getElementById($inputs[f].id + '-error');
                checkUploadUrlActions($inputs[f], $errorContainer );

                // check default UploadResetOrDeleteTrigger state
                // required to bind delete - look for all delete triggers
                // $deleteTriggers = [];
                // bindUploadResetOrDeleteTrigger(bindingType, $uploadTrigger, index);
                // eg.: document-files-0-preview; if $inputs[f].id === `document-files-0`
                var $previewContainer = $htmlTarget.getElementById(uploadTriggerId + '-preview');
                if (
                    $previewContainer
                    && $uploadTrigger
                    && !/none/i.test(window.getComputedStyle($previewContainer).display)
                    // for safety
                    && !/none/i.test($previewContainer.parentElement.style.display)
                ) {

                    var $deleteLink = null, index = 0, bindingType = 'delete';
                    console.debug('preview is visible ...');
                    $uploadTrigger.customFiles = [];
                    $uploadTrigger.form = $target;
                    var $els = $previewContainer.childNodes;
                    for (let i = 0, len = $els.length; i < len; i++) {
                        let $img = null;
                        if ( /ul/i.test($els[i].tagName) ) {
                            for (let e = 0, eLen = $els[i].length; e < eLen; e++) {
                                //let $li = new DOMParser().parseFromString($els[i].innerHTML, 'text/html');
                                let $li = $$els[i];
                                for (let l = 0, lLen = $li.length; l < lLen; l++) {
                                    if ( /img/i.test($li[l]) ) {
                                        $img = $li[l];
                                        $img.setAttribute('');

                                        index++;
                                    }
                                }

                            }
                        } else if ( /img/i.test($els[i].tagName) ) {
                            $img = $els[i];
                            deleteLinkId = uploadTriggerId + '-'+index+'-delete-trigger';
                            let file = $img.src.substr($img.src.lastIndexOf('/')+1);
                            $uploadTrigger.customFiles.push({
                                name: file,
                                deleteLinkId: deleteLinkId
                            });
                            // bind reset trigger
                            bindUploadResetOrDeleteTrigger(bindingType, $uploadTrigger, index);

                            index++;
                        }
                    }
                }

                // binding upload trigger
                // if ( $uploadTrigger ) {
                //     $uploadTrigger.setAttribute('data-gina-form-upload-target', $inputs[f].id);
                //     addListener(gina, $uploadTrigger, 'click', function(event) {
                //         event.preventDefault();
                //         var $el     = event.target;

                //         var fileElemId  = $el.getAttribute('data-gina-form-upload-target') || null;
                //         if (fileElemId)
                //             $upload = document.getElementById(fileElemId);

                //         if ($upload) {
                //             removeListener(gina, $upload, 'click');
                //             $upload.value = '';// force reset : != multiple
                //             triggerEvent(gina, $upload, 'click', event.detail);
                //         }
                //     });
                // }

                // binding file element == $upload
                // setTimeout(() => {
                //     removeListner(gina, $inputs[f], 'change');
                // }, 0);
                addListener(gina, $inputs[f], 'change', function(event) {
                    event.preventDefault();
                    var $el     = event.currentTarget;
                    // [0] is for a single file, when multiple == false
                    //var files = Array.from($el.files);
                    var files = $el.files;
                    // used for validation & onUploadResetOrDelete
                    $el.customFiles = Array.from(files);
                    if (!files.length ) return false;




                    // $progress = $($(this).parent().find('.progress'));
                    var url             = $el.getAttribute('data-gina-form-upload-action');
                    var name            = $el.getAttribute('name');
                    var fileId          = name;
                    var uploadFormId    = 'gina-upload-' + name.replace(/\[/g, '-').replace(/\]/g, '-' + $form.id);
                    $el.setAttribute('data-gina-form-virtual', uploadFormId);
                    var eventOnSuccess  = $el.getAttribute('data-gina-form-upload-on-success');
                    var eventOnError    = $el.getAttribute('data-gina-form-upload-on-error');
                    var errorField    = null;

                    if (files.length > 0) {

                        // create form if not exists
                        var $uploadForm = null, $activePopin = null;
                        if ( isPopinContext() ) {
                            // getting active popin
                            $activePopin = gina.popin.getActivePopin();
                            $activePopin.$target = new DOMParser().parseFromString($activePopin.target.outerHTML, 'text/html');
                            // binding to DOM
                            $activePopin.$target.getElementById($activePopin.id).innerHTML = document.getElementById($activePopin.id).innerHTML;

                            $uploadForm = $activePopin.$target.getElementById(uploadFormId);
                        } else {
                            $uploadForm = document.getElementById(uploadFormId);
                        }

                        if ( !$uploadForm ) {
                            try {
                                $uploadForm = getFormById(uploadFormId) || null;
                            } catch (noExistingFormErr) {
                                // do nothing
                            }

                            if (!$uploadForm) {
                                $uploadForm = (isPopinContext())
                                            ? $activePopin.$target.createElement('form')
                                            : document.createElement('form');
                            }


                            // adding form attributes
                            $uploadForm.id       = uploadFormId;
                            // setAttribute() not needed ?
                            //$uploadForm.setAttribute('id', uploadFormId);
                            $uploadForm.action   = url;
                            $uploadForm.enctype  = 'multipart/form-data';
                            $uploadForm.method   = 'POST';



                            if ( typeof($el.form) != 'undefined' ) {

                                // adding virtual fields
                                var fieldPrefix = 'files'; // by default
                                var fieldName   = $el.getAttribute('data-gina-form-upload-prefix') || $el.name || $el.getAttribute('name');
                                var fieldId     = $el.id || $el.getAttribute('id');

                                var hasPreviewContainer = false;
                                var previewContainer    = $el.getAttribute('data-gina-form-upload-preview') || fieldId + '-preview';
                                previewContainer        = (isPopinContext())
                                                        ? $activePopin.$target.getElementById(previewContainer)
                                                        : document.getElementById(previewContainer);

                                if ( typeof(previewContainer) != 'undefined' ) {
                                    hasPreviewContainer = true;
                                }

                                if (fieldName) {
                                    fieldPrefix = fieldName
                                }

                                var hiddenFields        = []
                                    , hiddenFieldObject = null
                                    , mandatoryFields   = [
                                        'name'
                                        , 'group'
                                        , 'originalFilename'
                                        , 'ext'
                                        , 'encoding'
                                        , 'size'
                                        , 'height' // will be removed depending on the mime type
                                        , 'width' // will be removed depending on the mime type
                                        , 'location'
                                        , 'mime'
                                        , 'preview'
                                    ]
                                    , formInputsFields  = $el.form.getElementsByTagName('INPUT')
                                    , fieldType         = null
                                    , hiddenField       = null
                                    , _userName         = null
                                    , _altId            = null
                                    , _name             = null
                                    , _nameRe           = null
                                    , subPrefix         = null
                                    , uploadFields      = {}
                                ;

                                for (var _f = 0, _fLen = files.length; _f < _fLen; ++_f) { // for each file
                                    // binding upload reset trigger
                                    bindUploadResetOrDeleteTrigger('reset', $el, _f);
                                    hiddenFields[_f] = null;
                                    subPrefix = fieldPrefix + '['+ _f +']';
                                    _nameRe = new RegExp('^'+subPrefix.replace(/\[/g, '\\[').replace(/\]/g, '\\]'));
                                    // collecting existing DOM fields
                                    for (var h = 0, hLen = formInputsFields.length; h < hLen; ++h) {
                                        fieldType   = formInputsFields[h].getAttribute('type');
                                        hiddenField = null;
                                        _name       = null, _userName = null;
                                        errorField= formInputsFields[h].getAttribute('data-gina-form-upload-error') || fieldId + '-error' || null;

                                        if (fieldType && /hidden/i.test(fieldType) ) {
                                            hiddenField = formInputsFields[h];

                                            _name       = ( /\[\w+\]$/i.test(hiddenField.name) )
                                                        ? hiddenField.name.match(/\[\w+\]$/)[0].replace(/\[|\]/g, '')
                                                        : hiddenField.name;
                                            _userName   = ( /\[\w+\]$/i.test(hiddenField.name) )
                                                        ? hiddenField.name.match(/\[\w+\]$/)[0].replace(/\[|\]/g, '')
                                                        : hiddenField.name;

                                            // mandatory informations
                                            if (
                                                hiddenField
                                                && typeof(_name) != 'undefiend'
                                                && mandatoryFields.indexOf( _name ) > -1
                                                && _nameRe.test( hiddenField.name )
                                            ) {

                                                if (!hiddenFields[_f] )
                                                    hiddenFields[_f] = {};

                                                if ( /\[preview\]/i.test(hiddenField.name) ) {
                                                    if ( typeof(hiddenFields[_f].preview) == 'undefined' )
                                                        hiddenFields[_f].preview = {};

                                                    hiddenFields[_f].preview[_name] = hiddenField;
                                                } else {
                                                    hiddenFields[_f][_name] = hiddenField;
                                                }
                                            } else if (
                                                hiddenField
                                                && typeof(_name) != 'undefiend'
                                                && mandatoryFields.indexOf( _name ) < 0
                                                && _nameRe.test( hiddenField.name )
                                            ) { // defined by user
                                                if (!hiddenFields[_f] )
                                                    hiddenFields[_f] = {};

                                                if ( /\[preview\]/i.test(hiddenField.name) ) {
                                                    if ( typeof(hiddenFields[_f].preview) == 'undefined' )
                                                        hiddenFields[_f].preview = {};

                                                    hiddenFields[_f].preview[_userName] = hiddenField;
                                                } else {
                                                    hiddenFields[_f][_userName] = hiddenField;
                                                }
                                            }
                                        }
                                    }

                                    // completing by adding non-declared mandatoring fields in the DOM: all but preview
                                    for (var m = 0, mLen = mandatoryFields.length; m < mLen; ++m) {
                                        // optional, must be set by user
                                        // needs recheck
                                        if (!hiddenFields[_f] )
                                            hiddenFields[_f] = {};

                                        if ( typeof(hiddenFields[_f][ mandatoryFields[m] ]) == 'undefined' ) {

                                            _name = fieldPrefix +'['+ _f +']['+ mandatoryFields[m] +']';
                                            // create input & add it to the form
                                            $newVirtualField = document.createElement('input');
                                            $newVirtualField.type = 'hidden';
                                            $newVirtualField.id = 'input.' + uuid.v4();
                                            $newVirtualField.name = _name;
                                            $newVirtualField.value = '';

                                            $el.form.appendChild($newVirtualField);
                                            hiddenFields[_f][ mandatoryFields[m] ] = $el.form[$el.form.length-1];// last added
                                        }

                                    }

                                } // EO for files

                                $uploadForm.uploadProperties = {
                                    id                  : $el.form.id || $el.getAttribute('id'),
                                    uploadTriggerId     : $el.id,
                                    $form               : $el.form,
                                    errorField          : errorField,
                                    mandatoryFields     : mandatoryFields,
                                    uploadFields        : hiddenFields,
                                    hasPreviewContainer : hasPreviewContainer,
                                    isPopinContext      : isPopinContext()
                                };
                                if (hasPreviewContainer) {
                                    $uploadForm.uploadProperties.previewContainer = previewContainer;
                                }
                            }

                            // Success event
                            if (eventOnSuccess) {
                                $uploadForm.setAttribute('data-gina-form-event-on-submit-success', eventOnSuccess);
                            } else {
                                $uploadForm.setAttribute('data-gina-form-event-on-submit-success', 'onGenericXhrResponse');
                            }
                            // Error event
                            if (eventOnError) {
                                $uploadForm.setAttribute('data-gina-form-event-on-submit-error', eventOnError);
                            } else {
                                $uploadForm.setAttribute('data-gina-form-event-on-submit-error', 'onGenericXhrResponse');
                            }


                            // adding for to current document
                            if (isPopinContext()) {
                                //$activePopin.$target.appendChild($uploadForm)
                                document.getElementById($activePopin.id).appendChild($uploadForm)
                            } else {
                                document.body.appendChild($uploadForm)
                            }
                        }

                        // binding form
                        try {
                            var $uploadFormValidator = getFormById(uploadFormId);
                            // create a FormData object which will be sent as the data payload
                            var formData = new FormData();
                            // add the files to formData object for the data payload
                            var file = null;
                            for (var l = 0, lLen = files.length; l < lLen; ++l) {
                                file = files[l];
                                formData.append(fileId, file, file.name);
                            }


                            $uploadFormValidator
                                // .on('error', function(e, result) {
                                //     console.error('[error] ', '\n(e)' + e, '\n(result)' + result)
                                // })
                                // .on('success', function(e, result){

                                //     var $el = e.target;
                                //     var $preview = null, $ul = null, $li = null, $img = null;
                                //     var previewId = $el.getAttribute('data-gina-form-upload-preview') || null;
                                //     if (previewId)
                                //         $preview = document.getElementById(previewId);


                                //     var files = result.files;
                                //     if ($preview) {
                                //         $preview.innerHTML = '';
                                //         $ul = document.createElement("ul");
                                //         for (var f = 0, fLen = files.length; f<fLen; ++f) {
                                //             $li = document.createElement("li");
                                //             $img = document.createElement("img");

                                //             $img.src = files[f].tmpSrc;
                                //             $img.width = files[f].width;
                                //             $img.height = files[f].height;

                                //             $li.appendChild($img);
                                //             $ul.appendChild($li);
                                //         }
                                //         $preview.appendChild($ul);
                                //     }

                                // })
                                /**.on('progress', function(evt, result) {

                                percentComplete = result.progress;

                                $progress.text(percentComplete + '%');
                                $progress.width(percentComplete + '%');

                                if (percentComplete === 100) {
                                    $progress.html('Done');
                                }

                                // if (evt.lengthComputable) {
                                //   // calculate the percentage of upload completed
                                //   var percentComplete = evt.loaded / evt.total;
                                //   percentComplete = parseInt(percentComplete * 100);

                                //   // update the Bootstrap progress bar with the new percentage
                                //   $progress.text(percentComplete + '%');
                                //   $progress.width(percentComplete + '%');

                                //   // once the upload reaches 100%, set the progress bar text to done
                                //   if (percentComplete === 100) {
                                //     $progress.html('Done');
                                //   }

                                // }
                                }) */
                                .send(formData, { withCredentials: true/** , isSynchrone: true*/ });

                        } catch (formErr) {
                            throw formErr;
                        }
                    }
                });


            }
        }// EO Binding input

        var updateSelect = function($el, $form) {
            $el.setAttribute('data-value', $el.value);
            // If Live check enabled, proceed to silent validation
            if ( /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled && $form.rules.count() > 0) ) {
                var localField = {}, $localField = {}, $localForm = null;
                $localForm = $el.form;//event.target.form
                localField[event.target.name]     = event.target.value;
                $localField[event.target.name]    = event.target;

                instance.$forms[$localForm.getAttribute('id')].isValidating = true;
                validate(event.target, localField, $localField, $form.rules, function onLiveValidation(result){
                    instance.$forms[$localForm.getAttribute('id')].isValidating = false;
                    var isFormValid = result.isValid();
                    //console.debug('onSilentPreGlobalLiveValidation: '+ isFormValid, result);
                    if (isFormValid) {
                        //resetting error display
                        handleErrorsDisplay($localForm, {}, result.data, event.target.name);
                    } else {
                        handleErrorsDisplay($localForm, result.error, result.data, event.target.name);
                    }
                    //updateSubmitTriggerState( $localForm, isFormValid );
                    // data-gina-form-required-before-submit
                    //console.debug('====>', result.isValid(), result);

                    // Global check required: on all fields
                    var $gForm = $localForm, gFields = null, $gFields = null, gRules = null;
                    var gValidatorInfos = getFormValidationInfos($gForm, rules);
                    gFields  = gValidatorInfos.fields;
                    $gFields = gValidatorInfos.$fields;
                    var formId = $gForm.getAttribute('id');
                    gRules   = instance.$forms[formId].rules;
                    // Don't be tempted to revome fields that has already been validated
                    instance.$forms[formId].isValidating = true;
                    validate($gForm, gFields, $gFields, gRules, function onSilentGlobalLiveValidation(gResult){
                        instance.$forms[formId].isValidating = false;
                        console.debug('[updateSelect]: onSilentGlobalLiveValidation: '+ gResult.isValid(), gResult);
                        var isFormValid = gResult.isValid();
                        updateSubmitTriggerState( $gForm, isFormValid);
                        once = false;
                    })

                });
            }
        };
        // BO binding select
        var selectedIndex = null, selectedValue = null;
        for (var s = 0, sLen = $select.length; s < sLen; ++s) {
            checkForRuleAlias($form.rules, $select[s]);

            elId = $select[s].getAttribute('id');

            if (elId && /^gina\-toolbar/.test(elId)) continue;

            if (!elId || elId == '') {
                elId = 'select.' + uuid.v4();
                $select[s].setAttribute('id', elId)
            }

            formElementGroupTmp = $select[s].getAttribute('data-gina-form-element-group');
            if (formElementGroupTmp) {
                let _name = $select[s].getAttribute('name') || elId;
                if (_name === elId) {
                    $select[s].setAttribute('name', elId)
                }
                allFormGroupedElements[elId] = {
                    id      : elId,
                    name    : _name,
                    group   : formElementGroupTmp,
                    target  : $select[s]
                };
            }

            addListener(gina, $select[s], 'change', function(event) {
                var $el = event.target;

                if (/select/i.test($el.type) ) {
                    updateSelect($el, $form);
                }
            });


            if ($select[s].options && !$form.fieldsSet[ elId ]) {
                selectedIndex = 0;
                selectedValue = $select[s].getAttribute('data-value') || null;
                if ( selectedValue ) {
                    for (var o = 0, oLen = $select[s].options.length; o < oLen; ++o ) {
                        if ( $select[s].options[o].value == selectedValue) {
                            selectedIndex = o;
                            $select[s].selectedIndex = selectedIndex;
                            break
                        }
                    }
                }

                if ( typeof($select[s].options[$select[s].selectedIndex]) != 'undefined' && $select[s].options[ $select[s].selectedIndex ].index ) {
                    selectedIndex = $select[s].options[ $select[s].selectedIndex ].index
                }

                if (
                    $select[s].options.length > 0
                    && typeof($select[s].options[ selectedIndex ]) != 'undefined'
                ) {
                    selectedValue = $select[s].options[ selectedIndex ].value;
                }

                $form.fieldsSet[ elId ] = {
                    id              : elId,
                    name            : $select[s].name || null,
                    value           : selectedValue || null,
                    selectedIndex   : selectedIndex || 0
                };

                // update select
                if (
                    typeof($select[s].selectedIndex) != 'undefined'
                    && $select[s].selectedIndex > -1
                ) {
                    $select[s].options[ selectedIndex ].selected = true;
                    $select[s].setAttribute('data-value',  $select[s].options[ selectedIndex ].value);
                }

            }
        }// EO binding select

        // group dependencies handling
        var updateReletadItems = function(elId, group, excluded, isCalledHasDependency) {

            if ( typeof(isCalledHasDependency) == 'undefined' ) {
                isCalledHasDependency = false;
            }

            if ( typeof(allFormGroupedElements[elId]) == 'undefined' ) {
                throw new Error('Radio & Checkbox dependencies not met: you must use the ID attribue of the `master element` as the `data-gina-form-element-group`')
            }

            var elIdIsChecked = null
                , re = null
                , re2 = null
                , namedId = elId.replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&')
                //, name = $el.getAttribute('name').replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&')
            ;
            elIdIsChecked = allFormGroupedElements[elId].target.checked;
            //console.debug('current id ', elId, excluded);
            for (let id in allFormGroupedElements) {
                // ignore triggers
                if ( /radio|checkbox/i.test(allFormGroupedElements[id].target.type) )
                    continue;

                let hasBeenUpdated = false;
                re = new RegExp(namedId);
                re2 = new RegExp(group);

                if (
                    re.test(allFormGroupedElements[id].group) && re2.test(allFormGroupedElements[id].group)
                    ||
                    re.test(allFormGroupedElements[id].group)
                ) {
                    // init default state: disable all;
                    allFormGroupedElements[id].target.disabled = true;
                    // adding custom rule for this case
                    if ( typeof($form.rules[ allFormGroupedElements[id].name ]) == 'undefined' ) {
                        $form.rules[ allFormGroupedElements[id].name ] = {}
                    }
                    $form.rules[ allFormGroupedElements[id].name ].exclude = true;

                    // triggered by click on the radio group
                    if (isCalledHasDependency) {
                        //console.debug('In Group #1 ', 'excluded:'+excluded, 'disabled:'+allFormGroupedElements[id].target.disabled, allFormGroupedElements[id].name, checkBoxGroup, ' VS ', allFormGroupedElements[id].group);
                        allFormGroupedElements[id].target.disabled = (elIdIsChecked) ? false : true;
                        $form.rules[ allFormGroupedElements[id].name ].exclude = (elIdIsChecked) ? false : true;
                        //console.debug('In Group #1 fixed to -> ', 'excluded:'+excluded, 'disabled:'+allFormGroupedElements[id].target.disabled);
                        continue;
                    }
                    // triggered by click on the checkbox
                    //console.debug('In Group #2 ', 'excluded:'+excluded, 'disabled:'+allFormGroupedElements[id].target.disabled, allFormGroupedElements[id].name, checkBoxGroup, ' VS ', allFormGroupedElements[id].group);
                    allFormGroupedElements[id].target.disabled = excluded;
                    $form.rules[ allFormGroupedElements[id].name ].exclude = excluded;
                    //console.debug('In Group #2 fixed to -> ', 'excluded:'+excluded, 'disabled:'+allFormGroupedElements[id].target.disabled);
                    continue;
                }
                //console.debug('elId: '+elId, 'isCalledHasDependency:'+isCalledHasDependency, 'hasBeenUpdated:'+ hasBeenUpdated, 'excluded:'+excluded, 'disabled:'+allFormGroupedElements[id].target.disabled, allFormGroupedElements[id].name, 'elIdIsChecked:'+elIdIsChecked, 'inGroup:'+re.test(allFormGroupedElements[id].group) );

            }

            return
        };
        var handleCheckBoxGroupDependencies = function($form, $el, checkBoxGroup, isCalledHasDependency) {


            if ( typeof(isCalledHasDependency) == 'undefined' ) {
                isCalledHasDependency = false;
            }
            if (isCalledHasDependency && typeof(allFormGroupedElements[$el.id]) != 'undefined' ) {
                var excluded = /true/i.test($el.checked) ? false : true;
                return updateReletadItems($el.id, allFormGroupedElements[$el.id].group, excluded, isCalledHasDependency)
            }


            var item = $el.name;
            if (withRules && typeof($form.rules[item]) == 'undefined' ) {
                $form.rules[item] = {}
            }
            if ( /^true$/i.test($el.checked) ) {
                if (withRules) {
                    $form.rules[item].exclude = false;
                    if ( typeof(allFormGroupedElements[$el.id]) != 'undefined' ) {
                        updateReletadItems($el.id, allFormGroupedElements[$el.id].group, false, isCalledHasDependency)
                    }
                }
            } else {
                //elGroup[item].disabled = true;
                if (withRules) {
                    $form.rules[item].exclude = true;
                    if ( typeof(allFormGroupedElements[$el.id]) != 'undefined' ) {
                        updateReletadItems($el.id, allFormGroupedElements[$el.id].group, true, isCalledHasDependency)
                    }
                }
            }
        };
        var updateCheckBox = function($el, isInit) {
            if ( typeof(isInit) == 'undefined' ) {
                isInit = false;
            }

            var triggerHandleCheckBoxGroupDependencies = function($el, checkBoxGroup, isExcluded) {
                if (checkBoxGroup) {
                    handleCheckBoxGroupDependencies($form, $el, checkBoxGroup);
                } else {
                    for (let id in allFormGroupedElements) {
                        if (
                            re.test(allFormGroupedElements[id].group)
                            ||
                            re.test(allFormGroupedElements[id].target.getAttribute('data-gina-form-element-group'))
                        ) {
                            allFormGroupedElements[id].target.disabled = isExcluded;
                        }
                    }
                }
            }

            // Preventing jQuery setting `on` value when input is not checked
            if (isInit && /^(on)$/i.test($el.value) && !$el.checked) {
                $el.value = false
            }
            var localValue  = $el.getAttribute('data-value') || $el.getAttribute('value') || $el.value;
            localValue = (/^(true|on)$/.test(localValue)) ? true : localValue;

            if (localValue === '') {
                localValue = false
            }
            var isLocalBoleanValue = ( /^(true|on|false)$/i.test(localValue) ) ? true : false;
            if (isInit && isLocalBoleanValue) { // on checkbox init
                // update checkbox initial state
                // Value defines checked state by default
                if ( /^true$/i.test(localValue) && !$el.checked) {
                    $el.checked = true;
                } else if ( /^false$/i.test(localValue) && $el.checked) {
                    $el.checked = false;
                }
            }
            var checked     = $el.checked;

            var checkBoxGroup   = $el.getAttribute('data-gina-form-element-group') || null;
            var re              = new RegExp($el.id.replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&'));
            // set to checked if not checked: false -> true
            if ( !checked || checked == 'null' || checked == 'false' || checked == '' ) {

                // prevents ticking behavior
                if (!isInit) {
                    setTimeout(function () {
                        $el.checked = false;
                        // means that the checkbox is member of another group
                        triggerHandleCheckBoxGroupDependencies($el, checkBoxGroup, true);
                        updateGroupChildrenState($el);
                    }, 0);
                } else {
                    updateGroupChildrenState($el);
                }


                $el.removeAttribute('checked');
                if (isLocalBoleanValue) {
                    $el.value = false;
                    $el.setAttribute('value', 'false');
                    if ( typeof($el.getAttribute('data-value') != 'undefined' ) )
                        $el.setAttribute('data-value', 'false');
                }


            } else {

                // prevents ticking behavior
                if (!isInit) {
                    setTimeout(function () {
                        $el.checked = true;
                        // means that the checkbox is member of another group
                        triggerHandleCheckBoxGroupDependencies($el, checkBoxGroup, false);
                        updateGroupChildrenState($el);
                    }, 0);
                    $el.setAttribute('checked', 'checked');
                } else {
                    updateGroupChildrenState($el);
                }

                if (isLocalBoleanValue) {
                    $el.value = true;
                    $el.setAttribute('value', true);
                    if ( typeof($el.getAttribute('data-value') != 'undefined' ) )
                        $el.setAttribute('data-value', true);
                }

            }
        };

        var updateGroupChildrenState = function($groupMaster) {
            var re = new RegExp($groupMaster.id.replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&'));
            // Handle extended groups
            for (let id in allFormGroupedElements) {
                if (
                    /checkbox/i.test(allFormGroupedElements[id].target.type) && re.test(allFormGroupedElements[id].group)
                    ||
                    /checkbox/i.test(allFormGroupedElements[id].target.type) && re.test(allFormGroupedElements[id].target.getAttribute('data-gina-form-element-group'))
                ) {
                    handleCheckBoxGroupDependencies($form, allFormGroupedElements[id].target, allFormGroupedElements[id].group, true);
                }
            }
        }

        // When binding children element to the radio, you must used the radio.id as the element group
        // Because the name attribute of the radio can also be used to group multiple radio field
        // On master: <input type="radio" id="invoice-type-balance" name="action[addFromExisting]" value="balanceFlow">
        // On children: <input type="checkbox" data-gina-form-element-group="invoice-type-balance" value="someValue">
        var handleGroupDependencies = function($el, isOnResetMode) {
            isOnResetMode = ( typeof(isOnResetMode) != 'undefined' && isOnResetMode) ? true: false;

            //console.debug('reset: '+isOnResetMode, $el.id, $el.checked);
            var extendedGroupName = $el.id.replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&')
                , re = null
            ;
            // parse grouped elements: allFormGroupedElements
            // init
            re = new RegExp(extendedGroupName);
            for (let id in allFormGroupedElements) {
                if (!/checkbox|radio/i.test(allFormGroupedElements[id].target.type)) {
                    allFormGroupedElements[id].target.disabled = true;
                    // adding custom rule for this case
                    if ( typeof($form.rules[ allFormGroupedElements[id].name ]) == 'undefined' ) {
                        $form.rules[ allFormGroupedElements[id].name ] = {}
                    }
                    $form.rules[ allFormGroupedElements[id].name ].exclude = true;
                }

                if (
                    re.test(allFormGroupedElements[id].group)
                    ||
                    re.test(allFormGroupedElements[id].target.getAttribute('data-gina-form-element-group').replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&'))
                ) {
                    // init default
                    allFormGroupedElements[id].target.disabled = true;
                    // adding custom rule for this case
                    if ( typeof($form.rules[ allFormGroupedElements[id].name ]) == 'undefined' ) {
                        $form.rules[ allFormGroupedElements[id].name ] = {}
                    }

                    if (/^(true|on)$/i.test($el.checked)) {
                        allFormGroupedElements[id].target.disabled = false;
                        $form.rules[ allFormGroupedElements[id].name ].exclude = false;
                    } else {
                        allFormGroupedElements[id].target.disabled = true;
                        $form.rules[ allFormGroupedElements[id].name ].exclude = true;
                    }
                }
            }
            // Handle extended groups
            updateGroupChildrenState($el);
        }

        // BO Binding radio
        var radioGroup = null;
        var updateRadio = function($el, isInit, isTriggedByUser) {
            isInit = ( typeof(isInit) == 'undefined' || !isInit ) ? false : true;
            isTriggedByUser = ( typeof(isTriggedByUser) == 'undefined' || !isTriggedByUser ) ? false : true;

            var checked = $el.checked, evt = null;
            var isBoolean = /^(true|false)$/i.test($el.value);
            radioGroup = document.getElementsByName($el.name);

            // loop if radio group
            for (let r = 0, rLen = radioGroup.length; r < rLen; ++r) {
                if (radioGroup[r].id !== $el.id && checked) {
                    radioGroup[r].checked = false;
                    radioGroup[r].removeAttribute('checked');
                    handleGroupDependencies(radioGroup[r], true)
                }
            }


            if (isInit) {
                handleGroupDependencies($el);
                return;
            }

            if ( !checked || checked == 'null' || checked == 'false' || checked == '' ) {

                // prevents ticking behavior
                setTimeout(function () {
                    if (isTriggedByUser) {
                        handleGroupDependencies($el);
                        return;
                    }
                    $el.checked = true;
                    $el.setAttribute('checked', 'checked');
                }, 0)

            } else {

                // prevents ticking behavior
                setTimeout(function () {
                    if (isTriggedByUser) {
                        handleGroupDependencies($el);
                        return;
                    }
                    $el.checked = false;
                    $el.removeAttribute('checked');
                }, 0)
            }

            if (isBoolean) { // force boolean value
                $el.value = (/^true$/.test($el.value)) ? true : false
            }
            // fix added on 2020/09/25 :
            return;
        }// EO Binding radio

        for (var i = 0, iLen = $inputs.length; i < iLen; ++i) {
            type    = $inputs[i].getAttribute('type');

            if ( typeof($inputs[i].id) == 'undefined' || $inputs[i].id == '' ) {
                $inputs[i].id = type +'-'+ uuid.v4();
                $inputs[i].setAttribute('id', $inputs[i].id)
            }


            // recover default state only on value === true || false || on
            if (
                typeof(type) != 'undefined'
                && /^checkbox$/i.test(type)
            ) {

                // if is master of a group, init children default state
                if (
                    $inputs[i].disabled
                    && allFormGroupNames.indexOf($inputs[i].id) > -1
                    ||
                    !$inputs[i].checked
                    && allFormGroupNames.indexOf($inputs[i].id) > -1
                ) {
                    // updateGroupChildrenState($inputs[i]);
                    let re = new RegExp( $inputs[i].id.replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&') );
                    for (let childElement in allFormGroupedElements ) {
                        if ( re.test(allFormGroupedElements[childElement].group) ) {
                            allFormGroupedElements[childElement].target.disabled = true;
                        }
                    }
                }

                evt = 'change.'+ $inputs[i].id;
                proceed = function ($el, evt) {

                    // recover default state only on value === true || false
                    addListener(gina, $el, evt, function(event) {
                        updateCheckBox(event.target);

                        triggerEvent(gina, event.target, 'changed.'+ event.target.id);
                    });

                    // default state recovery
                    updateCheckBox($el, true);
                }

                if ( typeof(gina.events[evt]) != 'undefined' && gina.events[evt] == $inputs[i].id ) {
                    removeListener(gina, $inputs[i], evt);
                    proceed($inputs[i], evt)

                } else {
                    proceed($inputs[i], evt)
                }

            } else if (
                typeof(type) != 'undefined'
                && /^radio$/i.test(type)
            ) {

                evt = $inputs[i].id;
                //evt = 'change.'+ $inputs[i].id;

                proceed = function ($el, evt) {
                    // recover default state
                    addListener(gina, $el, evt, function(event) {
                        //cancelEvent(event);
                        updateRadio(event.target);

                        triggerEvent(gina, event.target, 'changed.'+ event.target.id);
                    });

                    // default state recovery
                    updateRadio($el, true);
                }

                if ( typeof(gina.events[evt]) != 'undefined' && gina.events[evt] == $inputs[i].id ) {
                    removeListener(gina, $inputs[i], evt);
                    proceed($inputs[i], evt);
                } else {
                    proceed($inputs[i], evt)
                }
            }
        }


        evt = 'click';

        proceed = function () {
            var subEvent = null;
            // handle form reset
            subEvent = 'reset.'+$target.id;
            if ( typeof(gina.events[subEvent]) == 'undefined' ) {
                addListener(gina, $target, subEvent, function(e) {
                    e.preventDefault();

                    var _id             = e.currentTarget.id || e.target.id
                    var $form           = instance.$forms[_id];
                    $form.target.dataset.ginaFormIsResetting = true;
                    resetFields($form);
                    // forcing it
                    var validationInfo  = getFormValidationInfos($form.target, $form.rules, true);
                    var fields          = validationInfo.fields;
                    var $fields         = validationInfo.$fields;

                    validate($form.target, fields, $fields, $form.rules, function onSilentResetValidation(result){
                        var isFormValid = result.isValid();
                        console.debug('silent reset validation result[isValid:'+isFormValid+']: ', result);
                        //resetting error display
                        handleErrorsDisplay($form.target, {});

                        updateSubmitTriggerState( $form.target , isFormValid );
                        $form.target.dataset.ginaFormIsResetting = false;
                    });
                })
            }
            // reset proxy
            addListener(gina, $target, 'reset', function(event) {
                var $el = event.target;
                // prevent event to be triggered twice
                if (
                    typeof(event.defaultPrevented) != 'undefined'
                    && event.defaultPrevented
                ) {
                    return false;
                }
                // Fixed on 2021/06/08 - because of radio reset
                event.preventDefault();

                var _evt = $el.id;
                if (!_evt) return false;

                if ( !/^reset\./.test(_evt) ) {
                    _evt = 'reset.'+$el.id
                }
                if (gina.events[_evt]) {
                    triggerEvent(gina, $el, _evt, event.detail);
                }
            });
            // keydown proxy
            addListener(gina, $target, 'keydown', function(event) {
                var $el = event.target;
                // prevent event to be triggered twice
                if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                return false;

                keyboardMapping[event.keyCode] = event.type == 'keydown';

                var _evt = $el.id;
                if (!_evt) return false;

                if ( !/^keydown\./.test(_evt) ) {
                    _evt = 'keydown.'+$el.id
                }
                if (gina.events[_evt]) {
                    cancelEvent(event);
                    triggerEvent(gina, $el, _evt, event.detail, event);
                }
            });
            // keyup proxy - updating keyboardMapping
            addListener(gina, $target, 'keyup', function(event) {
                var $el = event.target;
                // prevent event to be triggered twice
                if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                return false;

                if (keyboardMapping[event.keyCode]) {
                    delete keyboardMapping[event.keyCode]
                }

                var _evt = $el.id;
                if (!_evt) return false;
                if ( !/^keyup\./.test(_evt) ) {
                    _evt = 'keyup.'+$el.id
                }
                if (gina.events[_evt]) {
                    cancelEvent(event);
                    triggerEvent(gina, $el, _evt, event.detail, event);
                }
            });

            // focusin proxy
            addListener(gina, $target, 'focusin', function(event) {
                var $el = event.target;
                // prevent event to be triggered twice
                if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                return false;

                var _evt = $el.id;
                if (!_evt) return false;

                if ( !/^focusin\./.test(_evt) ) {
                    _evt = 'focusin.'+$el.id
                }
                if (gina.events[_evt]) {
                    cancelEvent(event);

                    triggerEvent(gina, $el, _evt, event.detail);
                }
            });
            // focusout proxy
            addListener(gina, $target, 'focusout', function(event) {
                // Never preventDefault from a proxy listner
                var $el = event.target;
                // prevent event to be triggered twice
                if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                    return false;

                var _evt = $el.id;
                if (!_evt) return false;

                if ( !/^focusout\./.test(_evt) ) {
                    _evt = 'focusout.'+$el.id
                }
                if (gina.events[_evt]) {
                    cancelEvent(event);

                    triggerEvent(gina, $el, _evt, event.detail);
                }
            });

            // change proxy
            addListener(gina, $target, 'change', function(event) {
                // Never preventDefault from a proxy listner
                var $el = event.target;
                // prevent event to be triggered twice
                if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                return false;

                var _evt = $el.id;
                if (!_evt) return false;

                if ( !/^change\./.test(_evt) ) {
                    _evt = 'change.'+$el.id
                }
                if (gina.events[_evt]) {
                    cancelEvent(event);
                    triggerEvent(gina, $el, _evt, event.detail);
                }
            });
            // click proxy
            addListener(gina, $target, 'click', function(event) {
                // Never preventDefault from a proxy listner
                var $el = event.target;
                // prevent event to be triggered twice
                // if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                //     return false;

                var isCustomSubmit = false, isCaseIgnored = false;

                if (
                    /(label)/i.test(event.target.tagName)
                        && typeof(event.target.control) != 'undefined'
                        && event.target.control != null
                        && /(checkbox|radio)/i.test(event.target.control.type)
                    ||
                    /(label)/i.test(event.target.parentNode.tagName)
                        && typeof(event.target.parentNode.control) != 'undefined'
                        && event.target.parentNode.control != null
                        && /(checkbox|radio)/i.test(event.target.parentNode.control.type)
                ) {
                    var isCaseIgnored = (
                                        event.target.getAttribute('for')
                                        ||
                                        event.target.parentNode.getAttribute('for')
                                    ) ? true : false
                    ;
                    // if `event.target.control` not working on all browser,
                    // try to detect `for` attribute OR check if on of the label's event.target.children is an input & type == (checkbox|radio)
                    $el = event.target.control || event.target.parentNode.control;

                }
                if (
                    !$el.disabled
                    && /(checkbox|radio)/i.test($el.type)
                    && !isCaseIgnored
                ) {
                    // apply checked choice : if true -> set to false, and if false -> set to true
                    if ( /checkbox/i.test($el.type) ) {
                        return updateCheckBox($el);
                    } else if ( /radio/i.test($el.type) ) {
                        return updateRadio($el, false, true);
                    }
                }


                // include only these elements for the binding
                if (
                    /(button|input)/i.test($el.tagName) && /(submit|checkbox|radio)/i.test($el.type)
                    || /a/i.test($el.tagName) && $el.attributes.getNamedItem('data-gina-form-submit')
                    // You could also have a click on a child element like <a href="#"><span>click me</span></a>
                    || /a/i.test($el.parentNode.tagName) && $el.parentNode.attributes.getNamedItem('data-gina-form-submit')
                ) {
                    var namedItem = $el.attributes.getNamedItem('data-gina-form-submit');
                    var parentNamedItem = $el.parentNode.attributes.getNamedItem('data-gina-form-submit');
                    if (
                        namedItem
                        ||
                        parentNamedItem
                    ) {
                        isCustomSubmit = true;
                        // Get others attribute and override current form attribute
                        var newFormMethod = null;
                        if (namedItem) {
                            newFormMethod = $el.getAttribute('data-gina-form-submit-method') || event.currentTarget.getAttribute('method');
                        } else {
                            newFormMethod = $el.parentNode.getAttribute('data-gina-form-submit-method') || event.currentTarget.getAttribute('method');
                        }
                        if (newFormMethod) {
                            // Backup originalMethod

                            // Rewrite current method
                            if (namedItem && $el.form) {
                                if ($el.form.setAttribute) {
                                    $el.form.setAttribute('method', newFormMethod);
                                } else {
                                    event.currentTarget.setAttribute('method', newFormMethod);
                                }
                            } else if ($el.parentNode.form) {
                                if ($el.parentNode.form.setAttribute) {
                                    $el.parentNode.form.setAttribute('method', newFormMethod);
                                } else {
                                    event.currentTarget.setAttribute('method', newFormMethod);
                                }
                            }
                        }
                    }
                    // safety checking
                    if ( typeof($el.id) == 'undefined' || !$el.getAttribute('id') ) {
                        $el.setAttribute('id', 'click.' + uuid.v4() );
                        $el.id = $el.getAttribute('id')
                    } else {
                        $el.id = $el.getAttribute('id')
                    }


                    if (/^click\./.test($el.id) || withRules) {

                        var _evt = $el.id;

                        if (!_evt) return false;

                        if ( !/^click\./.test(_evt) ) {
                            _evt = $el.id
                        }

                        // normal case
                        if (
                            !$el.disabled
                            && /(checkbox|radio)/i.test($el.type)
                        ) {
                            //event.stopPropagation();
                            // apply checked choice : if true -> set to false, and if false -> set to true
                            if ( /checkbox/i.test($el.type) ) {
                                return updateCheckBox($el);
                            } else if ( /radio/i.test($el.type) ) {
                                return updateRadio($el, false, true);
                            }
                        }

                        // prevent event to be triggered twice
                        if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                            return false;

                        // in case we have multiple submit type buttons
                        if (
                            $el.type == 'submit' && !/^submit\./i.test(_evt)
                            ||
                            isCustomSubmit && !/^submit\./i.test(_evt)
                        ) {
                            _evt = 'submit.'+_evt
                        }
                        // in case we have multiple reset type buttons
                        if ( $el.type == 'reset' && !/^reset\./i.test(_evt) ) {
                            _evt = 'reset.'+_evt
                        }

                        if (gina.events[_evt]) {
                            cancelEvent(event);

                            triggerEvent(gina, $el, _evt, event.detail);
                        } else if (
                            isCustomSubmit
                            && typeof(this.id) != 'undefined'
                            && this.id != ''
                            && typeof(gina.validator.$forms[this.id]) != 'undefined'
                        ) {
                            gina.validator.getFormById(this.id).submit();
                            cancelEvent(event); // stop #navigation
                        }

                    }
                }

            })
        }

        proceed();





        evt = 'validate.' + _id;
        proceed = function () {
            // attach form submit event
            addListener(gina, $target, evt, function(event) {
                cancelEvent(event);

                //var result = event['detail'] || $form.eventData.error || $form.eventData.validation;
                var result = $form.eventData.error || $form.eventData.validation || event['detail'];
                // TODO - Since $form.eventData.error is cached, add a TTL to clear it and allow re $validator.send()
                handleErrorsDisplay(event['target'], result['fields']||result['error'], result['data']);

                var _id = event.target.getAttribute('id');

                if ( typeof(result['isValid']) != 'undefined' && result['isValid']() ) { // send if valid
                    // Experimental - inheritedData
                    // Inhertitance from previously posted form: merging datas with current form context
                    // TODO - Get the inhereted data from LMDB Database using the form CSRF
                    var inheritedData = instance.$forms[_id].target.getAttribute('data-gina-form-inherits-data') || null;
                    if (inheritedData) {
                        result['data'] = merge(result['data'],  JSON.parse(decodeURIComponent(inheritedData)) )
                    }
                    // now sending to server
                    if (instance.$forms[_id]) {
                        instance.$forms[_id].send(result['data']);
                    } else if ($form) { // just in case the form is being destroyed
                        $form.send(result['data']);
                    }
                }
            })
        }
        // cannot be binded twice
        if ( typeof(gina.events[evt]) != 'undefined' && gina.events[evt] == 'validate.' + _id ) {
            removeListener(gina, $form, evt, proceed)
        }

        proceed();

        var bindSubmitEl = function (evt, $submit) {
            // attach submit events
            if ( !/^submit\./i.test(evt) ) {
                evt = 'submit.'+ evt;
            }
            //console.debug('attaching submit event: `'+  evt +'` on `'+ $submit.id + '` element for form `'+ $submit.form.id +'`');
            addListener(gina, $submit, evt, function(event) {
                // start validation
                cancelEvent(event);

                // getting fields & values
                var $fields         = {}
                    , fields        = { '_length': 0 }
                    , id            = $target.getAttribute('id')
                    , rules         = ( typeof(instance.$forms[id]) != 'undefined' ) ? instance.$forms[id].rules : null
                    , name          = null
                    , value         = 0
                    , type          = null
                    , index         = { checkbox: 0, radio: 0 }
                    , isDisabled    = null
                ;

                // stop there if form has already been sent
                if (instance.$forms[id].sent) {
                    return;
                }

                var validatorInfos = getFormValidationInfos($target, rules);
                fields  = validatorInfos.fields;
                $fields = validatorInfos.$fields;
                rules   = instance.$forms[id].rules;


                if ( fields['_length'] == 0 ) { // nothing to validate
                    delete fields['_length'];
                    var result = {
                        'error'     : [],
                        'isValid'   : function() { return true },
                        'data'      : formatData(fields)
                    };

                    triggerEvent(gina, $target, 'validate.' + _id, result)

                } else {
                    // update rule in case the current event is triggered outside the main sequence
                    // e.g.: form `id` attribute rewritten on the fly
                    _id = $target.getAttribute('id');
                    var customRule = $target.getAttribute('data-gina-form-rule');

                    if ( customRule ) { // 'data-gina-form-rule'
                        rule = getRuleObjByName(customRule.replace(/\-|\//g, '.'))
                    } else {
                        rule = getRuleObjByName(_id.replace(/\-/g, '.'))
                    }
                    instance.$forms[id].isSubmitting = true;
                    instance.$forms[id].isSending = false;
                    validate($target, fields, $fields, rule, function onClickValidation(result){
                        triggerEvent(gina, $target, 'validate.' + _id, result)
                    })
                }
            });
        } // EO bindSubmitEl


        // BO binding submit button
        var $submit         = null
            , $buttons      = []
            , $buttonsTMP   = []
            , linkId        = null
            , buttonId      = null
        ;
        $buttonsTMP = $target.getElementsByTagName('button');
        if ( $buttonsTMP.length > 0 ) {
            for(let b = 0, len = $buttonsTMP.length; b < len; ++b) {
                if ($buttonsTMP[b].type == 'submit') {
                    $buttons.push($buttonsTMP[b])
                }
            }
        }

        // binding links
        $buttonsTMP = $target.getElementsByTagName('a');
        if ( $buttonsTMP.length > 0 ) {
            for(let b = 0, len = $buttonsTMP.length; b < len; ++b) {
                if ( $buttonsTMP[b].attributes.getNamedItem('data-gina-form-submit') ) {
                    $buttons.push($buttonsTMP[b])
                } else if (
                    !$buttonsTMP[b].getAttribute('id')
                    && !/gina\-popin/.test($buttonsTMP[b].className)
                    && !gina.popinIsBinded
                    && !/gina\-link/.test($buttonsTMP[b].className)
                ) { // will not be binded but will receive an id if not existing
                    linkId = 'link.'+ uuid.v4();
                    $buttonsTMP[b].id = linkId;
                }
            }
        }

        //
        var onclickAttribute = null, isSubmitType = false;
        for (let b=0, len=$buttons.length; b<len; ++b) {

            $submit = $buttons[b];
            // retrieve submitTrigger
            if (
                /button/i.test($submit.tagName)
                && typeof($submit.type) != 'undefined'
                && /submit/i.test($submit.type)
                ||
                /a/i.test($submit.tagName)
                && typeof($submit.dataset.ginaFormSubmit) != 'undefined'
                && /^true$/i.test($submit.dataset.ginaFormSubmit)
                ||
                /a/i.test($submit.parentNode.tagName)
                && typeof($submit.parentNode.dataset.ginaFormSubmit) != 'undefined'
                && /^true$/i.test($submit.parentNode.dataset.ginaFormSubmit)
            ) {
                if ( /a/i.test($submit.parentNode.tagName) ) {
                    $submit = $submit.parentNode;
                }

                if ( typeof($submit.id) == 'undefined' || typeof($submit.id) != 'undefined' && $submit.id == "" ) {
                    $submit.id = 'click.'+uuid.v4();
                    $submit.setAttribute('id', $submit.id);
                }

                if ( /a/i.test($submit.tagName) && typeof($submit.form) == 'undefined' ) {
                    $submit.form = { id: $form.id };
                    // $submit.form = $form;
                }

                /**if ( typeof(instance.$forms[$form.id].submitTrigger) != 'undefined' &&  $submit.form.id !== instance.$forms[$form.id].submitTrigger ) {
                    console.warn('Form `submitTrigger` is already defined for your form #'+ $submit.form.id +': cannot attach `'+$submit.id+'`');
                } else */
                if (
                    typeof($submit.dataset.ginaFormSubmitTriggerFor) == 'undefined'
                    && typeof(instance.$forms[$form.id]) != 'undefined'
                    && typeof(instance.$forms[$form.id].submitTrigger) == 'undefined'
                    && typeof($submit.form.id) != 'undefined'
                    && $form.id == $submit.form.id
                ) {
                    console.debug('attching submitTrigger: '+ $submit.id, ' \ form id: '+ $form.id);
                    instance.$forms[$form.id].submitTrigger = $form.submitTrigger = $submit.id || $submit.getAttribute('id');
                    // mark submitTrigger
                    $submit.dataset.ginaFormSubmitTriggerFor = $form.id;
                } // else, skipping
            }

            if ($submit.tagName == 'A') { // without this test, XHR callback is ignored
                //console.debug('a#$buttons ', $buttonsTMP[b]);
                onclickAttribute    = $submit.getAttribute('onclick');
                isSubmitType        = $submit.getAttribute('data-gina-form-submit');

                if ( !onclickAttribute && !isSubmitType) {
                    $submit.setAttribute('onclick', 'return false;')
                } else if ( !/return false/i.test(onclickAttribute) && !isSubmitType) {
                    if ( /\;$/.test(onclickAttribute) ) {
                        onclickAttribute += 'return false;'
                    } else {
                        onclickAttribute += '; return false;'
                    }
                }
            }

            if (!$submit['id']) {
                evt             = 'click.'+ uuid.v4();
                $submit['id']   = evt;
                $submit.setAttribute( 'id', evt);
            } else {
                evt = $submit['id'];
            }

            if ( typeof(gina.events[evt]) == 'undefined' || gina.events[evt] != $submit.id ) {
                bindSubmitEl(evt, $submit);
            }

        }// BO binding submit button

        evt = 'submit';

        // submit proxy
        addListener(gina, $target, evt, function(e) {

            var $target             = e.target
                , id                = $target.getAttribute('id')
                , $formInstance     = instance.$forms[id]
                , isBinded          = $form.binded
            ;

            // check submit trigger status
            var submitTrigger = new DOMParser()
                .parseFromString($target.innerHTML, 'text/html')
                .getElementById($formInstance.submitTrigger);
            // prevent submit if disabled
            if ( submitTrigger && submitTrigger.disabled) {
                cancelEvent(e);
            }

            // prevent event to be triggered twice
            if ( typeof(e.defaultPrevented) != 'undefined' && e.defaultPrevented )
                return false;

            if (withRules || isBinded) {
                cancelEvent(e);
            }


            // just collect data over forms
            // getting fields & values
            var $fields         = {}
                , fields        = { '_length': 0 }
                , rules         = ( typeof(gina.validator.$forms[id]) != 'undefined' ) ? gina.validator.$forms[id].rules : null
                , name          = null
                , value         = 0
                , type          = null
                , index         = { checkbox: 0, radio: 0 }
                , isDisabled    = null
            ;


            for (var i = 0, len = $target.length; i<len; ++i) {

                name        = $target[i].getAttribute('name');
                // NB.: If you still want to save the info and you main field is disabled;
                //      consider using an input type=hidden of validator rule `"exclude" : false`
                isDisabled  = $target[i].disabled || $target[i].getAttribute('disabled');
                isDisabled  = ( /disabled|true/i.test(isDisabled) ) ? true : false;

                if (!name) continue;
                if (isDisabled) continue;

                // checkbox or radio
                if ( typeof($target[i].type) != 'undefined' && $target[i].type == 'radio' || typeof($target[i].type) != 'undefined' && $target[i].type == 'checkbox' ) {

                    if ( $target[i].checked ) {
                        // if is boolean
                        if ( /^(true|false)$/.test($target[i].value) ) {
                            fields[name] = $target[i].value = (/^true$/.test($target[i].value)) ? true : false
                        } else {
                            fields[name] = $target[i].value
                        }

                    }  else if ( // force validator to pass `false` if boolean is required explicitly
                    rules
                    && typeof(rules[name]) != 'undefined'
                    && typeof (rules[name].isBoolean) != 'undefined' && $target[i].type == 'checkbox'
                    //&& typeof(rules[name].isRequired) != 'undefined'
                    && !/^(true|false)$/.test($target[i].value)
                    ) {
                        fields[name] = false;
                    }

                } else {
                    fields[name]    = $target[i].value;
                }



                $fields[name] = $target[i];
                // reset filed error data attributes
                $fields[name].setAttribute('data-gina-form-errors', '');

                //++fields['_length']
            }
            fields['_length'] = fields.count();


            if ( fields['_length'] == 0 ) { // nothing to validate

                delete fields['_length'];
                var result = {
                    'error'     : [],
                    'isValid'   : function() { return true },
                    'data'      : formatData(fields)
                };

                if ( typeof(gina.events['submit.' + id]) != 'undefined' ) { // if `on('submit', cb)` is binded
                    triggerEvent(gina, $target, 'submit.' + id, result);
                } else {
                    triggerEvent(gina, $target, 'validate.' + id, result);
                }

            } else {
                // update rule in case the current event is triggered outside the main sequence
                // e.g.: form `id` attribute rewritten on the fly
                var customRule = $target.getAttribute('data-gina-form-rule');

                if ( customRule ) { // 'data-gina-form-rule'
                    rule = getRuleObjByName(customRule.replace(/\-|\//g, '.'))
                } else {
                    rule = getRuleObjByName(id.replace(/\-/g, '.'))
                }
                instance.$forms[id].isValidating = true;
                validate($target, fields, $fields, rule, function onSubmitValidation(result){
                    instance.$forms[id].isValidating = false;
                    // var isFormValid = result.isValid();
                    // if (isFormValid) {
                    //     //resetting error display
                    //     handleErrorsDisplay($target, {}, result.data);
                    // } else {
                        // handleErrorsDisplay($target, result.error, result.data);
                        if ( typeof(gina.events['submit.' + id]) != 'undefined' ) { // if `on('submit', cb)` is binded
                            triggerEvent(gina, $target, 'submit.' + id, result);
                        } else {
                            triggerEvent(gina, $target, 'validate.' + id, result);
                        }
                        return;
                    // }
                })
            }
        });



        instance.$forms[_id]['binded']  = true;
        // If Live check enabled, proceed to silent validation
        if ( /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled && $form.rules.count() > 0) ) {
            console.debug('silent validation mode on');
            var validationInfo  = getFormValidationInfos($form.target, $form.rules);
            var fields          = validationInfo.fields;
            var $fields         = validationInfo.$fields;
            validate($form.target, fields, $fields, $form.rules, function onSilentValidation(result){
                console.debug('silent validation result[isValid:'+result.isValid()+']: ', result);
                if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                    // update toolbar
                    if (!gina.forms.errors)
                        gina.forms.errors = {};

                    var objCallback = {
                        id      : _id,
                        errors  :  result.error //,
                        // we might also need to update rules in case of form ajax changes
                        // rules   : $form.rules,
                        // data    : result.data
                    };

                    window.ginaToolbar.update('forms', objCallback);
                }
                updateSubmitTriggerState( $form, result.isValid() );
            });
        } else if (!/^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) {
            updateSubmitTriggerState( $form , true );
        }

    } // EO bindForm()

    var updateSubmitTriggerState = function($formInstanceOrTarget, isFormValid) {
        //console.debug('submitTrigger[isFormValid='+ isFormValid +']: ', $formInstance.submitTrigger)
        $formInstance = null;
        if ( $formInstanceOrTarget instanceof HTMLFormElement ) { //  is target DOMobject
            var id = $formInstanceOrTarget.getAttribute('id');
            $formInstance =  instance.$forms[id];
        } else {
            $formInstance = $formInstanceOrTarget;
        }
        //if (!$formInstance) return;

        if ( typeof($formInstance.submitTrigger) == 'undefined') {
            console.warn('This might be normal, so do not worry if this form is handled by your javascript: `'+ $formInstance.id +'`\nGina could not complete `updateSubmitTriggerState()`: `submitTrigger` might not be attached to form instance `'+ $formInstance.id +'`\nTo disable this warning, You just need to disable `Form Live Checking on your form by adding to your <form>: `data-gina-form-live-check-enabled=false``')
        } else if ( document.getElementById($formInstance.submitTrigger) ) {
            if ( /true/i.test(isFormValid) ) { // show submitTrigge
                document.getElementById($formInstance.submitTrigger).disabled = false;
            } else { // hide submitTrigger
                document.getElementById($formInstance.submitTrigger).disabled = true;
            }
        }
    }

    /**
     * getFormValidationInfos
     *
     * @param {object} $form - form target (DOMObject), not the instance
     * @param {object} [rules]
     *
     * @returns {object} { .fields, .$fields, .rules }
     */
    var getFormValidationInfos = function($form, rules, isOnResetMode) {
        // patching form reset
        if (typeof(isOnResetMode) == 'undefined') {
            isOnResetMode = false;
        }
        // getting fields & values
        var $fields         = {}
            , fields        = {}//{ '_length': 0 }
            , id            = $form.id || $form.getAttribute('id')
            , name          = null
            , value         = 0
            , type          = null
            , index         = { checkbox: 0, radio: 0 }
            , isDisabled    = null
        ;
        if ( typeof(rules) == 'undefined' ) {
            rules = ( typeof(instance.$forms[id].rules) != 'undefined' && instance.$forms[id].rules.count() > 0 ) ? instance.$forms[id].rules : null;
            if (!rules && typeof(gina.validator.$forms[id]) != 'undefined') {
                rules = gina.validator.$forms[id].rules
            }
        }

        // BO Parsing form elements
        for (var i = 0, len = $form.length; i<len; ++i) {
            if ( isOnResetMode ) {
                // reset form values
                switch ($form[i].tagName.toLowerCase()) {
                    case 'input':
                        if ( /^(hidden|text)$/i.test($form[i].type) ) {
                            $form[i].value = $form[i].defaultValue;
                        }
                        break;

                    default:
                        break;
                }
            }

            // retrieve submitTrigger
            if (
                /button/i.test($form[i].tagName)
                && typeof($form[i].type) != 'undefined'
                && /submit/i.test($form[i].type)
                ||
                /a/i.test($form[i].tagName)
                && typeof($form[i].dataset.ginaFormSubmit) != 'undefined'
                && /^true$/i.test($form[i].dataset.ginaFormSubmit)
            ) {
                if ( /a/i.test($form[i].tagName) && typeof($form[i].form) == 'undefined' ) {
                    $form[i].form = { id: id };
                }
                /**if ( typeof(instance.$forms[id].submitTrigger) != 'undefined' &&  $form[i].form.id !== instance.$forms[id].submitTrigger ) {
                    console.warn('Form `submitTrigger` is already defined for your form `#'+ $form[i].form.id +'`: cannot attach `'+$form[i].id+'`');
                } else */
                if (
                    typeof($form[i].dataset.ginaFormSubmitTriggerFor) == 'undefined'
                    && typeof(instance.$forms[id]) != 'undefined'
                    && typeof(instance.$forms[id].submitTrigger) == 'undefined'
                    && typeof($form[i].form.id) != 'undefined'
                    && id == $form[i].form.id
                ) {
                    instance.$forms[id].submitTrigger = $form[i].id || $form[i].getAttribute('id');
                    // mark submitTrigger
                    $form[i].dataset.ginaFormSubmitTriggerFor = id;
                }
                // else, skipping
            }

            name        = $form[i].getAttribute('name');
            // NB.: If you still want to save the info and you main field is disabled;
            //      consider using an input type=hidden of validator rule `"exclude" : false`
            isDisabled  = $form[i].disabled || $form[i].getAttribute('disabled');
            isDisabled  = ( /disabled|true/i.test(isDisabled) ) ? true : false;

            if (!name) continue;
            if (isDisabled) continue;

            // TODO - add switch cases against tagName (checkbox/radio)
            if (
                typeof($form[i].type) != 'undefined'
                && $form[i].type == 'radio'
                ||
                typeof($form[i].type) != 'undefined'
                && $form[i].type == 'checkbox' )
             {

                if (
                    $form[i].checked
                    || typeof (rules[name]) == 'undefined'
                        && $form[i].value != 'undefined'
                        && /^(true|false)$/.test($form[i].value)
                    || !$form[i].checked
                        && typeof (rules[name]) != 'undefined'
                        //&& typeof (rules[name].isBoolean) != 'undefined' && /^true$/.test(rules[name].isBoolean)
                        //&& typeof (rules[name].isRequired) != 'undefined' && /^true$/.test(rules[name].isRequired)
                        && typeof (rules[name].isBoolean) != 'undefined'
                        && /^(true|false)$/.test($form[i].value)
                ) {
                    // if is boolean
                    if ( /^(true|false)$/.test($form[i].value) ) {

                        if ( typeof(rules[name]) == 'undefined' ) {
                            rules[name] = { isBoolean: true };
                        } else if ( typeof(rules[name]) != 'undefined' && typeof(rules[name].isBoolean) == 'undefined' ) {
                            rules[name].isBoolean = true;
                            // forces it when field found in validation rules
                            rules[name].isRequired = true;
                        }

                        if ($form[i].type == 'radio') {
                            if ( typeof(rules[name]) == 'undefined' )
                                throw new Error('rule '+ name +' is not defined');

                            if (/^true$/.test(rules[name].isBoolean) && $form[i].checked ) {
                                fields[name] = (/^true$/.test($form[i].value)) ? true : false;
                            }
                        } else {
                            fields[name] = $form[i].value = (/^true$/.test($form[i].value)) ? true : false;
                        }

                    } else {
                        fields[name] = $form[i].value
                    }

                }  else if ( // force validator to pass `false` if boolean is required explicitly
                    rules
                    && typeof(rules[name]) != 'undefined'
                    && typeof(rules[name].isBoolean) != 'undefined'
                    && typeof(rules[name].isRequired) != 'undefined'
                    && !/^(true|false)$/.test($form[i].value)

                ) {
                    fields[name] = false;
                }

            } else {
                fields[name] = $form[i].value;
            }

            if ( typeof($fields[name]) == 'undefined' ) {
                $fields[name] = $form[i];
                // reset filed error data attributes
                $fields[name].setAttribute('data-gina-form-errors', '');
            }

            //++fields['_length']
        }// EO Parsing form elements
        fields['_length'] = fields.count() || 0;

        return {
            '$fields'   : $fields,
            'fields'    : fields,
            'rules'     : rules
        }
    }

    var getCastedValue = function(ruleObj, fields, fieldName, isOnDynamisedRulesMode) {

        if (
            // do not cast if no rule linked to the field
            typeof(ruleObj[fieldName]) == 'undefined'
            // do not cast if not defined or on error
            || /^(null|NaN|undefined|\s*)$/i.test(fields[fieldName])
        ) {
            return fields[fieldName]
        }

        if (
            /**typeof(ruleObj[fieldName].isBoolean) != 'undefined'
            || */typeof(ruleObj[fieldName].isNumber) != 'undefined'
            || typeof(ruleObj[fieldName].isInteger) != 'undefined'
            || typeof(ruleObj[fieldName].isFloat) != 'undefined'
            || typeof(ruleObj[fieldName].toFloat) != 'undefined'
            || typeof(ruleObj[fieldName].toInteger) != 'undefined'
        ) {

            if ( /\,/.test(fields[fieldName]) ) {
                fields[fieldName] = fields[fieldName].replace(/\,/g, '.').replace(/\s+/g, '');
            }
            return fields[fieldName];
        }

        if ( typeof(fields[fieldName]) == 'boolean') {
            return fields[fieldName]
        } else if (ruleObj[fieldName].isBoolean) {
            return (/^true$/i.test(fields[fieldName])) ? true : false;
        }

        return (
            typeof(isOnDynamisedRulesMode) != 'undefined'
            && /^true$/i.test(isOnDynamisedRulesMode)
        ) ? '\\"'+ fields[fieldName] +'\\"' : fields[fieldName];
    }

    /**
     * formatFields
     * Will cast values if needed
     *
     * @param {string|object} rules
     * @param {object} fields
     * @returns
     */
    var formatFields = function(rules, fields) {
        var ruleObj = null;
        if ( typeof(rules) != 'string') {
            rules = JSON.stringify(JSON.clone(rules))
        }
        ruleObj = JSON.parse(rules.replace(/\"(true|false)\"/gi, '$1'));

        for (let fName in fields) {
            fields[fName] = getCastedValue(ruleObj, fields, fName);
        }
        return fields;
    }

    var getDynamisedRules = function(stringifiedRules, fields, $fields, isLiveCheckingOnASingleElement) {

        // Because this could also be live check, if it is the case, we need all fields
        // of the current form rule for variables replacement/evaluation. Since live check is
        // meant to validate one field at the time, you could fall in a case where the current
        // field should be compared with another field of the same form.
        var ruleObj = JSON.parse(stringifiedRules.replace(/\"(true|false)\"/gi, '$1'));
        var stringifiedRulesTmp = JSON.stringify(ruleObj);
        if (isLiveCheckingOnASingleElement) {
            var $currentForm    = $fields[Object.getOwnPropertyNames($fields)[0]].form;
            var vInfos          = getFormValidationInfos($currentForm, ruleObj);
            delete vInfos.fields._length;

            fields  = vInfos.fields;
            $fields = vInfos.$fields;
        }


        var re = null, _field = null, arrFields = [], a = 0;
        // avoiding conflict like ["myfield", "myfield-name"]
        // where once `myfield` is replaced for exemple with `1234`, you also get 1234-name left behind
        // TODO - Replace this trick with a RegExp matching only the exact word
        // TODO - test this one:
        //          \W(\$myfield-name)(?!-)\W
        for (let field in fields) {
            arrFields[a] = field;
            a++;
        }
        arrFields.sort().reverse();

        for (let i = 0, len = arrFields.length; i < len; i++) {
            _field = arrFields[i].replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&');
            re = new RegExp('\\$'+_field, 'g');
            // default field value
            let fieldValue = '\\"'+ fields[arrFields[i]] +'\\"';
            let isInRule = re.test(stringifiedRulesTmp);
            if ( isInRule && typeof(ruleObj[arrFields[i]]) != 'undefined' ) {
                fieldValue = getCastedValue(ruleObj, fields, arrFields[i], true);
            } else if ( isInRule ) {
                console.warn('`'+arrFields[i]+'` is used in a dynamic rule without definition. This could lead to an evaluation error. Casting `'+arrFields[i]+'` to `string`.');
            }

            stringifiedRules = stringifiedRules.replace(re, fieldValue );
        }
        if ( /\$(.*)/.test(stringifiedRules) ) {
            for (let i = 0, len = arrFields.length; i < len; i++) {
                _field = arrFields[i].replace(/\-|\_|\@|\#|\.|\[|\]/g, '\\$&');
                re = new RegExp('\\$'+_field, 'g');
                // default field value
                let fieldValue = ($fields[arrFields[i]].value != '' ) ? '\\"'+ $fields[arrFields[i]].value +'\\"' : '\\"\\"';
                let isInRule = re.test(stringifiedRulesTmp);
                if ( isInRule && typeof(ruleObj[arrFields[i]]) != 'undefined' ) {
                    fieldValue = getCastedValue(ruleObj, fields, arrFields[i], true);
                } else if ( isInRule ) {
                    console.warn('`'+arrFields[i]+'` is used in a dynamic rule without definition. This could lead to an evaluation error. Casting `'+arrFields[i]+'` to `string`.');
                }

                stringifiedRules = stringifiedRules.replace(re, fieldValue || $fields[arrFields[i]].checked);
            }
        }

        return JSON.parse(stringifiedRules)
    }


    /**
     * Validate form
     * @param {object} $formOrElement - ${form|element}.target (DOMObject)
     * @param {object} fields
     * @param {object} $fields
     * @param {object} rules
     * @param {callback} cb
     */
    var validate = function($formOrElement, fields, $fields, rules, cb) {

        delete fields['_length']; //cleaning

        var stringifiedRules = JSON.stringify(rules);
        fields = formatFields(stringifiedRules, fields);
        if ( /\$(.*)/.test(stringifiedRules) ) {
            var isLiveCheckingOnASingleElement = (
                !/^form$/i.test($formOrElement.tagName)
                && $fields.count() == 1
                && /true/i.test($formOrElement.form.dataset.ginaFormLiveCheckEnabled)
            ) ? true : false;
            rules = getDynamisedRules(stringifiedRules, fields, $fields, isLiveCheckingOnASingleElement)
        }
        var id                  = null
            , evt               = null
            , data              = null
            , hasBeenValidated  = false
            , subLevelRules     = 0
            , rootFieldsCount   = fields.count()
            , hasParsedAllRules = false
            , $asyncField       = null
            , $asyncFieldId     = null
            , asyncEvt          = null
            , asyncCount        = 0
        ;


        var re = null, flags = null, args = null;
        var checkFieldAgainstRules = function(field, rules, fields) {
            // ignore field if used as a _case_field

            // looking for regexp aliases from rules
            if ( typeof (rules[field]) == 'undefined') {
                skipTest = false;
                // TODO - replace loop by checkForRuleAlias(rules, $el);
                for (var _r in rules) {
                    if (/^_comment$/i.test(_r)) continue;
                    if ( /^\//.test(_r) ) { // RegExp found
                        re      = _r.match(/\/(.*)\//).pop();
                        flags   = _r.replace('/'+ re +'/', '');
                        // fix escaping "[" & "]"
                        re      = re.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                        re      = new RegExp(re, flags);
                        if ( re.test(field)  ) {
                            skipTest = true;
                            // create new entry
                            rules[field] = rules[_r];
                            break;
                        }
                    }
                }

                if ( typeof(rules[field]) == 'undefined' )
                    return;
            }

            var listedFields = Object.getOwnPropertyNames(rules) || [];
            var f = 0, fLen = listedFields.length;
            if (fLen > 0) {
                while (f < fLen) {
                    if (
                        typeof(rules[listedFields[f]].exclude) != 'undefined'
                        && /^true$/i.test(rules[listedFields[f]].exclude)
                    ) {
                        // remove from listedFields
                        listedFields.splice(f, 1);
                        fLen--;
                        f--;
                    }
                    f++;
                }
            }

            // check each field against rule
            for (var rule in rules[field]) {
                // skip when not processing rule function
                if ( typeof(d[field][rule]) != 'function' ) {
                    continue;
                }

                if ( /^((is)\d+|is$)/.test(rule) && typeof(d[field][rule]) == 'undefined' ) { // is aliases
                    d[field][rule] = function(){};
                    d[field][rule] = inherits(d[field][rule], d[field][ rule.replace(/\d+/, '') ]);
                    d[field][rule].setAlias = (function(alias) {
                        this._currentValidatorAlias = alias
                    }(rule));
                }
                // check for rule params
                try {
                    if (Array.isArray(rules[field][rule])) { // has args
                        //convert array to arguments
                        args = JSON.clone(rules[field][rule]);
                        if ( /\$[\-\w\[\]]*/.test(args[0]) ) {
                            var foundVariables = args[0].match(/\$[\-\w\[\]]*/g);
                            for (var v = 0, vLen = foundVariables.length; v < vLen; ++v) {
                                args[0] = args[0].replace( foundVariables[v], d[foundVariables[v].replace('$', '')].value )
                            }
                        }
                        d[field][rule].apply(d[field], args);
                    } else {
                        // query rule case
                        if ( /^query$/.test(rule) ) {
                            $asyncField     = $fields[field];
                            $asyncFieldId   = $asyncField.getAttribute('id');
                            asyncEvt        = 'asyncCompleted.'+ $asyncFieldId;

                            var triggeredCount = 0, eventTriggered = false;
                            if ( typeof(gina.events[asyncEvt]) != 'undefined' ) {
                                console.debug('event `'+ asyncEvt +'` already added');
                                asyncCount = 0;
                                return;
                            }
                            ++asyncCount;
                            //console.debug('Adding listner '+asyncEvt);
                            addListener(gina, $asyncField, asyncEvt, function onasyncCompleted(event) {
                                event.preventDefault();

                                triggeredCount++;
                                --asyncCount;
                                // is this the last rule ?
                                var _rulesArr = Object.getOwnPropertyNames(rules[field]);
                                if (_rulesArr[_rulesArr.length-1] == rule) {
                                    hasParsedAllRules = true;
                                }

                                var _asyncEvt = 'asyncCompleted.' + event.target.getAttribute('id');
                                if ( /true/.test(eventTriggered) ) {
                                    // console.debug('already triggered !\nasyncCount: '+ asyncCount +'\nhasParsedAllRules: '+hasParsedAllRules );
                                    return;
                                }

                                d[field] = event.detail;

                                // retrieve current form
                                var $currentForm = $formOrElement;
                                if ( !/^form$/i.test($formOrElement.tagName) ) {
                                    $currentForm  = $formOrElement.form;
                                }
                                var formId = $currentForm.getAttribute('id');

                                if (
                                    hasParsedAllRules
                                    && asyncCount <= 0
                                    && !eventTriggered
                                ) {
                                    eventTriggered = true;

                                    // removing listner to revalidate with another context
                                    //console.debug('removing listner '+ _asyncEvt +'\nasyncCount: '+ asyncCount +'\nhasParsedAllRules: '+hasParsedAllRules + '\neventTriggered: '+ eventTriggered);
                                    removeListener(gina, event.target, _asyncEvt);

                                    cb._data = d['toData']();
                                    cb._errors = d['getErrors'](field);
                                    // console.debug('query callbakc triggered ', cb._errors, '\nisValidating: ', instance.$forms[formId].isValidating);
                                    // update instance form errors
                                    if ( cb._errors && cb._errors.count() > 0) {
                                        if ( typeof(instance.$forms[formId].errors) == 'undefined' ) {
                                            instance.$forms[formId].errors = {}
                                        }

                                        instance.$forms[formId].errors[field] = cb._errors[field];

                                        if (!isFormValid && /^true|false$/i.test(instance.$forms[formId].isValidating) || d[field].target.value != '' ) {
                                            refreshWarning($allFields[field]);
                                            handleErrorsDisplay($currentForm, cb._errors, cb._data, field);
                                            updateSubmitTriggerState( $currentForm, isFormValid);
                                        }

                                        if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                            // update toolbar
                                            if (!gina.forms.errors)
                                                gina.forms.errors = {};

                                            var objCallback = {
                                                id      : formId,
                                                errors  :  instance.$forms[formId].errors || {}
                                            };

                                            window.ginaToolbar.update('forms', objCallback);
                                        }


                                        triggerEvent(gina, $currentForm, 'validated.' + formId, cb);
                                        return;
                                    }
                                }

                                // is this the last or the only field to be validated ?
                                var needsGlobalReValidation = false, isFormValid = null;
                                if ( listedFields.length == 1 || listedFields[listedFields.length-1] == field) {
                                    // trigger end of validation
                                    // console.debug(field +' is the last element to be validated for formId: '+ formId, cb._errors, instance.$forms[formId].errors);
                                    isFormValid = ( cb._errors.count() > 0 ) ? false : true;
                                    if (!isFormValid && /^true|false$/i.test(instance.$forms[formId].isValidating)) {
                                        //console.debug('should update error display now ', cb._errors);
                                        instance.$forms[formId].errors = merge(cb._errors, instance.$forms[formId].errors);
                                        refreshWarning($allFields[field]);
                                        handleErrorsDisplay($currentForm, cb._errors, cb._data, field);
                                        updateSubmitTriggerState( $currentForm, isFormValid);
                                    }
                                    triggerEvent(gina, $currentForm, 'validated.' + formId, cb);
                                }
                                // just update warning state
                                else if (/^true$/i.test(instance.$forms[formId].isValidating) && listedFields.length > 1 && listedFields[listedFields.length-1] != field ) {
                                    //console.debug(field +' is NOT the last element to be validated for formId: '+ formId);
                                    needsGlobalReValidation = true;
                                }

                                if (needsGlobalReValidation) {
                                    validate($currentForm, allFields, $allFields, rules, function onSilentQueryGlobalLiveValidation(gResult){
                                        instance.$forms[formId].isValidating = false;
                                        // console.debug('['+ formId +'] onSilentQueryGlobalLiveValidation: '+ gResult.isValid(), gResult);
                                        isFormValid = gResult.isValid();
                                        if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                            // update toolbar
                                            if (!gina.forms.errors)
                                                gina.forms.errors = {};

                                            var objCallback = {
                                                id      : formId,
                                                errors  :  gResult.error || {}
                                            };

                                            window.ginaToolbar.update('forms', objCallback);
                                        }



                                        handleErrorsDisplay($currentForm, gResult.error, gResult.data, field);
                                        updateSubmitTriggerState( $currentForm, isFormValid);
                                    })
                                }

                            });

                            d[field][rule](rules[field][rule]);
                            continue;
                        }
                        // normal rule case
                        else {
                            d[field][rule](rules[field][rule]);
                        }
                    }

                    delete fields[field];

                } catch (err) {
                    if (rule == 'conditions') {
                        throw new Error('[ ginaFormValidator ] could not evaluate `' + field + '->' + rule + '()` where `conditions` must be a `collection` (Array)\nStack:\n' + err)
                    } else {
                        throw new Error('[ ginaFormValidator ] could not evaluate `' + field + '->' + rule + '()`\nStack:\n' + err)
                    }
                }
            }
        }


        //console.debug(fields, $fields);
        var d = null;//FormValidator instance
        var fieldErrorsAttributes = {}, isSingleElement = false;
        if (isGFFCtx) { // Live check if frontend only for now
            // form case
            if ( /^form$/i.test($formOrElement.tagName) ) {
                id = $formOrElement.getAttribute('id');
                evt = 'validated.' + id;
                instance.$forms[id].fields = fields;
                // clear existing errors
                if ( typeof($formOrElement.eventData) != 'undefined' && typeof($formOrElement.eventData.error) != 'undefined' ) {
                    delete $formOrElement.eventData.error
                }
                d = new FormValidator(fields, $fields, xhrOptions);
            }
            // single element case
            else {
                isSingleElement = true;
                id = $formOrElement.form.getAttribute('id') || $formOrElement.form.target.getAttribute('id');

                evt = 'validated.' + id;
                instance.$forms[id].fields = fields;
                d = new FormValidator(fields, $fields, xhrOptions, instance.$forms[id].fieldsSet);
            }
        } else {
            d = new FormValidator(fields, null, xhrOptions);
        }


        var allFields = null;
        var $allFields = null;
        if (!isSingleElement) {
            allFields   = JSON.clone(fields);
            $allFields  = $fields;
        } else {
            // TODO - Get cached infos
            var formId = $formOrElement.form.getAttribute('id');
            var formAllInfos = getFormValidationInfos(instance.$forms[formId].target, instance.$forms[formId].rules, false);
            allFields   = formatFields(JSON.stringify(instance.$forms[formId].rules), JSON.clone(formAllInfos.fields));
            $allFields  = formAllInfos.$fields;
        }

        var allRules = ( typeof(rules) !=  'undefined' ) ? JSON.clone(rules) : {};
        var forEachField = function($formOrElement, allFields, allRules, fields, $fields, rules, cb, i) {


            var hasCase = false, isInCase = null, conditions = null;
            var caseValue = null, caseType = null;
            var localRules = null, caseName = null;
            var localRuleObj = null, skipTest = null;
            var localFieldType  = null;

            //console.debug('parsing ', fields, $fields, rules);
            if ( typeof(rules) != 'undefined' ) {

                for (var field in fields) {

                    localFieldType = $fields[field].getAttribute('type');

                    if ( isGFFCtx && typeof($fields[field]) == 'undefined' ) {
                        //throw new Error('field `'+ field +'` found for your form rule ('+ $formOrElement.id +'), but not found in $field collection.\nPlease, check your HTML or remove `'+ field +'` declaration from your rule.')
                        console.warn('field `'+ field +'` found for your form rule ('+ $formOrElement.id +'), but not found in $field collection.\nPlease, check your HTML or remove `'+ field +'` declaration from your rule if this is a mistake.');
                        continue;
                    }
                    // 2021-01-17: fixing exclude default override for `data-gina-form-element-group`
                    if (
                        isGFFCtx
                        && $fields[field].getAttribute('data-gina-form-element-group')
                        && typeof(rules[field]) != 'undefined'
                        && typeof(rules[field].exclude) != 'undefined'
                        && rules[field].exclude
                        && !$fields[field].disabled
                    ) {
                        rules[field].exclude = false;
                    }

                    hasCase = ( typeof(rules['_case_' + field]) != 'undefined' ) ? true : false;
                    isInCase = false;


                    if (
                        isGFFCtx
                        && $fields[field].tagName.toLowerCase() == 'input'
                        && /^(checkbox)$/i.test(localFieldType)
                    ) {
                        if (
                            !$fields[field].checked
                                && typeof(rules[field]) != 'undefined'
                                && typeof(rules[field].isRequired) != 'undefined'
                                && /^(false)$/i.test(rules[field].isRequired)
                            ||
                            $fields[field].disabled
                        ) {
                            rules[field] = {
                                exclude: true
                            }

                        } else if ( /**^(checkbox)$/i.test(localFieldType) && */!$fields[field].checked && typeof(rules[field]) == 'undefined' ) {
                            continue;
                        }
                    }
                    else if (
                        isGFFCtx
                        && $fields[field].tagName.toLowerCase() == 'input'
                        && /^(radio)$/i.test(localFieldType)
                    ) {
                        console.debug('Radio: ', $fields[field].id, $fields[field].checked, $fields[field].value)
                    }




                    for (var c in rules) {
                        if (!/^\_case\_/.test(c) ) continue;
                        if ( typeof(rules[c].conditions) == 'undefined' || Array.isArray(rules[c].conditions) && !rules[c].conditions.length ) continue;
                        if ( typeof(rules[c].conditions[0].rules) == 'undefined' ) continue;


                        // enter cases conditions
                        if (
                            typeof(rules[c].conditions) != 'undefined'
                            && Array.isArray(rules[c].conditions)
                        ) {
                            caseName = c.replace('_case_', '');
                            // if case exists but case field not existing
                            if ( typeof($allFields[caseName]) == 'undefined' ) {
                                console.warn('Found case `'+ c +'` but field `'+ caseName +'` is misssing in the dom.\n You should add `'+ caseName +'` element to your form in order to allow Validator to process this case.');
                                continue
                            }

                            // depending on the case value, replace/merge original rule with condition rule
                            if ( typeof(allFields[caseName]) == 'undefined' ) {
                                //allFields[caseName] =  $fields[c.replace(/^\_case\_/, '')].value
                                allFields[caseName] =  $allFields[caseName].value
                            }
                            // Watch changes in case the value is modified
                            // A mutation observer was previously defined in case of hidden field when value has been mutated with javascript
                            // Ref.: liveCheck; look for comment `// Adding observer for hidden fileds`
                            /**
                            let caseEvent = 'change._case_' + caseName;
                            if ( typeof(gina.events[caseEvent]) == 'undefined' ) {

                                var redefineRulingContext = function($el, rules, c) {
                                    var _caseName = $el.name;
                                    if ( allFields[_caseName] != $el.value ) {
                                        console.debug('case `'+ _caseName +'` is changing from ', allFields[_caseName], ' to ', $el.value );

                                        if ( typeof(fields) == 'undefined') {
                                            var fields = {};
                                        }
                                        var _val = $el.value;
                                        if ( /^(true|false)$/i.test(_val) ) {
                                            _val = (/^(true)$/i.test(_val)) ? true : false;
                                        }
                                        if ( /^\d+$/.test(_val) ) {
                                            _val = parseInt(_val);
                                        }
                                        // Saving case current value
                                        allFields[_caseName] = fields[_caseName] = _val;

                                        // rebind & restart validation in silent mode
                                        var $_form = $el.form;
                                        if ($_form) {
                                            // backup `originalRules` in order to avoid override
                                            var formInstance = instance['$forms'][$_form.id];
                                            var customRules = {};
                                            var caseRules = {};
                                            var _conditions = [];
                                            if ( typeof(formInstance.originaRules) == 'undefined' ) {
                                                formInstance.originaRules = JSON.clone(rules);
                                            } else {
                                                //customRules = merge(rules, formInstance.originaRules);
                                                //customRules = JSON.clone(formInstance.originaRules);
                                                caseRules = JSON.clone(formInstance.originaRules);
                                            }
                                            //var customRules = JSON.clone(formInstance.originaRules);

                                            //var customRules = JSON.clone(rules);

                                            if ( typeof(rules[c]) != 'undefined' && typeof(rules[c].conditions) != 'undefined' ) {
                                                _conditions = rules[c].conditions;
                                            } else if (typeof(rules['_case_'+_caseName]) != 'undefined' && typeof(rules['_case_'+_caseName].conditions) != 'undefined') {
                                                _conditions = rules['_case_'+_caseName].conditions;
                                            }
                                            if (_conditions.length > 1) { // more than one condition
                                                for (let _ci = 0, _ciLen = _conditions.length; _ci < _ciLen; _ci++) {
                                                    if (
                                                        Array.isArray(_conditions[_ci].case)
                                                        && _conditions[_ci].case.indexOf(fields[_caseName]) > -1
                                                        ||
                                                        _conditions[_ci].case == fields[_caseName]
                                                    ) {
                                                        // Inherited first
                                                        caseRules = merge(_conditions[_ci].rules, caseRules);
                                                        //caseRules = _conditions[_ci].rules;
                                                    }
                                                }
                                            } else {
                                                if (
                                                    Array.isArray(_conditions[0].case)
                                                    && _conditions[0].case.indexOf(fields[_caseName]) > -1
                                                    ||
                                                    _conditions[0].case == fields[_caseName]
                                                ) {
                                                    // Inherited first
                                                    caseRules = merge(_conditions[0].rules, caseRules);
                                                    //caseRules = _conditions[0].rules;
                                                } else {
                                                    var _filter = {};
                                                    _filter['case'] = fields[_caseName];
                                                    try {
                                                        caseRules = merge(new Collection(_conditions).findOne(_filter).rules, caseRules)
                                                        //caseRules = new Collection(_conditions).findOne(_filter).rules
                                                        //caseRules = new Collection(_conditions).findOne(_filter).rules;
                                                    } catch (err) {
                                                        console.warn('Trying to eval undeclared or misconfigured case `"_case_'+ _caseName +'"`: `'+ fields[_caseName] +'`.\Now Skipping it, please check your rules and fix it if needed.');
                                                        // else -> caseRules = {}
                                                    }

                                                    _filter = null;
                                                }
                                            }
                                            _conditions = null;



                                            // Setting up new validation rules
                                            for (let _f in caseRules) {
                                                // if ( typeof(customRules[_f]) == 'undefined' ) {
                                                    customRules[_f] = caseRules[_f];
                                                // } else {
                                                //     // do not override customRules
                                                //     customRules[_f] = merge(customRules[_f], caseRules[_f]);
                                                // }

                                            }
                                            // formInstance._current_caseName = _caseName;
                                            // if ( typeof(formInstance._current_case) == 'undefined' ) {
                                            //     formInstance._current_case = {};
                                            // }
                                            // formInstance._current_case[_caseName] = customRules;

                                            caseRules = null;
                                            // reset binding
                                            reBindForm($_form, customRules);
                                        }
                                    }
                                }


                                //console.debug('placing event on ', $fields[caseName].name, caseEvent)
                                // We need to bind the case event and the input event at the same time
                                // search for grouped els
                                // var grpName = $fields[caseName].name;
                                // var selectedEls = [], sl = 0;
                                // if ( $formOrElement.length > 1 ) {
                                //     for (let g = 0, gLen = $formOrElement.length; g < gLen; g++) {
                                //         if (
                                //             $formOrElement[g].name ==  grpName
                                //             && $formOrElement[g].type == $fields[caseName].type
                                //             && $formOrElement[g].id != $fields[caseName].id
                                //         ) {
                                //             selectedEls[sl] = $formOrElement[g];
                                //             ++sl;
                                //         }
                                //     }
                                // }
                                // This portion of code is used for case value change
                                // var $elementToBind = (selectedEls.length > 0) ? selectedEls : $fields[caseName];
                                //     addListener(gina, $elementToBind, 'change.', function(event) {
                                //         event.preventDefault();
                                //         console.debug('Now rebinding on ', event.currentTarget.name +' == '+ event.currentTarget.value );
                                //         redefineRulingContext(event.currentTarget, rules, c);
                                //     });

                                // handles _case_* change; also useful if your are using radio tabs as cases triggers
                                addListener(gina, $fields[caseName], [ caseEvent, 'change.'+$fields[caseName].id ], function(event) {
                                    event.preventDefault();
                                    console.debug('First rebinding on ', event.currentTarget.name +' == '+ event.currentTarget.value );
                                    redefineRulingContext(event.currentTarget, rules, c);
                                });

                            } // EO caseEvent
                            */
                            caseValue = allFields[caseName];
                            if (isGFFCtx) {
                                if (fields[field] == "true")
                                    caseValue = true;
                                else if (fields[field] == "false")
                                    caseValue = false;
                            }


                            // filtering conditions
                            for (var _c = 0, _cLen = rules[c].conditions.length; _c < _cLen; ++_c) {

                                if (rules[c].conditions[_c].case != caseValue) {
                                    continue;
                                }

                                // enter condition rules
                                for (var _r in rules[c].conditions[_c].rules) {
                                    if (/^_comment$/i.test(_r)) continue;
                                    // ignore if we are testing on caseField or if $field does not exist
                                    if (_r == caseName || !$fields[_r]) continue;
                                    //if (_r == caseName || !$fields[caseName]) continue;
                                    // ok, not the current case but still,
                                    // we want to apply the validation when the field is not yet listed
                                    if (field != _r && !/^\//.test(_r) ) {
                                        if (
                                            typeof(fields[_r]) == 'undefined'
                                            &&  typeof(allFields[_r]) != 'undefined'
                                        ) {
                                            fields[_r] = allFields[_r];
                                            localRuleObj = ( typeof(rules[_r]) != 'undefined' ) ? rules[_r] : {};
                                            rules[_r] = merge(rules[c].conditions[_c].rules[_r], localRuleObj);

                                            checkFieldAgainstRules(_r, rules, fields);
                                            continue;
                                        }
                                    }


                                    if ( /^\//.test(_r) ) { // RegExp found
                                        re      = _r.match(/\/(.*)\//).pop();
                                        flags   = _r.replace('/'+ re +'/', '');
                                        // fix escaping "[" & "]"
                                        re      = re.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                                        re      = new RegExp(re, flags);
                                        if ( re.test(field)  ) {
                                            // depending on the case value, replace/merge original rule with condition rule
                                            // if ( typeof(allFields[caseField]) == 'undefined' ) {
                                            //     allFields[caseField] =  $fields[c.replace(/^\_case\_/, '')].value
                                            // }
                                            // caseValue = allFields[caseField];
                                            // if (isGFFCtx) {
                                            //     if (fields[field] == "true")
                                            //         caseValue = true;
                                            //     else if (fields[field] == "false")
                                            //         caseValue = false;
                                            // }
                                            if (
                                                rules[c].conditions[_c].case == caseValue
                                                ||
                                                // test for regexp
                                                /^\//.test(rules[c].conditions[_c].case)
                                                && new RegExp(rules[c].conditions[_c].case).test(caseValue)
                                            ) {
                                                localRuleObj = ( typeof(rules[_r]) != 'undefined' ) ? rules[_r] : {};
                                                rules[_r] = merge(rules[c].conditions[_c].rules[_r], localRuleObj);
                                            }
                                            // check each field against rule only if rule exists 1/3
                                            if ( caseName != _r && typeof(rules[_r]) != 'undefined') {
                                                checkFieldAgainstRules(_r, rules, fields);
                                            }
                                        }
                                    } else {
                                        if ( typeof(rules[c].conditions[_c].rules[_r]) != 'undefined' ) {
                                            // depending on the case value, replace/merge original rule with condition rule
                                            //caseField = c.replace(/^\_case\_/, '');
                                            caseField = _r;
                                            caseValue = fields[caseField];

                                            if ( typeof($fields[caseField]) == 'undefined' ) {
                                                console.warn('ignoring case `'+ caseField +'`: field `'+ +'` not found in your DOM');
                                                continue;
                                            }
                                            // by default
                                            // if ( typeof(allFields[caseField]) == 'undefined' ) {
                                            //     allFields[caseField] =  $fields[caseField].value
                                            // }
                                            // caseValue =  allFields[caseField];
                                            // boolean caseValue
                                            if (
                                                isGFFCtx
                                                && /^(true|false)$/i.test(caseValue)
                                                && typeof(rules[caseField]) != 'undefined'
                                                && typeof(rules[caseField].isBoolean) != 'undefined'
                                                && /^(true)$/i.test(rules[caseField].isBoolean)
                                            ) {
                                                caseValue = ( /^(true)$/i.test(caseValue) ) ? true : false;
                                            }

                                            if (
                                                //rules[c].conditions[_c].case == caseValue
                                                typeof(rules[c].conditions[_c].rules[_r]) != 'undefined'
                                                // ||
                                                // // test for regexp
                                                // /^\//.test(rules[c].conditions[_c].case)
                                                // && new RegExp(rules[c].conditions[_c].case).test(caseValue)
                                            ) {
                                                localRuleObj = ( typeof(rules[c].conditions[_c].rules[_r]) != 'undefined' ) ? rules[c].conditions[_c].rules[_r] : {};
                                                //rules[_r] = merge(rules[c].conditions[_c].rules[_r], localRuleObj);
                                                rules[_r] = localRuleObj;
                                            }

                                            // check each field against rule only if rule exists 2/3
                                            //if ( caseName != _r && typeof(rules[_r]) != 'undefined' ) {
                                            if ( caseName != _r && typeof(rules[_r]) != 'undefined' && typeof(fields[_r]) != 'undefined' ) {
                                                checkFieldAgainstRules(_r, rules, fields);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (isInCase || caseName == field) continue;

                    // check each field against rule only if rule exists 3/3
                    if ( typeof(rules[field]) != 'undefined' ) {
                        //checkFieldAgainstRules(field, rules, fields);
                        checkFieldAgainstRules(field, rules, allFields);
                    }

                    if (hasCase) {
                        ++i; // add sub level
                        conditions = rules['_case_' + field]['conditions'];

                        if ( !conditions ) {
                            throw new Error('[ ginaFormValidator ] case `_case_'+field+'` found without `condition(s)` !\nPlease, check your delcaration for `_case_'+ field +'`');
                        }


                        for (let c = 0, cLen = conditions.length; c<cLen; ++c) {
                            // by default
                            //caseValue = fields[field];
                            caseValue =  allFields[field];

                            if (isGFFCtx) {
                                if (fields[field] == "true")
                                    caseValue = true;
                                else if (fields[field] == "false")
                                    caseValue = false;
                            }

                            //console.debug(caseValue +' VS '+ conditions[c]['case'], "->", (caseValue == conditions[c]['case'] || Array.isArray(conditions[c]['case']) && conditions[c]['case'].indexOf(caseValue) > -1) );
                            if (
                                conditions[c]['case'] === caseValue
                                ||
                                Array.isArray(conditions[c]['case']) && conditions[c]['case'].indexOf(caseValue) > -1
                                ||
                                /^\//.test(conditions[c]['case'])
                            ) {

                                //console.debug('[fields ] ' + JSON.stringify(fields, null, 4));
                                localRules = {};
                                // exclude case field if not declared in rules && not disabled
                                if (
                                    typeof(conditions[c]['rules'][field]) == 'undefined'
                                    && typeof(allFields[field]) == 'undefined'
                                    ||
                                    $fields[field].disabled
                                ) {
                                    conditions[c]['rules'][field] = { exclude: true }
                                }
                                for (var f in conditions[c]['rules']) {
                                    if (/^_comment$/i.test(f)) continue;
                                    //console.debug('F: ', f, '\nrule: '+ JSON.stringify(conditions[c]['rules'][f], null, 2));
                                    if ( /^\//.test(f) ) { // RegExp found

                                        re      = f.match(/\/(.*)\//).pop();
                                        flags   = f.replace('/'+ re +'/', '');
                                        // fix escaping "[" & "]"
                                        re      = re.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                                        re      = new RegExp(re, flags);

                                        for (var localField in $fields) {
                                            if ( re.test(localField) ) {
                                                if ( /^\//.test(conditions[c]['case']) ) {
                                                    re      = conditions[c]['case'].match(/\/(.*)\//).pop();
                                                    flags   = conditions[c]['case'].replace('/'+ re +'/', '');
                                                    re      = new RegExp(re, flags);

                                                    if ( re.test(caseValue) ) {
                                                        localRules[localField] = conditions[c]['rules'][f];
                                                    }

                                                } else {
                                                    localRules[localField] = conditions[c]['rules'][f]
                                                }

                                                // we need to add it to fields list if not declared
                                                if (
                                                    typeof(fields[localField]) == 'undefined'
                                                    && typeof($fields[localField]) != 'undefined'
                                                    && typeof($fields[localField].value) != 'undefined'
                                                ) {
                                                    fields[localField] = $fields[localField].value;//caseValue is not goo here
                                                    if (isGFFCtx && /(true|false)/i.test(fields[localField] ) ) {
                                                        if (fields[localField] == "true")
                                                            fields[localField]  = true;
                                                        else if (fields[localField] == "false")
                                                            fields[localField]  = false;
                                                    }
                                                    d.addField(localField, fields[localField]);
                                                    if ( typeof(allRules[localField]) != 'undefined' ) {
                                                        localRules[localField] = merge(localRules[localField], allRules[localField])
                                                    }
                                                }
                                            }
                                        }

                                    } else {
                                        if ( /^\//.test(conditions[c]['case']) ) {

                                            re      = conditions[c]['case'].match(/\/(.*)\//).pop();
                                            flags   = conditions[c]['case'].replace('/'+ re +'/', '');
                                            // fix escaping "[" & "]"
                                            re      = re.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                                            re      = new RegExp(re, flags);

                                            if ( re.test(caseValue) ) {
                                                localRules[f] = conditions[c]['rules'][f]
                                            }

                                        } else {
                                            localRules[f] = conditions[c]['rules'][f]
                                        }

                                        // we need to add it to fields list if not declared
                                        // if ( typeof(fields[f]) == 'undefined' ) {
                                        //     fields[f] = caseValue;
                                        // }
                                        if (
                                            typeof(fields[f]) == 'undefined'
                                            && typeof($fields[f]) != 'undefined'
                                            && typeof($fields[f].value) != 'undefined'
                                        ) {
                                            fields[f] = $fields[f].value;
                                            if (isGFFCtx && /(true|false)/i.test(fields[f] ) ) {
                                                if (fields[f] == "true")
                                                    fields[f]  = true;
                                                else if (fields[f] == "false")
                                                    fields[f]  = false;
                                            }

                                            d.addField(f, fields[f]);
                                            if ( typeof(allRules[f]) != 'undefined' ) {
                                                localRules[f] = merge(localRules[f], allRules[f])
                                            }
                                        }
                                    }
                                }



                                ++subLevelRules; // add sub level
                                if (isGFFCtx)
                                    forEachField($formOrElement, allFields, allRules, fields, $fields, localRules, cb, i);
                                else
                                    return forEachField($formOrElement, allFields, allRules, fields, $fields, localRules, cb, i);
                            }

                        }
                        --i;
                    }


                } // EO for
            }

            --subLevelRules;

            if (i <= 0 && subLevelRules < 0) {

                var errors = d['getErrors']();
                // adding data attribute to handle display refresh
                for (var field in errors) {
                    for (rule in errors[field]) {
                        if (!fieldErrorsAttributes[field]) {
                            fieldErrorsAttributes[field] = ''
                        }

                        if (fieldErrorsAttributes[field].indexOf(rule) < 0)
                            fieldErrorsAttributes[field] += rule +' ';
                    }

                    if (isGFFCtx)
                        $fields[field].setAttribute('data-gina-form-errors', fieldErrorsAttributes[field].substr(0, fieldErrorsAttributes[field].length-1))
                }

                //calling back
                try {
                    data = formatData( d['toData']() );

                    if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                        // update toolbar
                        if (!gina.forms.validated)
                            gina.forms.validated = {};

                        if (!gina.forms.validated[id])
                            gina.forms.validated[id] = {};

                        var objCallback = {
                            id          : id,
                            validated   : data
                        };

                        window.ginaToolbar.update('forms', objCallback);
                    }
                } catch (err) {
                    throw err
                }
                hasParsedAllRules = true;
                if (!hasBeenValidated && asyncCount <= 0) {
                    if ( typeof(cb) != 'undefined' && typeof(cb) === 'function' ) {
                        cb._errors = d['getErrors']();
                        cb._data = d['toData']();
                        triggerEvent(gina, $formOrElement, 'validated.' + id, cb);
                    } else {
                        hasBeenValidated = true;
                        return {
                            'isValid'   : d['isValid'],
                            'error'     : errors,
                            'data'      : data
                        }
                    }
                }
            }
        }


        if (isGFFCtx) {
            addListener(gina, $formOrElement, evt, function(event) {
                event.preventDefault();

                if (!hasBeenValidated) {
                    hasBeenValidated    = true;
                    hasParsedAllRules   = false;
                    asyncCount          = 0;

                    var _cb         = event.detail;
                    var _data       = _cb._data || d['toData']();
                    var cbErrors    = _cb._errors || d['getErrors']() || null;

                    console.debug('instance errors: ', instance.$forms[id].errors, ' VS cbErrors: ', cbErrors, d['isValid'](), ' VS d.getErrors(): ',d['getErrors']() );

                    if ( cbErrors.count() > 0 && d['isValid']()) {
                        d['isValid'] = function() {
                            return false;
                        }
                    }

                    _cb({
                        'isValid'   : d['isValid'],
                        'error'     : cbErrors,
                        'data'      : formatData( _data )
                    });
                    removeListener(gina, event.target, 'validated.' + event.target.id);
                    return
                }
            });
        }

        // 0 is the starting level
        if (isGFFCtx)
            forEachField($formOrElement, allFields, allRules, fields, $fields, rules, cb, 0);
        else
            return forEachField($formOrElement, allFields, allRules, fields, $fields, rules, cb, 0);
    }

    var setupInstanceProto = function() {

        instance.target                 = document;
        instance.setOptions             = setOptions;
        instance.getFormById            = getFormById;
        instance.validateFormById       = validateFormById;
        instance.resetErrorsDisplay     = resetErrorsDisplay;
        instance.resetFields            = resetFields;
        instance.handleErrorsDisplay    = handleErrorsDisplay;
        instance.send                   = send;
        //instance.handleXhrResponse      = handleXhrResponse;
    }

    if (isGFFCtx) {
        return init(rules)
    } else {
        return backendInit(rules, data, formId)
    }

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports  = ValidatorPlugin
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('gina/validator', ['utils/events', 'utils/dom', 'utils/effects', 'utils/data', 'lib/form-validator'], function(){ return ValidatorPlugin })
}