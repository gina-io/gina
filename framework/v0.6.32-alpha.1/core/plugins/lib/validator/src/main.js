/**
 * ValidatorPlugin
 *
 * Dependencies:
 *  - lib/form-validator
 *  - lib/merge
 *  - utils/events
 *  - utils/data
 *  - lib/uuid
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
 * @param {string} [ culture ] // #i18n — per-request culture (e.g. "fr_FR"). On the
 *      server (`!isGFFCtx`) form-body path it is threaded to FormValidator so built-in
 *      rule labels resolve from the bundle catalog's `_validator.<rule>` namespace.
 *      The routing-mode call (`new Validator('routing', _data, null, _rule)`) lands its
 *      inert rule object in this slot; the overlay's `typeof culture === 'string'` guard
 *      ignores non-strings, and route-matching runs before culture negotiation, so
 *      routing-requirement labels stay English by design.
 * */
function ValidatorPlugin(rules, data, formId, culture) {

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
        'uploadProgress', // #R8 — upload (client-to-server) wire progress for staged uploads
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

    var uuid            = (isGFFCtx) ? require('lib/uuid') : require('../../../../../lib/uuid');
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../../../lib/merge');
    var inherits        = (isGFFCtx) ? require('lib/inherits') : require('../../../../../lib/inherits');
    var FormValidator   = (isGFFCtx) ? require('lib/form-validator') : require('./form-validator');
    //var Collection      = (isGFFCtx) ? require('lib/collection') : require('../../../../../lib/collection');
    var routing         = (isGFFCtx) ? require('lib/routing') : require('../../../../../lib/routing');
    var loadingState    = (isGFFCtx) ? require('lib/loading-state') : require('../../../../../lib/loading-state');


    /** definitions */
    var instance    = {
        'id'                : 'validator-' + uuid(),

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
        'resetFields'       : null,
        'setErrorLabels'    : null,
        '_errorLabelsByCulture' : {}
    };

    // validator proto
    var $validator      = { // isGFFCtx only
        'id'                    : null, // form id

        'plugin'                : this.plugin,
        'on'                    : (isGFFCtx) ? on : null,
        'eventData'             : {},
        'target'                : (isGFFCtx) ? document : null, // by default
        'cachedErrors'          : {},
        'lastFocused'           : (isGFFCtx) ? [] : null,
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
    // #B175: no module-scope XHR anymore — send() creates a fresh LOCAL XHR
    // per submit (see send()). The shared instance was the stale-handler
    // replay vector: re-open()ing it fired the previous submit's handler.
    // was: var xhr         = null;
    var xhrOptions  = {
        'url'               : '',
        'method'            : 'GET',
        'isSynchrone'       : false,
        'withCredentials'   : false,
        'withRateLimit'     : true,
        'headers'           : {
            // to upload, use `multipart/form-data` for `enctype`
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
            'X-Requested-With': 'XMLHttpRequest' // in case of cross domain origin
        }
    };

    /**
     * #CSRF2 follow-up — read the gina-csrf-token cookie set by the Csrf plugin.
     *
     * Pure, dependency-free parser for `document.cookie`. Returns the token
     * value (URL-decoded) or null when the cookie is absent. Browser-only
     * (isGFFCtx); when running outside a browser document, returns null.
     *
     * Default cookie name is 'gina-csrf-token' matching the Csrf plugin
     * settings.json default. The matching X-Gina-CSRF-Token header is
     * injected on mutating methods (POST/PUT/PATCH/DELETE) before xhr.send().
     *
     * No eval / Function / regex on user-controlled segments — name and
     * value are compared as plain strings via indexOf + slice only.
     *
     * @returns {string|null}
     * */
    var readCsrfCookie = function () {
        var name = 'gina-csrf-token';
        if ( typeof(document) === 'undefined' || !document || typeof(document.cookie) !== 'string' ) {
            return null;
        }
        var raw = document.cookie || '';
        if (!raw) {
            return null;
        }
        var parts = raw.split(';');
        for (var i = 0, len = parts.length; i < len; ++i) {
            var part = parts[i];
            // strip leading whitespace without regex
            while (part.charAt(0) === ' ' || part.charAt(0) === '\t') {
                part = part.slice(1);
            }
            var eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            var key = part.slice(0, eq);
            if (key !== name) {
                continue;
            }
            var val = part.slice(eq + 1);
            try {
                return decodeURIComponent(val);
            } catch (e) {
                return val;
            }
        }
        return null;
    };

    /**
     * #CSRF2 follow-up — true for HTTP methods that mutate state.
     *
     * GET, HEAD, OPTIONS are CSRF-safe by spec (they MUST NOT carry side
     * effects). All other methods (POST, PUT, PATCH, DELETE, ...) require
     * the X-Gina-CSRF-Token header.
     *
     * @param {string} method
     * @returns {boolean}
     * */
    var isMutatingMethod = function (method) {
        if ( typeof(method) !== 'string' || !method ) {
            return false;
        }
        var m = method.toUpperCase();
        return (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS');
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
     * backendIsPlainObject — plain-data-object test for the #B241 alias walk.
     * Arrays, Date instances and null are LEAF VALUES on the server form-body
     * path (a rule addresses the array/date itself), never containers to
     * descend into.
     *
     * @inner
     * @private
     * @param {*} value
     * @returns {boolean} true for a non-null, non-array, non-Date object
     */
    var backendIsPlainObject = function (value) {
        return (
            value !== null
            && typeof(value) == 'object'
            && !Array.isArray(value)
            && !(value instanceof Date)
        )
    };

    /**
     * backendAliasAugment — #B241: synthesize dotted-canon field entries
     * ALONGSIDE the raw posted keys so the per-field rule lookup can join.
     *
     * `parseRules` canonicalizes every rule key to a dotted path (a bracket
     * key `a[b]` becomes `a.b`, a nested rule tree flattens to its dotted
     * leaves) while the fields map keeps the RAW posted keys — so a rule
     * authored on a bracket key, or as a nested tree, never joined on this
     * path and the field was skipped with no warn (fail-open, check AND
     * drop directives alike). Both production wire shapes were affected:
     * flat bracket keys (the client posts the engine's name-keyed data as
     * JSON, which the server parses verbatim) and nested objects (the
     * multipart and urlencoded parsers expand bracket names).
     *
     * The originals are deliberately KEPT in the map: dollar-token
     * substitution reads the raw keys, so cross-field references to
     * bracket-named peers keep resolving exactly as before, and an all-flat
     * payload synthesizes nothing (identity). An alias is only added when
     * its key is still free, so a caller that already posts the dotted form
     * keeps its own entry untouched.
     *
     * @inner
     * @private
     * @param {object} fields - the fields map to augment IN PLACE
     * @param {object} data - the raw posted payload (never mutated)
     * @returns {object} aliases - { count: number, map: { alias: meta } }
     *   where meta is { kind: 'bracket', original } or
     *   { kind: 'nested', rootKey, path }
     */
    var backendAliasAugment = function (fields, data) {
        var aliases = { count: 0, map: {} };
        var addNestedLeafAliases = function (rootKey, base, obj, pathSoFar) {
            for (var subKey in obj) {
                var aliasPath = pathSoFar.concat(subKey);
                var subAlias = base + '.' + subKey;
                if ( backendIsPlainObject(obj[subKey]) ) {
                    addNestedLeafAliases(rootKey, subAlias, obj[subKey], aliasPath);
                } else if ( typeof(fields[subAlias]) == 'undefined' ) {
                    fields[subAlias] = obj[subKey];
                    aliases.map[subAlias] = { kind: 'nested', rootKey: rootKey, path: aliasPath };
                    ++aliases.count;
                }
            }
        };
        var key = null, alias = null;
        for (key in data) {
            if ( /\[/.test(key) ) {
                alias = key.replace(/\[/g, '.').replace(/\]/g, '');
                if ( typeof(fields[alias]) == 'undefined' ) {
                    fields[alias] = data[key];
                    aliases.map[alias] = { kind: 'bracket', original: key };
                    ++aliases.count;
                }
            } else if ( backendIsPlainObject(data[key]) ) {
                addNestedLeafAliases(key, key, data[key], [key]);
            }
        }
        return aliases;
    };

    /**
     * backendAliasToBracketName — rebuild the client's DOM-name addressing
     * from a nested alias path (['account','username'] -> account[username]),
     * so restored error keys match what the browser side renders against.
     *
     * @inner
     * @private
     * @param {string} rootKey
     * @param {array} pathArr - path segments, rootKey first
     * @returns {string} the bracket-notation field name
     */
    var backendAliasToBracketName = function (rootKey, pathArr) {
        var out = rootKey;
        for (var i = 1, len = pathArr.length; i < len; ++i) {
            out += '[' + pathArr[i] + ']';
        }
        return out;
    };

    /**
     * backendRestoreAliases — #B241 egress: fold every alias outcome back
     * onto the original addressing, so the summary keeps today's contract.
     *
     * Error keys move to the DOM-name bracket form (the addressing the
     * client's error rendering looks up). On `.data` — which the engine has
     * already materialized (bracket originals arrive nested) — the alias
     * flat keys are stripped and their outcomes applied at the original
     * spot: an alias the engine dropped (an `exclude` directive) drops the
     * original leaf too, an alias a transform rewrote wins over the raw
     * value. Parents emptied BY AN EXCLUSION are pruned along that alias's
     * path only — an empty object the caller posted is not this function's
     * to remove.
     *
     * @inner
     * @private
     * @param {object} result - the { isValid, error, data } summary (mutated)
     * @param {object} aliases - backendAliasAugment's return value
     * @returns {object} result
     */
    var backendRestoreAliases = function (result, aliases) {
        var alias = null, meta = null;
        var errors = {};
        for (alias in (result.error || {})) {
            meta = aliases.map[alias];
            if ( !meta ) {
                errors[alias] = result.error[alias];
            } else if ( meta.kind == 'bracket' ) {
                errors[meta.original] = result.error[alias];
            } else {
                errors[backendAliasToBracketName(meta.rootKey, meta.path)] = result.error[alias];
            }
        }
        result.error = errors;

        var data = result.data;
        if ( !data || typeof(data) != 'object' ) {
            return result;
        }
        for (alias in aliases.map) {
            meta = aliases.map[alias];
            var aliasKept = Object.prototype.hasOwnProperty.call(data, alias);
            var aliasValue = aliasKept ? data[alias] : undefined;
            delete data[alias];

            var segments = ( meta.kind == 'bracket' )
                ? meta.original.replace(/\]/g, '').split(/\[/g)
                : meta.path;
            var sLen = segments.length - 1;
            var parent = data, s = 0;
            for (; s < sLen && parent; ++s) {
                parent = parent[ segments[s] ];
            }
            if ( !parent || typeof(parent) != 'object' ) {
                continue;
            }
            if ( !aliasKept ) {
                delete parent[ segments[sLen] ];
                // walk back up THIS path only, dropping parents the exclusion emptied
                for (var back = sLen - 1; back >= 0; --back) {
                    var holder = data, b = 0;
                    for (; b < back && holder; ++b) {
                        holder = holder[ segments[b] ];
                    }
                    if (
                        holder
                        && backendIsPlainObject(holder[ segments[back] ])
                        && Object.keys(holder[ segments[back] ]).length === 0
                    ) {
                        delete holder[ segments[back] ];
                    } else {
                        break;
                    }
                }
            } else {
                parent[ segments[sLen] ] = aliasValue;
            }
        }
        return result;
    };

    /**
     * Backend init — the server half of form-body validation.
     *
     * Builds the fields map from the posted payload, parses the rule set
     * into the dotted canon, and runs the engine. #B241: bracket-notation
     * and nested-authored rule keys join through synthesized dotted aliases
     * (see backendAliasAugment above); verdict keys and the data egress are
     * restored to the original addressing before returning. The no-rules
     * branch is untouched and keeps returning the payload verbatim.
     *
     * @inner
     * @private
     * @param {object} rules - the form's rule set (authored keys)
     * @param {object} data - the posted payload
     * @param {string} [formId]
     * @param {string} [culture]
     * @returns {object} the { isValid, error, data } summary, or a bare
     *   FormValidator instance on the no-rules branch
     */
    var backendInit = function (rules, data, formId, culture) {

        var $form = ( typeof(formId) != 'undefined' ) ? { 'id': formId } : null;
        var fields = {};

        for (var field in data) {
            fields[field] = data[field]
        }


        // parsing rules
        if ( typeof(rules) != 'undefined' && rules.count() > 0 ) {

            // #B241 — join bracket/nested rule keys through dotted aliases
            var backendAliases = backendAliasAugment(fields, data);

            try {
                parseRules(rules, '');
                rules = checkForRulesImports(rules);
            } catch (err) {
                throw err
            }

            backendProto.rules = instance.rules;

            var backendResult = validate($form, fields, null, instance.rules, null, culture);
            if (
                backendAliases.count > 0
                && backendResult
                && typeof(backendResult.isValid) == 'function'
                && typeof(backendResult.error) != 'undefined'
            ) {
                backendRestoreAliases(backendResult, backendAliases);
            }
            return backendResult;

        } else {
            // without rules - by hand
            return new FormValidator(fields, undefined, undefined, undefined, culture)
        }
    }


    /**
     * GFF definitions
     * */
    var setOptions = function (options) {
        options = merge(options, xhrOptions);
        xhrOptions = options;

        return this;
    }


    /**
     * getFormById
     *
     * @param {string} formId
     *
     * @returns {object} $form
     *
     * @throws {Error} When `formId` resolves via document.getElementById to a non-FORM
     *                 element. Same shape and root cause as validateFormById's @throws —
     *                 a sibling <p id="X"> / <div id="X"> shares the id with a later-
     *                 loaded <form id="X"> (popin / AJAX fragment).
     * */
    var getFormById = function(formId) {
        var $form = null, _id = formId;

        if ( !instance['$forms'] )
            throw new Error('`$forms` collection not found');

        if ( typeof(_id) == 'undefined') {
            throw new Error('[ FormValidator::getFormById(formId) ] `formId` is missing')
        }

        _id = _id.replace(/\#/, '');

        // in case form is created on the fly and is not yet registered
        var $candidate = document.getElementById(_id);
        if ($candidate != null && typeof (instance['$forms'][_id]) == 'undefined') {

            // Same fail-loud guard as validateFormById's else branch —
            // document.getElementById returns the first matching element regardless
            // of tag, so a sibling <p id="X"> / <div id="X"> / etc. wins over a
            // later-loaded <form id="X">. Surface the collision instead of letting
            // initForm register the non-FORM element in instance.$forms (polluting
            // subsequent lookups) and crash later inside bindForm with
            // `Cannot read properties of undefined (reading 'length')`.
            if ( !($candidate instanceof HTMLFormElement) ) {
                throw new Error(
                    '[ FormValidator::getFormById(formId) ] `' + _id + '` resolves to <'
                    + $candidate.tagName + '>, not a FORM. A non-FORM element shares the same id as '
                    + 'the target form — rename one of them so the id is unique.'
                );
            }

            initForm( $candidate );
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
     *
     * @throws {Error} When `formId` resolves via document.getElementById to a non-FORM
     *                 element (e.g. a sibling <p id="X"> / <div id="X"> sharing the id
     *                 with a later-loaded <form id="X">). Surfaces the collision instead
     *                 of crashing later inside bindForm with a cryptic
     *                 `Cannot read properties of undefined (reading 'length')`.
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
            _id = $target.getAttribute('id') || 'form.'+uuid();

            $target.setAttribute('id', _id);// just in case

        } else {
            throw new Error('[ FormValidator::validateFormById(formId[, customRule]) ] `formId` should be a `string`');
        }

        checkForDuplicateForm(_id);

        if ( typeof(this.$forms) != 'undefined' && typeof(instance['$forms'][_id]) != 'undefined' ) {
            $form   = this.$forms[_id] = instance['$forms'][_id];
        } else { // binding a form out of context (outside of the main instance)
            $target             = document.getElementById(_id);

            // validateFormById was designed for FORM elements. getElementById
            // returns the first matching element regardless of tag, so a sibling
            // <p id="X"> / <div id="X"> / etc. wins over a later-loaded
            // <form id="X">. Surface the collision instead of crashing later
            // inside bindForm with a cryptic
            // `Cannot read properties of undefined (reading 'length')`.
            if ( $target && !($target instanceof HTMLFormElement) ) {
                throw new Error(
                    '[ FormValidator::validateFormById(formId) ] `' + _id + '` resolves to <'
                    + $target.tagName + '>, not a FORM. A non-FORM element shares the same id as '
                    + 'the target form — rename one of them so the id is unique.'
                );
            }

            $validator.id           = _id;
            $validator.target       = $target;

            $form = this.$forms[_id] = instance.$forms[_id] = merge({}, $validator);

            var rule    = null;
            if ( typeof(customRule) == 'undefined') {
                // #B128 — attribute-first: an injected form carrying `data-gina-form-rule`
                // (the popin bind path calls validateFormById with no customRule) must
                // resolve by the attribute's dotted name — the id-derived name stays the
                // fallback for attribute-less forms whose id names the rule. The old shape
                // read the attribute only when `rules` was undefined — unreachable on a
                // rules-bearing page (and its inner `rules` recheck was false by
                // construction, so that branch could only ever throw): the id-derived
                // lookup missed, bindForm re-resolved by id, `$form.rules` bound `{}`,
                // and the live-check gate stamped the form
                // `data-gina-form-live-check-enabled="false"` while the submit handler
                // independently re-read the attribute and succeeded.
                // was: rule = _id.replace(/\-/g, '.'); then the attribute behind an
                // unreachable `else if` ending in a dead throw.
                if ( typeof($form.target) != 'undefined' && $form.target !== null && $form.target.getAttribute('data-gina-form-rule') ) {
                    rule = $form.target.getAttribute('data-gina-form-rule').replace(/\-|\//g, '.');
                } else {
                    rule = _id.replace(/\-/g, '.');
                }

                if ( typeof(rules) != 'undefined' ) {
                    $form['rule'] = customRule = getRuleObjByName(rule)
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

    /**
     * #B319 — one-shot exemption raised while the framework moves focus to the
     * first invalid field to DELIVER a refused submit's answer (the #B246/#B308
     * display-only reveal, and the `validate.<id>` failure branch). `.focus()`
     * dispatches `focusin` synchronously, so without this flag that dispatch
     * re-enters the live-check listener whose `refreshWarning` call sees the
     * field is by then the active element and hides the very message the answer
     * just rendered (#B312: the message IS the answer). The focusin arm skips
     * the downgrade while the flag is up; both focus sites clear it on every
     * exit, so the user's next interaction — typing, refocusing — re-engages
     * the deliberate mid-typing suppression untouched.
     *
     * @private
     * @type {boolean}
     */
    var isAnswerFocusInProgress = false;

    /**
     * #B387 — the asynchronous continuation of the #B319 exemption above.
     *
     * The answer's own focus move makes the answered field the active element,
     * and BOTH display refreshers read "active element" as "the user is editing
     * this field" and soften/hide the committed message:
     *   - `refreshWarning`'s error->warning downgrade appends `hidden`;
     *   - `handleErrorsDisplay`'s refresh branch re-creates the message born-hidden.
     * The one-shot flag above only covers the SYNCHRONOUS focusin dispatched
     * inside `.focus()`; a validation completion firing LATER in the same
     * cascade (a live-check waiter woken by the reveal pass's deferred release,
     * or the trailing silent global re-validation) runs after the `finally`
     * cleared it — and re-hid the very message the answer had just rendered.
     *
     * This slot records WHICH field currently holds an answer-placed focus, so
     * the two hide sites can tell answer-placed focus from user-placed focus,
     * for ANY caller, however late. A single slot is exact: only one active
     * element exists. Released on the first genuine user interaction (any
     * trusted native event reaching a form proxy while the one-shot flag is
     * down), so the deliberate mid-typing suppression re-engages the moment
     * the user actually edits.
     *
     * @private
     * @type {object|null} `{ formId, elName }` while an answer-placed focus is live, else `null`
     */
    var answerFocusHold = null;

    /**
     * #B387 — does `answerFocusHold` name this exact field?
     *
     * @private
     * @param {string} formId - owning form id
     * @param {string} elName - field name
     * @returns {boolean} true while the answer-placed focus is live on this field
     */
    var isAnswerFocusHeldFor = function(formId, elName) {
        return ( answerFocusHold
            && answerFocusHold.formId === formId
            && answerFocusHold.elName === elName ) ? true : false;
    };

    /**
     * #B387 — release the hold on the first genuine user interaction.
     *
     * Trusted-only: framework-internal `triggerEvent` dispatches are untrusted
     * CustomEvents and must not release it. The `isAnswerFocusInProgress`
     * guard keeps the answer's OWN synchronous focusin (trusted — the UA
     * generates it inside `.focus()`) from releasing the hold it is part of
     * delivering.
     *
     * @private
     * @param {object} event - the native event reaching a form proxy handler
     * @returns {void}
     */
    var releaseAnswerFocusHold = function(event) {
        if ( !answerFocusHold ) {
            return;
        }
        if ( event && event.isTrusted && !isAnswerFocusInProgress ) {
            answerFocusHold = null;
        }
    };

    var refreshWarning = function($el) {
        var formId = $el.form.id || $el.form.getAttribute('id');
        var elName = $el.name || $el.form.getAttribute('name');
        var currentElName = document.activeElement.name;
        if ( /^true$/i.test(instance.$forms[formId].isValidating) ) {
            return;
        }

        var $parent                 = $el.parentNode
            , isErrorMessageHidden  = false
            ,  $children            = $parent.getElementsByTagName('div')
        ;

        if ( /form\-item\-warning/.test($parent.className) && currentElName != elName ) {
            $parent.className = $parent.className.replace(/form\-item\-warning/, 'form-item-error');

        }
        // #B387 — `currentElName == elName` reads "the user is editing this
        // field", but the ANSWER's own focus move (#B319) also makes the field
        // the active element — and unlike the synchronous focusin, the async
        // completion callers arrive after the one-shot flag is already down.
        // While the answer-focus hold names this field the focus is
        // answer-placed, not user-placed: keep the message the answer just
        // rendered.
        // was: else if (/form\-item\-error/.test($parent.className) && currentElName == elName ) {
        else if (
            /form\-item\-error/.test($parent.className) && currentElName == elName
            && !isAnswerFocusHeldFor(formId, elName)
        ) {
            $parent.className = $parent.className.replace(/form\-item\-error/, 'form-item-warning');
            isErrorMessageHidden = true;
        }

        // Fixed on 2025-03-16
        if (
            /^true$/i.test(instance.$forms[formId].isValidating)
            && !isErrorMessageHidden
        ) {
            return;
        }


        for (var c = 0, cLen = $children.length; c<cLen; ++c) {
            if ( /form\-item\-error\-message/.test($children[c].className) ) {
                if (isErrorMessageHidden) {
                    // hide error messages
                    $children[c].className = $children[c].className +' hidden';
                    // #A11Y5 — this hide fires when the field regains focus, and it does not
                    // touch aria-invalid: a committed error stays asserted while its message
                    // would otherwise leave the a11y tree. Clip it instead.
                    clipErrorMessage($children[c]);
                } else {
                    // display error messages
                    $children[c].className = $children[c].className.replace(/(\s+hidden|hidden)/, '');
                    revealErrorMessage($children[c]);
                }
                break
            }
        }
    }

    /**
     * #A11Y2 — create (or recover) a form's visually-hidden polite status region WITHOUT
     * writing to it. Split out of announceA11yError so the region can exist LONG before the
     * first error: a region that is inserted and populated in the same tick reaches assistive
     * tech as a single mutation batch, which is commonly never spoken, so the very first
     * announcement per form — the one that matters most — was the one most likely lost.
     * bindForm calls this at bind time, which is what makes that first error audible.
     *
     * The region is a CHILD OF THE FORM deliberately. A popin renders its form inside a native
     * `<dialog>` opened with showModal(), which leaves everything outside the top layer inert;
     * a body-level region would sit in that inert subtree and go unspoken for exactly the forms
     * that live in popins. Keeping it inside the form keeps it inside the dialog. The price is
     * that a subtree replacement (a popin re-render's `innerHTML =`, or a nav fragment swap)
     * destroys it — hence create-OR-RECOVER, and hence the deferred first write in
     * announceA11yError, which is what stops a recovery from silently repeating the defect.
     *
     * The bookkeeping flag lives on the element rather than in a module-scope map so it dies
     * WITH the region: a destroyed region leaves no stale entry behind, and no form id keeps
     * an unbounded map alive. Browser-only, like readCsrfCookie — this engine is shared with
     * the server form-body path, which has no document.
     *
     * @inner
     * @param {object} $form - the HTMLFormElement the region belongs to
     * @returns {object|null} the live-region element, or null outside a browser document
     * @example
     * // at bind time: the region is in the a11y tree before any error can occur
     * ensureA11yLiveRegion($form.target);
     */
    var ensureA11yLiveRegion = function($form) {
        if ( !$form ) return null;
        if ( typeof(document) === 'undefined' || !document || typeof(document.getElementById) !== 'function' ) {
            return null;
        }
        var _fid    = ( typeof($form.id) != 'undefined' && $form.id ) ? $form.id : ( $form.getAttribute('id') || 'form' );
        var _liveId = 'gina-aria-live-' + _fid;
        var _live   = document.getElementById(_liveId);
        if ( !_live ) {
            _live = document.createElement('div');
            _live.id = _liveId;
            _live.setAttribute('role', 'status');
            _live.setAttribute('aria-live', 'polite');
            _live.setAttribute('aria-atomic', 'true');
            _live.className = 'gina-visually-hidden';
            _live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
            _live.ginaA11yFresh = true;
            $form.appendChild(_live);
        } else if ( _live.parentNode !== $form ) {
            // Same id, different form node — a re-render replaced the form, or two forms share
            // an id. Re-home it so the region always sits inside the form that announces, which
            // is the property the inert reasoning above depends on; a move is a fresh insertion.
            _live.ginaA11yFresh = true;
            $form.appendChild(_live);
        }
        return _live;
    };

    /**
     * #A11Y1 (slice 4) — announce a blur-time committed error through the region created at
     * bind time. A CSS :user-invalid display toggle is not reliably announced by screen
     * readers, and on blur the field has lost focus so its own aria-invalid /
     * aria-errormessage are not re-read; the polite region decouples the announcement
     * from visual display. Submit-time errors use focus (see onValidate), not this region.
     *
     * #A11Y2 — when the region had to be created (or re-homed) HERE rather than at bind time,
     * the insertion and this write would land in the same tick and likely never be spoken, so
     * that first write is deferred by one macrotask. Only the fresh case defers; an already
     * bound region writes synchronously, exactly as before. While a deferred write is pending
     * a later call replaces the pending text, so the LATEST error wins and a stale first
     * message can never land on top of it. The timer re-enters this function, which then takes
     * the synchronous branch — keeping exactly ONE textContent write site.
     *
     * @param {object} $form - the HTMLFormElement the region belongs to
     * @param {string} text - the error text to announce
     * @returns {object|null} the live-region element, or null when nothing was announced
     * @example
     * announceA11yError($form, 'This field is required');
     */
    var announceA11yError = function($form, text) {
        if ( !$form || !text ) return null;
        var _live = ensureA11yLiveRegion($form);
        if ( !_live ) return null;
        if ( _live.ginaA11yFresh ) {
            _live.ginaA11yPending = text;
            if ( !_live.ginaA11yTimer ) {
                _live.ginaA11yTimer = setTimeout(function() {
                    _live.ginaA11yTimer = null;
                    _live.ginaA11yFresh = false;
                    announceA11yError($form, _live.ginaA11yPending);
                }, 0);
            }
            return _live;
        }
        text = a11yDistinctText(_live, text);
        _live.textContent = text;
        return _live;
    };

    /**
     * #B178 — announcement text for a field's error container.
     * The container renders one `<p>` per rule message; visually they stack as
     * blocks, but `textContent` concatenates them with NO separator, so an
     * aria-live announcement read multiple messages as one run-on string.
     * Joins the per-message texts with '. ' instead; falls back to the raw
     * `textContent` when the container has no `<p>` children.
     * @inner
     * @param {object} $err - the error-message container element
     * @returns {string} announcement text
     */
    var getA11yAnnounceText = function($err) {
        var $msgs = $err.getElementsByTagName('p');
        if ( !$msgs.length ) {
            return $err.textContent;
        }
        var parts = [];
        for (var m = 0, mLen = $msgs.length; m < mLen; ++m) {
            parts.push($msgs[m].textContent);
        }
        return parts.join('. ');
    };

    /**
     * A11Y_LABELS — English defaults for gina's own accessibility status strings.
     *
     * Deliberately separate from `setErrorLabels`, which owns per-culture overrides
     * for *rule* error labels and is keyed by rule name. These are framework-authored
     * announcements about what gina is doing, so they need a home of their own.
     *
     * `%s` in a value is replaced with a runtime detail (currently the file name);
     * it follows the same placeholder convention the rule error labels already use,
     * so a translation keeps control of where the detail lands in the sentence.
     *
     * @constant {object}
     * @inner
     */
    var A11Y_LABELS = {
        submitting      : 'Submitting…',
        // #A11Y7/U2 — staged uploads announce only their TRANSITIONS (start and
        // success), never per-tick progress: `aria-live="polite"` coalesces but does
        // not throttle, and one announcement per onprogress event would bury every
        // other message on the page. There is deliberately NO `uploadError` key —
        // the error path announces the server's own message instead (#A11Y7/U3), and
        // a generic second write in the same beat would clobber it (see the rationale
        // on `releaseSubmitA11y`).
        uploadStarted   : 'Upload started',
        uploadComplete  : 'Upload complete',
        // #A11Y7/U5 — spoken when a staged file's reset/delete control removes it.
        fileRemoved     : '%s removed'
    };

    /**
     * a11yLabel — resolve one accessibility status string.
     *
     * Follows the same philosophy `setErrorLabels` documents: an English default
     * ships inline and fills anything the project does not translate. A project
     * overrides by assigning `gina.config.a11y`, typically once at boot keyed off
     * the negotiated culture.
     *
     * @param   {string} key - Label key, e.g. `submitting`.
     * @returns {string} the project's override when it supplies a non-empty string,
     *                   otherwise the English default (empty string for unknown keys).
     *
     * @example
     * // project side, once at boot:
     * gina.config.a11y = { submitting: 'Envoi…' };
     *
     * @inner
     */
    var a11yLabel = function(key) {
        var _over = ( typeof(gina) != 'undefined' && gina && gina.config && gina.config.a11y )
            ? gina.config.a11y
            : null;
        if ( _over && typeof(_over[key]) == 'string' && _over[key] ) {
            return _over[key];
        }
        return A11Y_LABELS[key] || '';
    };

    /**
     * announceA11yStatus — announce a non-error status through the form's region.
     *
     * The region #A11Y2 stands up at bind time is `role="status" aria-live="polite"`,
     * i.e. already a status channel rather than an error-only one — so submit progress
     * rides that same element instead of a second region competing with it. Kept as a
     * named delegate purely so call sites read as status, not as errors.
     *
     * @param   {object} $form - form target (HTMLFormElement), not the form instance.
     * @param   {string} text  - resolved, human-readable status text.
     * @returns {object|null} the live region, or null when it could not be resolved.
     *
     * @example
     * announceA11yStatus($myForm, 'Envoi…');
     *
     * @inner
     */
    var announceA11yStatus = function($form, text) {
        return announceA11yError($form, text);
    };

    /**
     * a11yDistinctText — make a repeated announcement observably new.
     *
     * An `aria-live="polite"` region is announced when its content CHANGES, so re-writing
     * byte-identical text is commonly not spoken at all. That is the normal case for a
     * validation message: blurring a field that still fails the same rule produces exactly
     * the same string, and the user heard nothing the second time. Appending a no-break
     * space makes the node's content differ while leaving what is read out unchanged, and
     * it self-cancels — the next identical announcement compares against the suffixed text,
     * differs, and writes the clean string again.
     *
     * Lives outside `announceA11yError` deliberately: that function sits inside a fixed
     * character window asserted by a source pin, and the rationale above does not fit in it.
     *
     * ⚠️ Unverified: that a screen reader actually re-announces as a result. The string
     * demonstrably changes; no assistive-technology pass has been run to confirm the effect.
     *
     * @param   {object} $live - the live region node.
     * @param   {string} text  - the announcement about to be written.
     * @returns {string} `text`, suffixed only when it would otherwise be a no-op write.
     *
     * @example
     * var next = a11yDistinctText($region, 'This field is required');
     *
     * @inner
     */
    var a11yDistinctText = function($live, text) {
        if ( !$live || typeof(text) != 'string' ) {
            return text;
        }
        return ( $live.textContent === text ) ? text + ' ' : text;
    };

    /**
     * ERR_MSG_CLIP — inline declarations that hide an element from VIEW while leaving it
     * in the accessibility tree.
     *
     * `display` carries `!important` because gina's own `.hidden` helper is
     * `display: none !important`, and an inline `!important` is what outranks it (measured:
     * a plain inline `display:block` loses to it). The class is deliberately left in place
     * so consumer CSS keyed on `.hidden` keeps matching.
     *
     * @constant {string}
     * @inner
     */
    var ERR_MSG_CLIP = 'display:block !important;position:absolute;width:1px;height:1px;'
        + 'margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';

    /**
     * clipErrorMessage — hide a validation message visually, but keep it reachable.
     *
     * `.hidden` is `display: none !important`, which removes the node from the
     * accessibility tree outright. That is the wrong tool wherever `aria-invalid="true"`
     * stays asserted on the field, because the `aria-errormessage` association then points
     * assistive tech at a target it cannot resolve — the field is announced invalid with no
     * retrievable reason. Both hide paths that can coexist with an asserted `aria-invalid`
     * (the focus-driven hide in `refreshWarning`, and the refresh re-create) clip instead.
     *
     * gina creates and owns this element, so replacing `style.cssText` wholesale is safe.
     *
     * @param   {object} $err - the `form-item-error-message` element.
     * @returns {boolean} true when the clip was applied.
     *
     * @example
     * clipErrorMessage($someMessageDiv);
     *
     * @inner
     */
    var clipErrorMessage = function($err) {
        if ( !$err || typeof($err.style) == 'undefined' || !$err.style ) {
            return false;
        }
        $err.style.cssText = ERR_MSG_CLIP;
        return true;
    };

    /**
     * revealErrorMessage — undo `clipErrorMessage`, restoring normal visual flow.
     *
     * @param   {object} $err - the `form-item-error-message` element.
     * @returns {boolean} true when the clip was cleared.
     *
     * @example
     * revealErrorMessage($someMessageDiv);
     *
     * @inner
     */
    var revealErrorMessage = function($err) {
        if ( !$err || typeof($err.style) == 'undefined' || !$err.style ) {
            return false;
        }
        $err.style.cssText = '';
        return true;
    };

    /**
     * hasPaintableTwin — does another control of the same name exist that CAN receive
     * the error paint? (#B510)
     *
     * A BARE hidden control (`type=hidden`, not sitting in a `form-item-wrapper`) can never
     * receive the error-message node nor the `aria-invalid` state: every paint gate in
     * `handleErrorsDisplay` skips it. When the same name is also carried by a control that
     * can be painted — the recommended shape for a control that must render disabled yet
     * still post, i.e. a visible control plus a hidden twin with rule `"exclude": false` —
     * the bare hidden one must not consume the error, or the visible twin is never reached.
     * A bare hidden twin does not count as paintable; a wrapped hidden one does (its message
     * is inserted after the wrapper).
     *
     * @param {object} $form - the HTMLFormElement being walked
     * @param {object} $el - the bare hidden control under consideration
     * @returns {boolean} true when at least one other same-named control can be painted
     *
     * @inner
     */
    var hasPaintableTwin = function($form, $el) {
        var name = $el.name;
        if (!name) return false;
        for (var t = 0, tLen = $form.length; t<tLen; ++t) {
            var $other = $form[t];
            if ( $other === $el || $other.name != name ) continue;
            // a bare hidden twin cannot be painted either
            if ( $other.type == 'hidden' && !/form\-item\-wrapper$/.test($other.parentNode.className) ) continue;
            return true;
        }
        return false;
    };

    /**
     * handleErrorsDisplay
     * Attention: if you are going to handle errors display by hand, set data to `null` to prevent Toolbar refresh with empty data
     *
     * #A11Y1 — besides toggling `form-item-error` / `form-item-warning` and the error-message div,
     * this reflects each managed field's committed validity into `aria-invalid` ("true" on a
     * committed error, "false" when valid — mirroring the native ValidityState where the field has
     * native HTML constraints so it agrees with `:user-invalid`). Soft live-check warnings are not asserted.
     *
     * #B510 — a bare hidden control (no `form-item-wrapper`) is not a paint target when another
     * control of the same name can be painted; see `hasPaintableTwin`.
     * @param {object} $form - Target (HTMLFormElement)
     * @param {object} errors
     * @param {object|null} data
     * @param {string|null} [fieldName] - restricts the pass to one field (the per-field / live-check path)
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
                if (errors && errors.count() > 0) {
                    // reset field name
                    liveCheckErrors[formId][fieldName] = {};
                    // override
                    liveCheckErrors[formId][fieldName] = merge(errors[fieldName], liveCheckErrors[formId][fieldName]);
                    if (liveCheckErrors[formId][fieldName].count() == 0) {
                        delete liveCheckErrors[formId][fieldName]
                    }
                    errors = liveCheckErrors[formId];
                    // only if the form has not been sent yet
                    if (
                        !instance.$forms[formId].sent
                        ||
                        instance.$forms[formId].isValidating
                    ) {
                        isWarning = true;
                        // Fixed on 2025-03-16
                        var lastFocused = instance.$forms[formId].lastFocused;
                        // console.debug('fieldName: '+ fieldName + '\nactiveElement: '+ document.activeElement.getAttribute('name') +'\nlastFocused: ', lastFocused);
                        if (
                            lastFocused.length > 0
                                && typeof(lastFocused[1]) != 'undefined'
                                && lastFocused[1].name == fieldName
                            ||
                            lastFocused.length > 0
                                && !lastFocused[1]
                                && document.activeElement.getAttribute('name') != lastFocused[0].name
                            ||
                            document.activeElement.getAttribute('name') != fieldName
                        ) {
                            isWarning = false;
                        }
                        // console.debug('isWarning: '+isWarning);
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

            // #B510 — a BARE hidden control (no form-item-wrapper) can never receive the
            // message node nor the aria state below (every paint gate skips `type=hidden`),
            // yet it used to consume the error: it took the box's error class and, on the
            // per-field path, the name-match exit at the end of this loop stopped the walk
            // on it — so a visible twin listed AFTER it (the disabled-control + hidden-twin
            // pattern) was never painted, and on a shared box the pre-marked class blocked
            // the twin's first-error branch too. Skip it when a paintable same-named control
            // exists; a LONE bare hidden keeps the former behaviour (box class, no message).
            if ( $target === $el && $el.type == 'hidden' && hasPaintableTwin($form, $el) ) {
                continue;
            }

            // #A11Y1 (slice 2) — detect a consumer-provided aria-errormessage association. When
            // present, the field already references its own error element, so we must NOT inject a
            // competing form-item-error-message div (aria-invalid alone exposes it). Any wire we add
            // ourselves is marked (data-gina-aria-errormessage) so it is not mistaken for a consumer's.
            var _ariaErrId         = $el.getAttribute('aria-errormessage');
            var _ginaOwnsErrMsg    = ( typeof($el.dataset) != 'undefined' && typeof($el.dataset.ginaAriaErrormessage) != 'undefined' ) ? true : false;
            var _hasConsumerErrMsg = ( _ariaErrId && !_ginaOwnsErrMsg ) ? true : false;

            if (
                errors
                && typeof(errors[name]) != 'undefined'
                && !/(form\-item\-error|form\-item\-warning)/.test($parent.className)
            ) {

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

                // #A11Y1 — reflect a committed invalid state into aria-invalid so any
                // aria-errormessage association on the field is exposed to assistive tech.
                // Soft (live-check) warnings while the field is still being edited are not
                // asserted — only committed errors (blur/submit) are.
                if ( !isWarning && $el.type != 'hidden' ) {
                    $el.setAttribute('aria-invalid', 'true');
                }

                // injecting error messages
                // #B178 — two rules can carry byte-identical message text (e.g. a
                // coercion paired with its validator); render each distinct text once.
                // Dev bookkeeping below still records every key.
                var _renderedMsgs = {};
                for (var e in errors[name]) {

                    if (e != 'stack' && typeof(_renderedMsgs[ errors[name][e] ]) == 'undefined') { // ignore stack for display
                        _renderedMsgs[ errors[name][e] ] = true;
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

                // #A11Y1 (slice 2) — skip the injected message div when the field already references
                // a consumer-provided error element; otherwise inject it and wire aria-errormessage
                // to it so assistive tech can resolve the message text.
                if ($target.type != 'hidden' && !_hasConsumerErrMsg) {
                    if ( !$el.getAttribute('aria-errormessage') || _ginaOwnsErrMsg ) {
                        $err.id = ('gina-errormessage-' + (id || 'form') + '-' + (name || 'field')).replace(/[^a-zA-Z0-9_-]+/g, '-');
                        $el.setAttribute('aria-errormessage', $err.id);
                        if ( typeof($el.dataset) != 'undefined' ) {
                            $el.dataset.ginaAriaErrormessage = 'true';
                        }
                    }
                    insertAfter($target, $err);
                }

                // #A11Y1 (slice 4) — announce a blur-time committed error through the form's polite
                // live region (submit-time errors use focus instead). Only on the per-field/blur path
                // (fieldName set) and only once focus has left the field; soft warnings are skipped.
                if (
                    !isWarning
                    && typeof(fieldName) != 'undefined'
                    && $err
                    && $el !== document.activeElement
                ) {
                    announceA11yError($form, getA11yAnnounceText($err));
                }

            } else if (
                errors
                    && typeof(errors[name]) == 'undefined'
                    && /(form\-item\-error|form\-item\-warning)/.test($parent.className)
                ||
                errors
                    && typeof(errors[name]) != 'undefined' && errors[name].count() == 0
                    && /(form\-item\-error|form\-item\-warning)/.test($parent.className)
            ) {
                // Fixed on 2025-03-10
                // targeted field must be the active element
                // if (
                //     document.activeElement.getAttribute('name') != fieldName
                //     && errors.count() > 0
                // ) {
                //     break
                // }
                console.debug('[handleErrorsDisplay] Resetting when not in error');
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

                // #A11Y1 — field is valid per Gina; mirror the native ValidityState (where the
                // field has native HTML constraints) so aria-invalid never disagrees with the
                // :user-invalid styling already shown. Explicit "false" is a touched-and-valid signal.
                if ( $el.type != 'hidden' ) {
                    var _a11yNativeInvalid = ( $el.willValidate && $el.validity && !$el.validity.valid ) ? true : false;
                    $el.setAttribute('aria-invalid', _a11yNativeInvalid ? 'true' : 'false');
                }

                // #A11Y1 (slice 2) — the referenced div was just removed; drop the aria-errormessage
                // wire we own (a consumer-provided association, lacking our marker, is left intact).
                if ( typeof($el.dataset) != 'undefined' && typeof($el.dataset.ginaAriaErrormessage) != 'undefined' ) {
                    $el.removeAttribute('aria-errormessage');
                    delete $el.dataset.ginaAriaErrormessage;
                }

            } else if (
                errors.count() > 0
                && typeof(errors[name]) != 'undefined'
                && errAttr
            ) {
                // refreshing already displayed error on msg update
                var $divs = $parent.getElementsByTagName('div');
                for (var d = 0, dLen = $divs.length; d<dLen; ++d) {
                    // Fixed on 2025-03-05: className can have more than one !!
                    let foundMessage = $divs[d].className.match("form-item-error-message");
                    if (
                        foundMessage
                        && typeof(foundMessage.length) != 'undefined'
                        && foundMessage.length > 0
                    ) {

                        $divs[d].parentElement.removeChild($divs[d]);
                        $err = document.createElement('div');
                        // #livecheck — a field being typed in (the active element) surfaces only the
                        // soft form-item-warning border; its committed error message stays hidden until
                        // blur. This "refresh" re-create runs AFTER refreshWarning in the live-check
                        // global pass, so without this focus guard it re-shows the message mid-typing.
                        // On blur (field no longer active) the message is created shown (focusout commits).
                        // #B387 — same provenance refinement as refreshWarning's downgrade:
                        // an answer-placed focus (#B319) must not read as "being typed in",
                        // or this re-create clips the very message the answer delivered.
                        // was: ( document.activeElement && document.activeElement.name == name ) ?
                        $err.setAttribute('class', ( document.activeElement && document.activeElement.name == name && !isAnswerFocusHeldFor(id, name) ) ? 'form-item-error-message hidden' : 'form-item-error-message');
                        // #A11Y5 — the branch below re-asserts aria-invalid="true" on this same
                        // field, so when the message is hidden it must stay resolvable: clip it
                        // out of view rather than out of the accessibility tree. Reads the class
                        // just written instead of re-deriving the condition, so the ternary above
                        // stays exactly as pinned.
                        if ( /hidden/.test($err.className) ) {
                            clipErrorMessage($err);
                        }

                        // #A11Y1 (slice 2) — preserve the aria-errormessage wire we own across refresh.
                        if ( _ginaOwnsErrMsg && _ariaErrId ) {
                            $err.id = _ariaErrId;
                        }

                        // Fixed on 2025-03-09: className cleanup
                        if (
                            !isWarning
                            && /(\s+form\-item\-warning|form\-item\-warning)/.test($parent.className)
                        ) {
                            $parent.className = $parent.className.replace(/(\s+form\-item\-warning|form\-item\-warning)/, ' form-item-error');
                        }

                        // injecting error messages
                        // {
                        //     field: {
                        //         rule: errorMsg
                        //     }
                        // }
                        // #B178 — distinct-text dedup, parity with the first-error branch
                        var _renderedMsgs = {};
                        for (var e in errors[name]) {
                            if (e != 'stack' && typeof(_renderedMsgs[ errors[name][e] ]) == 'undefined') { // ignore stack for display (parity with the first-error branch, #B89)
                                _renderedMsgs[ errors[name][e] ] = true;
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

                        break;
                    }
                }

                if ($err && $target.type != 'hidden' && !_hasConsumerErrMsg) {
                    insertAfter($target, $err);
                }

                // #A11Y1 — the committed error persists on refresh; keep aria-invalid asserted.
                if ( !isWarning && $el.type != 'hidden' ) {
                    $el.setAttribute('aria-invalid', 'true');
                }

                // #B89 — re-announce the REFRESHED message through the live region. The
                // first-error branch announces, but this refresh branch rebuilt $err with a
                // NEW message (the value now fails a different rule, or a late setErrorLabels
                // overlay changed the label) and, without this, assistive tech kept announcing
                // the first message. Same guard as the first-error announce: committed (not
                // soft-warning) errors, per-field/blur path, once focus has left the field.
                // aria-live=polite + textContent-replace re-announces because the string changed.
                if (
                    !isWarning
                    && typeof(fieldName) != 'undefined'
                    && $err
                    && $el !== document.activeElement
                ) {
                    announceA11yError($form, getA11yAnnounceText($err));
                }
            }

            if (
                typeof(fieldName) != 'undefined'
                && fieldName === $el.name
            ) {
                break;
            }
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
            $form.isBeingReseted = true;
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
            delete $form.isBeingReseted;
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
     * nestBracketNotationKey — expand a single bracket-notation field name into a
     * nested object/array tree, in place. Byte-faithful port of the data helper's
     * `parseLocalObj` (`helpers/data/src/main.js`) so the programmatic `send(FormData)`
     * path nests exactly like the declarative `formatDataFromString` path (#B92).
     *
     * Values are placed VERBATIM — no url-decode, no `"true"`/`"false"`/`"null"`
     * coercion — because the non-binary body is posted as `application/json` and the
     * server keeps JSON keys/values as sent (#B28). A numeric next segment makes the
     * current level an array.
     *
     * @inner
     * @param {(object|Array)} obj - accumulator, mutated in place (may be replaced when the head segment is numeric — assign the return value)
     * @param {Array<string>} key - the split key path, e.g. `item[0][id]` -> `['item','0','id']`
     * @param {number} k - current recursion depth into `key`
     * @param {*} value - the field value to assign at the leaf
     * @returns {(object|Array)} the (possibly replaced) accumulator
     *
     * @example
     * // 'item[0][id]' -> ['item','0','id']
     * nestBracketNotationKey({}, ['item','0','id'], 0, 'x'); // { item: [ { id: 'x' } ] }
     */
    var nestBracketNotationKey = function(obj, key, k, value) {

        // #B446 — client-side twin of the server guard in helpers/data. Field names come
        // from the form / FormData, so a segment named `__proto__`, `constructor` or
        // `prototype` would assign through to Object.prototype for the whole page. Drop
        // the path rather than throwing: these names are never legitimate field names, and
        // a throw here would break submission of the entire form.
        for (let _s = 0, _sLen = key.length; _s < _sLen; ++_s) {
            if ( key[_s] === '__proto__' || key[_s] === 'constructor' || key[_s] === 'prototype' ) {
                return obj;
            }
        }

        for (let i = 0, len = key.length; i < len; i++) {
            // by default
            let _key = key[k];
            if (i == k) {
                // Array or Object ?
                if ( typeof(obj[ key[k] ]) == 'undefined' || typeof(obj[ key[k] ]) == 'string' ) {
                    if ( Array.isArray(obj) ) {
                        // index
                        _key = ~~key[k];
                        obj[ _key ] = ( /^\d+$/.test(key[k+1]) ) ? [] : {};
                    } else {
                        obj[ key[k] ] = ( /^\d+$/.test(key[k+1]) ) ? [] : {};
                    }
                }

                // Assigning value
                if (k == key.length-1) {
                    let _value = ( typeof(value) != 'undefined' ) ? value : '';
                    if ( Array.isArray( obj[key[k]] ) ) {
                        obj[key[k]].push(_value);
                    }
                    else {
                        obj[ key[k] ] = _value;
                    }
                    break;
                }
                // Assigning index or key
                else {
                    if ( /^\d+$/.test(key[k]) && !Array.isArray(obj) ) {
                        obj = [];
                    }
                    // Init array or object
                    if ( typeof(obj[ _key ]) == 'undefined' ) {
                        obj[ _key ] = null;
                    }

                    nestBracketNotationKey(obj[ _key ], key, k+1, value);
                }
            }
        }

        return obj;
    }


    /**
     * armSubmitLoading
     *
     * Marks `$trigger` as running (`data-gina-loading="true"`, or whatever
     * `gina.config.loadingAttribute` names) and remembers it on the form instance so
     * every terminal path can release it — including the ones that never reach an
     * XHR and therefore have no `$submitTrigger` of their own in scope.
     *
     * The element is stashed rather than re-derived because the two are NOT always
     * the same: `send()` resolves `$submitTrigger` once from `$form.submitTrigger`
     * (an id) at its own entry, which a rejected submit never reaches, and which a
     * second click on a different button would have overwritten by then. The stash
     * is a single reference per form, replaced on each arm and nulled on disarm, so
     * it can not retain a detached node past the submit that created it.
     *
     * @param {object} $formInstance - the form instance (`instance.$forms[id]`)
     * @param {object} $trigger - the element the user operated
     *
     * @returns {boolean} true when the trigger was marked
     *
     * FIRST ARM WINS until the state is released. A form runs one submit at a time — that
     * is what `withRateLimit` enforces — so a second attempt arriving mid-flight is about
     * to be refused, and must not take ownership: on a form with several submit buttons it
     * would move the stash to the refused trigger, leaving the trigger that actually owns
     * the request armed with nothing left to release it.
     *
     * @example
     * armSubmitLoading(instance.$forms[$form.id], loadingState.resolveTrigger($el, $target));
     *
     * @inner
     */
    var armSubmitLoading = function($formInstance, $trigger) {
        if ( !$formInstance || !$trigger ) {
            return false;
        }
        if ($formInstance.loadingTrigger) {
            return false;
        }
        $formInstance.loadingTrigger = $trigger;
        return loadingState.arm($trigger);
    };

    /**
     * disarmSubmitLoading
     *
     * Releases whatever `armSubmitLoading` marked for this form
     * (`data-gina-loading="false"`) and drops the stash. Idempotent and safe to call
     * on a form that was never armed — every terminal path calls it unconditionally
     * rather than trying to work out whether arming happened.
     *
     * #B247: the validation-rejected path is the one that stranded consumer loading
     * state, because a rejected submit sends nothing and so never reaches any XHR
     * settle. `send()`'s rate-limit early return is the same shape and is covered
     * too; `loadend` covers success, error, timeout and abort alike.
     *
     * @param {object} $formInstance - the form instance (`instance.$forms[id]`)
     *
     * @returns {boolean} true when a marked trigger was released
     *
     * @example
     * disarmSubmitLoading(instance.$forms[_id]); // on reject, settle, timeout or abort
     *
     * @inner
     */
    var disarmSubmitLoading = function($formInstance) {
        if ( !$formInstance || !$formInstance.loadingTrigger ) {
            return false;
        }
        var released = loadingState.disarm($formInstance.loadingTrigger);
        $formInstance.loadingTrigger = null;
        return released;
    };

    /**
     * holdTriggerFocus — remember the submit trigger gina is about to blur.
     *
     * A natively `disabled` control cannot hold focus: the instant gina disables an
     * in-flight submit trigger the browser moves focus to `<body>`, and re-enabling
     * does not bring it back (both measured). Every keyboard submit therefore loses
     * the user's place. Only the native-`disabled` branch is recorded — an `<a>`
     * receives `aria-disabled`, which does not blur (measured), so it needs no restore.
     *
     * @param   {object} $form    - the form instance, which carries the stash.
     * @param   {object} $trigger - resolved submit trigger; may be null.
     * @returns {boolean} true when focus was captured for a later restore.
     *
     * @example
     * holdTriggerFocus($myFormInstance, $mySaveButton);
     *
     * @inner
     */
    var holdTriggerFocus = function($form, $trigger) {
        if ( !$form || !$trigger ) {
            return false;
        }
        if ( typeof(document) === 'undefined' || !document ) {
            return false;
        }
        if ( document.activeElement !== $trigger ) {
            return false;
        }
        $form.ginaA11yFocusReturn = $trigger;
        return true;
    };

    /**
     * releaseTriggerFocus — put focus back on the trigger gina blurred.
     *
     * Deliberately conservative: it restores ONLY when focus is still exactly where
     * the disable dropped it (`<body>`) and the trigger is still in the document. If
     * anything else claimed focus while the request was in flight — a popin opened, a
     * redirect ran, the failed-submit branch moved focus to the first invalid field —
     * that decision wins and gina undoes nothing. gina restores what gina took, never
     * more.
     *
     * @param   {object} $form - the form instance holding the stash.
     * @returns {boolean} true when focus was actually restored.
     *
     * @example
     * releaseTriggerFocus($myFormInstance);
     *
     * @inner
     */
    var releaseTriggerFocus = function($form) {
        if ( !$form || !$form.ginaA11yFocusReturn ) {
            return false;
        }
        var $trigger = $form.ginaA11yFocusReturn;
        $form.ginaA11yFocusReturn = null;
        if ( typeof(document) === 'undefined' || !document ) {
            return false;
        }
        // Nothing else may have claimed focus in the meantime.
        if ( document.activeElement && document.activeElement !== document.body ) {
            return false;
        }
        var _stillThere = ( typeof($trigger.isConnected) == 'boolean' )
            ? $trigger.isConnected
            : ( document.body && document.body.contains($trigger) );
        if ( !_stillThere || typeof($trigger.focus) != 'function' ) {
            return false;
        }
        $trigger.focus();
        return true;
    };

    /**
     * armSubmitA11y — expose an in-flight submit to assistive technology.
     *
     * Three things at once, all scoped to the request window: capture the trigger's
     * focus before the caller's native disable blurs it, mark the trigger busy, and
     * announce the start once through the form's polite region.
     *
     * Two placement decisions worth keeping:
     * - `aria-busy` goes on the TRIGGER, never the form. The live region lives inside
     *   the form, and an ancestor marked busy MAY be treated as "defer announcements in
     *   this subtree", which would silence the very region used to announce. ARIA 1.2
     *   defines no normative behaviour here, so this is a cheap hedge, not a spec
     *   requirement — and it is explicitly NOT a claim about what implementations do:
     *   measured 2026-08-05 on VoiceOver/Chrome, an announcement from inside an
     *   `aria-busy="true"` ancestor WAS spoken, so at least that pairing does not defer.
     *   The placement costs nothing and still guards ATs that might; do not restate it
     *   as "assistive tech commonly defers" — that wording was wrong and was corrected.
     * - This window is only ever reached once a request is genuinely in flight, so a
     *   validation-rejected submit never arms and never announces. That is what keeps
     *   the arm-before-validate loading state from producing a busy/not-busy flap.
     *
     * @param   {object} $form    - the form instance.
     * @param   {object} $trigger - resolved submit trigger; may be null.
     * @returns {boolean} true when this call produced the announcement.
     *
     * @example
     * armSubmitA11y($myFormInstance, $mySaveButton);
     *
     * @inner
     */
    var armSubmitA11y = function($form, $trigger) {
        if ( !$form ) {
            return false;
        }
        if ($trigger) {
            if ( !/^A$/i.test($trigger.tagName) ) {
                holdTriggerFocus($form, $trigger);
            }
            $trigger.setAttribute('aria-busy', 'true');
        }
        // readyState 1 and 3 both reach here; announce once per request.
        if ( $form.ginaA11yBusy ) {
            return false;
        }
        $form.ginaA11yBusy = true;
        if ( $form.target ) {
            announceA11yStatus($form.target, a11yLabel('submitting'));
        }
        return true;
    };

    /**
     * releaseSubmitA11y — clear the in-flight submit exposure.
     *
     * Idempotent, because both the readyState-4 release and the `loadend` fail-safe
     * run it. Deliberately announces nothing on completion: an errored response is
     * already announced field-by-field by `handleErrorsDisplay`, and writing a second
     * status over a polite region in the same beat can cut that announcement off.
     *
     * @param   {object} $form    - the form instance.
     * @param   {object} $trigger - resolved submit trigger; may be null.
     * @returns {boolean} true when focus was restored to the trigger.
     *
     * @example
     * releaseSubmitA11y($myFormInstance, $mySaveButton);
     *
     * @inner
     */
    var releaseSubmitA11y = function($form, $trigger) {
        if ( !$form ) {
            return false;
        }
        if ($trigger) {
            $trigger.removeAttribute('aria-busy');
        }
        $form.ginaA11yBusy = false;
        return releaseTriggerFocus($form);
    };

    /**
     * send
     * N.B.: no validation here; if you want to validate against rules, use `.submit()` or `.validateFormById(formId)` before
     *
     *
     * @param {object} data - FormData object (https://developer.mozilla.org/en-US/docs/Web/API/FormData/Using_FormData_Objects)
     * @param {object} [ options ] : { isSynchrone: false, withCredentials: true, withRateLimit: true }
     * */
    var send = function(data, options) {


        var $target = this.target , id = $target.getAttribute('id');
        var $form   = instance.$forms[id] || this;
        var $submitTrigger = document.getElementById($form.submitTrigger) || null;
        var result  = null;
        var XHRData = null;
        var isAttachment = null; // handle download
        var hFormIsRequired = null;

        options = (typeof (options) != 'undefined') ? merge(options, xhrOptions) : xhrOptions;

        // Rate Limit to one request at the time
        // Attention: this should be an option
        // the request needs to be completed before another can be made
        // TODO - Check same url
        if (
            /^true$/i.test(options.withRateLimit)
            && typeof($form.isSending) != 'undefined'
            && /^true$/i.test($form.isSending)
            ||
            /^true$/i.test(options.withRateLimit)
            && typeof($form.sent) != 'undefined'
            && /^true$/i.test($form.sent)
        ) {
            // #B247 — deliberately NO loading-state release here. This return means a
            // request for this form is already in flight, so the trigger that owns it is
            // still legitimately loading and its own settle will release it. Releasing
            // here would clear the state mid-request; and because `armSubmitLoading` is
            // first-wins, the refused attempt never armed anything of its own to clear.
            return;
        }

        instance.$forms[id].isSending = true;


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

        // #R8 — staged-upload send? (virtual `gina-upload-*` form) The upload-progress
        // channel below only activates for these sends.
        var isUploadXhr = /^gina\-upload/i.test(id);
        // uploadProgress -> data-gina-form-event-on-upload-progress (copied from the
        // file input's `data-gina-form-upload-on-progress` by the upload change
        // handler); no default: absent attribute = no `.hform` progress channel
        var uploadProgressHFormIsRequired = ( $target.getAttribute('data-gina-form-event-on-upload-progress') ) ? true : false;

        var url         = $target.getAttribute('action') || options.url;
        var method      = $target.getAttribute('method') || options.method;
        method          = method.toUpperCase();
        options.method  = method;
        options.url     = url;

        // #B175: one XHR per send. The module-scope XHR (created once at
        // validator init) was reused for every submit, and re-open()ing a
        // completed XHR synchronously replays the PREVIOUS submit's
        // still-assigned `onreadystatechange` handler (readyState 4 → 1):
        // that stale closure re-disabled the PREVIOUS form's submit trigger
        // and re-stamped its `data-gina-form-loading`, with no release path
        // (its readyState-4 release never comes — the handler is replaced
        // right below). A fresh LOCAL XHR per send makes handler, state and
        // lifecycle per-submit; nested handlers close over this local, never
        // the module var (the file-removal path already does exactly this
        // with `let xhr = setupXhr(...)`).
        // was:
        // if (!xhr) {
        //     xhr = setupXhr(options);
        // }
        var xhr = setupXhr();

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

        // #CSRF2 follow-up — inject X-Gina-CSRF-Token on mutating methods
        if ( isMutatingMethod(options.method) ) {
            var csrfToken = readCsrfCookie();
            if (csrfToken) {
                xhr.setRequestHeader('X-Gina-CSRF-Token', csrfToken);
            }
        }

        if (xhr) {
            // #B175 fail-safe release: `loadend` fires on success, error,
            // timeout and abort alike — the lock armed below (submit trigger
            // disabled + `data-gina-form-loading`) must never outlive its
            // request. Idempotent with the readyState-4 release; one listener
            // per XHR (fresh per send), so nothing accumulates.
            if ( typeof(xhr.addEventListener) == 'function' ) {
                xhr.addEventListener('loadend', function onSendSettled() {
                    $form.isSending = false;
                    $form.sent = false;
                    if ($submitTrigger) {
                        // For A tag: aria-disabled=true
                        if ( /^A$/i.test($submitTrigger.tagName) ) {
                            // #B312 — unconditional again: the live-check gate now marks
                            // `data-gina-form-submit-gated` (its own channel, untouched
                            // here), so the in-flight lock is aria-disabled's only
                            // framework writer on this trigger and the #B309 verdict
                            // replay — a conditional re-mark read from the form's
                            // `_gateMarked` shadow (commit cf366c34a) — had nothing left
                            // to replay and is retired. An authored aria mark set
                            // mid-flight is still released here; that was equally true
                            // of the replay.
                            $submitTrigger.removeAttribute('aria-disabled');
                        } else {
                            $submitTrigger.removeAttribute('disabled');
                        }
                    }
                    $form.target.removeAttribute('data-gina-form-loading');
                    // #B247 — the trigger-scoped release rides the same fail-safe:
                    // `loadend` is the one hook that covers abort and error too.
                    disarmSubmitLoading($form);
                    // #A11Y4 — last, so focus lands on a trigger that is fully settled:
                    // re-enabled above and no longer flagged loading.
                    releaseSubmitA11y($form, $submitTrigger);
                });
            }
            // catching ready state cb
            // Data loading ...
            if ( /^(1|3)$/.test(xhr.readyState) ) {
                $form.target.setAttribute('data-gina-form-loading', true);
                // #A11Y4 — must run BEFORE the native disable below, which blurs the trigger.
                armSubmitA11y($form, $submitTrigger);
                if ($submitTrigger) {
                    // For A tag: aria-disabled=true
                    if ( /^A$/i.test($submitTrigger.tagName) ) {
                        $submitTrigger.setAttribute('aria-disabled', true);
                    } else {
                        $submitTrigger.setAttribute('disabled', true);
                    }
                }
            }
            //handleXhrResponse(xhr, $target, id, $form, hFormIsRequired);
            xhr.onreadystatechange = function onValidationCallback(event) {
                $form.isSubmitting = false;
                // #B175: `isSending` is no longer cleared here — this handler
                // first fires at readyState 1 (synchronously at open()), so an
                // early clear made the flag false for almost the whole request
                // while its name promises "a request is in flight". It now
                // spans send() → settled: cleared in the readyState-4 release
                // below and in the `loadend` fail-safe above.
                // was: $form.isSending = false;

                // limit send trigger to 1 sec to prevent from double clicks
                // setTimeout( function onSent() {
                //     $form.sent = false;
                // }, 1000); // 1000

                // Data loading ...
                if ( /^(1|3)$/.test(xhr.readyState) ) {
                    $form.target.setAttribute('data-gina-form-loading', true);
                    // #A11Y4 — must run BEFORE the native disable below, which blurs the trigger.
                    armSubmitA11y($form, $submitTrigger);
                    if ($submitTrigger) {
                        // For A tag: aria-disabled=true
                        if ( /^A$/i.test($submitTrigger.tagName) ) {
                            $submitTrigger.setAttribute('aria-disabled', true);
                        } else {
                            $submitTrigger.setAttribute('disabled', true);
                        }
                    }
                }
                // In case the user is also redirecting
                var redirectDelay = (/Google Inc/i.test(navigator.vendor)) ? 50 : 0;

                // responseType interception
                if (xhr.readyState == 2) {
                    isAttachment    = ( /^attachment\;/.test( xhr.getResponseHeader("Content-Disposition") ) ) ? true : false;
                    // force blob response type
                    if ( !xhr.responseType && isAttachment ) {
                        xhr.responseType = 'blob';
                    }
                }

                if (xhr.readyState == 4) {

                    $form.sent = false;
                    $form.isSending = false; // #B175 — see the note at the handler top
                    if ($submitTrigger) {
                        // For A tag: aria-disabled=true
                        if ( /^A$/i.test($submitTrigger.tagName) ) {
                            // #B312 — unconditional again, in step with the loadend
                            // release above (the #B309 verdict replay is retired with
                            // the shared attribute — the gate marks its own channel
                            // now), and the stray 2nd argument fixed by #B309 stays
                            // gone.
                            // was:
                            // $submitTrigger.removeAttribute('aria-disabled', true);
                            $submitTrigger.removeAttribute('aria-disabled');
                        } else {
                            // was: $submitTrigger.removeAttribute('disabled', true);
                            $submitTrigger.removeAttribute('disabled');
                        }
                    }
                    $form.target.removeAttribute('data-gina-form-loading');
                    // #B247 — idempotent with the `loadend` release above
                    disarmSubmitLoading($form);
                    // #A11Y4 — last, so focus lands on a fully settled trigger; idempotent
                    // with the `loadend` release, which may already have restored it.
                    releaseSubmitA11y($form, $submitTrigger);

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
                                a.download = getFilenameFromContentDisposition(contentDisposition);
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

                            }
                            // normal case
                            else {
                                result = xhr.responseText;
                            }



                            if ( /\/json/.test( contentType ) ) {
                                result = JSON.parse(xhr.responseText);

                                if ( typeof(result.status) == 'undefined' ) {
                                    result.status = xhr.status;
                                }
                                // Fixed on 2025-03-13 Allowing toolbar to ubdate after xhr results
                                // TODO - Allowing to revert to previously loaded data via a close button
                                if (gina && envIsDev && typeof(window.ginaToolbar) && typeof(result) != 'undefined') {
                                    window.ginaToolbar.update('data-xhr', result);
                                }
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
                                    var _popinLoadHandle = null;
                                    if (
                                        typeof(result.popin) != 'undefined'
                                        && typeof(result.popin.name) != 'undefined'
                                        && popinName != result.popin.name
                                    ) {
                                        if ($popin && $popin.isOpen) {
                                            // Let the close actually run: `isRedirecting` was set just
                                            // above and popinClose() ignores a redirecting popin — same
                                            // reset-then-close idiom as the `result.popin.close` branch.
                                            $popin.isRedirecting = false;
                                            $popin.close();
                                        }

                                        popinName = result.popin.name;
                                        $popin = gina.popin.getPopinByName(popinName);
                                        if ( !$popin ) {
                                            throw new Error('Popin with name `'+ popinName+'` not found !');
                                        }
                                        console.debug('Validator::Popin now redirecting [1-c]');
                                        _popinLoadHandle = $popin.load($popin.name, popinUrl, $popin.options);
                                    } else if ($popin) {
                                        console.debug('Validator::Popin now redirecting [1-d]');
                                        if ($popin && $popin.isOpen)
                                            $popin.close();
                                        _popinLoadHandle = $popin.load($popin.name, popinUrl, $popin.options);
                                    }
                                    if ($popin && !$popin.isOpen) {
                                        // Content-first: arm the popin's `loaded.<id>` listener through
                                        // the load handle so the response body is injected before the
                                        // popin opens. Replaces a blind 50 ms open that raced the load —
                                        // a faster XHR fired the popin's `loaded` event with no listener
                                        // armed (body lost, popin opened empty), a slower one opened an
                                        // empty popin first. No handle means the load could not start
                                        // (e.g. CORS unsupported): the popin stays closed and the load's
                                        // own `error.<id>` event is the only signal.
                                        if ( _popinLoadHandle && typeof(_popinLoadHandle.open) != 'undefined' ) {
                                            _popinLoadHandle.open();
                                        }
                                        return;
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


                    } else if ( xhr.readyState == 4 && xhr.status === 0 ) {
                        // #B447 — TRANSPORT-layer failure: network down, connection
                        // refused, DNS gone, the server process restarting. XHR settles
                        // at readyState 4 with status 0, which fails BOTH `/^2/.test()`
                        // and `status != 0` above. This arm existed but was commented
                        // out and there was no trailing `else`, so neither `error.<id>`
                        // nor `error.<id>.hform` was emitted — and `error.<id>.hform` is
                        // exactly what `data-gina-form-event-on-submit-error` registers
                        // (see listenToXhrEvents), so a consumer's declared submit-error
                        // handler was silent for the failure it most needs to cover.
                        // The `loadend` fail-safe still released the trigger, so the form
                        // spun, re-enabled, and said nothing.
                        //
                        // Shape mirrors the sibling `xhr.ontimeout` handler below rather
                        // than the old commented block: same 408 + `error` key (the
                        // codebase convention for a client-side XHR failure, also used by
                        // utils/events.js), same #B175
                        // removeAttribute, same onUpload branch. 408 keeps range-checking
                        // handlers (`status >= 400`) working; `transportError` is what
                        // distinguishes this from a genuine timeout, which matters because
                        // `ontimeout` emits a bare 408 for a different failure.
                        //
                        // The stash goes to eventData.ERROR, not .onerror: the three
                        // sibling arms in this same readyState chain all write .error,
                        // it is what the readers actually look at (utils/events.js and
                        // the validate handler), and it is the key the pre-validation
                        // cleanup deletes. The on* keys the ontimeout/onprogress
                        // handlers use are written but never read.
                        result = {
                            'status'        : 408,
                            'transportError': true,
                            'error'         : 'Transport failure: the request did not reach the server'
                        };

                        $form.eventData.error = result;
                        // #B175 — remove, never setAttribute(..., false)
                        $form.target.removeAttribute('data-gina-form-loading');

                        XHRData = result;
                        // update toolbar
                        if ( gina && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar && XHRData ) {
                            try {
                                if ( envIsDev && typeof(XHRData) != 'undefined' && /\/html/.test(contentType) ) {
                                    window.ginaToolbar.update("data-xhr", XHRData);
                                }
                            } catch (err) {
                                throw err
                            }
                        }

                        // intercept upload
                        if ( /^gina\-upload/i.test(id) ) {
                            onUpload(gina, $target, 'error', id, result);
                        }

                        triggerEvent(gina, $target, 'error.' + id, result);

                        if (hFormIsRequired)
                            triggerEvent(gina, $target, 'error.' + id + '.hform', result);

                        return;
                    }
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

            // #R8 — catching upload (client-to-server) wire progress for staged uploads.
            // Reassigned on EVERY send: `xhr` is a module-scoped singleton (created once,
            // then reused across sends), so a stale handler would replay the previous
            // send's closure — wrong `id`, wrong form — on later sends. The fresh
            // assignment below (mirroring onreadystatechange/onprogress/ontimeout)
            // prevents that. Dispatches on its own `uploadProgress.<id>` channel — the
            // response-side (download) channel above is separate and untouched.
            if ( typeof(xhr.upload) != 'undefined' && xhr.upload ) {
                // snapshot the staged file names once per send — the payload's
                // per-request identity: ONE request carries ALL files of a selection,
                // so progress is per-request (aggregate), not per-file
                var uploadFileNames = [];
                if ( isUploadXhr && data instanceof FormData ) {
                    for (var [uploadFileKey, uploadFileValue] of data.entries()) {
                        if (uploadFileValue instanceof File) {
                            uploadFileNames.push(uploadFileValue.name);
                        }
                    }
                }
                xhr.upload.onprogress = function(event) {
                    // staged uploads only (`gina-upload-*` virtual forms)
                    if (!isUploadXhr) return;

                    var percentComplete = null; // null means indeterminate (length not computable)
                    if ( event.lengthComputable && event.total > 0 ) {
                        percentComplete = event.loaded / event.total;
                        percentComplete = parseInt(percentComplete * 100);
                    }

                    var result = {
                        'status'            : 100,
                        'progress'          : percentComplete,
                        'loaded'            : event.loaded,
                        'total'             : event.total,
                        'lengthComputable'  : event.lengthComputable,
                        'files'             : uploadFileNames
                    };

                    $form.eventData.uploadProgress = result;

                    // declarative indicator (opt-in by element presence)
                    updateUploadProgressIndicator(
                        ($target.uploadProperties) ? $target.uploadProperties.progressContainer : null,
                        (percentComplete === null) ? 'indeterminate' : 'uploading',
                        result
                    );

                    triggerEvent(gina, $target, 'uploadProgress.' + id, result);
                    if (uploadProgressHFormIsRequired)
                        triggerEvent(gina, $target, 'uploadProgress.' + id + '.hform', result);
                };

                // #R8 — bytes-done → server post-processing window. onloadend is the
                // final upload-phase event (fires on success AND on abort/error/timeout),
                // so it robustly marks "sending finished" even when a browser omits the
                // final onprogress at loaded==total. Advance the indicator STATE only —
                // updateUploadProgressIndicator's `processing` branch leaves value/max/the
                // percent attribute exactly as the last onprogress left them, so a styled
                // (appearance:none) determinate bar stays visually full instead of
                // regressing to an empty track. onUpload later flips complete/error at the
                // response chokepoint, cleanly overwriting `processing`.
                xhr.upload.onloadend = function() {
                    if (!isUploadXhr) return;
                    updateUploadProgressIndicator(
                        ($target.uploadProperties) ? $target.uploadProperties.progressContainer : null,
                        'processing'
                    );
                };
            }

            // catching timeout
            xhr.ontimeout = function (event) {
                result = {
                    'status': 408,
                    'error': 'Request Timeout'
                };

                $form.eventData.ontimeout = result;

                // #B175: remove the attribute — `setAttribute(..., false)`
                // wrote the string "false", which is attribute-PRESENT and
                // truthy for any presence or non-empty-string check.
                // was: $form.target.setAttribute('data-gina-form-loading', false);
                $form.target.removeAttribute('data-gina-form-loading');

                // intercept upload
                if ( /^gina\-upload/i.test(id) ) {
                    onUpload(gina, $target, 'error', id, result);
                }

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
                                } else if ( /^(.*)\[(.*)\]/.test(key) ) {
                                    // #B92 — nest bracket-notation names per entry, mirroring the
                                    // declarative formatDataFromString/parseObject expansion so
                                    // `item[0][id]` arrives as `item: [ { id } ]` (not a literal
                                    // JSON key). Values stay VERBATIM (no decode/coerce) — #B28.
                                    newData = nestBracketNotationKey(newData, key.replace(/\]/g, '').split(/\[/g), 0, value);
                                } else {
                                    newData[key] = value
                                }
                            }
                        }


                        if (hasBinaries && binaries.length > 0) {

                            // We need a separator to define each part of the request
                            var boundary = '--ginaWKBoundary' + uuid();

                            // #B92-adjacent — non-file fields ride the multipart body as
                            // standard text parts. They were silently dropped on this branch:
                            // processFiles() assembles file parts only, and newData was never
                            // consumed once the FormData carried a File.
                            return processFiles(binaries, boundary, buildMultipartFieldParts(data, boundary), 0, function onComplete(err, data, done) {

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
                    // #FORMCT — the non-binary body is JSON (JSON.stringify'd above). Honor an
                    // EXPLICIT form `enctype` if set; otherwise send application/json — NOT the
                    // urlencoded default — or the server url-decodes the JSON body ('+' -> space,
                    // decodeURIComponent) and corrupts values such as email "+aliases".
                    var explicitEnctype = $target.getAttribute('enctype');
                    var sendContentType = (explicitEnctype && explicitEnctype != '')
                        ? explicitEnctype
                        : ( (typeof(data) == 'string' && /^[\[{]/.test(data.trim()))
                            ? 'application/json; charset=UTF-8'
                            : enctype );
                    if (typeof (sendContentType) != 'undefined' && sendContentType != null && sendContentType != '') {
                        xhr.setRequestHeader('Content-Type', sendContentType);
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

    /**
     * updateUploadProgressIndicator - #R8
     *
     * Updates the declarative upload-progress indicator of a staged upload
     * (`data-gina-form-upload-progress`, default target id `<fieldId>-progress`).
     * Opt-in by presence: a null id or no matching element is a silent no-op.
     *
     * Behavior by target type:
     * - native `<progress>`: `value`/`max` track uploaded/total bytes; the `value`
     *   attribute is removed while indeterminate (`preparing`, or length not
     *   computable) so the browser renders its native indeterminate animation;
     *   `error` empties the bar (value 0 — NOT indeterminate, whose animation
     *   would read as still working)
     * - any other element: `textContent` shows the integer percentage (`42%`), and
     *   `role="progressbar"` + `aria-valuemin="0"` / `aria-valuemax="100"` /
     *   `aria-valuenow="<percent>"` give it the semantics a native `<progress>` gets
     *   for free (#A11Y7/U2 — without them the indicator is unlabelled text to
     *   assistive tech). `aria-valuenow` tracks `data-gina-upload-progress` exactly:
     *   both are ABSENT while indeterminate and on `error`, because an absent
     *   `aria-valuenow` is how a progressbar signals "unknown" — a stale or zero
     *   value would read as real, stalled progress. A native `<progress>` is left
     *   untouched: it already exposes all of this, and a redundant explicit role
     *   risks overriding the implicit one.
     *
     * Every target also carries two data attributes as styling hooks:
     * `data-gina-upload-progress` (integer percent, absent while indeterminate)
     * and `data-gina-upload-progress-state`
     * (`preparing|uploading|indeterminate|processing|complete|error`). No copy/labels
     * are hardcoded — wording is the consumer's concern (CSS on the state attribute).
     * The `processing` state marks bytes-sent → awaiting-response (server-side
     * post-processing): it advances the state attribute ONLY, leaving value/max/the
     * percent attribute exactly as the last `uploading` update left them, so a styled
     * determinate bar stays visually full (an indeterminate one keeps animating)
     * through the window rather than regressing to an empty track.
     * The `reset` state strips everything this layer ever set on the element.
     *
     * @param {string|null} containerId - resolved indicator element id
     * @param {string} state - `preparing` | `uploading` | `indeterminate` | `processing` | `complete` | `error` | `reset`
     * @param {object} [result] - `uploadProgress` payload (`progress`, `loaded`, `total`) — read for `uploading` only
     *
     * @returns {undefined}
     * */
    var updateUploadProgressIndicator = function(containerId, state, result) {
        if (!containerId) return;
        var $indicator = document.getElementById(containerId);
        if (!$indicator) return; // opt-in by presence

        var isNativeProgress = /^progress$/i.test($indicator.tagName);

        if (state == 'reset') {
            if (isNativeProgress) {
                $indicator.removeAttribute('value');
                $indicator.removeAttribute('max');
            } else {
                $indicator.textContent = '';
            }
            $indicator.removeAttribute('data-gina-upload-progress');
            $indicator.removeAttribute('data-gina-upload-progress-state');
            // #A11Y7/U2 — `reset` strips everything this layer ever set, and the ARIA
            // below is part of "everything": leaving a stale `role="progressbar"` on a
            // cleared element would expose a permanently 0%-looking bar to assistive tech.
            if (!isNativeProgress) {
                $indicator.removeAttribute('role');
                $indicator.removeAttribute('aria-valuemin');
                $indicator.removeAttribute('aria-valuemax');
                $indicator.removeAttribute('aria-valuenow');
            }
            return;
        }

        $indicator.setAttribute('data-gina-upload-progress-state', state);
        // #A11Y7/U2 — a native <progress> already carries implicit progressbar
        // semantics (and its own value/max), so it is deliberately left alone; every
        // other element is text with no role at all until we give it one. The bounds
        // are constant because `data-gina-upload-progress` is already a percentage.
        if (!isNativeProgress) {
            $indicator.setAttribute('role', 'progressbar');
            $indicator.setAttribute('aria-valuemin', '0');
            $indicator.setAttribute('aria-valuemax', '100');
        }

        if (state == 'processing') {
            // #R8 — byte-complete, server still post-processing. Advance the STATE only:
            // leave value/max and the `data-gina-upload-progress` percent exactly as the
            // last `uploading` update left them (a determinate bar stays full; an
            // indeterminate one keeps its native animation). Falling through to the guard
            // below would strip `value` + the percent attribute — the regression this
            // early return prevents (the state attribute is already stamped above).
            return;
        }

        if (state == 'complete') {
            if (isNativeProgress) {
                if ( !$indicator.getAttribute('max') ) {
                    $indicator.max = 100;
                }
                $indicator.value = $indicator.max;
            } else {
                $indicator.textContent = '100%';
            }
            $indicator.setAttribute('data-gina-upload-progress', 100);
            if (!isNativeProgress) {
                $indicator.setAttribute('aria-valuenow', '100');
            }
            return;
        }

        if (state == 'error') {
            if (isNativeProgress) {
                if ( !$indicator.getAttribute('max') ) {
                    $indicator.max = 100;
                }
                $indicator.value = 0;
            } else {
                $indicator.textContent = '';
            }
            $indicator.removeAttribute('data-gina-upload-progress');
            // #A11Y7/U2 — an errored bar is EMPTY, not indeterminate (the native branch
            // above says the same about `value`): drop `aria-valuenow` so assistive tech
            // reports an unknown state rather than a confident 0% that reads as "no
            // progress yet, still working".
            if (!isNativeProgress) {
                $indicator.removeAttribute('aria-valuenow');
            }
            return;
        }

        if ( state == 'preparing' || state == 'indeterminate' || !result || result.progress === null ) {
            if (isNativeProgress) {
                $indicator.removeAttribute('value'); // native indeterminate animation
            }
            $indicator.removeAttribute('data-gina-upload-progress');
            // #A11Y7/U2 — mirrors the `value` removal above: an absent `aria-valuenow`
            // on a progressbar IS the indeterminate signal, so this must track the
            // percent attribute exactly rather than reporting a stale last-known value.
            if (!isNativeProgress) {
                $indicator.removeAttribute('aria-valuenow');
            }
            return;
        }

        // determinate update (`uploading`)
        if (isNativeProgress) {
            $indicator.max      = result.total;
            $indicator.value    = result.loaded;
        } else {
            $indicator.textContent = result.progress + '%';
            $indicator.setAttribute('aria-valuenow', result.progress);
        }
        $indicator.setAttribute('data-gina-upload-progress', result.progress);
    };

    /**
     * updateUploadDropzoneState - #R8 slice 2
     *
     * Updates the drag-and-drop state attribute of a staged-upload dropzone.
     * Opt-in by presence: a null id or no matching element is a silent no-op.
     *
     * The layer only toggles `data-gina-upload-dropzone-state`
     * (`idle` | `over` | `dropped`) - a pure CSS styling hook. No copy/labels
     * are hardcoded: wording is the consumer's concern (CSS on the state
     * attribute). The binding marker (`data-gina-upload-dropzone`, value =
     * the owner input id) is stamped once at bind time by bindUploadDropzone
     * and is never touched here.
     *
     * @param {string|null} dropzoneId - resolved dropzone element id
     * @param {string} state - `idle` | `over` | `dropped`
     *
     * @returns {undefined}
     * */
    var updateUploadDropzoneState = function(dropzoneId, state) {
        if (!dropzoneId) return;
        var $dropzone = document.getElementById(dropzoneId);
        if (!$dropzone) return; // opt-in by presence

        $dropzone.setAttribute('data-gina-upload-dropzone-state', state);
    };

    /**
     * bindUploadDropzone - #R8 slice 2
     *
     * Binds an attribute-marked dropzone element to a staged-upload file
     * input so files dropped on the zone route through the EXACT same
     * staging pipeline as a native picker selection - group tagging,
     * virtual form, staging POST, previews, hidden metadata fields,
     * reset/delete and upload progress - with zero duplicated logic: the
     * drop assigns the dropped `FileList` to the input, then re-fires the
     * input's `change` through triggerEvent (the same synthetic-change
     * idiom the form-reset path already uses). The change handler reads
     * only `currentTarget` off its event, so a synthetic dispatch is
     * indistinguishable from a trusted one on this path.
     *
     * Opt-in and EXPLICIT-ONLY: the input must carry
     * `data-gina-form-upload-dropzone="<elementId>"`. There is deliberately
     * no default id resolution (unlike `-preview` / `-error` / `-progress`):
     * auto-binding a coincidentally-named element would attach drag
     * semantics to markup that may already carry its own drop handling.
     * Absent attribute: fully inert. Attribute present but element
     * missing: console.warn + inert.
     *
     * Contract on the dropzone element:
     * - `data-gina-upload-dropzone` (value = owner input id): binding
     *   marker, stamped once. Also the first-wins guard - a zone serves
     *   exactly one input; a second input naming the same zone warns and
     *   is skipped, while the same owner re-binding (form re-bind cycles)
     *   is a silent no-op.
     * - `data-gina-upload-dropzone-state`: `idle` (bound, no drag) ->
     *   `over` (a file drag hovers the zone) -> `dropped` (files dropped,
     *   upload in flight) -> back to `idle` at the same chokepoints that
     *   finalize upload progress (onUpload complete/error) and strip it
     *   (reset/delete removal).
     *
     * Only file drags react (`dataTransfer.types` must carry `Files`):
     * text/link drags fall through untouched. Multi-file drops on a
     * non-`multiple` input keep the FIRST file only (console.warn) - the
     * graceful client mirror of the single-file native picker; configured
     * upload groups also enforce `isMultipleAllowed` server-side.
     *
     * @param {object} $uploadTrigger - the file `<input>` (HTMLInputElement)
     *
     * @returns {undefined}
     * */
    var bindUploadDropzone = function($uploadTrigger) {
        var dropzoneId = $uploadTrigger.getAttribute('data-gina-form-upload-dropzone') || null;
        if (!dropzoneId) return; // opt-in: explicit id only - no default id

        var $dropzone = document.getElementById(dropzoneId);
        if (!$dropzone) {
            console.warn('[FormValidator][upload] `data-gina-form-upload-dropzone` targets `#'+ dropzoneId +'` but no such element was found: drag-and-drop stays inactive for `#'+ $uploadTrigger.id +'`');
            return;
        }
        // first-wins: a zone serves exactly one input; re-binding by the
        // same owner (form re-bind cycles) is a silent no-op
        var dropzoneOwnerId = $dropzone.getAttribute('data-gina-upload-dropzone');
        if (dropzoneOwnerId) {
            if (dropzoneOwnerId != $uploadTrigger.id) {
                console.warn('[FormValidator][upload] dropzone `#'+ dropzoneId +'` is already bound to `#'+ dropzoneOwnerId +'`: skipping `#'+ $uploadTrigger.id +'`');
            }
            return;
        }
        $dropzone.setAttribute('data-gina-upload-dropzone', $uploadTrigger.id);
        updateUploadDropzoneState(dropzoneId, 'idle');

        // dragenter/dragleave also fire when the pointer crosses the
        // zone's own children - a bare leave handler would flicker the
        // state on every child boundary, hence the depth counter
        var dragDepth = 0;
        var hasFilesPayload = function(event) {
            var types = (event.dataTransfer && event.dataTransfer.types) || null;
            if (!types) return false;
            // `types` is a frozen array (DOMStringList on legacy engines,
            // which lacks .indexOf - hence the borrowed call)
            return ( Array.prototype.indexOf.call(types, 'Files') > -1 );
        };

        addListener(gina, $dropzone, 'dragenter', function(event) {
            if ( !hasFilesPayload(event) ) return; // text/link drags fall through
            event.preventDefault();
            dragDepth++;
            updateUploadDropzoneState(dropzoneId, 'over');
        });

        addListener(gina, $dropzone, 'dragover', function(event) {
            if ( !hasFilesPayload(event) ) return;
            event.preventDefault(); // required, or the browser refuses the drop
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
        });

        addListener(gina, $dropzone, 'dragleave', function(event) {
            if ( !hasFilesPayload(event) ) return;
            if (--dragDepth <= 0) {
                dragDepth = 0;
                updateUploadDropzoneState(dropzoneId, 'idle');
            }
        });

        addListener(gina, $dropzone, 'drop', function(event) {
            if ( !hasFilesPayload(event) ) return; // never swallow non-file drops
            event.preventDefault();
            dragDepth = 0;

            var droppedFiles = event.dataTransfer.files;
            if (!droppedFiles.length) {
                updateUploadDropzoneState(dropzoneId, 'idle');
                return;
            }
            // multi-file drop on a single-file input: keep the FIRST file
            // only - the graceful client mirror of the native single-file
            // picker
            if (droppedFiles.length > 1 && !$uploadTrigger.multiple) {
                console.warn('[FormValidator][upload] '+ droppedFiles.length +' files dropped on `#'+ dropzoneId +'` but `#'+ $uploadTrigger.id +'` is not `multiple`: keeping the first file only');
                var singleFileTransfer = new DataTransfer();
                singleFileTransfer.items.add(droppedFiles[0]);
                droppedFiles = singleFileTransfer.files;
            }
            // route through the staging pipeline: assign, then re-fire
            // `change` exactly like the form-reset path does
            $uploadTrigger.files = droppedFiles;
            updateUploadDropzoneState(dropzoneId, 'dropped');
            triggerEvent(gina, $uploadTrigger, 'change');
        });
    };

    var onUpload = function(gina, $target, status, id, data) {

        var uploadProperties = $target.uploadProperties || null;
        // FYI
        // {
        //     id              : String,
        //     $form           : $Object,
        //     mandatoryFields : Array,
        //     uploadFields    : ObjectList
        //     hasPreviewContainer : Boolean,
        //     previewContainer : $Object,
        //     progressContainer : String|null (#R8 — element id; string, unlike previewContainer)
        // }

        if ( !uploadProperties )
            throw new Error('No uploadProperties found !!');

        // #R8 — finalize the upload-progress indicator: this one chokepoint covers
        // the success path and every error/timeout path routed through onUpload
        updateUploadProgressIndicator(
            uploadProperties.progressContainer || null,
            (status == 'success') ? 'complete' : 'error'
        );
        // #R8 slice 2 — the dropzone (if bound) returns to idle at the same
        // single chokepoint
        updateUploadDropzoneState(uploadProperties.dropzoneContainer || null, 'idle');
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
            // #A11Y7/U3 — the container is `display:none` when the text is written and
            // only revealed by the fadeIn above, which is exactly the case where a
            // `role="alert"` on it is unreliable; route through the form's own polite
            // region instead — the same channel field validation errors already use.
            // Announce the RENDERED text, not `errMsg`: the message can carry markup
            // (the url-action checker substitutes `<br>`), and textContent is what a
            // user would actually read.
            if ( $uploadTriger && $uploadTriger.form ) {
                announceA11yError($uploadTriger.form, $error.textContent);
            }
        } else if(!$error && status != 'success') {
            throw new Error(errMsg)
        } else {
            // #A11Y7/U2 — success is the other end of the `uploadStarted` transition.
            // It lives in this branch rather than at the indicator chokepoint above so
            // it can never fire alongside the error announcement and overwrite it: a
            // polite region is latest-wins, and a generic "complete" landing on top of
            // a specific server message would lose the message.
            if ( $uploadTriger && $uploadTriger.form ) {
                announceA11yStatus($uploadTriger.form, a11yLabel('uploadComplete'));
            }

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
                let resetLabel = $uploadTriger.getAttribute('data-gina-form-upload-reset-label') || 'Reset';
                if (!$resetLink) {
                    resetLinkNeedToBeAdded      = true;
                    $resetLink                  = document.createElement('A');
                    $resetLink.href             = '#';
                    $resetLink.innerHTML        = resetLabel;
                    $resetLink.className        = defaultClassNameArr.join(' ');
                    $resetLink.id               = resetLinkId;
                } else {
                    if ( /a/i.test($resetLink.tagName) ) {
                        $resetLink.href             = '#';
                    }
                    if ( !$resetLink.innerHTML || $resetLink.innerHTML == '' ) {
                        $resetLink.innerHTML        = resetLabel;
                    }
                    if ( typeof($resetLink.className) == 'undefined' ) {
                        $resetLink.className = "";
                    }
                    let classNameArr = merge($resetLink.className.split(/\s+/g), defaultClassNameArr);
                    $resetLink.className    = classNameArr.join(' ');
                }
                // #A11Y7/U5 — the control gina generates is an anchor, so assistive tech
                // announces it as a link and Space does not activate it. Give it button
                // semantics; the matching Space handler lives with the click binding in
                // `bindUploadResetOrDeleteTrigger`, because a role that PROMISES button
                // behaviour without delivering the key is worse than no role at all.
                // Stamped only on an anchor: a consumer supplying their own <button> under
                // this id already has the right semantics, and overriding an implicit role
                // is a regression. Strict `/^a$/i` here, unlike the loose `/a/i` guarding
                // `href` above (that one also matches TEXTAREA, CANVAS, LABEL…).
                if ( /^a$/i.test($resetLink.tagName) ) {
                    $resetLink.setAttribute('role', 'button');
                    // The accessible name names the file it acts on: these controls stack
                    // one per staged file and are otherwise identical, so a controls list
                    // reads "Reset, Reset, Reset". The visible label stays the PREFIX so
                    // the name still contains it (WCAG 2.5.3 Label in Name), and it reuses
                    // the consumer's own `-reset-label`, so it is translated wherever that
                    // already is.
                    if ( files[f].originalFilename ) {
                        $resetLink.setAttribute('aria-label', resetLabel + ' ' + files[f].originalFilename);
                    }
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
                    // #A11Y7/U1 — the preview tells the user WHICH file is staged, so it is
                    // informative content, not decoration; without a text alternative assistive
                    // tech falls back to reading the temp URI aloud, once per staged file.
                    // Empty string when the name is missing: a silently ignored image beats
                    // announcing a placeholder.
                    $img.alt    = files[f].originalFilename || '';
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
                    // #B459 — the preview slot is a sub-field map, never an input (see the
                    // auto-create loop at bind time): its object is delivered key by key by
                    // the `handle preview` block below, never through `.value`.
                    if ( key != 'preview' ) {
                        fieldsObjectList[key].value = files[f][key];
                    }
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
                                // #A11Y7/U1 — name the file the user actually chose, not the
                                // server-generated preview variant recorded just below: the
                                // generated name is an internal artefact and means nothing to
                                // the person listening. Same empty-string fallback as the
                                // no-preview branch.
                                $img.alt = files[f].originalFilename || '';
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
     * restoreUploadAffordance
     *
     * Restores the upload input's add-affordance visibility once files were
     * removed: removes the optional `data-gina-form-upload-hidden-class` class
     * from the input and its parent (a class-hidden affordance could otherwise
     * never come back), then falls back to the historical inline-display
     * restore (parent first when the parent was inline-hidden, else the input).
     *
     * @inner
     * @private
     * @param {object} $uploadTrigger - HTMLInputElement (file input)
     * @param {string|null} hiddenClass - class name to remove, or null
     * @returns {void}
     */
    var restoreUploadAffordance = function($uploadTrigger, hiddenClass) {
        if (hiddenClass) {
            try {
                $uploadTrigger.classList.remove(hiddenClass);
                if ($uploadTrigger.parentElement) {
                    $uploadTrigger.parentElement.classList.remove(hiddenClass);
                }
            } catch (restoreErr) {}
        }
        if ( /none/i.test(window.getComputedStyle($uploadTrigger).display) ) {
            // eg.: visibility could be delegated to a parent element such as label or a div
            if ( /none/i.test($uploadTrigger.parentElement.style.display) ) {
                $uploadTrigger.parentElement.style.display = 'block';
            } else {
                $uploadTrigger.style.display = 'block';
            }
        }
    }

    /**
     * onUploadResetOrDelete
     *
     * Removes the previewed file(s): notifies the server first (the removal
     * XHR is sent BEFORE any DOM removal — the preview DOM feeds the payload),
     * then removes the preview image and its reset/delete link from the DOM,
     * restores the upload input's add-affordance (see restoreUploadAffordance)
     * and, when defined, invokes the `data-gina-form-upload-on-reset` /
     * `data-gina-form-upload-on-delete` callback — a bare identifier
     * registered on `window` — once per action with
     * `{ $upload, bindingType, files }`.
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
            // static snapshot of the preview images: nodes are removed from
            // the DOM mid-loop, so a live NodeList would shift under the
            // iteration (out-of-range reads on multi-file passes)
            , childNodes            = Array.prototype.filter.call($uploadPreview.childNodes, function (node) {
                return /img/i.test(node.tagName);
            })
            , $resetLink            = null
            , files                 = $uploadTrigger.customFiles
            , filesToBeRemoved      = []
            , onRemoveCbName        = $uploadTrigger.getAttribute('data-gina-form-upload-on-' + bindingType)
            , uploadHiddenClass     = $uploadTrigger.getAttribute('data-gina-form-upload-hidden-class')
            , removedCount          = 0
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
                    let file = childNodes[i].src.substring(childNodes[i].src.lastIndexOf('/')+1);
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
                        removedCount++;
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
                                // #FORMCT — the body sent below is JSON (JSON.stringify({ files })).
                                // Send application/json — NOT the urlencoded default — or the server
                                // url-decodes the JSON body ('+' -> space, decodeURIComponent) and
                                // corrupts '+'/'%' in removed-file keys.
                                'Content-Type': 'application/json; charset=UTF-8',
                                // cross domain is enabled by default, but you need to setup `Access-Control-Allow-Origin`
                                'X-Requested-With': 'XMLHttpRequest' // in case of cross domain origin
                            }
                        };
                        // #CSRF2 follow-up — inject X-Gina-CSRF-Token on mutating methods (file remove → DELETE/POST)
                        if ( isMutatingMethod(method) ) {
                            let csrfToken = readCsrfCookie();
                            if (csrfToken) {
                                xhrOptions.headers['X-Gina-CSRF-Token'] = csrfToken;
                            }
                        }
                        let xhr = setupXhr(xhrOptions);
                        //handleXhr(xhr);
                        if ( /GET|DELETE/i.test(method) ) {
                            xhr.send();
                        } else {
                            xhr.send(JSON.stringify({ files: filesToBeRemoved }));
                        }

                        // when there is no more files to preview, restore input file visibility
                        // display upload input
                        restoreUploadAffordance($uploadTrigger, uploadHiddenClass);

                        // #A11Y7/U5 — the control about to be removed is the one the user
                        // just activated, so it holds focus; removing a focused element
                        // drops focus to <body> and the user loses their place with no
                        // signal. Move focus first, onto the file input that owns the
                        // staged files — which `restoreUploadAffordance` just made visible
                        // again. Guarded on it actually holding focus, so a programmatic
                        // reset never yanks focus away from wherever the user really is.
                        if ( document.activeElement === $resetLink || $resetLink.contains(document.activeElement) ) {
                            if ( typeof($uploadTrigger.focus) == 'function' ) {
                                $uploadTrigger.focus();
                            }
                            // #A11Y5's lesson, applied: `typeof focus == 'function'` is true
                            // for EVERY HTMLElement, and focus() is a silent no-op on one
                            // that cannot take focus (hidden, disabled, detached) — so
                            // confirm the move instead of assuming it. Signal-only: there is
                            // no better fallback than the document, and failing loudly here
                            // would break a removal that otherwise succeeded.
                            if ( document.activeElement !== $uploadTrigger ) {
                                console.debug('[FormValidator][upload]['+ ($uploadTrigger.id || '?') +'] '+ bindingType +': could not move focus to the file input before removing the '+ bindingType +' control; focus falls back to the document.');
                            }
                        }
                        // Announce the removal. `aria-live="polite"` queues rather than
                        // interrupts, so this lands after the focus move above has been
                        // announced instead of racing it. Function replacer, not a string:
                        // a file name may contain `$`, and a string replacement would expand
                        // `$&` / `$1` patterns inside it.
                        if ( $uploadTrigger.form && childNodeFile ) {
                            announceA11yStatus(
                                $uploadTrigger.form,
                                a11yLabel('fileRemoved').replace('%s', function () { return childNodeFile; })
                            );
                        }

                        // remove link & image - must be done last
                        // (the reset/delete link's own click listener dies with the node)
                        $resetLink.remove();
                        childNodes[i].remove();
                        break;
                    }
                } // EO for
            }
        }

        // #B150 — the removal loop matched zero previews against the input's
        // customFiles, so NOTHING was removed: the tmp-delete XHR, the #R8
        // indicator strip, and the removal callback below are all `removedCount>0`
        // -gated and are about to be skipped, silently, leaving any staged tmp
        // files on the server. That is expected when there was nothing to remove
        // (an empty preview set), but a NON-EMPTY preview set that matched nothing
        // is a state desync (e.g. a runtime-injected bind whose customFiles names
        // do not line up with the rendered `data-upload-original-filename`s) —
        // signal it so the otherwise-invisible skip is diagnosable. Signal-only:
        // the `removedCount>0` gates STAY (no removal => no removal callback, #B94).
        if (removedCount === 0 && childNodes.length > 0) {
            console.warn('[FormValidator][upload]['+ ($uploadTrigger.id || '?') +'] '+ bindingType +': '+ childNodes.length +' preview(s) present but none matched the staged input files — nothing removed, cleanup skipped. Ensure each preview\'s `data-upload-original-filename` matches a current input file name.');
        }

        // #R8 — at least one staged file the indicator reported is gone:
        // strip the upload-progress indicator entirely
        if (removedCount > 0) {
            updateUploadProgressIndicator(
                $uploadTrigger.getAttribute('data-gina-form-upload-progress') || ( ($uploadTrigger.id) ? $uploadTrigger.id + '-progress' : null ),
                'reset'
            );
            // #R8 slice 2 — dropzone back to idle (explicit attr only)
            updateUploadDropzoneState($uploadTrigger.getAttribute('data-gina-form-upload-dropzone') || null, 'idle');
        }

        // removal-path callback: dispatched ONCE per reset/delete action,
        // AFTER the removal XHR(s) went out and the preview DOM was cleaned
        // up. Same convention as `data-gina-form-upload-on-success`: a bare
        // identifier registered on `window` (function-call shapes unsupported).
        if (removedCount > 0 && onRemoveCbName) {
            if ( /\((.*)\)/.test(onRemoveCbName) ) {
                try { console.warn('[FormValidator][upload] function-call shape not supported on `data-gina-form-upload-on-'+ bindingType +'` — use a bare identifier and register the handler on window: '+ onRemoveCbName); } catch (warnErr) {}
            } else if ( typeof(window[onRemoveCbName]) === 'function' ) {
                try {
                    window[onRemoveCbName]({ $upload: $uploadTrigger, bindingType: bindingType, files: filesToBeRemoved });
                } catch (cbErr) {
                    console.error('[FormValidator][upload] `data-gina-form-upload-on-'+ bindingType +'` callback (`'+ onRemoveCbName +'`) threw: ', cbErr);
                }
            } else {
                console.warn('[FormValidator][upload] `data-gina-form-upload-on-'+ bindingType +'` callback `'+ onRemoveCbName +'` was not found on `window`.');
            }
        }
    }

    // #B148 (2026-07-22) — `ab2str` is RETIRED. Its only consumer was the
    // staged-upload body assembly in `processFiles()`, which converted each
    // file's ArrayBuffer to a per-byte JS string so the multipart body could
    // be string-concatenated and sent as a DOMString. A DOMString is UTF-8
    // encoded on the wire, so every file byte >= 0x80 became a 2-byte
    // sequence and binary uploads were stored inflated/corrupted server-side.
    // `processFiles()` now assembles a `Blob` (raw bytes, transmitted
    // verbatim) and needs no buffer-to-string conversion at all.
    // was:
    // /**
    //  * Convert <Uint8Array|Uint16Array|Uint32Array> to <String>
    //  * @param {array} buffer
    //  * @param {number} [byteLength] e.g.: 8, 16 or 32
    //  *
    //  * @returns {string} stringBufffer
    //  */
    // var ab2str = function(event, buf, byteLength) {
    //
    //     var str = '';
    //     var ab = null;
    //
    //     if ( typeof(byteLength) == 'undefined' ) {
    //         var byteLength = 8;
    //     }
    //
    //
    //     var bits = (byteLength / 8)
    //
    //
    //     switch (byteLength) {
    //         case 8:
    //             ab = new Uint8Array(buf);
    //             break;
    //         case 16:
    //             ab = new Uint16Array(buf);
    //             break;
    //
    //         case 32:
    //             ab = new Uint32Array(buf);
    //             break;
    //
    //         default:
    //             ab = new Uint8Array(buf);
    //             break;
    //
    //     }
    //
    //     var abLen = ab.length;
    //     var CHUNK_SIZE = Math.pow(2, 8) + bits;
    //     var offset = 0, len = null, subab = null;
    //
    //     for (; offset < abLen; offset += CHUNK_SIZE) {
    //         len = Math.min(CHUNK_SIZE, abLen - offset);
    //         subab = ab.subarray(offset, offset + len);
    //         str += String.fromCharCode.apply(null, subab);
    //     }
    //
    //     return str;
    // }


    /**
     * buildMultipartFieldParts
     *
     * #B92-adjacent — serializes a FormData's NON-file entries into standard
     * multipart text parts so they ride the hand-assembled upload body
     * (`processFiles()` builds file parts only; before this helper every
     * non-file field was silently dropped whenever the FormData carried a
     * File). Part names keep the caller's ORIGINAL bracket notation
     * (`item[0][id]`) — the server nests them on capture, so the fields arrive
     * shaped exactly as on the JSON (fileless) path. Values are appended
     * verbatim; FormData guarantees non-file values are strings (a Blob append
     * becomes a File).
     *
     * @param {FormData} data - the form data being sent
     * @param {string} boundary - the multipart boundary (as used by processFiles)
     *
     * @returns {string} zero or more `--<boundary>` text parts; '' when the
     *  FormData carries no non-file entry
     */
    var buildMultipartFieldParts = function(data, boundary) {
        var parts = '';
        for (var [fieldKey, fieldValue] of data.entries()) {
            if (fieldValue instanceof File) {
                continue;
            }
            // RFC 7578 §5.1.1 name escaping (the browser convention): percent-encode
            // CR / LF / double-quote; anything else — bracket notation included — is
            // legal inside the quoted-string as-is.
            var safeName = String(fieldKey).replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
            parts += '--' + boundary + '\r\n'
                + 'Content-Disposition: form-data; name="' + safeName + '"\r\n'
                + '\r\n'
                + fieldValue + '\r\n';
        }
        return parts;
    };

    /**
     * processFiles
     *
     * Assembles the staged-upload multipart body and hands it to `onComplete`
     * as a `Blob` (#B148). The multipart FRAMING is byte-identical to the
     * historical hand-assembled string body — same `--<boundary>` delimiters,
     * same `Content-Disposition: form-data; name=".."; group=".."; filename=".."`
     * parameter set (the upload-group tag keeps its documented wire vehicle,
     * parsed server-side from the disposition params), same per-part
     * `Content-Type` / `Content-Length` headers — but the file BYTES now ride
     * as raw `File` (Blob) parts instead of a per-byte JS string.
     *
     * Why (#B148): the historical flow read each file with a `FileReader`,
     * converted the buffer to a JS string (one char per byte) and
     * string-concatenated the whole body, which `XMLHttpRequest.send()` then
     * transmitted as a DOMString — and a DOMString is UTF-8-encoded on the
     * wire, so every file byte >= 0x80 inflated to a 2-byte sequence: any real
     * binary upload (image / PDF / archive) was stored inflated + corrupted
     * server-side (measured x1.49 on a cycling-byte fixture). A `Blob` body is
     * transmitted verbatim, and an explicitly-set `Content-Type` request
     * header survives `xhr.send(Blob)`, so the server sees the exact same
     * wire contract with faithful bytes. String segments inside the Blob (the
     * part headers + any field parts) are UTF-8-encoded by the Blob itself —
     * byte-identical to the DOMString era for those segments, which is what
     * the server-side disposition-parameter decode expects.
     *
     * Disposition-parameter values (`name`, `group`, `filename`) are
     * percent-encoded for CR / LF / double-quote per the RFC 7578 §5.1.1
     * convention — the same escaping `buildMultipartFieldParts` applies to
     * field names (an unescaped double-quote previously produced a malformed
     * part). The per-part `Content-Length` now reports the file's true byte
     * size (`File.size`; numerically identical to the historical char count).
     *
     * The signature and the `onComplete(err, body, done)` contract are
     * unchanged (`body` is now a `Blob` instead of a string, and the send call
     * site passes it to `xhr.send()` opaquely either way). The `FileReader`
     * stage is retired along with `ab2str` (their only consumer was this
     * body), so the assembly is synchronous and `onComplete` fires in the
     * same tick — `xhr` is already open by then (opened in `setupXhr()`
     * before the send flow reaches this call).
     *
     * @param {array} binaries - staged-file records `{ key, group, file, bin }` (one per selected `File`)
     * @param {string} boundary - multipart boundary token (as declared in the `Content-Type` request header)
     * @param {string|Blob} data - body accumulator; the field parts built by `buildMultipartFieldParts()` ride here (`''` when the payload carries no non-file entry)
     * @param {number} f - index of the first file to process (the send call site passes `0`)
     * @param {function} onComplete - completion callback
     * @param {Error|false} onComplete.err - assembly error, `false` on success
     * @param {Blob|null} onComplete.body - the assembled multipart body
     * @param {boolean} onComplete.done - `true` when the body is final
     *
     * @returns {void}
     */
    var processFiles = function(binaries, boundary, data, f, onComplete) {
        // #B148 (2026-07-22) — build the body as a Blob of
        // [ field parts (string), per-file header (string), File, CRLF, ..., closer ]
        // so file bytes reach the wire VERBATIM. The historical implementation
        // (kept below for the record) sent the body as a DOMString, which
        // UTF-8-inflated every file byte >= 0x80 — binary uploads corrupted.
        var escapeDispositionParam = function(value) {
            // RFC 7578 §5.1.1 percent-escaping (the browser convention) — the
            // same treatment `buildMultipartFieldParts` applies to field names.
            return String(value).replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
        };
        var parts = [];
        if (data) {
            // non-file field parts (string) — UTF-8-encoded by the Blob,
            // byte-identical to the historical DOMString encoding of the same
            // segments
            parts.push(data);
        }
        try {
            for (var i = f; i < binaries.length; i++) {
                // MIME fallback — `File.type` is read-only, so resolve the
                // effective type instead of assigning it (the historical
                // assignment onto the File object was a silent no-op).
                var partType = binaries[i].file.type || 'application/octet-stream';

                // Start a new part in our body's request
                parts.push(
                    "--" + boundary + "\r\n"
                    // Describe it as form data
                    + 'Content-Disposition: form-data; '
                    // Define the name of the form data
                    + 'name="' + escapeDispositionParam(binaries[i].key) + '"; '
                    // Define the upload group
                    + 'group="' + escapeDispositionParam(binaries[i].group) + '"; '
                    // Provide the real name of the file
                    + 'filename="' + escapeDispositionParam(binaries[i].file.name) + '"\r\n'
                    // And the MIME type of the file
                    + 'Content-Type: ' + partType + '\r\n'
                    // File length (true byte count)
                    + 'Content-Length: ' + binaries[i].file.size + '\r\n'
                    // There's a blank line between the metadata and the data
                    + '\r\n'
                );

                // The file's raw bytes — a File IS a Blob: the browser reads it
                // lazily at transmit time, so no whole-file string or buffer is
                // ever materialized in JS.
                parts.push(binaries[i].file);
                parts.push('\r\n');
            }
        } catch (err) {
            return onComplete(err, null, true);
        }

        // Once we are done, "close" the body's request
        parts.push("--" + boundary + "--");

        return onComplete(false, new Blob(parts), true);
    }
    // was (#B148 — the historical string-assembly implementation, retired):
    // var processFiles = function(binaries, boundary, data, f, onComplete) {
    //
    //     var reader = new FileReader();
    //
    //     reader.addEventListener('load', function onReaderLoaded(e) {
    //
    //         e.preventDefault();
    //
    //         try {
    //
    //             var bin = ab2str(e, this.result);
    //             ;
    //             binaries[this.index].bin += bin;
    //
    //             if (!binaries[this.index].file.type) {
    //                 binaries[this.index].file.type = 'application/octet-stream'
    //             }
    //
    //         } catch (err) {
    //             return onComplete(err, null, true);
    //         }
    //
    //         // Start a new part in our body's request
    //         data += "--" + boundary + "\r\n";
    //
    //         // Describe it as form data
    //         data += 'Content-Disposition: form-data; '
    //             // Define the name of the form data
    //             + 'name="' + binaries[this.index].key + '"; '
    //             // Define the upload group
    //             + 'group="' + binaries[this.index].group + '"; '
    //             // Provide the real name of the file
    //             + 'filename="' + binaries[this.index].file.name + '"\r\n'
    //             // And the MIME type of the file
    //             + 'Content-Type: ' + binaries[this.index].file.type + '\r\n'
    //             // File length
    //             + 'Content-Length: ' + binaries[this.index].bin.length + '\r\n'
    //             // There's a blank line between the metadata and the data
    //             + '\r\n';
    //
    //         // Append the binary data to our body's request
    //         data += binaries[this.index].bin + '\r\n';
    //
    //         ++this.index;
    //         // is last file ?
    //         if (this.index == binaries.length) {
    //             // Once we are done, "close" the body's request
    //             data += "--" + boundary + "--";
    //
    //             onComplete(false, data, true);
    //
    //         } else { // process next file
    //             processFiles(binaries, boundary, data, this.index, onComplete)
    //         }
    //     }, false);
    //
    //     reader.index = f;
    //     binaries[f].bin = '';
    //
    //     reader.readAsArrayBuffer(binaries[f].file);
    // }


    var listenToXhrEvents = function($form) {

        //data-gina-form-event-on-submit-success
        var htmlSuccesEventCallback =  $form.target.getAttribute('data-gina-form-event-on-submit-success') || null;
        if (htmlSuccesEventCallback != null) {

            if ( /\((.*)\)/.test(htmlSuccesEventCallback) ) {
                // #M21a — function-call shape unsupported; register a bare handler on window instead
                try { console.warn('[gina-form-event] function-call shape no longer supported on data-gina-form-event-on-submit-success — use a bare identifier and register the handler on window: '+ htmlSuccesEventCallback); } catch (e) {}
            } else {
                $form.on('success.hform',  window[htmlSuccesEventCallback])
            }
        }
        //data-gina-form-event-on-submit-error
        var htmlErrorEventCallback =  $form.target.getAttribute('data-gina-form-event-on-submit-error') || null;
        if (htmlErrorEventCallback != null) {
            if ( /\((.*)\)/.test(htmlErrorEventCallback) ) {
                // #M21a — function-call shape unsupported; register a bare handler on window instead
                try { console.warn('[gina-form-event] function-call shape no longer supported on data-gina-form-event-on-submit-error — use a bare identifier and register the handler on window: '+ htmlErrorEventCallback); } catch (e) {}
            } else {
                $form.on('error.hform', window[htmlErrorEventCallback])
            }
        }
        // #R8 — data-gina-form-event-on-upload-progress (staged uploads: copied from
        // the file input's `data-gina-form-upload-on-progress` by the change handler)
        var htmlUploadProgressEventCallback = $form.target.getAttribute('data-gina-form-event-on-upload-progress') || null;
        if (htmlUploadProgressEventCallback != null) {
            if ( /\((.*)\)/.test(htmlUploadProgressEventCallback) ) {
                // #M21a — function-call shape unsupported; register a bare handler on window instead
                try { console.warn('[gina-form-event] function-call shape not supported on data-gina-form-event-on-upload-progress — use a bare identifier and register the handler on window: '+ htmlUploadProgressEventCallback); } catch (e) {}
            } else {
                $form.on('uploadProgress.hform', window[htmlUploadProgressEventCallback])
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
            _id = $target.getAttribute('id') || 'form.'+uuid();

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
                            tmpStr = tmpStr.substring(1, tmpStr.length-1);// removing ->{ ... }<-
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
                        id = $allForms[f].getAttribute('id') || 'form.' + uuid();
                        if ( id !== $allForms[f].getAttribute('id') ) {
                            $allForms[f].setAttribute('id', id)
                        }
                    } else {
                        id = 'form.' + uuid();
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
                                // #SCS1e (2026-04-24) — replaced `eval('gina.forms.rules.' + customRule)`
                                // with a safe dot-path walker. `customRule` is user-controlled (read
                                // from the `data-gina-form-rule` HTML attribute); after the replace at
                                // line 2601 it is a pure dot-path like `account.signin_scope`. The old
                                // eval executed anything that parsed as JS — a crafted rule name such
                                // as `constructor.constructor("return process.exit()")()` would fire on
                                // lookup. The walker rejects any non-identifier character and returns
                                // undefined on missing path (the `typeof(local.rules[customRule]) ==
                                // 'undefined'` check at line 2606 then produces the usual user-facing
                                // "no rule found" error).
                                // instance.$forms[id].rules[customRule] = instance.rules[customRule] = local.rules[customRule] = merge(JSON.clone( eval('gina.forms.rules.'+ customRule)), instance.rules[customRule]);
                                // instance.$forms[id].rules[customRule] = instance.rules[customRule] = local.rules[customRule] = merge(eval('gina.forms.rules.'+ customRule), instance.rules[customRule]);
                                if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(customRule)) {
                                    throw new Error('Invalid form rule path: `' + customRule + '`');
                                }
                                var _scsSegments = customRule.split('.');
                                var _scsCur      = gina.forms.rules;
                                for (var _scsI = 0; _scsCur != null && _scsI < _scsSegments.length; _scsI++) {
                                    _scsCur = _scsCur[_scsSegments[_scsI]];
                                }
                                instance.$forms[id].rules[customRule] = instance.rules[customRule] = local.rules[customRule] = merge(JSON.clone(_scsCur), instance.rules[customRule]);
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

                                var _id = $allForms[f].attributes.getNamedItem('id').nodeValue || 'form.'+uuid();

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


                // #B175: no init-time XHR — send() creates a fresh local XHR
                // per submit (setupXhr() carries the same browser fallbacks).
                // This block was the source of the shared instance every
                // submit then reused.
                // was:
                // // setting up AJAX
                // if (window.XMLHttpRequest) { // Mozilla, Safari, ...
                //     xhr = new XMLHttpRequest();
                // } else if (window.ActiveXObject) { // IE
                //     try {
                //         xhr = new ActiveXObject("Msxml2.XMLHTTP");
                //     } catch (e) {
                //         try {
                //             xhr = new ActiveXObject("Microsoft.XMLHTTP");
                //         }
                //         catch (e) {}
                //     }
                // }



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
            id = $form.getAttribute('id') || 'form.' + uuid();
            if (id !== $form.getAttribute('id')) {
                $form.setAttribute('id', id)
            }
        } else {
            id = 'form.' + uuid();
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

                    var _id = $form.attributes.getNamedItem('id').nodeValue || 'form.' + uuid();

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
     * setByPath — Safe property setter that walks a segments array and
     * assigns a value at the terminal segment, creating intermediate
     * `{}` / `[]` based on the next segment's type (numeric → array,
     * otherwise object).
     *
     * @inner
     * @private
     *
     * @param {object|array} rootObj - Root container to mutate in place.
     * @param {array} segments - Path keys (numbers for array indices, strings for object props).
     * @param {*} value - Value to assign at the terminal segment.
     *
     * @returns {void}
     *
     * @example
     *   var root = {};
     *   setByPath(root, ['foo', 'bar'], 42);
     *   // root === { foo: { bar: 42 } }
     *
     * @example
     *   var root = {};
     *   setByPath(root, ['items', 0], 'first');
     *   // root === { items: ['first'] }
     */
    var setByPath = function(rootObj, segments, value) {
        var cur = rootObj;
        for (var i = 0; i < segments.length - 1; i++) {
            var seg = segments[i];
            if ( cur[seg] === undefined || cur[seg] === null ) {
                cur[seg] = (typeof segments[i + 1] === 'number') ? [] : {};
            }
            cur = cur[seg];
        }
        cur[segments[segments.length - 1]] = value;
    };


    /**
     * makeObjectFromArgs — Recursive builder of a nested object/array tree
     * from a flat segments array. Threads a `rootSegments` path through the
     * recursion and assigns at the terminal via `setByPath`.
     *
     * #M20: replaced the previous string-path accumulator and runtime
     * evaluation with the segments-array + safe setter (see `setByPath`
     * above).
     *
     * @inner
     * @private
     *
     * @param {array} _root - Initial path segments (overwritten in init branch on first call).
     * @param {array} args - Bracketed key sequence.
     * @param {object} _obj - Current sub-tree being walked.
     * @param {number} len - args.length.
     * @param {number} i - Current index into args.
     * @param {*} _value - Terminal value to assign.
     * @param {object} [_rootObj] - Accumulator root object (null on first call).
     *
     * @returns {Object} A `JSON.clone`d snapshot of the assembled root tree.
     */
    var makeObjectFromArgs = function(_root, args, _obj, len, i, _value, _rootObj) {

        var rootSegments = Array.isArray(_root) ? _root : ['rootObj'];
        var obj          = _obj || null;
        var value        = _value || null;
        var rootObj      = _rootObj || null;

        if (i == len) { // end
            setByPath(rootObj, rootSegments.slice(1), value);
            return JSON.clone(rootObj);
        }

        var key = args[i].replace(/^\[|\]$/g, '');

        // init root object
        if ( typeof(rootObj) == 'undefined' || !rootObj ) {
            rootObj = {};
            rootSegments = ['rootObj'];

            rootSegments.push((/^\d+$/.test(key)) ? parseInt(key, 10) : key);
            setByPath(rootObj, rootSegments.slice(1), obj);
        } else {
            rootSegments.push((/^\d+$/.test(key)) ? parseInt(key, 10) : key);
        }


        var nextKey = ( typeof(args[i + 1]) != 'undefined' ) ? args[i + 1].replace(/^\[|\]$/g, '') : null;
        var valueType = ( nextKey && parseInt(nextKey) == nextKey ) ? [] : {};
        if ( nextKey ) {
            setByPath(rootObj, rootSegments.slice(1), valueType);
        }

        if ( typeof(obj[key]) == 'undefined' ) {

            if (/^\d+$/.test(nextKey)) { // collection index ?
                obj[key] = [];
            } else {
                obj[key] = {};
            }

            ++i;
            return makeObjectFromArgs(rootSegments, args, obj[key], len, i, value, rootObj);
        }

        ++i;
        return makeObjectFromArgs(rootSegments, args, obj[key], len, i, value, rootObj);
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

    /**
     * addLiveForInput
     * Wires one form control for live checking: registers the gina event
     * name(s) the control's validation handler consumes, plus the handler
     * itself (field pass + whole-form silent pass -> updateSubmitTriggerState).
     * Text-like controls register change./keyup./focusin./focusout.<id>;
     * radios and checkboxes register changed.<id> (dispatched by their
     * update relays); a radio ALSO registers change.<id> (#B228) because the
     * form-level change proxy is the only dispatcher that fires on a user
     * pick and it only dispatches names that are registered.
     *
     * @inner
     * @param {object} $form - form instance record (`instance.$forms[id]` shape: `.rules`, `.target`)
     * @param {object} $el - control to wire (DOMObject)
     * @param {number} liveCheckTimer - shared debounce timer handle
     * @param {boolean} [isOtherTagAllowed=false] - admit non-input/textarea tags (selects, FACEs)
     *
     * @returns {undefined}
     * */
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
                    // #B228 -- a RADIO also listens on the proxy-dispatched name: the
                    // form-level change proxy dispatches `change.<id>` only when that
                    // exact name is registered, and nothing else fires on a user pick
                    // (the click proxy short-circuits into updateRadio, which never
                    // dispatches; the bare-id relay has no live trigger) -- so the
                    // `changed.<id>` registration above was consume-only dead wiring
                    // on the pick path and the submit trigger kept its bind-time
                    // state forever. The handler's radio arm has accepted
                    // `change.`-typed events all along; checkboxes stay on their
                    // working relay (change proxy -> updateCheckBox -> `changed.<id>`).
                    if ( /^radio$/i.test($el.type) ) {
                        _evt = 'change.'+$el.id;
                        if ( typeof(gina.events[_evt]) == 'undefined' ) {
                            eventsList[_e] = _evt;
                            ++_e;
                        }
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

                            // if ( typeof($form.isBeingReseted) != 'undefined' && /^true$/.test($form.isBeingReseted) ) {
                            //     handleErrorsDisplay(event.target.form, {}, null, event.target.name);
                            //     return cancelEvent(event);
                            // }

                            if ( !/^(password)$/i.test(event.target.type) ) {
                                console.debug('processing: ' + event.target.name+ '/'+ event.target.id);
                            }

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
                            }


                            var localField = {}, $localField = {};
                            localField[event.target.name]     = event.target.value;
                            $localField[event.target.name]    = event.target;

                            instance.$forms[event.target.form.getAttribute('id')].isValidating = true;
                            validate(event.target, localField, $localField, $form.rules, function onLiveValidation(result){
                                // instance.$forms[event.target.form.getAttribute('id')].isValidating = false;
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
                                var gValidatorInfos = excludeWithheldAutofill(getFormValidationInfos($gForm, rules)); // #B478
                                gFields  = gValidatorInfos.fields;
                                $gFields = gValidatorInfos.$fields;
                                var formId = $gForm.getAttribute('id');
                                gRules   = instance.$forms[formId].rules;
                                // Don't be tempted to revome fields that has already been validated
                                instance.$forms[formId].isValidating = true;
                                validate($gForm, gFields, $gFields, gRules, function onSilentGlobalLiveValidation(gResult){
                                    instance.$forms[formId].isValidating = false;
                                    console.debug('['+ formId +'] onSilentGlobalLiveValidation: '+ gResult.isValid(), gResult, gFields);
                                    // var isFormValid = ( gResult.isValid() && instance.$forms[formId].errors && instance.$forms[formId].errors.count() == 0 )? true : false;
                                    var isFormValid = gResult.isValid();
                                    // var isFormValid = gResult.isValid();
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


                                    if ( !isFormValid && gResult.error ) {
                                        // Fixed on 2025-03-16 - we need past and live errors
                                        instance.$forms[ $el.form.getAttribute('id') ].errors = merge(result.error, gResult.error);
                                        // Fixed on 2026-04-09 - only display errors for the touched field,
                                        // not all fields from the global pass. The global pass determines
                                        // submit button state; untouched fields should not show errors
                                        // until the user interacts with them or submits.
                                        var _touchedField = event.target.name;
                                        if ( typeof(gResult.error[_touchedField]) != 'undefined' ) {
                                            refreshWarning($gFields[_touchedField]);
                                            handleErrorsDisplay($gForm, gResult.error, gResult.data, _touchedField);
                                        }
                                    }
                                    // #B136 — the fresh global pass is VALID but the store still
                                    // holds errors from an earlier pass (e.g. a cross-field
                                    // comparison fixed by ANOTHER control's change: a checkbox
                                    // handler raising the compared field). Every stored error is
                                    // stale — clear each previously-errored field's display, not
                                    // just the touched field's, so the re-enabled submit trigger
                                    // never sits beside a stale blocking-error message.
                                    // handleErrorsDisplay's empty-errors path also prunes the
                                    // per-field bookkeeping; new errors are never rendered here
                                    // (untouched-field display still waits for interaction or
                                    // submit).
                                    else if ( isFormValid && instance.$forms[formId].errors && instance.$forms[formId].errors.count() > 0 ) {
                                        var staleErrors = instance.$forms[formId].errors;
                                        instance.$forms[formId].errors = {};
                                        for (var staleField in staleErrors) {
                                            handleErrorsDisplay($gForm, {}, null, staleField);
                                        }
                                    }
                                    // Fixed on 2025-03-16
                                    // Eg.: input select change impacting another element: solve `no more errors`
                                    else if ( instance.$forms[formId].errors && !instance.$forms[formId].errors.count() ) {
                                        // recheck if valid
                                         //resetting error display
                                         instance.$forms[ formId ].errors = {};
                                         console.debug('resetting field: '+ $el.name);
                                         liveCheckErrors[formId] = {};
                                        //  $form.dataset.ginaFormIsResetting = true;
                                         handleErrorsDisplay($gForm, {}, null, $el.name);
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
                            // #B319 — not on the answer focus: when a refused submit
                            // moves focus to the first invalid field, the message it
                            // just rendered must survive its own delivery.
                            if (
                                /\-error/.test($el.parentNode.className)
                                && !isAnswerFocusInProgress
                            ) {
                                console.debug('#1 you just focusin ....'+$el.id, $el.value, instance.$forms[ $el.form.getAttribute('id') ].isValidating);
                                refreshWarning($el);
                            }
                        }
                        else if ( /^focusout\./i.test(event.type) ) {
                            if ( /\-warning/.test($el.parentNode.className) ) {
                                console.debug('#1 you just focusout ....'+$el.id, $el.value);
                                // Removed on 2025-03-16
                                instance.$forms[ $el.form.getAttribute('id') ].isValidating = false;

                                refreshWarning($el);
                                // in case error context is changed by another task
                                handleErrorsDisplay($el.form, instance.$forms[ $el.form.getAttribute('id') ].errors, null, $el.name);
                            }
                        }
                        else if ( /^keyup\./i.test(event.type) ) {
                            $el.ginaFormValidatorTestedValue = $el.value;
                            liveCheckTimer = setTimeout( function onLiveCheckTimer() {
                                // Do not trigger for copy/paste events
                                if ( ['91', '17', '16'].indexOf(''+event.keyCode) > -1  && keyboardMapping.count() == 0) {
                                    //console.debug('mapping ', keyboardMapping);
                                    return;
                                }

                                // Fixed on 2025-03-16:
                                // Treat TAB as focus in/out
                                // if ( ['9'].indexOf(''+event.keyCode) > -1 ) {

                                //     console.debug('[TAB] you just focusout from "'+ instance.$forms[ $el.form.getAttribute('id') ].lastFocused[1].id +'" to "'+ $el.id +'"');
                                //     var $gForm = event.target.form, gFields = null, $gFields = null, gRules = null;
                                //     var gValidatorInfos = getFormValidationInfos($gForm, rules);
                                //     gFields  = gValidatorInfos.fields;
                                //     $gFields = gValidatorInfos.$fields;
                                //     var formId = $gForm.getAttribute('id');
                                //     gRules   = instance.$forms[formId].rules;
                                //     // Don't be tempted to revome fields that has already been validated
                                //     instance.$forms[formId].isValidating = true;
                                //     validate($gForm, gFields, $gFields, gRules, function onSilentGlobalLiveValidation(gResult){
                                //         instance.$forms[formId].isValidating = false;
                                //         console.debug('['+ formId +'] [9] onSilentGlobalLiveValidation: '+ gResult.isValid(), gResult, gFields);
                                //         var isFormValid = ( gResult.isValid() && instance.$forms[formId].errors && instance.$forms[formId].errors.count() == 0 )? true : false;
                                //         // var isFormValid = gResult.isValid();
                                //         if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                //             // update toolbar
                                //             if (!gina.forms.errors)
                                //                 gina.forms.errors = {};

                                //             var objCallback = {
                                //                 id      : formId,
                                //                 errors  :  gResult.error || {}
                                //             };

                                //             window.ginaToolbar.update('forms', objCallback);
                                //         }


                                //         if ( !isFormValid && gResult.error ) {
                                //             // Fixed on 2025-03-16 - we need past and live errors
                                //             instance.$forms[ $el.form.getAttribute('id') ].errors = merge(result.error, gResult.error);
                                //             // Fixed on 2025-03-16
                                //             for (let eField in instance.$forms[ $el.form.getAttribute('id') ].errors) {
                                //                 refreshWarning($gFields[eField]);
                                //                 handleErrorsDisplay($gForm, instance.$forms[ $el.form.getAttribute('id') ].errors, gResult.data, eField);
                                //             }
                                //         }
                                //         // Fixed on 2025-03-16
                                //         // Eg.: input select change impacting another element: solve `no more errors`
                                //         else if ( instance.$forms[formId].errors && !instance.$forms[formId].errors.count() ) {
                                //             // recheck if valid
                                //              //resetting error display
                                //              instance.$forms[ formId ].errors = {};
                                //              console.debug('resetting field: '+ $el.name);
                                //              liveCheckErrors[formId] = {};
                                //             //  $form.dataset.ginaFormIsResetting = true;
                                //              handleErrorsDisplay($gForm, {}, null, $el.name);
                                //         }

                                //         updateSubmitTriggerState( $gForm, isFormValid);

                                //         once = false;
                                //     });
                                //     // var $previeousEl = document.getElementById(instance.$forms[ $el.form.getAttribute('id') ].lastFocused[1].id);
                                //     // var errors = instance.$forms[ $previeousEl.form.getAttribute('id') ].errors;
                                //     // var isFormValid = (!errors[$previeousEl.name]) ? true : false;
                                //     // console.debug('[TAB] you just focusout from "'+ instance.$forms[ $el.form.getAttribute('id') ].lastFocused[1].id +'" to "'+ $el.id +'"', "errors: ", errors);
                                //     // if (errors && errors.count() > 0 ) {
                                //     //     instance.$forms[ $previeousEl.form.getAttribute('id') ].isValidating = false;
                                //     //     isFormValid = false;
                                //     // }
                                //     // refreshWarning($previeousEl);
                                //     // // // in case error context is changed by another task
                                //     // handleErrorsDisplay($previeousEl.form, errors, null, $previeousEl.name);
                                //     // updateSubmitTriggerState( $el.form, isFormValid);
                                //     return;
                                // }


                                console.debug('[A]['+keyboardMapping.count()+'] keyup ('+ event.keyCode +') .... '+$el.id, $el.value, ' VS ',$el.ginaFormValidatorTestedValue + '(old)');
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
    /**
     * commitCaret
     * #B389 — commits the caret SYNCHRONOUSLY after a programmatic value
     * rebuild and records the position on the element. Assigning `.value`
     * collapses the selection to the END of the field (measured on WebKit
     * and Chromium), and the deferred restore of the transient-readonly
     * dance only runs two macrotasks later — so without a synchronous
     * commit, any keystroke arriving inside that window reads a stale
     * `selectionStart` and inserts at the wrong offset (scrambled fast
     * input). The recorded position (`_ginaAcCaret`) is what the keydown
     * interception trusts while a deferred restore is still in flight.
     *
     * @param {object} $el - HTMLElement
     * @param {number} pos - caret position to commit
     */
    var commitCaret = function ($el, pos) {
        setCaretToPos($el, pos);
        $el._ginaAcCaret = pos;
    }
    /**
     * queueCaretRestore
     * #B389 — re-applies the transient readonly (the Safari autofill/
     * autosuggest suppression — mechanism kept identical to the original
     * dance) and queues the deferred caret restore. The restore re-asserts
     * the LATEST committed caret (`_ginaAcCaret`) rather than the position
     * captured at its own keystroke: a later keystroke may have advanced
     * the caret while this restore sat in the queue, and re-applying a
     * stale capture is what scrambled fast typing. `_ginaAcPending` counts
     * restores in flight so the keydown interception knows when the
     * element's own selection can be trusted again; the tracker is handed
     * back (nulled) once the last pending restore has fired.
     *
     * @param {object} $el - HTMLElement
     */
    var queueCaretRestore = function ($el) {
        $el._ginaAcPending = ($el._ginaAcPending || 0) + 1;
        $el.setAttribute('readonly', 'readonly');
        setTimeout(() => {
            $el.removeAttribute('readonly');
            setTimeout(() => {
                // Guard on typeof — never truthiness: 0 is a valid caret
                // position, and the cleared tracker is null.
                if ( typeof($el._ginaAcCaret) == 'number' ) {
                    setCaretToPos($el, $el._ginaAcCaret);
                }
                $el._ginaAcPending--;
                if ( $el._ginaAcPending <= 0 ) {
                    $el._ginaAcPending = 0;
                    $el._ginaAcCaret = null;
                }
            }, 0);
        }, 0);
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
     *
     * Intercepts keydown on the field (preventDefault + a programmatic value
     * rebuild behind a transient readonly) so the browser never sees typing
     * and offers no autofill/autosuggest. Modifier chords (metaKey/ctrlKey)
     * are deliberately NOT intercepted (#B134): they return before
     * preventDefault so the native select-all/copy/paste/cut/undo defaults
     * run — the rebuild cannot reproduce them.
     *
     * Gated to REAL Safari at the registerForLiveChecking call site (#B135):
     * Chromium UAs carry the Safari token but were never this workaround's
     * target — they get native behavior.
     *
     * Caret integrity (#B389): every value rebuild commits the caret
     * SYNCHRONOUSLY (commitCaret) and records it on the element; the
     * deferred restore of the readonly dance (queueCaretRestore) re-asserts
     * the LATEST committed position, and while a restore is in flight the
     * keydown handler trusts the recorded caret over the element's own
     * selection — a `.value` assignment parks the selection at the end of
     * the field, so a fast next keystroke would otherwise read a stale
     * position and compose scrambled text.
     * @param {object} $el HTMLElement
     * @param {number} [liveCheckTimer] - live-check debounce handle, cleared per intercepted keystroke
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
                    // #B134 — modifier chords are NOT intercepted: return before
                    // preventDefault so the native select-all/copy/paste/cut/undo
                    // defaults run. The rebuild below cannot reproduce them — the
                    // printable branch typed the chord letter into the field
                    // (Cmd+A appended "a") and execCommand("paste") is inert in
                    // unprivileged web content. The field is not readonly here
                    // (focusin removed it), so the native edit lands and the
                    // live-check picks it up on the keyup that follows.
                    if ( e.metaKey || e.ctrlKey ) {
                        return;
                    }
                    e.preventDefault();
                    clearTimeout(liveCheckTimer);

                    var $_el = e.currentTarget;
                    var str = e.currentTarget.value;
                    var posStart = $_el.selectionStart, posEnd = $_el.selectionEnd;
                    // #B389 — while a deferred caret restore is in flight, the
                    // element's own selection is NOT trustworthy: the last
                    // rebuild parked the caret at the end of the field and the
                    // restore only runs two macrotasks later. Trust the
                    // committed caret instead, so consecutive fast keystrokes
                    // compose the same string a native field would.
                    if ( ($_el._ginaAcPending || 0) > 0 && typeof($_el._ginaAcCaret) == 'number' ) {
                        posStart = posEnd = $_el._ginaAcCaret;
                    }
                    $_el.removeAttribute('readonly');
                    //console.debug('pressed: '+ e.key+'('+ e.keyCode+')', ' S:'+posStart, ' E:'+posEnd, ' MAP: '+ JSON.stringify(keyboardMapping));
                    switch (e.keyCode) {
                        case 46: //Delete
                            if (posStart != posEnd) {
                                $_el.value = str.substring(0, posStart) + str.substring(posEnd);
                                // #B391 — the posStart == 0 override below ate one
                                // char MORE than the selection (native Delete
                                // removes the selection only): "XY" with [0,1)
                                // selected must give "Y", not "". The generic
                                // rebuild above is already correct at position 0.
                                // if (posStart == 0) {
                                //     $_el.value = str.substring(posEnd+1);
                                // }
                            } else if (posStart == 0) {
                                $_el.value = str.substring(posStart+1);
                            } else {
                                $_el.value = str.substring(0, posStart) + str.substring(posEnd+1);
                            }

                            // #B389 — synchronous caret commit + guarded deferred
                            // restore (the retired tail below re-applied a stale
                            // per-keystroke capture two macrotasks later; its
                            // if/else chain always resolved to posStart anyway).
                            // e.currentTarget.setAttribute('readonly', 'readonly');
                            // setTimeout(() => {
                            //     $_el.removeAttribute('readonly');
                            //     setTimeout(() => {
                            //         if (posStart != posEnd) {
                            //             setCaretToPos($_el, posStart);
                            //         } else if (posStart == 0) {
                            //             setCaretToPos($_el, posStart);
                            //         } else {
                            //             setCaretToPos($_el, posStart);
                            //         }
                            //     }, 0)
                            //
                            // }, 0);
                            commitCaret($_el, posStart);
                            queueCaretRestore($_el);
                            break
                        case 8: //Backspace
                            if (posStart != posEnd) {
                                $_el.value = str.substring(0, posStart) + str.substring(posEnd);
                                if (posStart == 0) {
                                    $_el.value = str.substring(posEnd);
                                }
                            } else if (posStart == 0) {
                                // #B390 — native Backspace at position 0 is a
                                // NO-OP: nothing sits before the caret. The
                                // retired rebuild below deleted the FIRST
                                // character instead. No value change, no caret
                                // move, no restore to queue.
                                // $_el.value = str.substring(posStart+1);
                                break;
                            } else {
                                $_el.value = str.substring(0, posStart-1) + str.substring(posEnd);
                            }

                            // #B389 — synchronous caret commit + guarded deferred
                            // restore (the retired tail below re-applied a stale
                            // per-keystroke capture two macrotasks later).
                            // e.currentTarget.setAttribute('readonly', 'readonly');
                            // setTimeout(() => {
                            //     $_el.removeAttribute('readonly');
                            //     setTimeout(() => {
                            //         if (posStart != posEnd) {
                            //             setCaretToPos($_el, posStart);
                            //         } else if (posStart == 0) {
                            //             setCaretToPos($_el, posStart);
                            //         } else {
                            //             setCaretToPos($_el, posStart-1);
                            //         }
                            //     }, 0)
                            //
                            // }, 0);
                            commitCaret($_el, (posStart != posEnd) ? posStart : posStart-1);
                            queueCaretRestore($_el);
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
                            // #B392 — setCaretToPos(-1) at position 0 coerces to
                            // the unsigned maximum and clamps to the END of the
                            // field (measured on WebKit and Chromium): floor at
                            // 0. #B389 — commit through the tracker so a pending
                            // deferred restore cannot undo the arrow move.
                            // setCaretToPos($_el, posStart-1);
                            commitCaret($_el, (posStart > 0) ? posStart-1 : 0);
                            break;
                        case 39: // ArrowRight
                            if (posStart+1 < str.length+1) {
                                // #B389 — through the tracker (see ArrowLeft).
                                // setCaretToPos($_el, posStart+1);
                                commitCaret($_el, posStart+1);
                            }
                            break;
                        // Shortcuts
                        // #B134 — the modifier-chord cases below are unreachable
                        // since the e.metaKey/e.ctrlKey bail at the top of this
                        // handler: chords now run natively, and the native
                        // copy/cut/paste/select-all/undo defaults are correct
                        // where these re-implementations were not (the paste
                        // re-implementation was inert in unprivileged web
                        // content, and undo-to-defaultValue wiped user input).
                        // Kept commented for the record.
                        // case 17: // CTRL
                        // case 91: // CMD
                        //     console.debug("CMD, CTRL hit");
                        //     e.preventDefault();
                        //     break;
                        // case 67: // to handle CMD+C (copy)
                        //     if (
                        //         keyboardMapping[67] && keyboardMapping[91] // mac osx
                        //         ||
                        //         keyboardMapping[67] && keyboardMapping[17] // windows
                        //     ) {
                        //         $_el.setSelectionRange(posStart, posEnd);
                        //         document.execCommand("copy");
                        //         break;
                        //     }
                        // case 86: // to handle CMD+V (paste)
                        //     if (
                        //         keyboardMapping[86] && keyboardMapping[91] // mac osx
                        //         ||
                        //         keyboardMapping[86] && keyboardMapping[17] // windows
                        //     ) {
                        //         if (posStart != posEnd) {
                        //             $_el.value = $_el.value.replace(str.substring(posStart, posEnd), '');
                        //         }
                        //         setCaretToPos($_el, posStart);
                        //         document.execCommand("paste");
                        //         break;
                        //     }
                        // case 88: // to handle CMD+X (cut)
                        //     if (
                        //         keyboardMapping[88] && keyboardMapping[91] // mac osx
                        //         ||
                        //         keyboardMapping[88] && keyboardMapping[17] // windows
                        //     ) {
                        //         $_el.setSelectionRange(posStart, posEnd);
                        //         document.execCommand("cut");
                        //         break;
                        //     }
                        // case 90: // to handle CMD+Z (undo)
                        //     if (
                        //         keyboardMapping[90] && keyboardMapping[91] // mac osx
                        //         ||
                        //         keyboardMapping[90] && keyboardMapping[17] // windows
                        //     ) {
                        //         $_el.value = $_el.defaultValue;
                        //         break;
                        //     }
                        default:
                            // Replace selection
                            if (e.key.length > 1) {
                                break;
                            }
                            if (posStart != posEnd) {
                                $_el.value = str.substring(0, posStart) + e.key;
                                if (posEnd-1 < str.length) {
                                    $_el.value += str.substring(posEnd)
                                }
                            } else if (posStart == 0) {
                                $_el.value = e.key + str.substring(posStart);
                            } else {
                                $_el.value = str.substring(0, posStart) + e.key + str.substring(posEnd);
                            }
                            // #B389 — synchronous caret commit + guarded deferred
                            // restore. The retired tail below only restored the
                            // caret two macrotasks after the `.value` assignment
                            // (which parks it at the end of the field), so a fast
                            // second keystroke read a stale selectionStart and
                            // inserted at the wrong offset — text landed at the
                            // end instead of the caret (gh issue #63).
                            // e.currentTarget.setAttribute('readonly', 'readonly');
                            // // Force restore last caret position
                            // setTimeout(() => {
                            //     $_el.removeAttribute('readonly');
                            //     setTimeout(() => {
                            //         setCaretToPos($_el, posStart+1);
                            //     }, 0);
                            //
                            // }, 0);
                            commitCaret($_el, posStart+1);
                            queueCaretRestore($_el);
                            break;
                    } //EO Switch
                });
            }

        });

    }

    var registerForLiveChecking = function($form, $el) {
        // A form-associated custom element (FACE) is the only hyphenated tagName that
        // reaches this point (collected via getOwnedFaces). It exposes its own `.value`
        // accessor and commits via a composed bubbling `change`, so it must NOT go through
        // the HTMLInputElement value-setter interception (setObserver) — that would clobber
        // the element's own accessor. Its live-check rides the existing form-level /
        // reassociated `change` proxy; no `input`-event wiring is added (a FACE commits via
        // `change` per the author contract, and gina has no `input` proxy for native inputs).
        var isCustomEl = ( $el.tagName.indexOf('-') > -1 );
        // Filter supported elements
        if (
            !isCustomEl && !/^(input|textarea)$/i.test($el.tagName)
            ||
            typeof(gina.events['registered.' + $el.id]) != 'undefined'
        ) {
            return
        }
        // Mutation obeserver - all but type == files, and custom elements (hazard a)
        if ( !isCustomEl && !/^file$/i.test($el.type) ) {
            setObserver($el);
        }
        var liveCheckTimer = null
        switch ($el.tagName.toLowerCase()) {

            case 'textarea':
                addLiveForInput($form, $el, liveCheckTimer, true);
                break;
            default:
                // For a FACE, pass isOtherTagAllowed=true so addLiveForInput enters its
                // body (a custom element has no input `type` to match its own gate) and
                // registers `change.<id>` — re-dispatched by the form-level / reassociated
                // change proxy when the FACE fires its composed bubbling `change`.
                addLiveForInput($form, $el, liveCheckTimer, isCustomEl);
                if ( !isCustomEl ) {
                    // Bypass Safari autocomplete (native inputs only)
                    // #B135 — REAL Safari only: every Chromium UA (Chrome/Edge/
                    // Brave/Opera...) also carries the "Safari/537.36" token, so
                    // the bare /safari/i test matched them all and ran this
                    // WebKit workaround where it was never intended (see the
                    // handleAutoComplete header). WebKit-on-iOS third-party
                    // browsers (CriOS/FxiOS/EdgiOS — no "Chrome"/"Chromium"
                    // token) stay matched on purpose: they run Safari's engine.
                    var isAutoCompleteField = $el.getAttribute('autocomplete');
                    if (
                        /safari/i.test(navigator.userAgent)
                        && !/chrom(e|ium)/i.test(navigator.userAgent)
                        && isAutoCompleteField
                        && /^(off|false)/i.test(isAutoCompleteField)
                    ) {
                        handleAutoComplete($el, liveCheckTimer)
                    }
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
            var customTriggerId = $uploadTrigger.getAttribute('data-gina-form-upload-'+ bindingType +'-trigger');
            if (customTriggerId) {
                uploadResetOrDeleteTriggerId = customTriggerId;
                $uploadResetOrDeleteTrigger = document.getElementById(uploadResetOrDeleteTriggerId);
            }
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
            // #A11Y7/U5 — the generated control is an anchor carrying `role="button"`,
            // and a button MUST activate on Space; an anchor natively answers Enter only,
            // so without this the role would advertise an interaction that does not work.
            // Anchors only: a real <button> already fires click on Space, and binding
            // this there would run the removal twice.
            if ( /^a$/i.test($uploadResetOrDeleteTrigger.tagName) ) {
                addListener(gina, $uploadResetOrDeleteTrigger, 'keydown', function onUploadResetOrDeleteTriggerKeydown(e) {
                    if ( e.key === ' ' || e.keyCode === 32 ) {
                        e.preventDefault(); // Space would otherwise scroll the page
                        onUploadResetOrDelete($uploadTrigger, bindingType);
                    }
                });
            }
            $uploadResetOrDeleteTrigger.isBinded = true;
        } else {
            console.warn('[FormValidator::bindForm][upload]['+$uploadTrigger.id+'] : did not find `upload '+bindingType+' trigger`.\nPlease, make sure that your '+bindingType+' element ID is `'+ uploadResetOrDeleteTriggerId +'`, or add to your file input ('+ $uploadTrigger.id +') -> `data-gina-form-upload-'+bindingType+'-trigger="your-custom-id"` definition.');
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
                // #B149 — an action with NO framework default route is legitimately
                // optional at bind time. `data-gina-form-upload-delete-action` removes
                // an ALREADY-SAVED file, so its endpoint is app-specific — the injected
                // tmp routes cannot serve it and there is deliberately no default (see
                // the public file-uploads guide). Its real enforcement is lazy, at the
                // delete USE site (onUploadResetOrDelete throws when a delete actually
                // fires with no URL). So a missing no-default action is a single debug,
                // never the warn + error + $errorContainer write that used to paint a
                // spurious error on every (re)bind of a working upload-only input.
                if (!defaultRoute) {
                    console.debug('`'+ action +'` not declared for `'+ $el.id +'` (no framework default; optional until a delete is triggered).');
                    return;
                }
                var additionalErrorDetails = null;
                try {
                    uploadActionUrl = routing.getRoute(defaultRoute);
                } catch (err) {
                    additionalErrorDetails = err;
                }

                if (uploadActionUrl) {
                    console.info('Ignore previous warnings regarding upload. I have found a default `'+action+'` route: `'+ defaultRoute +'@'+ uploadActionUrl.bundle +'`');
                    // #B146 — write the attribute that was actually CHECKED (`action`),
                    // not a hardcoded staging attribute. The reset-fallback used to
                    // overwrite the staging action with the reset-default route URL, so
                    // a file input declaring only its staging action had it silently
                    // repointed at the delete route (the staging POST then hit delete).
                    $el.setAttribute(action, uploadActionUrl.toUrl());
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
     * reBindForm
     * Allows form rebinding: it is like reseting validation
     *
     * E.g.:
     * $validator
     *    .getFormById('my-form-id')
     *    .reBind();
     *
     * @param {string} [formId]
     * @param {string} [rules]
     * @param {callback} [cb]
     */
    var reBindForm = function(formId, rules, cb) {
        var $form   = null
            , _id   = null
        ;
        if (
            typeof(this.target) != 'undefined'
            && /FORM/i.test(this.target.tagName)
        ) {
            _id = formId = this.target.getAttribute('id')
        } else if ( /string/i.test(typeof(formId)) ) {
            _id = formId
        }

        if ( typeof(instance.$forms[_id]) != 'undefined') {
            $form = instance.$forms[_id];
        } else {
            throw new Error('form instance `'+ _id +'` not found');
        }

        // reset errors
        resetErrorsDisplay(_id);
        // Unbind form
        unbindForm($form.target);
        // Bind
        if ( typeof(rule) != 'undefined' ) {
            bindForm($form.target, rules);
        } else {
            bindForm($form.target);
        }

        if ( cb ) {
            return cb($form);
        }

        return $form;
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
                _id = ( $target.getAttribute && $target.getAttribute('id') ) ? $form.getAttribute('id') : $form.id;
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
            for (let i = 0, len = $elTMP.length; i < len; ++i) {
                // if button is != type="submit", you will need to provide : data-gina-form-submit
                // TODO - On button binding, you can then provide data-gina-form-action & data-gina-form-method
                $els.push($elTMP[i])
            }
        }

        // submit links
        $elTMP = $form.target.getElementsByTagName('a');
        if ( $elTMP.length > 0 ) {
            for (let i = 0, len = $elTMP.length; i < len; ++i) {
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
            for (let i = 0, len = $elTMP.length; i < len; ++i) {
                $els.push( $elTMP[i] )
            }
        }


        // forms inside main form
        $elTMP = $form.target.getElementsByTagName('form');
        if ( $elTMP.length > 0 ) {
            for (let i = 0, len = $elTMP.length; i < len; ++i) {
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

        // [HTML5 form-reassociation support] Drain per-control listeners attached to
        // reassociated controls during bindForm. The element-by-tagName loops above
        // walk $form.target's descendant tree only, so reassociated controls (which
        // live outside that subtree) are invisible to them. We hold a side-table of
        // {el, evt, fn} triples and remove each listener directly from its element.
        // Direct removeEventListener (not the gina removeListener helper) avoids
        // touching gina.events bookkeeping that the form-level proxies still rely on.
        if ( Array.isArray($form.reassociatedListeners) ) {
            for (let i = 0, len = $form.reassociatedListeners.length; i < len; i++) {
                let entry = $form.reassociatedListeners[i];
                if (entry && entry.el && entry.el.removeEventListener) {
                    entry.el.removeEventListener(entry.evt, entry.fn, false);
                } else if (entry && entry.el && entry.el.detachEvent) {
                    entry.el.detachEvent('on' + entry.evt, entry.fn);
                }
            }
            $form.reassociatedListeners = [];
        }

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
     * @param {object} [$target] - DOM element
     * @param {object|string} [customRule]
     *
     * @return {object} bindedForm
     * */
    /**
     * Tells whether a checkbox posts a boolean derived from its live `.checked`
     * state (#49). A checkbox is boolean-classified when it carries no `value`
     * attribute (the DOM then defaults `.value` to `on`), when its value reads
     * `true` or `false` (the framework's change-time mirror maintains those), or
     * when a validation rule declares `isBoolean` for the field. A checkbox that
     * is NOT boolean-classified is value-carrying: its `value` is the submitted
     * payload and must never be coerced to a boolean.
     *
     * @inner
     * @param {object} $el - Checkbox element
     * @param {object} [rule] - Validation rule object declared for the field
     *
     * @returns {boolean} isBooleanCheckbox
     */
    var isBooleanCheckbox = function($el, rule) {
        return (
            $el.getAttribute('value') === null
            || /^(true|false)$/.test($el.value)
            || typeof(rule) != 'undefined' && rule && typeof(rule.isBoolean) != 'undefined'
        ) ? true : false;
    }

    /**
     * Legacy opt-in (#49 — deprecated, transitional): when the form carries
     * `data-gina-form-checkbox-value-as-state="true"`, a checkbox's `value`
     * attribute keeps deciding its initial checked state like it did before
     * the fix. Default is the HTML-spec behavior: only the `checked`
     * attribute decides the initial state.
     *
     * @inner
     * @param {object} $form - Form object (`instance.$forms[id]` shape)
     *
     * @returns {boolean} isCheckboxValueAsState
     */
    var isCheckboxValueAsState = function($form) {
        return /^true$/i.test($form.target.dataset.ginaFormCheckboxValueAsState) ? true : false;
    }

    /**
     * #B125: tells whether the form EXPLICITLY declares the checkbox state
     * model via `data-gina-form-checkbox-value-as-state` — any value counts:
     * "true" is the legacy opt-in, anything else (canonically "false")
     * declares the spec model. The #49 migration warns only fire when the
     * attribute is entirely absent: an author who declares the model has
     * already read it, so the migration aid has nothing left to teach — and
     * the payload-only shape (`value="true"` with no `checked`, intended
     * unticked) is legitimate post-#49 markup that is byte-identical to
     * pre-#49 markup at the attribute level, so the declaration is the only
     * intent signal available.
     *
     * @inner
     * @param {object} $form - Form object (`instance.$forms[id]` shape)
     *
     * @returns {boolean} isCheckboxStateModelDeclared
     */
    var isCheckboxStateModelDeclared = function($form) {
        return ( typeof($form.target.dataset.ginaFormCheckboxValueAsState) != 'undefined' ) ? true : false;
    }
    // one warn per field id per page load (migration aid, #49)
    var checkboxValueStateWarned = {};

    var bindForm = function($target, customRule) {

        var $form   = null
            , _id   = null
            , rules = ( typeof(local.rules.count() > 0 ) ) ? local.rules : instance.rules
        ;

        if (
            typeof($target) == 'undefined'
            && typeof(this.target) != 'undefined'
            && /FORM/i.test(this.target.tagName)
            ||
            !/object/i.test( typeof($target) )
        ) {
            _id = this.target.id || this.target.getAttribute('id');
        } else if ( /string/i.test(typeof($target)) ) {
            _id = $target
        } else {
            _id = $target.getAttribute('id')
        }

        try {
            if ( typeof(instance.$forms[_id]) != 'undefined') {
                $form = instance.$forms[_id];
                if ( typeof($form.target) == 'undefined' ) {
                    throw new Error('Validator::bindForm($target, customRule): `$target` must be a DOM element\n');
                }
                $target = $form.target;
            } else {
                throw new Error('form instance `'+ _id +'` not found');
            }
        } catch(err) {
            throw new Error('Validator::bindForm($target, customRule) could not bind form `'+ $target +'`\n'+err.stack );
        }

        // #A11Y2 — stand the polite live region up HERE, at bind time, rather than lazily on the
        // first error. Creating and populating it in one tick reaches assistive tech as a single
        // mutation batch that is commonly never spoken, so the first announcement per form used to
        // be the one most likely lost. Every registration path funnels through bindForm, so this
        // one call covers them all. Announcing stays announceA11yError's job; this only creates.
        ensureA11yLiveRegion($target);

        // console.debug('binding for: '+ _id);
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

        // Side-table for per-control listeners attached on form-reassociated controls
        // (controls whose form="X" attribute points at $target but which live OUTSIDE
        // $target's DOM subtree). Drained by unbindForm.
        if (!Array.isArray($form.reassociatedListeners))
            $form.reassociatedListeners = [];

        // Helper: collect controls owned by $form, including HTML5 form-reassociated
        // controls (those carrying `form="X"` outside the form's DOM subtree). Walks
        // $form.elements (HTMLFormControlsCollection — owner-aware) for the primary set,
        // then a secondary in-tree sweep filtered by `.form === $form` to catch elements
        // HTMLFormControlsCollection skips (type=image, nameless+idless). The `.form`
        // filter also excludes in-tree descendants whose `form="..."` points at a different
        // form (parent-form contamination guard).
        var getOwnedElements = function($form, tag) {
            // #B333 — dedup by NODE IDENTITY, not by id. The old `seen` table was
            // id-keyed, so an ID-LESS control already collected from `$form.elements`
            // was pushed a second time by the in-tree sweep (`!$el.id` passed the old
            // condition unconditionally). For an id-less `<button type=submit>` —
            // gina auto-assigns its id only later, in the submit-binding loop — the
            // double entry meant `bindSubmitEl` ran twice and every click executed
            // TWO full validate()+send() cycles. `arr.indexOf($el)` is an identity
            // test, so the same node can never enter twice regardless of id state.
            var arr  = []
                , tagUpper = tag.toUpperCase()
            ;
            for (let i = 0, len = $form.elements.length; i < len; i++) {
                let $el = $form.elements[i];
                if ($el.tagName === tagUpper) {
                    arr.push($el);
                }
            }
            var inTree = $form.getElementsByTagName(tag);
            for (let i = 0, len = inTree.length; i < len; i++) {
                let $el = inTree[i];
                // was: if ($el.form === $form && (!$el.id || !seen[$el.id])) {
                if ($el.form === $form && arr.indexOf($el) === -1) {
                    arr.push($el);
                }
            }
            return arr;
        };

        // Form-associated custom elements (FACEs). `form.elements` only contains
        // form-ASSOCIATED members, so the only hyphenated tagName it can hold is a
        // form-associated custom element (an unregistered / non-form-associated custom
        // element is an HTMLUnknownElement and never joins the collection). Widening the
        // bind coverage here — rather than in getOwnedElements' single-tag matcher — keeps
        // that helper unchanged for the native input/textarea/select/button paths.
        var getOwnedFaces = function($form) {
            var arr = [];
            for (let i = 0, len = $form.elements.length; i < len; i++) {
                let $el = $form.elements[i];
                if ( $el.tagName.indexOf('-') > -1 ) {
                    arr.push($el);
                }
            }
            return arr;
        };

        // binding form elements
        var type            = null
            , id            = null

            // a|links — DOM-tree only (anchor elements don't carry the HTMLFormControlsCollection
            // owner relationship; reassociated <a data-gina-form-submit> is not a documented pattern)
            , $a            = $target.getElementsByTagName('a')
            // input type: checkbox, radio, hidden, text, files, number, date ...
            , $inputs       = getOwnedElements($target, 'input')
            // textarea
            , $textareas    = getOwnedElements($target, 'textarea')
            // select
            , $select       = getOwnedElements($target, 'select')
            // form-associated custom elements (FACE)
            , $faces        = getOwnedFaces($target)
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
        //         elId += uuid();
        //         $a[f].setAttribute('id', elId)
        //     }
        // }
        // EO Binding a

        // BO Binding textarea
        for (let f = 0, len = $textareas.length; f < len; ++f) {
            checkForRuleAlias($form.rules, $textareas[f]);
            elId = $textareas[f].getAttribute('id');
            if (!elId || elId == '') {
                elId = 'textareas.' + uuid();
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

        // BO Binding form-associated custom elements (FACE)
        // A FACE already participates in the form's control collection, so value
        // harvest, validation, serialization and error render (all name-keyed and
        // tag-agnostic) already cover it at submit. This loop adds the bind-layer
        // parity a native control gets: auto-id, dirty tracking (fieldsSet) and
        // live-check. The value-setter interception (setObserver) is deliberately
        // skipped for custom tags inside registerForLiveChecking — a FACE exposes its
        // own `.value` accessor and commits via a composed bubbling `change`.
        for (let f = 0, len = $faces.length; f < len; ++f) {
            // A FACE exposes its owning form + name via ElementInternals / the `name`
            // attribute — NOT the element-level `.form` / `.name` properties that native
            // controls reflect. The validator's live-check path reads `$el.form`,
            // `$el.name` and `event.target.form`, so surface them on the element for that
            // path (a FACE that already exposes them — e.g. via its own getters — is left
            // untouched). Without this, addLiveForInput/setObserver dereference an
            // undefined `$el.form` and the whole form scan throws.
            if ( typeof($faces[f].form) == 'undefined' || $faces[f].form == null ) {
                try { Object.defineProperty($faces[f], 'form', { value: $form.target, configurable: true, writable: true }); } catch (e) {}
            }
            if ( (typeof($faces[f].name) == 'undefined' || !$faces[f].name) && $faces[f].getAttribute('name') ) {
                try { Object.defineProperty($faces[f], 'name', { value: $faces[f].getAttribute('name'), configurable: true, writable: true }); } catch (e) {}
            }
            checkForRuleAlias($form.rules, $faces[f]);
            elId = $faces[f].getAttribute('id');
            if (!elId || elId == '') {
                elId = 'face.' + uuid();
                $faces[f].setAttribute('id', elId)
            }
            if (!$form.fieldsSet[ elId ]) {
                let defaultValue = $faces[f].value || '';
                $form.fieldsSet[elId] = {
                    id: elId,
                    name: $faces[f].getAttribute('name') || null,
                    value: $faces[f].value || '',
                    defaultValue: defaultValue
                }
            }
            // Adding live check
            if (/^true$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) {
                registerForLiveChecking($form, $faces[f]);
            }
        }
        // EO Binding form-associated custom elements (FACE)

        // BO Binding input
        for (let f = 0, len = $inputs.length; f < len; ++f) {
            checkForRuleAlias($form.rules, $inputs[f]);
            elId = $inputs[f].getAttribute('id');
            if (!elId || elId == '') {
                elId = 'input.' + uuid();
                $inputs[f].setAttribute('id', elId)
            }

            if (!$form.fieldsSet[ elId ]) {
                let defaultValue = $inputs[f].value;
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

                    // Read the IDL `defaultChecked` (which mirrors the HTML `checked`
                    // attribute) instead of the live `.checked`. For form-reassociated
                    // radios hit by Chromium's parse-time IDL/attribute desync — sister
                    // bug to the updateRadio reconciliation at commit 80dd89f9 — `.checked`
                    // reads FALSE at bind time despite the attribute being present, so
                    // caching from `.checked` would hold the wrong default and a subsequent
                    // form-reset would clear the originally-checked option.
                    // #49: the value-derived clause (a checkbox whose `value` reads
                    // true/on used to be treated as checked-by-default) is legacy
                    // behavior, now gated on the form's explicit opt-in.
                    $form.fieldsSet[elId].defaultChecked = (
                                                            $inputs[f].defaultChecked
                                                            ||
                                                            isCheckboxValueAsState($form)
                                                            && /^(true|on)$/.test(defaultValue)
                                                            && /^(checkbox)$/i.test($inputs[f].type)
                                                        ) ? true : false;

                    if (/^radio$/i.test($inputs[f].type) ) {
                        $form.fieldsSet[elId].value = $inputs[f].value;
                        $form.fieldsSet[elId].defaultValue = $inputs[f].value;
                    }

                    // Migration aid (#49): this markup used to be auto-ticked by its
                    // `value` — surface it once so the author adds `checked` or the
                    // legacy form opt-in.
                    if (
                        /^(checkbox)$/i.test($inputs[f].type)
                        && !isCheckboxValueAsState($form)
                        && !isCheckboxStateModelDeclared($form)
                        && !$inputs[f].hasAttribute('checked')
                        && /^(true|on)$/i.test($inputs[f].getAttribute('value'))
                        && !checkboxValueStateWarned[elId]
                    ) {
                        checkboxValueStateWarned[elId] = true;
                        console.warn('[ FormValidator ] checkbox `'+ elId +'`: `value` no longer implies the checked state; add the `checked` attribute if it must render ticked, or set `data-gina-form-checkbox-value-as-state="true"` on the form to restore the legacy behavior. If the unticked rendering is intended, remove the `value` attribute (a boolean checkbox posts its live checked state either way), or set `data-gina-form-checkbox-value-as-state="false"` on the form to declare the current model and silence migration warnings');
                    }

                    // Migration aid (#49) — the mirror direction: this markup used to be
                    // auto-UN-ticked by its `value` (the pre-fix init pass cleared a
                    // parser-checked box whose resolved value read false/empty) and now
                    // stays ticked. Membership mirrors the old resolution chain:
                    // `data-value` attribute, else `value` attribute, else the DOM
                    // `.value` — with the empty string mapping to false. Reads run
                    // before the checkbox init pass, so `.value` is parser-fresh here.
                    var legacyUntickValue = $inputs[f].getAttribute('data-value') || $inputs[f].getAttribute('value') || $inputs[f].value;
                    if (
                        /^(checkbox)$/i.test($inputs[f].type)
                        && !isCheckboxValueAsState($form)
                        && !isCheckboxStateModelDeclared($form)
                        && $inputs[f].hasAttribute('checked')
                        && ( legacyUntickValue === '' || /^false$/i.test(legacyUntickValue) )
                        && !checkboxValueStateWarned[elId]
                    ) {
                        checkboxValueStateWarned[elId] = true;
                        console.warn('[ FormValidator ] checkbox `'+ elId +'`: `value` no longer un-ticks a checked box; remove the `checked` attribute if it must render unticked, or set `data-gina-form-checkbox-value-as-state="true"` on the form to restore the legacy behavior. If the ticked rendering is intended, set `data-gina-form-checkbox-value-as-state="false"` on the form to declare the current model and silence migration warnings');
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
                            let file = $img.src.substring($img.src.lastIndexOf('/')+1);
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

                // #R8 slice 2 — drag-and-drop: bind the (optional) declarative
                // dropzone at form-bind time — a drop can be the FIRST
                // interaction, no picker click required
                bindUploadDropzone($inputs[f]);

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
                    var eventOnProgress = $el.getAttribute('data-gina-form-upload-on-progress'); // #R8
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
                                // #R8 — upload-progress indicator target: stored as a STRING id
                                // (errorField's convention — resolved to an element at update
                                // time), unlike previewContainer below which stores the element
                                var progressContainer   = $el.getAttribute('data-gina-form-upload-progress') || ( (fieldId) ? fieldId + '-progress' : null );
                                // #R8 slice 2 - dropzone target: EXPLICIT id only, deliberately
                                // no default id (see bindUploadDropzone)
                                var dropzoneContainer   = $el.getAttribute('data-gina-form-upload-dropzone') || null;
                                var previewContainer    = $el.getAttribute('data-gina-form-upload-preview') || fieldId + '-preview';
                                previewContainer        = (isPopinContext())
                                                        ? $activePopin.$target.getElementById(previewContainer)
                                                        : document.getElementById(previewContainer);

                                // #B147 — previewContainer is a getElementById RESULT
                                // (element or null); typeof(null) is 'object', so the
                                // bare typeof check passed for a MISS, stored a null
                                // container, and the success handler later dereferenced
                                // it (TypeError). Require a truthy element — the
                                // architecture-index typeof-null guard pattern.
                                if ( typeof(previewContainer) != 'undefined' && previewContainer ) {
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
                                            // #B459 — `preview` is the one slot that is never a flat input:
                                            // its value is an OBJECT (`{location, uri, tmpUri, width, height}`),
                                            // which an input's `.value` can only hold as "[object Object]".
                                            // A form that declares no `[preview][...]` sub-fields gets an
                                            // EMPTY sub-field map instead, so the fill loop still visits the
                                            // key (the nested thumbnail is rendered from there) and posts
                                            // nothing for it — the documented field set. Declaring the
                                            // sub-fields stays the opt-in for persisting the preview.
                                            if ( mandatoryFields[m] == 'preview' ) {
                                                hiddenFields[_f].preview = {};
                                                continue;
                                            }

                                            _name = fieldPrefix +'['+ _f +']['+ mandatoryFields[m] +']';
                                            // create input & add it to the form
                                            $newVirtualField = document.createElement('input');
                                            $newVirtualField.type = 'hidden';
                                            $newVirtualField.id = 'input.' + uuid();
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
                                    progressContainer   : progressContainer, // #R8 — string id
                                    dropzoneContainer   : dropzoneContainer, // #R8 slice 2 — string id, explicit-only
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
                            // #R8 — upload-progress event (no default: absent attribute
                            // means no `.hform` progress channel for this upload form)
                            if (eventOnProgress) {
                                $uploadForm.setAttribute('data-gina-form-event-on-upload-progress', eventOnProgress);
                            }


                            // adding for to current document
                            if (isPopinContext()) {
                                //$activePopin.$target.appendChild($uploadForm)
                                document.getElementById($activePopin.id).appendChild($uploadForm)
                            } else {
                                document.body.appendChild($uploadForm)
                            }
                        }

                        // #R8 — upload-progress kickoff: show activity from selection
                        // time (covers the FileReader read/assembly phase before the
                        // first wire event). Runs on EVERY selection — the create
                        // block above is create-only.
                        if ( $uploadForm.uploadProperties && $uploadForm.uploadProperties.progressContainer ) {
                            updateUploadProgressIndicator($uploadForm.uploadProperties.progressContainer, 'preparing');
                        }

                        // #A11Y7/U2 — announce the transition into "uploading". Note this
                        // is deliberately NOT gated on `progressContainer`: the indicator is
                        // opt-in by presence, but a user who cannot see it is precisely the
                        // one who needs to be told the upload began.
                        // The announcement targets the file input's REAL owning form, not
                        // `$uploadForm` (the virtual one built just above): the real form is
                        // where `bindForm` already stood up a live region, so upload status
                        // and validation errors share one region instead of splitting across
                        // two. Selection always sends today — the `.send()` below is
                        // unconditional and `data-gina-file-autosend="false"` is still a TODO
                        // — so this is a true start; gate it if that ever lands.
                        if ( $uploadForm.uploadProperties && $uploadForm.uploadProperties.uploadTriggerId ) {
                            var $a11yUploadInput = document.getElementById($uploadForm.uploadProperties.uploadTriggerId);
                            if ( $a11yUploadInput && $a11yUploadInput.form ) {
                                announceA11yStatus($a11yUploadInput.form, a11yLabel('uploadStarted'));
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
            // #B176: the `&&` used to sit INSIDE test() — an explicit
            // `data-gina-form-live-check-enabled="false"` (a truthy string)
            // short-circuited to the rules-count boolean, which stringifies
            // to "true" and matched, so THIS gate ignored the opt-out.
            // Scope (measured at the fix's parent): only this gate and the
            // bindForm silent-validation gate were defective. The three
            // registerForLiveChecking sites already tested the attribute
            // alone, so an opted-out form never got text as-you-type — the
            // pre-fix behaviour was an incoherent middle, not a wholesale
            // ignore. Do not restate this as "the opt-out did nothing".
            // was: /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled && $form.rules.count() > 0)
            if (
                /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) && $form.rules.count() > 0
                // && typeof($form.isBeingReseted) == 'undefined'
            ) {
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
                    var gValidatorInfos = excludeWithheldAutofill(getFormValidationInfos($gForm, rules)); // #B478
                    gFields  = gValidatorInfos.fields;
                    $gFields = gValidatorInfos.$fields;
                    var formId = $gForm.getAttribute('id');
                    gRules   = instance.$forms[formId].rules;
                    // Don't be tempted to revome fields that has already been validated
                    instance.$forms[formId].isValidating = true;
                    validate($gForm, gFields, $gFields, gRules, function onSilentGlobalLiveValidation(gResult){
                        instance.$forms[formId].isValidating = false;
                        console.debug('[updateSelect]: onSilentGlobalLiveValidation: '+ gResult.isValid(), gResult);
                        // Fixed on 2025-03-16
                        var isFormValid = gResult.isValid();
                        if (!isFormValid) {
                            instance.$forms[formId].errors = gResult.error;
                            // Fixed on 2026-04-09 - only display errors for the touched field
                            var _touchedField = event.target.name;
                            if ( typeof(gResult.error[_touchedField]) != 'undefined' ) {
                                handleErrorsDisplay($gForm, gResult.error, gResult.data, _touchedField);
                            }
                        }
                        // #B136 — same stale-clear as processEvent's global pass (keep the
                        // two copies in sync): the fresh pass is valid but the store still
                        // holds earlier errors — clear each previously-errored field's
                        // display, not just the touched field's.
                        else if ( isFormValid && instance.$forms[formId].errors && instance.$forms[formId].errors.count() > 0 ) {
                            var staleErrors = instance.$forms[formId].errors;
                            instance.$forms[formId].errors = {};
                            for (var staleField in staleErrors) {
                                handleErrorsDisplay($gForm, {}, null, staleField);
                            }
                        }

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
                elId = 'select.' + uuid();
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
            // #49: value-driven initial ticking is legacy behavior — the HTML `checked`
            // attribute decides the initial state unless the form explicitly opts in.
            if (isInit && isLocalBoleanValue && isCheckboxValueAsState($form)) { // on checkbox init (legacy value-as-state mode)
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

            // [HTML5 form-reassociation] Reconcile the IDL `.checked` property with the
            // `checked` HTML attribute on init when they disagree. Background: when
            // multiple form-reassociated radios share a `name` AND are DOM descendants of
            // a common ancestor `<form>`, Chromium-based browsers uncheck the earlier ones
            // at parse time even though each radio belongs to a distinct form-owner per
            // the HTML5 spec — leaving `.checked = false` while the `checked` HTML
            // attribute is still present. Aligning the IDL state with the attribute
            // matches the author's intent and is a no-op for the normal (non-reassociated)
            // shape where the two already agree.
            if ( isInit && !$el.checked && $el.hasAttribute('checked') ) {
                $el.checked = true;
            }

            var checked = $el.checked, evt = null;
            var isBoolean = /^(true|false)$/i.test($el.value);

            // [HTML5 form-reassociation] Scope the mutual-exclusion peer set by form-owner
            // per HTML5 spec ("the radio button group that contains a radio button a also
            // contains all the other input elements b that fulfill ... b's form owner is
            // a's form owner"). `getElementsByName` returns same-name radios across the
            // whole document regardless of owner — without this filter, unchecking peers
            // cross-fires into other forms whose radios happen to share the name.
            var rawRadioGroup = document.getElementsByName($el.name);
            radioGroup = Array.prototype.filter.call(rawRadioGroup, function(_r) {
                return _r.form === $el.form;
            });

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
                $inputs[i].id = type +'-'+ uuid();
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

        // [HTML5 form-reassociation support] Form-level proxy handler bodies extracted as
        // named expressions so the same handlers can be attached on $target (form-level —
        // captures bubbled events from in-tree controls) AND on each reassociated control
        // (per-control — events on reassociated controls bubble through THEIR ancestors,
        // not through $target, so the form-level listener never fires for them). Handler
        // bodies read event.target.id and dispatch via gina.events; they don't depend on
        // event.currentTarget being the form (the few places that reference currentTarget
        // are guarded fallbacks that no-op on a control).
        var resetProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
            if (
                typeof(event.defaultPrevented) != 'undefined'
                && event.defaultPrevented
            ) {
                return false;
            }
            event.preventDefault();
            var _evt = $el.id;
            if (!_evt) return false;
            if ( !/^reset\./.test(_evt) ) {
                _evt = 'reset.'+$el.id
            }
            if (gina.events[_evt]) {
                triggerEvent(gina, $el, _evt, event.detail);
            }
        };
        var keydownProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
            if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
            return false;

            keyboardMapping[event.keyCode] = event.type == 'keydown';

            var _evt = $el.id;
            if (!_evt) return false;

            if ( !/^keydown\./.test(_evt) ) {
                _evt = 'keydown.'+$el.id
            }
            if (gina.events[_evt]) {
                // #B444 - dispatch FIRST and let the namespaced handler decide:
                // the native keydown is cancelled only when that handler asked
                // for it (it prevents the synthetic event on the paths it
                // re-implements, and deliberately does not on modifier chords,
                // per the interception's own contract). Cancelling BEFORE the
                // dispatch suppressed the browser's own editing commands for
                // every chord - on a real-Safari UA that made paste, select-all,
                // copy, cut and undo all dead on any live-checked
                // autocomplete-suppressed field, with no event observable
                // anywhere (gh issue #67).
                // was: cancelEvent(event); triggerEvent(gina, $el, _evt, event.detail, event);
                var _syntheticEvt = triggerEvent(gina, $el, _evt, event.detail, event);
                if ( _syntheticEvt && _syntheticEvt.defaultPrevented ) {
                    cancelEvent(event);
                }
            }
        };
        var keyupProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
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
        };
        var focusinProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
            if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
            return false;

            var _evt = $el.id;
            if (!_evt) return false;

            if ( !/^focusin\./.test(_evt) ) {
                _evt = 'focusin.'+$el.id
            }
            if (gina.events[_evt]) {
                cancelEvent(event);

                // event.target.form works for both in-tree and reassociated controls
                // (form-association is owner-relationship-aware); event.currentTarget
                // is the form when attached form-level, the control when per-control.
                var formId      = event.target.form.getAttribute('id') || ((event.currentTarget && event.currentTarget.getAttribute) ? event.currentTarget.getAttribute('id') : null);
                var lastFocused = {
                    id  : $el.id,
                    name: $el.name
                };
                if (!instance.$forms[formId].lastFocused.length) {
                    instance.$forms[formId].lastFocused[0] = lastFocused;
                } else {
                    instance.$forms[formId].lastFocused.splice(0,0,lastFocused);
                }
                lastFocused = ( typeof(instance.$forms[formId].lastFocused[1]) != 'undefined' ) ? instance.$forms[formId].lastFocused[1].id : null;

                instance.$forms[formId].lastFocused.splice(2);

                triggerEvent(gina, $el, _evt, event.detail);
            }
        };
        var focusoutProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
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
        };
        var changeProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387
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
        };
        var clickProxyHandler = function(event) {
            var $el = event.target;
            releaseAnswerFocusHold(event); // #B387

            // a click target removed from the DOM during its own dispatch
            // (e.g. an upload preview's reset/delete link) has no parent by
            // the time the event bubbles up to the form — nothing left to
            // proxy, and every parentNode read below would throw
            if ( !$el || !$el.parentNode ) {
                return;
            }

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
                $el = event.target.control || event.target.parentNode.control;

            }
            if (
                !$el.disabled
                && /(checkbox|radio)/i.test($el.type)
                && !isCaseIgnored
            ) {
                if ( /checkbox/i.test($el.type) ) {
                    return updateCheckBox($el);
                } else if ( /radio/i.test($el.type) ) {
                    return updateRadio($el, false, true);
                }
            }


            if (
                /(button|input)/i.test($el.tagName) && /(submit|checkbox|radio)/i.test($el.type)
                || /a/i.test($el.tagName) && $el.attributes.getNamedItem('data-gina-form-submit')
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
                    // For form-level (event.currentTarget == form), reads the form's
                    // method attribute. For per-control on a reassociated submit, the
                    // currentTarget fallback yields null and the if(newFormMethod) below
                    // skips the override block — typical reassociated submits don't need it.
                    var newFormMethod = null;
                    var $methodSrc = (event.currentTarget && event.currentTarget.getAttribute) ? event.currentTarget : ($el.form || null);
                    if (namedItem) {
                        newFormMethod = $el.getAttribute('data-gina-form-submit-method') || ($methodSrc ? $methodSrc.getAttribute('method') : null);
                    } else {
                        newFormMethod = $el.parentNode.getAttribute('data-gina-form-submit-method') || ($methodSrc ? $methodSrc.getAttribute('method') : null);
                    }
                    if (newFormMethod) {
                        if (namedItem && $el.form) {
                            if ($el.form.setAttribute) {
                                $el.form.setAttribute('method', newFormMethod);
                            } else if (event.currentTarget && event.currentTarget.setAttribute) {
                                event.currentTarget.setAttribute('method', newFormMethod);
                            }
                        } else if ($el.parentNode.form) {
                            if ($el.parentNode.form.setAttribute) {
                                $el.parentNode.form.setAttribute('method', newFormMethod);
                            } else if (event.currentTarget && event.currentTarget.setAttribute) {
                                event.currentTarget.setAttribute('method', newFormMethod);
                            }
                        }
                    }
                }
                if ( typeof($el.id) == 'undefined' || !$el.getAttribute('id') ) {
                    $el.setAttribute('id', 'click.' + uuid() );
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

                    if (
                        !$el.disabled
                        && /(checkbox|radio)/i.test($el.type)
                    ) {
                        if ( /checkbox/i.test($el.type) ) {
                            return updateCheckBox($el);
                        } else if ( /radio/i.test($el.type) ) {
                            return updateRadio($el, false, true);
                        }
                    }

                    if ( typeof(event.defaultPrevented) != 'undefined' && event.defaultPrevented )
                        return false;

                    if (
                        $el.type == 'submit' && !/^submit\./i.test(_evt)
                        ||
                        isCustomSubmit && !/^submit\./i.test(_evt)
                    ) {
                        _evt = 'submit.'+_evt;
                        instance.$forms[$form.id].submitTrigger = $form.submitTrigger = $el.id;
                    }
                    if ( $el.type == 'reset' && !/^reset\./i.test(_evt) ) {
                        _evt = 'reset.'+_evt
                    }

                    // #B246 — a gated or disabled submit trigger must not run the submit
                    // cycle. `updateSubmitTriggerState()` marks an invalid form's trigger
                    // with `data-gina-form-submit-gated` + a class (#B312 — the
                    // framework's own channel, no ARIA claim, precisely so the click
                    // still reaches us and the vocabulary stays honest), and
                    // `isTriggerDisabled` ALSO honours an AUTHORED aria/native disabled
                    // mark and the anchor in-flight lock.
                    //
                    // Intercept HERE — before the `submit.<id>` dispatch below — so
                    // `bindSubmitEl`'s handler never runs, `isSubmitting` is never latched
                    // and no send path is reachable. The click is still answered with a
                    // display-only reveal, so the user learns WHY the trigger is refused
                    // (which is what the operable-trigger design was bought for).
                    // Checked on the CLICKED element, not `$formInstance.submitTrigger`:
                    // a form may carry several submit buttons and only one registers.
                    //
                    // #B346 carve-out — when the gate's ONLY reason is a `query` verdict
                    // still on the wire (framework gated mark alone, no committed errors,
                    // in-flight marker present), the reveal has NOTHING to reveal and the
                    // refusal ate the click silently. Let that one state through: the
                    // normal submit cycle latches, arms its waiter, and the pending
                    // settle completes it (#B342) — valid ⇒ send, invalid ⇒ render +
                    // release. Every other refusal shape is unchanged.
                    if (
                        /^submit\./i.test(_evt) && isTriggerDisabled($el)
                        && !isAwaitingQueryVerdictOnly($el, $target, instance.$forms[$form.id] || $form)
                    ) {
                        cancelEvent(event);
                        revealValidationState( instance.$forms[$form.id] || $form );
                        return false;
                    }

                    // #B247 — arm the loading state on the element the user actually
                    // operated. DELIBERATELY after the #B246 gate above: a disabled
                    // trigger returns without starting anything, so arming it there
                    // would strand exactly the state this feature exists to release.
                    // `resolveTrigger` climbs to the owning button/anchor, because a
                    // click on a wrapped label (`<button><span>Save</span></button>`)
                    // targets the inner node, and the state belongs on the control the
                    // user perceives as the trigger.
                    if ( /^submit\./i.test(_evt) ) {
                        armSubmitLoading(
                            instance.$forms[$form.id] || $form,
                            loadingState.resolveTrigger($el, $target)
                        );
                    }

                    if (gina.events[_evt]) {
                        // #B294 — submit binding is TWO-STAGE and only the first stage is
                        // delegated. The native click proxy lives on the FORM (:8090) and
                        // survives any re-render; the listener that does the work is
                        // attached to the trigger NODE by `bindSubmitEl` (:8231). Because
                        // `gina.events` is a name -> id-STRING registry, the `submit.<id>`
                        // key outlives the node, so after an AJAX/popin re-render replaces
                        // the trigger this gate still passes: `cancelEvent` below suppresses
                        // the native submit and `triggerEvent` fires at a node that has no
                        // listener. The form does not even fall back to a normal submit, and
                        // nothing self-heals — `bindForm` latches `binded` (:8580) and is
                        // never re-entered on DOM replacement — so the trigger was
                        // permanently and silently dead.
                        // Re-bind the live node when its marker is absent. A clone cannot
                        // inherit the expando, so this fires exactly once per replacement
                        // and is a no-op on the normal path.
                        if ( $el && $el.__ginaSubmitBoundFor !== _evt ) {
                            bindSubmitEl(_evt, $el);
                        }
                        cancelEvent(event);

                        triggerEvent(gina, $el, _evt, event.detail);
                    } else if (
                        isCustomSubmit
                        && typeof(this.id) != 'undefined'
                        && this.id != ''
                        && typeof(gina.validator.$forms[this.id]) != 'undefined'
                    ) {
                        gina.validator.getFormById(this.id).submit();
                        cancelEvent(event);
                    }

                }
            }
        };
        var autofillProxyHandler = function(event) {
            // #B478 - a browser autofill (saved credentials, an address) lands
            // without a keystroke, and on Chrome without an `input`/`change`
            // either until a later user gesture, so the live check had nothing
            // to react to and the trigger kept its bind-time gated look on a
            // form the user could see was complete. The default stylesheet
            // (autofill.scss) gives every autofilled control - `:autofill` /
            // `:-webkit-autofill` - a 1ms keyframe named `gina-autofill-start`;
            // the fill therefore surfaces as this bubbling `animationstart`,
            // the one signal every native fill produces at fill time.
            //
            // Readable value: route it into the control's own live check as
            // the `change.<id>` it already registered - the field renders its
            // verdict and the whole-form pass syncs the trigger, exactly as a
            // typed value would. Withheld value (Chrome reads '' until the
            // gesture, measured on Chrome 152): re-derive the gate SILENTLY
            // instead - a field pass on '' would record `isRequired` and
            // render a false "required" error on a field the user can see is
            // populated.
            if ( !event || event.animationName !== 'gina-autofill-start' ) {
                return;
            }
            var $el = event.target;
            if ( !$el || !$el.id || !$el.form ) {
                return;
            }
            var _evt = 'change.' + $el.id;
            if ( typeof(gina.events[_evt]) == 'undefined' ) {
                return; // not a live-checked control
            }
            if ( isAutofillValueWithheld($el) ) {
                revalidateSilently( instance.$forms[$el.form.getAttribute('id')] );
                return;
            }
            triggerEvent(gina, $el, _evt, event.detail);
        };

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
            // Form-level proxies: capture bubbled events from in-tree controls.
            addListener(gina, $target, 'reset', resetProxyHandler);
            addListener(gina, $target, 'keydown', keydownProxyHandler);
            addListener(gina, $target, 'keyup', keyupProxyHandler);
            addListener(gina, $target, 'focusin', focusinProxyHandler);
            addListener(gina, $target, 'focusout', focusoutProxyHandler);
            addListener(gina, $target, 'change', changeProxyHandler);
            addListener(gina, $target, 'click', clickProxyHandler);
            addListener(gina, $target, 'animationstart', autofillProxyHandler); // #B478
        }

        proceed();

        // [HTML5 form-reassociation support] Per-control listener attachment for
        // reassociated controls (form="X" pointing at $target but living outside
        // $target's DOM subtree). Native events on these controls bubble through
        // their actual ancestors, not through $target, so the form-level proxies
        // above never see them. Per-control listeners ensure the proxy logic runs.
        // Tracked on $form.reassociatedListeners for unbindForm cleanup.
        //
        // Skipped events:
        //  - 'reset': fires on the form directly when reset() is called or a reset
        //    button submits to the form, regardless of where the button lives. The
        //    form-level reset listener above captures this for both cases.
        //  - 'submit': fires on the form directly when submit() is called or a submit
        //    button submits. Same reasoning as reset.
        for (let _rIdx = 0, _rLen = $target.elements.length; _rIdx < _rLen; _rIdx++) {
            let $rEl = $target.elements[_rIdx];
            if (!$target.contains($rEl)) {
                addListener(gina, $rEl, 'keydown', keydownProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'keydown', fn: keydownProxyHandler });
                addListener(gina, $rEl, 'keyup', keyupProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'keyup', fn: keyupProxyHandler });
                addListener(gina, $rEl, 'focusin', focusinProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'focusin', fn: focusinProxyHandler });
                addListener(gina, $rEl, 'focusout', focusoutProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'focusout', fn: focusoutProxyHandler });
                addListener(gina, $rEl, 'change', changeProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'change', fn: changeProxyHandler });
                addListener(gina, $rEl, 'click', clickProxyHandler);
                $form.reassociatedListeners.push({ el: $rEl, evt: 'click', fn: clickProxyHandler });
                addListener(gina, $rEl, 'animationstart', autofillProxyHandler); // #B478
                $form.reassociatedListeners.push({ el: $rEl, evt: 'animationstart', fn: autofillProxyHandler });
            }
        }





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
                } else {
                    // #B192 — release the submit latch. A rejected submit sends nothing, so it
                    // never reaches the XHR settle (`xhr.onreadystatechange`), which was the only
                    // other site clearing `isSubmitting`. Left latched, the live-check field
                    // listener hard-returns on every subsequent keystroke, `updateSubmitTriggerState`
                    // never runs again and the submit trigger keeps `aria-disabled="true"` +
                    // `gina-form-submit-disabled` until the page is reloaded — and because the flag
                    // lives on the `$forms[id]` object rather than a listener closure, it survives a
                    // full unbind/rebind too. This branch IS the terminal no-send outcome; the valid
                    // branch above deliberately keeps the latch until send() settles, which is what
                    // keeps live-check quiet during a real in-flight submit.
                    if ( instance.$forms[_id] ) {
                        instance.$forms[_id].isSubmitting = false;
                    }

                    // #B247 — release the trigger-scoped loading state. THIS is the path
                    // that stranded it: a rejected submit produces no request at all, so
                    // none of the XHR releases can ever run, and only the framework knows
                    // the submit was refused before it started. Left armed, the trigger
                    // stays visually loading until the page or popin is reloaded.
                    //
                    // Gated on nothing being in flight: a form can be submitted again
                    // while an earlier request is still running, and that later attempt
                    // may well be the one that fails validation. Releasing unconditionally
                    // would clear the state belonging to the request still in progress —
                    // whose own settle is what must release it.
                    var _loadingForm = instance.$forms[_id] || $form;
                    if ( !/^true$/i.test(_loadingForm.isSending) ) {
                        disarmSubmitLoading(_loadingForm);
                    }

                    // #A11Y1 (slice 3) — failed submit: move focus to the first invalid field so
                    // assistive tech announces it (accessible name + aria-invalid + the
                    // aria-errormessage text). DOM order; hidden / unfocusable fields are skipped.
                    var _a11yErrs = result['fields'] || result['error'];
                    if ( _a11yErrs ) {
                        var $a11yForm = event['target'];
                        // #B319 — same one-shot answer-focus exemption as
                        // focusFirstInvalidField: this focus delivers the
                        // answer, it is not the user editing the field.
                        isAnswerFocusInProgress = true;
                        try {
                            for (var _ai = 0, _aLen = $a11yForm.length; _ai < _aLen; ++_ai) {
                                var _aField = $a11yForm[_ai];
                                var _aName  = _aField.getAttribute('name');
                                if (
                                    _aName
                                    && typeof(_a11yErrs[_aName]) != 'undefined'
                                    && ( typeof(_a11yErrs[_aName].count) != 'function' || _a11yErrs[_aName].count() > 0 )
                                    && _aField.type != 'hidden'
                                    && typeof(_aField.focus) == 'function'
                                ) {
                                    _aField.focus();
                                    // #A11Y5 (V8) — kept in step with focusFirstInvalidField:
                                    // only stop once focus actually moved, since focus() is a
                                    // no-op on an unfocusable host that still passes the
                                    // typeof-function gate above.
                                    if ( typeof(document) === 'undefined' || !document || document.activeElement === _aField ) {
                                        // #B387 — same provenance record as focusFirstInvalidField.
                                        answerFocusHold = { formId: $a11yForm.getAttribute('id'), elName: _aName };
                                        break;
                                    }
                                }
                            }
                        } finally {
                            isAnswerFocusInProgress = false;
                        }
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
            // #B294 — mark the node this listener is ACTUALLY attached to. Deliberately
            // a JS expando and NOT a `data-*` attribute: `cloneNode(true)` copies
            // attributes but not expandos (measured), so a re-rendered trigger arrives
            // carrying every attribute yet WITHOUT this marker. That asymmetry is what
            // makes it a reliable "is this the bound node?" test — and it is why the
            // inherited `dataset.ginaFormSubmitTriggerFor` cannot serve the same purpose.
            // Assigned after the `submit.` prefix is normalised above, so it holds the
            // same string `clickProxyHandler` compares against. Read at the :8037
            // dispatch gate.
            $submit.__ginaSubmitBoundFor = evt;
            addListener(gina, $submit, evt, function(event) {
                // start validation
                cancelEvent(event);

                // #B332 belt — one submit cycle at a time per form. `isSubmitting`
                // latches below (before validate()) and is released on the XHR settle
                // AND on the rejected-validation branch (#B192), so a truthy read here
                // means a full cycle is still between click and settle: refuse the
                // re-entry (a re-click while a query rule's XHR is in flight, or a
                // residual duplicate listener on an older bundle) instead of racing
                // two concurrent cycles against the same form state.
                var _latchFormId = $target.getAttribute('id');
                if (
                    typeof(instance.$forms[_latchFormId]) != 'undefined'
                    && /^true$/i.test(instance.$forms[_latchFormId].isSubmitting)
                ) {
                    return;
                }

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


                // stop there if form has already been sent - anti spam
                // if (instance.$forms[id].sent) {
                //     return;
                // }

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
        // Owner-aware so reassociated submit buttons (<button form="X" type="submit">
        // outside $target's subtree) are bound to the correct form.
        $buttonsTMP = getOwnedElements($target, 'button');
        if ( $buttonsTMP.length > 0 ) {
            for (let b = 0, len = $buttonsTMP.length; b < len; ++b) {
                if ($buttonsTMP[b].type == 'submit') {
                    $buttons.push($buttonsTMP[b])
                }
            }
        }

        // binding links — DOM-tree only; <a> doesn't participate in HTMLFormControlsCollection
        $buttonsTMP = $target.getElementsByTagName('a');
        if ( $buttonsTMP.length > 0 ) {
            for (let b = 0, len = $buttonsTMP.length; b < len; ++b) {
                if ( $buttonsTMP[b].attributes.getNamedItem('data-gina-form-submit') ) {
                    $buttons.push($buttonsTMP[b])
                } else if (
                    !$buttonsTMP[b].getAttribute('id')
                    && !/gina\-popin/.test($buttonsTMP[b].className)
                    && !gina.popinIsBinded
                    && !/gina\-link/.test($buttonsTMP[b].className)
                ) { // will not be binded but will receive an id if not existing
                    linkId = 'link.'+ uuid();
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
                    $submit.id = 'click.'+uuid();
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
                    // console.debug('attaching submitTrigger: '+ $submit.id, ' \ form id: '+ $form.id);
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
                    // [CSP] Suppress the default action via a click listener instead of an inline
                    // onclick="return false;" attribute (tripped CSP script-src-attr under nonce
                    // policies). A preventDefault-only listener sets event.defaultPrevented exactly
                    // as the inline handler did, so the form-level clickProxyHandler's
                    // `if (event.defaultPrevented) return` guard still short-circuits identically.
                    addListener(gina, $submit, 'click', function(e) { e.preventDefault(); });
                }
                // (an existing onclick is left untouched, as before; the dead else-if append
                //  branch — it only mutated a local, never written back — was removed.)
            }

            if (!$submit['id']) {
                evt             = 'click.'+ uuid();
                $submit['id']   = evt;
                $submit.setAttribute( 'id', evt);
            } else {
                evt = $submit['id'];
            }

            // #B333 — the guard used to test `gina.events[evt]` where `evt` is the
            // BUTTON id (`click.<uuid>`), a key nothing ever writes: `bindSubmitEl`
            // registers under the NAMESPACED name (`submit.<id>`). The test was
            // therefore always true and every extra pass over the same button (the
            // id-less double-collection fixed in `getOwnedElements`, a re-bind path)
            // stacked one more live listener -> one more full validate()+send() cycle
            // per click. Test the key that actually gets registered, against the id
            // the registry stores. (A trigger REPLACED in the DOM keeps the registry
            // key but loses the expando marker — the #B294 click-time gate re-binds
            // that case; this guard only has to stop same-node re-binds.)
            // was:
            // if ( typeof(gina.events[evt]) == 'undefined' || gina.events[evt] != $submit.id ) {
            var _submitEvt = ( /^submit\./i.test(evt) ) ? evt : 'submit.'+ evt;
            if ( typeof(gina.events[_submitEvt]) == 'undefined' || gina.events[_submitEvt] != $submit.id ) {
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

            // #B308 — the disabled gate for USER GESTURES, with #B246's own predicate
            // read from the LIVE registered trigger, and #B246's own answer (cancel +
            // reveal). `e.isTrusted` scopes it: Enter-key submission and a wrapped-label
            // click (`<button type="submit"><span>`, whose click target has no `.type`
            // and so surfaces here instead of at the click proxy) arrive as trusted
            // submits; gina's own `triggerEvent` (`$forms[id].submit()`) dispatches an
            // untrusted CustomEvent and stays on the fresh-validate path below — a
            // programmatic submit is not operating the control, and the fresh pass is
            // the honest gate there. The reveal re-derives validity from live values,
            // so a stale marker heals and the NEXT gesture goes through.
            // Replaces the DOMParser innerHTML-copy guard below: the copy was blind to
            // the gate's marker (then `aria-disabled`, written by
            // updateSubmitTriggerState — since #B312 the gate marks its own
            // `data-gina-form-submit-gated` channel) while SIGHTED on a native `disabled` written
            // mid-dispatch by a double-submit guard — the exact attribute #B293 ruled
            // must not count on a real form control — so a wrapped-label trigger plus
            // a double-submit guard was a dead submit.
            // was:
            // // check submit trigger status
            // var submitTrigger = new DOMParser()
            //     .parseFromString($target.innerHTML, 'text/html')
            //     .getElementById($formInstance.submitTrigger);
            // // prevent submit if disabled
            // if ( submitTrigger && submitTrigger.disabled) {
            //     cancelEvent(e);
            // }
            if ($formInstance && e.isTrusted) {
                var $registeredTrigger = document.getElementById($formInstance.submitTrigger) || null;
                // #B346 — same carve-out as the click proxy's gate: when the ONLY
                // refusal reason is a query verdict still on the wire, refusing
                // here ate Enter-key and wrapped-label submits silently (nothing
                // committed to reveal). Let the pass run and wait for the settle;
                // every other refusal shape is unchanged.
                if (
                    isTriggerDisabled($registeredTrigger)
                    && !isAwaitingQueryVerdictOnly($registeredTrigger, $target, $formInstance)
                ) {
                    cancelEvent(e);
                    revealValidationState($formInstance);
                    return false;
                }
            }

            // prevent event to be triggered twice
            if ( typeof(e.defaultPrevented) != 'undefined' && e.defaultPrevented ) {
                return false;
            }

            // #B247 — a submit that never went through the click proxy still gets a
            // loading state: Enter inside a field, `form.submit()`, `$validator.submit()`,
            // and — less obviously — a click on a wrapped label such as
            // `<button type="submit"><span>Save</span></button>`, whose event.target is
            // the span (no `.type`), so the click proxy's submit branch never fires and
            // the event surfaces here instead. There is no clicked element on this path,
            // so the registered trigger is the best and only referent. Placed after the
            // disabled + defaultPrevented guards above, which both return first.
            // NB. the #B308 gesture gate above already cancelled any TRUSTED submit on
            // a marked trigger (#B346 excepted: a pending-verdict-only refusal now
            // proceeds, and the arm below covers it via the same carve-out), so this
            // skip otherwise guards the UNTRUSTED path: a programmatic submit on a
            // marked form runs the fresh validate pass below and must not flash the
            // trigger armed for the length of that pass.
            if ($formInstance) {
                var $loadingTrigger = document.getElementById($formInstance.submitTrigger);
                // #B346 — a pending-verdict bypass proceeds to a real cycle, so it
                // gets the loading state too (#B247 parity with the click proxy).
                if (
                    !isTriggerDisabled($loadingTrigger)
                    || isAwaitingQueryVerdictOnly($loadingTrigger, $target, $formInstance)
                ) {
                    armSubmitLoading($formInstance, $loadingTrigger);
                }
            }

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
                if ( typeof($target[i].type) != 'undefined' && $target[i].type == 'checkbox' && isBooleanCheckbox($target[i], (rules) ? rules[name] : null) ) {
                    // #49: boolean checkbox — the live `.checked` state IS the posted value
                    fields[name] = $target[i].checked;
                } else if ( typeof($target[i].type) != 'undefined' && $target[i].type == 'radio' || typeof($target[i].type) != 'undefined' && $target[i].type == 'checkbox' ) {

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
                    } else if ( // #B221: same collection arm as getFormValidationInfos --
                        // an unchecked non-boolean radio group with a truthy isRequired
                        // is collected as an empty value so the submit-path validation
                        // can adjudicate it (see the twin arm there for the rationale).
                        $target[i].type == 'radio'
                        && rules
                        && typeof(rules[name]) != 'undefined'
                        && /^true$/i.test(rules[name].isRequired)
                        && typeof(rules[name].isBoolean) == 'undefined'
                        && typeof(fields[name]) == 'undefined'
                    ) {
                        fields[name] = '';
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
                // #B346 — this pass may proceed while an async query verdict is
                // still on the wire: the pending-aware gate above lets a trusted
                // gesture through, and a programmatic submit() never consulted
                // the gate at all. An un-latched async pass STARVES — with the
                // query field not declared last, its waiter's completion resolves
                // to the needsGlobalReValidation display-only work and never runs
                // this callback. Latch exactly as bindSubmitEl does, so the
                // latched completion dispatches (#B342) — and mirror the #B332
                // belt for the window this pass now enters: one cycle at a time.
                // The owned-field scan mirrors isAwaitingQueryVerdictOnly's
                // (kept inline THERE — its body literals are pinned); trigger
                // marks and recorded errors are deliberately not consulted here,
                // because they do not affect LATCH soundness: an invalid pass
                // completes through the errors branch and releases via the
                // rejected-validation release, a clean pass through the latched
                // dispatch and the send release.
                var _pendingSel = '[data-gina-form-validator-query-pending]';
                var _formDomId = $target.id || ( typeof($target.getAttribute) == 'function' ? $target.getAttribute('id') : null );
                var _safeFormDomId = ( _formDomId && typeof(CSS) != 'undefined' && typeof(CSS.escape) == 'function' ) ? CSS.escape(_formDomId) : _formDomId;
                var _awaitsQueryVerdict = (
                    typeof($target.querySelector) == 'function' && $target.querySelector(_pendingSel)
                    || _safeFormDomId && document.querySelector('[form="'+ _safeFormDomId +'"]'+ _pendingSel)
                ) ? true : false;
                if (_awaitsQueryVerdict) {
                    if ( /^true$/i.test(instance.$forms[id].isSubmitting) ) {
                        return false;
                    }
                    instance.$forms[id].isSubmitting = true;
                    instance.$forms[id].isSending = false;
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
                            // #B346 — a consumer's own `on('submit')` handler owns
                            // the rest of the cycle and may never reach send():
                            // the latch cannot ride this dispatch (a stopping
                            // handler would strand it — the #B342 lockout shape).
                            // False -> false when this pass never latched.
                            instance.$forms[id].isSubmitting = false;
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
        // #B176: same inside-test() `&&` defect as the change-handler gate —
        // an explicit "false" opt-out still ran THIS bind-time silent
        // validation pass (it did NOT enable text as-you-type; the three
        // registerForLiveChecking sites were already strict). Note this gate
        // also swallowed the `else if` below, which exists precisely to serve
        // the opted-out case: the trigger still ended enabled either way,
        // because updateSubmitTriggerState forces its show branch when
        // live-check is off. See the scope note at the sibling site.
        // was: if ( /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled && $form.rules.count() > 0) ) {
        if ( /^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) && $form.rules.count() > 0 ) {
            console.debug('silent validation mode on');
            var validationInfo  = excludeWithheldAutofill(getFormValidationInfos($form.target, $form.rules)); // #B478
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
        }
        else if (!/^(true)$/i.test($form.target.dataset.ginaFormLiveCheckEnabled) ) {
            updateSubmitTriggerState( $form , true );
        }

    } // EO bindForm()

    /**
     * updateSubmitTriggerState
     *
     * Syncs a form's registered submit trigger with the live-check verdict:
     * while the form is invalid and live checking is on, the trigger is marked
     * `data-gina-form-submit-gated="true"` plus a styling class (#B312); both
     * marks are removed the moment the form validates. The marker is the
     * framework's OWN channel — the trigger carries no ARIA disabled claim,
     * because it stays genuinely operable: a click on a gated trigger is
     * answered by the display-only reveal (#B246) — or, when the only blocker
     * is a query verdict still on the wire, proceeds into a submit pass that
     * waits for the settle (#B346) — and `isValid()` remains the real send
     * gate.
     *
     * `aria-disabled` is deliberately neither written nor cleared here: an
     * authored mark belongs to the author (the gates enforce it, and nothing
     * here strips it), and the anchor in-flight lock's mark belongs to the
     * settle releases in `send()`.
     *
     * @param {object|HTMLFormElement} $formInstanceOrTarget - form instance, or its form target
     * @param {boolean|string} isFormValid - the fresh validity verdict
     *
     * @returns {void}
     *
     * @example
     * updateSubmitTriggerState(instance.$forms['checkout'], true);
     *
     * @inner
     */
    var updateSubmitTriggerState = function($formInstanceOrTarget, isFormValid) {
        //console.debug('submitTrigger[isFormValid='+ isFormValid +']: ', $formInstance.submitTrigger)
        var $formInstance = null; // #B176: was an implicit global (undeclared assignment)
        if ( $formInstanceOrTarget instanceof HTMLFormElement ) { //  is target DOMobject
            var id = $formInstanceOrTarget.getAttribute('id');
            $formInstance =  instance.$forms[id];
        } else {
            $formInstance = $formInstanceOrTarget;
        }
        //if (!$formInstance) return;


        if (
            typeof($formInstance.submitTrigger) == 'undefined'
            && /^(true)$/i.test($formInstance.target.dataset.ginaFormLiveCheckEnabled)
        ) {
            console.warn('This might be normal, so do not worry if this form is handled by your javascript: `'+ $formInstance.id +'`\nGina could not complete `updateSubmitTriggerState()`: `submitTrigger` might not be attached to form instance `'+ $formInstance.id +'`\nTo disable this warning, You just need to disable `Form Live Checking on your form by adding to your <form>: `data-gina-form-live-check-enabled=false``')
        } else if ( document.getElementById($formInstance.submitTrigger) ) {
            // Represent the "invalid + live-check-on" state with the framework's own
            // marker — `data-gina-form-submit-gated` + a class — INSTEAD of any
            // disabled vocabulary (#B312). A natively-disabled <button> emits no click
            // event at all, so the click could not be observed and the user would get
            // no feedback about WHY nothing happens; and an ARIA disabled claim would
            // be dishonest here — the control stays genuinely operable, keeping the
            // trigger focusable and perceivable, and clickProxyHandler answers its
            // clicks (#B246) with a display-only reveal: every invalid field is
            // rendered and the first is focused, while `isValid()` remains the real
            // send gate. `aria-disabled` is left to its two honest writers — markup or
            // script AUTHORS (the gates enforce an authored mark, and the show branch
            // never strips one) and the anchor in-flight lock in `send()` (armed and
            // released at the request boundary).
            // was (#B76, retired by #B312): the hide branch wrote an
            // `aria-disabled="true"` claim and the show branch removed it — one
            // attribute carrying the gate verdict, authored marks AND the in-flight
            // lock, a sharing whose collisions produced #B309/#B311/#B313.
            // Tag-agnostic: setAttribute/classList work for both <button> and <a> submit
            // triggers. The show branch KEEPS clearing native `disabled` so a trigger
            // rendered `disabled` in markup still enables on valid / when live-check is off.
            // The framework ships a default look for the gated state (see
            // loading-state.scss); consumers may override or extend via the
            // [data-gina-form-submit-gated="true"] / .gina-form-submit-disabled hooks.
            var $submitTrigger = document.getElementById($formInstance.submitTrigger);
            if (
                /^true$/i.test(isFormValid)
                ||
                !/^(true)$/i.test($formInstance.target.dataset.ginaFormLiveCheckEnabled)
            ) { // show submitTrigger
                $submitTrigger.disabled = false;
                $submitTrigger.removeAttribute('data-gina-form-submit-gated');
                $submitTrigger.classList.remove('gina-form-submit-disabled');
            } else { // hide submitTrigger (gated: marked not-ready, still operable)
                $submitTrigger.setAttribute('data-gina-form-submit-gated', 'true');
                $submitTrigger.classList.add('gina-form-submit-disabled');
            }
        }
    }

    /**
     * matchesAutofill
     *
     * Tells whether a control currently carries the browser's autofill state:
     * the `:autofill` pseudo-class (Firefox, and recent Chrome/Safari) or its
     * `:-webkit-autofill` alias (Chrome and Safari). Each selector is tried
     * under its own try/catch - an engine that does not implement one of them
     * throws from `matches()`, and that throw must never poison a live pass.
     *
     * @param {object} $el - form control (DOMObject)
     *
     * @returns {boolean} true when either autofill pseudo-class matches
     *
     * @example
     * matchesAutofill($passwordInput); // true right after the browser filled it
     *
     * @inner
     */
    var matchesAutofill = function($el) {
        if ( !$el || typeof($el.matches) != 'function' ) {
            return false;
        }
        var selectors = [':autofill', ':-webkit-autofill'];
        for (var s = 0; s < selectors.length; ++s) {
            try {
                if ( $el.matches(selectors[s]) ) {
                    return true;
                }
            } catch (unsupportedPseudoClassErr) {
                // this engine does not know that pseudo-class: try the next one
            }
        }
        return false;
    };

    /**
     * isAutofillValueWithheld
     *
     * #B478 - Chrome fills saved credentials VISIBLY but keeps the values
     * away from script until a trusted user gesture: the control matches
     * `:autofill`, the user sees it populated, and `.value` reads `''`
     * (measured on Chrome 152: both credential fields of a login form read
     * length 0 with `:-webkit-autofill` matching, until a click on the page
     * released them and fired a trusted keydown/input/change/keyup burst on
     * each). Validating such a field records `isRequired` against a value
     * the user can see is present: a false "required" verdict, and a gated
     * trigger on a form that is, to the user, complete.
     *
     * A field is "withheld" when it carries the autofill state AND reads
     * empty. Text-like controls only - a checkbox or radio never withholds.
     *
     * Exposed on the plugin instance as `gina.validator.isAutofillValueWithheld`
     * (#B341): the engine's `isRequired` consults it at submit time to render the
     * honest `isRequiredAutofill` label instead of the plain required one.
     *
     * @param {object} $el - form control (DOMObject)
     *
     * @returns {boolean} true when the browser filled the field but has not released its value yet
     *
     * @example
     * isAutofillValueWithheld($passwordInput); // true on Chrome before the first gesture
     *
     * @inner
     */
    var isAutofillValueWithheld = function($el) {
        if ( !$el || /^(radio|checkbox|file)$/i.test($el.type) ) {
            return false;
        }
        return ( $el.value === '' && matchesAutofill($el) );
    };

    /**
     * excludeWithheldAutofill
     *
     * #B478 - narrows a collected field set (the `getFormValidationInfos()`
     * shape) to the fields the browser has actually released: every control
     * `isAutofillValueWithheld()` reports is dropped from BOTH maps, so the
     * live-check layer never adjudicates a value it cannot read, and the
     * gate reflects what the user sees - a filled form - instead of an
     * `isRequired` failure on a visibly populated field.
     *
     * Used ONLY by the live-check passes: bind-time, the whole-form pass
     * behind every live event, the select pass, the display-only reveal and
     * the silent autofill pass. The submit passes keep the FULL collection on
     * purpose: `isValid()` stays the real send gate, so a value the browser
     * still withholds at click time fails `isRequired` there and the form
     * never posts an empty credential.
     *
     * @param {object} validationInfo - `{ fields, $fields, rules }` as returned by getFormValidationInfos()
     *
     * @returns {object} the same object, mutated in place (withheld fields removed, `_length` recomputed)
     *
     * @example
     * var infos = excludeWithheldAutofill(getFormValidationInfos($form, rules));
     * validate($form, infos.fields, infos.$fields, rules, onVerdict);
     *
     * @inner
     */
    var excludeWithheldAutofill = function(validationInfo) {
        if ( !validationInfo || !validationInfo.$fields || !validationInfo.fields ) {
            return validationInfo;
        }
        var dropped = 0;
        for (var name in validationInfo.$fields) {
            if ( isAutofillValueWithheld(validationInfo.$fields[name]) ) {
                delete validationInfo.$fields[name];
                delete validationInfo.fields[name];
                ++dropped;
            }
        }
        if ( dropped > 0 && typeof(validationInfo.fields['_length']) != 'undefined' ) {
            delete validationInfo.fields['_length'];
            validationInfo.fields['_length'] = validationInfo.fields.count() || 0;
        }
        return validationInfo;
    };

    /**
     * revalidateSilently
     *
     * #B478 - re-derives a live-checked form's gate from its CURRENT values
     * without rendering anything: collect (withheld autofill excluded),
     * validate, sync the submit trigger with the verdict. The bind-time
     * silent pass made callable, for the autofill signal on a control whose
     * value the browser has not released yet - there is nothing honest to
     * display for such a field, but the gate must stop counting it against
     * the user. A no-op for a form without live checking or without rules.
     *
     * @param {object} $formInstance - form instance record (`instance.$forms[id]`)
     *
     * @returns {void}
     *
     * @example
     * revalidateSilently(instance.$forms['checkout']);
     *
     * @inner
     */
    var revalidateSilently = function($formInstance) {
        if ( !$formInstance || !$formInstance.target || !$formInstance.rules ) {
            return;
        }
        if (
            !/^(true)$/i.test($formInstance.target.dataset.ginaFormLiveCheckEnabled)
            || $formInstance.rules.count() == 0
        ) {
            return;
        }
        var validationInfo = excludeWithheldAutofill(getFormValidationInfos($formInstance.target, $formInstance.rules));
        validate($formInstance.target, validationInfo.fields, validationInfo.$fields, $formInstance.rules, function onSilentAutofillValidation(result) {
            updateSubmitTriggerState($formInstance, result.isValid());
        });
    };

    /**
     * isTriggerDisabled
     *
     * Tells whether a submit trigger must currently be refused. Three marks
     * count, each with one honest writer (#B312): `updateSubmitTriggerState()`
     * gates an invalid form's trigger with the framework's own
     * `data-gina-form-submit-gated="true"` channel; an AUTHORED
     * `aria-disabled="true"` counts and is never cleared by the framework —
     * an author's disabled claim is enforced, not second-guessed; and the
     * anchor in-flight lock marks `aria-disabled` for the request window. The
     * aria/native arms keep the same shape as the popin and link plugins' own
     * gates, so the three subsystems still agree on what an authored
     * "disabled" means for a trigger; the gated arm is validator-only.
     *
     * #B293 — the native `disabled` attribute counts ONLY on an element where
     * `disabled` is not a real IDL property. On a genuine form control the
     * browser already suppresses the click entirely (measured: a natively
     * disabled <button> delivers no click event to JS at all), so this gate
     * never even runs for one — which means the only way the native arm could
     * fire there was a listener setting the attribute DURING the dispatch. That
     * is exactly the shape of the near-universal double-submit guard
     * (`onclick -> this.setAttribute('disabled', …)`), which is bound to the
     * button and therefore runs before gina's delegated proxy reaches this
     * check. Accepting it killed the submit outright: `send()` never ran, the
     * consumer's own handler cleared the attribute again, and every subsequent
     * click repeated the cycle with nothing marked and a normal-looking button.
     * On an <a> or a custom element the browser enforces nothing, so there the
     * attribute is still the only honest signal and is still read.
     *
     * @param {object} $el - candidate trigger (DOMObject)
     *
     * @returns {boolean} true when the trigger's activation must be refused
     *
     * @example
     * isTriggerDisabled($button); // true while the trigger is gated, or carries an authored aria-disabled="true"
     *
     * @example
     * // <button disabled> never reaches here (the browser eats the click), and a
     * // `disabled` set mid-click by a double-submit guard is deliberately ignored
     * isTriggerDisabled($guardedButton); // false
     *
     * @inner
     */
    var isTriggerDisabled = function($el) {
        if ( !$el || typeof($el.getAttribute) != 'function' ) {
            return false;
        }
        // #B293: `disabled` is only meaningful where the browser does not enforce it.
        // was: $el.getAttribute('disabled') != null && $el.getAttribute('disabled') != 'false'
        var nativeCounts = !('disabled' in $el);
        return (
            nativeCounts
            && $el.getAttribute('disabled') != null && $el.getAttribute('disabled') != 'false'
            ||
            $el.getAttribute('aria-disabled') == 'true'
            ||
            $el.getAttribute('data-gina-form-submit-gated') == 'true'
        );
    };

    /**
     * isAwaitingQueryVerdictOnly
     *
     * Tells whether a refused submit trigger is refused ONLY because a `query`
     * verdict is still pending — the one state the #B246 gate misclassifies.
     *
     * #B346 — `updateSubmitTriggerState()` gates on a boolean (`isFormValid`)
     * over a state that is really tri-valued: valid, invalid with COMMITTED
     * errors, and VERDICT-PENDING (an async `query` XHR on the wire, so the
     * form has no verdict yet). The #B246 refuse-and-reveal answer is only
     * coherent for the middle state — with nothing committed there is nothing
     * to reveal, and the click died silently (measured: wake path fully
     * healthy, `isSubmitting` never latched, zero sends inside the round-trip
     * window; the window scales with query LATENCY, not typing speed). When
     * this returns true the proxy lets the click run the normal submit cycle:
     * the pass latches and arms its waiter, the engine's in-flight branch
     * declines to duplicate the XHR, the pending settle wakes the waiter, and
     * the latched completion dispatches (#B342) — the exact flow live-check-off
     * forms already run.
     *
     * Deliberately NARROW — every arm fails toward the shipped refusal:
     * - the framework's own gated mark must be the ONLY refusal reason; an
     *   AUTHORED `aria-disabled="true"` or a (non-IDL) native `disabled`
     *   keeps refusing (#B312 — an author's claim is enforced, not
     *   second-guessed);
     * - any COMMITTED error keeps refusing — refuse-and-reveal stays coherent
     *   when there is something to reveal. Committed means a SETTLED field's:
     *   the pending field itself may carry a provisional `query` entry staged
     *   by the same-value fast path while its verdict is on the wire, and a
     *   provisional entry is not a verdict (measured — counting it refused
     *   every window this helper exists to recognize);
     * - an owned field must actually carry the in-flight query marker
     *   (`data-gina-form-validator-query-pending`, set by the engine right
     *   before `xhr.send()` and cleared at both settle chokepoints), looked up
     *   inside the form AND among form-reassociated controls (`form="<id>"`).
     *
     * @param {object} $el - the clicked submit trigger (DOMObject)
     * @param {object} $formDom - the owning form element (DOMObject)
     * @param {object} [$formRecord] - the validator record (`instance.$forms[id]`)
     *
     * @returns {boolean} true when the only thing standing between the click
     *  and a verdict is a query still on the wire
     *
     * @example
     * // gated trigger, clean form, uniqueness query in flight -> the click waits for the verdict
     * isAwaitingQueryVerdictOnly($button, $form, instance.$forms[$form.id]); // true
     *
     * @example
     * // same window but a sibling field has a committed error -> shipped refuse-and-reveal stands
     * isAwaitingQueryVerdictOnly($button, $form, instance.$forms[$form.id]); // false
     *
     * @inner
     */
    var isAwaitingQueryVerdictOnly = function($el, $formDom, $formRecord) {
        if ( !$el || typeof($el.getAttribute) != 'function' || !$formDom || typeof($formDom.querySelector) != 'function' ) {
            return false;
        }
        // the gated mark must be present, and be the ONLY firing arm
        if ( $el.getAttribute('data-gina-form-submit-gated') != 'true' ) {
            return false;
        }
        var nativeCounts = !('disabled' in $el);
        if (
            nativeCounts
            && $el.getAttribute('disabled') != null && $el.getAttribute('disabled') != 'false'
            ||
            $el.getAttribute('aria-disabled') == 'true'
        ) {
            return false;
        }
        // a query verdict must actually be pending for an owned field — inside
        // the form, or a form-reassociated control (`form="<id>"`)
        var pendingSel = '[data-gina-form-validator-query-pending]';
        var _id = $formDom.id || ( typeof($formDom.getAttribute) == 'function' ? $formDom.getAttribute('id') : null );
        var _safeId = ( _id && typeof(CSS) != 'undefined' && typeof(CSS.escape) == 'function' ) ? CSS.escape(_id) : _id;
        var hasPending = (
            $formDom.querySelector(pendingSel)
            || _safeId && document.querySelector('[form="'+ _safeId +'"]'+ pendingSel)
        ) ? true : false;
        if (!hasPending) {
            return false;
        }
        // COMMITTED errors keep the shipped refuse-and-reveal — but committed
        // means a SETTLED field's verdict. Measured (#B346): while a query is
        // on the wire, the same-value fast path stages a provisional `query`
        // entry under the PENDING field's own key in `$formRecord.errors`, so
        // a bare `errors.count() > 0` reads the very state this helper exists
        // to recognize as "no verdict yet" and refuses every window. Count an
        // erroring field only when it is NOT itself awaiting the verdict.
        if ( $formRecord && typeof($formRecord.errors) != 'undefined' && $formRecord.errors ) {
            for (var _fieldName in $formRecord.errors) {
                if ( !$formRecord.errors.hasOwnProperty(_fieldName) ) {
                    continue;
                }
                var _fieldErrors = $formRecord.errors[_fieldName];
                var _isErroring = ( _fieldErrors && typeof(_fieldErrors.count) == 'function' )
                    ? _fieldErrors.count() > 0
                    : !!_fieldErrors;
                if (!_isErroring) {
                    continue;
                }
                var _safeName = ( typeof(CSS) != 'undefined' && typeof(CSS.escape) == 'function' ) ? CSS.escape(_fieldName) : _fieldName;
                var _erroringIsPending = (
                    $formDom.querySelector('[name="'+ _safeName +'"]'+ pendingSel)
                    || _safeId && document.querySelector('[form="'+ _safeId +'"][name="'+ _safeName +'"]'+ pendingSel)
                ) ? true : false;
                if (!_erroringIsPending) {
                    // a settled field carries a real verdict — there IS
                    // something to reveal, the shipped refusal stands
                    return false;
                }
            }
        }
        return true;
    };

    /**
     * focusFirstInvalidField
     *
     * Moves focus to the first field carrying an error, in DOM order, skipping
     * hidden and unfocusable controls (#A11Y1) so assistive tech announces the
     * accessible name + `aria-invalid` + the `aria-errormessage` text.
     *
     * NB. the `validate.<id>` guard keeps its own inline twin of this loop rather
     * than calling here. That is DELIBERATE: the inline shape is locked by source
     * pins in `test/core/validator-aria-invalid.test.js` (`_a11yErrs`, `_aField`),
     * so collapsing the two would break pins unrelated to #B246. Keep the two in
     * step if the focus rule ever changes — as #B319 did: both sites raise the
     * answer-focus exemption around their loop, so delivering the answer cannot
     * be mistaken for the user editing the field.
     *
     * @param {object} $form - form target (DOMObject), not the instance
     * @param {object} errors - error map keyed by field name
     *
     * @returns {boolean} true when a field was focused
     *
     * @example
     * focusFirstInvalidField($form, result['fields'] || result['error']);
     *
     * @inner
     */
    var focusFirstInvalidField = function($form, errors) {
        if ( !$form || !errors ) {
            return false;
        }
        // #B319 — raise the one-shot answer-focus exemption so the synchronous
        // `focusin` dispatched by `$field.focus()` below cannot re-enter the
        // live-check suppression and hide the message this answer just rendered.
        isAnswerFocusInProgress = true;
        try {
            for (var i = 0, len = $form.length; i < len; ++i) {
                var $field  = $form[i];
                var name    = $field.getAttribute('name');
                if (
                    name
                    && typeof(errors[name]) != 'undefined'
                    && ( typeof(errors[name].count) != 'function' || errors[name].count() > 0 )
                    && $field.type != 'hidden'
                    && typeof($field.focus) == 'function'
                ) {
                    $field.focus();
                    // #A11Y5 (V8) — `typeof focus == 'function'` is true for EVERY HTMLElement,
                    // a custom element with neither `tabindex` nor `delegatesFocus` included,
                    // whose focus() is a silent no-op (measured). Without confirming the move,
                    // the loop reported success and stopped on a control that never took focus,
                    // so a failed submit announced nothing. Confirming it is also what makes the
                    // "skips unfocusable controls" contract above true rather than aspirational.
                    if ( typeof(document) === 'undefined' || !document || document.activeElement === $field ) {
                        // #B387 — record the answer-placed focus so display
                        // refreshes firing after the one-shot window (async
                        // completion callers) can tell it from user focus.
                        answerFocusHold = { formId: $form.getAttribute('id'), elName: name };
                        return true;
                    }
                }
            }
            return false;
        } finally {
            isAnswerFocusInProgress = false;
        }
    };

    /**
     * revealValidationState
     *
     * Display-only validation pass, used when a DISABLED submit trigger is
     * clicked (#B246). It runs the same collect + validate chain the submit path
     * uses, but routes the result straight to the error renderer instead of
     * dispatching `validate.<id>` — so `bindSubmitEl`'s handler never runs, the
     * `isSubmitting` latch is never set and the `isValid()` send gate is never
     * reached. No request can start from this path by construction.
     *
     * The trigger state is re-synced from the fresh result, which also self-heals
     * a stale disabled marker on a form that has since become valid.
     *
     * @param {object} $formInstance - form instance (carries `.target` / `.rules`)
     *
     * @returns {void}
     *
     * @example
     * revealValidationState(instance.$forms['myForm']);
     *
     * @inner
     */
    var revealValidationState = function($formInstance) {
        if ( !$formInstance || !$formInstance.target ) {
            return;
        }
        var $target         = $formInstance.target;
        var validationInfo  = excludeWithheldAutofill(getFormValidationInfos($target, $formInstance.rules)); // #B478

        var onDisabledTriggerReveal = function(result) {
            var errors = result['fields'] || result['error'];
            handleErrorsDisplay($target, errors, result['data']);
            focusFirstInvalidField($target, errors);
            updateSubmitTriggerState($formInstance, result.isValid());
        };
        // #B348 — completion identity. A reveal pass is un-latched, writes
        // neither `isSubmitting` nor `isValidating`, and on a VALID form its
        // verdict is clean — so with the async `query` field not declared
        // last its waiter completion matched NO dispatch branch and this
        // callback silently never ran: the documented self-heal + gate
        // re-sync were dead on those forms. The marker rides the exact cb of
        // the exact pass (the engine's own `cb._data`/`cb._errors` property
        // idiom); the waiter's terminal-gated rescue branch consults it.
        onDisabledTriggerReveal.isRevealCompletion = true;
        validate($target, validationInfo.fields, validationInfo.$fields, $formInstance.rules, onDisabledTriggerReveal);
    };

    /**
     * getFormValidationInfos
     *
     * Collects a form's named, non-disabled controls into a name->value map
     * (`fields`) plus a name->DOM-handle map (`$fields`). Radio groups: a
     * checked member's value is collected by the boolean/legacy arms; an
     * unchecked non-boolean group whose rule declares a truthy `isRequired`
     * is collected as an empty string (#B221) so the rule engine can
     * adjudicate it; any other unchecked group stays absent (native parity;
     * boolean-declared groups are owned by the force-false arm).
     *
     * @param {object} $form - form target (DOMObject), not the instance
     * @param {object} [rules]
     * @param {boolean} [isOnResetMode=false] - resets hidden/text values to their defaults while walking
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

                if ( $form[i].type == 'checkbox' && isBooleanCheckbox($form[i], (rules) ? rules[name] : null) ) {
                    // #49: boolean checkbox — the live `.checked` state IS the posted
                    // value; self-inject the isBoolean rule like the legacy path did
                    if (rules) {
                        if ( typeof(rules[name]) == 'undefined' ) {
                            rules[name] = { isBoolean: true };
                        } else if ( typeof(rules[name]) != 'undefined' && typeof(rules[name].isBoolean) == 'undefined' ) {
                            // forces it when field found in validation rules; isRequired is
                            // appended BEFORE isBoolean — rules run in key insertion order and
                            // the engine's isBoolean rescue only clears an isRequired error
                            // recorded before it (a boolean false otherwise reads as empty)
                            rules[name].isRequired = true;
                            rules[name].isBoolean = true;
                        }
                    }
                    fields[name] = $form[i].checked;
                } else if (
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
                            // forces it when field found in validation rules; isRequired is
                            // appended BEFORE isBoolean — rules run in key insertion order and
                            // the engine's isBoolean rescue only clears an isRequired error
                            // recorded before it (a boolean false otherwise reads as empty)
                            rules[name].isRequired = true;
                            rules[name].isBoolean = true;
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
                } else if ( // #B221: an unchecked non-boolean radio group with a
                    // declared truthy isRequired never entered `fields`, so no
                    // rule (isRequired above all) could adjudicate it -- and a
                    // radio-group-only form short-circuited the whole pass
                    // (fields count == 0 reads as nothing-to-validate). Collect
                    // it as an empty value so the engine's generic emptiness
                    // test fires. A checked member is always collected by the
                    // arms above; the already-collected guard keeps this arm
                    // from resetting it when an unchecked member iterates after
                    // the checked one. Groups with no rule, isRequired:false,
                    // or an isBoolean declaration keep the legacy
                    // absent-when-unchecked shape (boolean groups are owned by
                    // the force-false arm above; optional groups bypass on
                    // empty anyway, so their wire shape stays byte-identical).
                    $form[i].type == 'radio'
                    && rules
                    && typeof(rules[name]) != 'undefined'
                    && /^true$/i.test(rules[name].isRequired)
                    && typeof(rules[name].isBoolean) == 'undefined'
                    && typeof(fields[name]) == 'undefined'
                ) {
                    fields[name] = '';
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

    /**
     * getCastedValue
     * Returns the value to use for `fieldName` — raw for the engine to
     * adjudicate, or cast/quoted for dynamised-rules substitution.
     *
     * Plain mode (`formatFields`): numeric-rule comma normalisation only;
     * real booleans pass through as-is and every other value stays RAW — the
     * engine's own rules cast on acceptance (#B236).
     * Dynamised mode (`getDynamisedRules`): values are spliced into a
     * stringified condition, so a boolean-ruled field casts to an unquoted
     * boolean operand, an empty value becomes a quoted empty string, and
     * other strings are quoted.
     *
     * @inner
     * @param {object} ruleObj - parsed rules (quoted booleans unquoted)
     * @param {object} fields - collected field values (MUTATED: comma normalisation)
     * @param {string} fieldName
     * @param {boolean|string} [isOnDynamisedRulesMode] - truthy/`'true'` in dynamised mode
     * @returns {*} the raw, cast, or quoted value
     */
    var getCastedValue = function(ruleObj, fields, fieldName, isOnDynamisedRulesMode) {

        var isOnDynamisedRules = (
            typeof(isOnDynamisedRulesMode) != 'undefined'
            && /^true$/i.test(isOnDynamisedRulesMode)
        );

        if (
            // do not cast if no rule linked to the field
            typeof(ruleObj[fieldName]) == 'undefined'
            // do not cast if not defined or on error
            || /^(null|NaN|undefined|\s*)$/i.test(fields[fieldName])
        ) {
            // In dynamised-rules mode this value is spliced verbatim into a stringified
            // condition (e.g. `$a === $b`). An empty/whitespace value MUST become a quoted
            // empty string ("") so the condition stays a parseable binary comparison —
            // returning the raw empty value leaves a DANGLING operator (`"x" === `) that
            // `is()` then rejects, and the resulting throw aborts the whole-form validity
            // pass so the submit trigger never gets gated. Mirrors the sibling substitution
            // default in getDynamisedRules (`... : '\\"\\"'`). `null`/`undefined` stay raw:
            // they are already valid grammar operands, so only empty/whitespace needs quoting.
            if ( isOnDynamisedRules && /^\s*$/.test(fields[fieldName]) ) {
                return '\\"\\"';
            }
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
        // #B236 — the boolean pre-cast survives ONLY in dynamised-rules mode, where a
        // referenced isBoolean field must splice into a stringified condition as an
        // unquoted boolean operand (`$flag === true`). On the PLAIN pass it funneled
        // every value not matching the case-insensitive literal `true` to `false`
        // BEFORE the engine ran, so junk (and the HTML checkbox default `on`, and
        // the number 1) validated clean and persisted as `false` on the server auto
        // path. The engine is the single adjudicator now — the same contract the
        // routing requirements surface always enforced.
        // was: `} else if (ruleObj[fieldName].isBoolean) {`
        } else if (isOnDynamisedRules && ruleObj[fieldName].isBoolean) {
            return (/^true$/i.test(fields[fieldName])) ? true : false;
        }

        return isOnDynamisedRules ? '\\"'+ fields[fieldName] +'\\"' : fields[fieldName];
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
        // #B234 — this second loop is a DOM FALLBACK: it re-derives each splice
        // value from the live element (`$fields[...].value` / `.checked`), and
        // the server auto path (`backendInit`) passes `$fields = null`, so ANY
        // `$` surviving loop 1 threw here — a regex end-anchor in an `is`
        // condition, or a `$` inside a human-readable message string. Loop 1
        // already replaces every KNOWN field's token, so what reaches loop 2 is
        // a leftover it structurally cannot match anyway: skipping when there is
        // no DOM matches what the client does when this re-scan no-ops, and
        // leaves every previously-working substitution byte-identical. Same
        // `$fields &&` guard shape as the #B127 precedent one function later.
        // was: `if ( /\$(.*)/.test(stringifiedRules) ) {`
        if ( $fields && /\$(.*)/.test(stringifiedRules) ) {
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
     * @param {string} [culture] // #i18n — server form-body path only; forwarded to FormValidator
     */
    var validate = function($formOrElement, fields, $fields, rules, cb, culture) {

        delete fields['_length']; //cleaning

        var stringifiedRules = JSON.stringify(rules);
        fields = formatFields(stringifiedRules, fields);
        if ( /\$(.*)/.test(stringifiedRules) ) {
            // #B127 — `$fields` is null on the server paths (backendInit passes
            // validate($form, fields, null, rules, …)), so the unguarded
            // `$fields.count()` crashed the server pass for ANY `$`-bearing rule
            // set (plain `is` included) before the rules ever ran. A server pass
            // is a full-form pass by definition — never a single-element live-check.
            var isLiveCheckingOnASingleElement = (
                $fields
                && !/^form$/i.test($formOrElement.tagName)
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
            // #B332 — fields THIS pass armed an `asyncCompleted.<id>` waiter for.
            // The arm guard used to consult the global `gina.events` registry, which
            // cannot tell "this pass already armed it" (legitimate skip — a rules
            // re-application within one pass) from "a CONCURRENT pass armed it"
            // (must NOT skip: zeroing `asyncCount` there made this pass complete on
            // a sync-only verdict and send() fired while the query XHR was in
            // flight). Pass-local by construction, so only the first case matches.
            , armedAsyncFields  = {}
        ;


        var re = null, flags = null, args = null;
        /**
         * Apply every rule declared for one field to the FormValidator instance `d`.
         *
         * Array-form rules (`isInList: [...]`) get their FIRST argument scanned for
         * `$`-prefixed tokens; a token resolving to a real field (a `d` key with a
         * defined `.value`) is substituted with that value, anything else stays
         * LITERAL (#B239 — the blind deref crashed on unknown names and spliced
         * "undefined" on engine-method-name collisions). Later elements are never
         * scanned. Cross-field refs inside array rules are consumed upstream by
         * getDynamisedRules loop 1 (quoted — #B240), so in practice only leftover
         * non-field tokens reach the scan here.
         *
         * @inner
         * @param {string} field - field name (key into `rules`, `fields` and `d`)
         * @param {object} rules - parsed rule set for the whole form
         * @param {object} fields - collected field values
         * @returns {void} verdicts land on `d[field]` / `d.error`
         */
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
                // #B127 — numbered `is` aliases (`is0`, `is1`, …) must be installed
                // BEFORE the function typecheck below: the installer requires the
                // `undefined` state the typecheck `continue`s on, so with the old
                // order (typecheck first) the installer was unreachable and every
                // `is<N>` rule key was silently skipped — client AND server. The
                // regex is anchored: the old unanchored alternative also matched
                // names like `is0abc`, which would inherit from a nonexistent base.
                // was (below the typecheck — unreachable):
                // if ( /^((is)\d+|is$)/.test(rule) && typeof(d[field][rule]) == 'undefined' ) { // is aliases
                if ( /^is\d+$/.test(rule) && typeof(d[field][rule]) == 'undefined' ) { // is aliases
                    d[field][rule] = function(){};
                    d[field][rule] = inherits(d[field][rule], d[field][ rule.replace(/\d+/, '') ]);
                    // #B138 — arm the alias handshake PER INVOCATION, not per install.
                    // The old install-time IIFE armed the shared `_currentValidatorAlias`
                    // slot ONCE (this install branch is gated once-per-instance), while
                    // form-validator's is() CONSUMES the slot with a delete on every
                    // call — so on any re-application against the same instance (a
                    // `conditions`/_case_ re-evaluation, forEachField recursion) the
                    // slot was empty: every numbered rule collapsed onto the shared key
                    // 'is', the last-declared rule overwrote its siblings there, and its
                    // message rendered TWICE (its own key + the collapsed 'is' key — the
                    // error-display loop has no message dedup). The wrapper re-arms the
                    // slot immediately before every delegation, so is<N> keys stay
                    // distinct on every application. Root resolution mirrors
                    // form-validator's _aliasRoot (browser window / server global).
                    // was:
                    // d[field][rule].setAlias = (function(alias) {
                    //     this._currentValidatorAlias = alias
                    // }(rule));
                    d[field][rule] = (function (aliasName, composed) {
                        return function () {
                            var _aliasRoot = ( typeof(window) != 'undefined' ) ? window : ( ( typeof(global) != 'undefined' ) ? global : null );
                            if (_aliasRoot) {
                                _aliasRoot._currentValidatorAlias = aliasName;
                            }
                            return composed.apply(this, arguments);
                        };
                    }(rule, d[field][rule]));
                }
                // skip when not processing rule function
                if ( typeof(d[field][rule]) != 'function' ) {
                    continue;
                }
                // check for rule params
                try {
                    if (Array.isArray(rules[field][rule])) { // has args
                        //convert array to arguments
                        args = JSON.clone(rules[field][rule]);
                        if ( /\$[\-\w\[\]]*/.test(args[0]) ) {
                            var foundVariables = args[0].match(/\$[\-\w\[\]]*/g);
                            for (var v = 0, vLen = foundVariables.length; v < vLen; ++v) {
                                // #B239 — the deref used to be blind, throwing
                                // `TypeError: Cannot read properties of undefined` on
                                // BOTH paths for any token naming no field (`d` is the
                                // FormValidator field map on the client AND the server),
                                // and splicing the string "undefined" for a token whose
                                // name collides with an engine METHOD (isValid, toData —
                                // defined keys with no `.value`). A token that does not
                                // resolve to a real field now stays LITERAL, so strict
                                // comparison applies. Cross-field refs inside array
                                // rules remain owned by #B240 (upstream loop-1 quoting).
                                // was: args[0] = args[0].replace( foundVariables[v], d[foundVariables[v].replace('$', '')].value )
                                var _refName = foundVariables[v].replace('$', '');
                                if (
                                    typeof(d[_refName]) == 'undefined'
                                    || typeof(d[_refName].value) == 'undefined'
                                ) {
                                    continue;
                                }
                                args[0] = args[0].replace( foundVariables[v], d[_refName].value );
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
                            // #B332 — the arm guard is PASS-LOCAL now (see `armedAsyncFields`
                            // at the declaration block). The old registry test saw only that
                            // SOME pass had armed the field: when that pass was a concurrent
                            // one (a duplicate submit listener — #B333, a re-click while the
                            // query XHR was in flight, a live-check cycle beside a submit),
                            // this pass zeroed ITS OWN pending-async counter and returned —
                            // so its terminal block completed on the sync-only verdict, the
                            // `validate.<id>` valid branch ran, and `send()` fired ~200ms
                            // BEFORE the query answered (the "email already registered" error
                            // rendered after the POST had already left). A foreign waiter must
                            // not starve this pass of its own wake-up: waiters stack per pass
                            // (each self-detaches on first fire below) and the ENGINE dedups
                            // the wire via `ginaFormValidatorQueryPending` — no duplicate XHR.
                            // was:
                            // if ( typeof(gina.events[asyncEvt]) != 'undefined' ) {
                            //     console.debug('event `'+ asyncEvt +'` already added');
                            //     asyncCount = 0;
                            //     return;
                            // }
                            if ( typeof(armedAsyncFields[$asyncFieldId]) != 'undefined' ) {
                                console.debug('event `'+ asyncEvt +'` already armed by this pass');
                                continue;
                            }
                            armedAsyncFields[$asyncFieldId] = true;
                            ++asyncCount;
                            //console.debug('Adding listner '+asyncEvt);
                            addListener(gina, $asyncField, asyncEvt, function onasyncCompleted(event) {
                                event.preventDefault();
                                // #B332/#B334 — one settle per waiter. Waiters stack per pass
                                // now, so each must consume exactly one wake-up and leave the
                                // node: the registry-only `removeListener` in the completion
                                // block below carries no fn ref (a DOM no-op — it only deletes
                                // the `gina.events` key), and a stale un-latched waiter used to
                                // re-enter on every later settle of the same field, replaying a
                                // finished pass's completion against a live one.
                                event.currentTarget.removeEventListener(event.type, onasyncCompleted, false);

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
                                var formId      = $currentForm.getAttribute('id');
                                var isFormValid = null;

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
                                    // #B337 — the completion payload must carry the WHOLE pass's
                                    // verdict, not the query field's slice. On a full-form submit
                                    // pass `d` holds every field, and scoping to `field` starved
                                    // the `validate.<id>` handler of every OTHER invalid field:
                                    // their errors were adjudicated (DOM attributes set) but never
                                    // rendered on the submit path, and the #A11Y1 first-invalid
                                    // focus loop could only ever land on the query field. It also
                                    // inverted the query-passes-but-another-field-invalid scene:
                                    // the scoped set read empty, the early-return branch was
                                    // skipped, and the validated dispatch went out with NO errors
                                    // at all. On a single-element live-check pass `d` holds one
                                    // field, so the no-arg call is byte-equivalent there — the
                                    // touched-field-only DISPLAY below keeps its `field` argument,
                                    // which is the live-check contract (§4c). The validated
                                    // listener's own fallback was already `d.getErrors()` no-arg.
                                    // was: cb._errors = d['getErrors'](field);
                                    cb._errors = d['getErrors']();
                                    // console.debug('query callbakc triggered ', cb._errors, '\nisValidating: ', instance.$forms[formId].isValidating);
                                    // update instance form errors
                                    if ( cb._errors && cb._errors.count() > 0) {
                                        if ( typeof(instance.$forms[formId].errors) == 'undefined' ) {
                                            instance.$forms[formId].errors = {}
                                        }
                                        // Fixed on 2025-03-16
                                        if ( typeof(cb._errors[field]) != 'undefined' ) {
                                            instance.$forms[formId].errors[field] = cb._errors[field];
                                        }
                                        console.debug('[A] Refreshing warning/error on field '+ field);
                                        if (
                                            !isFormValid && /^true|false$/i.test(instance.$forms[formId].isValidating)
                                            || d[field].target.value != ''

                                        ) {
                                            refreshWarning($allFields[field]);
                                            handleErrorsDisplay($currentForm, cb._errors, cb._data, field);
                                            updateSubmitTriggerState( $currentForm, isFormValid);
                                        }

                                        if ( envIsDev && isGFFCtx && typeof(window.ginaToolbar) != 'undefined' && window.ginaToolbar ) {
                                            // update toolbar
                                            if (!gina.forms.errors) {
                                                gina.forms.errors = {};
                                            }

                                            var objCallback = {
                                                id      : formId,
                                                errors  :  instance.$forms[formId].errors || {}
                                            };

                                            window.ginaToolbar.update('forms', objCallback);
                                        }


                                        // #B334 — dispatch where THIS pass's listener actually
                                        // sits: $formOrElement (the form on a full-form pass —
                                        // identical to $currentForm there — but the ELEMENT on
                                        // a single-element pass, whose listener could never
                                        // hear a form-dispatched event: bubbling goes up, not
                                        // down; it still bubbles up THROUGH the form so
                                        // consumer `on('validated')` bindings keep hearing it).
                                        // was: triggerEvent(gina, $currentForm, 'validated.' + formId, cb);
                                        triggerEvent(gina, $formOrElement, 'validated.' + formId, cb);
                                        return;
                                    }
                                }

                                // #B342 — a SUBMIT pass has exactly ONE legitimate completer: this
                                // waiter (post-#B338 the terminal block runs while asyncCount is
                                // still > 0, so it can never dispatch for an async pass). On a
                                // CLEAN pass the errors>0 branch above is skipped, and both
                                // branches below are conditional — last-field matches only when
                                // the query field happens to be declared last in the rule set
                                // (minus `exclude:true` splices), and the live-check branch needs
                                // `isValidating`, which a submit pass does not set. A clean submit
                                // whose query field was NOT last exited this block having
                                // dispatched NOTHING: `cb` starved, `validate.<id>` never fired,
                                // no send ever left, and the #B332 `isSubmitting` latch stranded —
                                // gating every later click until reload (measured live on a
                                // consumer login form: value present, every field clean, click
                                // swallowed). Pre-arc this hole was MASKED by the very bugs
                                // #B332/#B333 removed: the duplicate pass's premature sync-only
                                // completion was the accidental completer. A latched form means
                                // this completion belongs to the submit cycle (live-check passes
                                // hard-return while the latch is held), so dispatch it — display
                                // work belongs to the `validate.<id>` handler's send/reject
                                // branches, same as the errors>0 dispatch above.
                                // #B346 note: waiters ARMED before the latch — live-check
                                // passes mid-window, the reveal's own pass — also wake through
                                // this branch once a pending-window gesture latches; each such
                                // dispatch carries THAT waiter's own pass cb, and the #B334
                                // own-pass listener filtering keeps every completion with its
                                // own pass. NEW live-check passes still hard-return on the
                                // latch.
                                if ( /^true$/i.test(instance.$forms[formId].isSubmitting) ) {
                                    triggerEvent(gina, $formOrElement, 'validated.' + formId, cb);
                                    return;
                                }

                                // is this the last or the only field to be validated ?
                                var needsGlobalReValidation = false;
                                if ( listedFields.length == 1 || listedFields[listedFields.length-1] == field) {
                                    // trigger end of validation
                                    // console.debug(field +' is the last element to be validated for formId: '+ formId, cb._errors, instance.$forms[formId].errors);
                                    isFormValid = ( cb._errors.count() > 0 ) ? false : true;
                                    // #B295 — `cb._errors` is `d.getErrors(field)`, which
                                    // form-validator.js scopes to a SINGLE field, so the flag
                                    // above means "this field passed", never "the form is
                                    // valid". Everything below is guarded on `!isFormValid`,
                                    // so a form that has just become valid got NO update at
                                    // all: `updateSubmitTriggerState` was never called and the
                                    // bind-time `aria-disabled` marker survived on a valid
                                    // form, while `$forms[id].errors` kept listing the field.
                                    // That was cosmetic until #B246 made the click gate read
                                    // the marker — then the first click after the query
                                    // settles is silently eaten.
                                    // Hand the verdict to the fresh whole-form pass below,
                                    // exactly as the not-last-field branch already does. It is
                                    // the only source that can be trusted here: measured with
                                    // another field left invalid, that pass reports its error
                                    // while both the field-scoped `cb._errors` AND the in-pass
                                    // `d.getErrors()` report none — so deciding from either of
                                    // those would enable the trigger on an invalid form.
                                    if (isFormValid) {
                                        needsGlobalReValidation = true;
                                    }
                                    if (!isFormValid && /^true|false$/i.test(instance.$forms[formId].isValidating)) {
                                        console.debug('[1] Should update error display now ', cb._errors);
                                        instance.$forms[formId].errors = merge(cb._errors, instance.$forms[formId].errors);
                                        refreshWarning($allFields[field]);
                                        handleErrorsDisplay($currentForm, cb._errors, cb._data, field);
                                        updateSubmitTriggerState( $currentForm, isFormValid);
                                    }
                                    // #B334 — same retarget as the completion branch above.
                                    // was: triggerEvent(gina, $currentForm, 'validated.' + formId, cb);
                                    triggerEvent(gina, $formOrElement, 'validated.' + formId, cb);
                                }
                                // just update warning state
                                else if (/^true$/i.test(instance.$forms[formId].isValidating) && listedFields.length > 1 && listedFields[listedFields.length-1] != field ) {
                                    //console.debug(field +' is NOT the last element to be validated for formId: '+ formId);
                                    needsGlobalReValidation = true;
                                }
                                // #B348 — the reveal's rescue: a TERMINAL completion
                                // (same condition as the errors>0 block above — the
                                // guard is what stops a multi-query-field early wake,
                                // where the first waiter fires at asyncCount 1)
                                // carrying the reveal's completion identity, that
                                // matched none of the branches above, must dispatch
                                // its own pass or `onDisabledTriggerReveal` starves:
                                // clean verdict + un-latched + not live-check +
                                // query-not-last fell through EVERY branch, the gate
                                // marker never re-synced, and a fully valid form ate
                                // every later click. Chained LAST so every
                                // previously-working shape (terminal errors>0, #B342
                                // latch, last-field, live-check display-only) stays
                                // byte-identical; an un-latched programmatic submit
                                // (#B347) carries no marker and is deliberately
                                // unaffected — its fix is gated on its own repro.
                                else if (
                                    hasParsedAllRules
                                    && asyncCount <= 0
                                    && cb && cb.isRevealCompletion
                                ) {
                                    triggerEvent(gina, $formOrElement, 'validated.' + formId, cb);
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
            d = new FormValidator(fields, null, xhrOptions, undefined, culture);
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
            var caseValueBackup = null; // #B229 — see the `caseName == field` arm below
            var baseValueBackup = null; // #B230 — see the base-rule restore below

            //console.debug('parsing ', fields, $fields, rules);
            if ( typeof(rules) != 'undefined' ) {

                for (var field in fields) {

                    // `$fields` is null on the server auto path (backendInit), and a rule
                    // field can be absent from the client collection: guard the DOM read.
                    localFieldType = ( $fields && typeof($fields[field]) != 'undefined' )
                        ? $fields[field].getAttribute('type')
                        : null;

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
                        if ( typeof(rules[c].conditions) == 'undefined' || Array.isArray(rules[c].conditions) && !rules[c].conditions.length ) continue;
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
                            // #B129 — coerce the CASE value itself (the direct-case
                            // site's semantics: unconditional string "true"/"false"
                            // -> boolean, isGFFCtx gate kept). The old shape tested
                            // `fields[field]` — the OUTER field being validated — so
                            // a boolean `case` never coerced unless the outer field's
                            // own value happened to be "true"/"false", which instead
                            // CLOBBERED the case value for that field's pass. Masked
                            // in full-form passes by the direct-case site below;
                            // unmasked in single-element/live-check mode.
                            // was:
                            // if (isGFFCtx) {
                            //     if (fields[field] == "true")
                            //         caseValue = true;
                            //     else if (fields[field] == "false")
                            //         caseValue = false;
                            // }
                            if (isGFFCtx) {
                                if (caseValue == "true")
                                    caseValue = true;
                                else if (caseValue == "false")
                                    caseValue = false;
                            }


                            // filtering conditions
                            for (var _c = 0, _cLen = rules[c].conditions.length; _c < _cLen; ++_c) {

                                if (
                                    Array.isArray(rules[c].conditions[_c].case)
                                        && rules[c].conditions[_c].case.indexOf(caseValue) == -1
                                    ||
                                    !Array.isArray(rules[c].conditions[_c].case)
                                        && rules[c].conditions[_c].case != caseValue

                                ) {
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

                    if (isInCase) continue;

                    // #B229 — a field that DRIVES a `_case_` still owns its BASE
                    // rules. `caseName` is assigned inside the `_case_` scan loop
                    // above, which runs in full on EVERY field iteration, so at this
                    // point it always holds the LAST scanned `_case_` key's driver
                    // name. The old combined tail therefore skipped the whole rest of
                    // the iteration for that driver — base-rule check included — so a
                    // rule shape { "group": { "isRequired": true }, "_case_group": {…} }
                    // never adjudicated `group` on the bind pass, the live-check
                    // global pass OR the submit pass: the form never gated and an
                    // empty submit went out unvalidated (the #B221 silent-submit
                    // class, resurfacing for the self-driving shape — downstream of
                    // #B221's collection fix, which already admits the group as '').
                    // The driver's `allFields` entry is restored around the call:
                    // checkFieldAgainstRules ends every applied rule with
                    // `delete fields[field]` on the object it is handed, and
                    // `allFields[caseName]` is the case VALUE the scan block re-reads
                    // on every later field iteration — a deleted entry re-seeds from
                    // `$allFields[name].value`, which for a radio group is the FIRST
                    // member's value regardless of `.checked` (#B230, pre-existing).
                    // The direct-case block below stays skipped for the driver, so
                    // WHICH conditions apply is unchanged (measured: that block is
                    // never entered for a self-driving case, pre-fix or post-fix).
                    // was:
                    // if (isInCase || caseName == field) continue;
                    if ( caseName == field ) {
                        if ( typeof(rules[field]) != 'undefined' ) {
                            caseValueBackup = allFields[field];
                            checkFieldAgainstRules(field, rules, allFields);
                            if (
                                typeof(allFields[field]) == 'undefined'
                                && typeof(caseValueBackup) != 'undefined'
                            ) {
                                allFields[field] = caseValueBackup;
                            }
                        }
                        continue;
                    }

                    // #B230 — a `_case_` driver's entry in `allFields` IS the case
                    // VALUE every later reader consumes: the scan block above
                    // re-reads it on every subsequent field iteration (a missing
                    // entry re-seeds from `$allFields[name].value` — a radio
                    // group's FIRST member regardless of `.checked`), and the
                    // direct-case block below reads it in THIS iteration. Site
                    // 3/3's adjudication deletes it (checkFieldAgainstRules ends
                    // every applied rule with `delete fields[field]` on the
                    // object it is handed), so a non-last driver's conditions
                    // matched a value the user never picked on later scans and
                    // matched nothing (`undefined`) in its own direct-case pass.
                    // Back the entry up and restore it after the check — gated
                    // on the field driving a `_case_` in the live `rules` OR in
                    // the pass-entry clone `allRules`: inside a direct-case
                    // recursion `rules` is the condition's own rule set (no
                    // `_case_` keys), so `hasCase` alone is blind there
                    // (measured — the union is load-bearing). Non-driver fields
                    // keep the delete untouched: the pull-in gate, the
                    // direct-case exclude injection and the async-`query`
                    // re-validation input all read those absences today.
                    baseValueBackup = allFields[field];
                    // check each field against rule only if rule exists 3/3
                    if ( typeof(rules[field]) != 'undefined' ) {
                        //checkFieldAgainstRules(field, rules, fields);
                        checkFieldAgainstRules(field, rules, allFields);
                    }
                    // #B230 restore — see the block comment above
                    if (
                        ( hasCase || typeof(allRules['_case_' + field]) != 'undefined' )
                        && typeof(baseValueBackup) != 'undefined'
                        && typeof(allFields[field]) == 'undefined'
                    ) {
                        allFields[field] = baseValueBackup;
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
                                Array.isArray(conditions[c]['case'])
                                    && conditions[c]['case'].indexOf(caseValue) > -1
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
                        $fields[field].setAttribute('data-gina-form-errors', fieldErrorsAttributes[field].substring(0, fieldErrorsAttributes[field].length-1))
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


        // #B334 — three defects lived in this one registration:
        //   (a) it registered for EVERY pass, but a cb-less pass never dispatches
        //       `validated.<id>` (the terminal block returns the result object
        //       instead) — its listener was pure accumulation;
        //   (b) `event.detail` IS the DISPATCHING pass's callback, and the body ran
        //       it unconditionally — so every stale listener replayed the dispatcher's
        //       callback once (measured: two listeners -> one dispatch -> two
        //       `validate.<id>` dispatches -> two send() calls for one click);
        //   (c) the `removeListener` call in the body carries no fn ref, and
        //       events.js then only deletes the registry key —
        //       `removeEventListener(name, undefined)` detaches nothing, so every
        //       pass's listener stayed on the node for the page's lifetime.
        // The listener now registers only when a callback exists, consumes ONLY its
        // own pass's dispatch (detail identity), and detaches itself on consumption
        // (a mid-dispatch removal also stops a not-yet-run duplicate per DOM spec).
        // was: if (isGFFCtx) {
        //          addListener(gina, $formOrElement, evt, function(event) {
        if ( isGFFCtx && typeof(cb) === 'function' ) {
            addListener(gina, $formOrElement, evt, function onValidatedOwnPass(event) {
                event.preventDefault();

                if ( event.detail !== cb ) {
                    // another pass's completion — not ours to consume
                    return;
                }
                event.currentTarget.removeEventListener(event.type, onValidatedOwnPass, false);

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

    /**
     * setErrorLabels — register per-culture overrides for gina's built-in rule
     * error labels (browser only). Global to the validator: all bound forms share
     * the built-in label catalog. Call once, typically keyed off gina.config.culture
     * (whispered from the request's negotiated culture):
     *   gina.validator.setErrorLabels({ isRequired: '...' });          // current culture
     *   gina.validator.setErrorLabels({ isRequired: '...' }, 'fr_FR'); // explicit culture
     * English defaults fill any rule the app does not translate; a per-field/rule
     * `error` string still wins. Custom user-defined rules already carry app messages
     * and are untouched.
     *
     * @param   {object} labels      - { ruleName: message } for one culture.
     * @param   {string} [culture]   - Target culture; defaults to gina.config.culture.
     * @returns {object} the validator instance (chainable).
     * */
    var setErrorLabels = function (labels, culture) {
        if ( !labels || typeof(labels) != 'object' ) {
            return instance;
        }
        if ( !culture ) {
            culture = ( typeof(gina) != 'undefined' && gina.config && gina.config.culture )
                ? gina.config.culture
                : 'en';
        }
        if ( !instance._errorLabelsByCulture ) {
            instance._errorLabelsByCulture = {};
        }
        instance._errorLabelsByCulture[culture] = merge(
            JSON.clone(labels),
            instance._errorLabelsByCulture[culture] || {}
        );
        return instance;
    };

    var setupInstanceProto = function() {

        instance.target                 = document;
        instance.setOptions             = setOptions;
        instance.getFormById            = getFormById;
        instance.validateFormById       = validateFormById;
        instance.resetErrorsDisplay     = resetErrorsDisplay;
        instance.resetFields            = resetFields;
        instance.handleErrorsDisplay    = handleErrorsDisplay;
        instance.send                   = send;
        instance.setErrorLabels         = setErrorLabels;
        // #B341 - the engine consults the plugin's single definition of a withheld
        // autofill (#B478) to pick the honest `isRequired` label at submit time.
        instance.isAutofillValueWithheld = isAutofillValueWithheld;
        //instance.handleXhrResponse      = handleXhrResponse;
    }

    if (isGFFCtx) {
        return init(rules)
    } else {
        return backendInit(rules, data, formId, culture)
    }

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports  = ValidatorPlugin
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define('gina/validator', ['utils/events', 'utils/dom', 'utils/effects', 'utils/data', 'lib/form-validator', 'lib/routing', 'lib/loading-state'], function(){ return ValidatorPlugin })
}