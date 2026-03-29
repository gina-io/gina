/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');

/**
 * WatcherService — shared file-watch registry (#R1).
 *
 * Accepts registrations from two sources:
 *   1. User-defined entries loaded from `watchers.json` via `load()`.
 *   2. Framework internals (e.g. #M6 dev-mode hot-reload) via `register()`.
 *
 * Uses `fs.watch` for native, event-driven file change detection.
 * No polling — no drift.
 *
 * Lifecycle:
 *   var w = new WatcherService();
 *   w.load(configDir, watchersConf);   // populate from watchers.json
 *   w.register('custom', '/abs/path'); // optional programmatic registration
 *   w.on('app.json', function(event, filePath) { ... });
 *   w.start();                         // open fs.watch handles
 *   // …
 *   w.stop();                          // close all handles
 *
 * @class WatcherService
 * @constructor
 */
function WatcherService() {

    var self     = this;
    var _handles = {};  // name → fs.FSWatcher
    var _entries = {};  // name → { filePath, event, persistent, listeners[] }


    /**
     * Register a file watcher entry.
     * Silently ignored if a watcher with the same name is already registered.
     *
     * @param {string}  name                   - Unique entry name (e.g. 'app.json')
     * @param {string}  filePath               - Absolute path of the file to watch
     * @param {object}  [options]
     * @param {string}  [options.event='change'] - fs.watch event to filter: 'change' or 'rename'
     * @param {boolean} [options.persistent=false] - Whether to keep the process alive while watching
     */
    self.register = function(name, filePath, options) {

        if (_handles[name] || _entries[name]) {
            return;
        }

        options = options || {};
        _entries[name] = {
            filePath   : filePath,
            event      : options.event      || 'change',
            persistent : options.persistent || false,
            listeners  : []
        };
    };


    /**
     * Attach a listener to a registered watcher entry.
     * The listener is called with `(event, filePath)` when the watched file changes.
     * Silently ignored if no entry with the given name exists.
     *
     * @param {string}   name     - Entry name (must have been registered first)
     * @param {function} listener - `function(event, filePath)`
     */
    self.on = function(name, listener) {

        if (!_entries[name]) return;
        _entries[name].listeners.push(listener);
    };


    /**
     * Populate watcher entries from a `watchers.json` config object.
     * Called by the framework from `gna.js` `onStarted`. Paths in `watchersConf`
     * are resolved relative to `basePath` (the bundle's config directory).
     *
     * `$schema` keys are automatically skipped.
     *
     * @param {string} basePath     - Base directory for resolving relative file paths
     * @param {object} watchersConf - Parsed `watchers.json` content:
     *                                `{ 'filename': { event?, persistent? } }`
     */
    self.load = function(basePath, watchersConf) {

        if (!watchersConf || typeof watchersConf !== 'object') return;

        Object.keys(watchersConf).forEach(function(key) {

            // skip JSON schema annotations
            if (key.charAt(0) === '$') return;

            var entry    = watchersConf[key] || {};
            var filePath = nodePath.resolve(basePath, key);

            self.register(key, filePath, {
                event      : entry.event      || 'change',
                persistent : entry.persistent || false
            });
        });
    };


    /**
     * Open `fs.watch` handles for all registered entries.
     * Entries whose file does not exist at start time are silently skipped —
     * they will not be watched until `start()` is called again.
     */
    self.start = function() {

        Object.keys(_entries).forEach(function(name) {

            if (_handles[name]) return;  // already watching

            var entry    = _entries[name];
            var filePath = entry.filePath;

            if (!fs.existsSync(filePath)) {
                console.debug('[WatcherService] skipping non-existent path: ' + filePath);
                return;
            }

            try {

                var handle = fs.watch(filePath, { persistent: entry.persistent }, function onFsEvent(fsEvent) {

                    if (fsEvent !== entry.event) return;

                    var listeners = entry.listeners;
                    for (var i = 0; i < listeners.length; i++) {
                        try {
                            listeners[i](fsEvent, filePath);
                        } catch (listenerErr) {
                            console.error('[WatcherService] listener error for "' + name + '": ' + (listenerErr.stack || listenerErr));
                        }
                    }
                });

                handle.on('error', function(watchErr) {
                    console.warn('[WatcherService] fs.watch error for "' + name + '": ' + (watchErr.message || watchErr));
                });

                _handles[name] = handle;
                console.debug('[WatcherService] watching: ' + filePath);

            } catch (openErr) {
                console.warn('[WatcherService] could not watch "' + filePath + '": ' + (openErr.message || openErr));
            }
        });
    };


    /**
     * Close all active `fs.watch` handles.
     * Registered entries and their listeners are preserved — `start()` can be called again.
     */
    self.stop = function() {

        Object.keys(_handles).forEach(function(name) {
            try {
                _handles[name].close();
            } catch (closeErr) {
                // close errors are benign — handle may already be closed
            }
            delete _handles[name];
        });
    };


    /**
     * Return the names of all currently active (open) watchers.
     *
     * @returns {string[]}
     */
    self.active = function() {
        return Object.keys(_handles);
    };


    /**
     * Return the names of all registered entries (started or not).
     *
     * @returns {string[]}
     */
    self.registered = function() {
        return Object.keys(_entries);
    };

}

module.exports = WatcherService;
