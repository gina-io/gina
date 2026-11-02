// imports
var fs          = require('fs');
var path        = require('path');
var lib         = require('./../../../lib') || require.cache[require.resolve('./../../../lib')];
var helpers     = lib.helpers;
var console     = lib.logger;
var inherits    = lib.inherits;
var merge       = lib.merge;


/**
 * Make country list from *.csv
 *
 * */
function Make() {
    var self = {}, rec = {};

    var setup = function () {

        var opt         = {}
            , targets   = [ 'currency', 'region' ]
            , tmp       = null
        ;

        for (let i = 1, len = process.argv.length; i < len; ++i) {
            if ( /^\-\-[-_0-9a-z]+\=/i.test( process.argv[i] ) ) {
                tmp = process.argv[i].split(/\=/);
                tmp[0] = tmp[0].replace(/\-\-/, '');
                opt[ tmp[0] ] = tmp[1]
            }
        }

        if ( !opt.target )
            throw new Error('`--target=<target>` option is missing.');

        if ( targets.indexOf(opt.target) < 0 )
            throw new Error('`--target=`'+ opt.target +' option is not allowed.');

        if ( typeof(opt.region) != 'undefined' && /\,/.test(opt.region) ) {
            var regions = opt.region.split(/\,/g);
            for (let i=0, len=regions.length; i<len; ++i) {
                let options = JSON.clone(opt);
                options.region = regions[i];
                generate(options)
            }
            return;
        }
        generate(opt)
    }

    var generate = function(opt) {

        var filename    = null
            , dir       = __dirname
        ;

        filename = (opt.filename) ? opt.filename : _(dir +'/resources/'+ opt.target +'.csv', true);

        var region      = (opt.region) ? opt.region : 'en';
        var mappingFile = _(dir+ '/resources/'+ opt.target +'.mapping.json', true);
        var content     = null;
        try {
            // was: rec.mapping = requireJSON(mappingFile); — loaded twice, and
            // the cached object was then mutated by the non-en remap below, so
            // a later pass of a `--region=<a>,<b>` run inherited the previous
            // language's remapped mapping (`official_name_en` already deleted).
            // Cloning the cached copy lets every pass start pristine.
            rec.mapping = JSON.clone(requireJSON(mappingFile));
        } catch (err) {
            throw err
        }

        if ( opt.region != 'en' ) {
            rec.mapping[ 'official_name_' + opt.region ] = JSON.clone(rec.mapping["official_name_en"]);
            // remove default
            delete rec.mapping["official_name_en"];
            console.debug('region set to ', opt.region);
        }

        cleanMapping();

        try {

            content = fs.readFileSync(filename);

            // Each pass emits a standalone file: reset the accumulator so a
            // `--region=en,fr` run cannot append one language's rows to the
            // previous language's output (every `isoShort` ended up duplicated,
            // English rows first — and lookups by `isoShort` always matched
            // the English copy).
            self.body = null;

            csvToCollection(content.toString());

            if ( opt.target == 'region' ) {
                // Drop statistical-aggregate rows carrying no ISO 3166 alpha-2
                // code (M49-only entries): they cannot be matched by `isoShort`
                // and would ship with empty identifiers.
                self.body = self.body.filter(function (row) {
                    return typeof(row.isoShort) == 'string' && row.isoShort.trim().length > 0
                });

                if ( region != 'en' ) {
                    localizeCountryNames(region, filename)
                }
            }

            var target = ( opt.outdir ) ? _(''+ opt.outdir, true) : _(dir + '/../dist/'+ opt.target, true);
            if ( opt.target == 'region') {
                target += '/'+ region +'.json'
            } else {
                target += '/'+ opt.target +'.json'
            }

            save( target, JSON.stringify(self.body, null, 2) )

        } catch (err) {
            throw err
        }
    }

    /**
     * Overlay `countryName` with the localized short names shipped beside the
     * source CSV (`region.names.<lang>.json`, keyed by ISO 3166 alpha-2 code).
     * The CSV `name` column only carries the English short name, so a non-en
     * build without a names file would silently emit English `countryName`
     * values — fail fast instead. Codes absent from the names file keep the
     * English short name.
     *
     * @inner
     * @param {string} region - language code being generated (e.g. `fr`)
     * @param {string|object} csvFilename - resolved source CSV path; the names file is expected in the same directory
     * @returns {undefined}
     * */
    var localizeCountryNames = function (region, csvFilename) {
        var namesFile = path.join( path.dirname( ''+ csvFilename ), 'region.names.'+ region +'.json' );
        if ( !fs.existsSync(namesFile) ) {
            throw new Error('`countryName` localization source not found for `'+ region +'`: expected `'+ namesFile +'` (ISO 3166 alpha-2 code -> localized short name)');
        }
        var names = requireJSON(namesFile);
        for (let i = 0, len = self.body.length; i < len; ++i) {
            if ( typeof(names[ self.body[i].isoShort ]) == 'string' && names[ self.body[i].isoShort ].length > 0 ) {
                self.body[i].countryName = names[ self.body[i].isoShort ]
            }
        }
    }

    var cleanMapping = function() {
        var newMapping = {}, key = null;
        for (let map in rec.mapping) {
            key = map.replace(/(^[\s]|((?![_-\s+a-zA-Z0-9]).)*)/g, '');
            newMapping[key] = rec.mapping[map]
        }
        rec.mapping = newMapping;
    }

    var save = function (filename, data) {

        if ( fs.existsSync(filename) ) {
            //Just in case.
            fs.chmodSync(filename, 0755);

            if ( fs.unlinkSync ) {
                fs.unlinkSync(filename)
            } else {
                fs.unlink(filename);
            }
        }

        //Setting permission.
        try {
            fs.writeFileSync(filename, data);

            fs.chmodSync(filename, 0755)
        } catch (err) {
            throw err
        }
    }

    var makeObject = function(obj, value, args, len, i) {

        if (i >= len) {
            return false
        }

        var key     = args[i];
        var nextKey = ( i < len-1 && typeof(args[i+1]) != 'undefined' ) ?  args[i+1] : null;

        if ( typeof(obj[key]) == 'undefined' ) {
            if (nextKey && /^\d+$/.test(nextKey)) {
                nextKey = parseInt(nextKey);
                obj[key] = []
            } else {
                obj[key] = {}
            }
        }

        for (var o in obj) {

            if ( typeof(obj[o]) == 'object' ) {

                if ( Array.isArray(obj[o]) ) {

                    if (o === key) {

                        var _args = JSON.clone(args);
                        _args.splice(0, 1);

                        for (var a = i, aLen = _args.length; a < aLen; ++a) {
                            key = parseInt(_args[a])
                            obj[o][key] = {};

                            if (a == aLen-1) {
                                obj[o][key] = value;
                            }
                        }
                    }

                } else if ( o === key ) {

                    if (i == len-1) {
                        obj[o] = value;
                    } else {
                        makeObject(obj[o], value, args, len, i+1)
                    }
                }
            }
        }

    }

    var csvToCollection = function (content) {

        var rows            = content.split(/[\n\r]+/)
            , cols          = rows[0].split(';') // header cols
            , body          = self.body || []
            , bodyCols      = null
            , i             = 0
            , index         = ( self.body ) ? self.body.length : 0
            , r             = 1 // row after after the header
            , col           = ""
            , len           = rows.length
            , hasContent    = null
            , arr           = []
            , aLen          = 0
            , aContent      = null
            , bc            = 0
            , subArr        = []
            , subCols       = null;


        for (; r<len; ++r) {// on row
            // eject empty records
            // hasContent = rows[r].match(/((\w+?),|(\w+?)",)/g);//if any word preceding `,`
            // if (!hasContent) {
            //     continue;
            // }

            arr = rows[r].replace(/;"/, ';').replace(/\"/g, '').split(/;/g);

            bodyCols    = [];
            bc          = 0;
            aLen = arr.length
            for (let a = 0; a < aLen; ++a) {
                aContent = arr[a].split(/"/g);

                for (let ac = 0, acLen = aContent.length; ac < acLen; ++ac) {
                    if ( ac == acLen-1 ) {
                        aContent[ac] = (aContent[ac].substring(0,1) == ';') ? aContent[ac].substring(1) : aContent[ac];
                        subArr = aContent[ac].split(/;/);
                        for (var s = 0, sLen = subArr.length; s < sLen; ++s) {
                            bodyCols[bc] = subArr[s];
                            ++bc
                        }
                    } else {
                        if (aContent[ac]) {
                            bodyCols[bc] = aContent[ac];
                            ++bc
                        }
                    }
                }
            }


            //formating
            i = 0;
            for (; i<bodyCols.length; ++i) { // on col
                if (cols[i]) {

                    col = cols[i].replace(/(^[\s]|((?![_-\s+a-zA-Z0-9]).)*)/g, '');

                    // excluding all columns not in the mapping
                    if (
                        col && typeof(rec.mapping[col]) != 'undefined'
                    ) {
                        if ( typeof(body[index]) == 'undefined' ) body[index] = {};
                        bodyCols[i] = bodyCols[i].replace(/\"/g, '');

                        // column mapping
                        col = rec.mapping[col];


                        // formating content
                        // like modifying colum content on the fly

                    }

                }
            }

            // filter (complex) - need to compare multiple columns... so we need to make sure they exists
            i = 0;
            for (; i<bodyCols.length; ++i) { // on col
                if (cols[i]) {

                    col = cols[i].replace(/((?![a-zA-Z0-9_-\s+]).)*/g, '');

                    // excluding all columns not in the mapping
                    if (
                        col && typeof(rec.mapping[col]) != 'undefined'
                    ) {

                        if (typeof(bodyCols[i]) == 'string') {
                            bodyCols[i] = bodyCols[i].replace(/\"/g, '');
                        }

                        // column mapping
                        col = rec.mapping[col];

                        // convert values to array
                        if ( /^(languages|dial)$/.test(col) ) {
                            bodyCols[i] = bodyCols[i].split(/\,/)
                        }

                        if ( /\./.test(col) ) {
                            subCols = col.split(/\./g);

                            // building object tree
                            makeObject(body[index], bodyCols[i], subCols, subCols.length, 0);

                        } else {
                            body[index][col] = bodyCols[i]
                        }
                    }
                }
            }

            // additional infos
            if ( typeof(body[index]) != "undefined" && typeof(bodyCols) != 'undefined') {
                // add whatever you need to
                ++index
            }
        }

        self.body = body;

    }

    return {
        setup       : setup,
        generate    : generate
    }
}

// was: `setup(); process.exit(0);` inside Make() + `module.exports = Make();`
// — executing at require time made the module untestable (any `require` ran
// the CLI and exited the process). The CLI entry now only runs when the file
// is invoked directly: `node src/make --target=region --region=en,fr`.
if (require.main === module) {
    Make().setup();
    process.exit(0);
}

module.exports = Make;