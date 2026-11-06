/* Gina.Lib.Generator
 *
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs = require('fs');

// #CN2v3 — Capture the state module reference at module-load time, when
// __dirname is still valid. The cached reference survives later framework-
// dir renames (e.g. post_publish.js bumpVersion renames framework/v<old>/
// → framework/v<new>/), whereas a runtime `require('../state')` would
// re-resolve `__dirname + '/../state.js'` against the on-disk path that
// no longer exists, throw MODULE_NOT_FOUND, and silently fall through to
// the legacy JSON-only write — leaving gina.db drifted behind main.json
// on every alpha bump.
var _stateModule;
try { _stateModule = require('../state'); } catch (_) { _stateModule = null; }

// #B43 — monotonic counter for unique same-process atomic-write temp filenames
// (createFileFromDataSync's legacy path writes a temp + renames to stay tear-free).
var _atomicWriteSeq = 0;

/**
 * @class Generator
 *
 * Generator Class
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Generator
 * @author      Rhinostone <contact@gina.io>
 * */
var Generator = {
    createFileFromTemplate : function(source, target, callback){

        fs.readFile(source, function(err, data){
            if (err) throw err;
            //Removing existing files.
            if(fs.existsSync(target)){
                //Just in case.
                fs.chmodSync(target, 0755);

                if ( fs.unlinkSync ) {
                    fs.unlinkSync(target)
                } else {
                    fs.unlink(target);
                }
            }
            fs.writeFile(target, data, function(err, data){
                setTimeout( function onChmod(){
                    if (err) throw err;
                    //Setting permission.
                    fs.chmodSync(target, 0755);
                    if ( typeof(callback) != 'undefined') callback(err)
                }, 1000)
            });
        });
    },
    /**
     * Create file form template sync
     * Added to support node v5.5.0
     * */
    createFileFromTemplateSync : function(source, target) {
        var data = fs.readFileSync(source);
        if (data instanceof Error) {
            throw data
        } else {
            if (fs.existsSync(target)) {
                //Just in case.
                fs.chmodSync(target, 0755);

                if ( fs.unlinkSync ) {
                    fs.unlinkSync(target)
                } else {
                    fs.unlink(target);
                }
            }

            fs.writeFileSync(target, data);

            //Setting permission.
            try {
                fs.chmodSync(target, 0755)
            } catch (err) {} // file not found
        }
    },
    createFileFromDataSync : function(data, target){
        // #CN2v3 — route known ~/.gina/ state files through StateStore for
        // atomic SQLite write + JSON sidecar. Skipped silently when the
        // module wasn't loadable at startup (Node < 22.5.0, older framework
        // versions). Unexpected runtime errors are logged — the previous
        // empty catch silently hid the bumpVersion gina.db drift across
        // multiple alpha cuts.
        if (_stateModule) {
            try {
                var _store = _stateModule.getInstance();
                if (_store.isStatePath(target)) {
                    var _data = (typeof data === 'object') ? data : JSON.parse(data);
                    if (_store.write(target, _data)) return;
                    // write() returned false → SQLite unavailable, fall through
                }
            } catch(stateErr) {
                console.warn('[generator] StateStore write failed for ' + target + ': ' + (stateErr.message || stateErr));
            }
        }

        // Legacy JSON write (non-state files, or SQLite unavailable).
        // #B43 — write ATOMICALLY: a same-dir temp + rename, so a concurrent reader
        // never observes a truncated/empty file (a bare fs.writeFileSync truncates the
        // target in place; a concurrent boot read of the partial JSON crashes FATALLY).
        // rename(2) is atomic within a filesystem; the temp is a sibling of the target.
        data = (typeof(data) == "object") ? JSON.stringify(data, null, 4) : data;
        var _tmp = target + '.' + process.pid + '.' + (_atomicWriteSeq++) + '.tmp';
        try {
            fs.writeFileSync(_tmp, data);
            fs.chmodSync(_tmp, 0755);
            fs.renameSync(_tmp, target);
        } catch (writeErr) {
            try { fs.unlinkSync(_tmp); } catch(unlinkErr) {}
            throw writeErr;
        }
    },
    // createFoldersFromStructureSync : function(structure){
    // },
    /**
     * Creates a directory path recursively (mkdir -p semantics), then calls
     * back.
     *
     * #B381 — was a per-segment exists/mkdir walk: two processes creating the
     * same path concurrently raced each check-then-create and the loser threw
     * EEXIST. `recursive: true` never throws on an existing directory, so the
     * race disappears; the callback contract is unchanged.
     *
     * @param {string} path - Directory path to create
     * @param {function} callback - `function(err)` — called with `false` on success
     */
    createPathSync : function(path, callback) {
        try {
            fs.mkdirSync( path.replace(/\\/g, '/'), { recursive: true } );
            callback(false);
        } catch (err) {
            callback(err);
        }
    }
};

module.exports = Generator