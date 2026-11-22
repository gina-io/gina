/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/async
 * @description Async bridging utilities for Gina's EventEmitter-based callback patterns.
 *
 * Shell commands (`Shell::run`), the `run()` global, and any user-defined class
 * that adopts the `.onComplete(cb)` convention return EventEmitter instances.
 * These utilities wrap the callback into a native Promise so callers can use
 * `async/await`.
 *
 * PathObject file operations (`mkdir`, `cp`, `mv`, `rm`) are NOT part of that
 * set: they are Node-style callback methods that return `undefined`, so they
 * cannot be wrapped by `onCompleteCall` — promisify their callback instead.
 *
 * @package    gina.framework
 * @namespace  lib.async
 * @author     Rhinostone <contact@gina.io>
 */

'use strict';

/**
 * Wrap an `.onComplete(cb)` emitter into a Promise.
 *
 * Accepts any object that exposes an `onComplete(callback)` method — a `Shell`
 * command, the `run()` global, or any user-defined class that follows the same
 * convention. The callback signature is `(err, result)`: on error, the Promise
 * rejects with `err`; on success, it resolves with `result`.
 *
 * @memberof module:lib/async
 * @param {object} emitter - An object with an `onComplete(cb)` method
 * @returns {Promise<*>} Resolves with the operation result, rejects on error
 * @throws {TypeError} If `emitter` is falsy or lacks an `onComplete` method
 *
 * @example
 * // Await a Shell command — `Shell::run` returns the emitter:
 * var output = await onCompleteCall( new lib.Shell().run('ls -la', true) );
 *
 * @example
 * // Await the `run()` global (also exported as `gna.run`):
 * var output = await onCompleteCall( run([ 'ls', '-la' ], { cwd: self.uploadDir }) );
 *
 * @example
 * // PathObject ops are callback-style and return `undefined`, so onCompleteCall
 * // cannot wrap them — promisify the callback:
 * var dir = await new Promise(function(resolve, reject) {
 *     new _(self.uploadDir).mkdir(function(err, path) {
 *         if (err) return reject(err);
 *         resolve(path);
 *     });
 * });
 *
 * @example
 * // In an async controller action:
 * Controller.prototype.upload = async function(req, res, next) {
 *     var self = this;
 *     try {
 *         var output = await onCompleteCall( new lib.Shell().run('ls -la', true) );
 *         self.renderJSON({ ok: true, output: output });
 *     } catch (err) {
 *         self.throwError(res, 500, err);
 *     }
 * };
 */
function onCompleteCall(emitter) {
    if (!emitter || typeof emitter.onComplete !== 'function') {
        throw new TypeError('onCompleteCall: expected an object with an onComplete(cb) method, got ' + (emitter ? typeof emitter : String(emitter)));
    }
    return new Promise(function(resolve, reject) {
        emitter.onComplete(function(err, result) {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

module.exports = onCompleteCall;
