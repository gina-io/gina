'use strict';
// Imports
const net = require('net');
// #B160 — control-plane dial-host resolution (pure, no framework globals)
var netLocality = require(__dirname + '/../../../../net-locality');
// var fs                  = require('fs');
// var util                = require('util');

function MQSpeaker(opt, loggers, cb) {
    var self = {
        name: 'MQSpeaker'
    };
    var loggerHelper    = require(__dirname +'/../../helper.js')(opt, loggers);
    var format          = loggerHelper.format;



    /**
     * Resolves the framework's connection settings, then starts the speaker.
     *
     * Runs before the framework globals are guaranteed to exist (see the
     * "hack for early calls" block below), so every global read is guarded.
     *
     * @inner
     * @param {object} opt - Logger options; mqPort/hostV4/bindHost are filled in here.
     * @param {function} cb - Passed through to startMQSpeaker.
     * @returns {*} Whatever startMQSpeaker() returns.
     *
     * @example
     * init({ }, function(err, speaker) { });
     */
    function init(opt, cb) {

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

        // Guard: settings.mq_port may be an unresolved template placeholder (e.g. '${}'
        // from a broken W2 migration write). Convert to int and fall back to 8125 if invalid.
        var _mqPort = ~~settings.mq_port;
        opt.mqPort = (_mqPort > 0 && _mqPort < 65536) ? _mqPort : 8125;
        opt.hostV4 = settings.host_v4;
        // #B160 — carry the daemon's bind address so startMQSpeaker() can
        // dial locally when host_v4 names one of this machine's interfaces.
        opt.bindHost = settings.bind_host;
        // ---------- EO - hack for early calls

        return startMQSpeaker(opt, cb);
    }


    /**
     * Opens the speaker's connection to the MQ listener, and KEEPS it — every
     * dial after the first is a reconnect (#B323).
     *
     * What the caller receives is a stable transport FACADE, not the socket.
     * The sole consumer (`mq/index.js`) captures this return once, at
     * logger-construction time, and holds it for the life of the process — so
     * a speaker that swapped its socket without a facade would leave that
     * consumer writing into the dead one forever. `write()` therefore
     * delegates to whichever socket is current, and reports `false` while the
     * speaker is down.
     *
     * The socket is `unref`'d: a logging transport must never be the reason a
     * process stays alive. Processes that legitimately run long hold the event
     * loop open by their own means — a bundle keeps it alive with its HTTP
     * server (`core/server.js` owns the single `listen()` call for both
     * engines) — so unref'ing costs them nothing while it stops the speaker
     * from outliving its host. The redial timer below is unref'd for exactly
     * the same reason, which is what keeps the reconnect loop from resurrecting
     * the #B276 hang in short-lived CLIs.
     *
     * @inner
     * @param {object} opt - Logger options; `mqPort`/`bindHost` are read here
     *  (`hostV4` is deliberately NOT — see the #B320 note at the dial).
     * @param {function} [cb] - Called ONCE, on the FIRST outcome only:
     *  `(false, client)` on connect, `(err)` on failure. Later reconnects — and
     *  their failures — never re-invoke it, so a caller cannot be surprised by
     *  a second settle hours into the process.
     * @returns {object} A stable transport facade: `{ write: function }`.
     *  `write()` returns the underlying socket's backpressure boolean, or
     *  `false` when the speaker is currently down (the frame is dropped).
     *
     * @example
     * var transport = startMQSpeaker({ mqPort: 8125, bindHost: '127.0.0.1' });
     * transport.write('{"level":"info","content":"hello"}\r\n');
     */
    function startMQSpeaker(opt, cb) {
        var port = opt.mqPort || 8125;// jshint ignore:line
        // #B320 — the speaker's listener is CO-LOCATED BY CONSTRUCTION (started
        // by this install's `bin/cli`), so `host_v4` is not an input of this
        // dial at all: it is advertisement state, and on a shared or stale
        // `~/.gina` it can name ANOTHER machine — #B160's remote-unchanged rule
        // then shipped every log frame there while the connect read healthy.
        // Dial what the local daemon binds instead. The env tier mirrors the
        // GINA_HOMEDIR ladder above (and the bind side's own precedence,
        // init.js #B161): process.env is load-bearing for the early-call
        // window in which this container is constructed.
        var _envBindHost = (typeof getEnvVar === 'function' && getEnvVar('GINA_BIND_HOST'))
            || process.env.GINA_BIND_HOST || null;
        var host = netLocality.resolveLocalDialHost(_envBindHost || opt.bindHost);// jshint ignore:line
        // #B323 — state shared by every dial this speaker makes. Before this,
        // `startMQSpeaker` opened exactly one socket and handed it out; there
        // was no state to share because there was no second attempt, and a
        // speaker that lost its connection stayed silent for the life of the
        // process.
        var current       = null;   // the socket write() delegates to right now
        var attempts      = 0;      // CONSECUTIVE failed dials; reset on connect
        var redialTimer   = null;
        var cbCalled      = false;
        var everConnected = false;
        var warnedDown    = false;

        /**
         * Invokes the caller's callback at most once, on the first outcome.
         *
         * A reconnecting speaker settles repeatedly; a callback contract does
         * not. This flag is what stops an `(err)` from arriving hours after
         * `(false, client)` already did.
         *
         * @inner
         * @param {(string|boolean)} err - Error text, or `false` on connect.
         * @param {object} [client] - The connected socket, on the success path.
         * @returns {void}
         *
         * @example
         * settle(false, client);   // the first connect wins
         * settle('ECONNREFUSED');  // ignored once the line above has run
         */
        function settle(err, client) {
            if ( cbCalled || !cb ) {
                return;
            }
            cbCalled = true;
            cb(err, client);
        }

        /**
         * Arms the next dial, backing off exponentially, capped at 30s.
         *
         * The timer is `unref`'d, which is what keeps the reconnect loop from
         * resurrecting the #B276 hang: a process with nothing else to do exits
         * instead of waiting on it, so a short-lived CLI retries only for as
         * long as it was going to live anyway. A bundle — whose HTTP server
         * holds the loop — keeps retrying at a ≤30s cadence and HEALS on its
         * own if a listener appears later.
         *
         * @inner
         * @returns {void}
         *
         * @example
         * scheduleRedial();   // 500ms, then 1s, 2s, 4s … capped at 30s
         */
        function scheduleRedial() {
            if ( redialTimer ) {
                return;
            }
            var delay = Math.min(500 * Math.pow(2, attempts), 30000);
            attempts++;
            redialTimer = setTimeout(function () {
                redialTimer = null;
                dial();
            }, delay);
            redialTimer.unref();
        }

        /**
         * Opens ONE connection to the listener and wires its whole lifecycle.
         *
         * Runs once at startup and again for every reconnect. `clientOptions`
         * is rebuilt per dial deliberately: the listener mints a fresh
         * `sessionId` per connection, and the handshake in the `data` handler
         * only fires while `clientOptions.sessionId` is still unset — so a
         * shared object would make every reconnect skip its own
         * acknowledgement and never register its loggers.
         *
         * @inner
         * @returns {void}
         *
         * @example
         * dial();   // adopts the new socket as `current`, synchronously
         */
        function dial() {
            var clientOptions = {
                host    : host,
                port    : port,
                request : 'report'
            };
            var client = net.createConnection(clientOptions, () => {
                // 'connect' listener.
                attempts   = 0;
                warnedDown = false;
                // send request
                client.write( JSON.stringify(clientOptions) +'\r\n');

                // #B323 — name a reconnect for what it is, so an operator
                // reading the log can tell a fresh boot from a recovered one.
                var notice = (everConnected)
                    ? '[MQSpeaker] reconnected to server on host: '
                    : '[MQSpeaker] connected to server on host: ';
                console.info(notice + host +' & port: '+ port +' :) ');
                everConnected = true;

                settle(false, client);
            });
            // #B323 — the socket becomes `current` at DIAL time, not at connect
            // time: a net.Socket QUEUES writes made while it is still
            // connecting and flushes them once it is up, which is exactly how
            // the frames a bundle logs DURING its own mount survive. Adopting
            // on 'connect' instead would silently drop that entire window —
            // the same frames #B323 was filed to stop losing.
            current = client;
            // #B276 — the logger is a load-time singleton (`lib/index.js` requires it
            // eagerly, `main.js` invokes `Logger()` at module scope), so this socket is
            // opened by the mere act of requiring the framework — including on a boot
            // that is about to throw for want of a bundle context. Without unref, that
            // documented throw becomes unrecoverable: the caller catches the error and
            // the process still cannot exit, because the socket keeps the loop alive.
            // Only bites when something is actually listening on the MQ port; with
            // nothing there the connection is refused and the handle closes itself.
            client.unref();
            // #B318 — `unref()` covers the socket HANDLE but NOT the pending
            // `TCPConnectWrap` REQUEST, and a pending request keeps the event loop
            // alive on its own. The comment above is correct only for the two states
            // it names: a completed connect, and a REFUSED one (reachable host, no
            // listener — the peer sends RST, the handle closes itself). It misses the
            // third: an UNREACHABLE host (powered off, black-holed, a stale
            // `host_v4` left behind by a DHCP reassignment) answers nothing at all,
            // so the connect stays pending for the OS timeout — ~75s on macOS — and
            // the process cannot exit for that whole window. That is exactly the
            // hang #B276 set out to remove, surviving in the one state neither the
            // fix nor its comment considered.
            //
            // The deadline below is itself `unref`'d, so it never keeps the loop
            // alive either: it can only fire while something ELSE is holding the
            // loop open, which during a stalled dial is precisely the connect
            // request it exists to cancel. `destroy(err)` emits `error`, so the
            // outcome flows through the established handler below — same callback
            // contract, same warn text, no new egress path.
            //
            // #B323 — the verdict is deferred one event-loop PHASE, and that
            // deferral is the whole fix. `client.connecting` does not flip when
            // the kernel completes the connect; it flips when the POLL phase
            // runs `afterConnect`. A timer fires in the TIMERS phase, which
            // precedes poll — so on any boot that blocks the loop past the
            // deadline (a bundle mount off a network filesystem, every
            // Kubernetes-class start), the loop resumes, runs the overdue
            // deadline FIRST, and reads `connecting === true` on a connection
            // the kernel established seconds ago. It then destroyed a perfectly
            // live speaker, and with no reconnect the bundle logged nowhere for
            // the rest of its life. Re-checking from `setImmediate` moves the
            // read to the CHECK phase, which runs AFTER poll: a queued
            // `afterConnect` has been processed by then, so a completed connect
            // survives while a genuinely pending one still reads `connecting`
            // and still dies on schedule. Measured both directions — a
            // kernel-completed dial reads true at timers / false at check, a
            // black-holed one reads true at both — so this corrects the safety
            // claim the guard above used to make ("it destroys only while
            // connecting") without weakening the no-hang contract it exists for.
            var connectDeadline = setTimeout(function () {
                setImmediate(function () {
                    if (!client.connecting) { return; }
                    client.destroy(new Error(
                        'connect ETIMEDOUT ' + host + ':' + port +
                        ' - MQ host unreachable; giving up (logging transport only)'
                    ));
                });
            }, opt.mqConnectTimeout || 2000);
            connectDeadline.unref();
            client.once('connect', function () { clearTimeout(connectDeadline); });
            client.once('error',   function () { clearTimeout(connectDeadline); });
            client.on('error', (data) => {
                var err = data.toString();
                if (cb) {
                    // The callback owns error reporting for this speaker, as it
                    // always has — it just settles once now (#B323).
                    return settle(err);
                }

                //console.error('[MQSpeaker]  (error): ' + err);
                // Identical to console.error
                // But if have to use this one since it can be called from a
                // spawned commande line like `npm install` post_install script
                // console.debug('=> ', process.argv);
                // #B323 — one warn per OUTAGE, not one per attempt. The redial
                // below runs for the life of the process, so an un-gated warn
                // would turn a boot with no listener into a log line every 30s
                // forever. The flag is cleared on connect, so a LATER outage
                // still announces itself once.
                if ( warnedDown ) {
                    return;
                }
                warnedDown = true;
                if ( !/(\/bin\/cli|\/bin\/gina)$/.test(process.argv[1]) ) {
                    process.stdout.write( format(opt.name, 'warn', '[MQSpeaker] ' + err) );
                }

            });

            var payloads = null, i = null;
            client.on('data', (data) => {
                //console.log('[MQSpeaker]  (data): ' + data.toString());
                payloads = data.toString();

                // from speakers & tail
                if ( /^(\{\"|\[\{\")/.test(payloads) ) {
                    payloads = payloads.split(/\r\n/g);
                    //console.log(payloads);
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
                                process.stdout.write(  '[MQSpeaker] (exception) '+ payload +'\n' );
                                continue;
                            }


                            if ( pl.sessionId && !clientOptions.sessionId ) {
                                // configuring
                                clientOptions.sessionId = pl.sessionId;
                                clientOptions.loggers = loggers;

                                // acknowledging
                                client.write( JSON.stringify(clientOptions) +'\r\n');
                            }

                            if (!pl.content) {
                                // debug only
                                //process.stdout.write(  '[MQSpeaker] (undefined content) '+ JSON.stringify(pl, null) +'\n' );
                                continue;
                            }

                            // debug only when starting the framework with: ./bin/cli start >/usr/local/tmp/gina-smaple.log 2>&1
                            // process.stdout.write(  '[MQSpeaker] '+ pl.content +'\n' );
                        }
                    }

                    return
                }

                // regular messages
                process.stdout.write(  '[MQSpeaker] '+ payloads +'\n'  );

            });
            client.on('end', () => {
                console.debug('[MQSpeaker] disconnected from server');
            });
            client.on('close', () => {
                // #B323 — only the CURRENT socket may arm a redial. A
                // superseded one closes too (it was destroyed after its
                // replacement had already been adopted), and letting that close
                // schedule a dial would stack a second connection on top of a
                // healthy speaker. This is also what makes the whole loop
                // self-limiting: exactly one socket is live at a time.
                if ( current !== client ) {
                    return;
                }
                current = null;
                scheduleRedial();
            });
        }

        // #B323 — the stable facade. `mq/index.js` captures this ONCE, at
        // logger-construction time, and holds it for the life of the process,
        // so the reconnect above is only reachable through an indirection the
        // consumer cannot outlive.
        var transport = {
            /**
             * Writes one frame to whichever connection is current.
             *
             * @param {string} chunk - The serialised frame, `\r\n`-terminated.
             * @returns {boolean} The socket's own backpressure signal, or
             *  `false` when the speaker is down and the frame was dropped.
             *
             * @example
             * transport.write('{"level":"info","content":"hello"}\r\n');
             */
            write: function (chunk) {
                if ( current && current.writable ) {
                    return current.write(chunk);
                }
                // #B323 — down: DROP the frame rather than queue it. An
                // unbounded buffer behind an outage of unknown length is a
                // memory leak wearing a logging transport's clothes, and the
                // `default` (stdout) flow carries these same lines regardless.
                return false;
            }
        };

        dial();

        return transport;
    }


    return init(opt, cb);
}
module.exports = MQSpeaker;