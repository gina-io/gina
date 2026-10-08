'use strict';

/**
 * @module lib/collection
 * @description In-memory array collection with MongoDB-style query, update,
 * insert, delete, orderBy, and aggregation methods. Each entry gets a `_uuid`
 * index on construction. Works in Node.js (CommonJS) and browser (GFF/AMD).
 *
 * `Collection.length` returns entry count — do not use `.count()` as it
 * includes function properties in the count.
 *
 * Dependencies: `lib/merge`, `lib/uuid`
 */

/**
 * In-memory document collection with query and mutation methods.
 *
 * Filter values must be defined. Every method that accepts a filter object
 * throws an `Error` naming the offending key when that object carries an
 * `undefined` value: `find`, `findOne`, `or`, `update`, `replace`, `max`,
 * `notIn` and `delete`. The last two are covered transitively — `notIn`
 * routes a filter-object argument through `find`, and `delete` delegates to
 * `notIn` — so only `notIn`'s array form, `notIn(rows, key)`, is exempt.
 * Build such filters conditionally (add a key only when its value is
 * defined). An explicitly empty `{}` filter is legal and matches every
 * record; `null` is a legal needle comparing strictly against stored values.
 *
 * A key holding a dot is a property path (`'address.city'`), also inside an
 * array of objects (`'reviews[*].ratings.score'`). A dotted key that is not a
 * property path matches nothing.
 *
 * Query results (`find`, `orderBy`, `limit`, `notIn`, …) are Arrays carrying
 * these methods, so calls chain. Their `filter` takes either a function, which
 * filters like `Array.prototype.filter` and returns a chainable result, or a
 * field name or a list of field names, which projects each row onto those
 * fields and returns a plain array.
 *
 * Search options. `setSearchOption(field, 'isCaseSensitive', false)` makes the
 * next search compare `field` without regard to case. It applies to that one
 * call (`find`, `findOne`, `update`, `replace`, `delete`, …) and is then
 * cleared. The value is matched as TEXT, whole: a dot, a parenthesis or any
 * other character means itself.
 *
 * Two things read a value as something other than text, with or without a
 * search option: a value holding `<`, `>` or `=` is a comparison (`'>= 1'`),
 * and the value `not null`, in any case, matches every defined, non-null
 * value. `{ searchOptionRules: { skipEval: true } }`, passed to the
 * constructor, turns the comparison off for the plain (non-dotted) keys of
 * that Collection; it changes neither `not null` nor a dotted key.
 *
 * @class Collection
 * @constructor
 * @this {Collection}
 *
 * @param {Array}   content      - Initial array of documents (deep-cloned on construction)
 * @param {object}  [options]                      - Options
 * @param {boolean} [options.useLocalStorage=false] - Persist to `localStorage` (browser only)
 * @param {string}  [options.locale='en']           - Locale used for string comparison
 * @param {object}  [options.searchOptionRules]     - Overrides of the search-option rule table: `skipEval` (boolean, default `false`), and the `re` template and `modifiers` flags of an `isCaseSensitive` entry (`false` or `true`). In a template `%s` stands for the filter value, which is always matched as text: `{ isCaseSensitive: { false: { re: '^%s', modifiers: 'i' } } }` makes the case-insensitive search a prefix search
 * @returns {object} Collection instance (the enriched `content` array)
 * @throws {Error} When `content` is not an Array
 *
 * @example
 * var col = new Collection([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
 *
 * // find — AND clause
 * col.find({ name: 'Alice' });                          // [{ id:1, name:'Alice', _uuid:'…' }]
 * // find — comparison
 * col.find({ id: '>= 1' });                             // both entries
 * // find — nested
 * col.find({ 'address.city': 'Paris' });
 * // find — within array
 * col.find({ 'tags[*].label': 'news' });
 * // OR clause (pass two filter objects)
 * col.or().find({ name: 'Alice' }, { name: 'Bob' });
 *
 * col.findOne({ id: 1 });                               // { id:1, … }
 * col.findOne({ id: undefined });                       // throws — filter values must be defined
 * col.update({ id: 1 }, { name: 'Alicia' });
 * col.insert({ id: 3, name: 'Carol' });
 * col.delete({ id: 2 });
 * col.orderBy({ name: 'asc' });
 * col.toRaw();                                          // strip _uuid/_hasItsOwnUuid
 * col.find({}).filter(function (r) { return r.id > 1; }); // chainable: .toRaw(), .orderBy(), …
 * col.find({}).filter(['id', 'name']);                  // projection: [{ id, name }, …]
 *
 * // search option — the next search ignores the case of `name`; the value is text
 * col.setSearchOption('name', 'isCaseSensitive', false).findOne({ name: 'ALICE' }); // { id:1, name:'Alice' }
 * col.setSearchOption('name', 'isCaseSensitive', false).find({ name: 'a.' });       // [] — the dot is a dot
 * // the same option as one object, keyed by field
 * col.setSearchOption({ name: { isCaseSensitive: false } }).findOne({ name: 'BOB' }); // { id:2, name:'Bob' }
 */
function Collection(content, options) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var uuid            = (isGFFCtx) ? require('lib/uuid') : require('../../../lib/uuid');
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');

    // defined search option rules
    var searchOptionRules = {
        isCaseSensitive: {
            false: {
                re: '^%s$',
                modifiers: 'i'
            },
            true: {
                re: '^%s$'
            }
        },
        skipEval: false
    };
    var withOrClause = false;
    var notInSearchModeEnabled = false;

    var localSearchOptions  = null;

    var defaultOptions = {
        useLocalStorage: false,
        locale: 'en', // TODO - get settigs.region, or user.region
        searchOptionRules: searchOptionRules
    };



    options = (typeof(options) == 'object') ? merge(options, defaultOptions) : defaultOptions;

    var keywords    = ['not null']; // TODO - null, exists (`true` if property is defined)
    // #SCS1d (2026-04-23) — replaced `eval(condition)` with a safe binary-compare evaluator.
    // The conditions tryEval() receives are all constructed internally as `<left><op><right>`
    // where left/right ∈ {number literal, "string literal", new Date("...")} and op ∈
    // {===, !==, ==, !=, <, >, <=, >=}. User-controlled filter strings flowed into eval via
    // `_content + filter` concat (line 293) and the datetime-wrapped variant (line 310) —
    // any filter containing `<`|`>`|`=` reached eval unsanitised (RCE vector). Preserves
    // error behaviour: throws on any unparseable input (callers at 310/314/406/411 do not
    // catch — it bubbles).
    // var tryEval     = function(condition) {
    //     try {
    //         return eval(condition);
    //     } catch(err) {
    //         throw new Error('Could not evaluate condition `'+ condition +'`.\n' + err.stack );
    //     }
    // }
    // #B609 — the string operand now accepts JSON escapes (`\"`, `\\`, …) so a value
    // containing a quote or backslash cannot break the grammar. Previously the operand
    // was `"[^"]*"`, which no escaped quote could satisfy: a single row whose string
    // value held a `"` threw and poisoned the whole query.
    var CONDITION_RE = /^\s*(new\s+Date\("[^"]*"\)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)\s*(===|!==|<=|>=|==|!=|<|>)\s*(new\s+Date\("[^"]*"\)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)\s*$/;
    var parseOperand = function(s) {
        var m = s.match(/^\s*new\s+Date\("([^"]*)"\)\s*$/);
        if (m) return new Date(m[1]);
        var t = s.replace(/^\s+|\s+$/g, '');
        if (/^"(?:\\.|[^"\\])*"$/.test(t)) return JSON.parse(t);
        var n = Number(t);
        if (!isNaN(n) && t !== '') return n;
        throw new Error('Invalid operand: `'+ s +'`');
    };
    // #B609 — build a safe `<left><op><right>` condition for a STRING left operand:
    // strip the full operator (every form the grammar admits, longest first), trim the
    // compared value, tolerate a pre-quoted operand, and JSON-encode both sides so a
    // quote/backslash in a value — or an operator character inside the operand — can no
    // longer corrupt the expression. The numeric and datetime paths are left untouched.
    var STRING_OP_RE = /^(===|!==|<=|>=|==|!=|<|>)/;
    var buildStringCondition = function(left, filter) {
        var fs = String(filter);
        var m = fs.match(STRING_OP_RE);
        if (!m) { return JSON.stringify(String(left)) + fs; }
        var op = m[1];
        var right = fs.slice(op.length).replace(/^\s+|\s+$/g, '');
        if (/^"(?:\\.|[^"\\])*"$/.test(right)) { right = JSON.parse(right); }
        return JSON.stringify(String(left)) + op + JSON.stringify(right);
    };
    // #B818 — every character a RegExp reads as syntax outside a character class.
    var REGEXP_SYNTAX_RE = /[\\^$.*+?()[\]{}|]/g;
    /**
     * Build the RegExp of one search-option rule for one filter value (#B818, #B819).
     *
     * The rule's `re` is a template in which `%s` stands for the value. The
     * template is the pattern; the value is TEXT: every character a RegExp reads
     * as syntax is escaped before the value takes the place of `%s`, and a
     * function replacer puts it there, so a `$` sequence in the value (`$&`,
     * `$$`, …) is not expanded. The pattern is built in a local and the rule
     * entry is only read: the next value — on this instance, or on another one
     * sharing the caller's rule table — starts from the same template.
     *
     * @inner
     * @private
     * @param {object} ruleDef             - A rule entry of the search-option rule table
     * @param {string} ruleDef.re          - The template, e.g. `'^%s$'`
     * @param {string} [ruleDef.modifiers] - RegExp flags, e.g. `'i'`
     * @param {*}      value               - The filter value; read as a string
     * @returns {RegExp} the expression matching `value` as text inside the template
     *
     * @example
     * buildSearchOptionRegExp({ re: '^%s$', modifiers: 'i' }, 'a.b'); // /^a\.b$/i
     */
    var buildSearchOptionRegExp = function(ruleDef, value) {
        var text    = String(value).replace(REGEXP_SYNTAX_RE, '\\$&');
        var pattern = ruleDef.re.replace(/\%s/, function onValue() { return text; });
        return (ruleDef.modifiers) ? new RegExp(pattern, ruleDef.modifiers) : new RegExp(pattern);
    };
    var tryEval     = function(condition) {
        var m = (typeof(condition) == 'string') ? condition.match(CONDITION_RE) : null;
        if (!m) {
            throw new Error('Could not evaluate condition `'+ condition +'`.\n(grammar: <operand><op><operand>; operand ∈ number | "string" | new Date("..."); op ∈ === !== == != < > <= >=)');
        }
        try {
            var left  = parseOperand(m[1]);
            var op    = m[2];
            var right = parseOperand(m[3]);
            // Match eval's Date semantics: only arithmetic ops coerce Date to valueOf()
            // (timestamp); `==`/`!=`/`===`/`!==` between two Date objects are reference
            // compares and always false (two fresh `new Date(x)` are different objects).
            if ( op === '<' || op === '>' || op === '<=' || op === '>=' ) {
                if (left  instanceof Date) left  = left.getTime();
                if (right instanceof Date) right = right.getTime();
            }
            switch (op) {
                case '===': return left === right;
                case '!==': return left !== right;
                case '==':  return left == right;
                case '!=':  return left != right;
                case '<':   return left <  right;
                case '>':   return left >  right;
                case '<=':  return left <= right;
                case '>=':  return left >= right;
            }
        } catch(err) {
            throw new Error('Could not evaluate condition `'+ condition +'`.\n' + err.stack );
        }
    }

    if (typeof(content) == 'undefined' || content == '' || content == null)
        content = [];

    if ( !Array.isArray(content) )
        throw new Error('`new Collection([content] [, options] )`: `content` argument must be an Array !');

    content = (content) ? JSON.clone(content) : []; // original content -> not to be touched

    // Indexing : uuids are generated for each entry
    var searchIndex = [], idx = 0;
    for (var entry = 0, entryLen = content.length; entry < entryLen; ++entry) {
        if (!content[entry]) {
            content[entry] = {};
        }
        if ( typeof(content[entry]._uuid) != 'undefined' ) {
            content[entry]._hasItsOwnUuid = true;
        } else {
            // 16-char base-62 (~4.77e28 space) — at the default 4-char (~14.78M) the
            // birthday-paradox collision rate at N=917 is ~2.84%, and `notIn()`'s
            // _uuid-keyed splice removes the wrong record on collision. 16 keeps the
            // collision rate below 1e-13 up to N=100M, future-proof for any practical
            // collection size.
            content[entry]._uuid = uuid(16);
        }

        // To avoid duplicate entries
        searchIndex[idx] = content[entry]._uuid;
        ++idx;
    }

    var instance = content;
    /**
     * Set local search option for the current collection method call
     *
     * The option applies to the next search only (`find`, `findOne`, `update`,
     * `replace`, `delete`, …) and is then cleared. The value of that search is
     * matched as text: a pattern character in it means itself (#B818).
     *
     * Two forms. Three arguments set one rule on one field and ADD to what an
     * earlier call set, so calls chain per field. One object, keyed by field,
     * REPLACES what was set: `{ <field>: { <rule>: <value> } }` (#B820). The
     * object is copied: it is neither kept nor changed. The only rule is
     * `isCaseSensitive` (`true` or `false`; the texts `'true'` / `'false'` are
     * read as booleans). `skipEval` is a constructor option
     * (`options.searchOptionRules`): as a top-level key of the object it is
     * accepted and has no effect.
     *
     * @param {object|string} searchOptionObject or searchOptionTargetedProperty - the options keyed by field, or the field name
     * @param {string} [searchRule] - the rule name (three-argument form)
     * @param {boolean} [searchRuleValue] - the rule's value: `false` ignores the case, `true` keeps it
     *
     * @returns {object} instance with local search options
     * @throws {Error} on zero, two or more than three arguments
     * @throws {Error} when a single argument is not an object
     * @throws {Error} `<rule> is not an allowed searchOption !` on an unknown rule name
     * @throws {Error} when a field's entry in the object form is not an object of rules
     *
     * @example
     * // three arguments: one rule on one field
     * var rec = new Collection(rows)
     *     .setSearchOption('city', 'isCaseSensitive', false)
     *     .find({ city: 'cap Town' });
     *
     * @example
     * // one object, keyed by field
     * var rec = new Collection(rows)
     *     .setSearchOption({ city: { isCaseSensitive: false }, country: { isCaseSensitive: false } })
     *     .find({ city: 'cap Town', country: 'south africa' });
     */
    instance['setSearchOption'] = function() {

        if (!arguments.length)
            throw new Error('searchOption cannot be left blank');

        if (arguments.length > 3 || arguments.length < 3 && arguments.length > 1)
            throw new Error('argument length mismatch');

        var i       = 0
            , len   = arguments.length
        ;

        if (len == 1) {
            if ( typeof(arguments[0]) != 'object' )
                throw new Error('searchOption must be an object');

            // #B820 — the object form is keyed by FIELD: { <field>: { <rule>: <value> } }.
            // The loop below tested each top-level key — a field name — against the
            // rule table, so the documented shape threw, with a message read from the
            // second argument, which this form does not have. Each field's rule names
            // are now tested instead, and the options are COPIED: the caller's object
            // is neither kept nor changed by the search. A top-level key that names a
            // rule is accepted and has no effect, as before.
            // for (var prop in arguments[0]) {
            //     if ( typeof(searchOptionRules[prop]) == 'undefined' )
            //         throw new Error(arguments[1] + ' is not an allowed searchOption !');
            // }
            //
            // localSearchOptions = arguments[0];
            var given = arguments[0], normalized = {};
            for (var prop in given) {
                if ( typeof(searchOptionRules[prop]) != 'undefined' )
                    continue;

                if ( !given[prop] || typeof(given[prop]) != 'object' || Array.isArray(given[prop]) )
                    throw new Error('searchOption `' + prop + '` must be an object of rules, e.g. { isCaseSensitive: false }');

                normalized[prop] = {};
                for (var ruleName in given[prop]) {
                    if ( typeof(searchOptionRules[ruleName]) == 'undefined' )
                        throw new Error(ruleName + ' is not an allowed searchOption !');

                    if ( /true|false/i.test(given[prop][ruleName]) ) {
                        normalized[prop][ruleName] = /true/i.test(given[prop][ruleName]) ? true : false
                    } else {
                        normalized[prop][ruleName] = given[prop][ruleName]
                    }
                }
            }

            localSearchOptions = normalized;
        } else {

            if ( !localSearchOptions )
                localSearchOptions = {};

            for (; i < len; ++i) {
                if ( typeof(searchOptionRules[arguments[1]]) == 'undefined' )
                    throw new Error(arguments[1] + ' is not an allowed searchOption !');

                if (typeof(localSearchOptions[arguments[0]]) == 'undefined')
                    localSearchOptions[arguments[0]] = {};

                if ( /true|false/i.test(arguments[2]) ) {
                    localSearchOptions[arguments[0]][arguments[1]] = /true/i.test(arguments[2]) ? true : false
                } else {
                    localSearchOptions[arguments[0]][arguments[1]] = arguments[2]
                }
            }
        }

        return instance
    }


    /**
     * find
     *
     * Filters the collection content with one or more filter objects.
     * Passing more than one filter object acts as an OR clause.
     *
     * Every filter value must be DEFINED. A key whose value is `undefined`
     * makes the whole call throw an Error naming the offending key: the JSON
     * round-trip below would otherwise silently drop the key, degrading the
     * filter to a weaker one — a single-key filter degraded to `{}` and
     * matched EVERY record (#B396, gh #65). An explicitly empty `{}` filter
     * stays legal and matches everything (no constraint). `null` values are
     * legal needles and compare strictly against stored values.
     *
     * @param {...object} filters - filter object(s); values compare with `===`
     * @param {boolean} [withOrClause] - trailing boolean, forces OR mode
     * @throws {Error} when any filter key's value is `undefined`
     * @returns {array} result - decorated result set (chainable)
     */
    instance['find'] = function() {
        // reset
        withOrClause = false;

        if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
            withOrClause = arguments[arguments.length-1];
            delete arguments[arguments.length-1];
            --arguments.length;
        }

        // #B396 (gh #65) — refuse undefined-valued filter keys BEFORE the JSON
        // round-trip below: JSON.stringify() silently DROPS such keys, so the
        // in-loop guard further down could never see them. `findOne`, `or` and
        // `update` all delegate here, so this single gate covers the family
        // (`update` would otherwise mass-mutate every record on such a filter).
        var _fIdx = 0, _fLen = arguments.length, _fObj = null, _fKey = null;
        for (; _fIdx < _fLen; ++_fIdx) {
            _fObj = arguments[_fIdx];
            if ( _fObj && typeof(_fObj) == 'object' && !Array.isArray(_fObj) ) {
                for (_fKey in _fObj) {
                    if ( typeof(_fObj[_fKey]) == 'undefined' ) {
                        throw new Error('filter `'+ _fKey +'` cannot be left undefined');
                    }
                }
            }
        }
        _fObj = null;

        var filtersStr      = null;
        var filters         = null;
        var filtersCount    = null;
        try {
            filtersStr      = JSON.stringify(arguments);
            filters         = JSON.parse(filtersStr);
            filtersCount    = filters.count();
        } catch( filtersError) {
            throw new Error('filter must be an object\n'+ filtersError.stack);
        }

        if ( typeof(filters) != 'undefined' && filtersCount > 0 ) {

            if (filtersCount > 1) {
                withOrClause = true;
            }
            // checking filter : this should be forbidden -> { type: 'red', type: 'orange'}
            // var filtersFields = null;
            // for (let f = 0, fLen = filters.count(); f < fLen; f++) {
            //     filtersFields = {};
            //     for (let fField in filters[f]) {
            //         if (  typeof(filtersFields[ fField ]) != 'undefined' ) {
            //             throw new Error('Filter field can only be defined once inside a filter object !\n`Field '+ fField +'` is already defined : '+ filters[f])
            //         }
            //         filtersFields[ fField ] = true;
            //     }
            // }

            var filter              = null
                , condition         = null
                , i                 = 0
                //, tmpContent        = ( Array.isArray(this) && !withOrClause) ? this : JSON.clone(content)
                , tmpContent        = ( Array.isArray(this) ) ? this : JSON.clone(content)
                , resultObj         = {}
                , result            = []
                , localeLowerCase   = ''
                , re                = null
                , field             = null
                , fieldWithin       = null
                , value             = null
                , searchOptions     = localSearchOptions
                , searchOptionRules = options.searchOptionRules
            ;

            var matched = null
                , filterIsArray = null
                , searchResult = [];

            /**
             *  Regular Search
             * @param {object} filter
             * @param {string} field
             * @param {strine|number|date} _content
             * @param {number} matched
             */
            var search = function(filter, field, _content, matched, searchOptionRules) {
                if (
                    localSearchOptions
                    && typeof(localSearchOptions[field]) != 'undefined'
                ) {
                    searchOptionRules = merge(localSearchOptions, searchOptionRules);
                }

                var reValidCount = null, searchOptCount = null;
                 // null case
                if (filter === null && _content === null) {
                    ++matched;
                } else if (
                    filter
                    && keywords.indexOf(localeLowerCase) > -1
                    && localeLowerCase == 'not null'
                    && typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content != 'null'
                    && _content != 'undefined'
                ) {

                    if (result.indexOf(_content) < 0) {
                        ++matched;
                    }

                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && /(<|>|=)/.test(filter)
                    && !/undefined|function/.test(typeof(_content))
                    && !searchOptionRules.skipEval
                ) { // with operations
                    let condition = _content + filter;
                    if ( typeof(filter) == 'string' && typeof(_content) == 'string' ) {
                        // #B609 — was: quote `_content` and the partially-stripped filter,
                        // then concat. That threw on a `"` in either operand, failed to strip
                        // `==`/`>`/`<` (so the operator leaked into the operand), and kept a
                        // leading space in the compared value (wrong rows). Build both operands
                        // safely instead. `filter` is no longer mutated, so the datetime path
                        // below still sees the original string.
                        condition = buildStringCondition(_content, filter);
                    }

                    // looking for a datetime ?
                    if (
                        /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(_content)
                        && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(filter)
                    ) {

                        if (tryEval(_content.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")'))) {
                            ++matched;
                        }

                    } else if (tryEval(condition)) {
                        ++matched;
                    }

                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content === filter
                    && !searchOptions
                    ||
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content === filter
                    && typeof(searchOptions[field]) == 'undefined'
                    ||
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && _content === filter
                    && typeof(searchOptions[field]) != 'undefined'
                    && searchOptionRules.skipEval
                ) {

                    ++matched;
                } else if (
                    typeof(_content) != 'undefined'
                    && typeof(_content) !== 'object'
                    && searchOptions
                    && typeof(searchOptions[field]) != 'undefined'
                ) {
                    reValidCount    = 0;
                    searchOptCount  = searchOptions[field].count();
                    for ( let rule in searchOptions[field]) {
                        if ( typeof(searchOptionRules[rule][searchOptions[field][rule]]) == 'undefined' ) {
                            continue
                        }

                        // #B818 / #B819 — the value is matched as TEXT and the rule table is
                        // only read. The statements below spliced the raw value into the
                        // rule's template with a string replacer and ASSIGNED the result to
                        // the rule entry: a value holding a pattern character was compiled
                        // as a pattern (it threw out of the search, or matched other rows),
                        // a `$` sequence in a value was expanded, and the entry kept the
                        // FIRST value, so every later option search on the instance — or on
                        // any instance sharing the caller's rule table — matched that value.
                        // searchOptionRules[rule][searchOptions[field][rule]].re = searchOptionRules[rule][searchOptions[field][rule]].re.replace(/\%s/, filter);
                        //
                        // if (searchOptionRules[rule][searchOptions[field][rule]].modifiers) {
                        //     re = new RegExp(searchOptionRules[rule][searchOptions[field][rule]].re, searchOptionRules[rule][searchOptions[field][rule]].modifiers);
                        // } else {
                        //     re = new RegExp(searchOptionRules[rule][searchOptions[field][rule]].re);
                        // }
                        re = buildSearchOptionRegExp(searchOptionRules[rule][searchOptions[field][rule]], filter);

                        if ( re.test(_content) ) {
                            ++reValidCount
                        }
                    }

                    if (reValidCount == searchOptCount) {
                        ++matched;
                    }
                }

                return {
                    matched: matched
                };
            }

            /**
             * Search on a dotted key: walk `f` as a property path of `_content`
             * and compare the value found there with `filter`.
             *
             * `f` must be a property path (`a.b.c`, identifiers separated by
             * dots). Any other dotted key matches nothing: the path check below
             * refuses it and no value is read.
             *
             * @inner
             * @private
             * @param {*}      filter   - The filter value, or a comparison (`'>= 4'`)
             * @param {string} f        - The dotted key
             * @param {object} _content - The row, or the element of a `[*]` array
             * @param {number} matched  - The conditions matched so far
             * @returns {{matched: number}} `matched`, plus one when the value matches
             */
            var searchThroughProp = function(filter, f, _content, matched) {

                // #B821 — dead code that could only throw. The expression was built
                // from the last segment of the filter KEY and never read (the only
                // read of `re` follows its own assignment, in the search-option
                // branch above), so a key holding `(`, `)` or `[` threw a
                // SyntaxError out of the search, before the path check below could
                // refuse the key like any other dotted key that is not a path.
                // var field = f.split(/\./g);
                // field = field[field.length - 1];
                // re = new RegExp('("' + field + '":\\w+)');

                var value = null;

                // #SCS1d (2026-04-23) — replaced `eval('_content.' + f)` with a safe dot-path
                // walker. `f` arrives here as a dot-separated path like `"ratings.Cleanliness"`
                // (the `[*]` bracket-star variant is already stripped by searchWithin before
                // this function is called — see split at line 438). User-controlled filter
                // keys flowed through this without sanitisation; the old eval executed
                // anything that parsed as JS, e.g. a key like
                // `"constructor.constructor('return process.exit()')()"` would fire on lookup.
                // try {
                //     if ( _content )
                //         value = eval('_content.'+f);
                // } catch (err) {
                //     // Nothing to do
                //     // means that the field is not available in the collection
                // }
                try {
                    if ( _content ) {
                        if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(f)) {
                            throw new Error('Invalid property path: `'+ f +'`');
                        }
                        var _segments = f.split('.');
                        var _cur = _content;
                        for (var _si = 0; _cur != null && _si < _segments.length; _si++) {
                            _cur = _cur[_segments[_si]];
                        }
                        value = _cur;
                    }
                } catch (err) {
                    // Nothing to do
                    // means that the field is not available in the collection
                }



                if (value /** && value.length > 0*/) {
                    if ( Array.isArray(value) )
                        value = value[1].split(/:/)[1];
                    else if ( typeof(value) == 'string' && /\:/.test(value) )
                        value = value.split(/:/)[1];


                    if (/(<|>|=)/.test(filter)) {

                        // looking for a datetime ?
                        if (
                            /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(value)
                            && /(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/.test(filter)
                        ) {

                            if (tryEval(value.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")') + filter.replace(/(\d{4})\-(\d{2})\-(\d{2})(\s+|T)(\d{2}):(\d{2}):(\d{2})/, 'new Date("$&")'))) {

                                ++matched;
                            }

                        } else if (typeof(value) == 'string') {
                            // #B609 — a string value must be JSON-encoded like the find() path;
                            // `value + filter` (unquoted) threw for every string comparison here.
                            if (tryEval(buildStringCondition(value, filter))) {
                                ++matched;
                            }
                        } else if (tryEval(value + filter)) {

                            ++matched;
                        }

                    } else {
                        if (value == filter) {
                            ++matched;
                        }
                    }

                }

                return {
                    matched: matched
                }
            }

            // if one of the entry matches the given filter, tag the whole entry as matched
            var searchWithin = function(filter, f, _content, matched, i) {

                var collectionName  = null
                    , collection    = null
                    , arr           = null
                    , field         = null;


                arr = f.split(/\[\*\]/g);
                collectionName = arr[0].replace(/\[\*\]/, '');// only take the first collection
                collection = _content[ collectionName ];


                field = arr[1];
                if (/^\./.test(field) )
                    field = field.substring(1);

                var subMatched = 0;
                if (collection) {

                    for (var c = 0, cLen = collection.length; c < cLen; ++c) {
                        // cases with _filter.prop
                        if (/\./.test(field)) {

                            searchResult = searchThroughProp(filter, field, collection[c], subMatched);
                            subMatched = searchResult.matched;

                        } else { // normal case

                            searchResult = search(filter, field, collection[c], subMatched, searchOptionRules);
                            subMatched = searchResult.matched;
                        }

                        if (subMatched > 0) break;
                    }
                }

                return {
                    matched: (matched + subMatched)
                }
            }


            for (var o in tmpContent) {

                if (!tmpContent[o]) {
                    tmpContent[o] = {}
                }

                if (!/undefined|function/.test( typeof(tmpContent[o]))) {

                    for (let l = 0, lLen = filters.count(); l<lLen; ++l) {
                        filter = filters[l];
                        condition = filter.count();
                        // for each condition
                        matched = 0;

                        for (var f in filter) {
                            // Belt only since #B396: undefined-valued keys are refused at
                            // the method entry, before the JSON round-trip that used to
                            // strip them — and JSON.parse can never produce such a value
                            // here, so this in-loop guard is unreachable by construction.
                            if ( typeof(filter[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                            localeLowerCase = ( filter[f] !== null && !/(boolean|number)/.test(typeof(filter[f])) ) ? filter[f].toLocaleLowerCase() : filter[f];

                            // cases with tmpContent.prop
                            if (/\./.test(f)) {
                                //JSON.stringify(tmpContent[o]).match(/("gross":\w+)/)[1].split(/:/)[1]

                                // detect if array|collection case
                                if (/\[\*\]/.test(f)) {

                                    searchResult = searchWithin(filter[f], f, tmpContent[o], matched, 0);
                                    matched = searchResult.matched;

                                } else {

                                    searchResult = searchThroughProp(filter[f], f, tmpContent[o], matched);
                                    matched = searchResult.matched;
                                }

                            } else { // normal case

                                searchResult = search(filter[f], f, tmpContent[o][f], matched, searchOptionRules);
                                matched = searchResult.matched;
                            }
                        }

                        if (matched == condition ) { // all conditions must be fulfilled to match
                            // `this` {Array} is the result of the previous search or the current content
                            // TODO - Add a switch
                            if (
                                withOrClause
                                && notInSearchModeEnabled
                                && searchIndex.indexOf(tmpContent[o]._uuid) < 0
                                || notInSearchModeEnabled
                                || !withOrClause
                            ) {
                                //console.debug('searchIndex ', searchIndex);
                                if (!withOrClause || withOrClause && result.indexOf(tmpContent[o]._uuid) < 0 || notInSearchModeEnabled) {
                                    result[i] = tmpContent[o];
                                    ++i;
                                }
                            } else if (
                                withOrClause
                                && !notInSearchModeEnabled
                            ) {
                                if (result.indexOf(tmpContent[o]._uuid) < 0) {
                                    result[i] = tmpContent[o];
                                    ++i;
                                }
                            }
                        }

                    }

                }
            }
        } else {
            result = content
        }

        // reset localSearchOptions for nest calls
        localSearchOptions = null;

        // TODO - remove this
        //if (withOrClause) {
            // merging with previous result
            //console.debug('withOrClause: supposed to merge ? \nnotInSearchModeEnabled: '+notInSearchModeEnabled+'\nResult: ' +result)//+'\nThis: '+ this.toRaw();
            // if (!notInSearchModeEnabled) {
            //     result  = merge(this, result);
            // }
            // TODO - remove this part
            // Removed this on 2021-01-21 because it was causing duplicate content
            //result  = merge(this, result, true)
        //}

        // chaining
        //result._options         = instance._options;
        //result.setSearchOption  = instance.setSearchOption;

        result.insert           = instance.insert;
        result.notIn            = instance.notIn;
        result.find             = this.find;
        result.update           = instance.update;
        result.replace          = instance.replace;
        result.or               = instance.or;
        result.findOne          = instance.findOne;
        result.limit            = instance.limit;
        result.orderBy          = instance.orderBy;
        result.delete           = instance.delete;
        result.toRaw            = instance.toRaw;
        result.filter           = instance.filter;

        return result
    }

    /**
     * findOne
     *
     * E.g.:
     *  - new Collection(projects).findOne({name: 'My Project'})
     *  - new Collection(projects)
     *              .setSearchOption({name: { isCaseSensitive: false }})
     *              .findOne({name: 'my project'})
     *
     *
     * Available options :
     *  isCaseSensitive: [true|false] - set to true by default
     *  skipEval: [true|false] - set to false by default
     *
     * @param {object} filter
     *
     * @returns {object} result
     *
    */
    instance['findOne'] = function() {
        var key         = null // comparison key
            , result    = null
            , filters   = null
            //, uuidSearchModeEnabled = true
        ;

        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ findOne ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        //var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );
        var currentResult = null;
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        if (foundResults.length > 0) {
            currentResult = foundResults.limit(1).toRaw()[0];
        }

        result          = currentResult;
        return result
    }


    instance['or'] = function () {
        arguments[arguments.length] = true;
        ++arguments.length;

        return instance.find.apply(this, arguments);
    }

    instance['limit'] = function(resultLimit) {
        if ( typeof(resultLimit) == 'undefined' || typeof(resultLimit) != 'number' ) {
            throw new Error('[Collection::result->limit(resultLimit)] : `resultLimit` parametter must by a `number`')
        }

        var result = Array.isArray(this) ? this : JSON.clone(content);

        //resultLimit
        result = result.splice(0, resultLimit);

        // chaining
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.notIn    = instance.notIn;
        result.findOne  = instance.findOne;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * notIn
     * Works like a filter to match results by `excluding` through given `filters` !!
     *
     *  filter can be like
     *      { car: 'toyota' }
     *      { car: 'toyota', color: 'red' }
     *
     *  You can pass more than one filter
     *      { car: 'toyota', color: 'red' }, { car: 'porche' }
     *
     * .notIn(filter) // AND syntax
     * .notIn(filter1, filter2, filter3) // OR syntax
     * .notIn(filter, 'id') where `id` is the uuid used for the DIFF - `_uuid
     * .noIn(collectionObj, 'id')
     *
     * By default, Collection use its own internal `_uuid` to search and compare.
     * This mode is called `uuidSearchModeEnabled`, and it is by default set to `true`.
     * If you want to disable this mode in order to MATCH/DIFF by forcing check on every single filter
     * of the resultset :
     *      .notIn(filter, false) where false must be a real boolean
     *
     *
     *
     * @param {object|array} filters|arrayToFilter - works like find filterss
     * @param {string} [key] - unique id for comparison; faster when provided
    */
    instance['notIn'] =  function(){

        var arrayToFilter           = null // [] those that we don't want in the result
            , key                   = null //  string comparison key
            , result                = null
            , filters               = null
            , uuidSearchModeEnabled = true
        ;

        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
            uuidSearchModeEnabled = arguments[arguments.length - 1]
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ notIn ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );

        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults    = arguments[0];
        } else {
            notInSearchModeEnabled = true;
            foundResults    = instance.find.apply(this, arguments) || [];
            notInSearchModeEnabled = false;
        }


        if (foundResults.length > 0) {

            // check key
            if (
                uuidSearchModeEnabled
                && key
                && typeof(foundResults[0]) == 'undefined'
                && typeof(foundResults[0][key]) == 'undefined'
            ) {
                throw new Error('[ Collection ][ notIn ] `key` not valid');
            } else if ( uuidSearchModeEnabled && !key && typeof(foundResults[0]['_uuid']) != 'undefined' ) {
                key = '_uuid'
            } else if ( typeof(foundResults[0]['id']) != 'undefined' ) {
                key = 'id';
            }

            if ( !key || typeof(foundResults[0][key]) == 'undefined' ) {
                throw new Error('No comparison key defined !')
            }

            // fast search with key
            var r                       = 0
                , rLen                  = foundResults.length
                , c                     = 0
                , cLen                  = currentResult.length
                , f                     = 0
                , fLen                  = filters.count()
                , keyLen                = null
                , matched               = 0
                , fullFiltersMatched    = 0
            ;
            if ( uuidSearchModeEnabled && typeof(currentResult[c]) != 'undefined' && currentResult[c].hasOwnProperty(key) ) {
                // for every single result found
                for (; r < rLen; ++r) {

                    if (!currentResult.length) break;

                    c = 0; cLen = currentResult.length;
                    for (; c < cLen; ++c) {
                        if ( typeof(currentResult[c]) == 'undefined' || typeof(foundResults[r]) == 'undefined' ) {
                            continue
                        }
                        // when matched, we want to remove those not in current result
                        if (currentResult[c][key] === foundResults[r][key]) {
                            currentResult.splice(c,1);
                            break;
                        }
                    }
                }
            } else if ( typeof(currentResult[c]) == 'undefined' ) { //empty source case
                // means that since we don't have a source to compare, current === found
                currentResult = JSON.clone(foundResults);

            } else { // search based on provided filters
                // for every single result found
                for (; r < rLen; ++r) {
                    if (!currentResult.length) break;

                    //onRemoved:
                    c = 0; cLen = currentResult.length;
                    for (; c < cLen; ++c) { // current results

                        if ( typeof (currentResult[c]) != 'undefined' ) {

                            // for each filter
                            fullFiltersMatched = 0;
                            f = 0;
                            for (; f < fLen; ++f ) {
                                if ( typeof(filters[f]) == 'undefined' ) throw new Error('filter `'+f+'` cannot be left undefined');

                                keyLen = filters[f].count();
                                matched = 0;
                                for (key in filters[f]) {
                                    if ( currentResult[c].hasOwnProperty(key) && currentResult[c][key] === foundResults[r][key] ) {
                                        ++matched;
                                    }
                                }
                                if (matched == keyLen) {
                                    ++fullFiltersMatched
                                }
                            }

                            if (fullFiltersMatched) {
                                currentResult.splice(c,1);
                                //break onRemoved;
                                break;
                            }

                        }
                    }
                }
            }

        }

        result          = currentResult;
        result.notIn    = instance.notIn;
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.replace  = instance.replace;
        result.update   = instance.update;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    instance['insert'] = function (set) {

        var result = null;
        if ( typeof(set) !== 'object' ) {
            throw new Error('filter must be an object');
        } else {

            var tmpContent = Array.isArray(this) ? this : content;

            // Indexing; 16-char to match the constructor's collision-safe size.
            set._uuid = uuid(16);
            tmpContent.push(set);

            result = tmpContent;
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * update
     *
     * @param {object} filter
     * @param {object} set
     *
     * @returns {objet} instance
     */
    instance['update'] = function() {
        var key         = '_uuid' // comparison key is _uuid by default
            , result    = null
            , filters   = null
            , set       = null
            //, uuidSearchModeEnabled = true
        ;

        // comparison key  : _uuid by default, but can be set to id
        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'object' ) {
            set = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ update ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        if ( typeof(set) == 'undefined' || !set || typeof(set) != 'object' ) {
            throw new Error('[ Collection ][ update ] `set` argument must be defined: Object expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        result = Array.isArray(this) ? this : JSON.clone(content);
        if (foundResults.length > 0 ) {
            var arr = foundResults.toRaw();
            for (var a = 0, aLen = arr.length; a < aLen; ++a) {
                arr[a] = merge(JSON.clone(set), arr[a]);
                // arr[a] = merge(set, arr[a]);
                for (var r = 0, rLen = result.length; r < rLen; ++r) {
                    if ( typeof(result[r][key]) == 'undefined' && key == '_uuid' && typeof(result[r]['id']) != 'undefined' ) {
                        key = 'id';
                    }

                    if ( result[r][key] == arr[a][key] ) {
                        result[r] = arr[a];
                        break;
                    }
                }
            }
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }


    /**
     * Replaces each matched entry with `set`, wholesale — unlike `.update()`,
     * which merges. Matching is done in two stages: `filter` selects the entries
     * (same syntax as `.find()`), then each selected entry is located in the
     * result by comparing a single key against the same key on `set`.
     *
     * That comparison key is resolved per entry, from BOTH sides:
     *
     *  1. the internal `_uuid` when the stored entry AND `set` both carry one;
     *  2. otherwise `id`, when both carry one;
     *  3. otherwise the call throws — a `set` sharing no key with the stored
     *     entry cannot be matched, and refusing is preferable to returning a
     *     result that silently replaced nothing.
     *
     * Pass `key` to name the comparison key explicitly; it is then used as given,
     * with no fallback and no refusal.
     *
     * N.B. a chained result carries the internal `_uuid` on every entry the call
     * did not replace. Persist `.toRaw()` rather than the chained array if the
     * data is going to be re-loaded into a new Collection later.
     *
     * @param {object|Array} filter    - Entry selector, as `.find()` — or an already-found result array
     * @param {object}       set       - The replacement entry (replaces the match wholesale)
     * @param {string}       [key]     - Explicit comparison key; skips the resolution above
     * @returns {Array} the chainable result set
     *
     * @throws {Error} `No comparison key defined !` when neither side shares a usable key
     *
     * @example
     * // matched by the internal _uuid when both sides carry it, else by id
     * col.replace({ id: 1 }, { id: 1, name: 'Alicia' });
     *
     * @example
     * // explicit comparison key
     * col.replace({ ref: 'r1' }, { ref: 'r1', name: 'Alicia' }, 'ref');
     */
    instance['replace'] = function() {
        var key         = '_uuid' // comparison key
            // #B393 — whether the caller named the comparison key explicitly. An
            // explicit key is honoured as given (no fallback, no refusal), exactly
            // as before; only the DEFAULT `_uuid` path resolves a key below.
            , keyExplicit = false
            , result    = null
            , filters   = null
            , set       = null
            //, uuidSearchModeEnabled = true
        ;


        if ( typeof(arguments[arguments.length-1]) == 'string' ) {
            key = arguments[arguments.length - 1];
            keyExplicit = true;
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        if ( typeof(arguments[arguments.length-1]) == 'object' ) {
            set = arguments[arguments.length - 1];
            delete arguments[arguments.length - 1];
            --arguments.length;
        }

        // if ( typeof(arguments[arguments.length-1]) == 'boolean' ) {
        //     uuidSearchModeEnabled = arguments[arguments.length - 1]
        //     delete arguments[arguments.length - 1];
        //     --arguments.length;
        // }

        if (arguments.length > 0) {
            filters = arguments;
        }


        if ( typeof(filters) == 'undefined' || !filters || typeof(filters) != 'object' ) {
            throw new Error('[ Collection ][ update ] `filters` argument must be defined: Array or Filter Object(s) expected');
        }

        if ( typeof(set) == 'undefined' || !set || typeof(set) != 'object' ) {
            throw new Error('[ Collection ][ update ] `set` argument must be defined: Object expected');
        }

        // If an operation (find, insert ...) has been executed, get the previous result; if not, get the whole collection
        //var currentResult = JSON.clone( (Array.isArray(this)) ? this : content );
        var currentResult = null;
        var foundResults = null;
        if ( Array.isArray(arguments[0]) ) {
            foundResults = arguments[0];
        } else {
            foundResults = instance.find.apply(this, arguments) || [];
        }

        result = Array.isArray(this) ? this : JSON.clone(content);
        if (foundResults.length > 0 ) {
            var arr = foundResults.toRaw();
            for (var a = 0, aLen = arr.length; a < aLen; ++a) {
                arr[a] = JSON.clone(set);
                for (var r = 0, rLen = result.length; r < rLen; ++r) {
                    // #B393 — resolve the comparison key from BOTH sides, per entry.
                    //
                    // Previously the key was chosen by inspecting the STORED entry
                    // only, and was mutated in place. Two consequences, both fixed
                    // here:
                    //
                    //  (a) When the stored entry carried a `_uuid` and the caller's
                    //      `set` did not, neither the `id` fallback nor the refusal
                    //      fired (both were gated on the STORED entry lacking the
                    //      key), so the comparison was `<storedUuid> == undefined` —
                    //      never true. Nothing matched, nothing was replaced, and the
                    //      call returned a successful-looking result: a silent, lossy
                    //      write. A stored `_uuid` is present exactly when the caller
                    //      re-loaded an array a previous chained call had returned.
                    //  (b) `key` was assigned rather than shadowed, so once any entry
                    //      flipped it to `id` it stayed `id` for every later entry in
                    //      the same call.
                    //
                    // `cmpKey` is derived per (a, r) pair and the outer `key` is never
                    // written, so a fallback can no longer leak across iterations.
                    var cmpKey = key;
                    if ( !keyExplicit ) {
                        if (
                            typeof(result[r][cmpKey]) == 'undefined'
                            || typeof(arr[a][cmpKey]) == 'undefined'
                        ) {
                            if (
                                typeof(result[r]['id']) != 'undefined'
                                && typeof(arr[a]['id']) != 'undefined'
                            ) {
                                cmpKey = 'id';
                            }
                        }
                        // No key both sides carry: refuse loudly rather than return a
                        // result that silently replaced nothing.
                        if (
                            typeof(result[r][cmpKey]) == 'undefined'
                            || typeof(arr[a][cmpKey]) == 'undefined'
                        ) {
                            throw new Error('No comparison key defined !')
                        }
                    }

                    if ( result[r][cmpKey] == arr[a][cmpKey] ) {
                        result[r] = arr[a];
                        break;
                    }
                }
            }
        }

        // chaining
        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.delete   = instance.delete;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    }

    /**
     * .delete({ key: 2 })
     * .delete({ name: 'Jordan' }, ''id) where id will be use as the `uuid` to compare records
     *
     * AND syntax
     * .delete({ car: 'toyota', color: 'red' })
     *
     * OR syntax
     * .delete({ car: 'toyota', color: red }, { car: 'ford' } ) // will delete all `toyota red cars` & all `ford cars`
     *
     *  N.B.: will not affect current result - just returning the DIFF
     *  If you
     * @param {object} filter - same as `.find(filter)`
     * @param {string|boolean} [ uuid | disabled ] - by default, Collection is using its internal _uuid
     * If you want to delete without key comparison, disable `uuid` search mode
     * .delete({ name: 'Jordan' }, false)
     *
     * @returns {array} result
     */
    instance['delete'] = function() {

        var result = instance.notIn.apply(this, arguments);

        result.limit    = instance.limit;
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.notIn    = instance.notIn;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;
        result.delete   = this.delete;

        return result
    }


    var sortKeywords = [ 'asc', 'desc' ];
    /**
     * sort
     *
     * @param {object|array} filter
     * */
    instance['orderBy'] = function () {

        if ( typeof(arguments) == 'undefined' || arguments.length < 1)
            throw new Error('[ Collection->orderBy(filter) ] where `filter` must not be empty or null' );

        var filter = null;
        if ( arguments.length == 1 ) {
            filter = arguments[0];
        } else {
            // converting arguments into array
            filter = new Array(arguments.length);
            for (var f = 0, fLen = filter.length; f < fLen; ++f) {
                filter[f] = arguments[f]
            }
        }

        var variableContent = (Array.isArray(this)) ? this : JSON.clone(content);
        return sortResult(filter, variableContent.toRaw())
    }

    /**
     * max
     * E.g:
     *  myCollection.max({ order: 'not null'})
     *      => 5
     *  myCollection.max({ createAt: 'not null'})
     *      => '2021-12-31T23:59:59'
     *  myCollection.max({ firstName: 'not null'})
     *      => 'Zora'
     *
     * @param {object|array} filter
     *
     * @returns {number|date|string}
     * */
    instance['max'] = function () {
        if ( typeof(arguments) == 'undefined' || arguments.length < 1)
            throw new Error('[ Collection->max(filter) ] where `filter` must not be empty or null' );

        var filter = null;
        if (
            arguments.length > 1
            || Array.isArray(arguments[0])
            || typeof(arguments[0]) == 'object' && arguments[0].count() > 1
        ) {
            throw new Error('[ Collection->max(filter) ] only accept one filter length, and fileter count must be equal to 1' );
        }
        filter = arguments[0];
        try {
            var key = Object.keys(filter)[0];
            var subFilter = {};
            subFilter[key] = 'desc';
            return instance['find'](filter).orderBy(subFilter).limit(1)[0][key];
        } catch (err) {
            throw err
        }
    }

    /**
     * sortResult
     * ref.:
     *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort
     *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare#Browser_compatibility
     *
     * e.g.:
     *  .orderBy({ name: 'asc' })
     *
     *  // overriding filters -> last filter is always right
     *  .orderBy([ { updatedAt : 'desc'}, { name: 'asc' } ])
     *
     *  // sorting boolean
     *  .orderBy({ isActive: 'desc'}) => will display all active(TRUE) first
     *  NB.: Boolean are 0 (FALSE) or 1 (TRUE)
     *
     *  // combining filters -> the first one is always right
     *  .orderBy({ updatedAt : 'desc'}, { name: 'asc' })
     *
     * @param {object|array} filter
     * */
    var sortResult = function (filter, content) {
        if ( typeof(filter) != 'object') {
            throw new Error('`filter` parametter must be an object or an array')
        }

        var condition           = filter.count()
            , sortOp            = {}
            , multiSortOp       = null
            , sortRecursive     = null
            , key               = null
            , prop              = null
            , result            = []
        ;

        if (condition == 0) return null;


        // asc
        sortOp['asc'] = function (prop, content) {

            var mapped = content.map(function(obj, i) {
                var _m = {};
                _m.index = i;
                _m[prop] = obj[prop];
                return _m;
            });

            mapped.sort(function onAscSort(a, b) {


                var _compare = function(a, b) {
                    // handle booleans
                    if ( /^(true|false)$/i.test(a) ) {
                        a = ( /true/i.test(a) ) ? 1 : 0;
                    }

                    if ( /^(true|false)$/i.test(b) ) {
                        b = ( /true/i.test(b) ) ? 1 : 0;
                    }


                    if ( typeof(a) == 'string' && a != '' ||  typeof(b) == 'string' ) {
                        // Fixed on 2025-03-08: allowed to compare with one of the fields being NULL or not defined
                        if ( typeof(a) == 'undefined' || a == null) {
                            a = ''; // cast to string
                        }
                        if ( typeof(b) == 'undefined' || b == null) {
                            b = ''; // cast to string
                        }

                        if ( typeof(a) == 'number' ) {
                            a = ''+a; // cast to string
                        }
                        if ( typeof(b) == 'number' ) {
                            b = ''+b; // cast to string
                        }


                        return a.localeCompare(b, undefined, {sensitivity: 'case', caseFirst: 'upper'})
                    }

                    if (a > b) {
                        return 1;
                    }
                    if (a < b) {
                        return -1;
                    }
                    // a must be equal to b
                    return 0;
                }


                if ( typeof(a) == 'object' ) {
                    return _compare(a[prop], b[prop])
                }

                return _compare(a, b)

            });

            return mapped.map(function(m, index, result){
                return content[m.index];
            });
        }

        // desc
        sortOp['desc'] = function (prop, content) {
            return sortOp['asc'](prop, content).reverse()
        }

        multiSortOp = function(content, filter) {

            var props = [], keys = [];

            if ( Array.isArray(filter) ) {
                for (var f = 0, fLen = filter.length; f < fLen; ++f) {
                    props[f] = Object.keys(filter[f])[0];
                    keys[f] = filter[f][ props[f]] ;
                }
            } else {
                var f = 0;
                for (var flt in filter) {
                    props[f] = flt;
                    keys[f] = filter[flt] ;
                    ++f;
                }
            }



            sortRecursive = function(a, b, columns, order_by, index) {

                var direction = order_by[index] == 'desc' ? 1 : 0;

                var res = null, x = null, y = null;

                if ( typeof(a[columns[index]]) == 'string' && a[columns[index]] != '' ) {

                    res = a[columns[index]].localeCompare(b[columns[index]]);

                    if ( direction == 0 && res != 0 ) {
                        return res < 0 ? -1 : 1
                    } else if (res != 0) {
                        return res < 0 ? 1 : -1
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else if (typeof (a[columns[index]]) == 'number' || typeof(b[columns[index]]) == 'number' ) {

                    res = (''+ a[columns[index]]).localeCompare((''+ b[columns[index]]), undefined, { numeric: true });

                    if (direction == 0 && res != 0) {
                        return res < 0 ? -1 : 1
                    } else if (res != 0) {
                        return res < 0 ? 1 : -1
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else if ( typeof(a[columns[index]]) == 'boolean' || typeof (b[columns[index]]) == 'boolean' ) {

                    if ( typeof(a[columns[index]]) == 'boolean' ) {
                        x = (a[columns[index]]) ? 1 : 0;
                    }

                    if ( typeof(b[columns[index]]) == 'boolean' ) {
                        y = (b[columns[index]]) ? 1 : 0;
                    }

                    if (x > y) {
                        return direction == 0 ? 1 : -1;
                    }

                    if (x < y) {
                        return direction == 0 ? -1: 1;
                    }

                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;

                } else {

                    if (a[columns[index]] > b[columns[index]]) {
                        return direction == 0 ? 1 : -1;
                    }

                    if (a[columns[index]] < b[columns[index]]) {
                        return direction == 0 ? -1 : 1;
                    }
                    // a must be equal to b
                    return columns.length - 1 > index ? sortRecursive(a, b, columns, order_by, index + 1) : 0;
                }
            }

            return content.sort(function onMultiSort(a, b) {
                return sortRecursive(a, b, props, keys, 0);
            });
            // return mapped.map(function(m, index, result){
            //     return content[m.index];
            // });
        }

        if ( Array.isArray(filter) || filter.count() > 1 ) {

            result = multiSortOp(content, filter);

        } else {

            prop    = Object.keys(filter)[0];
            key     = filter[prop];

            result  = sortOp[key](prop, content);
        }



        // chaining
        result.find     = instance.find;
        result.findOne  = instance.findOne;
        result.limit    = instance.limit;
        result.notIn    = instance.notIn;
        result.insert   = instance.insert;
        result.update   = instance.update;
        result.replace  = instance.replace;
        result.delete   = instance.delete;
        result.orderBy  = instance.orderBy;
        result.max      = instance.max;
        result.toRaw    = instance.toRaw;
        result.filter   = instance.filter;

        return result
    };

    /**
     * toRaw
     * Transform result into a clean format (without _uuid)
     *
     * @returns {array} result
     * */
    instance['toRaw'] = function() {

        var result = ( Array.isArray(this) ) ? this.slice() : content.slice();
        // cleanup
        for (var i = 0, len = result.length; i < len; ++i) {
            if (result[i]._hasItsOwnUuid) {
                let hasItsOwnUuid = (/^true$/i.test(result[i]._hasItsOwnUuid) ) ? true : false;
                delete result[i]._hasItsOwnUuid;
                if (hasItsOwnUuid) {
                    continue;
                }
            }
            if (result[i]._uuid) {
                delete result[i]._uuid;
            }
        }

        // return JSON.clone(result);
        return result
    }

    /**
     * filter
     * With a FUNCTION, filters like `Array.prototype.filter`: the callback gets
     * `(row, index, array)` and `thisArg` as its `this`, and the result is a
     * `find()`-style result: the matching rows (the same objects) with the methods
     * `find()` attaches, so `.toRaw()` and the chain keep working.
     * With a field name or a list of field names, projects each row onto those
     * fields and returns a plain, deep-cloned array.
     *
     * #B517 — a function used to be read as a field name, so `rows.filter(fn)`
     * matched nothing and returned `[]` with no error.
     *
     * @param {function|string|array} filter - a predicate, a field name, or a list of field names
     *  e.g: function (row) { return row.active; }
     *  e.g: 'id'
     *  e.g: ['id', 'name']
     * @param {*} [thisArg] - `this` for the predicate (function form only)
     *
     * @returns {array} the matching rows (function form), or rawFilteredResult (projection)
     * @throws {Error} when `filter` is undefined
     *
     * @example
     * var col = new Collection([{ id: 1, active: true }, { id: 2, active: false }]);
     * col.find({}).filter(function (row) { return row.active; }).toRaw(); // [{ id: 1, active: true }]
     * col.find({}).filter('id');                                           // [{ id: 1 }, { id: 2 }]
     * */
     instance['filter'] = function(filter, thisArg) {

        if ( typeof(filter) == 'undefined' ) {
            // was: throw new Error('`filter` parametter must be a string or an array.');
            throw new Error('`filter` parameter must be a function, a string or an array.');
        }
        var result = ( Array.isArray(this) ) ? this : content;

        // #B517 — a function filters like Array.prototype.filter. The projection below
        // read it as a field name, matched nothing and returned [] with no error. The
        // result gets the methods find() attaches, so .toRaw() and the chain keep working.
        if ( typeof(filter) == 'function' ) {
            var filtered            = Array.prototype.filter.call(result, filter, thisArg);
            filtered.notIn          = instance.notIn;
            filtered.find           = instance.find;
            filtered.update         = instance.update;
            filtered.replace        = instance.replace;
            filtered.or             = instance.or;
            filtered.findOne        = instance.findOne;
            filtered.limit          = instance.limit;
            filtered.orderBy        = instance.orderBy;
            filtered.delete         = instance.delete;
            filtered.toRaw          = instance.toRaw;
            filtered.filter         = instance.filter;

            return filtered
        }
        if ( !result.length ) {
            return []
        }
        var i = 0, len = result.length;
        var rawFilteredResult = [], fCount = 0;

        if ( Array.isArray(filter) ) {
            var f = null, fLen = filter.length, wrote = null;
            for (; i < len; ++i) {
                wrote = false;
                f = 0;
                for (; f < fLen; ++f) {
                    if ( typeof(result[i][ filter[f] ]) != 'undefined' ) {
                        if ( typeof(rawFilteredResult[fCount]) == 'undefined' ) {
                            rawFilteredResult[fCount] = {}
                        }
                        rawFilteredResult[fCount][ filter[f] ] = result[i][ filter[f] ];
                        wrote = true;
                    }
                }
                if (wrote)
                    ++fCount;
            }
        } else {
            for (; i < len; ++i) {
                if ( typeof(result[i][filter]) != 'undefined' ) {
                    if ( typeof(rawFilteredResult[fCount]) == 'undefined' ) {
                        rawFilteredResult[fCount] = {}
                    }
                    rawFilteredResult[fCount][filter] = result[i][filter];
                    ++fCount;
                }
            }
        }

        return JSON.clone(rawFilteredResult);
    }


    return instance;
};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Collection
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return Collection })
}