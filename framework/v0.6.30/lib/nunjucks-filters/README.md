# lib/nunjucks-filters

Per-request filter registry for the nunjucks render path (`controller.render-nunjucks.js`).

Mirrors `lib/swig-filters` — same factory shape, same 7 public filters
(`getUrl`, `getWebroot`, `length`, `nl2br`, `addHours`, `addDays`, `addYears`).
`getConfig` is internal and excluded from `env.addFilter()` registration to
match the swig path's `swig.setFilter` loop.
