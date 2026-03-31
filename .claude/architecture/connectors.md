# Connector Patterns — Couchbase

Reference for the Couchbase connector: entity wiring, N1QL loading, `$scope` substitution, and dev-mode behaviour.

**File:** `core/connectors/couchbase/index.js`

---

## 1. Startup Wiring — `init()` and `readSource()`

The connector runs once at bundle startup. `init()` scans `models/<database>/entities/` and `models/<database>/n1ql/` and wires every entity class and N1QL file onto a shared `entities` object.

```text
init()
  └─ loadN1QL(entities, filename)
       └─ readSource(entities, entityName, source)
            ├─ fs.readFileSync(source)   ← SQL read ONCE, stored in closure
            ├─ resolve @include directives
            ├─ parse @param / @options / @return annotations
            └─ entities[entityName].prototype[methodName] = function() { ... }
```

Every entity prototype method is a closure over the original `queryString`. The SQL content lives in that closure for the lifetime of the process.

---

## 2. `_scope` and `_collection` on Entity Prototypes

Both fields are set on each entity prototype at startup:

```javascript
Entity.prototype._collection = entityName;          // e.g. 'company', 'invoice'
Entity.prototype._scope      = infos.scope || process.env.NODE_SCOPE;
```

`infos.scope` is read from `connectors.json` for the bundle. Falls back to `process.env.NODE_SCOPE`. Allowed values: `local`, `beta`, `production`, `testing`.

These mirror the `_collection` / `_scope` fields written into every Couchbase document at insert time, enabling N1QL queries to filter by both type and environment without needing separate buckets.

---

## 3. `$scope` Substitution in N1QL Queries

`$scope` in a `.sql` file is replaced with a **quoted string literal** immediately before the query is dispatched:

```javascript
if ( query.indexOf('$scope') > -1 ) {
    query = query.replace(/\$scope/g, "'" + (infos.scope || process.env.NODE_SCOPE) + "'");
}
```

**Why a literal, not a positional parameter**

Couchbase positional parameters are numbered (`$1`, `$2`, …). Injecting `$scope` as `$3` would require renumbering every existing SQL file. The literal substitution leaves existing `$1/$2` numbering intact — no call-site changes needed anywhere.

**Rule**

> Every N1QL query that discriminates by document type should also include `AND t._scope = $scope` in the WHERE clause. Queries that use `USE KEYS` already pin to a specific document key, but the `_scope` filter is still required for consistency and to future-proof against index changes.

---

## 4. `_scope` at Insert Time

`bulkInsert` stamps `_scope` on every record before writing:

```javascript
rec[id].values._scope = this._scope;
```

Individual entity `insert` methods must do the same explicitly:

```javascript
rec._scope = self._scope;
```

Documents created before `_scope` was introduced (pre-2026-03-23) will have `_scope IS MISSING`. Run the backfill script once per environment to stamp them:

```bash
node script/backfill-scope.js [--scope=local] [--host=localhost:8093]
```

---

## 5. Dev-Mode SQL Re-read

**Added:** commit `…` · 2026-03-25

At startup the SQL is read once into the `queryString` closure. In production that is final. In dev mode (`envIsDev = true`), the file is re-read from disk on **every query call** so edits are picked up without restarting the server — mirroring the `delete require.cache` pattern used for controllers.

```javascript
if (envIsDev) {
    var _devSrc  = fs.readFileSync(source).toString().replace(/\n/g, ' ');
    var _devCmts = _devSrc.match(/(\/\*...*\*\/)|\/\/.*/g);
    queryString  = (_devCmts ? _devSrc.replace(_devCmts[0], '') : _devSrc).trim();
}
queryStatement = queryString.slice(0);
```

`@include` directives and `@param` / `@options` metadata are **not** re-processed — they stay as parsed at startup. Only the query body is refreshed. If you change the parameter signature of a `.sql` file in dev mode, restart the server.

---

## 6. `queryStatement` Shared Mutable Variable — Concurrency Note

`queryStatement` is declared in the `readSource` closure scope, not inside the prototype method body. It is re-assigned on every call (`queryStatement = queryString.slice(0)`), which means two concurrent calls to the **same N1QL method** share it briefly.

In practice this is benign because `queryStatement` is only mutated locally (placeholder substitution) and the Couchbase SDK receives it by value before the next assignment. However, be aware of this if adding async operations between the assignment and the SDK call.

---

## 8. Session Store — Promise `.then()` Callback Safety (#CB-BUG-4)

**Files:** `core/connectors/couchbase/lib/session-store.v3.js`, `session-store.v4.js`

**The bug (fixed commit `693b82bc`)**

In v3 and v4, `touch()` and `destroy()` used Promise-based KV operations but forwarded the resolved value unsafely to the express-session callback:

```javascript
// UNSAFE — resolved MutationResult becomes arguments[0] = "err"
client.upsert(...)
    .then(function onResult() { fn && fn.apply(this, arguments); })

// UNSAFE — .then(fn) passes MutationResult as fn's first arg
client.remove(...).then(fn)
```

Couchbase SDK v3/v4 resolves `upsert()` / `remove()` with a `MutationResult`:
```json
{ "cas": "1774918045556670464", "token": { "bucket_name": "session", ... } }
```

express-session v1.18.1 `store.touch()` callback:
```javascript
store.touch(req.sessionID, req.session, function ontouch(err) {
    if (err) {
        defer(next, err);   // ← routes MutationResult as error to Express error handler
    }
    writeend();
});
```

`defer(next, MutationResult)` → `setImmediate(next, MutationResult)` → Express error handler → 500 response with CAS token as body.

**Why the old SDK v2 (`session-store.v2.js`) is safe**

v2 uses the callback-style API throughout: `client.upsert(key, val, opts, function(err) { fn.apply(this, arguments) })`. The callback receives `(err, result)` as separate positional parameters — `err` is always `null` on success regardless of what `result` is.

**The rule**

In any session store method that uses a Promise-based KV API, ALWAYS call `fn(null)` explicitly in `.then()`:

```javascript
// SAFE
client.upsert(...)
    .then(function onResult() { fn && fn(null); })
    .catch(function onError(err) { fn && fn(err); })

client.remove(...)
    .then(function onResult() { fn(null); })
    .catch(fn)
```

Never use `.then(fn)` or `.then(fn.apply(this, arguments))` — the Promise resolved value
(MutationResult, delete count, etc.) will be misidentified as the error argument.

**Identifying this bug in production**

If a Couchbase `MutationResult` object (`{cas: "...", token: {bucket_name: "..."}}`) appears
as an HTTP 500 response body, the source is a session store's `.then()` handler leaking its
resolved value into the express-session callback chain. Check `touch()` and `destroy()` first.

---

## 7. SDK Version Branching

The connector supports Couchbase SDK v2 (callback-based) and v3+ (Promise-based):

```javascript
var sdkVersion = conn.sdk.version || 2;

if (sdkVersion > 2) {
    conn._cluster.query(query, queryOptions)   // Promise
        .then(onResult).catch(onError);
} else {
    conn.query(query, queryOptions, onQueryCallback);  // callback
}
```

`onQueryCallback` normalises empty results: `if (!data || data.length == 0) { data = null }`. This null propagates through the entity event system — see [Entity — `_arguments` buffer](./class.entity.md#4-_arguments-buffer-firing-5-and-dev-mode-cache-poisoning).
