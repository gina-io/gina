/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var lib             = require('gina').lib;

// #B440 — per-call identity for emit-style entity methods (2026-08-30).
//
// Both dispatch paths below (the util.promisify fast-path and Option B) queue one
// resolver per in-flight call and, before #B440, paired each `<shortName>#<method>`
// emit to the OLDEST queued resolver. Arrival order carries no call identity: a call
// that never emits (a throw inside an un-awaited async callback is the canonical
// shape — swallowed, only `unhandledRejection` sees it) left its resolver at the
// head forever, and from then on every caller of that method received the NEXT
// caller's record while the last one hung. Every wrapped call now runs inside a
// per-process AsyncLocalStorage store `{ e, r }` (trigger name + this call's
// resolver), so an emit fired from ANY async continuation of the call — callback,
// promise, timer, I/O — is paired to the call that made it. Arrival order remains
// only as the fallback for a completion that reaches the entity outside every
// call's async context (e.g. a native driver invoking callbacks from a loop started
// at boot), and that fallback is logged at debug level.

/**
 * Per-call identity store, one per process and shared by every entity generation
 * (dev-mode hot-reload re-requires this module; a store created per generation
 * would lose the calls still in flight across the reload).
 *
 * @private
 * @constant
 * @type {AsyncLocalStorage}
 */
var _callALS = (function () {
    if (typeof process.gina == 'undefined') process.gina = {};
    if (!process.gina._entityCallALS) process.gina._entityCallALS = new (require('async_hooks').AsyncLocalStorage)();
    return process.gina._entityCallALS;
})();

/**
 * Dequeues the resolver an emit belongs to (#B440).
 *
 * - The active store names THIS trigger: splice that call's own resolver out of the
 *   queue — or, when that call has already settled (bounded wait, Promise path),
 *   DROP the late completion: it is never handed to whoever is at the head.
 * - No active store, or a store for another trigger: arrival order (`shift()`), the
 *   pre-#B440 pairing, logged at debug so a consumer can see the fallback happen in
 *   their own logs.
 *
 * @private
 * @param {Array<function>} q - the trigger's FIFO of pending resolvers
 * @param {string} e - trigger name (`<shortName>#<method>`)
 * @returns {function|null} the resolver to deliver to, or `null` when the emit is dropped
 */
var _dequeueByIdentity = function (q, e) {
    var st = _callALS.getStore();
    if (st && st.e === e) {
        var idx = q ? q.indexOf(st.r) : -1;
        return idx > -1 ? q.splice(idx, 1)[0] : null;
    }
    if (q && q.length) { console.debug('[ MODEL ][ ENTITY ] DISPATCH:NO_CONTEXT ' + e + ' (completion reached the entity outside the call\'s async context; pairing by arrival order)'); }
    return q ? q.shift() : null;
};

/**
 * Removes a settled call's resolver from its trigger's queue, so a completion that
 * arrives after the call settled cannot be paired with it (#B440).
 *
 * @private
 * @param {EntitySuper} entity - the entity carrying the `_callbacks` queues
 * @param {string} e - trigger name
 * @param {function} r - the resolver to forget
 * @returns {void}
 */
var _forget = function (entity, e, r) {
    var q = entity._callbacks[e]; if (!Array.isArray(q)) return;
    var i = q.indexOf(r); if (i > -1) q.splice(i, 1);
};
var console         = lib.logger;
var helpers         = lib.helpers;
var inherits        = lib.inherits;
var merge           = lib.merge;
var modelUtil       = new lib.Model();

/**
 * @class EntitySuper
 * @constructor
 * @this {EntitySuper}
 * @extends EventEmitter
 *
 * Base class for all Gina model entities. Automatically discovers entity methods
 * that emit named events (`shortName#methodName`) and wraps them with
 * `.onComplete(cb)` listener support and optional Promise-style usage.
 *
 * Entity method event naming convention: `entityShortName#methodName`
 * E.g. a `UserEntity` method `findById` → event `user#findById`
 *
 * @param {object} conn     - Database connection object from the connector
 * @param {string} [caller] - Name of the calling context (used for debugging)
 * @param {object} [injected] - Optional dependency overrides for unit testing (#R3).
 *   When present, the injected values replace the live connector and config lookup
 *   so entities can be exercised without a running database or framework server.
 * @param {function} [injected.config] - Replacement for `getConfig(bundle, confName)`.
 *   Called with the same `(bundle, confName)` signature; return value is used as-is.
 * @param {object} [injected.connector] - Replacement connection object returned by
 *   `this.getConnection()`. Use a mock/spy to simulate database operations.
 *
 * @package     Gina
 * @namespace   Gina.Model
 * @author      Rhinostone <contact@gina.io>
 * @api         Public
 */
function EntitySuper(conn, caller, injected) {

    this.initialized    = false;
    this._maxListeners  = 50;
    this._methods       = [];
    this._relations     = {};
    this._injected      = injected || null;

    var local           = {}
    var self            = this;
    var caller          = caller || undefined;
    var isCacheless     = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;

    var init = function(conn, caller) {

        local.conn = conn;

        if (!EntitySuper[self.name]) {
            EntitySuper[self.name] = {}
        }

        if ( !EntitySuper[self.name]._conn ) {
            EntitySuper[self.name]._conn = conn;
        }

        if ( !EntitySuper[self.name].instance ) {
            return setListeners(caller)
        } else {
            return EntitySuper[self.name].instance
        }
    }


    /**
     * Scan the entity for event-emitting methods and wire up `once` + `.onComplete(cb)` listeners.
     * Skips entities that set `hasOwnEvents = true`.
     *
     * @inner
     * @param {string} [caller] - Calling context name (debug only)
     * @returns {EntitySuper|false} self, or `false` when `hasOwnEvents` is set
     */
    var setListeners = function(caller) {

        var entityName  = self.name.substring(0, 1).toLowerCase() + self.name.substring(1);
        var shortName   = self.name.replace(/Entity/, '');
        shortName       = shortName.substring(0, 1).toLowerCase() + shortName.substring(1);

        var entity      = null;

        if ( EntitySuper[self.name].initialized ) {

            self.initialized = EntitySuper[self.name].initialized;
            entity = self

        } else {
            EntitySuper[self.name].initialized = true;
            entity = self.getEntity(self.name)
        }



        var eventName = '';
        for (var prop in entity) {
            eventName = shortName +'#'+ prop;
            if (self._methods.indexOf(prop) < 0 && typeof(entity[prop]) == 'function' && new RegExp('(' + eventName + '\'|' + eventName + '\"|' + eventName + '$)').test(entity[prop].toString()) ) {
                self._methods.push(prop)
            }
        }

        // use this property inside your entity to disable listeners
        if ( typeof(entity.hasOwnEvents) != 'undefined' && entity.hasOwnEvents ) return false;

        var events = []
            , triggers = []
            , i = 0
            , cb = {}
            , methods = self._methods;


        for (var m = 0, mLen = methods.length; m < mLen; ++m) {
            if (
                typeof(entity[methods[m]]) == 'function'
                && m != 'onComplete'
            ) {

                if ( triggers.indexOf(shortName + '#' + methods[m]) < 0 ) {
                    events[i] = {
                        index: i,
                        shortName: shortName + '#' + methods[m],
                        method: methods[m],
                        entityName: entityName
                    };


                    triggers.push(shortName + '#' + methods[m]);

                    ++i;
                }
            }
        }

        entity._listeners = events;
        entity._triggers = triggers;
        entity._callbacks = {};
        // #B440 — opt-in bound on a call that never signals completion:
        // settings.json > model.emitTimeout (ms). Absent or 0: no bound — a genuinely
        // dead call waits forever, exactly as before, because a fixed default would
        // fail legitimately slow bulk operations. Read once per entity, at wrap time.
        if (typeof(entity._emitTimeout) == 'undefined') {
            entity._emitTimeout = 0;
            try {
                var _st = self.getConfig(self.bundle, 'settings');
                var _et = (_st && _st.model) ? Number(_st.model.emitTimeout) : 0;
                if (_et > 0) { entity._emitTimeout = Math.min(Math.floor(_et), 2147483647); }
            } catch (_cfgErr) {}
        }
        entity._maxListeners += i; // default max listeners is 10
        entity.setMaxListeners(entity._maxListeners || 50);
        //console.debug('['+self.name+'] setting max listeners to: ' + (entity.maxListeners || eCount) );

        var f           = null
            , fSource   = '';

        for (var i = 0; i < events.length; ++i) {

            entity.removeAllListeners(events[i].shortName); // added to prevent adding new listners on each new querie
            //console.debug('placing event: '+ events[i].shortName +'\n');
            f       = events[i].method;
            fSource = entity[f].toString();

            // only if method content is about the event
            if (methods.indexOf(f) > -1 && new RegExp('(' + events[i].shortName + '\'|' + events[i].shortName + '\"|' + events[i].shortName + '$)').test(fSource)) {

                // CRUD | model's methods, for the n1ql, look into connector/<connectorName>/index.js
                entity[f] = (function onEntityEvent(e, m, i, source) {

                    var cached      = entity[m];

                    var variables   = source.match(/\((.*)\)/g)[0];
                    var args        = [];

                    if (variables.length) {
                        variables = variables.replace(/\(|\)/g, '').replace(/\s*/g, '');
                        if (variables) args = variables.split(/\,/g);
                    }
                    // TODO - retrieve argument while the method is being rewritten
                    return function () {

                        // #entity-dev-nocache: in dev mode, clear any buffered result for
                        // this trigger so each call gets a fresh listener.  Prevents stale
                        // null results from a concurrent-call race (DISPATCH:PREEMPTIVE_BUFFER) from
                        // poisoning subsequent requests for the entity lifetime.
                        // Mirrors the controller cacheless-require pattern for dev mode.
                        if (isCacheless && entity._arguments && typeof(entity._arguments[e]) !== 'undefined') {
                            delete entity._arguments[e];
                        }

                        // retrieving local arguments, & binding it to the event callback

                        /**
                         * handle promises with async/await
                         *
                         * NB.: Always use the prefix `db` inside an entity file
                         *      instead of using `this.getRelation(entityName)`
                         *
                         * e.g.:
                         *  var recordJob   = promisify(db.jobEntity.insert);
                         *  await recordJob(jobObj)
                         *      .then( function onJob(_jobObj) {
                         *          jobObj = _jobObj;
                         *      })
                         *      .catch( function onJobErr(_err) {
                         *          jobErr = _err;
                         *      });
                         *
                         */
                        if ( typeof(this[m]) == 'undefined' && typeof(arguments[arguments.length-1]) == 'function' ) {

                            var promise = function() {
                                var cb = arguments[arguments.length-1];

                                if (entity._triggers.indexOf(events[i].shortName) > -1) {
                                    console.debug('[ MODEL ][ ENTITY ] Setting promise listener for: [ ' + self.model + '/' + events[i].entityName + '::' + events[i].shortName + ' ]');

                                    // #M2 — queue check: buffer is now an array; treat missing/empty as "no buffer".
                                    if (!entity._arguments || !entity._arguments[events[i].shortName] || entity._arguments[events[i].shortName].length === 0) {

                                        // #B394 — FIFO parity with the Option B path below (2026-08-19).
                                        //
                                        // The fast-path used to register a SCALAR callback slot
                                        // (`entity._callbacks[shortName] = cb`) plus a per-call `.once`
                                        // guarded on that slot. Under concurrency a second in-flight
                                        // caller OVERWROTE the first's slot: the first result to arrive
                                        // was flushed to the LAST-registered callback (cross-delivery),
                                        // and the displaced caller's `.once` then found its guard false
                                        // and its promise NEVER settled (starvation — a hung request
                                        // with nothing logged). Option B (entity-context calls) already
                                        // fixed this with a FIFO queue + a single persistent dispatch
                                        // listener (#M2); the fast-path kept the scalar because its own
                                        // comment claimed it "bypasses queue". It no longer does.
                                        //
                                        // Push this invocation's callback onto the FIFO instead of
                                        // overwriting, and register ONE persistent `.on` dispatcher
                                        // (only when none is active) that shifts the OLDEST callback per
                                        // emit and removes itself when the queue drains — the exact
                                        // `_onQueueEmit` shape Option B uses further down. Concurrent
                                        // callers now each receive a result in arrival order, and none
                                        // can be orphaned.
                                        //
                                        // #B440 (2026-08-30) — the residual this left (OUT-OF-order
                                        // completion swapping results, and one LOST emit permanently
                                        // desynchronising the queue) is closed: each call runs inside
                                        // its own `_callALS` store and the dispatcher pairs an emit to
                                        // the call it came from (`_dequeueByIdentity`); arrival order
                                        // is only the fallback for a completion reaching the entity
                                        // outside every call's async context. A method that RETURNS a
                                        // Promise is chained on here too (`_fpInner.then()` below),
                                        // exactly as Option B always did with `_innerResult`.
                                        var _fpShortName = events[i].shortName;
                                        if ( !Array.isArray(entity._callbacks[_fpShortName]) ) {
                                            entity._callbacks[_fpShortName] = [];
                                        }
                                        // #B440 — one guarded deliverer per call: settles at most once,
                                        // forgets itself, clears the bound, and runs the caller's callback
                                        // inside the store that was active when the call was made — so an
                                        // entity method that calls another entity's method with a direct
                                        // callback and emits its own completion from inside it still
                                        // pairs by identity (measured: without this, that chain fell back
                                        // to arrival order).
                                        var _fpDone = false, _fpOuter = _callALS.getStore();
                                        var _fpDeliver = function () {
                                            if (_fpDone) return; _fpDone = true;
                                            _forget(entity, _fpShortName, _fpDeliver);
                                            if (_fpTimer) clearTimeout(_fpTimer);
                                            var _dSelf = this, _dArgs = arguments;
                                            if (_fpOuter) { _callALS.run(_fpOuter, function () { cb.apply(_dSelf, _dArgs); }); } else { cb.apply(this, arguments); }
                                        };
                                        var _fpTimer = null;
                                        if (entity._emitTimeout > 0) {
                                            _fpTimer = setTimeout(function () { var _msg = '[ MODEL ][ ENTITY ] ' + _fpShortName + ': no completion signal within ' + entity._emitTimeout + ' ms — the method neither emitted nor returned a settled Promise (#B440)'; console.warn(_msg); _fpDeliver(new Error(_msg)); }, entity._emitTimeout);
                                            _fpTimer.unref();
                                        }
                                        promise._b440 = { e: _fpShortName, r: _fpDeliver };
                                        entity._callbacks[_fpShortName].push(_fpDeliver);

                                        // The custom emit routes an ARRAY slot straight to native emit
                                        // (its third guard skips setListener when `!Array.isArray`), so
                                        // this `.on` listener receives the emit arguments directly.
                                        if ( entity.listenerCount(_fpShortName) === 0 ) {
                                            // #B395 — these DISPATCH:* dispatch diagnostics use console.debug,
                                            // NOT console.log, and the distinction is load-bearing: in gina
                                            // console.log is the logger's raw `process.stdout.write` path, which
                                            // bypasses container dispatch (file/mq) AND the level gate, while a
                                            // daemon-spawned bundle's stdout is filtered by lib/cmd/bundle/start.js
                                            // — so as console.log they reached neither the bundle log nor docker
                                            // logs, and only flooded a foreground boot. Levelled, they are off by
                                            // default and appear when a consumer raises the hierarchy to debug.
                                            var _onFpQueueEmit = function onFpQueueEmit() {
                                                var _q = entity._callbacks[_fpShortName];
                                                if ( !_q || _q.length === 0 ) { return; }
                                                var _fn = _dequeueByIdentity(_q, _fpShortName);
                                                if (!_fn) { return; }
                                                console.debug('[ MODEL ][ ENTITY ] DISPATCH:CALLBACK_FLUSH ' + _fpShortName);
                                                _fn.apply(this, arguments);
                                                if ( !entity._callbacks[_fpShortName] || entity._callbacks[_fpShortName].length === 0 ) {
                                                    delete entity._callbacks[_fpShortName];
                                                    entity.removeListener(_fpShortName, _onFpQueueEmit);
                                                }
                                            };
                                            entity.on(_fpShortName, _onFpQueueEmit);
                                        }
                                    } else { // in case the event is not ready yet
                                        console.debug('[ MODEL ][ ENTITY ] DISPATCH:BUFFER_CALLBACK ' + events[i].shortName);
                                        // #M2 — queue consume: shift oldest buffered result so concurrent
                                        // callers each receive their own result, not a shared stale one.
                                        var _firing2Args = entity._arguments[events[i].shortName].shift();
                                        if (entity._arguments[events[i].shortName].length === 0) {
                                            delete entity._arguments[events[i].shortName];
                                        }
                                        cb.apply(entity[m], _firing2Args);
                                    }
                                }
                            }

                            promise.apply(null, arguments);
                            // #B440 — run the call inside its own identity store, and chain on a
                            // returned Promise as Option B does (the fast-path used to discard it).
                            var _fpArgs = arguments;
                            var _fpInner = promise._b440 ? _callALS.run(promise._b440, function () { return cached.apply(promise, _fpArgs); }) : cached.apply(promise, arguments);
                            if (_fpInner && typeof(_fpInner.then) === 'function' && promise._b440) {
                                _fpInner.then(function (data) { promise._b440.r(null, data); }, function (err) { promise._b440.r(err); });
                            }
                            return promise;
                        } //else is normal case

                        // ─────────────────────────────────────────────────────────
                        // Option B — native Promise return (2026-03-20)
                        //
                        // Why: JS entity methods previously returned `this[m]`
                        //   (the entity function, with .onComplete attached as a
                        //   property). This was not directly awaitable without first
                        //   wrapping in util.promisify — which itself only worked
                        //   because of the separate fast-path above (lines 192-229)
                        //   that detects a trailing-function argument and a missing
                        //   `this[m]` context. Easy to miss, fragile under refactors.
                        //
                        // What changed: we now return a native Promise. The once-
                        //   listener is registered BEFORE calling cached() so there
                        //   is no race where a synchronous emit fires before we
                        //   are ready to receive it.
                        //
                        //   `.onComplete(cb)` is attached to the Promise so ALL
                        //   existing callers keep working unchanged:
                        //     entity.method(args).onComplete(function(err, data) {...})
                        //
                        //   entity._callbacks[shortName] is a FIFO queue (array) of
                        //   per-invocation resolvers (#M2).  A single persistent .on
                        //   listener dequeues the oldest resolver on each emit.
                        //
                        // The util.promisify fast-path above (lines 192-229) is
                        //   untouched — it fires when this[m] is undefined (called
                        //   without entity context). This Promise path fires in the
                        //   normal entity-context case.
                        // ─────────────────────────────────────────────────────────

                        var _resolve, _reject;

                        var _promise = new Promise(function(resolve, reject) {
                            _resolve = resolve;
                            _reject  = reject;
                        });

                        if (entity._triggers.indexOf(events[i].shortName) > -1) {

                            // #M5 — defensive clear: delete any stale _arguments entry so
                            // it cannot accumulate across calls.  This is unconditional
                            // (prod + dev) — the dev-mode clear at lines 186-188 only runs
                            // when isCacheless=true.
                            if (entity._arguments && entity._arguments[events[i].shortName]) {
                                delete entity._arguments[events[i].shortName];
                            }

                            // #M5 — _arguments buffer removed from Option B (2026-04-04).
                            //
                            // The _arguments buffer (entity.js:497-509) is populated by
                            // setListener when an emit fires with no in-flight resolver.
                            // In Option B, this never happens:
                            //
                            //   1. Connector methods: connector emits 'N1QL:entity#method'
                            //      (prefixed, lowercase); the buffer .once() listens on
                            //      'entity#method' (different event) — never fires.
                            //
                            //   2. Custom entity methods: _callbacks[e] is an array (pushed
                            //      below) before cached.apply() calls the method.  When the
                            //      method calls entity.emit(type), line 578 checks
                            //      !Array.isArray(_callbacks[type]) — false — so setListener
                            //      is never called and the buffer is never populated.
                            //
                            // Resolution always flows through _innerResult.then() → _resolver
                            // (connector Promise) or the _onQueueEmit dispatch listener
                            // (entity emit).  The _resolved flag prevents double-resolution.
                            //
                            // The promisify fast-path (lines 218-243) retains its own
                            // _arguments check — it runs in a different context.

                            // #M2 — resolver: double-resolution guard replaces the old _callbacks
                            // delete guard. The queue dispatch listener manages _callbacks —
                            // _resolver no longer needs to touch it.
                            //
                            // _innerResult.then() (connector Promise path) and the queue dispatch
                            // listener may both call _resolver; the _resolved flag ensures only
                            // the first call wins.
                            var _resolved = false;
                            var _obTimer = null;
                            var _resolver = function(err, data) {
                                if (_resolved) return;
                                _resolved = true;
                                _forget(entity, e, _resolver);   // #B440
                                if (_obTimer) clearTimeout(_obTimer);
                                if (err) _reject(err);
                                else     _resolve(data);
                            };
                            if (entity._emitTimeout > 0) {   // #B440 — the opt-in bound
                                _obTimer = setTimeout(function () { var _msg = '[ MODEL ][ ENTITY ] ' + e + ': no completion signal within ' + entity._emitTimeout + ' ms — the method neither emitted nor returned a settled Promise (#B440)'; console.warn(_msg); _resolver(new Error(_msg)); }, entity._emitTimeout);
                                _obTimer.unref();
                            }

                            // #M2 — FIFO queue: push this invocation's resolver instead of
                            // overwriting the single _callbacks slot.  removeAllListeners is
                            // removed — it was killing in-flight callers' queue dispatch listener.
                            if (!entity._callbacks[e]) {
                                entity._callbacks[e] = [];
                            }
                            entity._callbacks[e].push(_resolver);

                            // Register a single persistent dispatch listener only when none is
                            // active.  It pairs each emit to the call it came from (#B440,
                            // `_dequeueByIdentity`), falling back to the oldest resolver only for
                            // a completion that carries no call context.
                            if (entity.listenerCount(e) === 0) {
                                var _onQueueEmit = function onQueueEmit() {
                                    var _q = entity._callbacks[e];
                                    if (!_q || _q.length === 0) return;
                                    var _fn = _dequeueByIdentity(_q, e);
                                    if (!_fn) { return; }
                                    _fn.apply(null, arguments);
                                    if (!_q || _q.length === 0) {
                                        delete entity._callbacks[e];
                                        entity.removeListener(e, _onQueueEmit);
                                    }
                                };
                                entity.on(e, _onQueueEmit);
                            }
                        }

                        // #B440 — run the call inside its own identity store (only when a
                        // resolver exists, i.e. the trigger is registered for this method).
                        var _obArgs = arguments, _obThis = this[m];
                        var _innerResult = (typeof _resolver === 'function') ? _callALS.run({ e: e, r: _resolver }, function () { return cached.apply(_obThis, _obArgs); }) : cached.apply(this[m], arguments);

                        // If the underlying method returns a Promise (connector Option B
                        // with _mainCallback=null, or async custom entity methods), chain
                        // on it so that _promise resolves/rejects when the inner operation
                        // completes.
                        //
                        // Without this, _promise only resolves when
                        // entity.emit('entity#method') fires. Connector N1QL methods resolve
                        // via 'N1QL:entity#method' (different event), so entity.emit() is
                        // never called for them — _promise would hang forever.
                        //
                        // _resolver guards against double-resolution via the _resolved flag (#M2).
                        // The queue dispatch listener and _innerResult.then() may both call it;
                        // the flag ensures only the first call wins.
                        //
                        // Additional guard: _resolver is only defined when shortName is in
                        // entity._triggers (lines 268+). If the method returns a Promise
                        // but its shortName is NOT in _triggers, _resolver is undefined
                        // (var hoisted but not assigned). Without this check, the .then()
                        // callback fires later and throws "TypeError: _resolver is not a function"
                        // as an uncaughtException that corrupts the event loop.
                        if (_innerResult && typeof(_innerResult.then) === 'function') {
                            _innerResult.then(
                                function(data) {
                                    if (typeof _resolver === 'function') _resolver(null, data);
                                },
                                function(err) {
                                    if (typeof _resolver === 'function') _resolver(err);
                                }
                            );
                        }

                        // Backward-compatible .onComplete(cb):
                        //   chains on the Promise resolution so the callback
                        //   receives (err, data) exactly as before.
                        _promise.onComplete = function(cb) {
                            _promise.then(
                                function(data) { cb(null, data); },
                                function(err)  { cb(err); }
                            );
                            return _promise; // preserve chaining
                        };

                        return _promise; // was: return this[m]
                    };

                }(events[i].shortName, f, i, fSource));

            }
        }


        if (!/Entity$/.test(entityName)) {
            entityName = entityName + 'Entity'
        }

        if (caller) {
            if ( !EntitySuper[caller].instance ) {
                EntitySuper[caller].instance = {
                    _relations: {}
                }
            }

        } else {
            if ( !EntitySuper[self.name].instance ) {
                EntitySuper[self.name].instance = {
                    _relations: {}
                }
            }
        }

        if (caller) {
            EntitySuper[caller].instance._relations[entity.name] = merge(EntitySuper[caller].instance._relations[entity.name], entity);
            modelUtil.updateModel(self.bundle, self.model, entityName, EntitySuper[caller].instance._relations[entity.name] );

            self._relations[entity.name] = EntitySuper[caller].instance._relations[entity.name];

            return EntitySuper[caller].instance._relations[entity.name]
        } else {
            modelUtil.updateModel(self.bundle, self.model, entityName, entity);
            EntitySuper[self.name].instance = entity;

            return EntitySuper[self.name].instance
        }
    }

    var setListener = function() {
        // Bun/JSC rejects assigning to `arguments` outright ("Invalid assignment
        // target"), where V8 permits it in sloppy mode. `_args` carries what the
        // reassignment used to put in `arguments` — but ONLY this scope's own reads
        // are rewritten: the `arguments` inside the nested `.on(evt, function(){...})`
        // callbacks below refer to each CALLBACK's own arguments and must stay as-is.
        var _args = arguments[0];

        var args = Array.prototype.slice.call(_args);
        var trigger = args.splice(0, 1)[0];

        if ( !/\#/.test(trigger) ) {
            throw new Error('trigger name not properly set: use `#` between the entity name and the method reference');
            process.exit(1)
        } else {
            if ( self._triggers.indexOf(trigger) < 0 ) {
                self._triggers.push(trigger);

                // Cap to prevent unbounded growth if numbered variants accumulate (e.g. in loop/recursive emit patterns).
                var ENTITY_MAX_LISTENERS = 100;
                self._maxListeners = Math.min(self._maxListeners + 1, ENTITY_MAX_LISTENERS);
                self.setMaxListeners(self._maxListeners);

                var alias       = trigger.split(/\#/)[1]
                    , method    = alias.replace(/[0-9]/g, '')
                    , events    = null
                    , i         = 0
                    ;

                self._listeners.push({
                    shortName   : trigger,
                    method      : method,
                    entityName  : self.name
                });

                events  = self._listeners;
                i       = events.length-1;

                if ( self._triggers.indexOf(events[i].shortName) > -1 ) {
                    // reusable event
                    self
                        //.off(events[i].shortName, function(){ delete self._callbacks[trigger]; })
                        .on(events[i].shortName, function () {
                            console.debug('[ MODEL ][ ENTITY ] DISPATCH:ALIAS_TRIGGER ' + trigger);
                            this._callbacks[trigger.replace(/[0-9]/g, '')].apply(this[method], arguments);
                            delete self._callbacks[trigger];
                        })
                }

            } else {
                if ( typeof(self._callbacks[trigger]) != 'undefined' ) {
                    console.debug('[ MODEL ][ ENTITY ] DISPATCH:CALLBACK_FLUSH ' + trigger);
                    self._callbacks[trigger].apply(this, args);
                    delete self._callbacks[trigger];
                } else {
                    self
                        // .off(trigger, function(){
                        //     if (!this._arguments) {
                        //         this._arguments = {}
                        //     }

                        //     if ( typeof(this._arguments[trigger]) != 'undefined' ) {
                        //         delete this._arguments[trigger];
                        //     }
                        // })
                        .once(trigger, function () {// buffers an emit that arrives before its listener is attached
                            if (!this._arguments) {
                                this._arguments = {}
                            }

                            // #M2 — queue mode: push to array so each concurrent caller consumes
                            // its own buffered result instead of sharing a single scalar slot.
                            // Before: scalar assignment silently dropped every emit after the first.
                            if (!this._arguments[trigger]) {
                                this._arguments[trigger] = [];
                            }
                            console.debug('[ MODEL ][ ENTITY ] DISPATCH:PREEMPTIVE_BUFFER ' + trigger);
                            this._arguments[trigger].push(arguments);

                        })
                }
            }
        }
    }


    var arrayClone = function(arr, i) {
        var copy = new Array(i);
        while (i--)
            copy[i] = arr[i];
        return copy;
    }

    var emitOne = function(handler, isFn, self, arg1) {
        if (isFn)
            handler.call(self, arg1);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1);
        }
    }
    var emitTwo = function(handler, isFn, self, arg1, arg2) {
        if (isFn)
            handler.call(self, arg1, arg2);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1, arg2);
        }
    }
    var emitThree = function(handler, isFn, self, arg1, arg2, arg3) {
        if (isFn)
            handler.call(self, arg1, arg2, arg3);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].call(self, arg1, arg2, arg3);
        }
    }

    var emitMany = function(handler, isFn, self, args) {
        if (isFn)
            handler.apply(self, args);
        else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
                listeners[i].apply(self, args);
        }
    }

    /**
     * custom emit based on node.js emit source
     * Added on 2016-02-09
     * */
    this.emit = function emit(type) {
        // BO Added to handle trigger with increment when `emit occurs whithin a loop or recursive function
        if (
            self._triggers && self._triggers.indexOf(type) == -1 && self._triggers.indexOf(type.replace(/[0-9]/g, '')) > -1
            || self._triggers && self._triggers.indexOf(type) > -1 && typeof(self._callbacks[type]) == 'undefined' && typeof(self._events[type]) == 'undefined'
            // #M2 — skip DISPATCH:CALLBACK_FLUSH for queue mode (_callbacks is an array);
            // the persistent .on dispatch listener handles routing in that case.
            || self._triggers && self._triggers.indexOf(type) > -1 && typeof(self._callbacks[type]) != 'undefined' && !Array.isArray(self._callbacks[type])
        ) {
            setListener(arguments)
        }
        // EO Added to handle trigger with increment

        var er, handler, len, args, i, events, domain;
        var needDomainExit = false;
        var doError = (type === 'error');

        // #EVTBUS Slice 2a — bridge a whitelisted entity trigger onto the live
        // Inspector event signal. Default topics [] → no-op (zero overhead); the
        // allow-list IS the flood control, so this is inert unless an operator
        // opts in. 'error' is EventEmitter control, never an app event. Ships a
        // framework-controlled shape summary ({ok,error}) only — never raw rows.
        if (
            !doError
            && process.gina && process.gina._inspectorEventTopics
            && process.gina._inspectorEventTopics.length
        ) {
            try {
                var _ie = require('lib/inspector-events');
                if (_ie.matchTopics(type, process.gina._inspectorEventTopics)) {
                    var _evErr = arguments[1];
                    _ie.emit(type, { ok: !_evErr, error: (_evErr && _evErr.message) || null }, 'framework');
                }
            } catch (_evBridgeErr) {}
        }

        events = this._events;
        if (events)
            doError = (doError && events.error == null);
        else if (!doError)
            return false;

        domain = this.domain;

        // If there is no 'error' event listener then throw.
        if (doError) {
            er = arguments[1];
            if (domain) {
                if (!er)
                    er = new Error('Uncaught, unspecified "error" event');
                er.domainEmitter = this;
                er.domain = domain;
                er.domainThrown = false;
                domain.emit('error', er);
            } else if (er instanceof Error) {
                throw er; // Unhandled 'error' event
            } else {
                // At least give some kind of context to the user
                var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
                err.context = er;
                throw err;
            }
            return false;
        }

        handler = events[type];

        if (!handler)
            return false;

        if (domain && this !== process) {
            domain.enter();
            needDomainExit = true;
        }

        var isFn = typeof handler === 'function';
        len = arguments.length;
        switch (len) {
            // fast cases
            case 1:
                emitNone(handler, isFn, this);
                break;
            case 2:
                emitOne(handler, isFn, this, arguments[1]);
                break;
            case 3:
                emitTwo(handler, isFn, this, arguments[1], arguments[2]);
                break;
            case 4:
                emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
                break;
            // slower
            default:
                args = new Array(len - 1);
                for (i = 1; i < len; i++)
                    args[i - 1] = arguments[i];
                emitMany(handler, isFn, this, args);
        }

        if (needDomainExit)
            domain.exit();

        return true;
    }


    /**
     * Get connection from entity.
     *
     * When `injected.connector` is set (e.g. in unit tests), that object is
     * returned immediately, bypassing the live Couchbase connection entirely.
     *
     * @param {string} [scope]      - Couchbase scope name (v3+ SDK only)
     * @param {string} [collection] - Couchbase collection name (v3+ SDK only)
     * @returns {object|null} Active connection or mock connector, or null when none
     *
     * @memberof EntitySuper
     */
    this.getConnection = function(scope, collection) {
        // #R3 — injected connector takes priority over the live connection
        if (self._injected && self._injected.connector) {
            return self._injected.connector;
        }

        var conn =  local.conn || self._conn || null;

        if ( typeof(conn) == 'undefined' || !conn) {
            return null;
        }

        if ( typeof(scope) == 'undefined' ) {
            scope = '_default';
        }
        var currentCollection = '_default';
        if ( typeof(collection) != 'undefined' ) {
            currentCollection = collection;
        }


        // retrieve & return the collection
        if ( typeof(conn.scope) != 'undefined' && typeof(conn._scope) == 'undefined' && typeof(conn.scope) != 'undefined' ) {
            var newConn = conn.scope(scope).collection(currentCollection);
            newConn.sdk = conn.sdk;
            return newConn;
        }

        // return the cached collection
        return conn;
    }

    /**
     * Get bundle configuration, routing through `injected.config` when present
     * (#R3). Falls back to the global `getConfig()` helper (which itself checks
     * the R2 `__mock__` override before hitting the real framework config).
     *
     * Entity method body (preferred style going forward):
     * ```javascript
     * var cfg = this.getConfig(this.bundle, 'app');
     * ```
     *
     * Legacy global call still works unchanged:
     * ```javascript
     * var cfg = getConfig(this.bundle, 'app');
     * ```
     *
     * @param {string} [bundle]   - Bundle name; defaults to `this.bundle`
     * @param {string} [confName] - Config key (e.g. `'app'`, `'settings'`)
     * @returns {object|undefined} Configuration object
     *
     * @memberof EntitySuper
     */
    this.getConfig = function(bundle, confName) {
        // #R3 — injected config function takes priority
        if (self._injected && typeof self._injected.config === 'function') {
            return self._injected.config(bundle, confName);
        }
        return getConfig(bundle, confName);
    }

    this.getEntity = function(entity) {

        var ntt = entity;
        entity = entity.substring(0,1).toUpperCase() + entity.substring(1);
        var nttName = entity;

        if ( !/Entity$/.test(entity) ) {
            entity = entity + 'Entity'
        }

        try {
            var callerName = self.name;
            var entityName = entity.replace('Entity', '');

            if (!callerName) {
                throw new Error('no name defined for this Entity !!');
            } else { // imported
                if ( callerName == entity.replace('Entity', '')) {
                    if ( !EntitySuper[self.name].instance ) {
                        return getModelEntity(self.bundle, self.model, entity, self.getConnection())
                    } else {
                        return EntitySuper[self.name].instance
                    }

                } else if ( typeof(EntitySuper[callerName].instance) != 'undefined' && EntitySuper[callerName].instance._relations[entityName] ) {
                    return EntitySuper[callerName].instance._relations[entityName]
                } else {
                    if ( typeof(modelUtil.entities[self.bundle][self.model][entity]) != 'function' ) {
                        throw new Error('Model entity not found: `'+ entity + '` while trying to call '+ callerName +'Entity.getEntity('+ entity +')');
                    }

                    // fixed on May 2019, 21st : need for `this.getEntity(...)` inside the model
                    if (  typeof(EntitySuper[callerName].instance._relations[entityName]) == 'undefined' ) {

                        if ( typeof(EntitySuper[entityName]) != 'undefined' && typeof(EntitySuper[entityName].instance) != 'undefined' ) {

                            EntitySuper[callerName].instance._relations[entityName] = new modelUtil.entities[self.bundle][self.model][entity](self.getConnection(), callerName)
                        } else { // regular case
                            new modelUtil.entities[self.bundle][self.model][entity](self.getConnection(), callerName);
                        }
                    }


                    return EntitySuper[callerName].instance._relations[entityName]
                }
            }

        } catch (err) {
            throw err;
        }
    }

    this.setInstance = function(instance) {
        EntitySuper[self.name].instance = instance
    }


    return init(conn, caller)
};

EntitySuper = inherits(EntitySuper, EventEmitter);
module.exports = EntitySuper