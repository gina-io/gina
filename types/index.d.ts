/**
 * Gina Framework — TypeScript declarations
 *
 * Main module declaration for `require('gina')` / `import gina from 'gina'`.
 *
 * SHAPE — namespace-as-module (`export = gina`): the CJS runtime is
 * `module.exports = gna` (the module IS the framework object) and the ESM
 * entry re-exports that same object as its default. A namespace exported
 * with `export =` is the only declaration shape that describes both
 * consumer forms (`import gina = require('gina')` and
 * `import gina from 'gina'`) without lying to either.
 *
 * The runtime object is a PLAIN OBJECT LITERAL — it is NOT an EventEmitter
 * (no `on` / `once` / `removeListener`), which is why this namespace
 * deliberately declares none of those members.
 *
 * `SuperController` / `EntitySuper` are TYPES here only: the main entry
 * does not export those constructor VALUES. The constructors live on
 * `require('gina/gna')` (see `types/gna.d.ts`).
 *
 * PARITY CONTRACT — `test/lib/types-runtime-parity.test.js` parses this
 * file and diffs it against the runtime. Namespace VALUE members must be
 * declared at 4-space indent as `const <name>:` or `function <name>(`;
 * interface members sit deeper. Keep that layout when editing.
 *
 * @packageDocumentation
 */

/// <reference types="node" />
/// <reference path="./globals.d.ts" />

import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Http2ServerRequest, Http2ServerResponse, ServerHttp2Stream } from 'http2';
import type { LocaleResult, ApiErrorConstructor } from './globals';

declare namespace gina {

    // ─── Request / Response aliases ──────────────────────────────────────

    /**
     * The framework request object.
     *
     * `TDto` types the validated payload of a route that declares
     * `param.dto` in `routing.json` — pass the `<Name>Projected` type
     * emitted by `gina bundle:types` (the projection is what the server
     * actually holds: declared fields coerced, `.exclude()`d fields
     * dropped). The method-payload fields stay intersected with
     * `Record<string, any>` because URL params ride alongside the body
     * and undeclared keys are passed through, never stripped.
     */
    type GinaRequest<TDto = Record<string, any>> = (IncomingMessage | Http2ServerRequest) & {
        /** Parsed GET query-string params */
        get?: Record<string, any>;
        /** Parsed POST body (+ URL params; DTO-coerced when the route declares `param.dto`) */
        post?: TDto & Record<string, any>;
        /** Parsed PUT body (+ URL params; DTO-coerced when the route declares `param.dto`) */
        put?: TDto & Record<string, any>;
        /** Parsed PATCH body (+ URL params; DTO-coerced when the route declares `param.dto`) */
        patch?: TDto & Record<string, any>;
        /** Parsed DELETE params (+ URL params; DTO-coerced when the route declares `param.dto`) */
        delete?: TDto & Record<string, any>;
        /** Parsed HEAD query-string params */
        head?: Record<string, any>;
        /** The original parsed body (no URL params merged in) */
        body?: TDto & Record<string, any>;
        /** URI params extracted by the router (`:id` segments, requirement captures) */
        params?: Record<string, string>;
        /**
         * Strict DTO projection of the payload — declared fields ONLY
         * (coerced, `.exclude()`d dropped, undeclared keys absent).
         * Present only when the matched route declares `param.dto`.
         */
        dto?: TDto;
        /** Routing metadata attached by the router */
        routing?: {
            rule: string;
            method: string;
            param: RouteParam;
            [key: string]: any;
        };
        /** Get all merged params for the current HTTP method */
        getParams(): Record<string, any>;
        /** Get a single param by name */
        getParam(name: string): any;
    };

    type GinaResponse = (ServerResponse | Http2ServerResponse) & {
        /** HTTP/2 stream when available */
        stream?: ServerHttp2Stream;
        status?: number;
    };

    type NextFunction = (err?: any) => void;

    // ─── i18n translate shapes ────────────────────────────────────────────

    /**
     * The controller-bound translate function (`self.t`): culture and
     * bundle are auto-bound from the current request.
     */
    interface ControllerTranslate {
        (key: string, params?: object | null, culture?: string): string;
        /** ICU MessageFormat variant */
        icu(key: string, params?: object | null, culture?: string): string;
    }

    /**
     * The module-level translate function (`gina.t`): culture and bundle
     * are passed explicitly via the trailing options.
     */
    interface GnaTranslate {
        (key: string, params?: object | null, culture?: string, options?: {
            bundleName?: string;
            defaultCulture?: string;
            fallbackChain?: string[];
            devMissingKey?: boolean;
            [key: string]: any;
        }): string;
        /** ICU MessageFormat variant */
        icu(key: string, params?: object | null, culture?: string, options?: object): string;
    }

    // ─── DTO builder (#DTO1) ──────────────────────────────────────────────

    /**
     * A single DTO field under construction. All modifiers chain.
     */
    interface DtoField {
        required(): this;
        optional(): this;
        /**
         * Never serialise this field: dropped from the coerced request
         * payload / `req.dto`, and stripped from responses shaped by a
         * `param.responseDto`.
         */
        exclude(): this;
        description(text: string): this;
        /** Documentation-only default (rides the JSON Schema; not applied at runtime). */
        default(value: any): this;
        example(...values: any[]): this;
        /** String fields only. */
        email(): this;
        /** String fields only. */
        minLength(n: number): this;
        /** String fields only. */
        maxLength(n: number): this;
        /** String fields only. Documentation/OpenAPI only — not runtime-enforced. */
        pattern(re: string): this;
        /** String fields only. */
        trim(): this;
        /**
         * Integer/number fields only. SCHEMA-ONLY: rides the JSON Schema as
         * `minimum` but is NOT enforced by the runtime validation pipe.
         */
        min(v: number): this;
        /**
         * Integer/number fields only. SCHEMA-ONLY: rides the JSON Schema as
         * `maximum` but is NOT enforced by the runtime validation pipe.
         */
        max(v: number): this;
        /** Date fields only — the validation mask (default `'yyyy-mm-dd'`). */
        mask(mask: string): this;
        /** The field's JSON-Schema fragment (a clone). Not chainable. */
        toSchemaFragment(dialect?: string): object;
        /** The field's form-validator rules fragment. Not chainable. */
        toFieldRules(): object;
    }

    /**
     * A named DTO. Note `apply()` is the response projection used by
     * `param.responseDto`, and `toRules()` is the runtime-validation
     * projection used by `param.dto`.
     */
    interface DtoObject {
        /** Registry name (set by the second arg of `dto.object()` or by `.as()`), or `null`. */
        name: string | null;
        /** Name (and register) this DTO. */
        as(name: string): this;
        title(text: string): this;
        description(text: string): this;
        /** Keep undeclared keys in `apply()` / advertise `additionalProperties: true`. */
        passthrough(): this;
        /**
         * Advertise `additionalProperties: false` (the default). This is an
         * OpenAPI/MCP statement, NOT a runtime gate — undeclared keys (URL
         * params included) are passed through by the validation pipe.
         */
        strict(): this;
        /** The canonical JSON Schema (throws on an unknown dialect). */
        toJsonSchema(dialect?: 'draft-07' | '2020-12', opts?: { standalone?: boolean; dropExcluded?: boolean }): object;
        /**
         * The form-validator rules projection. THROWS if any `$` appears in
         * the compiled rules (an authored `$` in an enum value, field name
         * or date mask is server-fatal in the validation engine).
         */
        toRules(): object;
        /**
         * Response projection: returns a NEW object keeping declared,
         * non-excluded fields (plus `__gina*` sidecar keys; plus undeclared
         * keys when `.passthrough()`). Non-objects are returned verbatim.
         */
        apply(obj: object): object;
    }

    /**
     * The native DTO builder — `require('gina').dto` (also `gina.lib.dto`).
     * Inside a DTO FILE (`<bundle>/dtos/<Name>.js`) always use the factory
     * form `module.exports = function (dto) { ... }` instead of requiring
     * this module.
     */
    interface DtoBuilder {
        /** Build (and, when `name` is given, register) an object DTO. */
        object(shape: Record<string, DtoField>, name?: string): DtoObject;
        string(): DtoField;
        integer(): DtoField;
        number(): DtoField;
        boolean(): DtoField;
        /** Closed value set (throws on an empty array). Coerces to a literal-union type in `bundle:types` output. */
        enum(values: Array<string | number | boolean>): DtoField;
        /**
         * A date field. NOTE: the runtime engine coerces the value to an ISO
         * STRING (and shifts it to UTC) — the payload type is `string`, not `Date`.
         */
        date(): DtoField;
        register(name: string, d: DtoObject): DtoObject;
        get(name: string): DtoObject | null;
        /** Resolve `<bundleSrcPath>/dtos/<name>.js` (factory or DtoObject); re-runs the factory on every call. */
        load(bundleSrcPath: string, name: string): DtoObject | null;
        names(): string[];
        isDto(x: any): x is DtoObject;
        DIALECTS: { 'draft-07': string; '2020-12': string };
        DtoObject: new (shape: Record<string, DtoField>, name?: string) => DtoObject;
        DtoField: new (kind: string) => DtoField;
    }

    // ─── SuperController ──────────────────────────────────────────────────

    /**
     * Base controller INSTANCE shape. Every bundle controller action runs
     * with `this` bound to a fresh per-request instance, which IS an
     * EventEmitter.
     *
     * This is a TYPE only: the main entry does not export the constructor
     * value — `require('gina/gna').SuperController` does.
     */
    interface SuperController extends EventEmitter {
        name: string;
        engine: any;
        /** Only assigned once `query()` or `throwError()` has run — absent on a fresh instance. */
        isProcessingError?: boolean;

        /** Get the current request object */
        getRequestObject(): GinaRequest;
        /** Get the current response object */
        getResponseObject(): GinaResponse;
        /** Get the `next` middleware callback */
        getNextCallback(): NextFunction | null;

        /** True when running in dev mode */
        isCacheless(): boolean;
        /** True when scope is `'local'` */
        isLocalScope(): boolean;
        /** True when scope is `'production'` */
        isProductionScope(): boolean;

        /**
         * True when the authenticated session user holds `role` (#COMPLY1).
         *
         * The imperative escape hatch for an action that authorizes mid-logic; the
         * declarative `routing.json` `param.roles` gate covers the whole-route case.
         * False for an unauthenticated request.
         * @param role - The role name to test for
         */
        hasRole(role: string): boolean;

        /**
         * Render an HTML template (Swig or Nunjucks per the route's engine).
         * @param userData - Template data merged into the view
         * @param displayInspector - Show the Gina Inspector overlay
         * @param errOptions - Error rendering options (internal)
         */
        render(userData?: object, displayInspector?: boolean, errOptions?: object): void;

        /** Render without the layout wrapper */
        renderWithoutLayout(data?: object, displayInspector?: boolean): void;

        /**
         * Send a JSON response.
         * @param jsonObj - Data to serialise; parsed if passed as a string
         */
        renderJSON(jsonObj: any): void;

        /**
         * Stream an AsyncIterable as a chunked HTTP response.
         * Defaults to `text/event-stream` (SSE) framing.
         */
        renderStream(asyncIterable: AsyncIterable<any>, contentType?: string): void;

        /**
         * Send a pre-serialised XML document.
         * The status comes from `response.statusCode`, not from the payload.
         * @param xmlContent - The serialised document; coerced when not a string
         * @param contentType - Defaults to `application/xml`; pass the suffix
         *                      family explicitly (`application/soap+xml`, …)
         */
        renderXML(xmlContent: string | any, contentType?: string): void;

        /** Send a plain-text response */
        renderTEXT(content: string | any): void;

        /**
         * Send 103 Early Hints for preloading resources.
         * @returns `this` for chaining
         */
        setEarlyHints(links: string | string[]): this;

        /**
         * Record HTTP/2 response trailers to send after the body
         * (`:`-prefixed pseudo-headers are stripped; best-effort no-op on
         * HTTP/1.1).
         * @returns `this` for chaining
         */
        sendTrailers(fields: object): this;

        /** True when the request was made via XMLHttpRequest */
        isXMLRequest(): boolean;
        /** True when credentials (cookies/auth) were sent */
        isWithCredentials(): boolean;
        /** True when the request originated from a Gina popin */
        isPopinContext(): boolean;

        /** Override the HTTP method for the current request */
        setRequestMethod(requestMethod: string, conf: object): string;
        /** Get the (possibly overridden) HTTP method */
        getRequestMethod(): string | null;
        /** Override the parsed method params */
        setRequestMethodParams(params: object): void;
        /** Get the overridden method params */
        getRequestMethodParams(): object | null;

        /**
         * Override the route's template file (and optionally extension) at
         * action time, before `render()`.
         */
        setTemplate(file: string, ext?: string): void;

        /**
         * Redirect to a route name, URL, or full request triplet.
         */
        redirect(target: string, ignoreWebRoot?: boolean): void;
        redirect(req: GinaRequest, res: GinaResponse, next?: NextFunction): void;

        /** Get a clone of the bundle configuration */
        getConfig(name?: string): any;

        /** Get locale utilities */
        getLocales(shortCountryCode?: string): LocaleResult;

        /** Get form validation rules for the current request */
        getFormsRules(): object;

        /**
         * Translate a key via the bundle's i18n catalogs; culture is
         * auto-bound from the current request.
         */
        t: ControllerTranslate;

        /** Emit an observable application event to the dev Inspector Events tab. */
        emitEvent(name: string, metadata?: object): boolean;

        /**
         * Start an out-of-band async job; returns the job id immediately.
         * The job outlives the request — poll `/_gina/jobs/:id` or use
         * `jobStatus()`.
         */
        startJob(fn: () => any | Promise<any>, opts?: object): string;

        /** Read a job's full record by id (node-style callback). */
        jobStatus(id: string, cb: (err: Error | null, record?: object) => void): void;

        /**
         * Emit one audit-trail record (#COMPLY2). Fire-and-forget; a no-op
         * when `settings.json > audit.enabled` is not true. `data.actor`
         * overrides the session-derived actor snapshot.
         */
        audit(action: string, data?: { resource?: any; meta?: object; actor?: { key?: any; roles?: string[] } }, cb?: (err: Error | null) => void): void;

        /**
         * Start an async model-inference job (wraps
         * `getModel(connector).infer(...)` in `startJob`); returns the job id.
         */
        inferAsync(messages: Array<{ role: string; content: string }>, options?: { connector?: string; [key: string]: any }, jobOpts?: object): string;

        /**
         * Render/output cache facade for routes configured with
         * `routing.json > cache`.
         */
        cache: {
            /** Invalidate every cache entry registered under `invalidateOnEvents` containing `event`; returns the invalidated count. */
            invalidateByEvent(event: string): number;
            /** Flush this bundle's render/output cache (optionally scoped); returns the flushed count. */
            clear(bundle?: string): number;
        };

        /**
         * Make an outbound HTTP/HTTPS request.
         * @param options - Request options (host, port, path, method, headers, critical, ...)
         * @param data - Request body / query params
         * @param callback - `callback(err, result)` -- omit (or pass `null`) to get the
         *   fluent `{ onComplete }` handle: a PER-CALL channel (#B475) returned on
         *   every path, chainable, delivering `cb(false, data)` on success and
         *   `cb(err)` on failure. Never a Promise -- promisify the call to `await` it.
         */
        query(options: QueryOptions, data?: object, callback?: (err: Error | null, result: any) => void): QueryHandle | void;

        /**
         * Download a file from a remote URL and stream it to the client.
         */
        downloadFromURL(url: string, options?: DownloadOptions, cb?: (err: Error | null, files?: any[]) => void): Promise<void>;

        /** Download a local file to the client */
        downloadFromLocal(filename: string): void;

        /**
         * Serve a stored object over HTTP with full Range support — the
         * read-side companion of `store()`'s driver routing. Terminal:
         * answers 200/206/416/304 (or 404/500 via `throwError`) with
         * `Accept-Ranges`/`Content-Range`, a strong key-derived `ETag`,
         * `Last-Modified`, conditional GET and `If-Range`, on both engines.
         */
        serveFromStorage(driverName: string, key: string, opts?: {
            /** Explicit Content-Type; served verbatim, bypasses the active-content downgrade. */
            contentType?: string;
            /** Replaces the `private, max-age=31536000, immutable` default, verbatim. */
            cacheControl?: string;
            /** `true` emits `Content-Disposition: attachment`. */
            download?: boolean;
            /** Download filename (implies attachment); defaults to the stored originalName. */
            filename?: string;
        }): void;

        /**
         * Store uploaded file(s) to a target directory. With no `cb`, returns
         * the fluent handle: `store(target).onComplete(cb)` (#B420 — the
         * implementation is deliberately not `async`).
         */
        store(target: string, files?: any, cb?: (err: Error | null, files?: any[]) => void): { onComplete(cb: (err: Error | null, files?: any[]) => void): void } | void;

        /** Health check: responds with `{ status: 200, isAlive: true }` */
        getBundleStatus(req: GinaRequest, res: GinaResponse, next: NextFunction): void;

        /** Ping a sibling bundle's health endpoint */
        checkBundleStatus(bundle: string, cb?: (err: Error | null, status: object) => void): Promise<object>;

        /** Forward the request to another bundle */
        forward(req: GinaRequest, res: GinaResponse, next: NextFunction): void;

        /** Conditional 404: throw 404 unless `condition` is truthy */
        forward404Unless(condition: any, req: GinaRequest, res: GinaResponse, next?: NextFunction): Error | boolean;

        /** Push an SSE payload to connected clients */
        push(payload: any, option?: object, callback?: (err: Error | null) => void): void;

        /** Check if the session has a halted request */
        isHaltedRequest(session?: object): boolean;
        /** Snapshot and store the current request for later replay */
        pauseRequest(data?: object, requestStorage?: object): object;
        /** Replay a previously paused request */
        resumeRequest(requestStorage?: object): void;

        /** Render the custom error page */
        renderCustomError(req: GinaRequest, res: GinaResponse, next: NextFunction): void;

        /**
         * Error handler. Polymorphic signatures:
         * - `throwError(err: Error)`
         * - `throwError(code, err)` — 2-arg form: HTTP status + Error | string
         * - `throwError(res, code, msg)`
         * - `throwError(errorObj)` where errorObj has `.status`, `.error`, `.fields`
         */
        throwError(err: Error): void;
        throwError(code: number, err: Error | string): void;
        throwError(res: GinaResponse, code: number, msg?: string | Error): void;
        throwError(errorObj: { status?: number; error?: string; message?: string; fields?: object; flash?: object }): void;

        /** Inject per-request state (called by router -- not typically used in app code) */
        setOptions(req: GinaRequest, res: GinaResponse, next: NextFunction, options: object): void;
    }

    /**
     * The SuperController CONSTRUCTOR — the value exported by
     * `require('gina/gna')`, NOT by the main entry.
     */
    interface SuperControllerConstructor {
        new (options?: object): SuperController;
        /** Create an isolated test instance (fresh `local` closure, `setOptions` pre-wired). */
        createTestInstance(deps?: {
            req?: object;
            res?: object;
            next?: (err?: any) => void;
            options?: object;
        }): SuperController;
    }

    // ─── EntitySuper ──────────────────────────────────────────────────────

    interface EntityInjected {
        config?: (bundle: string, confName: string) => any;
        connector?: any;
    }

    /**
     * Base entity INSTANCE shape. Entity methods return Promises with an
     * `.onComplete(cb)` shim attached.
     *
     * This is a TYPE only: the constructor value lives on
     * `require('gina/gna').EntitySuper`.
     */
    interface EntitySuper extends EventEmitter {
        initialized: boolean;
        name: string;
        bundle: string;
        model: string;
        /** Stamped by the connector at model init (from `connectors.json` scope). */
        _scope?: string;
        /** Stamped by the connector at model init. */
        database?: any;
        /** Stamped by the connector at model init. */
        _collection?: string;

        /** Get the database connection object */
        getConnection(scope?: string, collection?: string): any;

        /** Get bundle config */
        getConfig(bundle?: string, confName?: string): any;

        /**
         * Get a related entity by name.
         * Supports short names: `'user'` resolves to `'user/user'`.
         */
        getEntity(entity: string): any;

        /** Override the cached entity instance */
        setInstance(instance: any): void;
    }

    /**
     * The EntitySuper CONSTRUCTOR — the value exported by
     * `require('gina/gna')`, NOT by the main entry.
     */
    interface EntitySuperConstructor {
        /**
         * @param conn - Database connection object from the connector
         * @param caller - Name of calling context (debug)
         * @param injected - Dependency overrides for unit testing
         */
        new (conn: any, caller?: string, injected?: EntityInjected): EntitySuper;
    }

    // ─── Query / Download option shapes ───────────────────────────────────

    /**
     * The fluent handle `query()` returns when no callback is given (#B475): one
     * per call, so concurrent fluent queries on one controller never share a
     * channel; `onComplete()` returns the handle so registrations chain, and a
     * registration made after the call settled still fires on the next tick.
     */
    interface QueryHandle {
        onComplete(cb: (err: any, data?: any) => void): QueryHandle;
    }

    interface QueryOptions {
        host?: string;
        hostname?: string;
        port?: number;
        path?: string;
        method?: string;
        headers?: Record<string, string>;
        /** When `false`, HTTP/2 errors are swallowed (log-only) instead of propagating */
        critical?: boolean;
        /**
         * Opt a non-safe HTTP method (POST/PUT/PATCH/DELETE) back into
         * automatic retries on transient transport failures. Default
         * `false`: only GET/HEAD/OPTIONS/TRACE auto-retry, because a
         * post-send failure cannot prove the upstream did not execute.
         */
        retryUnsafe?: boolean;
        rejectUnauthorized?: boolean;
        [key: string]: any;
    }

    interface DownloadOptions {
        /** Override the downloaded file name */
        file?: string | null;
        fileSize?: number | null;
        /** Store locally instead of streaming to client */
        toLocalDir?: string | false;
        contentDisposition?: string;
        contentType?: string;
        agent?: any;
        rejectUnauthorized?: boolean;
        port?: number;
        method?: string;
        keepAlive?: boolean;
        headers?: Record<string, string>;
    }

    // ─── Config file shapes ───────────────────────────────────────────────

    /** A single route entry in `routing.json` */
    interface RouteEntry {
        url: string;
        method: string;
        param: RouteParam;
        requirements?: Record<string, string>;
        middleware?: string[];
        middlewareIgnored?: string[];
        bundle?: string;
        hostname?: string;
        scopes?: string[];
        cache?: string | RouteCache;
        namespace?: string;
        _comment?: string;
        _sample?: any;
    }

    interface RouteParam {
        /**
         * The controller action name. Required for HTTP routes; omitted for
         * `method: "ws"` routes (which use `wsHandler` instead).
         */
        control?: string;
        file?: string;
        path?: string;
        code?: number;
        ignoreWebRoot?: boolean;
        title?: string;
        namespace?: string;
        /**
         * Name of a DTO (`<bundle>/dtos/<Name>.js`) validating this route's
         * request payload before the action runs (422 on failure; the
         * coerced payload replaces `req[method]` and the strict projection
         * lands on `req.dto`). Registered at bundle boot — a DTO edit needs
         * a bundle restart.
         */
        dto?: string;
        /**
         * Name of a DTO shaping this route's 2xx JSON responses:
         * `.exclude()`d fields never reach the wire (or the render cache).
         */
        responseDto?: string;
        /** `method: "ws"` routes: the channel handler at `<bundle>/channels/<name>.js`. */
        wsHandler?: string;
        /** `method: "ws"` routes: per-route WebSocket options. */
        wsOptions?: { maxPayload?: number; protocol?: string; closeTimeout?: number };
        /** URL-param bindings (`"id": ":id"`) and any static route metadata. */
        [key: string]: any;
    }

    interface RouteCache {
        type?: string;
        ttl?: number;
        visibility?: string;
        sliding?: boolean;
        maxAge?: number;
        invalidateOnEvents?: string[];
    }

    /** `routing.json` — keys are route names */
    type RoutingConfig = Record<string, RouteEntry>;

    /** A single connector entry in `connectors.json` */
    interface ConnectorEntry {
        connector?: 'couchbase' | 'mongodb' | 'scylladb' | 'mysql' | 'postgresql' | 'sqlite' | 'duckdb' | 'redis' | 'ai';
        protocol?: string;
        host?: string;
        port?: number;
        database?: string;
        username?: string;
        password?: string;
        scope?: string;
        connectionLimit?: number;
        ssl?: object;
        /** SQLite: path to database file */
        file?: string;
        /** PostgreSQL: idle timeout in ms */
        idleTimeout?: number;
        /** PostgreSQL: connection timeout in ms */
        connectionTimeout?: number;
        /** Redis: database index */
        db?: number;
        /** Redis: TLS toggle */
        tls?: boolean;
        /** Redis: key prefix for sessions */
        prefix?: string;
        /** Redis: TTL in seconds */
        ttl?: number;
        /** Redis: cluster node list */
        cluster?: Array<{ host: string; port: number }>;
        /** Couchbase: keep connection alive */
        keepAlive?: boolean;
        /** Couchbase: ping interval (e.g. `"2m"`) */
        pingInterval?: string;
        /** Couchbase: use scopes and collections */
        useScopeAndCollections?: boolean;
        /** Couchbase: timeout overrides */
        timeouts?: Record<string, number>;
        /** AI: API key or env var reference */
        apiKey?: string;
        /** AI: model identifier */
        model?: string;
        /** AI: base URL override */
        baseURL?: string;
    }

    /** `connectors.json` — keys are connector names */
    type ConnectorsConfig = Record<string, ConnectorEntry>;

    /** `app.json` */
    interface AppConfig {
        name: string;
        version: string;
        greeting?: string;
        proxy?: Record<string, {
            ca?: string;
            hostname?: string;
            port?: number;
            path?: string;
            requestTimeout?: number;
        }>;
        apis?: Record<string, object>;
    }

    /** `settings.json` */
    interface SettingsConfig {
        region?: {
            culture?: string;
            isoShort?: string;
            date?: string;
            timeZone?: string;
        };
        server?: {
            engine?: 'isaac' | 'express';
            protocol?: string;
            scheme?: string;
            allowHTTP1?: boolean;
            warmup?: number;
        };
        ioServer?: {
            integrationMode?: string;
            transports?: string[];
            pingInterval?: number;
            pingTimeout?: number;
        };
        upload?: {
            maxFieldsSize?: number;
        };
        response?: {
            header?: Record<string, string>;
        };
        http2Options?: {
            maxConcurrentStreams?: number;
            initialWindowSize?: number;
        };
    }

    /** A single bundle entry in `manifest.json` */
    interface ManifestBundle {
        version: string;
        tag?: string;
        gina_version?: string;
        src: string;
        link?: Record<string, string>;
        releases?: Record<string, string>;
    }

    /** `manifest.json` */
    interface ManifestConfig {
        name: string;
        version: string;
        scope: string;
        rootDomain: string;
        bundles: Record<string, ManifestBundle>;
    }

    /** A single watcher entry in `watchers.json` */
    interface WatcherEntry {
        event?: 'change' | 'rename';
        persistent?: boolean;
    }

    /** `watchers.json` — keys are config file names */
    type WatchersConfig = Record<string, WatcherEntry>;

    /** A single cron entry in `app.crons.json` */
    interface CronEntry {
        active: boolean;
        interval: string;
        task: string;
        processingCores?: number;
    }

    /** `app.crons.json` — keys are cron names */
    type CronsConfig = Record<string, CronEntry>;

    // ─── lib registry ─────────────────────────────────────────────────────

    /**
     * The framework library registry (`require('gina').lib`). Key parity
     * with `framework/v<version>/lib/index.js` is enforced by
     * `test/lib/types-runtime-parity.test.js`.
     */
    interface GinaLib {
        /** Connector-backed audit-store dispatcher (`settings.json > audit.store`). */
        AuditStore: any;
        Cache: any;
        Collection: any;
        Config: any;
        /**
         * Per-call copy-on-write view over a shared configuration tree (#P40) —
         * what `self.getConfig()` returns in its default `view` mode: reads pass
         * through, writes land in a private overlay, enumeration materialises the
         * touched subtree once. Plain objects and arrays only; anything else comes
         * back as-is. Server-side only.
         */
        confView: {
            /** Build a view over `root`; a non-plain root (or `undefined`) comes back unchanged, a frozen root as a plain deep copy. Never throws. */
            create<T>(root: T): T;
            /** `true` for a value produced by `create()` (a materialised node's plain children are not views). */
            isView(value: unknown): boolean;
        };
        Domain: any;
        /** Job persistence dispatcher (`app.json > jobs.store`). */
        JobStore: any;
        /** Connector-backed KV namespace-store dispatcher (`settings.json > kv.namespaces.<name>.store`) (#KV1). */
        KvStore: any;
        Model: any;
        Proc: any;
        /**
         * Out-of-request push primitive (#B366) — deliver to ONE named session
         * from code with no live request. The recipient is required and this
         * API never broadcasts; `self.push(payload, { broadcast: true })` is
         * the deliberate all-clients path, and it stays in-request.
         */
        push: {
            toSession(
                instance: any,
                sessionID: string,
                payload: object | string,
                option?: { section?: string; [key: string]: any } | null,
                callback?: (err: Error | null, result?: { delivered: number }) => void
            ): void;
        };
        /** Render/output cache backing `routing.json > cache`. */
        RenderCache: any;
        /** Connector-backed render-cache L2 store dispatcher (`cache.type=redis`). */
        RenderCacheStore: any;
        SessionStore: any;
        Shell: any;
        State: any;
        /** Connector-backed storage metadata-store dispatcher (`settings.json > storage.drivers.<name>.store`). */
        StorageStore: any;
        SwigFilters: any;
        Watcher: any;
        /**
         * Admin-endpoint gates: the IP allowlist (`app.json > admin.allowFrom`)
         * and the cross-origin WRITE guard fronting the `/_gina/*` control
         * family (#B384).
         */
        admin: any;
        archiver: any;
        async: any;
        /** The audit-trail primitive behind `self.audit()` (#COMPLY2). */
        audit: any;
        /** Authentication hardening primitives — password hashing, policy, lockout, TOTP (#COMPLY3). */
        authn: any;
        /** The route authorization gate (framework-internal seam). */
        authzGate: any;
        cleanFiles: any;
        cmd: any;
        cmdStatusFormat: any;
        connectorConfig: any;
        /** Transient-vs-permanent classifier for datastore query errors — stamps `err.isTransient` / `err.transientReason` (#CE1). */
        connectorError: any;
        connectorRegistry: any;
        /** The native DTO builder (same object as `gina.dto`). */
        dto: DtoBuilder;
        /** The route-DTO validation pipe (framework-internal seam). */
        dtoPipe: any;
        /** The DTO → `.d.ts` emitter behind `gina bundle:types`. */
        dtoTypes: any;
        generator: any;
        helpers: any;
        /** i18n core (`t()`, catalog loading, culture negotiation). */
        i18n: any;
        imageBuild: any;
        inherits: (ctor: Function, superCtor: Function) => Function;
        /** Application event bus feeding the dev Inspector Events tab. */
        inspectorEvents: any;
        instrument: any;
        /** Async-job primitive behind `self.startJob()` / `/_gina/jobs/:id`. */
        job: any;
        /** General-purpose KV primitive — strict-declared namespaces behind gina.kv() (`settings.json > kv`) (#KV1). */
        kv: any;
        jsonConfigHeader: any;
        logger: any;
        /**
         * Maintenance-mode primitive (#MAINT1) behind the pre-routing gate on
         * both engines — `settings.json > server.maintenance`.
         */
        maintenance: any;
        math: any;
        mcpDispatch: any;
        mcpHttp: any;
        mcpServer: any;
        /**
         * Deep merge — the TARGET (first argument) wins on collisions unless
         * `override` is `true`; returns the mutated first argument.
         */
        merge: (target: object, source: object, override?: boolean) => object;
        /**
         * Exact-money primitive (#FIN5) — ISO 4217 minor-unit integer
         * arithmetic, BigInt-safe. Amounts are `{ currency, exponent, minor }`
         * where `minor` is a bigint; wire strings in and out, no floats.
         * Display formatting stays with the i18n layer (`Intl.NumberFormat`).
         */
        money: {
            /** Minor-unit exponent for an ISO 4217 code (default 2; JPY 0, BHD 3, ...). */
            exponent(code: string): number;
            /** Parse a canonical wire string ("19.99"); rejects floats and excess precision. */
            parse(value: string, code: string): { currency: string; exponent: number; minor: bigint };
            /** Build an amount from an integer minor-unit count. */
            fromMinor(minor: string | number | bigint, code: string): { currency: string; exponent: number; minor: bigint };
            /** Exact addition — same currency only, throws on mismatch. */
            add(a: object, b: object): { currency: string; exponent: number; minor: bigint };
            /** Exact subtraction (a - b) — same currency only, throws on mismatch. */
            subtract(a: object, b: object): { currency: string; exponent: number; minor: bigint };
            /** Exact multiplication by an INTEGER factor (fractional rates are the app's rounding). */
            multiply(a: object, factor: string | number | bigint): { currency: string; exponent: number; minor: bigint };
            /** Three-way comparison — same currency only, throws on mismatch. */
            compare(a: object, b: object): -1 | 0 | 1;
            /** Canonical wire string with exactly the currency's fraction digits ("20.00"). */
            format(a: object): string;
            /** Minor-unit count as a JSON-safe decimal string. */
            toMinor(a: object): string;
        };
        /**
         * `multipart/form-data` body encoder (#B489) — the request parser's
         * inverse: nested text fields plus `req.files` staging records become
         * one body under a fresh boundary, for `self.query()`'s `body` option
         * (what `self.forward()` relays uploads with). Server-side only.
         */
        multipart: {
            /**
             * Encode fields + files into a Buffer body. `options.maxSize` (bytes) is
             * checked against field bytes + on-disk file sizes BEFORE any read.
             * Throws coded Errors: `MULTIPART_BAD_INPUT`, `MULTIPART_TOO_LARGE`
             * (`.size`, `.limit`), `MULTIPART_FILE_UNREADABLE` (`.path`), `MULTIPART_BOUNDARY`.
             */
            encode(input?: { fields?: object; files?: object[] }, options?: { maxSize?: number; boundary?: string }): { contentType: string; body: Buffer; length: number; boundary: string };
            /** Flatten a nested fields object to ordered `[name, value]` pairs in bracket notation — the inverse of the parser's nesting. */
            flatten(fields?: object): Array<[string, string]>;
        };
        /** Prometheus metrics primitive behind `/_gina/metrics`. */
        metrics: any;
        /** Control-plane dial-host resolution — `bind_host` vs `host_v4` locality (#B160). */
        netLocality: any;
        nunjucksFilters: any;
        nunjucksResolver: any;
        /** Identified-caller quota gate — fixed-window counters over the kv primitive, run by the router between authz and the DTO pipe (#MS6). */
        rateLimit: any;
        idempotency: any;
        /** Message-schema validation seam — application-supplied validators registered at boot, gated at the router band ahead of the DTO pipe (#FIN3). */
        messageValidator: any;
        /** Stale built-release watch primitives — source-tree fingerprints, change classification, busy probes and the in-flight request gauge (#RWATCH). */
        releaseWatch: any;
        routing: {
            getRoute(name: string): RouteEntry | undefined;
            getRouteByUrl(url: string): RouteEntry | undefined;
            [key: string]: any;
        };
        routingIntrospect: any;
        /** `${secret:KEY}` config placeholder resolver. */
        secrets: any;
        /**
         * Engine-agnostic security-header emission (#OW1, OWASP A02) —
         * `settings.json > server.securityHeaders`. Exists at the framework
         * layer because the `#HDR1-14` plugins are express middleware and the
         * default `isaac` engine never runs the express chain for HTTP
         * responses. First-writer-wins, so a mounted plugin or an `env.json`
         * `server.response.header` entry always beats the framework default.
         */
        securityHeadersEmitter: any;
        /**
         * Subresource Integrity attribute computation (#OW3, OWASP A08) —
         * opt-in per bundle via `templates.json > "_common" > "sriEnabled"`.
         * Fail-open: any asset that cannot be honestly hashed gets no
         * `integrity` attribute rather than a guessed one.
         */
        sri: any;
        /** Pluggable object storage — adapter x strategy behind an opaque key (`settings.json > storage`). */
        storage: any;
        swigResolver: any;
        /** Async template loaders (`settings.template.<engine>.loader`). */
        templateLoaders: any;
        uuid: any;
        wsFraming: any;
        wsQuery: any;
        wsSession: any;
    }

    // ─── The module value members ─────────────────────────────────────────
    // One entry per `gna.X = ...` assignment in core/gna.js (78 members,
    // enforced two-way by test/lib/types-runtime-parity.test.js). Members
    // assigned conditionally at runtime are typed `| undefined` — narrow
    // before use.

    // -- flags & environment (assigned during require) --

    /** Flipped to `true` once `onInitialize` has registered its hook. */
    const initialized: boolean;
    /** Flipped to `true` once `onRouting` has registered its hook. */
    const routed: boolean;
    /** Flipped to `true` once the HTTP server is listening. */
    const started: boolean;
    /** `true` while a fatal abort is in progress. */
    const isAborting: boolean;
    /** Active environment (`NODE_ENV`). */
    const env: string;
    /** Active scope (`NODE_SCOPE`). */
    const scope: string;
    /** The project root path. */
    const executionPath: string;
    /** The parsed project manifest. */
    const project: ManifestConfig;
    /** The framework library registry. */
    const lib: GinaLib;
    /** The native DTO builder (`require('gina').dto`). */
    const dto: DtoBuilder;
    /** Locales module. */
    const locales: any;
    /** Plugins registry (`Validator`, `Session`, `Csrf`, security headers, ...). */
    const plugins: any;

    // -- conditionally-assigned state (narrow before use) --

    /** The started WatcherService — only set in dev/watch mode after server start. */
    const watcher: any;
    /** Set to `true` only once an `onError` handler has been registered. */
    const errorCatched: boolean | undefined;
    /** Reverse-proxy host (scheme/port stripped) — only when a proxy config supplies a hostname. */
    const proxyHost: string | undefined;
    /** Reverse-proxy full hostname — only when a proxy config supplies a hostname. */
    const proxyHostname: string | undefined;
    /** Reverse-proxy port — only when a proxy config resolves. */
    const proxyPort: number | undefined;
    /** Reverse-proxy scheme — only when a proxy config resolves. */
    const proxyScheme: string | undefined;

    // -- lifecycle hooks (assigned synchronously during require in a bundle context) --

    /**
     * Called after models are loaded and connectors are ready.
     * @param callback - `(event, instance, middleware) => void`
     */
    function onInitialize(callback: (event: EventEmitter, instance: any, middleware: any) => void): void;

    /** Called when the HTTP server is listening */
    function onStarted(callback: () => void): void;

    /**
     * Called on every incoming request after routing resolves.
     * @param callback - `(event, request, response, next, params) => void`
     */
    function onRouting(callback: (event: EventEmitter, request: GinaRequest, response: GinaResponse, next: NextFunction, params: object) => void): void;

    /** Called on framework-level errors (persistent handler). */
    function onError(callback: (err: Error, request?: GinaRequest, response?: GinaResponse, next?: NextFunction) => void): void;

    /** Start the bundle server */
    function start(): void;
    /** Stop the bundle process */
    function stop(pid?: number, code?: number): void;
    /** Check bundle status */
    function status(bundle?: string): void;
    /** Restart the bundle */
    function restart(): void;

    /**
     * Bundle-aware config accessor. ONLY assigned once the bundle's models
     * have loaded (inside the init phase triggered by `onInitialize`) —
     * `undefined` before that point; narrow before calling.
     */
    const getConfig: ((name?: string) => any) | undefined;

    /**
     * ⚠ An inert stub: always returns `false`, never dispatches, never
     * throws — the internal lifecycle emitter is not exposed and the module
     * object has no listener surface. Kept for parity with the runtime
     * surface only — do not rely on it; application events go through the
     * controller's `emitEvent()`.
     */
    const emit: (eventName: string | symbol, ...args: any[]) => boolean;

    /** Translate a key via a bundle's i18n catalogs (explicit culture/bundle via `options`). */
    const t: GnaTranslate;

    // -- project / bundle introspection --

    /** Get the parsed manifest as a project object */
    function getProjectConfiguration(callback: (err: Error | null, project: ManifestConfig) => void): void;

    /** Mount a bundle via symlink */
    function mount(bundlesPath: string, source: string, target: string, type?: string, callback?: (err: Error | null) => void): void;

    /** Read connector shutdown config (async) */
    function getShutdownConnector(callback: (err: Error | null, config: object) => void): void;
    /** Read connector shutdown config (sync) */
    function getShutdownConnectorSync(): object | undefined;

    /** List mounted bundles (async) */
    function getMountedBundles(callback: (err: Error | null, bundles: string[]) => void): void;
    /** List mounted bundles (sync) */
    function getMountedBundlesSync(): string[] | string;

    /** Get running bundle PIDs: `[bundlePids, ginaPids]` */
    function getRunningBundlesSync(): [string[], string[]];

    /** Read bundle version from app.json */
    function getVersion(bundle?: string): string | Error | undefined;

    /** Register an application busy probe for the release-watch idle gate — returns `{busy, detail}` | boolean (or a Promise of either), or callback-shaped `(cb)` (#RWATCH). */
    function registerBusyProbe(name: string, fn: (...args: any[]) => any): void;

    /** Get a configured object-storage driver; omit `name` for `storage.default`. Throws when storage is unconfigured or the name is unknown (#STO1). */
    function storage(name?: string): any;

    /** Get a configured KV namespace; omit `name` for `kv.default`. Throws when kv is unconfigured or the name is unknown (#KV1). */
    function kv(name?: string): any;

    /**
     * Push a payload to ONE named session from outside a request (#B366) — for
     * code with no live controller (job handlers, cron, boot hooks).
     *
     * `sessionID` is required: an absent recipient is an error, never a
     * fan-out. This API cannot broadcast at all — the deliberate all-clients
     * send stays in-request as `self.push(payload, { broadcast: true })`.
     * Source the recipient from server-held state, never from client input.
     *
     * `delivered` counts the sockets written; `0` is a normal outcome.
     * Needs the isaac engine with `server.ioServer` attached.
     */
    function pushToSession(
        sessionID: string,
        payload: object | string,
        option?: { section?: string; [key: string]: any } | null,
        callback?: (err: Error | null, result?: { delivered: number }) => void
    ): void;
    function pushToSession(
        sessionID: string,
        payload: object | string,
        callback: (err: Error | null, result?: { delivered: number }) => void
    ): void;

    // -- global-helper re-exports (same functions the framework injects on
    //    the global scope; see types/globals.d.ts) --

    const _: typeof globalThis._;
    const __: typeof globalThis.__;
    const ApiError: ApiErrorConstructor;
    const define: typeof globalThis.define;
    const defineDefault: typeof globalThis.defineDefault;
    const encodeRFC5987ValueChars: typeof globalThis.encodeRFC5987ValueChars;
    const filterArgs: typeof globalThis.filterArgs;
    const formatDataFromString: typeof globalThis.formatDataFromString;
    const getBundleStartingArgv: typeof globalThis.getBundleStartingArgv;
    const getContext: typeof globalThis.getContext;
    const getDefined: typeof globalThis.getDefined;
    const getEnvVar: typeof globalThis.getEnvVar;
    const getEnvVars: typeof globalThis.getEnvVars;
    const getLib: typeof globalThis.getLib;
    const getLogDir: typeof globalThis.getLogDir;
    const getModel: typeof globalThis.getModel;
    const getModelEntity: typeof globalThis.getModelEntity;
    const getPath: typeof globalThis.getPath;
    const getPaths: typeof globalThis.getPaths;
    const getProtected: typeof globalThis.getProtected;
    const getRunDir: typeof globalThis.getRunDir;
    const getTmpDir: typeof globalThis.getTmpDir;
    const getUserHome: typeof globalThis.getUserHome;
    const getVendorsConfig: typeof globalThis.getVendorsConfig;
    const importEnvVars: typeof globalThis.importEnvVars;
    const isWin32: typeof globalThis.isWin32;
    const joinContext: typeof globalThis.joinContext;
    const log: typeof globalThis.log;
    const merge: typeof globalThis.merge;
    const onCompleteCall: typeof globalThis.onCompleteCall;
    const parseTimeout: typeof globalThis.parseTimeout;
    const requireJSON: typeof globalThis.requireJSON;
    const resetContext: typeof globalThis.resetContext;
    const run: typeof globalThis.run;
    const safeDecodeURI: typeof globalThis.safeDecodeURI;
    const safeDecodeURIComponent: typeof globalThis.safeDecodeURIComponent;
    const setContext: typeof globalThis.setContext;
    const setEnvVar: typeof globalThis.setEnvVar;
    const setPath: typeof globalThis.setPath;
    const setPaths: typeof globalThis.setPaths;
    const setVendorsConfig: typeof globalThis.setVendorsConfig;
    const whisper: typeof globalThis.whisper;

    // ─── Back-compat module type alias ────────────────────────────────────

    /** The type of the whole module object (`require('gina')`). */
    type Gna = typeof gina;
}

export = gina;
