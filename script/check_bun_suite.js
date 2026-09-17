#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Suite-under-Bun gate — compares one `bun test --isolate --reporter=junit`
 * run of the node:test suite against a committed expected-failures set.
 *
 * Why two artifacts. The JUnit report carries every REGISTERED test under a
 * stable key (`<file> :: <classname> :: <name>` — bun joins nested describe
 * names deepest-first), but it is BLIND to load-time errors: a describe body
 * that throws shows as a smaller suite with no `<error>`, and a file that
 * throws at top level is omitted from the report entirely (measured on Bun
 * 1.4.2, 2026-09-17). The console summary's ` N errors` line is the only
 * place those surface, and the every-test-file-has-a-suite check is what
 * catches the omitted file. A gate reading the XML alone would stay green
 * while tests silently stop running.
 *
 * Verdict contract:
 *   - red   : a NEW failing test (in the run, not in the expected set);
 *             any load-time error; a test file on disk absent from the
 *             report; a run that registered zero tests (a control that
 *             cannot fire is not a control).
 *   - warn  : an expected failure that no longer fails — the fix landed;
 *             update the file (`--update`). Never a red: a gate that goes
 *             red on improvement trains people to ignore it.
 *   - green : otherwise.
 *
 * Exit codes: 0 green (warnings allowed) · 1 red · 2 usage / precondition.
 *
 * Usage:
 *   node script/check_bun_suite.js --junit <junit.xml> --console <bun-console.txt>
 *        --expected test/bun-expected-failures.txt [--files test/core --files test/lib]
 *        [--update]
 *
 * `--files` defaults to the two directories `npm test` globs (`test/core`,
 * `test/lib`); the XML `file` attributes are cwd-relative, so run from the
 * repository root. `--update` rewrites the expected file from the actual
 * failing set (sorted, one key per line) — review its diff before committing.
 */

'use strict';

var fs   = require('fs');
var path = require('path');

/** @constant {string[]} Default test roots — the same two `npm test` globs. */
var DEFAULT_FILE_ROOTS = ['test/core', 'test/lib'];

/** @constant {string} Header written at the top of a generated expected file. */
var EXPECTED_HEADER = [
    '# Expected failures of the node:test suite under `bun test --isolate` on the CI Bun pin.',
    '# One key per line: <file> :: <classname> :: <name>  (classname as bun emits it, deepest-first).',
    '# Maintained by script/check_bun_suite.js --update — review the diff before committing.',
    '# A NEW failure not listed here is a red; a listed one that no longer fails is a warning.'
].join('\n') + '\n';

var outBuf = [];

/**
 * Buffers one output line; everything is flushed synchronously before exit so
 * nothing is lost on an async pipe (CI collectors, `bin/gina-container`).
 *
 * @inner
 * @param {string} line
 * @returns {void}
 */
function say(line) { outBuf.push(line); }

/**
 * Flushes the buffered output to fd 1 and exits with `code`.
 *
 * @inner
 * @param {number} code
 * @returns {void}
 */
function finish(code) {
    if (outBuf.length) {
        try { fs.writeSync(1, outBuf.join('\n') + '\n'); } catch (e) { /* best effort */ }
    }
    process.exit(code);
}

/**
 * Prints a usage error to fd 2 and exits 2.
 *
 * @inner
 * @param {string} msg
 * @returns {void}
 */
function usage(msg) {
    var text = 'check_bun_suite: ' + msg + '\n'
        + 'usage: node script/check_bun_suite.js --junit <junit.xml> --console <console.txt> '
        + '--expected <expected.txt> [--files <dir>]... [--update]\n';
    try { fs.writeSync(2, text); } catch (e) { /* best effort */ }
    process.exit(2);
}

/**
 * Parses argv into options. Every value option takes exactly one argument.
 *
 * @inner
 * @param {string[]} argv - `process.argv.slice(2)`
 * @returns {{junit:?string, console:?string, expected:?string, files:string[], update:boolean}}
 */
function parseArgs(argv) {
    var opt = { junit: null, console: null, expected: null, files: [], update: false };
    for (var i = 0; i < argv.length; i++) {
        var a = argv[i];
        if (a === '--update') { opt.update = true; continue; }
        if (a === '--junit' || a === '--console' || a === '--expected' || a === '--files') {
            var v = argv[++i];
            if (typeof v === 'undefined') { usage('missing value for ' + a); }
            if (a === '--files') { opt.files.push(v); } else { opt[a.slice(2)] = v; }
            continue;
        }
        usage('unknown argument ' + a);
    }
    if (!opt.junit || !opt.console || !opt.expected) {
        usage('--junit, --console and --expected are required');
    }
    if (!opt.files.length) { opt.files = DEFAULT_FILE_ROOTS.slice(); }
    return opt;
}

/**
 * Decodes the XML entities bun's reporter emits (named + numeric).
 *
 * @inner
 * @param {string} s
 * @returns {string}
 */
function unescapeXml(s) {
    return String(s)
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Reads one attribute off an XML start tag's attribute string.
 *
 * @inner
 * @param {string} attrs - The text between the tag name and `>` / `/>`.
 * @param {string} name
 * @returns {?string} Decoded value, or `null` when absent.
 */
function attr(attrs, name) {
    var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
    return m ? unescapeXml(m[1]) : null;
}

/**
 * Extracts what the gate needs from a bun JUnit report.
 *
 * The parser is a deliberately small state machine over bun's own regular
 * output — no XML dependency. A `<testcase … />` (self-closing) is a pass; a
 * `<testcase …> … </testcase>` is inspected for `<failure` / `<error`
 * (failing) or `<skipped` (skipped).
 *
 * @param {string} xml
 * @returns {{tests:number, files:Object<string,boolean>, failures:string[], skipped:number}}
 *
 * @example
 * var r = readJUnit(fs.readFileSync('junit.xml', 'utf8'));
 * // r.failures → ['test/lib/x.test.js :: suite :: name', …]
 */
function readJUnit(xml) {
    var res = { tests: 0, files: {}, failures: [], skipped: 0 };
    var root = /<testsuites\b([^>]*)>/.exec(xml);
    if (root) { res.tests = parseInt(attr(root[1], 'tests') || '0', 10) || 0; }

    var suiteRe = /<testsuite\b([^>]*)>/g, m;
    while ((m = suiteRe.exec(xml)) !== null) {
        var f = attr(m[1], 'file');
        if (f) { res.files[f] = true; }
    }

    var caseRe = /<testcase\b([^>]*?)(\/?)>/g;
    while ((m = caseRe.exec(xml)) !== null) {
        var attrs = m[1], selfClosing = m[2] === '/';
        var key = (attr(attrs, 'file') || '') + ' :: ' + (attr(attrs, 'classname') || '') + ' :: ' + (attr(attrs, 'name') || '');
        if (selfClosing) { continue; }
        var end = xml.indexOf('</testcase>', caseRe.lastIndex);
        var inner = end === -1 ? '' : xml.slice(caseRe.lastIndex, end);
        if (/<failure\b|<error\b/.test(inner)) { res.failures.push(key); }
        else if (/<skipped\b/.test(inner)) { res.skipped++; }
        if (end !== -1) { caseRe.lastIndex = end + '</testcase>'.length; }
    }
    return res;
}

/**
 * Reads the load-time error count off bun's console summary (` N errors`).
 * Absent line ⇒ 0 (bun prints it only when non-zero).
 *
 * @param {string} text
 * @returns {number}
 *
 * @example
 * readConsoleErrors(' 3 pass\n 2 errors\nRan 5 tests across 2 files.') // → 2
 */
function readConsoleErrors(text) {
    var m = /^\s*(\d+) errors?\s*$/m.exec(String(text));
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * Lists `*.test.js` files directly under each root (the `npm test` glob
 * shape — not recursive), as cwd-relative paths in bun's `file` attribute
 * form.
 *
 * @inner
 * @param {string[]} roots
 * @returns {string[]} Sorted relative paths.
 */
function listTestFiles(roots) {
    var out = [];
    roots.forEach(function (root) {
        var abs = path.resolve(root);
        var names;
        try { names = fs.readdirSync(abs); } catch (e) { usage('cannot read --files directory ' + root); }
        names.forEach(function (n) {
            if (/\.test\.js$/.test(n)) { out.push(path.relative(process.cwd(), path.join(abs, n)).split(path.sep).join('/')); }
        });
    });
    return out.sort();
}

/**
 * Reads the expected-failures file into a set of keys. `#` lines and blank
 * lines are ignored.
 *
 * @inner
 * @param {string} file
 * @returns {Object<string,boolean>}
 */
function readExpected(file) {
    var set = {};
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
        var l = line.trim();
        if (!l || l[0] === '#') { return; }
        set[l] = true;
    });
    return set;
}

// ─── main ───────────────────────────────────────────────────────────────────

var opt = parseArgs(process.argv.slice(2));

var junitText, consoleText;
try { junitText = fs.readFileSync(opt.junit, 'utf8'); } catch (e) { usage('cannot read --junit ' + opt.junit); }
try { consoleText = fs.readFileSync(opt.console, 'utf8'); } catch (e) { usage('cannot read --console ' + opt.console); }
if (!opt.update && !fs.existsSync(opt.expected)) {
    usage('expected file not found: ' + opt.expected + ' (run with --update to create it)');
}

var report   = readJUnit(junitText);
var errors   = readConsoleErrors(consoleText);
var onDisk   = listTestFiles(opt.files);
var actual   = {};
report.failures.forEach(function (k) { actual[k] = true; });
var actualKeys = Object.keys(actual).sort();

if (opt.update) {
    fs.writeFileSync(opt.expected, EXPECTED_HEADER + actualKeys.map(function (k) { return k + '\n'; }).join(''));
    say('check_bun_suite: wrote ' + actualKeys.length + ' expected failure(s) to ' + opt.expected + ' — review the diff before committing');
    finish(0);
}

var expected = readExpected(opt.expected);
var red = false;

say('suite-under-bun gate');
say('  registered tests: ' + report.tests + ' across ' + Object.keys(report.files).length + ' file(s) in the report; '
    + onDisk.length + ' test file(s) on disk; ' + report.skipped + ' skipped');

if (report.tests === 0) {
    say('  RED: the report registered zero tests — an empty run is not a green run');
    red = true;
}

var missing = onDisk.filter(function (f) { return !report.files[f]; });
if (missing.length) {
    red = true;
    missing.forEach(function (f) { say('  RED: ' + f + ' is MISSING from the JUnit report (a top-level throw makes bun omit the file — silent registration loss)'); });
}

if (errors > 0) {
    red = true;
    say('  RED: ' + errors + ' load-time error(s) reported by bun (a throwing describe body / top-level throw — see the console log)');
}

var matched = 0, newF = [], vanished = [];
actualKeys.forEach(function (k) { if (expected[k]) { matched++; } else { newF.push(k); } });
Object.keys(expected).sort().forEach(function (k) { if (!actual[k]) { vanished.push(k); } });

say('  expected failures: ' + Object.keys(expected).length + ' (' + matched + ' matched); actual failures: ' + actualKeys.length);
vanished.forEach(function (k) { say('  WARNING: VANISHED expected failure (fixed? update the file): ' + k); });
newF.forEach(function (k) { say('  RED: NEW failure: ' + k); });
if (newF.length) { red = true; }

say(red ? '  verdict: RED' : '  verdict: green');
finish(red ? 1 : 0);
