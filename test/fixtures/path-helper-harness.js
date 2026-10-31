/**
 * Shared by the `helpers/path.js` settle tests (#B1045, #B1046, #B1047, #B1048).
 *
 * Every arm drives the real helpers on the real filesystem. A vanishing path is timed by a wrapper
 * on the `fs` call that opens the window, so an arm depends on timing only where it says so. A
 * process-level throw is read through the `uncaughtException` listeners, swapped for each arm.
 *
 * Red first: `GINA_PATH_HELPER_SRC=<a copy of another helpers/path.js>` serves that copy in place of
 * the tree's (`git show <parent>:<framework dir>/helpers/path.js`).
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var Module = require('module');

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var FW = path.join(ginaRoot, 'framework', 'v' + version);

var work;
var seq = 0;

/**
 * Loads the real helpers, which inject the global `_()`, and makes the arms' work directory.
 *
 * @returns {void}
 */
function load() {
    if (process.env.GINA_PATH_HELPER_SRC) {
        var served = fs.readFileSync(process.env.GINA_PATH_HELPER_SRC, 'utf8');
        var realJs = Module._extensions['.js'];
        Module._extensions['.js'] = function (m, filename) {
            if ( filename === path.join(FW, 'helpers', 'path.js') ) {
                return m._compile(served, filename);
            }
            return realJs(m, filename);
        };
    }
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    Module.Module._initPaths();
    require(path.join(FW, 'helpers'));
    require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-path-helper-'));
}

/**
 * Removes the arms' work directory.
 *
 * @returns {void}
 */
function unload() {
    fs.rmSync(work, { recursive: true, force: true });
}

/**
 * @returns {string} a new, empty directory for one arm
 */
function trialDir() {
    var dir = path.join(work, 't' + (++seq));
    fs.mkdirSync(dir);
    return dir;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Runs `fn` with the process-level listeners swapped, and returns what reached them.
 *
 * @param {function(): Promise} fn
 * @returns {Promise<Error[]>} the errors that reached the process
 */
async function processLevel(fn) {
    var saved = process.listeners('uncaughtException');
    var seen = [];
    var rec = function (err) { seen.push(err); };
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', rec);
    try {
        await fn();
        // a throw from the last async callback lands after the callback it replaced would have
        await wait(30);
    } finally {
        process.removeListener('uncaughtException', rec);
        saved.forEach(function (l) { process.on('uncaughtException', l); });
    }
    return seen;
}

/**
 * A call's callback, recording each settle. `done()` resolves on the first one, or after `ms`.
 *
 * @param {number} [ms] - How long to wait for a callback (default 800)
 * @returns {{cb: function, calls: Array, done: function(): Promise<void>, firstError: function(): *}}
 */
function recorder(ms) {
    var calls = [];
    var wake = null;
    return {
        calls: calls,
        cb: function (err) {
            calls.push({ err: err });
            if (wake) { wake(); wake = null; }
        },
        done: function () {
            if (calls.length) { return Promise.resolve(); }
            return new Promise(function (resolve) {
                wake = resolve;
                setTimeout(function () { resolve(); }, ms || 800);
            });
        },
        firstError: function () {
            return calls[0] && calls[0].err;
        }
    };
}

/**
 * Wraps an `fs` function for one arm: `hook(args)` runs before the real call, or before the real
 * callback when `when` is `'after'`, on the calls `match(args)` selects.
 *
 * @param {string} name - The `fs` function
 * @param {function(Array): boolean} match
 * @param {function(Array): void} hook
 * @param {string} [when] - `'after'`
 * @returns {function(): void} the restore
 */
function wrapFs(name, match, hook, when) {
    var real = fs[name];
    fs[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        if ( !match(args) ) { return real.apply(fs, args); }
        if (when === 'after') {
            var cb = args[args.length - 1];
            args[args.length - 1] = function () {
                hook(args);
                cb.apply(null, arguments);
            };
            return real.apply(fs, args);
        }
        hook(args);
        return real.apply(fs, args);
    };
    return function () { fs[name] = real; };
}

module.exports = {
    // Permission arms read nothing as root, which ignores the modes they set
    asRoot: typeof(process.getuid) == 'function' && process.getuid() === 0,
    load: load,
    unload: unload,
    trialDir: trialDir,
    wait: wait,
    processLevel: processLevel,
    recorder: recorder,
    wrapFs: wrapFs
};
