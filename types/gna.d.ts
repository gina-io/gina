/**
 * Gina Framework — Explicit exports
 *
 * Type declarations for `require('gina/gna')`.
 * Provides named imports for all global helpers, enabling IDE navigation
 * and static analysis without relying on global scope injection.
 *
 * Usage:
 *   const { getContext, _, onCompleteCall, uuid } = require('gina/gna');
 */

import type { UuidFunction } from './globals';
import type { SuperController, EntitySuper } from './index';

interface GinaExports {
    // Context helpers
    setContext: typeof globalThis.setContext;
    getContext: typeof globalThis.getContext;
    resetContext: typeof globalThis.resetContext;
    getConfig: typeof globalThis.getConfig;
    getLib: typeof globalThis.getLib;
    whisper: typeof globalThis.whisper;
    define: typeof globalThis.define;
    getDefined: typeof globalThis.getDefined;

    // Path helpers
    _: typeof globalThis._;
    setPath: typeof globalThis.setPath;
    getPath: typeof globalThis.getPath;
    setPaths: typeof globalThis.setPaths;
    getPaths: typeof globalThis.getPaths;
    onCompleteCall: typeof globalThis.onCompleteCall;

    // Model helpers
    getModel: typeof globalThis.getModel;
    getModelEntity: typeof globalThis.getModelEntity;

    // JSON helper
    requireJSON: typeof globalThis.requireJSON;

    // Task helper
    run: typeof globalThis.run;

    // Env helpers
    getUserHome: typeof globalThis.getUserHome;
    getEnvVar: typeof globalThis.getEnvVar;
    getEnvVars: typeof globalThis.getEnvVars;
    setEnvVar: typeof globalThis.setEnvVar;
    getLogDir: typeof globalThis.getLogDir;
    getRunDir: typeof globalThis.getRunDir;
    getTmpDir: typeof globalThis.getTmpDir;
    parseTimeout: typeof globalThis.parseTimeout;
    isWin32: typeof globalThis.isWin32;

    // Classes
    SuperController: typeof SuperController;
    EntitySuper: typeof EntitySuper;

    // uuid
    uuid: UuidFunction;

    // ApiError
    ApiError: typeof globalThis.ApiError;
}

declare const ginaExports: GinaExports;
export = ginaExports;
