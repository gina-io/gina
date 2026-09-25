/**
 * project:add — linkGina self-resolved CLI invocation.
 *
 * Locks the fix for the scaffolded-bundle MODULE_NOT_FOUND boot crash: linkGina
 * used to create the project's `node_modules/gina` symlink by shelling out to a
 * PATH-resolved `gina link @<project>` and silently swallowed the failure
 * (`onSuccess(err)`), so on a host without the binary on PATH (a repo checkout
 * where `npm install --ignore-scripts` skipped bin linking) project:add reported
 * success while the project had no gina symlink — and the bundle's framework
 * require crashed at boot.
 *
 * The fix:
 *   (a) spawn the running install's OWN CLI — `[process.execPath, <root>/bin/cli,
 *       'link', '@<project>']` (array form, path resolved from add.js's location);
 *   (b) verify the actual postcondition (the symlink exists) instead of trusting
 *       the Shell err channel (which reports any stderr output as an error);
 *   (c) route genuine failures through the (previously dead) onError parameter.
 *
 * §05 covers the same defect class in framework/link.js's stale-node_modules
 * repair path: `execSync('$(which gina) link-node-modules ...')` was PATH-resolved
 * AND its `instanceof Error` check was dead code (execSync throws on failure, it
 * never returns an Error) — now a self-resolved CLI invocation wrapped in
 * try/catch routing failures through end().
 *
 * §08/§09 lock the follow-up hardening: the CLI bootstrap sweeps GINA_* out of
 * process.env, so linkGina re-exports GINA_HOMEDIR to the spawned child (a home
 * override otherwise never reaches it — the child resolves the default home,
 * misses the just-registered project, and the link fails after registration
 * landed), and the tail of the child's captured output is appended to the
 * postcondition error instead of being discarded with the Shell temp logs.
 *
 * §10 locks the same two defect classes in the --scope/--env child blocks
 * (`scope:add` / `env:add` children): self-resolved CLI instead of a
 * PATH-resolved `gina`, GINA_HOMEDIR re-exported past the bootstrap sweep, and
 * the inherited-stdio execSync return no longer dereferenced (it is null under
 * inherited stdio, so reading it misreported every successful child as a
 * failure and exited 1).
 *
 * Run standalone:
 *   node --test test/lib/project-add-link.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var ADD_PATH = path.join(FW, 'lib/cmd/project/add.js');
var SRC = fs.readFileSync(ADD_PATH, 'utf8');

// linkGina slice — from its declaration to the end of the constructor body
var lgIdx = SRC.indexOf('var linkGina = function');
var LG = (lgIdx > -1) ? SRC.slice(lgIdx, SRC.indexOf('init()', lgIdx)) : '';

// Strips /* */ blocks and full-or-trailing // line comments so negative pins
// don't trip on the `// was:` historical lines kept next to the new code.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(function(line) { return line.replace(/^\s*\/\/.*$/, ''); })
        .join('\n');
}


// ── 01 — Source pins: self-resolved CLI spawn ───────────────────────────────

describe('01 - linkGina spawns the running install\'s own CLI (not a PATH-resolved binary)', function() {

    it('linkGina is declared in project/add.js', function() {
        assert.ok(lgIdx > -1, 'var linkGina = function not found in ' + ADD_PATH);
    });

    it('uses the array form of Shell.run with process.execPath as argv[0]', function() {
        assert.ok(
            LG.indexOf('.run([ process.execPath,') > -1,
            'expected `.run([ process.execPath, ...], true)` — the array form avoids Shell.run\'s split-on-space'
        );
    });

    it('resolves the CLI path from __dirname, targeting bin/cli', function() {
        assert.match(
            LG,
            /require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/cli'\)/,
            'expected the CLI path resolved from add.js\'s own location (framework/link.js rationale)'
        );
    });

    it('still passes the link task and the @<project> argument', function() {
        assert.match(LG, /'link',\s*'@'\+\s*self\.projectName\s*\],\s*true\)/);
    });

    it('no live PATH-resolved `gina link` call remains (comment-stripped)', function() {
        var live = stripComments(LG);
        assert.ok(
            live.indexOf(".run('gina link") < 0,
            'found a live string-form `gina link` Shell call — PATH-resolved self-invocation must not come back'
        );
    });

});


// ── 02 — Resolution replica against the real tree ───────────────────────────

describe('02 - the __dirname-resolved CLI path is the repo\'s bin/cli', function() {

    var resolved = path.resolve(path.dirname(ADD_PATH), '../../../../..', 'bin/cli');
    var expected = path.resolve(FW, '../..', 'bin', 'cli');

    it('resolves to <gina root>/bin/cli', function() {
        assert.equal(resolved, expected);
    });

    it('the resolved CLI exists on disk', function() {
        assert.ok(fs.existsSync(resolved), resolved + ' does not exist');
    });

});


// ── 03 — Source pins: postcondition check + onError wiring ──────────────────

describe('03 - linkGina verifies the symlink postcondition and surfaces failures via onError', function() {

    it('checks fs.existsSync on the project\'s node_modules/gina inside onComplete', function() {
        assert.ok(LG.indexOf("_(self.projectLocation + '/node_modules/gina', true)") > -1);
        assert.ok(LG.indexOf('if ( !fs.existsSync(ginaModule) )') > -1);
    });

    it('calls onError(err) on the missing-symlink branch', function() {
        var guardIdx = LG.indexOf('if ( !fs.existsSync(ginaModule) )');
        var errIdx   = LG.indexOf('return onError(err)', guardIdx);
        assert.ok(guardIdx > -1 && errIdx > guardIdx, 'expected `return onError(err)` after the !existsSync guard');
    });

    it('the old error-swallowing onSuccess(err) shape is gone (comment-stripped)', function() {
        assert.ok(
            stripComments(LG).indexOf('onSuccess(err)') < 0,
            'a failed link must no longer be routed through onSuccess'
        );
    });

});


// ── 04 — Pure-logic replica: postcondition gating ────────────────────────────

describe('04 - onComplete decision replica (postcondition wins over the Shell err channel)', function() {

    // Mirrors linkGina's onComplete branch logic line-for-line.
    function replica(linked, err, onError, onSuccess) {
        if (!linked) {
            err = new Error('Could not create the gina symlink' + (err ? '\n' + (err.stack || err) : ''));
            return onError(err);
        }
        onSuccess();
    }

    it('symlink present + stderr noise from the Shell → success (noise tolerated)', function() {
        var ok = false, ko = false;
        replica(true, 'Error: some warning printed to stderr', function() { ko = true; }, function() { ok = true; });
        assert.ok(ok && !ko, 'stderr noise must not fail a link whose postcondition holds');
    });

    it('symlink missing + Shell err → onError with both messages', function() {
        var got = null;
        replica(false, 'spawn gina ENOENT', function(e) { got = e; }, function() {});
        assert.ok(got instanceof Error);
        assert.ok(got.message.indexOf('Could not create the gina symlink') > -1);
        assert.ok(got.message.indexOf('spawn gina ENOENT') > -1);
    });

    it('symlink missing with no Shell err → still onError', function() {
        var got = null;
        replica(false, null, function(e) { got = e; }, function() {});
        assert.ok(got instanceof Error);
    });

});


// ── 05 — framework/link.js sibling: stale-node_modules repair path ───────────

describe('05 - framework:link stale-node_modules repair uses the self-resolved CLI in a try/catch', function() {

    var LINK_PATH = path.join(FW, 'lib/cmd/framework/link.js');
    var LINK_SRC = fs.readFileSync(LINK_PATH, 'utf8');

    it('no live PATH-resolved $(which gina) invocation remains (comment-stripped)', function() {
        assert.ok(
            stripComments(LINK_SRC).indexOf('$(which gina)') < 0,
            'found a live `$(which gina)` self-invocation in framework/link.js'
        );
    });

    it('invokes the running install\'s own CLI via process.execPath', function() {
        assert.ok(LINK_SRC.indexOf('execSync(\'"\'+ process.execPath +\'" "\'+ cli +\'" link-node-modules @\'+ self.projectName)') > -1);
    });

    it('resolves the CLI path from __dirname, targeting bin/cli', function() {
        assert.match(
            LINK_SRC,
            /var cli = require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/cli'\)/
        );
    });

    it('the __dirname-resolved CLI path from link.js is the repo\'s bin/cli and exists', function() {
        var resolved = path.resolve(path.dirname(LINK_PATH), '../../../../..', 'bin/cli');
        assert.equal(resolved, path.resolve(FW, '../..', 'bin', 'cli'));
        assert.ok(fs.existsSync(resolved));
    });

    it('the execSync is wrapped in try/catch routing the failure through end() — the dead instanceof check is gone', function() {
        var tryIdx   = LINK_SRC.indexOf('try {');
        var execIdx  = LINK_SRC.indexOf('execSync(\'"\'+ process.execPath');
        var catchIdx = LINK_SRC.indexOf('catch (linkErr)');
        assert.ok(tryIdx > -1 && execIdx > tryIdx && catchIdx > execIdx, 'expected try { execSync(...) } catch (linkErr)');
        assert.match(LINK_SRC.slice(catchIdx, catchIdx + 400), /return end\(new Error\(errOutput\), 'error'\)/);
        // execSync never RETURNS an Error — the old `err = execSync(...); if (err instanceof Error)` was dead code
        assert.ok(
            stripComments(LINK_SRC).indexOf('err = execSync') < 0,
            'the dead `err = execSync(...)` assignment shape must not come back'
        );
    });

});


// ── 06 — helper.js auto-link block (project:/bundle: start|stop|restart) ─────
//
// Scoped to the `linking node-modules & gina` block ONLY: helper.js:~407 keeps a
// DELIBERATE live `$(which gina)` (project:import prefix derivation — semantically
// "where is gina installed", left as-is by design), so no file-wide negative pin.

describe('06 - CmdHelper auto-link invokes the running install\'s own CLI', function() {

    var HELPER_PATH = path.join(FW, 'lib/cmd/helper.js');
    var HELPER_SRC = fs.readFileSync(HELPER_PATH, 'utf8');
    var blockIdx = HELPER_SRC.indexOf('// linking node-modules & gina');
    var BLOCK = (blockIdx > -1) ? HELPER_SRC.slice(blockIdx, blockIdx + 3500) : '';

    it('the auto-link block exists', function() {
        assert.ok(blockIdx > -1, 'anchor `// linking node-modules & gina` not found in helper.js');
    });

    it('no live $(which gina) remains inside the block (comment-stripped)', function() {
        assert.ok(stripComments(BLOCK).indexOf('$(which gina)') < 0);
    });

    it('resolves the CLI from __dirname (4 levels up from lib/cmd), targeting bin/cli', function() {
        assert.match(
            BLOCK,
            /var selfCli = require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/cli'\)/
        );
        var resolved = path.resolve(path.dirname(HELPER_PATH), '../../../..', 'bin/cli');
        assert.equal(resolved, path.resolve(FW, '../..', 'bin', 'cli'));
        assert.ok(fs.existsSync(resolved));
    });

    it('link-node-modules runs via process.execPath in a try/catch — the dead instanceof check is gone', function() {
        var execIdx  = BLOCK.indexOf('execSync(\'"\'+ process.execPath +\'" "\'+ selfCli +\'" link-node-modules @\'+cmd.projectName');
        var catchIdx = BLOCK.indexOf('catch (linkErr)');
        assert.ok(execIdx > -1 && catchIdx > execIdx, 'expected try { execSync(node cli link-node-modules) } catch (linkErr)');
        assert.ok(
            stripComments(BLOCK).indexOf('err = execSync') < 0,
            'the dead `err = execSync(...)` assignment shape must not come back'
        );
    });

    it('the follow-up `link` call also runs via process.execPath + selfCli', function() {
        assert.ok(BLOCK.indexOf('execSync(\'"\'+ process.execPath +\'" "\'+ selfCli +\'" link @\'+cmd.projectName') > -1);
    });

});


// ── 07 — daemon-lifecycle sites (framework start/restart) use self-resolved bin/gina

describe('07 - framework start/restart invoke the self-resolved bin/gina wrapper', function() {

    var START_PATH   = path.join(FW, 'lib/cmd/framework/start.js');
    var RESTART_PATH = path.join(FW, 'lib/cmd/framework/restart.js');
    var START_SRC   = fs.readFileSync(START_PATH, 'utf8');
    var RESTART_SRC = fs.readFileSync(RESTART_PATH, 'utf8');

    it('no live $(which gina) remains in start.js (comment-stripped)', function() {
        assert.ok(stripComments(START_SRC).indexOf('$(which gina)') < 0);
    });

    it('no live $(which gina) remains in restart.js (comment-stripped)', function() {
        assert.ok(stripComments(RESTART_SRC).indexOf('$(which gina)') < 0);
    });

    it('restart.js declares a file-scope ginaBin resolved from __dirname, targeting bin/gina', function() {
        assert.match(
            RESTART_SRC,
            /var ginaBin\s+= require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/gina'\)/
        );
    });

    it('restart.js uses ginaBin at all three sites (start, stop, bundle:restart)', function() {
        var m = RESTART_SRC.match(/'"'\+ process\.execPath \+'" "'\+ ginaBin \+'"/g) || [];
        assert.ok(m.length >= 3, 'expected >= 3 self-resolved invocations in restart.js, got ' + m.length);
    });

    it('start.js resolves ginaBin and uses it for bundle:restart', function() {
        assert.match(
            START_SRC,
            /var ginaBin = require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/gina'\)/
        );
        assert.ok(START_SRC.indexOf('\'"\'+ process.execPath +\'" "\'+ ginaBin +\'" bundle:restart \'') > -1);
    });

    it('the __dirname-resolved bin/gina exists and bin/gina self-locates its cli from __dirname', function() {
        var resolved = path.resolve(path.dirname(RESTART_PATH), '../../../../..', 'bin/gina');
        assert.equal(resolved, path.resolve(FW, '../..', 'bin', 'gina'));
        assert.ok(fs.existsSync(resolved));
        // bin/gina must keep resolving its cli from its own location for the
        // absolute-path invocation to stay PATH-independent end-to-end
        var ginaSrc = fs.readFileSync(resolved, 'utf8');
        assert.ok(ginaSrc.indexOf("__dirname + '/cli'") > -1);
    });

});


// ── 08 — env re-export: the spawned CLI child must see the parent's home ─────
//
// The CLI bootstrap sweeps every GINA_*/VENDOR_*/USER_* key out of process.env
// into the framework context (read back via getEnvVar), so a spawned child
// inherits none of them. linkGina must re-export the home explicitly or, under
// a home override, the child resolves the default home, misses the
// just-registered project, and the link fails after registration landed —
// project:add then exits 1 on an otherwise-successful registration.

describe('08 - linkGina re-exports the framework home to the spawned CLI child', function() {

    var SHELL_PATH = path.join(FW, 'lib/shell.js');
    var SHELL_SRC = fs.readFileSync(SHELL_PATH, 'utf8');

    it('Shell supports an `env` option (declared in the options map)', function() {
        assert.match(
            SHELL_SRC,
            /var local = \{\s*chdir : undefined,\s*console: undefined,\s*env : undefined\s*\}/,
            'expected the Shell options map to carry an `env` slot (setOptions rejects unknown keys)'
        );
    });

    it('the local spawn passes the configured env through', function() {
        assert.ok(
            SHELL_SRC.indexOf("{ cwd: root, stdio: [ 'ignore', out, err ], env: local.env }") > -1,
            'expected the runLocal spawn to receive `env: local.env` (undefined = inherit, existing callers unchanged)'
        );
    });

    it('linkGina composes the child env from process.env plus an explicit GINA_HOMEDIR', function() {
        assert.match(
            LG,
            /env\s*:\s*Object\.assign\(\{\},\s*process\.env,\s*\{\s*GINA_HOMEDIR\s*:\s*GINA_HOMEDIR\s*\}\s*\)/,
            'expected linkGina to re-export the home to the spawned child'
        );
    });

    it('the env rides the same setOptions call as chdir, ahead of the run', function() {
        var soIdx  = LG.indexOf('npm.setOptions({');
        var envIdx = LG.indexOf('env', soIdx);
        var runIdx = LG.indexOf('.run([ process.execPath,');
        assert.ok(soIdx > -1 && envIdx > soIdx && envIdx < runIdx);
    });

    // Mirrors the composed-env shape, driven with a post-sweep process.env
    // (the sweep leaves NO GINA_* behind).
    function composeEnv(sweptEnv, home) {
        return Object.assign({}, sweptEnv, { GINA_HOMEDIR: home });
    }

    it('replica: a post-sweep env gains GINA_HOMEDIR without losing other keys', function() {
        var swept = { PATH: '/usr/bin', HOME: '/home/someone' }; // no GINA_* — the sweep removed them
        var env = composeEnv(swept, '/tmp/custom-home/.gina');
        assert.equal(env.GINA_HOMEDIR, '/tmp/custom-home/.gina');
        assert.equal(env.PATH, '/usr/bin');
        assert.equal(env.HOME, '/home/someone');
        assert.ok(!('GINA_HOMEDIR' in swept), 'the source env object must not be mutated');
    });

    it('subtract: plain post-sweep inheritance carries NO home for the child (the defect condition)', function() {
        var swept = { PATH: '/usr/bin', HOME: '/home/someone' };
        var inherited = Object.assign({}, swept); // pre-fix shape: bare inheritance of the swept env
        assert.ok(
            !('GINA_HOMEDIR' in inherited),
            'post-sweep inheritance loses the home override — the child would resolve the default home'
        );
    });

});


// ── 09 — failure observability: the child's captured output is surfaced ──────

describe('09 - linkGina appends the child output tail to the postcondition error', function() {

    it('builds a bounded childOutput from the Shell data argument', function() {
        assert.ok(
            LG.indexOf("'\\n[ link output ] '+ String(data).trim().slice(-800)") > -1,
            'expected a bounded tail of the child output (its stdio otherwise vanishes with the Shell temp logs)'
        );
    });

    it('appends childOutput to the postcondition error message', function() {
        var errIdx = LG.indexOf("err = new Error('Could not create the gina symlink");
        assert.ok(errIdx > -1);
        var stmt = LG.slice(errIdx, LG.indexOf(';', errIdx));
        assert.ok(stmt.indexOf('+ childOutput') > -1, 'the error must carry the child output tail');
    });

    // Mirrors the childOutput construction line-for-line.
    function buildChildOutput(data) {
        return ( data && String(data).trim().length > 0 ) ? '\n[ link output ] '+ String(data).trim().slice(-800) : '';
    }

    it('replica: child output present → tail appended', function() {
        var out = buildChildOutput('project [ x ] not found\n');
        assert.equal(out, '\n[ link output ] project [ x ] not found');
    });

    it('replica: output longer than 800 chars is tail-bounded and keeps the trailing text', function() {
        var noise = new Array(900).join('a') + 'THE-ERROR';
        var out = buildChildOutput(noise);
        assert.ok(out.length <= '\n[ link output ] '.length + 800);
        assert.ok(out.indexOf('THE-ERROR') > -1, 'the tail must keep the trailing error text');
    });

    it('replica: empty / whitespace-only / absent output → no suffix', function() {
        assert.equal(buildChildOutput(''), '');
        assert.equal(buildChildOutput('   \n'), '');
        assert.equal(buildChildOutput(null), '');
        assert.equal(buildChildOutput(undefined), '');
    });

});


// ── 10 — the --scope/--env child blocks: self-resolved CLI + home re-export ──

describe('10 - project:add --scope/--env children run the self-resolved CLI with the home re-exported', function() {

    // Structural end-anchored slices: scope block runs up to the env block's
    // guard; env block runs up to the manifest-creation comment.
    var scopeIdx = SRC.indexOf("if ( self.scope && !isDefined('scope', self.scope) )");
    var envIdx   = SRC.indexOf("if ( self.env && !isDefined('env', self.env) )");
    var manIdx   = SRC.indexOf('// creating project manifest');
    var SCOPE_BLK = (scopeIdx > -1 && envIdx > scopeIdx) ? SRC.slice(scopeIdx, envIdx) : '';
    var ENV_BLK   = (envIdx > -1 && manIdx > envIdx) ? SRC.slice(envIdx, manIdx) : '';

    it('both blocks were found by their structural anchors', function() {
        assert.ok(SCOPE_BLK.length > 0, 'scope block anchor missing');
        assert.ok(ENV_BLK.length > 0, 'env block anchor missing');
    });

    [ ['scope', function() { return SCOPE_BLK; }, "'gina scope:add '", 'scope:add' ],
      ['env',   function() { return ENV_BLK;   }, "'gina env:add '",   'env:add'   ]
    ].forEach(function(spec) {
        var name = spec[0], blkFn = spec[1], oldLiteral = spec[2], task = spec[3];

        it('['+ name +'] re-exports GINA_HOMEDIR onto the child env after the process.env spread', function() {
            var blk = blkFn();
            var spreadIdx = blk.indexOf('{ ...process.env }');
            var homeIdx = blk.indexOf("currentEnv['GINA_HOMEDIR'] = GINA_HOMEDIR");
            assert.ok(spreadIdx > -1, 'expected the process.env spread');
            assert.ok(homeIdx > spreadIdx, 'expected the GINA_HOMEDIR re-export after the spread (the sweep strips it from process.env)');
        });

        it('['+ name +'] invokes the running install\'s own CLI (process.execPath + resolved bin/cli)', function() {
            var blk = blkFn();
            assert.ok(blk.indexOf('process.execPath') > -1, 'expected process.execPath');
            assert.ok(
                blk.indexOf("resolve(__dirname, '../../../../..', 'bin/cli')") > -1,
                'expected the 5-up self-resolved bin/cli (the linkGina idiom)'
            );
            assert.ok(blk.indexOf("'"+ task +"', self."+ name +"]") > -1, 'expected the '+ task +' task and the value as their own argv elements on the self-resolved CLI (#B640)');
        });

        it('['+ name +'] no longer shells out to a PATH-resolved `gina`', function() {
            assert.ok(
                stripComments(blkFn()).indexOf(oldLiteral) < 0,
                'the PATH-resolved '+ oldLiteral +' literal must be gone (repo checkouts / second installs resolve wrong)'
            );
        });

        it('['+ name +'] does not dereference the inherited-stdio execSync return', function() {
            var blk = stripComments(blkFn());
            assert.ok(blk.indexOf('.toString()') < 0, 'the null-return dereference must be gone');
            assert.ok(blk.indexOf('execFileSync(process.execPath, args, execOptions);') > -1, 'expected the bare execFileSync call — an argument vector, no shell (#B640)');
        });

        it('['+ name +'] the catch surfaces the child error instead of a bare mislabel', function() {
            assert.ok(blkFn().indexOf('could not be set: ') > -1, 'expected the real error appended to the message');
        });
    });

    it('the undefined `self.stask` log token is gone from live code file-wide', function() {
        // comment-stripped: the dead commented-out import blocks legitimately
        // keep the old token in `//` lines.
        assert.ok(stripComments(SRC).indexOf('self.stask') < 0, 'the warn prefix must use the real self.task');
    });

    // Mirrors the child-env composition line-for-line.
    function composeChildEnv(sweptEnv, nodeParams, home) {
        var currentEnv = Object.assign({}, sweptEnv);
        currentEnv['NODE_OPTIONS'] = nodeParams.join(' ');
        currentEnv['GINA_HOMEDIR'] = home;
        return currentEnv;
    }

    it('replica: a post-sweep env gains GINA_HOMEDIR and keeps the NODE_OPTIONS forward', function() {
        var swept = { PATH: '/usr/bin', HOME: '/home/someone' }; // no GINA_* — the sweep removed them
        var env = composeChildEnv(swept, ['--inspect=1234'], '/tmp/custom-home/.gina');
        assert.equal(env.GINA_HOMEDIR, '/tmp/custom-home/.gina');
        assert.equal(env.NODE_OPTIONS, '--inspect=1234');
        assert.equal(env.PATH, '/usr/bin');
        assert.ok(!('GINA_HOMEDIR' in swept), 'the source env object must not be mutated');
    });

    it('subtract: the pre-fix return dereference throws on the inherited-stdio null return', function() {
        // Old shape: console.log(execSync(cmd, {stdio:'inherit'}).toString().trim())
        // — execSync returns null when stdout is not piped, so a SUCCESSFUL child
        // still threw here and was misreported as "could not be set" + exit 1.
        function oldShape(execSyncReturn) {
            return execSyncReturn.toString().trim();
        }
        assert.throws(function() { oldShape(null); }, TypeError);
    });

    it('subtract: the fixed shape ignores the return and cannot throw on it', function() {
        function fixedShape(execSyncReturn) {
            // bare call — the return value is deliberately unread
            return true;
        }
        assert.equal(fixedShape(null), true);
    });

});


// ── 11 — home re-export at the remaining CLI child spawn sites ───────────────
//
// The CmdHelper auto-link execSyncs and the project:start/stop/restart bundle
// delegations spawn children with the post-sweep process.env — under a
// GINA_HOMEDIR override they resolved the DEFAULT home and silently created
// links / scaffold artifacts there (measured: link-node-modules "fixed" a
// manifest and linked node_modules under the wrong home, exit 0).

describe('11 - CmdHelper auto-link children receive the re-exported home', function() {

    var HELPER_PATH = path.join(FW, 'lib/cmd/helper.js');
    var HELPER_SRC = fs.readFileSync(HELPER_PATH, 'utf8');
    var blockIdx = HELPER_SRC.indexOf('// linking node-modules & gina');
    var endIdx = HELPER_SRC.indexOf('cmd.protocols.sort()', blockIdx);
    var BLOCK = (blockIdx > -1 && endIdx > blockIdx) ? HELPER_SRC.slice(blockIdx, endIdx) : '';

    it('the block composes the child env from process.env plus an explicit GINA_HOMEDIR', function() {
        assert.match(
            BLOCK,
            /var _linkEnv = Object\.assign\(\{\},\s*process\.env,\s*\{\s*GINA_HOMEDIR\s*:\s*GINA_HOMEDIR\s*\}\s*\)/,
            'expected the _linkEnv composition (the sweep strips GINA_* from process.env)'
        );
    });

    it('both auto-link execSyncs carry the composed env', function() {
        var count = (BLOCK.match(/\{ env: _linkEnv \}/g) || []).length;
        assert.equal(count, 2, 'expected both the link-node-modules and link children to receive _linkEnv');
    });

    it('the env is composed before the first child runs', function() {
        // comment-stripped: the historical `// was: err = execSync(...)` line
        // sits above the composition and would otherwise match first.
        var live = stripComments(BLOCK);
        var envIdx  = live.indexOf('var _linkEnv');
        var execIdx = live.indexOf('execSync(');
        assert.ok(envIdx > -1 && execIdx > envIdx);
    });

});

describe('11b - project start/stop/restart delegations receive the re-exported home', function() {

    ['start', 'stop', 'restart'].forEach(function(name) {
        var FILE_PATH = path.join(FW, 'lib/cmd/project/' + name + '.js');
        var FILE_SRC = fs.readFileSync(FILE_PATH, 'utf8');

        it('[' + name + '] the exec options carry maxBuffer plus the composed env', function() {
            assert.ok(
                FILE_SRC.indexOf('exec(_cmd, { maxBuffer: 1024 * 500, env: Object.assign({}, process.env, { GINA_HOMEDIR: GINA_HOMEDIR }) }') > -1,
                'expected the delegated bundle:' + name + ' child to receive the re-exported home'
            );
        });

        it('[' + name + '] the bare pre-fix options shape is gone', function() {
            assert.ok(
                stripComments(FILE_SRC).indexOf('exec(_cmd, { maxBuffer: 1024 * 500 },') < 0,
                'the env-less exec options must not come back (post-sweep inheritance loses the home)'
            );
        });
    });

    it('subtract: the pre-fix options object carries no home for the child', function() {
        var preFix = { maxBuffer: 1024 * 500 };
        assert.ok(!('env' in preFix), 'pre-fix shape: the child inherits the post-sweep env — no home override reaches it');
        var fixed = { maxBuffer: 1024 * 500, env: Object.assign({}, { PATH: '/usr/bin' }, { GINA_HOMEDIR: '/tmp/ovr/.gina' }) };
        assert.equal(fixed.env.GINA_HOMEDIR, '/tmp/ovr/.gina');
    });

});
