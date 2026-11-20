/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/dto
 *
 * Native Gina schema/DTO builder. Zero runtime deps, CJS/`var`, no `class`.
 *
 * A DTO is authored ONCE and reused for three projections:
 *
 *   var dto = require('gina').dto;                 // global helper, like getModel/getConfig
 *   var CreateUser = dto.object({
 *       email: dto.string().email().required(),
 *       age:   dto.integer().min(0).max(120),      // value bounds -> canonical minimum/maximum
 *       role:  dto.enum(['admin', 'user']).required()
 *   }).as('CreateUser');
 *
 *   CreateUser.toJsonSchema('2020-12');  // OpenAPI 3.1 requestBody (identity — canonical)
 *   CreateUser.toJsonSchema('draft-07'); // MCP inputSchema.body + the house config-schema dialect
 *   CreateUser.toJsonSchema('2020-12', { dropExcluded: true }); // response-side (200 / outputSchema):
 *                                        // `.exclude()`d fields omitted — they never reach the wire (#B110)
 *   CreateUser.toRules();                // the live form-validator rules-object (server + client)
 *   CreateUser.name;                     // stable id for the dto:types generator + drift gate + routing param.dto
 *
 * ## JSON-Schema-canonical
 * The builder's internal representation IS a JSON Schema fragment. `toJsonSchema()`
 * is the identity; `toRules()` is the DERIVED projection (compiled to the live
 * form-validator engine — the same engine `routing.json` `validator::` rules and
 * `forms/rules/*.json` already use, so a DTO unifies validation rather than adding a
 * parallel validator). This makes the choice of runtime backend reversible and gives
 * the emitter maximum OpenAPI fidelity.
 *
 * ## Curated vocabulary
 * A deliberate subset of the engine's rules (form-validator.js): isEmail, isRequired,
 * isBoolean, isNumber, isInteger, isString(+min/maxLength), isDate, isInList (enum),
 * exclude, trim. It EXCLUDES `toFloat` (a coercion transform, kept out of the
 * DTO vocabulary — its historical unguarded-`document` server crash is fixed
 * by #B398) and `query` (spins a Controller) — a DTO must never emit them.
 *
 * ## Value-range (`.min()/.max()`) — schema-canonical, runtime-deferred (measured)
 * The engine has NO min/max-VALUE rule, and its generic `is` condition can only
 * express a value bound via a `$field` self-reference — which crashes the server-side
 * form-body path (`main.js` `validate()` reads `$fields.count()` on the null server
 * `$fields`; a #B85-sibling). So a value bound is carried in the CANONICAL JSON Schema
 * as `minimum`/`maximum` (perfect OpenAPI/MCP fidelity) and is NOT enforced at runtime
 * by `toRules()` in this cut — runtime value-bound enforcement is a labelled follow-on
 * (a first-class engine rule, which is browser-bundled and needs a dist rebuild).
 * The runtime pipe still enforces TYPE (isInteger/isNumber) + enum + length + format
 * + required.
 *
 * ## The `$` guard (#DTO2 — measured; rationale updated with #B239)
 * `toRules()` compiles no `$` of its own (see above), but a `$` can still reach the
 * emitted rules through AUTHORED content — an enum value (`dto.enum(['$100'])`), a
 * field NAME, or a date mask. `$` is the validation engine's RESERVED cross-field
 * reference sigil, so whether an authored `$` survives as a literal depends on a
 * runtime field-name COLLISION: a token naming a sibling field is consumed upstream
 * as a reference (substituted + quoted — #B240 — so the literal can never match),
 * while a token naming no field stays literal only since #B239 (before that it
 * crashed the whole pass; earlier still, ANY leftover `$` crashed server-side —
 * #B127/#B234). Deterministic literal semantics are impossible to guarantee for a
 * `$`, so `toRules()` REJECTS one anywhere in its output at build/boot rather than
 * let a DTO validate differently depending on which field names exist beside it.
 * `toJsonSchema()` is deliberately NOT guarded — a `$` is perfectly valid in a JSON
 * Schema enum, so a currency-style DTO still documents (and still serves as a
 * `param.responseDto`); only the runtime-validation projection is constrained.
 */

/** @constant {Object.<string,string>} JSON Schema dialect -> `$schema` URI. */
var DIALECTS = {
    'draft-07': 'http://json-schema.org/draft-07/schema#',
    '2020-12' : 'https://json-schema.org/draft/2020-12/schema'
};

/** @constant {string} Default emit dialect (matches the house `schema/*.json` style). */
var DEFAULT_DIALECT = 'draft-07';

/**
 * Lazily-initialised named-DTO registry, stashed on `process.gina._dtos` so it
 * survives dev-mode `refreshCore()` hot-reload (the builder module is
 * hot-reloadable; the registry must persist across requests). Mirrors the
 * `process.gina._swigEngines` / `_swigLoaders` convention.
 * @inner
 * @returns {Object.<string, DtoObject>}
 */
var _registry = function () {
    if (typeof process.gina === 'undefined' || process.gina === null) {
        process.gina = {};
    }
    if (typeof process.gina._dtos === 'undefined') {
        process.gina._dtos = {};
    }
    return process.gina._dtos;
};

/**
 * Shallow-clone a plain JSON value (schema fragments are plain JSON — no cycles,
 * no functions). Avoids leaking a shared reference from one projection into a caller.
 * @inner
 * @param {*} v
 * @returns {*}
 */
var _clone = function (v) {
    return (v === undefined) ? undefined : JSON.parse(JSON.stringify(v));
};

/**
 * A single DTO field. Chainable; its internal `_schema` is a JSON Schema fragment.
 *
 * @class DtoField
 * @constructor
 * @param {object} baseSchema - initial canonical JSON Schema fragment (e.g. `{type:'string'}`).
 * @param {string} kind       - one of 'string'|'integer'|'number'|'boolean'|'enum'|'date'.
 */
function DtoField(baseSchema, kind) {
    this._kind     = kind;
    this._schema   = baseSchema || {};
    this._required = false;
    this._excluded = false;
    this._trim     = false;
    this._email    = false;
    this._enum     = null;              // for kind 'enum'
    this._dateMask = 'yyyy-mm-dd';      // for kind 'date'
}

/**
 * Assert this field is one of the allowed kinds for a chained method, else throw
 * at build time (matches the framework's throw-on-invalid-config convention).
 * @private
 * @param {string} method
 * @param {string[]} kinds
 * @this {DtoField}
 */
DtoField.prototype._assertKind = function (method, kinds) {
    if (kinds.indexOf(this._kind) < 0) {
        throw new Error('[dto] `.' + method + '()` is not valid on a ' + this._kind +
            ' field; allowed on: ' + kinds.join(', '));
    }
};

/** Mark the field required (adds it to the parent object's JSON Schema `required[]`). @returns {DtoField} */
DtoField.prototype.required = function () { this._required = true; return this; };

/** Mark the field optional (the default). @returns {DtoField} */
DtoField.prototype.optional = function () { this._required = false; return this; };

/** Strip the field from the validated/coerced output data (`exclude` rule). @returns {DtoField} */
DtoField.prototype.exclude = function () { this._excluded = true; return this; };

/**
 * Attach a human description (JSON Schema `description`; carried into OpenAPI/MCP).
 * @param {string} text
 * @returns {DtoField}
 */
DtoField.prototype.description = function (text) { this._schema.description = text; return this; };

/**
 * Set a JSON Schema `default` value (documentation only; not applied at runtime).
 * @param {*} value
 * @returns {DtoField}
 */
DtoField.prototype.default = function (value) { this._schema['default'] = value; return this; };

/**
 * Attach one or more JSON Schema `examples`.
 * @param {...*} values
 * @returns {DtoField}
 */
DtoField.prototype.example = function () {
    var vals = Array.prototype.slice.call(arguments);
    this._schema.examples = (this._schema.examples || []).concat(vals);
    return this;
};

/** String only — mark as an email (JSON Schema `format:'email'`; `isEmail` rule). @returns {DtoField} */
DtoField.prototype.email = function () {
    this._assertKind('email', ['string']);
    this._email = true;
    this._schema.format = 'email';
    return this;
};

/**
 * String only — minimum character LENGTH (JSON Schema `minLength`; `isString` bound).
 * @param {number} n
 * @returns {DtoField}
 */
DtoField.prototype.minLength = function (n) {
    this._assertKind('minLength', ['string']);
    this._schema.minLength = n;
    return this;
};

/**
 * String only — maximum character LENGTH (JSON Schema `maxLength`; `isString` bound).
 * @param {number} n
 * @returns {DtoField}
 */
DtoField.prototype.maxLength = function (n) {
    this._assertKind('maxLength', ['string']);
    this._schema.maxLength = n;
    return this;
};

/**
 * String only — a `pattern` (JSON Schema regex; documentation/OpenAPI only in this
 * cut — the engine has no generic pattern rule beyond `is`, which is value-bound-only).
 * @param {string} re
 * @returns {DtoField}
 */
DtoField.prototype.pattern = function (re) {
    this._assertKind('pattern', ['string']);
    this._schema.pattern = re;
    return this;
};

/** String only — trim surrounding whitespace from the coerced value (`trim` rule). @returns {DtoField} */
DtoField.prototype.trim = function () {
    this._assertKind('trim', ['string']);
    this._trim = true;
    return this;
};

/**
 * Number/integer only — minimum VALUE (JSON Schema `minimum`). Carried in the
 * canonical schema for OpenAPI/MCP; NOT runtime-enforced by `toRules()` in this cut
 * (see the module note). @param {number} v @returns {DtoField}
 */
DtoField.prototype.min = function (v) {
    this._assertKind('min', ['integer', 'number']);
    this._schema.minimum = v;
    return this;
};

/**
 * Number/integer only — maximum VALUE (JSON Schema `maximum`). Canonical-schema only
 * in this cut (see the module note). @param {number} v @returns {DtoField}
 */
DtoField.prototype.max = function (v) {
    this._assertKind('max', ['integer', 'number']);
    this._schema.maximum = v;
    return this;
};

/**
 * Date only — override the mask (default `yyyy-mm-dd`). @param {string} mask @returns {DtoField}
 */
DtoField.prototype.mask = function (mask) {
    this._assertKind('mask', ['date']);
    this._dateMask = mask;
    return this;
};

/**
 * The canonical JSON Schema fragment for this field, in the requested dialect.
 * For the curated vocabulary the draft-07 and 2020-12 subsets are identical
 * (type/format/enum/minLength/maxLength/minimum/maximum/description) — the dialect
 * only affects a standalone `$schema` (added at the object level).
 * @param {string} [dialect]
 * @returns {object}
 */
DtoField.prototype.toSchemaFragment = function (dialect) {
    return _clone(this._schema);
};

/**
 * The live form-validator rules-object fragment for this field (the value stored
 * under the field key). Derived from the canonical schema + gina flags. Never emits
 * `$`, `toFloat`, or `query`.
 * @returns {object}
 */
DtoField.prototype.toFieldRules = function () {
    var r = {};
    if (this._required) { r.isRequired = true; }

    switch (this._kind) {
        case 'string':
            if (this._email) {
                r.isEmail = true;
            }
            var hasMin = (typeof this._schema.minLength === 'number');
            var hasMax = (typeof this._schema.maxLength === 'number');
            if (hasMin || hasMax) {
                // positional isString(minLength, maxLength); null placeholders skip a bound
                r.isString = [
                    hasMin ? this._schema.minLength : null,
                    hasMax ? this._schema.maxLength : null
                ];
            } else if (!this._email) {
                // plain string type-check (isEmail already implies string, so skip when email)
                r.isString = true;
            }
            if (this._trim) { r.trim = true; }
            break;

        case 'integer':
            r.isInteger = true;   // value bounds (minimum/maximum) are schema-only (cut 1)
            break;

        case 'number':
            r.isNumber = true;    // value bounds (minimum/maximum) are schema-only (cut 1)
            break;

        case 'boolean':
            r.isBoolean = true;
            break;

        case 'enum':
            r.isInList = (this._enum || []).slice();   // ARRAY form (scalar throws in the engine)
            break;

        case 'date':
            r.isDate = [this._dateMask || 'yyyy-mm-dd'];
            break;
    }

    if (this._excluded) { r.exclude = true; }
    return r;
};

/**
 * A top-level object DTO. Chainable.
 *
 * @class DtoObject
 * @constructor
 * @param {Object.<string, DtoField>} shape - field name -> DtoField.
 * @param {string} [name]                    - stable id (also settable via `.as()`).
 */
function DtoObject(shape, name) {
    this._kind        = 'object';
    this._shape       = shape || {};
    this.name         = name || null;
    this._passthrough = false;    // additionalProperties (default: strict / false)
    this._title       = null;
    this._description  = null;

    // validate the shape at build time
    for (var f in this._shape) {
        if (!(this._shape[f] instanceof DtoField)) {
            throw new Error('[dto] field `' + f + '` must be a dto field (dto.string()/integer()/...); got ' +
                typeof this._shape[f]);
        }
    }
    if (name) { _registry()[name] = this; }
}

/**
 * Name the DTO and register it (so the validation pipe can resolve a route's
 * `param.dto` reference and the type generator can enumerate it). @param {string} name @returns {DtoObject}
 */
DtoObject.prototype.as = function (name) {
    this.name = name;
    _registry()[name] = this;
    return this;
};

/** Set the JSON Schema `title`. @param {string} text @returns {DtoObject} */
DtoObject.prototype.title = function (text) { this._title = text; return this; };

/** Set the JSON Schema `description`. @param {string} text @returns {DtoObject} */
DtoObject.prototype.description = function (text) { this._description = text; return this; };

/** Allow undeclared properties (`additionalProperties:true`). @returns {DtoObject} */
DtoObject.prototype.passthrough = function () { this._passthrough = true; return this; };

/** Forbid undeclared properties (`additionalProperties:false` — the default). @returns {DtoObject} */
DtoObject.prototype.strict = function () { this._passthrough = false; return this; };

/**
 * The canonical JSON Schema for this DTO, in the requested dialect. This is the
 * IDENTITY projection (the builder's internal form). Embeddable in an OpenAPI 3.1
 * `requestBody`/`responses` (dialect `2020-12`) or an MCP `inputSchema` (draft-07).
 *
 * `opts.dropExcluded` emits the RESPONSE projection instead: `.exclude()`d fields
 * leave `properties` AND `required[]`. `apply()` deletes them before the wire, so a
 * response schema advertising them would document properties a client can never
 * receive (#B110). Request-side emission keeps them — the client DOES send them.
 * The drop reads the SHAPE (`_excluded`), never `toRules()`, so it stays total for
 * a DTO whose rules would throw on an authored `$` (same rationale as the type
 * emitter's excluded-set derivation).
 *
 * @param {string} [dialect='draft-07'] - 'draft-07' | '2020-12'.
 * @param {object} [opts]               - emit options.
 * @param {boolean} [opts.standalone]   - add `$schema` (+ `$id`/`title` when named).
 * @param {boolean} [opts.dropExcluded] - omit `.exclude()`d fields (response projection).
 * @returns {object}
 */
DtoObject.prototype.toJsonSchema = function (dialect, opts) {
    dialect = dialect || DEFAULT_DIALECT;
    if (!DIALECTS[dialect]) {
        throw new Error('[dto] unknown JSON Schema dialect `' + dialect + '`; use one of: ' +
            Object.keys(DIALECTS).join(', '));
    }
    opts = opts || {};

    var schema = { type: 'object', properties: {}, required: [] };
    for (var f in this._shape) {
        var field = this._shape[f];
        // #B110 — response projection: an excluded field can never appear on the
        // wire, so it must not be advertised (nor required) by a response schema.
        if (opts.dropExcluded && field._excluded) { continue; }
        schema.properties[f] = field.toSchemaFragment(dialect);
        if (field._required) { schema.required.push(f); }
    }
    if (schema.required.length === 0) { delete schema.required; }
    schema.additionalProperties = this._passthrough ? true : false;

    if (this._title)       { schema.title = this._title; }
    if (this._description) { schema.description = this._description; }

    if (opts.standalone) {
        var out = { $schema: DIALECTS[dialect] };
        if (this.name) {
            out.$id = 'https://gina.io/schema/dto/' + this.name + '.json';
            if (!schema.title) { out.title = 'Gina DTO ' + this.name; }
        }
        for (var k in schema) { out[k] = schema[k]; }
        return out;
    }
    return schema;
};

/**
 * The live form-validator rules-object for this DTO (field -> { ruleName: value }).
 * Feeds `new (gina.plugins.Validator)(rules, data, formId, culture)` on the server
 * (and the same engine client-side). Never emits `toFloat` or `query`, and THROWS
 * rather than emit a `$` (see the `$` guard in the module header).
 *
 * @throws {Error} when an authored enum value / field name / date mask puts a `$` in
 *                 the emitted rules — the engine would reinterpret it
 *                 collision-dependently (reserved sigil; see the module header).
 * @returns {object}
 */
DtoObject.prototype.toRules = function () {
    var rules = {};
    for (var f in this._shape) {
        rules[f] = this._shape[f].toFieldRules();
    }
    // #DTO2 — `$` is the engine's reserved cross-field sigil: whether an authored
    // `$` stays literal depends on a runtime field-name collision (a colliding
    // token is substituted + quoted upstream — #B240 — so the literal can never
    // match; a non-colliding one stays literal only since #B239). Fail at
    // build/boot with a message that names the culprit, never validate
    // collision-dependently at request time.
    if ( /\$/.test(JSON.stringify(rules)) ) {
        // NOTE: every `$` below is followed by a SPACE, deliberately. A message carrying
        // the sequence `$` + backtick/quote/digit is a String.replace() dollar-pattern
        // (prematch / postmatch / capture-group), and any consumer that splices this text
        // into a template with `template.replace(re, msg)` would expand it — mangling the
        // very boot error an operator needs to read. Keep it that way.
        throw new Error('[dto] `' + (this.name || 'anonymous') + '` emits a $ character in its validation ' +
            'rules (check enum values, field names and date masks). The validator engine cannot evaluate ' +
            'a $ server-side: rename the field, or drop the $ from the value. toJsonSchema() is unaffected.');
    }
    return rules;
};

/**
 * Project an object onto this DTO — the RESPONSE-side transform (#DTO2).
 *
 * Keeps only the declared fields, drops every `.exclude()`d one (so `.exclude()`
 * finally means "never serialise this" — e.g. a password hash), and passes keys
 * matching `/^__gina/` through untouched so the dev-Inspector sidecars
 * (`__ginaQueries` / `__ginaFlow`) survive a strict projection.
 *
 * A `.passthrough()` DTO keeps undeclared keys (it declares
 * `additionalProperties: true`), so the projection only drops the excluded fields.
 *
 * Pure: returns a NEW object, never mutates the input.
 *
 * @param {object} obj - the outgoing payload.
 * @returns {object} the projected payload (the input verbatim when it is not a plain object).
 *
 * @example
 * // responseDto: id, email, passwordHash.exclude()
 * User.apply({ id: 7, email: 'a@b.co', passwordHash: 'x', extra: 1 });
 * // -> { id: 7, email: 'a@b.co' }
 */
DtoObject.prototype.apply = function (obj) {
    // Arrays and non-objects have no declared shape to project onto — pass verbatim.
    if ( obj === null || typeof obj !== 'object' || Array.isArray(obj) ) {
        return obj;
    }
    var out = {};
    var k;
    if (this._passthrough) {
        for (k in obj) { out[k] = obj[k]; }
    } else {
        for (k in obj) {
            // The dev-Inspector sidecars are attached by the render delegate AFTER the
            // action returns; a strict projection must not eat them.
            if ( /^__gina/.test(k) ) { out[k] = obj[k]; }
        }
        for (k in this._shape) {
            if ( typeof obj[k] !== 'undefined' ) { out[k] = obj[k]; }
        }
    }
    for (k in this._shape) {
        if ( this._shape[k]._excluded ) { delete out[k]; }
    }
    return out;
};

/**
 * The gina DTO namespace — the public builder. Exposed as `require('gina').dto`.
 * @namespace dto
 */
var dto = {
    /**
     * Create an object DTO.
     * @memberof dto
     * @param {Object.<string, DtoField>} shape - field name -> a dto field.
     * @param {string} [name]                    - optional stable id (also settable via `.as()`).
     * @returns {DtoObject}
     */
    object: function (shape, name) { return new DtoObject(shape, name); },

    /** A string field. @memberof dto @returns {DtoField} */
    string: function () { return new DtoField({ type: 'string' }, 'string'); },

    /** An integer field. @memberof dto @returns {DtoField} */
    integer: function () { return new DtoField({ type: 'integer' }, 'integer'); },

    /** A number (float) field. @memberof dto @returns {DtoField} */
    number: function () { return new DtoField({ type: 'number' }, 'number'); },

    /** A boolean field. @memberof dto @returns {DtoField} */
    boolean: function () { return new DtoField({ type: 'boolean' }, 'boolean'); },

    /**
     * A closed-set (enum) field. Values must be a non-empty array of primitives.
     * The JSON Schema carries `enum`; a homogeneous value array also sets `type`.
     * @memberof dto
     * @param {Array<string|number|boolean>} values
     * @returns {DtoField}
     */
    'enum': function (values) {
        if (!Array.isArray(values) || values.length === 0) {
            throw new Error('[dto] dto.enum(values) requires a non-empty array of primitive values');
        }
        var f = new DtoField({}, 'enum');
        f._enum = values.slice();
        f._schema.enum = values.slice();
        // infer a homogeneous type for OpenAPI/MCP fidelity (the engine's isInList is
        // type-strict === , so a homogeneous enum keeps the schema and the rule aligned)
        var t = null, ok = true;
        for (var i = 0; i < values.length; i++) {
            var vt = (typeof values[i] === 'number')
                ? (Number.isInteger(values[i]) ? 'integer' : 'number')
                : typeof values[i];
            if (t === null) { t = vt; }
            else if (t !== vt) { ok = false; break; }
        }
        if (ok && (t === 'string' || t === 'integer' || t === 'number' || t === 'boolean')) {
            f._schema.type = t;
        }
        return f;
    },

    /** A date field (`format:'date'`; validated + coerced to a Date via `isDate`). @memberof dto @returns {DtoField} */
    date: function () { return new DtoField({ type: 'string', format: 'date' }, 'date'); },

    /**
     * Register a named DTO (so the validation pipe / type generator can resolve it).
     * @memberof dto
     * @param {string} name
     * @param {DtoObject} d
     * @returns {DtoObject}
     */
    register: function (name, d) {
        if (!(d instanceof DtoObject)) {
            throw new Error('[dto] dto.register(name, d) — d must be a dto.object(...)');
        }
        d.name = name;
        _registry()[name] = d;
        return d;
    },

    /**
     * Resolve a registered DTO by name (or null).
     * @memberof dto
     * @param {string} name
     * @returns {DtoObject|null}
     */
    get: function (name) {
        var reg = _registry();
        return (typeof reg[name] !== 'undefined') ? reg[name] : null;
    },

    /**
     * Resolve a route's `param.dto` / `param.responseDto` reference to a DtoObject,
     * loading a bundle DTO module from `<bundleSrcPath>/dtos/<name>.js` when present.
     * This is the resolver shared by the OFFLINE `bundle:openapi` / `bundle:mcp` CLIs
     * (which load no other bundle code) and the request-time validation pipe.
     *
     * A bundle DTO file MUST be context-free so the offline CLI can load it: that CLI
     * process bootstraps via the lib registry (`bin/cli`), NOT via `core/gna.js`, so a
     * file that did `require('gina')` would cold-load gna.js with no bundle context and
     * throw. The supported shape is therefore a FACTORY that receives the builder:
     *
     *   // <bundle>/dtos/CreateUser.js
     *   module.exports = function (dto) { return dto.object({ ... }, 'CreateUser'); };
     *
     * A module that already exports a DtoObject (authored for runtime-only use, where
     * `require('gina').dto` works) is also accepted. Resolution order: the bundle file
     * (factory or DtoObject) then the named registry. Returns null when unresolved.
     * A broken file/factory THROWS (the caller decides: the CLI warns + skips, the
     * pipe fails fast). No `require.cache` eviction — one-shot in the CLI, register-once
     * in a booted bundle (avoids the dev-mode `module.children` leak class #B32).
     *
     * @memberof dto
     * @param {string} bundleSrcPath - absolute path to the bundle source dir.
     * @param {string} name          - the reference (also the file base name).
     * @returns {DtoObject|null}
     *
     * @example
     * var CreateUser = dto.load('/path/to/bundle', 'CreateUser');
     * if (CreateUser) {
     *     op.requestBody = { content: { 'application/json': { schema: CreateUser.toJsonSchema('2020-12') } } };
     * }
     */
    load: function (bundleSrcPath, name) {
        if (typeof name !== 'string' || !name) { return null; }
        var reg = _registry();
        if (typeof bundleSrcPath === 'string' && bundleSrcPath) {
            var file = require('path').join(bundleSrcPath, 'dtos', name + '.js');
            if (require('fs').existsSync(file)) {
                var mod = require(file);                          // may throw -> caller handles
                if (typeof mod === 'function') { mod = mod(dto); } // factory -> inject the builder (may throw)
                if (mod instanceof DtoObject) {
                    mod.name = name;                              // the reference name is canonical
                    reg[name] = mod;                             // register for subsequent get()
                    return mod;
                }
                // file present but not a DtoObject / factory-of-DtoObject -> unresolved
            }
        }
        return (typeof reg[name] !== 'undefined') ? reg[name] : null;
    },

    /**
     * All registered DTO names.
     * @memberof dto
     * @returns {string[]}
     */
    names: function () { return Object.keys(_registry()); },

    /**
     * Is `x` a DTO object?
     * @memberof dto
     * @param {*} x
     * @returns {boolean}
     */
    isDto: function (x) { return (x instanceof DtoObject); },

    /** @memberof dto @constant */
    DIALECTS: DIALECTS,

    /** @memberof dto — exposed for `instanceof` / test use. */
    DtoObject: DtoObject,

    /** @memberof dto — exposed for `instanceof` / test use. */
    DtoField: DtoField
};

module.exports = dto;
