/**
 * @module gina/lib/cmd/framework/man
 * @description `gina framework:man` — renders the framework manual page
 * (`lib/cmd/gina-framework.1.md`). Thin re-export of the shared engine in
 * {@link module:gina/lib/cmd/man-render}, which picks the group from
 * `opt.task.topic`.
 */
// alias
module.exports = require('../man-render');
