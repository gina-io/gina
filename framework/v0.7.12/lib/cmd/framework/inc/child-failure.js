/**
 * @module gina/lib/cmd/framework/inc/child-failure
 *
 * Builds the message a command reports when a gina CLI command it ran as a child
 * (`execFileSync(process.execPath, [<install>/bin/cli, …])`) failed (#B905).
 *
 * A gina CLI command writes its errors through gina's logger, on stdout: the
 * catch in `lib/cmd/framework/init.js` logs « Gina has some troubles with this
 * command » there and exits 1. The callers built their message from the
 * child's stderr alone, an empty Buffer in that case (truthy, so it was used),
 * and `exit('')` frames exit code 0 for an empty message: `gina bundle:start`
 * reported success with nothing started when its `framework:link-node-modules`
 * child failed (measured), and `framework:link` reported a bare `Error`.
 *
 * The message built here is never empty: it names the child command and its
 * exit code (or signal), and carries the child's stderr and its stdout, or else
 * the error's own message. Both streams, because either may hold the reason: the
 * gina CLI writes its errors on stdout, while Node writes on stderr an uncaught
 * exception and its own warnings — and a warning there is timing-dependent
 * (Node emits it on a later tick, which a child that exits at once never
 * reaches), so preferring stderr hid the reason behind « ExperimentalWarning:
 * SQLite … » in one run of the same failure and not in the next (measured).
 */

/**
 * The trimmed text of a child's captured output.
 *
 * @inner
 * @private
 * @param {Buffer|string|null|undefined} output - `err.stderr` or `err.stdout`
 * @returns {string} the trimmed text, `''` when there is none
 */
function textOf(output) {
    if ( output === null || typeof(output) == 'undefined' ) {
        return '';
    }
    return String(output).trim();
}

/**
 * Describes a failed child command for the user, never as an empty string.
 *
 * @param {Error} err - the error `execFileSync()` threw: its `status` (exit code),
 *   `signal`, `stderr` and `stdout`
 * @param {string} command - the command as the user would type it, e.g.
 *   `gina framework:link-node-modules @myproject`
 * @returns {string} « `<command>` failed (exit code N) », followed on the next lines
 *   by the child's stderr and its stdout (each when not empty), or else the error's message
 *
 * @example
 * try {
 *     execFileSync(process.execPath, [cli, 'link-node-modules', '@myproject']);
 * } catch (linkErr) {
 *     return exit(describeChildFailure(linkErr, 'gina framework:link-node-modules @myproject'));
 * }
 * // `gina framework:link-node-modules @myproject` failed (exit code 1):
 * // … Gina has some troubles with this command: …
 */
function describeChildFailure(err, command) {
    var head = '`'+ command +'` failed';
    if ( err && typeof(err.status) == 'number' ) {
        head += ' (exit code '+ err.status +')';
    } else if ( err && err.signal ) {
        head += ' (signal '+ err.signal +')';
    }

    var output = '';
    if ( err ) {
        output = [ textOf(err.stderr), textOf(err.stdout) ].filter(function (text) { return text !== ''; }).join('\n')
            || textOf(err.message);
    }

    return ( output ) ? head +':\n'+ output : head;
}

module.exports = describeChildFailure;
module.exports.describeChildFailure = describeChildFailure;
