/**
 * Gina — net-locality helpers (control-plane dial-host resolution).
 *
 * The framework daemon binds its control sockets — the command socket (8124)
 * and the MQ listener (8125) — to `bind_host`, loopback by default, while
 * `host_v4` is the address EXTERNAL clients use to reach this machine. The
 * CLI-side clients (command socket dial, MQ speaker, MQ file container,
 * `gina tail`) historically dialled `host_v4` — so whenever `host_v4` was set
 * to a non-loopback address of this very machine (the common containerized
 * shape, where it carries the container/LAN IP so siblings can reach the
 * bundles), the co-located client dialled an address the daemon does not
 * bind, and the control plane was unreachable from its own host.
 *
 * The resolution deliberately stays on the DIAL side: when `host_v4` names
 * one of this machine's own interfaces, the daemon being dialled is local,
 * so the client dials the address the daemon actually binds. The BIND side
 * stays untouched — widening it remains a deliberate opt-in.
 *
 * Pure module: no framework globals, no state. `os.networkInterfaces()` is
 * the only system dependency and is injectable for deterministic tests.
 *
 * @module gina/lib/net-locality
 */
'use strict';

var os = require('os');

/**
 * Normalizes an address for comparison: trims, lowercases, strips an
 * IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`) and an IPv6 zone
 * suffix (`fe80::1%en0` → `fe80::1`).
 *
 * @inner
 * @private
 * @param {string} host - Raw host string
 * @returns {string} Normalized host
 */
var normalizeHost = function(host) {
    var h = String(host).trim().toLowerCase();
    if (h.indexOf('::ffff:') === 0 && h.indexOf('.') > -1) {
        h = h.substring(7);
    }
    var zone = h.indexOf('%');
    if (zone > -1) {
        h = h.substring(0, zone);
    }
    return h;
};

/**
 * True when the (normalized) host is a loopback name or address:
 * `localhost`, anything in `127.0.0.0/8`, or `::1`.
 *
 * @inner
 * @private
 * @param {string} h - Normalized host (see `normalizeHost`)
 * @returns {boolean}
 */
var isLoopback = function(h) {
    return ( h === 'localhost' || h === '::1' || /^127\./.test(h) );
};

/**
 * True when the (normalized) host is a wildcard bind address (`0.0.0.0` or
 * `::`) — an address that can be listened on but never meaningfully dialled.
 *
 * @inner
 * @private
 * @param {string} h - Normalized host (see `normalizeHost`)
 * @returns {boolean}
 */
var isWildcard = function(h) {
    return ( h === '0.0.0.0' || h === '::' );
};

/**
 * Tells whether `host` is an address assigned to one of this machine's own
 * network interfaces (exact match after normalization). Loopback always
 * qualifies. A hostname never matches — only literal addresses are compared,
 * so `my-host.local` falls through to `false` by design. Any enumeration
 * failure also returns `false` (fail-safe: callers keep today's unmodified
 * dial behaviour).
 *
 * @param {string} host - Literal IP address to test
 * @param {object} [interfaces] - `os.networkInterfaces()`-shaped map; used by
 *  tests for determinism. Defaults to the live `os.networkInterfaces()`.
 * @returns {boolean} True when the address belongs to this machine
 *
 * @example
 *  isLocalAddress('127.0.0.1');      // true
 *  isLocalAddress('192.0.2.1');      // false (TEST-NET, not a local iface)
 *  isLocalAddress('my-host.local');  // false (hostname, not an address)
 */
var isLocalAddress = function(host, interfaces) {
    if ( typeof(host) !== 'string' || host === '' ) {
        return false;
    }
    var h = normalizeHost(host);
    if ( isLoopback(h) ) {
        return true;
    }
    try {
        var ifaces = interfaces || os.networkInterfaces();
        for (var name in ifaces) {
            var addrs = ifaces[name];
            if ( !Array.isArray(addrs) ) {
                continue;
            }
            for (var i = 0, len = addrs.length; i < len; i++) {
                var a = addrs[i] && addrs[i].address;
                if ( typeof(a) === 'string' && normalizeHost(a) === h ) {
                    return true;
                }
            }
        }
    } catch (err) {
        return false;
    }
    return false;
};

/**
 * Resolves the host a control-plane CLIENT should dial.
 *
 * Rules, in order:
 *  1. No usable `hostV4` → `127.0.0.1` (the historical fallback).
 *  2. `hostV4` is loopback → returned unchanged (already dial-safe).
 *  3. `hostV4` does NOT name one of this machine's interfaces (a hostname, a
 *     genuinely remote address, or interface enumeration failed) → returned
 *     unchanged: remote administration keeps working exactly as before.
 *  4. `hostV4` names a local interface → the daemon is local, so dial what it
 *     binds: `bindHost` when it is a concrete non-wildcard address,
 *     `127.0.0.1` otherwise (a wildcard bind includes loopback).
 *
 * @param {string} hostV4 - The resolved client-facing host (`host_v4`)
 * @param {string} [bindHost] - The daemon's `bind_host`, when known
 * @param {object} [interfaces] - `os.networkInterfaces()`-shaped map; used by
 *  tests for determinism. Defaults to the live `os.networkInterfaces()`.
 * @returns {string} The host to dial
 *
 * @example
 *  // co-located daemon, LAN-facing host_v4 (the containerized shape)
 *  resolveDialHost('192.168.1.20', '127.0.0.1'); // '127.0.0.1' (when local)
 *  // operator widened the bind to a concrete address
 *  resolveDialHost('192.168.1.20', '192.168.1.20'); // '192.168.1.20'
 *  // wildcard bind still dials loopback
 *  resolveDialHost('192.168.1.20', '0.0.0.0');   // '127.0.0.1' (when local)
 *  // remote daemon: unchanged
 *  resolveDialHost('203.0.113.7', '127.0.0.1');  // '203.0.113.7'
 */
var resolveDialHost = function(hostV4, bindHost, interfaces) {
    if ( typeof(hostV4) !== 'string' || hostV4 === '' ) {
        return '127.0.0.1';
    }
    var h = normalizeHost(hostV4);
    if ( isLoopback(h) ) {
        return hostV4;
    }
    if ( !isLocalAddress(h, interfaces) ) {
        return hostV4;
    }
    if ( typeof(bindHost) === 'string' && bindHost !== '' ) {
        var b = normalizeHost(bindHost);
        if ( !isWildcard(b) ) {
            return bindHost;
        }
    }
    return '127.0.0.1';
};

/**
 * Resolves the dial target for a client whose server is CO-LOCATED BY
 * CONSTRUCTION — the MQ speaker and the MQ file container, whose listener is
 * started by the same install's daemon (`bin/cli`). `host_v4` is deliberately
 * NOT an input: it is self-describing advertisement state ("the address
 * EXTERNAL clients use to reach this machine"), never a dial target for an
 * intra-host transport. #B320 — on a `~/.gina` shared across hosts (or after
 * a stale address is left behind), `host_v4` can name ANOTHER machine, and
 * `resolveDialHost`'s remote-unchanged rule then ships every log frame to
 * that machine while the local connection story reads healthy.
 *
 * Rules, in order:
 *  1. `bindHost` is a concrete, non-wildcard address of THIS machine → dial
 *     it (required when the daemon binds a specific non-loopback interface,
 *     where loopback would be refused).
 *  2. Anything else → `127.0.0.1`. A wildcard bind includes loopback; a
 *     FOREIGN or unverifiable `bindHost` (shared/stale state again) refuses
 *     to leave the host — a loud local ECONNREFUSED beats silently
 *     delivering logs to another machine.
 *
 * @param {string} bindHost - The daemon's `bind_host`, when known
 * @param {object} [interfaces] - `os.networkInterfaces()`-shaped map; used by
 *  tests for determinism. Defaults to the live `os.networkInterfaces()`.
 * @returns {string} The host to dial
 *
 * @example
 *  resolveLocalDialHost('0.0.0.0');       // '127.0.0.1' (wildcard bind)
 *  resolveLocalDialHost(undefined);       // '127.0.0.1' (default bind)
 *  resolveLocalDialHost('192.168.1.20');  // '192.168.1.20' when local,
 *                                         // '127.0.0.1' when not
 */
var resolveLocalDialHost = function(bindHost, interfaces) {
    if ( typeof(bindHost) !== 'string' || bindHost === '' ) {
        return '127.0.0.1';
    }
    var b = normalizeHost(bindHost);
    if ( isWildcard(b) ) {
        return '127.0.0.1';
    }
    if ( !isLocalAddress(b, interfaces) ) {
        return '127.0.0.1';
    }
    return bindHost;
};

module.exports = {
    isLocalAddress       : isLocalAddress,
    resolveDialHost      : resolveDialHost,
    resolveLocalDialHost : resolveLocalDialHost
};
