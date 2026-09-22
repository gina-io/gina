/**
 * Region locale data invariants (gina-io/gina#50 verification gate).
 *
 * Locks the SHIPPED dist/region/*.json artifacts against the #50 defect
 * family, so a future regeneration with a regressed generator (or a stale
 * hand-edit) fails CI instead of shipping:
 *
 *   01 — per-file structural invariants: unique isoShort == item count
 *        (no duplicated codes), zero empty isoShort, non-empty countryName
 *        on every row
 *   02 — cross-file parity: every language covers the same iso set
 *   03 — localization: the non-en files carry localized SHORT country names
 *        (spot-checked rows + a bulk differs-from-en threshold), resolved
 *        through the REAL lib/collection first-match path a consumer uses
 *
 * Usage: node --test test/core/locales-region-data.test.js
 */

var path   = require('path');
var fs     = require('fs');
var assert = require('assert');

var describe = require('node:test').describe;
var it       = require('node:test').it;

var FW = require('../fw');

// Framework-globals bootstrap (Collection's match loop needs
// Object.prototype.count) — same recipe as controller-locale-fallback §02.
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));

// Load the region DB exactly like core/locales/index.js does.
var DIR   = path.join(FW, 'core/locales/dist/region');
var FILES = fs.readdirSync(DIR).filter(function (f) { return !/^\./.test(f) && /\.json$/.test(f); });
var DB    = {};
FILES.forEach(function (f) {
    DB[f.split(/\./)[0]] = require(path.join(DIR, f));
});

var Collection = require(path.join(FW, 'lib/collection'));


describe('01 - per-file structural invariants (#50 defects 1 + empty-iso)', function() {

    Object.keys(DB).forEach(function (lang) {
        var rows = DB[lang];

        it(lang + '.json — every row has a non-empty isoShort', function() {
            var empties = rows.filter(function (r) {
                return typeof (r.isoShort) != 'string' || r.isoShort.trim().length === 0;
            });
            assert.equal(empties.length, 0);
        });

        it(lang + '.json — no duplicated isoShort (unique codes == item count)', function() {
            var seen = {};
            rows.forEach(function (r) { seen[r.isoShort] = (seen[r.isoShort] || 0) + 1; });
            var dups = Object.keys(seen).filter(function (c) { return seen[c] > 1; });
            assert.deepEqual(dups, [], 'duplicated codes found');
            assert.equal(Object.keys(seen).length, rows.length);
        });

        it(lang + '.json — every row carries a non-empty countryName', function() {
            var bad = rows.filter(function (r) {
                return typeof (r.countryName) != 'string' || r.countryName.trim().length === 0;
            });
            assert.deepEqual(bad.map(function (r) { return r.isoShort; }), []);
        });

        it(lang + '.json — carries a plausible country count', function() {
            assert.ok(rows.length >= 240, lang + ' has ' + rows.length + ' rows — expected the full ISO 3166 set');
        });
    });
});


describe('02 - cross-file parity', function() {

    it('every language file covers the same isoShort set', function() {
        var langs = Object.keys(DB);
        assert.ok(langs.indexOf('en') > -1, 'en.json must exist (the canonical set)');
        var ref = DB.en.map(function (r) { return r.isoShort; }).sort();
        langs.forEach(function (lang) {
            var set = DB[lang].map(function (r) { return r.isoShort; }).sort();
            assert.deepEqual(set, ref, lang + '.json iso set diverges from en.json');
        });
    });
});


describe('03 - localization through the real consumer path (#50 defects 2+3)', function() {

    // The exact lookup shape the issue's reproducer (and consuming apps) use:
    // getLocales().getCountries() preserves file order and findOne returns
    // the FIRST match — pre-fix, that was the English copy.
    var fr = new Collection(DB.fr);
    var en = new Collection(DB.en);

    [
        ['DE', 'Allemagne',    'Germany'],
        ['US', 'États-Unis',   null],
        ['GB', 'Royaume-Uni',  null],
        ['KR', 'Corée du Sud', null]
    ].forEach(function (probe) {
        var iso = probe[0], wantFr = probe[1], wantEn = probe[2];

        it('fr findOne({isoShort:\'' + iso + '\'}).countryName === \'' + wantFr + '\' (localized SHORT name)', function() {
            var row = fr.findOne({ isoShort: iso });
            assert.ok(row, iso + ' row must exist');
            assert.equal(row.countryName, wantFr);
        });

        if (wantEn) {
            it('en findOne({isoShort:\'' + iso + '\'}).countryName === \'' + wantEn + '\' (en unchanged)', function() {
                assert.equal(en.findOne({ isoShort: iso }).countryName, wantEn);
            });
        }
    });

    it('fr officialStateName keeps the LONG official form (distinct from countryName)', function() {
        var us = fr.findOne({ isoShort: 'US' });
        assert.equal(us.officialStateName, 'États-Unis d\'Amérique');
        assert.notEqual(us.officialStateName, us.countryName);
    });

    it('fr countryName differs from en for the bulk of the set (not a copied file)', function() {
        var enBy = {};
        DB.en.forEach(function (r) { enBy[r.isoShort] = r.countryName; });
        var differing = DB.fr.filter(function (r) { return r.countryName !== enBy[r.isoShort]; }).length;
        // 72 names are legitimately identical across en/fr (France, Canada, …);
        // the localized set measures 177 differing of 249.
        assert.ok(differing >= 150, 'only ' + differing + ' localized fr names differ from en — the overlay did not apply');
    });
});
