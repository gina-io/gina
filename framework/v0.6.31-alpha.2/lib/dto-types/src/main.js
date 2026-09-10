/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/dto-types
 *
 * The #DTO3 type emitter: a DTO's canonical JSON Schema -> TypeScript declarations.
 *
 * Authored once (`bundle/dtos/<Name>.js`), a DTO already drives runtime validation
 * (#DTO2), the OpenAPI/MCP schemas (#DTO1c) and response shaping. This module adds the
 * fourth projection — static types — so an IDE and `tsc` see the same contract the wire
 * does. It is consumed by the offline `gina bundle:types` CLI (the sibling of
 * `bundle:openapi` / `bundle:mcp`), and is a pure function of the DTOs: no fs, no
 * globals, no clock. Zero runtime deps.
 *
 * ## TWO types per DTO — measured, not stylistic
 * `.exclude()`d fields are carried in the canonical JSON Schema (`properties`, and
 * `required` when declared required) but are ABSENT from what the server actually holds:
 * the validator engine drops them from its coerced output, and `DtoObject.apply()`
 * deletes them. So a single schema-derived type would LIE about `req.dto`. Each DTO
 * therefore emits:
 *
 *   <Name>            the DECLARED shape — what the client sends, and what the OpenAPI /
 *                     MCP schema documents. Includes the `.exclude()`d fields.
 *   <Name>Projected   what the SERVER holds — `req.dto` after the validation pipe, and
 *                     the body a `param.responseDto` puts on the wire. Excluded fields
 *                     dropped (`Omit`), or an alias of <Name> when there are none.
 *
 * ## The scalar mapping (measured against the LIVE validator engine, not inferred)
 * The pipe hands the action the engine's COERCED payload, so the emitted type must
 * describe the coerced value, not the raw wire string:
 *
 *   integer | number -> number      ('30'   -> 30)
 *   boolean          -> boolean     ('true' -> true)
 *   enum             -> a literal union ('admin' | 'user')
 *   string           -> string
 *   date             -> string      NOT Date. `isDate` coerces to an ISO string, and it
 *                                   also SHIFTS the value: '2020-01-02' comes back as
 *                                   '2020-01-01T23:00:00.000Z'.
 *
 * ## Why the excluded set is read off the shape, not off `toRules()`
 * `toRules()` also reports `exclude: true` per field — but it THROWS on an authored
 * dollar sign (the engine's server-fatal branch; see lib/dto). A currency-style DTO
 * (`dto.enum(['$ 100'])`) can never be compiled to rules, yet it still documents and
 * still needs a type. Reading the shape keeps the emitter total.
 *
 * ## Determinism
 * The output is a pure function of the DTOs: DTOs are sorted by name, fields keep their
 * declaration order, and NO timestamp / path / version is embedded. That is what lets a
 * committed artifact be drift-checked by re-running the emitter in memory.
 */

/** @constant {RegExp} A bare TypeScript identifier (a name that needs no quoting). */
var TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A property key, quoted only when it is not a bare TS identifier.
 * @inner
 * @param {string} name
 * @returns {string}
 */
var tsPropKey = function (name) {
    return TS_IDENT.test(name) ? name : JSON.stringify(name);
};

/**
 * A primitive value as a TypeScript literal type.
 * @inner
 * @param {string|number|boolean} v
 * @returns {string}
 */
var tsLiteral = function (v) {
    if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
    }
    return JSON.stringify(v);   // strings: quoted + escaped
};

/**
 * Neutralise a comment terminator so an authored description / pattern cannot close the
 * JSDoc block it is emitted into (the same guard `script/generate_gna_types.js` applies).
 * @inner
 * @param {*} str
 * @returns {string}
 */
var sanitize = function (str) {
    return String(str).replace(/\*\//g, '*\\/');
};

/**
 * The TypeScript type for one canonical JSON Schema property fragment.
 * @inner
 * @param {object} frag - a `toJsonSchema()` property fragment.
 * @returns {string}
 */
var tsTypeOf = function (frag) {
    if ( Array.isArray(frag.enum) && frag.enum.length > 0 ) {
        return frag.enum.map(tsLiteral).join(' | ');
    }
    switch (frag.type) {
        case 'integer':
        case 'number' : return 'number';
        case 'boolean': return 'boolean';
        case 'string' : return 'string';   // includes `format: 'date'` — see the header
        default       : return 'any';
    }
};

/**
 * The JSDoc comment lines for a property: its description plus the schema facets the TS
 * type cannot carry (format / length / pattern / value bounds), so the contract stays
 * visible in an IDE.
 *
 * The value bounds are labelled schema-only on purpose: they ride in the JSON Schema for
 * OpenAPI fidelity but the validator engine has no min/max-VALUE rule, so they are NOT
 * enforced at runtime (a documented limitation of this cut).
 *
 * @inner
 * @param {object} frag       - a `toJsonSchema()` property fragment.
 * @param {boolean} isExcluded
 * @param {string} indent
 * @returns {string[]} zero or more source lines.
 */
var propDoc = function (frag, isExcluded, indent) {
    var lines = [];

    if ( typeof(frag.description) == 'string' && frag.description !== '' ) {
        lines.push(sanitize(frag.description));
    }
    if ( typeof(frag.format) == 'string' ) {
        lines.push('@format ' + sanitize(frag.format));
    }
    if ( typeof(frag.minLength) == 'number' ) { lines.push('@minLength ' + frag.minLength); }
    if ( typeof(frag.maxLength) == 'number' ) { lines.push('@maxLength ' + frag.maxLength); }
    if ( typeof(frag.pattern)   == 'string' ) { lines.push('@pattern ' + sanitize(frag.pattern)); }
    if ( typeof(frag.minimum)   == 'number' ) {
        lines.push('@minimum ' + frag.minimum + ' (schema-only — not enforced at runtime)');
    }
    if ( typeof(frag.maximum)   == 'number' ) {
        lines.push('@maximum ' + frag.maximum + ' (schema-only — not enforced at runtime)');
    }
    if ( isExcluded ) {
        lines.push('@remarks Excluded — stripped from the validated payload and never serialised.');
    }

    if ( lines.length === 0 ) { return []; }
    if ( lines.length === 1 ) { return [ indent + '/** ' + lines[0] + ' */' ]; }

    var out = [ indent + '/**' ];
    for (var i = 0; i < lines.length; ++i) {
        out.push(indent + ' * ' + lines[i]);
    }
    out.push(indent + ' */');
    return out;
};

/**
 * The declared-field names a DTO strips at runtime, in declaration order.
 * @inner
 * @param {DtoObject} d
 * @returns {string[]}
 */
var excludedFields = function (d) {
    var out = [], f;
    // Read the shape, NOT toRules() — toRules() throws on an authored dollar sign, and a
    // DTO that cannot be compiled to rules must still be typeable (see the header).
    for (f in d._shape) {
        if ( d._shape[f]._excluded ) { out.push(f); }
    }
    return out;
};

/**
 * Emit the two declarations for a single DTO.
 * @inner
 * @param {DtoObject} d
 * @returns {string[]} source lines.
 * @throws {Error} when the DTO is unnamed, or its name is not a valid TS identifier.
 */
var emitDto = function (d) {
    var name = d && d.name;
    if ( typeof(name) != 'string' || name === '' ) {
        throw new Error('[dto-types] every DTO must be named (dto.object(shape, \'Name\') or .as(\'Name\')) ' +
            'so it can be emitted as a TypeScript interface.');
    }
    if ( !TS_IDENT.test(name) ) {
        throw new Error('[dto-types] DTO name `' + name + '` is not a valid TypeScript identifier, so it ' +
            'cannot be emitted as an interface. Rename the DTO (and its dtos/<Name>.js file).');
    }

    var schema     = d.toJsonSchema('2020-12');   // the PUBLIC identity projection
    var props      = schema.properties || {};
    var required   = schema.required   || [];
    var excluded   = excludedFields(d);
    var isOpen     = (schema.additionalProperties === true);

    var lines = [];

    lines.push('/**');
    if ( typeof(schema.title) == 'string' && schema.title !== '' ) {
        lines.push(' * ' + sanitize(schema.title));
        lines.push(' *');
    }
    if ( typeof(schema.description) == 'string' && schema.description !== '' ) {
        lines.push(' * ' + sanitize(schema.description));
        lines.push(' *');
    }
    lines.push(' * `' + name + '` — the DECLARED shape: what the client sends, and what the OpenAPI /');
    lines.push(' * MCP schema documents.' + (excluded.length
        ? ' Includes the excluded field' + (excluded.length > 1 ? 's' : '') + ' the server strips.'
        : ''));
    lines.push(' */');
    lines.push('export interface ' + name + ' {');

    var first = true, f, doc, i;
    for (f in props) {
        var isRequired = (required.indexOf(f) > -1);
        var isExcluded = (excluded.indexOf(f) > -1);

        doc = propDoc(props[f], isExcluded, '    ');
        if ( !first && doc.length > 0 ) { lines.push(''); }
        for (i = 0; i < doc.length; ++i) { lines.push(doc[i]); }

        lines.push('    ' + tsPropKey(f) + (isRequired ? '' : '?') + ': ' + tsTypeOf(props[f]) + ';');
        first = false;
    }

    if ( isOpen ) {
        if ( !first ) { lines.push(''); }
        lines.push('    /** The DTO is `.passthrough()` — undeclared keys are kept. */');
        lines.push('    [key: string]: any;');
    }

    lines.push('}');
    lines.push('');

    // The projection the server actually holds.
    lines.push('/**');
    lines.push(' * `' + name + '` as the SERVER holds it — `req.dto` after the validation pipe, and the');
    lines.push(' * body a `param.responseDto` puts on the wire.');
    if ( excluded.length > 0 ) {
        lines.push(' *');
        lines.push(' * The excluded field' + (excluded.length > 1 ? 's are' : ' is') + ' dropped: ' +
            excluded.map(function (k) { return '`' + k + '`'; }).join(', ') + '.');
        lines.push(' */');
        lines.push('export type ' + name + 'Projected = Omit<' + name + ', ' +
            excluded.map(function (k) { return tsLiteral(k); }).join(' | ') + '>;');
    } else {
        lines.push(' *');
        lines.push(' * This DTO excludes no field, so the projection is the declared shape.');
        lines.push(' */');
        lines.push('export type ' + name + 'Projected = ' + name + ';');
    }

    return lines;
};

/**
 * Emit TypeScript declarations for a set of DTOs.
 *
 * Pure and deterministic: DTOs are sorted by name, fields keep their declaration order,
 * and nothing volatile (timestamp, absolute path, framework version) is embedded — which
 * is what lets a committed artifact be drift-checked by re-running this in memory.
 *
 * @param {DtoObject[]} dtos      - the bundle's DTOs (from `dto.load()`).
 * @param {object}      [opts]
 * @param {string}      [opts.bundle] - the bundle name, for the banner.
 * @returns {string} the full `.d.ts` source.
 * @throws {Error} when a DTO is unnamed or its name is not a valid TS identifier.
 *
 * @example
 * var src = lib.dtoTypes.emit([ CreateUser, UserView ], { bundle: 'api' });
 * fs.writeFileSync(bundleSrc + '/dtos/index.d.ts', src, 'utf8');
 */
var emit = function (dtos, opts) {
    opts = opts || {};
    var bundle = ( typeof(opts.bundle) == 'string' && opts.bundle !== '' ) ? opts.bundle : '<bundle>';

    var sorted = (dtos || []).slice().sort(function (a, b) {
        var an = (a && a.name) || '', bn = (b && b.name) || '';
        return (an < bn) ? -1 : (an > bn) ? 1 : 0;
    });

    var out = [];
    out.push('/**');
    out.push(' * Gina — DTO types for bundle `' + bundle + '`');
    out.push(' *');
    out.push(' * AUTO-GENERATED by `gina bundle:types ' + bundle + ' @<project>` — do not edit by hand.');
    out.push(' * Source of truth: the DTO factories in `dtos/`.');
    out.push(' * Re-run after adding, removing or changing a DTO.');
    out.push(' *');
    out.push(' * Each DTO emits TWO types, because a DTO\'s declared shape and the shape the server');
    out.push(' * actually holds are not the same:');
    out.push(' *');
    out.push(' *   <Name>           the DECLARED shape — what the client sends, and what the OpenAPI /');
    out.push(' *                    MCP schema documents. Includes the excluded fields.');
    out.push(' *   <Name>Projected  what the SERVER holds — `req.dto` after the validation pipe, and');
    out.push(' *                    the body a `param.responseDto` puts on the wire. Excluded fields');
    out.push(' *                    are dropped.');
    out.push(' *');
    out.push(' * Note: a `date` field is typed `string`, not `Date` — the validator coerces it to an');
    out.push(' * ISO string. And `@minimum` / `@maximum` ride in the JSON Schema for OpenAPI fidelity');
    out.push(' * but are NOT enforced at runtime in this cut.');
    out.push(' */');

    for (var i = 0; i < sorted.length; ++i) {
        out.push('');
        var lines = emitDto(sorted[i]);
        for (var j = 0; j < lines.length; ++j) { out.push(lines[j]); }
    }

    out.push('');
    return out.join('\n');
};

module.exports = {
    emit: emit
};
