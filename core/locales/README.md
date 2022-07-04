# Country Codes
Ref.: https://github.com/datasets/country-codes

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

## Building `dist` from resources

### Region
1) Download `country-codes.csv` from the repository
2) Open it with `Numbers` or `Excel`, then export it as `resources/region.csv` using `;` separator
3) Open a terminal to the current location and hit: 
``` tty
node src/make --target=region --region=en
```
A `dist/region/en.json` file will be created.

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