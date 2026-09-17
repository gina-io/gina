/**
 * #B100 — locale-DB fallback hardening (core/controller/controller.js).
 *
 * Two catch sites — the setOptions locale bridge and `getLocales()` — used to
 * read `settings.region.shortCode` blind (threw `reading 'shortCode'` when the
 * `region` block was absent) and deref the fallback `findOne(...).content`
 * unguarded (threw `reading 'content'` when the resolved language was not in
 * the loaded region set). The schema-valid shape (region present, no
 * `shortCode`) never threw — Collection's `find` round-trips its filter
 * through JSON.stringify, which drops undefined-valued keys, so
 * `findOne({lang: undefined})` match-alls to the FIRST record — but the warn
 * printed `undefined` and the fallback was an accident, not a decision.
 *
 * Post-fix: a shared closure helper `getLocaleFallbackLang(conf)` resolves
 * `region.isoShort` (the schema key, ISO 639-1) → legacy `region.shortCode` →
 * `'en'`, every level guarded, and both catches guard the fallback record
 * before dereferencing `.content`.
 *
 * Sections:
 *   01 — source pins on the helper + both catch sites
 *   02 — behavioural replica against the REAL lib/collection + REAL region
 *        data, plus SUBTRACT cases reproducing all three pre-fix behaviours
 *
 * Usage: node --test test/core/controller-locale-fallback.test.js
 */

var path   = require('path');
var assert = require('assert');
var fs     = require('fs');

var describe = require('node:test').describe;
var it       = require('node:test').it;

var FW       = require('../fw');
var CTRL_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');


describe('01 - guarded locale fallback source pins (#B100)', function() {

    it('defines the shared closure helper getLocaleFallbackLang(conf)', function() {
        assert.match(CTRL_SRC, /var\s+getLocaleFallbackLang\s*=\s*function\s*\(\s*conf\s*\)/);
    });

    it('helper prefers isoShort, honours legacy shortCode, defaults to en — in that order', function() {
        // End-anchor slice: helper definition → the getLocales JSDoc that follows it.
        var hStart = CTRL_SRC.indexOf('var getLocaleFallbackLang');
        var hEnd   = CTRL_SRC.indexOf('this.getLocales', hStart);
        assert.ok(hStart > -1 && hEnd > hStart, 'helper block slice must resolve');
        var block   = CTRL_SRC.slice(hStart, hEnd);
        var isoIdx  = block.indexOf('_region.isoShort');
        var legIdx  = block.indexOf('_region.shortCode');
        var enIdx   = block.indexOf("return 'en'");
        assert.ok(isoIdx > -1, 'isoShort read present');
        assert.ok(legIdx > isoIdx, 'legacy shortCode read AFTER isoShort (priority order)');
        assert.ok(enIdx > legIdx, "final return 'en' after both");
        // every level guarded — the region deref is existence-gated
        assert.match(block, /conf\s*&&\s*conf\.content\s*&&\s*conf\.content\.settings\s*&&\s*conf\.content\.settings\.region/);
    });

    it('has exactly TWO helper call sites (setOptions bridge + getLocales)', function() {
        // The definition is `getLocaleFallbackLang = function(` (an `=` between
        // name and paren), so this pattern counts calls only.
        var calls = (CTRL_SRC.match(/getLocaleFallbackLang\s*\(/g) || []).length;
        assert.equal(calls, 2, 'expected the two catch-site calls, no more, no less');
    });

    it('both catches guard the fallback record before dereferencing .content', function() {
        var guards = (CTRL_SRC.match(/_fallbackLocales\s*&&\s*_fallbackLocales\.content/g) || []).length;
        assert.equal(guards, 2, 'both fallback lookups must be guarded');
    });

    it('both warns interpolate the RESOLVED fallback, never a blind deref', function() {
        var warns = (CTRL_SRC.match(/\+\s*_fallbackLang\s*\+/g) || []).length;
        assert.equal(warns, 2, 'both warns must print the resolved fallback language');
    });

    it('the blind settings.region.shortCode deref is gone file-wide', function() {
        // Access-prefix form — the helper reads `_region.shortCode` (guarded)
        // and comments may name `region.shortCode` bare; only the full blind
        // chain is forbidden.
        assert.doesNotMatch(CTRL_SRC, /local\.options\.conf\.content\.settings\.region\.shortCode/);
    });

});


describe('02 - behavioural replica — REAL Collection + REAL region data (#B100)', function() {

    // Bootstrap: framework bare-module resolution + Object.prototype.count
    // (Collection's match loop depends on it) — same recipe as the scratchpad
    // measurement probe that pinned the pre-fix behaviours.
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));

    // Load the region DB exactly like core/locales/index.js does.
    var dir     = path.join(FW, 'core/locales/dist/region');
    var files   = fs.readdirSync(dir);
    var LOCALES = [];
    for (var f = 0; f < files.length; f++) {
        if (!/^\./.test(files[f])) {
            LOCALES.push({ lang: files[f].split(/\./)[0], content: require(path.join(dir, files[f])) });
        }
    }
    var Collection = require(path.join(FW, 'lib/collection'));

    // Content discriminator — the sets are told apart by the DE row's
    // localized short name ('Germany' → en, 'Allemagne' → fr). Size stopped
    // discriminating when the #50 fix regenerated both files to the same
    // healthy 249-row shape (the old en-251 / fr-502 size gap was itself a
    // property of the #50 duplication bug this replica used to lean on).
    function resolvedLang(rows) {
        if (!rows || !rows.length) { return null; }
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].isoShort === 'DE') {
                if (rows[i].countryName === 'Allemagne') { return 'fr'; }
                if (rows[i].countryName === 'Germany')   { return 'en'; }
                return null;
            }
        }
        return null;
    }

    // Verbatim-lifted helper (locked to the shipped block by the §01 pins).
    function getLocaleFallbackLang(conf) {
        var _region = ( conf && conf.content && conf.content.settings && conf.content.settings.region ) ? conf.content.settings.region : null;
        if ( _region ) {
            if ( typeof(_region.isoShort) == 'string' && _region.isoShort.length > 0 ) {
                return _region.isoShort.toLowerCase();
            }
            if ( typeof(_region.shortCode) == 'string' && _region.shortCode.length > 0 ) {
                return _region.shortCode.toLowerCase();
            }
        }
        return 'en';
    }

    // Verbatim-lifted NEW bridge (the fixed catch shape).
    function newBridge(conf, userLangCode, warns) {
        var locales     = new Collection(LOCALES);
        var userLocales = null;
        try {
            userLocales = locales.findOne({ lang: userLangCode }).content;
        } catch (err) {
            var _fallbackLang    = getLocaleFallbackLang(conf);
            warns.push('language code `'+ userLangCode +'` not handled by current locales setup: replacing by default: `'+ _fallbackLang +'`');
            var _fallbackLocales = locales.findOne({ lang: _fallbackLang }) || locales.findOne({ lang: 'en' });
            userLocales = ( _fallbackLocales && _fallbackLocales.content ) ? _fallbackLocales.content : [];
        }
        return userLocales;
    }

    // Verbatim-lifted OLD bridge (the pre-fix catch shape) — the subtract.
    function oldBridge(conf, userLangCode, warns) {
        var locales     = new Collection(LOCALES);
        var userLocales = null;
        try {
            userLocales = locales.findOne({ lang: userLangCode }).content;
        } catch (err) {
            warns.push('language code `'+ userLangCode +'` not handled by current locales setup: replacing by default: `'+ conf.content.settings.region.shortCode +'`');
            userLocales = locales.findOne({ lang: conf.content.settings.region.shortCode }).content; // by default
        }
        return userLocales;
    }

    var confSchemaValid = { content: { settings: { region: { culture: 'fr_FR', isoShort: 'fr', date: 'dd/mm/yyyy', timeZone: 'Europe/Paris' } } } };
    var confNoIsoShort  = { content: { settings: { region: { culture: 'fr_FR' } } } };
    var confNoRegion    = { content: { settings: {} } };
    var confLegacyBad   = { content: { settings: { region: { shortCode: 'zz' } } } };
    var confLegacyGood  = { content: { settings: { region: { shortCode: 'fr' } } } };

    it('sanity — region data loaded, en and fr distinguishable by content', function() {
        var en = null, fr = null;
        for (var k = 0; k < LOCALES.length; k++) {
            if (LOCALES[k].lang === 'en') { en = LOCALES[k].content; }
            if (LOCALES[k].lang === 'fr') { fr = LOCALES[k].content; }
        }
        assert.ok(en && en.length > 0, 'en region data present');
        assert.ok(fr && fr.length > 0, 'fr region data present');
        // can-fail control in BOTH directions — a duplicated or unlocalized
        // fr file (the #50 defect shapes) classifies as 'en' and fails here
        assert.equal(resolvedLang(en), 'en', 'en set must classify as en');
        assert.equal(resolvedLang(fr), 'fr', 'fr set must classify as fr');
    });

    it('helper: isoShort wins, shortCode is legacy fallback, en is the final default', function() {
        assert.equal(getLocaleFallbackLang(confSchemaValid), 'fr');
        assert.equal(getLocaleFallbackLang({ content: { settings: { region: { isoShort: 'de', shortCode: 'fr' } } } }), 'de');
        assert.equal(getLocaleFallbackLang(confLegacyGood), 'fr');
        assert.equal(getLocaleFallbackLang(confNoIsoShort), 'en');
        assert.equal(getLocaleFallbackLang(confNoRegion), 'en');
        assert.equal(getLocaleFallbackLang(null), 'en');
    });

    it('loaded language takes the try path — catch untouched', function() {
        var warns = [];
        var out = newBridge(confSchemaValid, 'en', warns);
        assert.equal(resolvedLang(out), 'en');
        assert.equal(warns.length, 0);
    });

    it('unknown lang + schema-valid region → isoShort fallback, honest warn', function() {
        var warns = [];
        var out = newBridge(confSchemaValid, 'xx', warns);
        assert.equal(resolvedLang(out), 'fr', 'isoShort fr resolved the fr region set');
        assert.match(warns[0], /replacing by default: `fr`/);
        assert.doesNotMatch(warns[0], /undefined/);
    });

    it('unknown lang + region WITHOUT isoShort/shortCode → en default, honest warn', function() {
        var warns = [];
        var out = newBridge(confNoIsoShort, 'xx', warns);
        assert.equal(resolvedLang(out), 'en');
        assert.match(warns[0], /replacing by default: `en`/);
    });

    it('unknown lang + region block ABSENT → NO throw, en default (pre-fix: TypeError)', function() {
        var warns = [];
        var out = newBridge(confNoRegion, 'xx', warns);
        assert.equal(resolvedLang(out), 'en');
        assert.match(warns[0], /replacing by default: `en`/);
    });

    it('legacy shortCode naming an UNLOADED lang → NO throw, en retry (pre-fix: TypeError)', function() {
        var warns = [];
        var out = newBridge(confLegacyBad, 'xx', warns);
        assert.equal(resolvedLang(out), 'en', 'fallback findOne missed → guarded en retry');
        assert.match(warns[0], /replacing by default: `zz`/);
    });

    it('legacy shortCode naming a LOADED lang still honoured', function() {
        var warns = [];
        var out = newBridge(confLegacyGood, 'xx', warns);
        assert.equal(resolvedLang(out), 'fr');
    });

    it('SUBTRACT — pre-fix shape THREW when the region block was absent', function() {
        var warns = [];
        assert.throws(function() { oldBridge(confNoRegion, 'xx', warns); }, /shortCode/);
        assert.equal(warns.length, 0, 'the warn itself was the throw site — it never printed');
    });

    it('SUBTRACT — pre-fix shape THREW on an unloaded legacy shortCode', function() {
        var warns = [];
        assert.throws(function() { oldBridge(confLegacyBad, 'xx', warns); }, /content/);
        assert.match(warns[0], /replacing by default: `zz`/, 'warn printed, then the .content deref threw');
    });

    it('SUBTRACT — pre-fix schema-valid shape now THROWS at the undefined filter (#B396)', function() {
        // region present, no shortCode: historically findOne({lang: undefined})
        // match-alled to the FIRST record (JSON.stringify dropped undefined
        // filter keys), so the old shape returned the en content while warning
        // `undefined` — the accidental fallback #B100 was filed against. #B396
        // closed the match-all at Collection.find()'s entry, so the same
        // pre-fix bytes now refuse loudly at the lookup: the accident is
        // structurally impossible. The warn still fires first — it precedes
        // the lookup — so the historical `undefined` interpolation survives
        // as the observable half of the old record.
        var warns = [];
        assert.throws(
            function() { oldBridge(confNoIsoShort, 'xx', warns); },
            /filter `lang` cannot be left undefined/
        );
        assert.match(warns[0], /replacing by default: `undefined`/);
    });

});


describe('03 - country-locale lookup keys on isoShort (#B101)', function() {

    // ---- source pins --------------------------------------------------------

    it('filters the region rows on isoShort with an uppercase-normalized code', function() {
        // #P39 realignment — the lookup moved from a per-request Collection
        // findOne into the memoized _resolveLocaleRow helper. The semantics
        // this pin locks are unchanged: the region rows are keyed on isoShort,
        // and the incoming country code is uppercase-normalized before the
        // compare (rows carry UPPERCASE ISO 3166-1 alpha-2 — #B101).
        assert.match(CTRL_SRC, /_resolveLocaleRow\(\s*userLocales\s*,\s*userLangCode\s*,\s*userCountryCode\s*\)/,
            'the pinned ternary must resolve the row through the culture memo');
        assert.match(CTRL_SRC, /var\s+iso\s*=\s*countryCode\.toUpperCase\(\)/,
            'the helper must normalize the incoming code to uppercase');
        assert.match(CTRL_SRC, /\.isoShort\s*===\s*iso/,
            'the helper must key the compare on isoShort');
    });

    it('the dead `short` filter is gone file-wide', function() {
        // The region data never carried a `short` key — a `findOne({ short: … })`
        // could only ever miss (or match-all on an undefined value).
        assert.doesNotMatch(CTRL_SRC, /findOne\(\s*\{\s*short\s*:/);
    });

    it('a country-less culture resolves to an explicit {} — never the match-all', function() {
        // The guard must gate the lookup itself: an undefined-valued filter key
        // serializes to `{}` and matches EVERY record, so the lookup may only
        // run when a non-empty country code exists.
        assert.match(CTRL_SRC, /options\.conf\.locale\s*=\s*\(\s*typeof\(userCountryCode\)\s*==\s*'string'\s*&&\s*userCountryCode\.length\s*>\s*0\s*\)/);
    });

    // ---- behavioural replica — REAL Collection + REAL region data ----------

    var Collection = require(path.join(FW, 'lib/collection'));
    var EN_ROWS    = require(path.join(FW, 'core/locales/dist/region/en.json'));

    // #P39 realignment — the lookup executes the EXTRACTED shipped bytes of
    // _resolveLocaleRow (no replica to drift), wrapped in the shipped ternary
    // + per-request clone semantics. The helper closes over the module-level
    // _localeRowMemo, injected here as a Function parameter with a fresh memo
    // per call so arms stay independent.
    function extractResolveLocaleRow() {
        var decl  = 'var _resolveLocaleRow = function(contentRows, langCode, countryCode) {';
        var start = CTRL_SRC.indexOf(decl);
        assert.ok(start > -1, 'extraction control: the _resolveLocaleRow declaration must exist');
        assert.equal(CTRL_SRC.indexOf(decl, start + 1), -1,
            'extraction control: the declaration must appear exactly once');
        var i = start + decl.length; // the decl string ends with `{` — start just past it
        var depth = 1;
        while (depth > 0 && i < CTRL_SRC.length) {
            var ch = CTRL_SRC[i];
            if (ch === '{') { depth++; }
            else if (ch === '}') { depth--; }
            i++;
        }
        assert.equal(depth, 0, 'extraction control: braces must balance');
        var fnSrc = CTRL_SRC.slice(start + 'var _resolveLocaleRow = '.length, i);
        return new Function('_localeRowMemo', 'return (' + fnSrc + ');')({});
    }

    function newLocaleLookup(userLocales, userCountryCode) {
        var resolveRow = extractResolveLocaleRow();
        return ( typeof(userCountryCode) == 'string' && userCountryCode.length > 0 )
            ? ( JSON.clone( resolveRow(userLocales, 'en', userCountryCode) || {} ) )
            : {};
    }

    // Verbatim-lifted OLD lookup (the pre-fix statement) — the subtract.
    function oldLocaleLookup(userLocales, userCountryCode) {
        return new Collection(userLocales).findOne({ short: userCountryCode }) || {};
    }

    it('sanity — the region data carries isoShort and no `short` key', function() {
        assert.ok(EN_ROWS.length > 0, 'region rows present');
        assert.equal(typeof EN_ROWS[0].isoShort, 'string', 'rows key on isoShort');
        for (var i = 0; i < EN_ROWS.length; i++) {
            assert.ok(!('short' in EN_ROWS[i]), 'no region row may carry a `short` key');
        }
    });

    it('a present country code resolves the REAL country record', function() {
        var rec = newLocaleLookup(EN_ROWS, 'US');
        assert.equal(rec.isoShort, 'US');
        assert.equal(rec.currency.alphacode, 'USD', 'currency data rides the resolved record');
    });

    it('a lowercase country code is normalized (Accept-Language case-tolerance)', function() {
        var rec = newLocaleLookup(EN_ROWS, 'us');
        assert.equal(rec.isoShort, 'US');
    });

    it('a country-less culture resolves to an explicit empty object', function() {
        assert.deepEqual(newLocaleLookup(EN_ROWS, undefined), {});
        assert.deepEqual(newLocaleLookup(EN_ROWS, ''), {});
    });

    it('an unknown country code degrades to {} via the || {} guard', function() {
        assert.deepEqual(newLocaleLookup(EN_ROWS, 'ZZ'), {});
    });

    it('#P39 — the memo returns a consistent row, and each request gets its OWN copy', function() {
        // One extraction, one shared memo — the second lookup is the memo-HIT
        // path; the per-request JSON.clone is what isolates the .date write
        // (and any app mutation) from sibling requests.
        var resolveRow = extractResolveLocaleRow();
        var hitA = JSON.clone( resolveRow(EN_ROWS, 'en', 'US') || {} );
        var hitB = JSON.clone( resolveRow(EN_ROWS, 'en', 'US') || {} );
        assert.equal(hitA.isoShort, 'US');
        assert.deepEqual(hitA, hitB, 'memo hit must resolve the same record');
        hitA.date = { now: 'mutated-by-request-A' };
        hitA.currency.alphacode = 'XXX';
        assert.equal(typeof hitB.date, 'undefined', 'request B must not see request A\'s date write');
        assert.equal(hitB.currency.alphacode, 'USD', 'nested subtrees must be isolated per request too');
        assert.equal(EN_ROWS.filter(function(r){ return r.isoShort === 'US'; })[0].currency.alphacode, 'USD',
            'the pristine source row must never be touched');
    });

    it('SUBTRACT — the pre-fix `short` filter could NEVER match a real code', function() {
        assert.deepEqual(oldLocaleLookup(EN_ROWS, 'US'), {}, 'no row carries `short`, so the lookup always missed');
    });

    it('SUBTRACT — the pre-fix shape now THROWS at the undefined country filter (#B396)', function() {
        // historically findOne({ short: undefined }) match-alled to the FIRST
        // region row — the junk-record leak #B101 guarded against. #B396
        // closed the match-all at Collection.find()'s entry, so the same
        // pre-fix bytes now refuse loudly: the leak is structurally impossible.
        assert.throws(
            function() { oldLocaleLookup(EN_ROWS, undefined); },
            /filter `short` cannot be left undefined/
        );
    });

});
