'use strict';
/**
 * @module gina/lib/priority
 * @description #H12 — RFC 9218 Extensible Priorities: the `Priority` header field.
 *
 * WHAT THIS IS. RFC 9218 retired the RFC 7540 stream-priority tree in favour of
 * one structured header — `Priority: u=<0-7>, i` — that a client attaches to a
 * request and an origin MAY attach to a response. The value is an RFC 8941
 * Structured-Fields Dictionary with two known members: `u` (urgency, Integer
 * 0–7 where 0 is the most urgent, default 3) and `i` (incremental, Boolean,
 * default false). Everything else — unknown members, out-of-range or
 * wrong-type values, member parameters — MUST be ignored (RFC 9218 §4), and a
 * value that fails the dictionary grammar is ignored WHOLE, as if the header
 * were absent (RFC 8941 §4.2).
 *
 * WHAT GINA DOES WITH IT. Node exposes no DATA-frame scheduler and no
 * PRIORITY_UPDATE frame API, so the framework cannot reorder response writes
 * (measured — routing-and-http2 § deferred server capabilities). What it CAN
 * do is carry the signal faithfully: `req.priority` on both engines (parsed
 * once, at the top of each engine's request listener), propagation onto
 * `self.query()` sub-requests via {@link resolveOutbound}, an explicit
 * `self.setPriority()` on the response, and urgency-ordered selection in
 * `lib/job`. The header is CLIENT-SUPPLIED and ADVISORY — nothing in gina
 * grants more on its strength; a consumer may only use it to yield.
 *
 * PURE. No state, no I/O, no framework dependency, and no input can make it
 * throw: a hostile or malformed value degrades to the RFC defaults.
 *
 * @example
 * var priority = require('lib/priority');
 * priority.parse('u=1, i');     // → { urgency: 1, incremental: true,  present: true }
 * priority.parse('u=9, i=?0');  // → { urgency: 3, incremental: false, present: true }  (u out of range ⇒ ignored)
 * priority.parse('U=1');        // → { urgency: 3, incremental: false, present: false } (grammar failure ⇒ whole field ignored)
 * priority.parse(undefined);    // → { urgency: 3, incremental: false, present: false }
 * priority.serialize({ urgency: 0, incremental: true }); // → 'u=0, i'
 */

/**
 * The urgency a request has when it says nothing (RFC 9218 §4.1).
 * @constant
 * @type {number}
 */
var DEFAULT_URGENCY = 3;

/**
 * Lowest urgency value — the MOST urgent (RFC 9218 §4.1).
 * @constant
 * @type {number}
 */
var URGENCY_MIN = 0;

/**
 * Highest urgency value — the LEAST urgent (RFC 9218 §4.1).
 * @constant
 * @type {number}
 */
var URGENCY_MAX = 7;

/**
 * The header field name, lower-cased as node presents it on `req.headers`.
 * @constant
 * @type {string}
 */
var HEADER_NAME = 'priority';

// ── RFC 8941 lexical classes ───────────────────────────────────────────────
/** @constant @private */ var RE_KEY_FIRST   = /[a-z*]/;
/** @constant @private */ var RE_KEY_REST    = /[a-z0-9_\-.*]/;
/** @constant @private */ var RE_TOKEN_FIRST = /[A-Za-z*]/;
/** @constant @private */ var RE_TOKEN_REST  = /[A-Za-z0-9:/!#$%&'*+\-.^_`|~]/;
/** @constant @private */ var RE_DIGIT       = /[0-9]/;
/** @constant @private */ var RE_BASE64      = /[A-Za-z0-9+/=]/;

/**
 * A cursor over the field value — the few primitives the RFC 8941 algorithms
 * need. Every `parse*` helper below returns `undefined` on a grammar failure,
 * which {@link parseDictionary} turns into "ignore the whole field".
 *
 * @inner
 * @private
 * @constructor
 * @param {string} s - The field value.
 */
function Reader(s) {
    /** @type {string} */
    this.s = s;
    /** @type {number} */
    this.i = 0;
}
Reader.prototype.eof    = function() { return this.i >= this.s.length; };
Reader.prototype.peek   = function() { return this.s.charAt(this.i); };
Reader.prototype.next   = function() { return this.s.charAt(this.i++); };
Reader.prototype.skipSP = function() {
    // RFC 8941 discards SP; HTAB is tolerated because RFC 7230 OWS permits it
    // where field lines were combined.
    while ( !this.eof() && (this.peek() === ' ' || this.peek() === '\t') ) { this.i++; }
};

/**
 * RFC 8941 §4.2.3.3 — Parsing a Key.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {string|undefined}
 */
function parseKey(r) {
    if ( r.eof() || !RE_KEY_FIRST.test(r.peek()) ) { return undefined; }
    var out = '';
    while ( !r.eof() && RE_KEY_REST.test(r.peek()) ) { out += r.next(); }
    return out;
}

/**
 * RFC 8941 §4.2.4 — Parsing an Integer or Decimal.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: number}|undefined}
 */
function parseIntegerOrDecimal(r) {
    var neg = false, str = '', isDecimal = false;
    if ( r.peek() === '-' ) { r.next(); neg = true; }
    if ( r.eof() || !RE_DIGIT.test(r.peek()) ) { return undefined; }
    while ( !r.eof() ) {
        var c = r.peek();
        if ( RE_DIGIT.test(c) ) {
            str += c; r.next();
        } else if ( !isDecimal && c === '.' ) {
            if ( str.length > 12 ) { return undefined; }
            str += c; r.next(); isDecimal = true;
        } else {
            break;
        }
        if ( !isDecimal && str.length > 15 ) { return undefined; }
        if ( isDecimal && str.length > 16 ) { return undefined; }
    }
    if ( !isDecimal ) {
        var n = parseInt(str, 10);
        return { type: 'integer', value: ( neg && n !== 0 ) ? -n : n };
    }
    if ( str.charAt(str.length - 1) === '.' ) { return undefined; }
    if ( str.split('.')[1].length > 3 ) { return undefined; }
    var d = parseFloat(str);
    return { type: 'decimal', value: ( neg ) ? -d : d };
}

/**
 * RFC 8941 §4.2.5 — Parsing a String.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: string}|undefined}
 */
function parseString(r) {
    r.next(); // opening DQUOTE
    var out = '';
    while ( !r.eof() ) {
        var c = r.next();
        if ( c === '\\' ) {
            if ( r.eof() ) { return undefined; }
            var n = r.next();
            if ( n !== '"' && n !== '\\' ) { return undefined; }
            out += n;
        } else if ( c === '"' ) {
            return { type: 'string', value: out };
        } else if ( c < ' ' || c > '~' ) {
            return undefined; // %x00-1F and non-ASCII are not allowed inside a String
        } else {
            out += c;
        }
    }
    return undefined; // unterminated
}

/**
 * RFC 8941 §4.2.6 — Parsing a Token (the first character was validated by the caller).
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: string}}
 */
function parseToken(r) {
    var out = '';
    while ( !r.eof() && RE_TOKEN_REST.test(r.peek()) ) { out += r.next(); }
    return { type: 'token', value: out };
}

/**
 * RFC 8941 §4.2.7 — Parsing a Byte Sequence (the bytes themselves are not needed).
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: string}|undefined}
 */
function parseByteSequence(r) {
    r.next(); // opening ':'
    var out = '';
    while ( !r.eof() ) {
        var c = r.next();
        if ( c === ':' ) { return { type: 'bytes', value: out }; }
        if ( !RE_BASE64.test(c) ) { return undefined; }
        out += c;
    }
    return undefined; // unterminated
}

/**
 * RFC 8941 §4.2.8 — Parsing a Boolean (`?1` / `?0`, nothing else).
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: boolean}|undefined}
 */
function parseBoolean(r) {
    r.next(); // '?'
    var c = r.next();
    if ( c === '1' ) { return { type: 'boolean', value: true  }; }
    if ( c === '0' ) { return { type: 'boolean', value: false }; }
    return undefined;
}

/**
 * RFC 8941 §4.2.3.1 — Parsing a Bare Item, dispatched on its first character.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string, value: *}|undefined}
 */
function parseBareItem(r) {
    if ( r.eof() ) { return undefined; }
    var c = r.peek();
    if ( c === '-' || RE_DIGIT.test(c) ) { return parseIntegerOrDecimal(r); }
    if ( c === '"' )                     { return parseString(r); }
    if ( RE_TOKEN_FIRST.test(c) )        { return parseToken(r); }
    if ( c === ':' )                     { return parseByteSequence(r); }
    if ( c === '?' )                     { return parseBoolean(r); }
    return undefined;
}

/**
 * RFC 8941 §4.2.3.2 — Parsing Parameters. Their values are consumed for
 * grammar only: RFC 9218 §4 says priority parameters' parameters are ignored.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {boolean} `false` on a grammar failure.
 */
function parseParameters(r) {
    while ( !r.eof() && r.peek() === ';' ) {
        r.next();
        r.skipSP();
        if ( parseKey(r) === undefined ) { return false; }
        if ( !r.eof() && r.peek() === '=' ) {
            r.next();
            if ( parseBareItem(r) === undefined ) { return false; }
        }
    }
    return true;
}

/**
 * RFC 8941 §4.2.1.2 — Parsing an Inner List (`(` items `)`); the items are
 * consumed for grammar only, since neither `u` nor `i` may be a list.
 * @inner
 * @private
 * @param   {Reader} r
 * @returns {{type: string}|undefined}
 */
function parseInnerList(r) {
    r.next(); // '('
    while ( true ) {
        r.skipSP();
        if ( r.eof() ) { return undefined; }
        if ( r.peek() === ')' ) {
            r.next();
            if ( !parseParameters(r) ) { return undefined; }
            return { type: 'inner-list' };
        }
        if ( parseBareItem(r) === undefined ) { return undefined; }
        if ( !parseParameters(r) ) { return undefined; }
        if ( r.eof() ) { return undefined; }
        var c = r.peek();
        if ( c !== ' ' && c !== ')' ) { return undefined; }
    }
}

/**
 * RFC 8941 §4.2.2 — Parsing a Dictionary, restricted to what RFC 9218 needs:
 * every member is classified by TYPE (`integer` / `decimal` / `string` /
 * `token` / `bytes` / `boolean` / `inner-list`), a member with no `=` is
 * Boolean true, a repeated key overwrites (last wins), member parameters are
 * validated and dropped.
 *
 * @inner
 * @private
 * @param   {string} input - The combined field value.
 * @returns {Object<string, {type: string, value: *}>|null} The members, or
 *   `null` when the value fails the grammar and MUST be ignored whole.
 */
function parseDictionary(input) {
    var r    = new Reader(input);
    var dict = {};
    r.skipSP();
    while ( !r.eof() ) {
        var key = parseKey(r);
        if ( key === undefined ) { return null; }
        var member;
        if ( !r.eof() && r.peek() === '=' ) {
            r.next();
            if ( r.eof() ) { return null; }
            member = ( r.peek() === '(' ) ? parseInnerList(r) : parseBareItem(r);
            if ( member === undefined ) { return null; }
            if ( member.type !== 'inner-list' && !parseParameters(r) ) { return null; }
        } else {
            member = { type: 'boolean', value: true };
            if ( !parseParameters(r) ) { return null; }
        }
        dict[key] = member;
        r.skipSP();
        if ( r.eof() ) { return dict; }
        if ( r.next() !== ',' ) { return null; }
        r.skipSP();
        if ( r.eof() ) { return null; } // trailing comma
    }
    return dict;
}

/**
 * RFC 8941 §4.2 step 1 — combine field lines: node hands most repeated
 * headers over as one comma-joined string already, but an array is joined
 * with `", "` here too so a caller can pass either shape. Anything that is
 * not a string afterwards means "no header".
 *
 * @inner
 * @private
 * @param   {*} value
 * @returns {string|null}
 */
function fieldValue(value) {
    if ( Array.isArray(value) ) { value = value.join(', '); }
    return ( typeof value === 'string' ) ? value : null;
}

/**
 * @typedef  {Object}  PriorityInfo
 * @property {number}  urgency     - 0 (most urgent) … 7; `3` when the header says nothing.
 * @property {boolean} incremental - `true` when the response may be served in parts.
 * @property {boolean} present     - `true` when a header was present AND parsed as a
 *   dictionary — even one whose members were all ignored. `false` for an absent header
 *   and for one that failed the grammar (RFC 8941 §4.2: ignored as if absent).
 */

/**
 * Parse a `Priority` header field value (RFC 9218 §4 over RFC 8941).
 *
 * Never throws. Out-of-range or wrong-type `u` / `i`, unknown members and
 * member parameters are ignored individually; a grammar failure ignores the
 * whole field. A fresh object is returned on every call.
 *
 * @param   {string|string[]|undefined} value - `req.headers['priority']` as node presents it.
 * @returns {PriorityInfo}
 *
 * @example
 * parse('u=2, i');   // → { urgency: 2, incremental: true,  present: true }
 * parse('i');        // → { urgency: 3, incremental: true,  present: true }
 * parse('u=1, i=1'); // → { urgency: 1, incremental: false, present: true } (i=1 is an Integer, wrong type)
 * parse('u=1,');     // → { urgency: 3, incremental: false, present: false } (trailing comma: whole field ignored)
 */
function parse(value) {
    var out = { urgency: DEFAULT_URGENCY, incremental: false, present: false };
    var s   = fieldValue(value);
    if ( s === null ) { return out; }
    var dict = parseDictionary(s);
    if ( dict === null ) { return out; }
    out.present = true;
    var u = dict.u, i = dict.i;
    if ( u && u.type === 'integer' && u.value >= URGENCY_MIN && u.value <= URGENCY_MAX ) {
        out.urgency = u.value;
    }
    if ( i && i.type === 'boolean' ) {
        out.incremental = i.value;
    }
    return out;
}

/**
 * Clamp a caller-supplied urgency to the RFC range, or fall back to the default.
 * Accepts only an integer 0–7 (a numeric string is NOT coerced).
 *
 * @param   {*} value
 * @returns {number} The urgency to use.
 *
 * @example
 * normalizeUrgency(0);    // → 0
 * normalizeUrgency(9);    // → 3
 * normalizeUrgency('1');  // → 3
 */
function normalizeUrgency(value) {
    if ( typeof value === 'number' && isFinite(value) && Math.floor(value) === value
        && value >= URGENCY_MIN && value <= URGENCY_MAX ) {
        return value;
    }
    return DEFAULT_URGENCY;
}

/**
 * Serialize a priority specification to a `Priority` field value.
 *
 * An explicit `urgency` is ALWAYS emitted — including `3` — because on a
 * response only an explicit member overrides the client's value (RFC 9218 §8:
 * absence means "no change"). `incremental` is emitted as the bare key `i`
 * when true and omitted when false (its default). Out-of-range or non-integer
 * urgency is dropped rather than thrown. Returns `''` when there is nothing to
 * say, so a caller can skip the header.
 *
 * @param   {{urgency?: number, incremental?: boolean}|undefined} spec
 * @returns {string} e.g. `'u=1, i'`, `'u=3'`, `'i'`, or `''`.
 *
 * @example
 * serialize({ urgency: 1, incremental: true }); // → 'u=1, i'
 * serialize({ incremental: true });             // → 'i'
 * serialize({ urgency: 9 });                    // → ''
 */
function serialize(spec) {
    if ( !spec || typeof spec !== 'object' ) { return ''; }
    var parts = [];
    var u = spec.urgency;
    if ( typeof u === 'number' && isFinite(u) && Math.floor(u) === u && u >= URGENCY_MIN && u <= URGENCY_MAX ) {
        parts.push('u=' + u);
    }
    if ( spec.incremental === true ) {
        parts.push('i');
    }
    return parts.join(', ');
}

/**
 * Decide the `Priority` header of an OUTBOUND call — the four-rung chain
 * `self.query()` runs before dispatch (one site for both transports, every
 * retry and `self.forward()`):
 *
 *   1. the caller already set a `Priority` header (any casing) → leave it alone;
 *   2. `option === false`                                       → send nothing;
 *   3. `option` given (a `{urgency, incremental}` object or a wire string) →
 *      its normalized form, or nothing when it says nothing — an explicit
 *      option never falls through to the inbound value;
 *   4. the inbound request carried a header (`inbound.present`)   → propagate
 *      its normalized value (RFC 9218 is end-to-end: a sub-request made on
 *      behalf of a `u=0` page is itself `u=0`);
 *   5. otherwise                                                  → nothing.
 *
 * @param   {Object}        input
 * @param   {Object}        [input.headers] - The outbound `options.headers` map (read only).
 * @param   {*}             [input.option]  - The caller's `options.priority`.
 * @param   {PriorityInfo}  [input.inbound] - `req.priority` of the request being served, if any.
 * @returns {string|null} The header value to set, or `null` to set nothing.
 *
 * @example
 * resolveOutbound({ headers: {}, inbound: { urgency: 0, incremental: true, present: true } }); // → 'u=0, i'
 * resolveOutbound({ headers: {}, option: false, inbound: { urgency: 0, incremental: true, present: true } }); // → null
 * resolveOutbound({ headers: { Priority: 'u=6' }, option: { urgency: 0 } }); // → null (the caller's header wins)
 */
function resolveOutbound(input) {
    input = input || {};
    var headers = input.headers;
    if ( headers && typeof headers === 'object' ) {
        for ( var k in headers ) {
            if ( Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === HEADER_NAME
                && typeof headers[k] === 'string' && headers[k].length > 0 ) {
                return null;
            }
        }
    }
    var option = input.option;
    if ( option === false ) { return null; }
    if ( typeof option !== 'undefined' && option !== null ) {
        if ( typeof option === 'string' ) {
            var parsed = parse(option);
            return ( parsed.present ) ? serialize(parsed) || null : null;
        }
        return serialize(option) || null;
    }
    var inbound = input.inbound;
    if ( inbound && inbound.present === true ) {
        return serialize({ urgency: inbound.urgency, incremental: inbound.incremental }) || null;
    }
    return null;
}

module.exports = {
    parse:            parse,
    serialize:        serialize,
    resolveOutbound:  resolveOutbound,
    normalizeUrgency: normalizeUrgency,
    DEFAULT_URGENCY:  DEFAULT_URGENCY,
    URGENCY_MIN:      URGENCY_MIN,
    URGENCY_MAX:      URGENCY_MAX,
    HEADER_NAME:      HEADER_NAME
};
