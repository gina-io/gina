/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/connector-registry
 * @description Single source of truth for the connector driver → npm
 * package + semver range mapping. Consumed by the `connector:*` CLI
 * handlers (`connector:add`, `connector:list`) to produce install hints
 * and to resolve the range used by `connector:add --install`.
 *
 * Previously duplicated inline in `lib/cmd/connector/add.js` and
 * `lib/cmd/connector/list.js`, and also in the root `package.json`
 * `peerDependencies` — three hand-synced copies that had already
 * drifted (list.js knew about `mongodb` / `scylladb`, add.js did not).
 * This module consolidates them into one table.
 *
 * Adding a new connector upstream: edit `DRIVER_MAP` here. Both
 * `connector:add` and `connector:list` pick the change up automatically.
 */

'use strict';

/**
 * Driver entry for a non-AI connector type.
 *
 * @typedef {object} DriverEntry
 * @property {string}  [npm]      npm package name (absent for builtins).
 * @property {string}  [range]    Semver range, e.g. `>=3.0.0`.
 * @property {boolean} [builtin]  True when provided by Node.js itself.
 * @property {string}  [note]     Human-readable note (used for builtins).
 */

/**
 * Driver entry for an AI protocol scheme — always requires an npm package.
 *
 * @typedef {object} AIDriverEntry
 * @property {string} npm    npm package name.
 * @property {string} range  Semver range.
 */

/**
 * Logical `connector` type → {@link DriverEntry}. Mirrors the enum in
 * `schema/connectors.json` (`connector.properties.connector.enum`).
 *
 * ScyllaDB uses `cassandra-driver` (Apache Software Foundation) since the
 * Node.js ecosystem has no first-party shard-aware ScyllaDB driver — the
 * official `@scylladb/scylla-driver` package does not exist on npm
 * (Python / Java / Go / Rust drivers are first-party shard-aware; Node.js
 * is not). `cassandra-driver` provides token-aware routing which is
 * sufficient for most workloads against ScyllaDB or Cassandra.
 *
 * @constant
 * @type {Object<string, DriverEntry>}
 */
var DRIVER_MAP = {
    couchbase  : { npm: 'couchbase',        range: '>=3.0.0' },
    redis      : { npm: 'ioredis',          range: '>=5.0.0' },
    mysql      : { npm: 'mysql2',           range: '>=2.0.0' },
    postgresql : { npm: 'pg',               range: '>=8.0.0' },
    mongodb    : { npm: 'mongodb',          range: '>=7.0.0' },
    scylladb   : { npm: 'cassandra-driver', range: '>=4.0.0' },
    // Every published @duckdb/node-api version carries an `-r.N` prerelease
    // suffix, so a caret range matches NOTHING (npm E404) and this floor is
    // tuple-frozen (semver excludes prereleases of other version tuples) —
    // bump it on driver updates like any other row.
    duckdb     : { npm: '@duckdb/node-api',  range: '>=1.5.5-r.0 <2' },
    sqlite     : { builtin: true, note: 'Node.js >= 22.5.0 built-in (node:sqlite)' }
};

/**
 * AI `protocol` scheme → {@link AIDriverEntry}. Matches the PROVIDERS
 * table in `core/connectors/ai/lib/connector.js`. OpenAI-compatible
 * providers (deepseek, qwen, groq, mistral, together, ollama, gemini,
 * xai, perplexity) all resolve to the `openai` npm package — the
 * `@anthropic-ai/sdk` entry is the only non-OpenAI-SDK exception.
 *
 * @constant
 * @type {Object<string, AIDriverEntry>}
 */
var AI_DRIVER_MAP = {
    anthropic  : { npm: '@anthropic-ai/sdk', range: '>=0.27.0' },
    openai     : { npm: 'openai',            range: '>=4.0.0' },
    deepseek   : { npm: 'openai',            range: '>=4.0.0' },
    qwen       : { npm: 'openai',            range: '>=4.0.0' },
    groq       : { npm: 'openai',            range: '>=4.0.0' },
    mistral    : { npm: 'openai',            range: '>=4.0.0' },
    together   : { npm: 'openai',            range: '>=4.0.0' },
    ollama     : { npm: 'openai',            range: '>=4.0.0' },
    gemini     : { npm: 'openai',            range: '>=4.0.0' },
    xai        : { npm: 'openai',            range: '>=4.0.0' },
    perplexity : { npm: 'openai',            range: '>=4.0.0' }
};

/**
 * Look up the driver entry for a non-AI connector type.
 *
 * @example
 * var reg  = lib.connectorRegistry;
 * var info = reg.getDriver('redis');
 * // → { npm: 'ioredis', range: '>=5.0.0' }
 *
 * @example
 * lib.connectorRegistry.getDriver('unknown');
 * // → null
 *
 * @param {string} type - Connector type key (e.g. 'redis', 'postgresql').
 * @returns {DriverEntry|null} The entry, or null when the type is unknown.
 */
function getDriver(type) {
    if (!type || typeof type !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(DRIVER_MAP, type) ? DRIVER_MAP[type] : null;
}

/**
 * Look up the driver entry for an AI protocol scheme.
 *
 * @example
 * lib.connectorRegistry.getAIDriver('anthropic');
 * // → { npm: '@anthropic-ai/sdk', range: '>=0.27.0' }
 *
 * @example
 * lib.connectorRegistry.getAIDriver('unknown');
 * // → null
 *
 * @param {string} scheme - Protocol scheme without trailing `://`
 *                          (e.g. 'anthropic', 'openai').
 * @returns {AIDriverEntry|null} The entry, or null when the scheme is unknown.
 */
function getAIDriver(scheme) {
    if (!scheme || typeof scheme !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(AI_DRIVER_MAP, scheme) ? AI_DRIVER_MAP[scheme] : null;
}

/**
 * List every known connector type key — for error messages, help text,
 * and source-inspection tests.
 *
 * @example
 * lib.connectorRegistry.getDriverTypes();
 * // → ['couchbase', 'redis', 'mysql', 'postgresql', 'mongodb', 'scylladb', 'duckdb', 'sqlite']
 *
 * @returns {string[]}
 */
function getDriverTypes() {
    return Object.keys(DRIVER_MAP);
}

/**
 * List every known AI protocol scheme — for error messages, help text,
 * and source-inspection tests.
 *
 * @example
 * lib.connectorRegistry.getAISchemes();
 * // → ['anthropic', 'openai', 'deepseek', 'qwen', 'groq', 'mistral',
 * //    'together', 'ollama', 'gemini', 'xai', 'perplexity']
 *
 * @returns {string[]}
 */
function getAISchemes() {
    return Object.keys(AI_DRIVER_MAP);
}

module.exports = {
    getDriver     : getDriver,
    getAIDriver   : getAIDriver,
    getDriverTypes: getDriverTypes,
    getAISchemes  : getAISchemes,
    DRIVER_MAP    : DRIVER_MAP,
    AI_DRIVER_MAP : AI_DRIVER_MAP
};
