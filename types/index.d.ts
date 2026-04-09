/**
 * Gina Framework — TypeScript declarations
 *
 * Main module declaration for `require('gina')`.
 * Also exports all public types for use in consumer projects.
 *
 * @packageDocumentation
 */

/// <reference types="node" />
/// <reference path="./globals.d.ts" />

import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Http2ServerRequest, Http2ServerResponse, ServerHttp2Stream } from 'http2';
import type { PathObject, OnCompletable, UuidFunction, LocaleResult } from './globals';

// ─── Request / Response aliases ──────────────────────────────────────────────

export type GinaRequest = (IncomingMessage | Http2ServerRequest) & {
    /** Parsed GET query-string params */
    get?: Record<string, any>;
    /** Parsed POST body */
    post?: Record<string, any>;
    /** Parsed PUT body */
    put?: Record<string, any>;
    /** Parsed PATCH body */
    patch?: Record<string, any>;
    /** Parsed DELETE body */
    delete?: Record<string, any>;
    /** Parsed HEAD query-string params */
    head?: Record<string, any>;
    /** Alias for the method-specific params (e.g. req.post on POST) */
    body?: Record<string, any>;
    /** URI params extracted by the router (`:id` segments, requirement captures) */
    params?: Record<string, string>;
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

export type GinaResponse = (ServerResponse | Http2ServerResponse) & {
    /** HTTP/2 stream when available */
    stream?: ServerHttp2Stream;
    status?: number;
};

export type NextFunction = (err?: any) => void;

// ─── SuperController ─────────────────────────────────────────────────────────

/**
 * Base controller class. Every bundle controller inherits from SuperController.
 * A fresh instance is created for each HTTP request.
 */
export class SuperController extends EventEmitter {
    name: string;
    engine: any;
    isProcessingError: boolean;

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
     * Render an HTML template (Swig engine).
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
     * @param asyncIterable - Source of chunks (strings or Buffers)
     * @param contentType - Response Content-Type (default: `'text/event-stream'`)
     */
    renderStream(asyncIterable: AsyncIterable<any>, contentType?: string): void;

    /** Send a plain-text response */
    renderTEXT(content: string | any): void;

    /**
     * Send 103 Early Hints for preloading resources.
     * @param links - Link header value(s)
     * @returns `this` for chaining
     */
    setEarlyHints(links: string | string[]): this;

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
     * Redirect to a route name, URL, or full request triplet.
     *
     * Overloads:
     * - `redirect(url: string, ignoreWebRoot?: boolean)`
     * - `redirect(routeName: string, ignoreWebRoot?: boolean)`
     * - `redirect(req, res, next)`
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
     * Make an outbound HTTP/HTTPS request.
     * @param options - Request options (host, port, path, method, headers, critical, ...)
     * @param data - Request body / query params
     * @param callback - `callback(err, result)` -- omit for Promise
     */
    query(options: QueryOptions, data?: object, callback?: (err: Error | null, result: any) => void): void | Promise<any>;

    /**
     * Download a file from a remote URL and stream it to the client.
     * @param url - Remote URL
     * @param options - Download options (file, toLocalDir, contentType, ...)
     * @param cb - Callback on completion
     */
    downloadFromURL(url: string, options?: DownloadOptions, cb?: (err: Error | null, files?: any[]) => void): Promise<void>;

    /** Download a local file to the client */
    downloadFromLocal(filename: string): void;

    /**
     * Store uploaded file(s) to a target directory.
     * @param target - Destination directory path
     * @param files - File(s) to store (defaults to all uploaded files)
     * @param cb - Callback `(err, files)`
     */
    store(target: string, files?: any, cb?: (err: Error | null, files?: any[]) => void): Promise<void>;

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
     * - `throwError(res, code, msg)`
     * - `throwError(errorObj)` where errorObj has `.status`, `.error`, `.fields`
     */
    throwError(err: Error): void;
    throwError(res: GinaResponse, code: number, msg?: string | Error): void;
    throwError(errorObj: { status?: number; error?: string; message?: string; fields?: object; flash?: object }): void;

    /** Inject per-request state (called by router -- not typically used in app code) */
    setOptions(req: GinaRequest, res: GinaResponse, next: NextFunction, options: object): void;

    /** Create an isolated test instance */
    static createTestInstance(deps?: { config?: Function; connector?: object }): SuperController;
}

// ─── EntitySuper ─────────────────────────────────────────────────────────────

export interface EntityInjected {
    config?: (bundle: string, confName: string) => any;
    connector?: any;
}

/**
 * Base entity class. Each model entity inherits from EntitySuper.
 * Entity methods return Promises with an `.onComplete(cb)` shim attached.
 */
export class EntitySuper extends EventEmitter {
    initialized: boolean;
    name: string;
    bundle: string;
    model: string;

    /**
     * @param conn - Database connection object from the connector
     * @param caller - Name of calling context (debug)
     * @param injected - Dependency overrides for unit testing
     */
    constructor(conn: any, caller?: string, injected?: EntityInjected);

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

// ─── Query / Download option shapes ──────────────────────────────────────────

export interface QueryOptions {
    host?: string;
    hostname?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    /** When `false`, HTTP/2 errors are swallowed (log-only) instead of propagating */
    critical?: boolean;
    rejectUnauthorized?: boolean;
    [key: string]: any;
}

export interface DownloadOptions {
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

// ─── Config file shapes ──────────────────────────────────────────────────────

/** A single route entry in `routing.json` */
export interface RouteEntry {
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

export interface RouteParam {
    control: string;
    file?: string;
    path?: string;
    code?: number;
    ignoreWebRoot?: boolean;
    title?: string;
}

export interface RouteCache {
    type?: string;
    ttl?: number;
    visibility?: string;
    sliding?: boolean;
    maxAge?: number;
    invalidateOnEvents?: string[];
}

/** `routing.json` — keys are route names */
export type RoutingConfig = Record<string, RouteEntry>;

/** A single connector entry in `connectors.json` */
export interface ConnectorEntry {
    connector?: 'couchbase' | 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'ai';
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
export type ConnectorsConfig = Record<string, ConnectorEntry>;

/** `app.json` */
export interface AppConfig {
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
export interface SettingsConfig {
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
export interface ManifestBundle {
    version: string;
    tag?: string;
    gina_version?: string;
    src: string;
    link?: Record<string, string>;
    releases?: Record<string, string>;
}

/** `manifest.json` */
export interface ManifestConfig {
    name: string;
    version: string;
    scope: string;
    rootDomain: string;
    bundles: Record<string, ManifestBundle>;
}

/** A single watcher entry in `watchers.json` */
export interface WatcherEntry {
    event?: 'change' | 'rename';
    persistent?: boolean;
}

/** `watchers.json` — keys are config file names */
export type WatchersConfig = Record<string, WatcherEntry>;

/** A single cron entry in `app.crons.json` */
export interface CronEntry {
    active: boolean;
    interval: string;
    task: string;
    processingCores?: number;
}

/** `app.crons.json` — keys are cron names */
export type CronsConfig = Record<string, CronEntry>;

// ─── lib registry ────────────────────────────────────────────────────────────

export interface GinaLib {
    Config: any;
    inherits: (ctor: Function, superCtor: Function) => void;
    helpers: any;
    Domain: any;
    Model: any;
    Collection: any;
    merge: (source: object, target: object) => object;
    generator: any;
    Proc: any;
    Shell: any;
    logger: any;
    math: any;
    routing: {
        getRoute(name: string): RouteEntry | undefined;
        getRouteByUrl(url: string): RouteEntry | undefined;
        [key: string]: any;
    };
    archiver: any;
    cmd: any;
    SessionStore: any;
    SwigFilters: any;
    Cache: any;
    uuid: UuidFunction;
    Watcher: any;
    async: <T = any>(emitter: OnCompletable) => Promise<T>;
    State: any;
}

// ─── Gna (main module export) ────────────────────────────────────────────────

export interface Gna extends EventEmitter {
    lib: GinaLib;
    locales: any;
    plugins: any;
    initialized: boolean;
    routed: boolean;
    started: boolean;
    env: string;
    scope: string;
    executionPath: string;
    project: ManifestConfig;
    watcher?: any;
    isAborting: boolean;

    /**
     * Called after models are loaded and connectors are ready.
     * @param callback - `(emitter, instance, middleware) => void`
     */
    onInitialize(callback: (emitter: EventEmitter, instance: any, middleware: any) => void): void;

    /** Called when the HTTP server is listening */
    onStarted(callback: () => void): void;

    /**
     * Called on every incoming request after routing resolves.
     * @param callback - `(emitter, request, response, next, params) => void`
     */
    onRouting(callback: (emitter: EventEmitter, request: GinaRequest, response: GinaResponse, next: NextFunction, params: object) => void): void;

    /** Called on framework-level errors */
    onError(callback: (err: Error, request?: GinaRequest, response?: GinaResponse, next?: NextFunction) => void): void;

    /** Get bundle config (available after onInitialize) */
    getConfig(name?: string): any;

    /** Get the parsed manifest as a project object */
    getProjectConfiguration(callback: (err: Error | null, project: ManifestConfig) => void): void;

    /** Mount a bundle via symlink */
    mount(bundlesPath: string, source: string, target: string, type?: string, callback?: (err: Error | null) => void): void;

    /** Read connector shutdown config (async) */
    getShutdownConnector(callback: (err: Error | null, config: object) => void): void;
    /** Read connector shutdown config (sync) */
    getShutdownConnectorSync(): object | undefined;

    /** List mounted bundles (async) */
    getMountedBundles(callback: (err: Error | null, bundles: string[]) => void): void;
    /** List mounted bundles (sync) */
    getMountedBundlesSync(): string[] | string;

    /** Get running bundle PIDs: `[bundlePids, ginaPids]` */
    getRunningBundlesSync(): [string[], string[]];

    /** Read bundle version from app.json */
    getVersion(bundle?: string): string | Error | undefined;

    /** Start the bundle server */
    start(): void;
    /** Stop the bundle process */
    stop(pid: number, code?: number): void;
    /** Check bundle status */
    status(bundle: string): void;
    /** Restart the bundle */
    restart(): void;
}
