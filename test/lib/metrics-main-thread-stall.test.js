'use strict';
/**
 * lib/metrics — the stall watchdog's two series:
 * `<prefix>main_thread_stalls_total` (counter) and
 * `<prefix>main_thread_stall_seconds` (histogram).
 *
 *   §01 registerMainThreadStallMetrics(): a no-op while metrics are off; once
 *       started, both series exist under the configured prefix with the stall
 *       buckets; a second call registers nothing more.
 *   §02 recordMainThreadStall(seconds): one inc + one observe of the seconds;
 *       registers the series itself when the watchdog did not; ignores a duration
 *       that is not a finite number >= 0; a no-op while metrics are off.
 *   §03 reset() forgets the series and the prefix (a restart re-registers them).
 *
 * The prom-client is a mock (the suite's own convention, test/lib/metrics.test.js):
 * the assertions read what the module handed the client.
 *
 * Run: node --test test/lib/metrics-main-thread-stall.test.js
 */
var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var FW      = require('../fw');
var metrics = require(path.join(FW, 'lib/metrics/src/main'));

/**
 * A prom-client double recording every Counter / Histogram it builds and every
 * inc / observe made on them.
 *
 * @returns {Object}
 */
function makeMockProm() {
    var built = { counters: [], histograms: [] };
    function Registry() {
        this.metrics = function() { return Promise.resolve(''); };
    }
    function Counter(opts) {
        var self = { opts: opts, incs: [] };
        built.counters.push(self);
        this.inc = function(labels) { self.incs.push(labels); };
    }
    function Histogram(opts) {
        var self = { opts: opts, observes: [] };
        built.histograms.push(self);
        this.observe = function(a, b) { self.observes.push(( typeof(b) == 'undefined' ) ? [a] : [a, b]); };
    }
    return {
        Registry              : Registry,
        Counter               : Counter,
        Histogram             : Histogram,
        collectDefaultMetrics : function() {},
        built                 : built
    };
}

/**
 * The series a mock built with the given name.
 *
 * @param {Object[]} list
 * @param {string} name
 * @returns {Object[]}
 */
function named(list, name) {
    return list.filter(function(s) { return s.opts.name === name; });
}

beforeEach(function() {
    metrics.reset();
});

describe('01 - registerMainThreadStallMetrics()', function() {

    it('01.01 - returns false and builds nothing while metrics are off', function() {
        assert.equal(metrics.isEnabled(), false);
        assert.equal(metrics.registerMainThreadStallMetrics(), false);
    });

    it('01.02 - builds the counter and the histogram under the configured prefix', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false, prefix: 'app_' });
        assert.equal(metrics.registerMainThreadStallMetrics(), true);

        var counters   = named(prom.built.counters, 'app_main_thread_stalls_total');
        var histograms = named(prom.built.histograms, 'app_main_thread_stall_seconds');
        assert.equal(counters.length, 1, 'the counter is built once, under the prefix');
        assert.equal(histograms.length, 1, 'the histogram is built once, under the prefix');
        assert.deepEqual(histograms[0].opts.buckets, metrics.STALL_BUCKETS);
        assert.deepEqual(metrics.STALL_BUCKETS, [1, 2, 5, 10, 30, 60, 120, 300]);
        assert.equal(counters[0].opts.registers.length, 1, 'registered on the framework registry');
    });

    it('01.03 - the default prefix is gina_', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false });
        metrics.registerMainThreadStallMetrics();
        assert.equal(named(prom.built.counters, 'gina_main_thread_stalls_total').length, 1);
        assert.equal(named(prom.built.histograms, 'gina_main_thread_stall_seconds').length, 1);
    });

    it('01.04 - a second call registers nothing more', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false });
        assert.equal(metrics.registerMainThreadStallMetrics(), true);
        var before = prom.built.counters.length + prom.built.histograms.length;
        assert.equal(metrics.registerMainThreadStallMetrics(), true);
        assert.equal(prom.built.counters.length + prom.built.histograms.length, before);
    });
});

describe('02 - recordMainThreadStall(seconds)', function() {

    it('02.01 - one inc and one observe of the seconds', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false });
        metrics.registerMainThreadStallMetrics();
        metrics.recordMainThreadStall(6.1);

        var counter   = named(prom.built.counters, 'gina_main_thread_stalls_total')[0];
        var histogram = named(prom.built.histograms, 'gina_main_thread_stall_seconds')[0];
        assert.equal(counter.incs.length, 1);
        assert.deepEqual(histogram.observes, [[6.1]]);
    });

    it('02.02 - registers the series itself when they do not exist yet', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false });
        metrics.recordMainThreadStall(2);
        assert.equal(named(prom.built.counters, 'gina_main_thread_stalls_total')[0].incs.length, 1);
        assert.deepEqual(named(prom.built.histograms, 'gina_main_thread_stall_seconds')[0].observes, [[2]]);
    });

    it('02.03 - ignores a duration that is not a finite number >= 0', function() {
        var prom = makeMockProm();
        metrics.start({ client: prom, defaultMetrics: false });
        metrics.registerMainThreadStallMetrics();
        [-1, NaN, Infinity, '5', null, undefined, {}].forEach(function(v) {
            metrics.recordMainThreadStall(v);
        });
        assert.equal(named(prom.built.counters, 'gina_main_thread_stalls_total')[0].incs.length, 0);
        assert.equal(named(prom.built.histograms, 'gina_main_thread_stall_seconds')[0].observes.length, 0);
        metrics.recordMainThreadStall(0);
        assert.equal(named(prom.built.counters, 'gina_main_thread_stalls_total')[0].incs.length, 1, 'zero is a duration (the control: the series do count)');
    });

    it('02.04 - a no-op while metrics are off', function() {
        assert.doesNotThrow(function() { metrics.recordMainThreadStall(3); });
        assert.equal(metrics.isEnabled(), false);
    });
});

describe('03 - reset()', function() {

    it('03.01 - forgets the series: a new start registers them again, under its own prefix', function() {
        var first = makeMockProm();
        metrics.start({ client: first, defaultMetrics: false, prefix: 'one_' });
        metrics.registerMainThreadStallMetrics();
        metrics.reset();

        var second = makeMockProm();
        metrics.start({ client: second, defaultMetrics: false, prefix: 'two_' });
        metrics.recordMainThreadStall(1.5);
        assert.equal(named(second.built.counters, 'two_main_thread_stalls_total').length, 1);
        assert.deepEqual(named(second.built.histograms, 'two_main_thread_stall_seconds')[0].observes, [[1.5]]);
        assert.equal(named(first.built.counters, 'one_main_thread_stalls_total')[0].incs.length, 0, 'the first registry is never written again');
    });
});
