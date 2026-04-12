/**
 * Gina — Explicit exports for global helpers
 *
 * Usage:
 *   const { getContext, _, onCompleteCall } = require('gina/gna');
 *
 * All symbols are also available as globals at runtime (no import required).
 * This module provides explicit exports so IDEs can navigate to definitions
 * and static analysis tools can verify usage.
 *
 * Getters are used so that symbols resolve at access time (after framework boot),
 * not at require() time.
 */

'use strict';

// Framework core — the main gna module (lifecycle hooks, lib, etc.)
var _gna = require('./framework/v0.3.3/core/gna');

// SuperController and EntitySuper — loaded from their source modules
var SuperController = require('./framework/v0.3.3/core/controller');
var EntitySuper     = require('./framework/v0.3.3/core/model/entity');

// uuid — from the lib registry
var uuid = require('./framework/v0.3.3/lib/uuid');

module.exports = {

    // ── Context helpers ──────────────────────────────────────────────────

    get setContext()   { return global.setContext; },
    get getContext()   { return global.getContext; },
    get resetContext() { return global.resetContext; },
    get getConfig()    { return global.getConfig; },
    get getLib()       { return global.getLib; },
    get whisper()      { return global.whisper; },
    get define()       { return global.define; },
    get getDefined()   { return global.getDefined; },

    // ── Path helpers ─────────────────────────────────────────────────────

    get _()               { return global._; },
    get setPath()         { return global.setPath; },
    get getPath()         { return global.getPath; },
    get setPaths()        { return global.setPaths; },
    get getPaths()        { return global.getPaths; },
    get onCompleteCall()  { return global.onCompleteCall; },

    // ── Model helpers ────────────────────────────────────────────────────

    get getModel()       { return global.getModel; },
    get getModelEntity() { return global.getModelEntity; },

    // ── JSON helper ──────────────────────────────────────────────────────

    get requireJSON() { return global.requireJSON; },

    // ── Task helper ──────────────────────────────────────────────────────

    get run() { return global.run; },

    // ── Env helpers ──────────────────────────────────────────────────────

    get getUserHome()  { return global.getUserHome; },
    get getEnvVar()    { return global.getEnvVar; },
    get getEnvVars()   { return global.getEnvVars; },
    get setEnvVar()    { return global.setEnvVar; },
    get getLogDir()    { return global.getLogDir; },
    get getRunDir()    { return global.getRunDir; },
    get getTmpDir()    { return global.getTmpDir; },
    get parseTimeout() { return global.parseTimeout; },
    get isWin32()      { return global.isWin32; },

    // ── Classes ──────────────────────────────────────────────────────────

    SuperController: SuperController,
    EntitySuper:     EntitySuper,

    // ── uuid ─────────────────────────────────────────────────────────────

    uuid: uuid,

    // ── ApiError ─────────────────────────────────────────────────────────

    get ApiError() { return global.ApiError; }
};
