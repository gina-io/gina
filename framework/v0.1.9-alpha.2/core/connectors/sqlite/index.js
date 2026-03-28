/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * SQLite connector — v1: session store only.
 *
 * Uses the Node.js built-in `node:sqlite` module (Node >= 22.5.0, zero npm deps).
 * Entity/ORM wiring and `~/.gina/` state storage are planned for future releases.
 *
 * To configure:
 *   1. Add a `sqlite` entry to `config/connectors.json` in your bundle.
 *   2. No npm install required — `node:sqlite` is built into Node >= 22.5.0.
 *   3. Wire the store in `bundle/index.js` — see: core/connectors/sqlite/lib/session-store.js
 *
 * Planned phases:
 *   v2 — ORM / entity connector (embedded relational store, no external DB service)
 *   v3 — `~/.gina/` state storage (replace 4 JSON config files with a single gina.db)
 *
 * @class Sqlite
 * @constructor
 */
var Sqlite = function Sqlite() {
    // v1: no entity wiring — session store only
};

module.exports = Sqlite;
