#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Generate types/gna.d.ts from JSDoc annotations.
 *
 * Reads:
 *   - framework/v<version>/test/unit/gna-exports.test.js -> GLOBAL_EXPORTS inventory
 *   - framework/v<version>/core/gna.js                   -> per-export JSDoc blocks
 *   - types/globals.d.ts                                 -> already-declared globals
 *
 * Emits:
 *   types/gna.d.ts — `GinaExports` interface with one entry per GLOBAL_EXPORTS
 *   name (plus SuperController / EntitySuper / uuid class bindings).
 *
 * For each exported name the generator prefers `typeof globalThis.<name>` when
 * globals.d.ts declares it; otherwise it synthesizes a function signature from
 * the JSDoc block immediately preceding `gna.<name> =` in core/gna.js.
 *
 * Run with:
 *   node script/generate_gna_types.js            # write types/gna.d.ts
 *   node script/generate_gna_types.js --check    # exit 1 if file would change
 *   node script/generate_gna_types.js --stdout   # print, do not write
 *
 * Zero non-core dependencies. Called by `npm run types:gen`.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT   = path.resolve(__dirname, '..');
const PKG_PATH    = path.join(REPO_ROOT, 'package.json');
const TYPES_DIR   = path.join(REPO_ROOT, 'types');
const OUT_PATH    = path.join(TYPES_DIR, 'gna.d.ts');
const GLOBALS_DTS = path.join(TYPES_DIR, 'globals.d.ts');

const PKG         = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const VERSION     = PKG.version;
const FRAMEWORK   = path.join(REPO_ROOT, 'framework', 'v' + VERSION);
const CORE_GNA    = path.join(FRAMEWORK, 'core', 'gna.js');
const TEST_FILE   = path.join(FRAMEWORK, 'test', 'unit', 'gna-exports.test.js');

// ---------------------------------------------------------------------------
// Step 1 — extract GLOBAL_EXPORTS inventory from the unit test file.
// ---------------------------------------------------------------------------

function readGlobalExports() {
    const src   = fs.readFileSync(TEST_FILE, 'utf8');
    const match = src.match(/const\s+GLOBAL_EXPORTS\s*=\s*\[([\s\S]*?)\];/);
    if (!match) {
        throw new Error('Could not locate GLOBAL_EXPORTS array in ' + TEST_FILE);
    }

    const body = match[1];
    const names = [];
    // Match quoted strings, skip comment-only lines.
    const rx = /(?<!\/\/[^\n]*)['"]([^'"]+)['"]/g;
    // Strip line comments first, then match.
    const stripped = body.replace(/\/\/[^\n]*/g, '');
    let m;
    const literalRx = /['"]([^'"]+)['"]/g;
    while ((m = literalRx.exec(stripped)) !== null) {
        names.push(m[1]);
    }

    if (!names.length) {
        throw new Error('GLOBAL_EXPORTS parsed as empty list');
    }
    return names;
}

// ---------------------------------------------------------------------------
// Step 2 — extract declared globals from types/globals.d.ts.
// A name is considered "globally declared" when globals.d.ts contains either
// `function <name>(` or `var <name>:` inside the `declare global { ... }` block.
// ---------------------------------------------------------------------------

function readDeclaredGlobals() {
    const src = fs.readFileSync(GLOBALS_DTS, 'utf8');
    const declared = new Set();

    // Capture inside declare global { ... } — simple nested-brace walk.
    const start = src.indexOf('declare global');
    if (start === -1) return declared;

    let depth = 0;
    let i = src.indexOf('{', start);
    const bodyStart = i + 1;
    let bodyEnd = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) { bodyEnd = i; break; }
        }
    }
    if (bodyEnd === -1) return declared;

    const body = src.slice(bodyStart, bodyEnd);

    const fnRx  = /^\s*function\s+([A-Za-z_$][\w$]*)\s*[<(]/gm;
    const varRx = /^\s*var\s+([A-Za-z_$][\w$]*)\s*:/gm;

    let m;
    while ((m = fnRx.exec(body))  !== null) declared.add(m[1]);
    while ((m = varRx.exec(body)) !== null) declared.add(m[1]);

    return declared;
}

// ---------------------------------------------------------------------------
// Step 3 — extract per-export JSDoc blocks from core/gna.js.
// For each GLOBAL_EXPORTS name, locate the line `gna.<name> = ...` and capture
// the `/** ... */` block immediately above it (no more than 2 blank lines of
// separation).
// ---------------------------------------------------------------------------

function readCoreJsDoc() {
    const src = fs.readFileSync(CORE_GNA, 'utf8');
    const blocks = {};

    // Pre-index all JSDoc blocks with their end offsets.
    const jsdocRx = /\/\*\*([\s\S]*?)\*\//g;
    const jsdocs  = [];
    let m;
    while ((m = jsdocRx.exec(src)) !== null) {
        jsdocs.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
    }

    // Anchor-free on purpose: `gna.<name> =` assignments are routinely
    // INDENTED (e.g. `gna.getConfig` is assigned inside a boot callback), so
    // a line-anchored `/^gna\./` silently misses them and their JSDoc.
    const assignRx = /^\s*gna\.([A-Za-z_$][\w$]*)\s*=/gm;
    while ((m = assignRx.exec(src)) !== null) {
        const name = m[1];
        const assignStart = m.index;
        // Find the last JSDoc that ends before the assignment, with only
        // whitespace / blank lines between them.
        let picked = null;
        for (let i = jsdocs.length - 1; i >= 0; i--) {
            const j = jsdocs[i];
            if (j.end >= assignStart) continue;
            const between = src.slice(j.end, assignStart);
            if (/^\s*$/.test(between)) { picked = j; }
            break;
        }
        if (picked && !blocks[name]) {
            blocks[name] = picked.body;
        }
    }

    return blocks;
}

// ---------------------------------------------------------------------------
// Step 4 — parse a JSDoc block into { description, params[], returns }.
// ---------------------------------------------------------------------------

function sanitizeForJsDoc(str) {
    // `*/` inside a value would prematurely close the emitted JSDoc.
    return String(str).replace(/\*\//g, '*\\/');
}

function parseJsDoc(body) {
    const lines = body.split('\n').map(function (l) {
        return l.replace(/^\s*\*\s?/, '').replace(/\s+$/, '');
    });

    const description = [];
    const params      = [];
    let   returns     = null;

    let mode = 'desc';
    for (const line of lines) {
        const paramMatch   = line.match(/^@param\s+\{([^}]+)\}\s+(\[?[\w$.]+\]?)\s*(?:-\s*)?(.*)$/);
        const returnsMatch = line.match(/^@returns?\s+\{([^}]+)\}\s*(.*)$/);

        if (paramMatch) {
            mode = 'param';
            let name = paramMatch[2];
            const optional = name.startsWith('[');
            if (optional) name = name.slice(1, -1);
            // Drop default-value suffix, e.g. [type='dir'] -> type
            const eq = name.indexOf('=');
            if (eq !== -1) name = name.slice(0, eq);
            // Drop nested-param dotted names (e.g. callback.err) — not part of
            // the fn signature.
            if (name.indexOf('.') !== -1) continue;
            params.push({
                jsdocType: paramMatch[1].trim(),
                name:      name,
                optional:  optional,
                desc:      (paramMatch[3] || '').trim()
            });
        } else if (returnsMatch) {
            mode = 'returns';
            returns = {
                jsdocType: returnsMatch[1].trim(),
                desc:      (returnsMatch[2] || '').trim()
            };
        } else if (/^@(throws|example|memberof|class|module)/.test(line)) {
            mode = 'other';
        } else if (mode === 'desc' && line) {
            description.push(line);
        }
    }

    return {
        description: sanitizeForJsDoc(description.join(' ').replace(/\s+/g, ' ').trim()),
        params:      params.map(function (p) {
            return Object.assign({}, p, { desc: sanitizeForJsDoc(p.desc) });
        }),
        returns:     returns
            ? { jsdocType: returns.jsdocType, desc: sanitizeForJsDoc(returns.desc) }
            : null
    };
}

// ---------------------------------------------------------------------------
// Step 5 — translate a JSDoc type string into a TypeScript type expression.
// ---------------------------------------------------------------------------

const TYPE_MAP = {
    '*':        'any',
    'any':      'any',
    'string':   'string',
    'number':   'number',
    'boolean':  'boolean',
    'void':     'void',
    'null':     'null',
    'undefined':'undefined',
    'object':   'object',
    'Object':   'object',
    'Error':    'Error',
    'RegExp':   'RegExp',
    'Function': 'Function',
    'function': 'Function',
    'Date':     'Date'
};

function translateType(jsdocType, context) {
    if (!jsdocType) return 'any';
    const trimmed = jsdocType.trim();

    // Rest type, e.g. ...*
    if (trimmed.startsWith('...')) {
        const inner = translateType(trimmed.slice(3), context);
        return inner + '[]';
    }

    // Union
    if (trimmed.indexOf('|') !== -1) {
        return trimmed.split('|').map(function (t) {
            return translateType(t, context);
        }).join(' | ');
    }

    // Generic, e.g. Promise<*>, Array<string>
    const gen = trimmed.match(/^([A-Za-z_$][\w$]*)<(.+)>$/);
    if (gen) {
        return translateType(gen[1], context) + '<' + translateType(gen[2], context) + '>';
    }

    // Array shorthand, e.g. string[], Array[]
    if (trimmed.endsWith('[]')) {
        const base = trimmed.slice(0, -2);
        if (base === 'Array') return 'any[][]';
        return translateType(base, context) + '[]';
    }

    if (Object.prototype.hasOwnProperty.call(TYPE_MAP, trimmed)) {
        return TYPE_MAP[trimmed];
    }

    // Bare `Array` — treat as any[]
    if (trimmed === 'Array') return 'any[]';

    // Pass through — likely a custom type (EventEmitter, PathObject, ...).
    return trimmed;
}

// ---------------------------------------------------------------------------
// Step 6 — emit a TypeScript function-type expression from a parsed JSDoc.
// ---------------------------------------------------------------------------

function emitFnType(parsed) {
    const params = parsed.params.map(function (p) {
        let tsType = translateType(p.jsdocType, 'param');
        let name   = p.name;
        let suffix = p.optional ? '?' : '';

        // Rest: JSDoc `{...*}` with name `args` -> `...args: any[]`.
        if (p.jsdocType.trim().startsWith('...')) {
            name   = '...' + name;
            suffix = '';
        }
        return name + suffix + ': ' + tsType;
    }).join(', ');

    const ret = parsed.returns ? translateType(parsed.returns.jsdocType, 'returns') : 'void';
    return '(' + params + ') => ' + ret;
}

// ---------------------------------------------------------------------------
// Step 7 — format a multi-line JSDoc comment for the output.
// ---------------------------------------------------------------------------

function emitDocComment(parsed, indent) {
    const lines = [];
    if (parsed.description) {
        // Wrap at ~90 chars to keep the file readable.
        const wrapped = wrap(parsed.description, 90);
        for (const w of wrapped) lines.push(w);
    }
    if (parsed.params.length) {
        if (lines.length) lines.push('');
        for (const p of parsed.params) {
            const desc = p.desc ? ' - ' + p.desc : '';
            lines.push('@param ' + p.name + desc);
        }
    }
    if (parsed.returns && parsed.returns.desc) {
        if (lines.length && !lines[lines.length - 1].startsWith('@')) lines.push('');
        lines.push('@returns ' + parsed.returns.desc);
    }
    if (!lines.length) return '';

    if (lines.length === 1) {
        return indent + '/** ' + lines[0] + ' */';
    }
    return indent + '/**\n' +
        lines.map(function (l) { return indent + ' * ' + l; }).join('\n').replace(/ \* $/gm, ' *') +
        '\n' + indent + ' */';
}

function wrap(str, width) {
    const words = str.split(/\s+/);
    const out = [];
    let line = '';
    for (const w of words) {
        if (line.length + w.length + 1 > width) {
            if (line) out.push(line);
            line = w;
        } else {
            line = line ? line + ' ' + w : w;
        }
    }
    if (line) out.push(line);
    return out;
}

// ---------------------------------------------------------------------------
// Step 8 — group names for readable section headers.
// ---------------------------------------------------------------------------

const SECTIONS = [
    { header: 'Context helpers',
      names: ['setContext', 'getContext', 'joinContext', 'resetContext',
              'getConfig', 'getLib', 'whisper', 'define', 'getDefined'] },
    { header: 'Platform helper',
      names: ['isWin32'] },
    { header: 'Path helpers',
      names: ['_', 'setPath', 'getPath', 'setPaths', 'getPaths', 'onCompleteCall'] },
    { header: 'Model helpers',
      names: ['getModel', 'getModelEntity'] },
    { header: 'JSON helper',
      names: ['requireJSON'] },
    { header: 'Data helpers',
      names: ['encodeRFC5987ValueChars', 'formatDataFromString'] },
    { header: 'Text helper',
      names: ['__'] },
    { header: 'Console helper',
      names: ['log'] },
    { header: 'Task helper',
      names: ['run'] },
    { header: 'Env helpers',
      names: ['getUserHome', 'getEnvVar', 'getEnvVars', 'setEnvVar',
              'getProtected', 'filterArgs', 'importEnvVars', 'getLogDir', 'getRunDir', 'getTmpDir',
              'getArgvDir', 'getBundleStartingArgv', 'getVendorsConfig', 'setVendorsConfig',
              'defineDefault', 'parseTimeout', 'merge'] },
    { header: 'ApiError',
      names: ['ApiError'] }
];

function groupNames(allNames) {
    const seen = new Set();
    const groups = [];
    for (const section of SECTIONS) {
        const names = section.names.filter(function (n) { return allNames.indexOf(n) !== -1; });
        for (const n of names) seen.add(n);
        if (names.length) groups.push({ header: section.header, names: names });
    }
    const leftovers = allNames.filter(function (n) { return !seen.has(n); });
    if (leftovers.length) {
        groups.push({ header: 'Other', names: leftovers });
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Step 9 — emit the complete gna.d.ts body.
// ---------------------------------------------------------------------------

function emitEntry(name, declared, docBlocks) {
    // ApiError is a constructor, not a callable.
    if (name === 'ApiError') {
        return ['    ApiError: typeof globalThis.ApiError;'];
    }

    const indent = '    ';
    if (declared.has(name)) {
        const line = indent + name + ': typeof globalThis.' + name + ';';
        const body = docBlocks[name];
        if (body) {
            const parsed = parseJsDoc(body);
            if (parsed.description) {
                // Keep entries compact: one-line /** */ when the first sentence fits,
                // otherwise fall back to a wrapped multi-line block. Require the sentence
                // terminator to not be part of an ellipsis (`...`) or `!!`/`??`.
                const sentenceMatch = parsed.description.match(
                    /^(.*?(?<![.!?])[.!?](?![.!?]))(\s|$)/
                );
                const firstSentence = sentenceMatch ? sentenceMatch[1] : parsed.description;
                if (firstSentence.length <= 100) {
                    return [indent + '/** ' + firstSentence + ' */', line];
                }
                const wrapped = wrap(firstSentence, 90);
                const commentLines = [indent + '/**'];
                for (const w of wrapped) commentLines.push(indent + ' * ' + w);
                commentLines.push(indent + ' */');
                return commentLines.concat([line]);
            }
        }
        return [line];
    }

    // Synthesize from JSDoc.
    const body = docBlocks[name];
    if (!body) {
        // Fallback — no JSDoc found, emit a permissive signature.
        return [indent + name + ': (...args: any[]) => any;'];
    }
    const parsed = parseJsDoc(body);
    const doc    = emitDocComment(parsed, indent);
    const sig    = indent + name + ': ' + emitFnType(parsed) + ';';
    return doc ? [doc, sig] : [sig];
}

function generate() {
    const names       = readGlobalExports();
    const declared    = readDeclaredGlobals();
    const docBlocks   = readCoreJsDoc();

    // Fail fast if any name is missing a JSDoc block and isn't globally declared.
    const gaps = names.filter(function (n) {
        return n !== 'ApiError' && !declared.has(n) && !docBlocks[n];
    });
    if (gaps.length) {
        throw new Error(
            'Cannot generate types/gna.d.ts: missing JSDoc for ' +
            gaps.join(', ') + ' in ' + path.relative(REPO_ROOT, CORE_GNA) +
            ' (and not declared in globals.d.ts). Add JSDoc or declare the global.'
        );
    }

    const groups = groupNames(names);

    const out = [];
    out.push('/**');
    out.push(' * Gina Framework — Explicit exports');
    out.push(' *');
    out.push(' * Type declarations for `require(\'gina/gna\')`.');
    out.push(' * Provides named imports for all global helpers, enabling IDE navigation');
    out.push(' * and static analysis without relying on global scope injection.');
    out.push(' *');
    out.push(' * AUTO-GENERATED by script/generate_gna_types.js — do not edit by hand.');
    out.push(' * Source of truth: JSDoc on core/gna.js (per-global) and globals.d.ts.');
    out.push(' * Run `npm run types:gen` after adding or removing a global export.');
    out.push(' *');
    out.push(' * Usage:');
    out.push(' *   const { getContext, _, onCompleteCall, uuid } = require(\'gina/gna\');');
    out.push(' */');
    out.push('');
    out.push('import type { UuidFunction } from \'./globals\';');
    out.push('import type { SuperControllerConstructor, EntitySuperConstructor } from \'./index\';');
    out.push('');
    out.push('interface GinaExports {');

    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (i > 0) out.push('');
        out.push('    // ' + g.header);
        for (const name of g.names) {
            for (const line of emitEntry(name, declared, docBlocks)) {
                out.push(line);
            }
        }
    }

    out.push('');
    out.push('    // Classes — the CONSTRUCTOR VALUES live on this barrel (root gna.js),');
    out.push('    // not on the main entry, whose declarations are type-only.');
    out.push('    SuperController: SuperControllerConstructor;');
    out.push('    EntitySuper: EntitySuperConstructor;');
    out.push('');
    out.push('    // uuid');
    out.push('    uuid: UuidFunction;');
    out.push('}');
    out.push('');
    out.push('declare const ginaExports: GinaExports;');
    out.push('export = ginaExports;');
    out.push('');

    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Step 10 — entry point.
// ---------------------------------------------------------------------------

function main() {
    const args     = process.argv.slice(2);
    const check    = args.includes('--check');
    const toStdout = args.includes('--stdout');
    const output   = generate();

    if (toStdout) {
        process.stdout.write(output);
        return;
    }

    if (check) {
        let existing = '';
        try { existing = fs.readFileSync(OUT_PATH, 'utf8'); } catch (_) { /* no-op */ }
        if (existing === output) {
            console.log('types/gna.d.ts is up to date.');
            process.exit(0);
        }
        console.error('types/gna.d.ts is out of date. Run: npm run types:gen');
        process.exit(1);
    }

    fs.mkdirSync(TYPES_DIR, { recursive: true });
    fs.writeFileSync(OUT_PATH, output, 'utf8');
    console.log('Wrote ' + path.relative(REPO_ROOT, OUT_PATH));
}

if (require.main === module) {
    try { main(); } catch (err) {
        console.error('[generate_gna_types] ' + (err && err.message || err));
        process.exit(1);
    }
}

module.exports = { generate: generate, readDeclaredGlobals: readDeclaredGlobals };
