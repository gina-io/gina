var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var SOURCE    = path.join(require('../fw'), 'core/connectors/sql-parser.js');
var sqlParser = require(SOURCE);

var stripComments            = sqlParser.stripComments;
var extractFirstBlockComment = sqlParser.extractFirstBlockComment;


// ── 01 — stripComments: block comments ────────────────────────────────────────
describe('01 - stripComments: block comments', function() {

    it('removes a simple block comment', function() {
        var result = stripComments('/* comment */ SELECT 1').trim();
        assert.ok(result.indexOf('SELECT 1') > -1);
        assert.ok(result.indexOf('comment') === -1);
    });

    it('replaces block comment with a space (preserves token boundary)', function() {
        var result = stripComments('SELECT/* comment */1');
        assert.equal(result, 'SELECT 1');
    });

    it('removes a multi-line block comment', function() {
        var result = stripComments('/*\n * @return {object}\n */\nSELECT * FROM t').trim();
        assert.ok(result.indexOf('SELECT') > -1);
        assert.ok(result.indexOf('@return') === -1);
    });

    it('handles nested block comments (one level deep)', function() {
        var result = stripComments('/* outer /* inner */ still-outer */ SELECT 1').trim();
        assert.equal(result.trim(), 'SELECT 1');
    });

    it('handles nested block comments (two levels deep)', function() {
        var result = stripComments('/* a /* b /* c */ b */ a */ SELECT 2').trim();
        assert.equal(result.trim(), 'SELECT 2');
    });

    it('handles multiple block comments', function() {
        var result = stripComments('/* A */ SELECT /* B */ 1').replace(/\s+/g, ' ').trim();
        assert.equal(result, 'SELECT  1'.replace(/\s+/g, ' ').trim());
    });

    it('empty source returns empty string', function() {
        assert.equal(stripComments(''), '');
    });

    it('source with no comments passes through unchanged', function() {
        var src = 'SELECT id, name FROM users WHERE id = ?';
        assert.equal(stripComments(src), src);
    });

});


// ── 02 — stripComments: line comments ─────────────────────────────────────────
describe('02 - stripComments: line comments', function() {

    it('removes SQL -- line comment', function() {
        var result = stripComments('SELECT 1 -- this is a comment\nFROM t');
        assert.ok(result.indexOf('this is a comment') === -1);
        assert.ok(result.indexOf('SELECT') > -1);
        assert.ok(result.indexOf('FROM') > -1);
    });

    it('removes C-style // line comment', function() {
        var result = stripComments('SELECT 1 // comment\nFROM t');
        assert.ok(result.indexOf('comment') === -1);
        assert.ok(result.indexOf('FROM') > -1);
    });

    it('-- at end of file (no newline) is removed cleanly', function() {
        var result = stripComments('SELECT 1 -- trailing');
        assert.ok(result.indexOf('trailing') === -1);
        assert.ok(result.indexOf('SELECT') > -1);
    });

    it('multiple -- lines are all removed', function() {
        var result = stripComments('-- line 1\n-- line 2\nSELECT 1');
        assert.ok(result.indexOf('line 1') === -1);
        assert.ok(result.indexOf('line 2') === -1);
        assert.ok(result.indexOf('SELECT') > -1);
    });

});


// ── 03 — stripComments: string literals ───────────────────────────────────────
describe('03 - stripComments: string literals', function() {

    it('-- inside single-quoted string is not treated as a comment', function() {
        var src    = "SELECT * FROM t WHERE name = 'it''s -- not a comment'";
        var result = stripComments(src);
        assert.equal(result, src);
    });

    it('/* inside single-quoted string is not treated as a block comment opener', function() {
        var src    = "SELECT '/* not a comment */' AS x";
        var result = stripComments(src);
        assert.equal(result, src);
    });

    it('-- inside double-quoted identifier is not treated as a comment', function() {
        var src    = 'SELECT "col--name" FROM t';
        var result = stripComments(src);
        assert.equal(result, src);
    });

    it('single-quoted string with doubled-quote escape passes through verbatim', function() {
        var src    = "SELECT 'O''Brien' AS name";
        var result = stripComments(src);
        assert.equal(result, src);
    });

    it('double-quoted string with doubled-quote escape passes through verbatim', function() {
        var src    = 'SELECT "col""name" FROM t';
        var result = stripComments(src);
        assert.equal(result, src);
    });

    it('comment before and after string literal — only comments removed', function() {
        var result = stripComments("/* A */ SELECT 'value' /* B */").replace(/\s+/g, ' ').trim();
        assert.ok(result.indexOf('SELECT') > -1);
        assert.ok(result.indexOf("'value'") > -1);
        assert.ok(result.indexOf('A') === -1);
        assert.ok(result.indexOf('B') === -1);
    });

});


// ── 04 — extractFirstBlockComment: basic cases ────────────────────────────────
describe('04 - extractFirstBlockComment: basic cases', function() {

    it('returns null when there is no block comment', function() {
        assert.equal(extractFirstBlockComment('SELECT 1'), null);
    });

    it('returns null for empty string', function() {
        assert.equal(extractFirstBlockComment(''), null);
    });

    it('returns the full comment including delimiters', function() {
        var result = extractFirstBlockComment('/* hello */ SELECT 1');
        assert.equal(result, '/* hello */');
    });

    it('returns a multi-line comment verbatim', function() {
        var src = '/*\n * @param {string} $1\n * @return {object}\n */\nSELECT 1';
        var result = extractFirstBlockComment(src);
        assert.ok(result !== null);
        assert.ok(result.startsWith('/*'));
        assert.ok(result.endsWith('*/'));
        assert.ok(result.indexOf('@param') > -1);
        assert.ok(result.indexOf('@return') > -1);
    });

    it('returns only the first comment when there are multiple', function() {
        var result = extractFirstBlockComment('/* first */ SELECT /* second */ 1');
        assert.equal(result, '/* first */');
    });

    it('-- line comment before block comment — still finds the block comment', function() {
        var result = extractFirstBlockComment('-- line\n/* block */ SELECT 1');
        assert.equal(result, '/* block */');
    });

});


// ── 05 — extractFirstBlockComment: nested comments ────────────────────────────
describe('05 - extractFirstBlockComment: nested comments', function() {

    it('returns the full extent of a one-level nested comment', function() {
        var src    = '/* outer /* inner */ still-outer */ SELECT 1';
        var result = extractFirstBlockComment(src);
        assert.equal(result, '/* outer /* inner */ still-outer */');
    });

    it('returns the full extent of a two-level nested comment', function() {
        var src    = '/* a /* b /* c */ b */ a */ SELECT 1';
        var result = extractFirstBlockComment(src);
        assert.equal(result, '/* a /* b /* c */ b */ a */');
    });

    it('content after the nested comment is not included', function() {
        var result = extractFirstBlockComment('/* /* */ */ extra');
        assert.equal(result, '/* /* */ */');
    });

});


// ── 06 — extractFirstBlockComment: string literals ────────────────────────────
describe('06 - extractFirstBlockComment: string literals skip', function() {

    it('/* inside single-quoted string does not open a comment', function() {
        var result = extractFirstBlockComment("SELECT '/* not a comment */'");
        assert.equal(result, null);
    });

    it('/* inside double-quoted identifier does not open a comment', function() {
        var result = extractFirstBlockComment('SELECT "/* col */"');
        assert.equal(result, null);
    });

    it('string literal before real comment — comment is still found', function() {
        var result = extractFirstBlockComment("SELECT '/*' /* real */ FROM t");
        assert.equal(result, '/* real */');
    });

});


// ── 07 — integration: typical annotated .sql file patterns ────────────────────
describe('07 - integration: typical annotated SQL file patterns', function() {

    it('strips annotation comment and leaves clean N1QL query', function() {
        var src = [
            '/**',
            ' * getOneById',
            ' * @options { consistency: "request_plus" }',
            ' * @param {string} $1 - account uuid',
            ' * @return {object} account',
            ' */',
            'SELECT DISTINCT a.*',
            'FROM users AS a',
            'WHERE a.id = $1',
            'LIMIT 1'
        ].join('\n');

        var clean = stripComments(src).replace(/\s+/g, ' ').trim();
        assert.ok(clean.indexOf('SELECT') > -1);
        assert.ok(clean.indexOf('WHERE') > -1);
        assert.ok(clean.indexOf('@return') === -1);
        assert.ok(clean.indexOf('@param') === -1);
        assert.ok(clean.indexOf('$1') > -1); // positional param preserved
    });

    it('extractFirstBlockComment finds $param references in annotation comment', function() {
        var src = [
            '/**',
            ' * @param {string} $1',
            ' * @param {string} $2',
            ' * @return {object}',
            ' */',
            'SELECT * FROM t WHERE a = $1 AND b = $2'
        ].join('\n');

        var comment = extractFirstBlockComment(src);
        assert.ok(comment !== null);
        var params  = comment.match(/\$\w+/g);
        assert.deepEqual(params, ['$1', '$2']);
    });

    it('nested comment in annotation does not truncate param list', function() {
        var src = [
            '/**',
            ' * @param {string} $1',
            ' * /* nested note */',
            ' * @param {string} $2',
            ' */',
            'SELECT * FROM t WHERE a = $1 AND b = $2'
        ].join('\n');

        var comment = extractFirstBlockComment(src);
        assert.ok(comment !== null);
        // Full outer comment must include $2 (not truncated at inner */)
        var params  = comment.match(/\$\w+/g);
        assert.ok(params !== null && params.indexOf('$2') > -1);
    });

    it('-- inside string literal does not break query extraction', function() {
        var src = [
            '/* @return {object} */',
            "SELECT * FROM t WHERE name = 'it''s -- not a comment'"
        ].join('\n');

        var clean = stripComments(src).replace(/\s+/g, ' ').trim();
        assert.ok(clean.indexOf("'it''s -- not a comment'") > -1);
    });

    it('SQLite @return {object} annotation is preserved in comment, stripped from query', function() {
        var src = '/*\n * @return {object}\n */\nSELECT * FROM users WHERE id = ?';
        var comment = extractFirstBlockComment(src);
        assert.ok(comment !== null && comment.indexOf('@return') > -1);
        var clean = stripComments(src).replace(/\s+/g, ' ').trim();
        assert.ok(clean.indexOf('@return') === -1);
        assert.ok(clean.indexOf('SELECT') > -1);
    });

});
