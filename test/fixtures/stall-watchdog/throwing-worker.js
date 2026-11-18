'use strict';
/**
 * A watchdog thread that fails at once — test/lib/stall-watchdog-worker.test.js
 * §06: the main thread must take the fault as an 'error' event (turning the
 * watchdog off with one warn line) and keep running, never as an
 * uncaughtException.
 */
throw new Error('watchdog fixture failure');
