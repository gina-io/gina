'use strict';
// Imports
const fs                  = require('fs');
const util                = require('util');
//const {EventEmitter}             = require('events');
const net                 = require('net');
// var promisify           = util.promisify;
// const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// const { execSync }      = require('child_process');

var helpers = null;

// #M22 — merge-eval fallback removed (sister fix to lib/merge/src/main.js direct json_clone require)
var merge     = require(__dirname + '/../../../../merge');
// #B160 — control-plane dial-host resolution (pure, no framework globals)
var netLocality = require(__dirname + '/../../../../net-locality');

function FileContainer(opt, loggers) {
    var self = {
        // flow or container name/id
        name: 'file'
    };

    var mqId = 'MQ'+ self.name.substring(0,1).toLocaleUpperCase() + self.name.substring(1);

    helpers         = require(__dirname +'/../../../../../helpers');


    var loggerHelper    = require(__dirname +'/../../helper.js')(opt, loggers);
    var format          = loggerHelper.format;
    var processProperties = null;
    var filenames   = {};

    // ── Rotation ────────────────────────────────────────────────────────────
    //
    // Options arrive as `opt.rotate`: loadContainers() merges this container's
    // own `~/.gina/user/extensions/logger/file/config.json` over the logger
    // options with override:true (lib/logger/src/main.js), so the sink is
    // configured where it is enabled — at the machine level, matching the
    // per-host file it writes (`<logdir>/<webroot><host>.log`).
    //
    // Mechanism is rename-then-reopen, NOT copy-then-truncate. This process owns
    // the descriptor, so renaming the file and opening a fresh one loses
    // nothing. The retired vendored rotator copied then truncated, which drops
    // every line appended during the copy window — a window that grows with the
    // file, so the bigger the log the more it lost.
    //
    // Defaults are ON at 10MB x 5, deliberately mirroring the kubelet's
    // containerLogMaxSize/containerLogMaxFiles, because this sink appends
    // without bound otherwise and a silent unbounded file is the worst of the
    // available behaviours.
    var DEFAULT_ROTATE = {
        enabled : true,
        when    : 'daily',
        size    : '10MB',
        count   : 5,
        maxAge  : null
    };

    /**
     * Parse a size string (`'10MB'`, `'512KB'`, `'1.5GB'`) into bytes.
     *
     * Mirrors the convention of `lib/storage/src/util.js parseSize` on purpose:
     * a unit is REQUIRED and a bare number is refused, so a value can never be
     * silently read as bytes when megabytes were meant. The convention is
     * mirrored rather than imported because the logger is constructed during
     * bootstrap and stays dependency-minimal.
     *
     * @inner
     * @param {string} value - Size with an explicit unit.
     * @returns {number} Bytes, or NaN when unparseable.
     */
    function parseSize(value) {
        if ( typeof(value) != 'string' ) return NaN;
        var m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\s*$/i.exec(value);
        if (!m) return NaN;
        var mult = { b:1, kb:1024, mb:1048576, gb:1073741824, tb:1099511627776 };
        return Math.floor( parseFloat(m[1]) * mult[ m[2].toLowerCase() ] );
    }

    /**
     * Parse an age string (`'30d'`, `'12h'`) into milliseconds.
     *
     * @inner
     * @param {string} value - Age with an explicit unit.
     * @returns {number} Milliseconds, or NaN when unparseable.
     */
    function parseAgeMs(value) {
        if ( typeof(value) != 'string' ) return NaN;
        var m = /^\s*([0-9]+)\s*(h|d|w)\s*$/i.exec(value);
        if (!m) return NaN;
        var mult = { h:3600000, d:86400000, w:604800000 };
        return parseInt(m[1], 10) * mult[ m[2].toLowerCase() ];
    }

    /**
     * Resolve and validate the rotation options once per group.
     *
     * Invalid values REFUSE LOUDLY rather than falling back to a default: a
     * rotation policy that silently did something other than what was written
     * is how a log directory fills a disk. The refusal disables rotation for
     * that group and says so on stdout, which is visible in `docker logs` and
     * under `gina tail` alike.
     *
     * @inner
     * @returns {object} Resolved options; `enabled:false` when refused.
     */
    function resolveRotate(group) {
        // Resolved explicitly, key by key, rather than through lib/merge: this is
        // a small fixed set of scalars, and an unset key must fall back to the
        // default deterministically. `opt.rotate` arrives from a user-authored
        // JSON file, so it may be absent, partial, or not an object at all.
        var user = ( opt.rotate && typeof(opt.rotate) == 'object' && !Array.isArray(opt.rotate) )
                    ? opt.rotate : {};
        // OWN properties only — a `typeof(user.<key>) != 'undefined'` guard is
        // WRONG here, and silently so. The repo-root `utils/prototypes.js` installs
        // `Object.prototype.count` + `functionCount` and `Array.prototype.clone` +
        // `inArray` the moment it is REQUIRED — unguarded — so ANY object, `{}`
        // included, answers `typeof user.count === 'function'`. (`count` is the
        // own-property counter behind idioms like `forwardList.count()` in the MQ
        // listener.) Do NOT cite or patch `helpers/prototypes.js`: it declares the
        // same names, but its guard is `typeof(Object.count) == 'undefined'`, and
        // `Object` inherits through Function.prototype to Object.prototype — so once
        // utils/ has run, the guard reads 'function' and every declaration there is
        // skipped. The trap defeats its own guard. A typeof guard
        // therefore hands the inherited METHOD back as the configured value;
        // `~~(function)` is 0, and rotation refuses itself with "keeps no files"
        // on a perfectly valid default. It is defined `enumerable: false`, so
        // `Object.keys(user)` still reports `[]` and `JSON.stringify` drops the
        // function — which is why the failure reads as "count is undefined" and
        // why an isolated repro outside the framework cannot reproduce it at all.
        // Measured on a live boot, not reasoned from the source.
        var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
        var cfg = {};
        cfg.enabled = has(user, 'enabled') ? user.enabled : DEFAULT_ROTATE.enabled;
        cfg.when    = has(user, 'when')    ? user.when    : DEFAULT_ROTATE.when;
        cfg.size    = has(user, 'size')    ? user.size    : DEFAULT_ROTATE.size;
        cfg.count   = has(user, 'count')   ? user.count   : DEFAULT_ROTATE.count;
        cfg.maxAge  = has(user, 'maxAge')  ? user.maxAge  : DEFAULT_ROTATE.maxAge;
        if ( cfg.enabled === false ) return { enabled: false };

        var refuse = function(why) {
            process.stdout.write( format(opt.name, 'warn',
                '['+ mqId +'] log rotation DISABLED for `'+ group +'`: '+ why
                + ' — the file will grow without bound until this is corrected.') );
            return { enabled: false };
        };

        var bytes = null;
        if ( cfg.size !== null && typeof(cfg.size) != 'undefined' ) {
            bytes = parseSize(cfg.size);
            if ( isNaN(bytes) || bytes <= 0 ) {
                return refuse('`rotate.size` is '+ JSON.stringify(cfg.size)
                    + ', which is not a size with an explicit unit (e.g. "10MB")');
            }
        }
        var ageMs = null;
        if ( cfg.maxAge !== null && typeof(cfg.maxAge) != 'undefined' ) {
            ageMs = parseAgeMs(cfg.maxAge);
            if ( isNaN(ageMs) || ageMs <= 0 ) {
                return refuse('`rotate.maxAge` is '+ JSON.stringify(cfg.maxAge)
                    + ', which is not an age with an explicit unit (e.g. "30d")');
            }
        }
        var count = ~~(cfg.count);
        if ( count < 1 ) {
            return refuse('`rotate.count` is '+ JSON.stringify(cfg.count) +', which keeps no files');
        }
        if ( cfg.when !== null && typeof(cfg.when) != 'undefined' && !/^daily$/i.test(cfg.when) ) {
            return refuse('`rotate.when` is '+ JSON.stringify(cfg.when) +', expected "daily" or null');
        }
        if ( bytes === null && (cfg.when === null || typeof(cfg.when) == 'undefined') ) {
            return refuse('neither `rotate.size` nor `rotate.when` is set, so nothing would ever trigger');
        }
        return {
            enabled : true,
            bytes   : bytes,
            ageMs   : ageMs,
            count   : count,
            daily   : ( cfg.when !== null && typeof(cfg.when) != 'undefined' )
        };
    }

    /**
     * Open (or reopen) the append stream for a group and record its size.
     *
     * @inner
     */
    function openStream(entry) {
        var size = 0;
        try { size = fs.statSync(entry.filename).size; } catch (statErr) { size = 0; }
        entry.size   = size;
        entry.day    = new Date().toISOString().slice(0, 10);
        entry.stream = fs.createWriteStream(entry.filename, { flags: 'a' });
        entry.stream.on('error', function (streamErr) {
            process.stdout.write( format(opt.name, 'err',
                '['+ mqId +'] log write failed on `'+ entry.filename +'`: '+ streamErr.message) );
        });
        return entry.stream;
    }

    /**
     * Rotate a group's file: close the stream, cascade `.1..N`, rename the live
     * file to `.1`, prune by age, then reopen. Failure is non-fatal by design —
     * losing rotation is preferable to losing the log line that triggered it, so
     * on error the current stream is reopened and writing continues.
     *
     * @inner
     */
    function rotateNow(entry) {
        var f = entry.filename, keep = entry.rotate.count;
        try {
            if (entry.stream) { entry.stream.end(); entry.stream = null; }

            try { fs.unlinkSync(f + '.' + keep); } catch (e) { /* absent is fine */ }
            for (var i = keep - 1; i >= 1; i--) {
                try { fs.renameSync(f + '.' + i, f + '.' + (i + 1)); } catch (e) { /* absent is fine */ }
            }
            fs.renameSync(f, f + '.1');

            if (entry.rotate.ageMs) {
                var cutoff = Date.now() - entry.rotate.ageMs;
                for (var n = 1; n <= keep; n++) {
                    try {
                        if ( fs.statSync(f + '.' + n).mtimeMs < cutoff ) { fs.unlinkSync(f + '.' + n); }
                    } catch (e) { /* absent is fine */ }
                }
            }
        } catch (rotErr) {
            process.stdout.write( format(opt.name, 'warn',
                '['+ mqId +'] log rotation failed for `'+ f +'`: '+ rotErr.message
                + ' — continuing to write to the current file.') );
        }
        openStream(entry);
    }


    /**
     * Resolves the framework's connection settings for the file container.
     *
     * Runs before the framework globals are guaranteed to exist (see the
     * "hack for early calls" block below), so every global read is guarded.
     *
     * @inner
     * @param {object} opt - Logger options; mqPort/hostV4/bindHost are filled in here.
     * @returns {void}
     *
     * @example
     * init({ });
     */
    function init(opt) {

        // ---------- BO - hack for early calls
        var isWin32         = (process.platform === 'win32') ? true : false;
        var binPath         = __dirname +'/../../../../../../../';
        var ginaPath        = (binPath.replace(/\\/g, '/')).replace('/bin', '');
        ginaPath = (isWin32) ? ginaPath.replace(/\//g, '\\') : ginaPath;
        // loading pack
        var pack            = ginaPath + '/package.json';
        pack = (isWin32) ? pack.replace(/\//g, '\\') : pack;
        var packObj         = require(pack);
        var version         = packObj.version;// jshint ignore:line
        // var frameworkPath   = ginaPath + '/framework/v' + version;


        var shortVersion = version.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');

        var settings = { mq_port: 8125, host_v4: '127.0.0.1' };
        try {
            // #B160-sibling (3) — honour GINA_HOMEDIR so an isolated home resolves
            // its OWN settings instead of the invoking user's. The variable already
            // carries the `/.gina` segment (bin/cli, bin/gina-init both compose it
            // as `home + '/.gina'`), so it replaces that whole prefix, not just the
            // home.
            // Three tiers, and process.env is load-bearing rather than defensive:
            // this container is constructed BEFORE bin/cli imports the OS env into
            // process.gina (measured: process.gina is empty here, while
            // process.env.GINA_HOMEDIR still holds the value), so the framework-env
            // tier alone would never fire on the CLI path. Framework env still wins
            // where it is populated (bundle processes, gina-container), matching the
            // two-tier read used by the secrets backend and resolveHttpHost.
            var _ginaHome = (typeof getEnvVar === 'function' && getEnvVar('GINA_HOMEDIR'))
                || process.env.GINA_HOMEDIR
                || (getUserHome() + '/.gina');
            settings = require( _ginaHome + '/' + shortVersion + '/settings.json');
        } catch (err) {}

        opt.mqPort = settings.mq_port;
        opt.hostV4 = settings.host_v4;
        // #B160 — carry the daemon's bind address for the dial-host
        // resolution in onPayload().
        opt.bindHost = settings.bind_host;
        // ---------- EO - hack for early calls

        // handle server not started yet or server exited
        // process.on('gina#mqlistener-started', function onGinaStarted(mqPort, hostV4, group) {
        //     if (group) {
        //         console.info('[MQFile] Group `'+group+'` connected `'+ hostV4 +'` on port `'+ mqPort +'` :)');
        //     }
        //     clearInterval(nIntervId);
        //     nIntervId = null;
        //     onPayload({mqPort: mqPort, hostV4: hostV4});
        // });

        process.on('gina#bundle-logging', function onBundleStarted(mqPort, hostV4, group) {
            console.debug('[MQFile] resuming ...')
            if (group) {
                console.info('[MQFile] Group `'+group+'` connected `'+ hostV4 +'` on port `'+ mqPort +'` :)');
            }
            // only if tail not already running !! Or you will get duplicate logs
            onPayload({mqPort: mqPort, hostV4: hostV4}, true);
        });

        onPayload(opt);

        // ----------------------------Debug---------------------------------------
        var level = 'debug';
        // Init debugging - Logs not in hierarchy will just be ignored
        if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels[level].code) > -1) {
            process.emit('logger#'+self.name, JSON.stringify({
                group       : opt.name,
                level       : level,
                // Raw content !
                content     : '`'+ self.name +'` logger container loaded !'
            }));
        }
        // ------------------------------------------------------------------------
    }

    function setup(group, filenames, props) {
        //var group = process.title; // gina, frontend@myproject ...
        console.log('['+ mqId +'] setting up '+ group);

        // we only want the bundle's logs
        if (
            !/\@/.test(group)
            // ||
            // props.bundles
            // && props.bundles.length == 0
            // ||
            // props.bundles
            // && props.bundles.indexOf(group) < 0
        ) {
            return
        }

        if ( !filenames[group] ) {
            filenames[group] = {}
        }
        process.stdout.write( format(opt.name, 'info', '['+ mqId +'] setting up '+ group +'\nFilenames: '+ JSON.stringify(filenames, null, 2)) );
        /// aready defiened
        if ( filenames[group].filename) {
            return
        }

        // retriving hostname
        var bfnArr = group.split(/\@/);
        var bundleName = bfnArr[0];
        var projectName = bfnArr[1];
        var homeDir = getUserHome() || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];// jshint ignore:line
        homeDir += '/.gina';
        var project = requireJSON(_(homeDir +'/projects.json', true))[projectName];// jshint ignore:line
        var projectPath = project.path;
        // console.debug('logger::file write env: ', bundleName, process.env.NODE_ENV, getEnvVar('GINA_ENV'), JSON.stringify(process.gina, null, 2) );// jshint ignore:line

        var env         = process.env.NODE_ENV || getEnvVar('GINA_ENV');// jshint ignore:line
        var scope       = process.env.NODE_SCOPE || getEnvVar('GINA_SCOPE');// jshint ignore:line
        var Config      = require(getEnvVar('GINA_CORE') + '/config');
        var conf = new Config({
            env: env,
            scope: scope,
            projectName: projectName,
            executionPath: projectPath,
            startingApp: bundleName,
            ginaPath: getEnvVar('GINA_CORE')
        }, true).getInstance(bundleName);

        var envObj      = conf.envConf[bundleName][env];// jshint ignore:line
        var webroot     = ( !/\s+|\//.test(envObj.server && envObj.server.webroot) ) ? envObj.server.webroot +'.' : '';
        var hostname    = envObj.host;
        var logDir      = getLogDir() || getEnvVar('GINA_LOGDIR');// jshint ignore:line

        filenames[group].filename = _(logDir +'/'+ webroot + hostname +'.log', true);// jshint ignore:line
        console.debug('Log group `'+ group +'` filename set to: ' + filenames[group].filename);
        process.stdout.write( format(opt.name, 'info', 'Log group `'+ group +'` filename set to: ' + filenames[group].filename) );

        // Resolve the rotation policy once, then hold the descriptor open. The
        // previous implementation re-opened the file for every single line
        // (fs.writeFile with flag 'a'), which left nothing to rename and gave
        // concurrent callbacks no ordering guarantee.
        filenames[group].rotate = resolveRotate(group);
        openStream(filenames[group]);
    }

    function onPayload(opt, isResuming) {
        // console.debug('mqFile options: ', JSON.stringify(opt, null, 2));
        var port = opt.mqPort || getEnvVar('GINA_MQ_PORT') || 8125;// jshint ignore:line
        // #B320 — like the MQ speaker, this container's listener is co-located
        // by construction, so `host_v4` (advertisement state — foreign on a
        // shared or stale `~/.gina`, incl. the value the `gina#bundle-logging`
        // event carries) is not an input of the dial. Dial what the local
        // daemon binds; env first, matching the bind side's own precedence
        // (init.js #B161) and covering the early-call construction window.
        var host = netLocality.resolveLocalDialHost(
            ((typeof getEnvVar === 'function' && getEnvVar('GINA_BIND_HOST')) || process.env.GINA_BIND_HOST || null)
            || opt.bindHost
        );// jshint ignore:line
        var clientOptions = {
            host    : host,
            port    : port,
            request : 'writeToFile'
        }
        // var loggerOptions   = console.getOptions();
        // var loggers         = console.getLoggers();
        // var loggerHelper    = LoggerHelper(loggerOptions, loggers);
        // var format          = loggerHelper.format;




        var delayedMessages = [];
        var resume = function(payload) {
            // process.stdout.write('['+ mqId +'] Resuming with group: '+ payload.group);
            var i = 0;
            while (i < delayedMessages.length) {
                let pl = delayedMessages[i];
                // debug only
                // process.stdout.write('['+ mqId +']'+ format(pl.group, pl.level, pl.content) );

                write(pl.group, format(pl.group, pl.level, pl.content) );
                i++;
            }
            delayedMessages = []
        }




        var client = net.createConnection(clientOptions, () => {
            // 'connect' listener.
            console.info('['+ mqId +'] connected to server :) on host: '+ host + ' & port: '+ port, process.argv);
            processProperties = loggerHelper.getProcessProperties();
            console.info('['+ mqId +'] process properties ', processProperties);

            process.emit('gina#container-writting', host, port);

            // send request
            client.write( JSON.stringify(clientOptions) +'\r\n');

        });


        client.on('error', (data) => {
            var err = data.toString();
            process.stdout.write( format(opt.name, 'warn', '['+ mqId +'] ' + err) );

            // allowing the framework to quit properly
            if ( /write EPIPE|read ECONNRESET|connect ECONNREFUSED/i.test(err) ) {
                process.exit(0)
            }

            // var mqPort = null;
            // nIntervId = setInterval(() => {
            //     try {
            //         mqPort = ~~(fs.readFileSync(mqPortFile).toString());
            //         if (mqPort) {
            //             process.emit('gina#mqlistener-started', mqPort, host);
            //         }
            //     } catch (fileErr) {}
            // }, 100);
        });

        var payloads = null, i = null;
        client.on('data', (data) => {

            //console.log('['+ mqId +']  (data): ' + data.toString());
            payloads = data.toString();

            // from speakers
            if ( /^(\{\"|\[\{\")/.test(payloads) ) {
                payloads = payloads.split(/\r\n/g);
                i = -1;
                while(i < payloads.length) {
                    i++;
                    let payload = payloads[i];
                    if (
                        /^\{/.test(payload) && /\}$/.test(payload)
                        || /^\[\{/.test(payload) && /\}\]$/.test(payload)
                    ) {
                        let pl = null;
                        try {
                            pl = JSON.parse(payload);
                        } catch(plErr) {
                            process.stdout.write( '['+ mqId +'] (exception) '+ payload +'\n' );
                            continue;
                        }


                        if (!pl.content) {
                            // only for debug
                            // process.stdout.write( '['+ mqId +'] (undefined content) '+ JSON.stringify(pl, null) +'\n' );

                            // updating logger context since it can run on different processes
                            if ( pl.sessionId && !clientOptions.sessionId ) {
                                clientOptions.sessionId = pl.sessionId;
                                // setting up file descriptor if not existing

                                // `processProperties.bundles` is derived from a
                                // `bundle:start <bundle> @<project>` argv shape that no
                                // bundle process ever sees: core/gna.js splices
                                // process.argv down to [ node, appPath ] when the
                                // framework is loaded through the CLI, so this list is
                                // always empty here and no filename was ever assigned —
                                // the sink connected, received lines and wrote nothing.
                                // The logger's own name IS this process' group, so use
                                // it when the argv-derived list yields nothing.
                                if ( processProperties.bundles.length > 0 ) {
                                    for ( let b = 0, bLen = processProperties.bundles.length; b < bLen; b++) {
                                        let realGroup = processProperties.bundles[b];
                                        setup(realGroup, filenames, processProperties);
                                    }
                                } else if ( /\@/.test(opt.name) ) {
                                    setup(opt.name, filenames, processProperties);
                                }

                                // acknowledging
                                client.write( JSON.stringify(clientOptions) +'\r\n');
                            }

                            if (pl.loggers) {
                                loggers = merge(loggers, pl.loggers);
                                if (delayedMessages.length > 0 /**&& /\@/.test(pl.group)*/ ) {
                                    resume(pl)
                                }
                            }
                            continue;
                        }

                        // resuming logging from another process
                        // we do not want to print twice in this case since another logger server is already running
                        if (isResuming) {
                            return
                        }

                        // only for debug
                        // process.stdout.write(  '['+ mqId +'] '+ pl.content +'\n' );

                        try {
                            // A merged process serves several groups on one port; set
                            // each one up the first time a line for it actually arrives
                            // rather than relying on the handshake having enumerated
                            // them. setup() is a no-op once the filename is defined.
                            if ( !filenames[pl.group] || !filenames[pl.group].filename ) {
                                setup(pl.group, filenames, processProperties);
                            }
                            if ( !filenames[pl.group] || !filenames[pl.group].filename ) {
                                return;
                            }
                            write(pl.group, format(pl.group, pl.level, pl.content) );

                        } catch (writeErr) {
                            // means that the related MQSpeaker is not connected yet
                            // this can happen during `bundle:start` configuration
                            // we'll then delay the output until MQSpeaker is ready
                            delayedMessages.push(pl);
                        }

                    }
                }
            }

        });
        client.on('end', () => {
            console.log('['+ mqId +'] disconnected from server');
        });
        // setInterval(() => {}, 1 << 30);
    }

    function write(group, content) {

        if ( !/\@/.test(group) || !filenames[group] ) {
            process.stdout.write( '['+ mqId +']['+ group +'] '+ content );
            return;
        }

        if ( !filenames[group].filename ) {
            //throw new Error('['+ mqId +'] No filename found!');
            process.emit('logger#'+self.name, JSON.stringify({
                group       : group,
                level       : 'error',
                // Raw content !
                content     : new Error('['+ mqId +'] No filename found!')
            }));
            return;
        }
        var entry = filenames[group];
        var buf   = Buffer.from(content);

        if ( !entry.stream ) { openStream(entry); }

        // Trigger BEFORE the write, so a line never straddles a rotation and the
        // cap is an upper bound rather than an overshoot.
        if ( entry.rotate && entry.rotate.enabled ) {
            var bySize = ( entry.rotate.bytes !== null
                        && (entry.size + buf.length) > entry.rotate.bytes
                        && entry.size > 0 );
            var byDay  = ( entry.rotate.daily
                        && entry.day !== new Date().toISOString().slice(0, 10) );
            if ( bySize || byDay ) { rotateNow(entry); }
        }

        entry.stream.write(buf);
        entry.size += buf.length;
    }



    init(opt);
}
module.exports = FileContainer;