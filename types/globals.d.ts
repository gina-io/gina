/**
 * Gina Framework — Global type augmentations
 *
 * These symbols are injected on the `global` scope at framework boot time.
 * No import required — they are available everywhere in a running Gina app.
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

// ─── JSON augmentations ──────────────────────────────────────────────────────

interface JSON {
    /** Deep-clone any JSON-safe value */
    clone<T>(obj: T): T;
    /** Escape special characters in a string for safe embedding */
    escape(str: string): string;
}

// ─── Global declarations ─────────────────────────────────────────────────────

declare global {

    // -- Path helpers --

    /**
     * Resolve a path string. Returns a `PathObject` when called as a constructor
     * or the resolved path string when `force` is `true`.
     */
    function _(path: string, force: true): string;
    function _(path: string, force?: boolean): PathObject;

    function setPath(name: string, path: string): void;
    function getPath(name: string): string | object;
    function setPaths(paths: Record<string, string>): void;
    function getPaths(): Record<string, string>;

    /**
     * Wrap an `.onComplete(cb)` emitter into a native Promise.
     * Enables `await onCompleteCall(_(path).mkdir())`.
     */
    function onCompleteCall<T = any>(emitter: OnCompletable): Promise<T>;

    // -- Context helpers --

    function setContext(name: string, obj: any, force?: boolean): void;
    function getContext(name: string): any;
    function getContext(): Record<string, any>;
    function resetContext(): void;
    function getConfig(bundle?: string, confName?: string): any;
    function getLib(bundle: string, lib?: string): any;
    function whisper(dictionary: object, replaceable: string, rule?: RegExp): string | object;
    function define(name: string, value: any): void;
    function getDefined(): Array<{ name: string; value: any }>;

    // -- Model helpers --

    function getModel(bundle?: string, model?: string): any;
    function getModelEntity(bundle: string, model: string, entityClassName: string, conn: any): any;

    // -- JSON helper --

    /** Load a JSON file with comment stripping. */
    function requireJSON(filename: string): any;

    // -- Task helper --

    function run(cmdline: string, opt?: object, cb?: (err: Error | null, result?: any) => void): EventEmitter & OnCompletable;

    // -- Env helpers --

    function isWin32(): boolean;
    function getEnvVar(key: string): any;
    function getEnvVars(): Record<string, any>;
    function setEnvVar(key: string, val: any, isProtected?: boolean): void;
    function getUserHome(): string;
    function getLogDir(): string;
    function getRunDir(): string;
    function getTmpDir(): string;
    function parseTimeout(value: string | number): number | null;

    // -- i18n stub --

    function __(str: string): void;

    // -- ApiError --

    var ApiError: ApiErrorConstructor;

    // -- Array augmentation --

    interface Array<T> {
        clone(): T[];
    }

    // -- String augmentation --

    interface String {
        ltrim(): string;
        rtrim(): string;
        gtrim(): string;
    }
}

export { PathObject, PathArray, OnCompletable, ApiError, ApiErrorConstructor, UuidFunction, Country, LocaleResult };
