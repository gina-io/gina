/**
 * @module gina/lib/cmd/bundle/man
 * @description `gina bundle:man` — shows the bundle manual. No
 * `gina-bundle.1.md` source exists yet, so the shared engine falls back to
 * `lib/cmd/bundle/help.txt`. Thin re-export of
 * {@link module:gina/lib/cmd/man-render}, which picks the group from
 * `opt.task.topic`.
 */
// alias
module.exports = require('../man-render');
