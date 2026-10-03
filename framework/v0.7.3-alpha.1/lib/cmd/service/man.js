/**
 * @module gina/lib/cmd/service/man
 * @description `gina service:man` — shows the service manual. No
 * `gina-service.1.md` source exists yet, so the shared engine falls back to
 * `lib/cmd/service/help.txt`. Thin re-export of
 * {@link module:gina/lib/cmd/man-render}, which picks the group from
 * `opt.task.topic`.
 */
// alias
module.exports = require('../man-render');
