# Country Codes
Ref.: https://datahub.io/core/country-codes
https://github.com/datasets/country-codes

Comprehensive country code information, including ISO 3166 codes, ITU dialing
codes, ISO 4217 currency codes, and many others. Provided as a [Tabular Data
Package](https://specs.frictionlessdata.io/tabular-data-package/).

## Data

Data comes from multiple sources as follows:

Customary English short names are from
[Unicode Common Locale Data Repository (CLDR) Project] (https://github.com/unicode-cldr/cldr-localenames-full/blob/master/main/en/territories.json)
Note: CLDR shorter names "ZZ-alt-short" are used when available

ISO 3166 official English and French short names are from
[United Nations Statistics Division](https://unstats.un.org/unsd/methods/m49/m49.htm)

ISO 4217 currency codes are from
[iso.org](https://www.iso.org/iso-4217-currency-codes.html)

Many other country codes are from
[statoids.com](https://www.statoids.com/wab.html)

Special thanks to Gwillim Law for his excellent
[statoids.com](https://www.statoids.com) site (some of the field descriptions
are excerpted from his site), which is more up-to-date than most similar
resources and is much easier to scrape than multiple Wikipedia pages.

Capital cities, languages, continents, TLDs, and geonameid are from [geonames.org](https://download.geonames.org/export/dump/countryInfo.txt)

EDGAR codes are from [sec.gov](https://www.sec.gov/edgar/searchedgar/edgarstatecodes.htm)

Culture codes explained (https://www.fincher.org/Utilities/CountryLanguageList.shtml)
short: { ISO 639 - 2 lower case letters }-{ ISO 3166 - 2 upper case letters }
long: { ISO 639 - 2 lower case letters }-{ ISO 3166 - 3 upper case letters }

## Building `dist` from resources

### countries 
https://github.com/stefangabos/world_countries/

### Region
1) Download `country-codes.csv` from the [repository](https://datahub.io/core/country-codes)
2) Open it with `Numbers` or `Excel`, then export it as `resources/region.csv` using `;` separator
3) Open a terminal to the current location and hit: 
``` tty
node src/make --target=region --region=en
```
or if you want to select multiple languages
``` tty
node src/make --target=region --region=en,fr
```

A `dist/region/en.json` file will be created.

Each requested language emits its own **standalone** `dist/region/<lang>.json` —
`--region=en,fr` writes `en.json` AND `fr.json`, each carrying the full country
set exactly once. Rows without an ISO 3166 alpha-2 code are dropped (they cannot
be matched by `isoShort` and carry no display name). An optional
`--outdir=<path>` writes the files somewhere else (defaults to
`dist/<target>`).

#### Per-language short names — `resources/region.names.<lang>.json`

The CSV carries English short names (CLDR, `ZZ-alt-short` when available — see
above) and the LONG official names per language, but no non-English short-name
column. For any language other than `en`, the build therefore overlays
`countryName` from `resources/region.names.<lang>.json` — a flat
`{ "<ISO 3166 alpha-2>": "<short name>" }` map sitting beside `region.csv` —
and **fails fast** if that file is missing for a requested language, so a build
can never silently ship English names under a non-English filename.

`region.names.fr.json` ships with the framework. Provenance: Unicode CLDR
(`cldr-localenames-full/main/fr/territories.json`), retrieved 2026-07-18, using
the **plain** territory names — the French `-alt-short` variants are
abbreviations (`É.-U.`, `R.-U.`), not display names, so the plain form is used
deliberately (this differs from the CSV's own English column, which prefers
`-alt-short`). To add a language, drop a `region.names.<lang>.json` built the
same way and run `node src/make --target=region --region=<lang>`.

__NB.: To keep the file updated__
```tty
 npm install data.js
```
```javascript
const {Dataset} = require('data.js')

const path = 'https://datahub.io/core/country-codes/datapackage.json'

// We're using self-invoking function here as we want to use async-await syntax:
;(async () => {
  const dataset = await Dataset.load(path)
  // get list of all resources:
  for (const id in dataset.resources) {
    console.log(dataset.resources[id]._descriptor.name)
  }
  // get all tabular data(if exists any)
  for (const id in dataset.resources) {
    if (dataset.resources[id]._descriptor.format === "csv") {
      const file = dataset.resources[id]
      // Get a raw stream
      const stream = await file.stream()
      // entire file as a buffer (be careful with large files!)
      const buffer = await file.buffer
      // print data
      stream.pipe(process.stdout)
    }
  }
})()
```

### Currency
1) Download [`codes-all.csv`](https://raw.githubusercontent.com/datasets/currency-codes/master/data/codes-all.csv)
2) Open it with `Numbers` or `Excel`, then export it as `resources/currency.csv` using `;` separator
3) Open a terminal to the current location and hit:
``` tty
node src/make --target=currency
```    
A `dist/currency.json` file will be created.

### Languages
1) Download [`iso-languagecodes.txt`](https://download.geonames.org/export/dump/iso-languagecodes.txt) from https://www.geonames.org
2) Import it to `Numbers` or `Excel`, then export it as `resources/language.csv` using `;` separator
3) Open a terminal to the current location and hit: `node src/make --target=language`: a `dist/language.json` file will be created.