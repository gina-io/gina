// imports
var fs          = require('fs');
var utils       = require('./../../utils') || require.cache[require.resolve('./../../utils')];
var helpers     = utils.helpers;
var console     = utils.logger;
var inherits    = utils.inherits;
var merge       = utils.merge;


/**
 * Make country list from *.csv
 *
 * */
function Make() {
    var self = {}, rec = {};
    
    var setup = function () {


        var opt         = {}
            , filename  = null
            , targets   = [ 'currency', 'region' ]
            , tmp       = null
            , dir       = __dirname
            ;

        for (var i = 1, len = process.argv.length; i < len; ++i) {
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

        filename = (opt.filename) ? opt.filename : _(dir +'/resources/'+ opt.target +'.csv', true);

        var region      = (opt.region) ? opt.region : 'en';
        var mappingFile = _(dir+ '/resources/'+ opt.target +'.mapping.json', true);
        var content     = null;

        rec.mapping = {
            "name"                              : "full",
            "official_name_en"                  : "officialName.short",
            "ISO3166-1-Alpha-2"                 : "short",
            "ISO3166-1-Alpha-3"                 : "long",
            "M49"                               : "m49",
            "ITU"                               : "itu",
            "MARC"                              : "marc",
            "WMO"                               : "wmo",
            "DS"                                : "ds",
            "Dial"                              : "dial",
            "FIFA"                              : "fifa",
            "FIPS"                              : "fips",
            "GAUL"                              : "gaul",
            "IOC"                               : "ioc",
            "ISO4217-currency_alphabetic_code"  : "currency.code",
            "ISO4217-currency_country_name"     : "currency.countryName",
            "ISO4217-currency_minor_unit"       : "currency.minorUnit",
            "ISO4217-currency_name"             : "currency.name",
            "ISO4217-currency_numeric_code"     : "currency.numCode",
            "is_independent"                    : "isIndependent",
            "Capital"                           : "capital",
            "Continent"                         : "continent",
            "TLD"                               : "tld",
            "Languages"                         : "languages",
            "Geoname ID"                        : "geonameId",
            "EDGAR"                             : "edgar"
        };

        if ( opt.region != 'en' ) {
            rec.mapping[ 'official_name_' + opt.region ] = "officialName.short"
        }

        cleanMapping();

        try {

            content = fs.readFileSync(filename);

            csvToCollection(content.toString());

            var target = _(dir + '/../dist/'+ opt.target, true);
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

    var cleanMapping = function() {
        var newMapping = {};
        for (var map in rec.mapping) {
            newMapping[map.replace(/(^[\s]|((?![_-\s+a-zA-Z0-9]).)*)/g, '')] = rec.mapping[map]
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

                        var _args = JSON.parse(JSON.stringify(args));
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
            for (var a = 0, aLen = arr.length; a < aLen; ++a) {
                aContent = arr[a].split(/"/g);

                for (var ac = 0, acLen = aContent.length; ac < acLen; ++ac) {
                    if ( ac == acLen-1 ) {
                        aContent[ac] = (aContent[ac].substr(0,1) == ';') ? aContent[ac].substr(1) : aContent[ac];
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

    setup();
    process.exit(0);
};

module.exports = Make()