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
 * Gina's PathObject file operations (`mkdir`, `cp`, `mv`, `rm`), Shell commands,
 * and any user-defined class that adopts the `.onComplete(cb)` convention return
 * EventEmitter instances. These utilities wrap the callback into a native Promise
 * so callers can use `async/await`.
 *
 * @package    gina.framework
 * @namespace  lib.async
 * @author     Rhinostone <contact@gina.io>
 */

'use strict';

/**
 * Wrap an `.onComplete(cb)` emitter into a Promise.
 *
 * Accepts any object that exposes an `onComplete(callback)` method — PathObject
 * file operations, Shell commands, or any user-defined class that follows the
 * same convention. The callback signature is `(err, result)`: on error, the
 * Promise rejects with `err`; on success, it resolves with `result`.
 *
 * @memberof module:lib/async
 * @param {object} emitter - An object with an `onComplete(cb)` method
 * @returns {Promise<*>} Resolves with the operation result, rejects on error
 * @throws {TypeError} If `emitter` is falsy or lacks an `onComplete` method
 *
 * @example
 * // Await a PathObject directory creation:
 * var dir = await onCompleteCall( _(self.uploadDir).mkdir() );
 *
 * @example
 * // Await a Shell command:
 * var output = await onCompleteCall( lib.Shell('ls -la') );
 *
 * @example
 * // In an async controller action:
 * Controller.prototype.upload = async function(req, res, next) {
 *     var self = this;
 *     try {
 *         await onCompleteCall( _(self.uploadDir).mkdir() );
 *         self.renderJSON({ ok: true });
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
