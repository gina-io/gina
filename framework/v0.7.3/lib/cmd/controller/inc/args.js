/**
 * @module gina/lib/cmd/controller/inc/args
 *
 * Pure positional-argument parser for the `controller:*` verbs.
 *
 * CmdHelper's clean positional list (`splice(0,3)` + drop `@project` / `--flag`)
 * only runs for `bundle:` tasks (helper.js). For any other topic — `controller:`
 * included — `self.bundles` is contaminated with the project's OTHER bundles, so
 * a multi-positional verb cannot read its `<name> <bundle>` (or
 * `<old> <new> <bundle>`) operands from it reliably. This helper reproduces the
 * proven `bundle:` cleanup against the handler's own `opt.argv`, keeping the
 * logic contained to the controller group (no shared-file change) and
 * require-by-path unit-testable.
 *
 * No `fs`, no framework globals.
 */

/**
 * Extracts the ordered positional operands from an offline command's argv,
 * dropping the `[node, launcher, topic:action]` prefix and every `@project` /
 * `--flag` token. Mirrors CmdHelper's `bundle:` positional cleanup
 * (`argv.slice(3)` then filter `^@` / `^--`).
 *
 * @param {string[]} argv - The handler's `opt.argv`
 *                          (`[node, gina, 'controller:add', <positionals…>, '@project', '--flag']`)
 * @returns {string[]} The positional operands, in order
 *
 * @example
 *  positionals(['node','gina','controller:add','checkout','web','@app','--controls=a,b']);
 *  // ['checkout', 'web']
 *
 * @example
 *  positionals(['node','gina','controller:rename','old','new','web','@app','--dry-run']);
 *  // ['old', 'new', 'web']
 */
function positionals(argv) {
    var arr = (argv || []).slice(3)
        , out = [];
    for (var i = 0; i < arr.length; i++) {
        var tok = arr[i];
        if ( typeof(tok) != 'string' ) {
            continue;
        }
        if ( tok.charAt(0) === '@' || tok.indexOf('--') === 0 ) {
            continue;
        }
        out.push(tok);
    }
    return out;
}

module.exports = {
    positionals : positionals
};
