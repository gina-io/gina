/**
 * @module gina/lib/cmd/project/man
 * @description `gina project:man` — shows the project manual. No
 * `gina-project.1.md` source exists yet, so the shared engine falls back to
 * `lib/cmd/project/help.txt`. Thin re-export of
 * {@link module:gina/lib/cmd/man-render}, which picks the group from
 * `opt.task.topic`.
 */
// alias
module.exports = require('../man-render');
