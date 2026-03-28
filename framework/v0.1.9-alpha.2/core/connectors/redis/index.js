/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Redis connector — v1: session store only.
 *
 * Entity/ORM wiring is not implemented in v1.
 * Use this connector exclusively as a session store backend via `lib.SessionStore`.
 *
 * To configure:
 *   1. Add a `redis` entry to `config/connectors.json` in your bundle.
 *   2. Install ioredis in your project: `npm install ioredis`
 *   3. Wire the store in `bundle/index.js` — see: core/connectors/redis/lib/session-store.js
 *
 * ORM / entity support is planned for a future release.
 *
 * @class Redis
 * @constructor
 */
var Redis = function Redis() {
    // v1: no entity wiring — session store only
};

module.exports = Redis;
