# Country Codes
Ref.: https://datahub.io/core/country-codes
https://github.com/datasets/country-codes

Comprehensive country code information, including ISO 3166 codes, ITU dialing
codes, ISO 4217 currency codes, and many others. Provided as a [Simple Data
Format Data Package](http://dataprotocols.readthedocs.io/en/latest/simple-data-format.html).

## Data

Data comes from multiple sources as follows:

Customary English short names are from
[Unicode Common Locale Data Repository (CLDR) Project] (https://github.com/unicode-cldr/cldr-localenames-full/blob/master/main/en/territories.json)
Note: CLDR shorter names "ZZ-alt-short" are used when available

ISO 3166 official English and French short names are from
[United Nations Statistics Division](http://unstats.un.org/unsd/methods/m49/m49.htm)

ISO 4217 currency codes are from
[currency-iso.org](http://www.currency-iso.org/en/home/tables/table-a1.html)

Many other country codes are from
[statoids.com](http://www.statoids.com/wab.html)

Special thanks to Gwillim Law for his excellent
[statoids.com](http://www.statoids.com) site (some of the field descriptions
are excerpted from his site), which is more up-to-date than most similar
resources and is much easier to scrape than multiple Wikipedia pages.

Capital cities, languages, continents, TLDs, and geonameid are from [geonames.org](http://download.geonames.org/export/dump/countryInfo.txt)

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
1) Download [`iso-languagecodes.txt`](http://download.geonames.org/export/dump/iso-languagecodes.txt) from http://geonames.org
2) Import it to `Numbers` or `Excel`, then export it as `resources/language.csv` using `;` separator
3) Open a terminal to the current location and hit: `node src/make --target=language`: a `dist/language.json` file will be created.