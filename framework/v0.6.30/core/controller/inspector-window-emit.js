"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module core/controller/inspector-window-emit
 *
 * #INS10 follow-up — prod-window egress for server-rendered HTML pages.
 *
 * During an instrumentation window (`process.gina._inspectorWindowUntil >
 * Date.now()`) outside dev mode, a server-rendered HTML page's own captured
 * controller queries (`local._queryLog`) and flow timeline (`local._timeline`)
 * must reach the authenticated `/_gina/agent` SSE — but the existing
 * `inspector#data` emit in `controller.render-swig.js` /
 * `controller.render-nunjucks.js` lives inside a dev-only block entangled with
 * `window.__ginaData` script injection and the `</body>` rewrite, so its gate
 * cannot simply be broadened without running dev-path HTML mutation on prod
 * cached renders.
 *
 * This helper is the separate, HTML-free emit path. It mirrors the render-json
 * v1 emit (`controller.render-json.js:253-323`): build an environment block
 * from `getContext('gina')` + `local.options.conf`, attach the captured query
 * log and flow timeline, redact via `lib/inspector-redact`, stash the redacted
 * payload on `self.serverInstance._lastGinaData`, and
 * `process.emit('inspector#data', payload)`. It touches NO HTML and never
 * mutates the response body — egress is the already-window-aware SSE handlers
 * (`server.js` / `server.isaac.js`).
 *
 * Callers gate it on `<window-open> && !self.isCacheless()` so it is mutually
 * exclusive with every dev-only injection block (all of which require
 * `isCacheless()` / `displayInspector === true`) — no double emit, no prod
 * HTML mutation. See the call sites in `controller.render-swig.js`
 * (cache-hit + cache-miss) and `controller.render-nunjucks.js`.
 *
 * Payload scope is deliberately minimal — `environment` + `queries` + `flow`,
 * with NO `user.data` (unlike render-json, which carries the JSON response as
 * `data`). An HTML page's server-side story is its queries + flow; the template
 * context is not streamed, keeping the on-wire sensitive surface minimal — the
 * channel's instrument-key auth, not redaction, is the protection for the raw
 * query text. Like render-json, it does NOT write `_lastGinaDataUnredacted`
 * (a prod window is never `local` scope, so no unredacted snapshot is retained).
 */

// Relative require (not the bare `lib/inspector-redact` form the delegates use)
// so this module resolves without depending on the gna.js NODE_PATH bootstrap —
// keeps it require()-able standalone in unit tests. Resolves to the same module
// instance as the bare form (Node caches by resolved path).
var inspectorRedact = require('../../lib/inspector-redact');

/**
 * Build and emit the redacted Inspector payload for an HTML page render during
 * a prod instrumentation window. No-op-safe: any failure is swallowed so an
 * Inspector-side bug can never break the response.
 *
 * Reads the per-request capture buffers off `local` (`_queryLog`, `_timeline`)
 * — the caller is responsible for ensuring they belong to the current request
 * (they are aliased onto `local` by `controller.js setOptions()` under the same
 * window/dev gate that drives this emit).
 *
 * @param {object} self  - SuperController instance (provides `serverInstance`
 *                          and `isCacheless`).
 * @param {object} local - Per-request controller closure (provides
 *                          `options.conf`, `_queryLog`, `_timeline`).
 * @returns {void}
 *
 * @example
 * // controller.render-swig.js / controller.render-nunjucks.js, after the
 * // path's response-write/total timeline entries are pushed:
 * if ((process.gina && process.gina._inspectorWindowUntil > Date.now())
 *     && !self.isCacheless()) {
 *     emitInspectorWindowData(self, local);
 * }
 */
function emitInspectorWindowData(self, local) {
    try {
        if (!self || !self.serverInstance || !local || !local.options) {
            return;
        }
        var _ctx  = (typeof getContext === 'function' && getContext('gina')) || {};
        var _conf = local.options.conf || {};
        var _mem  = process.memoryUsage();
        var _gpid = (typeof getEnvVar === 'function' && getEnvVar('GINA_PID')) || String(process.pid);
        // Environment block — identical key set to render-json.js:256-274 so the
        // Inspector Environment tab renders the same fields for HTML and JSON.
        var _env = {
            'gina'            : _ctx.version || '',
            'gina pid'        : _gpid,
            'nodejs'          : process.versions.node + ' ' + process.platform + ' ' + process.arch,
            'engine'          : (_conf.server && _conf.server.engine) || '',
            'env'             : process.env.NODE_ENV || '',
            'envIsDev'        : self.isCacheless(),
            'scope'           : process.env.NODE_SCOPE || '',
            'bundle'          : _conf.bundle || '',
            'project'         : _conf.projectName || '',
            'protocol'        : (_conf.server && _conf.server.protocol) || '',
            'scheme'          : (_conf.server && _conf.server.scheme) || '',
            'port'            : (_conf.server && _conf.server.port) || '',
            'webroot'         : (_conf.server && _conf.server.webroot) || '',
            'memory heap'     : (_mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
            'memory allocated': (require('v8').getHeapStatistics().heap_size_limit / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
            'date.now'        : new Date().toISOString(),
            'pid'             : process.pid
        };
        // Minimal payload — environment + queries + flow only (NO user.data).
        var _gdUser = { environment: _env };
        if (local._queryLog && local._queryLog.length > 0) {
            _gdUser.queries = local._queryLog;
        }
        // #AISTREAM — AI token-stream snapshot alongside queries/flow.
        if (local._aiLog && local._aiLog.length > 0) {
            _gdUser.aiStream = local._aiLog;
        }
        // #EVTBUS — observable application-event snapshot alongside queries/flow.
        if (local._eventLog && local._eventLog.length > 0) {
            _gdUser.events = local._eventLog;
        }
        if (local._timeline) {
            _gdUser.flow = {
                requestStart : local._timeline.requestStart,
                entries      : local._timeline.entries
            };
        }
        var _redactConf = inspectorRedact.getConfig(_conf);
        // #INS8 — standalone Inspector URL (settings.json > inspector.url), or null.
        var _inspUrl = null;
        try {
            if (_conf.content && _conf.content.settings
                && _conf.content.settings.inspector
                && _conf.content.settings.inspector.url) {
                _inspUrl = _conf.content.settings.inspector.url;
            }
        } catch (e) { /* leave null */ }
        var __gdPayload = {
            gina : {
                environment     : _env,
                inspectorRedact : {
                    patterns    : _redactConf.patterns,
                    types       : _redactConf.types,
                    replacement : _redactConf.replacement
                },
                inspectorUrl : _inspUrl
            },
            user : _gdUser
        };
        // #R7 — redact secret-NAMED fields before the payload reaches any sink.
        // Like render-json, do NOT write _lastGinaDataUnredacted: a prod window
        // is never `local` scope, so no unredacted snapshot is ever retained.
        __gdPayload = inspectorRedact.redact(__gdPayload, {
            compiledPatterns : _redactConf.compiledPatterns,
            replacement      : _redactConf.replacement
        });
        self.serverInstance._lastGinaData = __gdPayload;
        process.emit('inspector#data', __gdPayload);
    } catch (e) {
        // Never let an Inspector-side failure break the render.
        try { console.warn('[inspector-window-emit] skipped: ' + (e.message || e)); } catch (e2) { /* noop */ }
    }
}

module.exports = emitInspectorWindowData;
