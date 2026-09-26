/**
 * Gina Framework — Global type augmentations
 *
 * These symbols are injected on the `global` scope at framework boot time.
 * No import required — they are available everywhere in a running Gina app.
 *
 * Every declaration in this file is verified against the runtime by
 * `test/lib/types-runtime-parity.test.js` — a symbol may only be declared
 * here if the framework actually injects it (and vice versa). Do not add
 * declarations from memory.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';

// ─── PathObject ──────────────────────────────────────────────────────────────

/**
 * Array-like result returned by `_().toArray()`.
 */
interface PathArray extends Array<string> {
    first(): string;
    index(i: number): string;
    last(): string;
}

/**
 * Object returned by `_(path)` when the path is resolvable.
 * Provides file-system helpers with both sync and async (EventEmitter) APIs.
 */
interface PathObject {
    /** Resolved absolute path */
    readonly path: string;
    /** Alias for `.path` */
    readonly value: string;
    /** Basename of the path */
    readonly key: string;
    /** Platform path separator */
    readonly sep: string;
    /** First segment of the path */
    readonly start: string;

    toString(): string;
    toArray(): PathArray;

    existsSync(): boolean;
    exists(callback: (exists: boolean) => void): void;
    isDirectory(): boolean;
    isSymlinkSync(): boolean;
    getSymlinkSourceSync(): string;
    isWritableSync(): boolean;
    isWritable(callback: (writable: boolean) => void): void;
    hasFile(search: string, callback: (err: Error | null, found: boolean) => void): void;

    mkdirSync(): void;
    mkdir(): EventEmitter & { onComplete(cb: (err: Error | null) => void): void };
    cp(target: string, options?: object): EventEmitter & { onComplete(cb: (err: Error | null) => void): void };
    mv(target: string): EventEmitter & { onComplete(cb: (err: Error | null) => void): void };
    rm(): EventEmitter & { onComplete(cb: (err: Error | null) => void): void };
    rmSync(): void;
}

// ─── OnCompletable ───────────────────────────────────────────────────────────

/** Any object that exposes `.onComplete(cb)` — the pattern used by entity methods and PathObject ops. */
interface OnCompletable {
    onComplete(cb: (err: any, result?: any) => void): void;
}

// ─── ApiError ────────────────────────────────────────────────────────────────

interface ApiErrorConstructor {
    new (errorMessage: string, fieldName?: string, errorStatus?: number): ApiError;
    (errorMessage: string, fieldName?: string, errorStatus?: number): ApiError;
}

interface ApiError extends Error {
    status: number;
    error: string;
    fields: Record<string, string>;
    flash: Record<string, string>;
}

// ─── Locale types ────────────────────────────────────────────────────────────

interface Country {
    isoShort: string;
    isoLong: string;
    countryName: string;
    officialStateName: string;
}

interface LocaleResult {
    getCountries(code?: string): Country[];
}

// ─── uuid ────────────────────────────────────────────────────────────────────

interface UuidFunction {
    /**
     * Generate a random base-62 ID.
     * @param size - Number of characters (default: 4)
     */
    (size?: number): string;

    /**
     * Create a generator for a custom alphabet.
     * @param alphabet - Characters to use
     * @param defaultSize - Default output length
     * @returns A generator function `(size?) => string`
     */
    customAlphabet(alphabet: string, defaultSize?: number): (size?: number) => string;
}

// ─── Global declarations ─────────────────────────────────────────────────────

declare global {

    // -- JSON augmentation --
    // (Must live INSIDE `declare global` — at module scope this interface
    // would silently never merge with the built-in JSON type.)

    interface JSON {
        /** Deep-clone any JSON-safe value */
        clone<T>(obj: T): T;
        /** Escape special characters in a string for safe embedding */
        escape(str: string): string;
    }

    // -- Path helpers --

    /**
     * Resolve a path string. Returns a `PathObject` when called as a constructor
     * or the resolved path string when `force` is `true`.
     */
    function _(path: string, force: true): string;
    function _(path: string, force?: boolean): PathObject;

    /**
     * Register a named path. The framework itself also stores structured path
     * maps under a name (e.g. `setPath('gina', { core: ... })`), so the value
     * may be a string or an object of paths.
     */
    function setPath(name: string, path: string | object): void;
    function getPath(name: string): string | object;
    function setPaths(paths: Record<string, string>): void;
    function getPaths(): Record<string, string>;

    /**
     * Wrap an `.onComplete(cb)` emitter into a native Promise.
     * Enables `await onCompleteCall(_(path).mkdir())`.
     */
    function onCompleteCall<T = any>(emitter: OnCompletable): Promise<T>;

    // -- Context helpers --

    function setContext(name: string | object, obj?: any, force?: boolean): void;
    function getContext(name: string): any;
    function getContext(): Record<string, any>;
    /** Merge an additional contexts object into the current registry. */
    function joinContext(context: object): void;
    function resetContext(): void;
    function getConfig(bundle?: string, confName?: string): any;
    function getLib(lib: string): any;
    function getLib(bundle: string, lib: string): any;
    function whisper(dictionary: object, replaceable: string, rule?: RegExp): string | object;
    function whisper(dictionary: object, replaceable: object, rule?: RegExp): object;
    function define(name: string, value: any): void;
    function getDefined(): Array<{ name: string; value: any }>;

    // -- Model helpers --
    // Injected when the model layer initialises (bundle boot with connectors),
    // not by the bare helpers bootstrap.

    function getModel(model: string): any;
    function getModel(bundle: string, model: string): any;
    function getModelEntity(bundle: string, model: string, entityClassName: string, conn?: any): any;

    // -- JSON helper --

    /** Load a JSON file with comment stripping. */
    function requireJSON(filename: string): any;

    // -- Task helper --

    function run(cmdline: string | string[], opt?: object, cb?: (err: Error | null, result?: any) => void): EventEmitter & OnCompletable;

    // -- Data helpers --

    /** URL-encode a string per RFC 5987 (`*` → `%2A`, keeps `|` `` ` `` `^`). */
    function encodeRFC5987ValueChars(str: string): string;
    /** Crash-safe `decodeURIComponent` — returns the input string unchanged on a malformed `%` escape. */
    function safeDecodeURIComponent(str: string): string;
    /** Crash-safe `decodeURI` — returns the input string unchanged on a malformed `%` escape. */
    function safeDecodeURI(str: string): string;
    /** Parse a form/body string (urlencoded, or a JSON document) into a nested object (bracket-notation `foo[bar][0]` keys nest); `undefined` for an invalid JSON document. */
    function formatDataFromString(bodyStr: string | object): object | undefined;
    /**
     * Nest ONE bracket-notation key path (`item[0][id]`) into the accumulator
     * object at depth `k` (callers pass `0`); assigns `value` at the leaf.
     * Mutates and returns the accumulator.
     */
    function nestBracketNotationKey(obj: object | any[], key: string[], k: number, value: any): object | any[];

    // -- Env helpers --

    function isWin32(): boolean;
    function getEnvVar(key: string): any;
    function getEnvVars(): Record<string, any>;
    function setEnvVar(key: string, val: any, isProtected?: boolean): void;
    /** List env-var keys that were marked protected via `setEnvVar(..., true)`. */
    function getProtected(): string[];
    /** Promote `--key=value` argv flags to env vars, then strip them from `argv`. */
    function filterArgs(): void;
    /** Import `GINA_*`/`VENDOR_*`/`USER_*` keys from `process.env` into `process.gina`; `keep=true` leaves `process.env` intact (the `bin/cli` early visibility pass), default deletes them (the `filterArgs()` sweep). */
    function importEnvVars(keep?: boolean): void;
    function getUserHome(): string;
    function getLogDir(): string;
    function getRunDir(): string;
    function getTmpDir(): string;
    /** Resolve the argv dir — `<GINA_HOMEDIR>/run`, created `0700` when absent — where each bundle's start argv is saved for the `gina tail --follow` crash restart. Never the shared tmp dir. */
    function getArgvDir(): string;
    /** Read the saved startup argv for `bundle@project` from the argv dir (used by the `gina tail --follow` crash restart), or `null` — also when, on POSIX, the file is not a regular file owned by the current user that group/other cannot write. */
    function getBundleStartingArgv(bundle: string, project: string): string | null;
    /** Read a vendor config loaded via `setVendorsConfig` (omit `vendor` for the whole map). */
    function getVendorsConfig(vendor?: string): object | undefined;
    /** Load every `*.json` file in `dir` as a vendor config keyed by filename. */
    function setVendorsConfig(dir: string): void;
    /** Bulk-register an object of env vars as `USER_*` defaults via `define`. */
    function defineDefault(obj: object): void;
    function parseTimeout(value: string | number): number | null;

    // -- Misc helpers --

    /**
     * Framework deep-merge. The TARGET (first argument) wins on collisions
     * unless `override` is `true`; the source only fills missing keys.
     * Returns the mutated first argument.
     */
    function merge(target: object, source: object, override?: boolean): object;
    /** Write arguments to stdout followed by a newline (objects JSON-stringified). */
    function log(...args: any[]): void;

    // -- i18n stub --

    function __(str: string): void;

    // -- ApiError --

    var ApiError: ApiErrorConstructor;

    // -- Stack-introspection getters (logger plumbing; evaluated at the access site) --
    // `__filename` is ALSO injected but is deliberately not re-declared here:
    // @types/node already declares it with the same type.

    /** Current V8 call-site stack (getter). */
    var __stack: NodeJS.CallSite[];
    /** Line number at the access site (getter). */
    var __line: number;
    /** Column number at the access site (getter). */
    var __column: number;
    /** File name at the access site (getter); `undefined` in eval-like contexts. */
    var __file: string | undefined;
    /** Enclosing function name at the access site (getter); `null` at top level. */
    var __function: string | null;
    /** Module name derived from the access site (getter). */
    var __module: string;

    // -- Array augmentation --

    interface Array<T> {
        clone(): T[];
    }
}

export { PathObject, PathArray, OnCompletable, ApiError, ApiErrorConstructor, UuidFunction, Country, LocaleResult };
