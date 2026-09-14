var Open;
/**
 * @module gina/lib/cmd/inspector/open
 *
 * Opens the dev-mode Inspector SPA in a chromeless browser window (app mode).
 *
 * Usage:
 *   gina inspector:open [<target>] [@<project>] [--browser=<name>] [--port=<port>] [--url=<url>]
 *
 * `<target>` accepts two shapes:
 *   - `<bundle>`     — a registered bundle name; resolved to `http://localhost:<port>`
 *   - `<url>`        — a full `http(s)://` URL; used as the target origin directly
 *                      (useful when bundles run on Docker or a remote env while the
 *                      Inspector SPA runs on the host).
 *
 * The command detects the default browser on macOS, Linux, and Windows.
 * When available, it launches in app mode (chromeless window — no address
 * bar, no tabs). Chromium-based browsers (Chrome, Edge, Brave, Vivaldi,
 * Opera) all support `--app=<url>`. Firefox and Safari fall back to a
 * normal browser window.
 *
 * `--browser=<name>` overrides the default browser. Accepted short names:
 *   chrome, chromium, edge, brave, vivaldi, opera, firefox, safari
 *
 * `--port=<port>` overrides the bundle port (skips project config lookup).
 *
 * `--url=<url>` overrides the Inspector base URL (standalone SPA). Takes
 * precedence over the bundle's `settings.inspector.url`. The final URL is
 * `<url>?target=<target-origin>`.
 *
 * When `--port` or a URL target is used, `@<project>` is optional.
 *
 * Inspector URL resolution order (#INS8):
 *   1. `--url=<url>`  — explicit override.
 *   2. Bundle `config/settings.json > inspector.url` — when a project and
 *      bundle are resolved (i.e. neither `--port` nor a URL target was used).
 *   3. Global `~/.gina/${shortVersion}/settings.json > inspector.url` — per-user
 *      default for the Inspector SPA origin.
 *   4. Embedded popup at `<target>/_gina/inspector/` — legacy fallback.
 *
 * @class Open
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */

var fs        = require('fs');
var child     = require('child_process');
var os        = require('os');
var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * Browser registry — short names mapped to per-platform details.
 * `appMode: true` means the browser supports `--app=<url>` for a chromeless window.
 *
 * @constant
 * @type {Object<string, {name: string, appMode: boolean, darwin: object, linux: object, win32: object}>}
 */
var BROWSERS = {
    chrome: {
        name      : 'Google Chrome'
      , appMode   : true
      , darwin    : { app: 'Google Chrome' }
      , linux     : { bins: ['google-chrome-stable', 'google-chrome', 'chrome'] }
      , win32     : { bins: ['chrome'], paths: [
            '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe'
          , '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe'
          , '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe'
        ]}
    }
  , chromium: {
        name      : 'Chromium'
      , appMode   : true
      , darwin    : { app: 'Chromium' }
      , linux     : { bins: ['chromium-browser', 'chromium'] }
      , win32     : { bins: ['chromium'], paths: [] }
    }
  , edge: {
        name      : 'Microsoft Edge'
      , appMode   : true
      , darwin    : { app: 'Microsoft Edge' }
      , linux     : { bins: ['microsoft-edge-stable', 'microsoft-edge'] }
      , win32     : { bins: ['msedge'], paths: [
            '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe'
          , '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'
        ]}
    }
  , brave: {
        name      : 'Brave'
      , appMode   : true
      , darwin    : { app: 'Brave Browser' }
      , linux     : { bins: ['brave-browser-stable', 'brave-browser'] }
      , win32     : { bins: ['brave'], paths: [
            '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
          , '%LocalAppData%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        ]}
    }
  , vivaldi: {
        name      : 'Vivaldi'
      , appMode   : true
      , darwin    : { app: 'Vivaldi' }
      , linux     : { bins: ['vivaldi-stable', 'vivaldi'] }
      , win32     : { bins: ['vivaldi'], paths: [
            '%LocalAppData%\\Vivaldi\\Application\\vivaldi.exe'
        ]}
    }
  , opera: {
        name      : 'Opera'
      , appMode   : true
      , darwin    : { app: 'Opera' }
      , linux     : { bins: ['opera'] }
      , win32     : { bins: ['opera'], paths: [
            '%LocalAppData%\\Programs\\Opera\\launcher.exe'
        ]}
    }
  , firefox: {
        name      : 'Firefox'
      , appMode   : false
      , darwin    : { app: 'Firefox' }
      , linux     : { bins: ['firefox'] }
      , win32     : { bins: ['firefox'], paths: [
            '%ProgramFiles%\\Mozilla Firefox\\firefox.exe'
        ]}
    }
  , safari: {
        name      : 'Safari'
      , appMode   : false
      , darwin    : { app: 'Safari' }
      , linux     : null
      , win32     : null
    }
};

/**
 * macOS bundle IDs → short name mapping for default browser detection.
 * @constant
 * @type {Object<string, string>}
 */
var BUNDLE_ID_MAP = {
    'com.google.chrome'            : 'chrome'
  , 'org.chromium.chromium'        : 'chromium'
  , 'com.microsoft.edgemac'        : 'edge'
  , 'com.brave.browser'            : 'brave'
  , 'com.vivaldi.vivaldi'          : 'vivaldi'
  , 'com.operasoftware.opera'      : 'opera'
  , 'org.mozilla.firefox'          : 'firefox'
  , 'com.apple.safari'             : 'safari'
};

/**
 * Linux .desktop file prefixes → short name mapping.
 * @constant
 * @type {Object<string, string>}
 */
var DESKTOP_MAP = {
    'google-chrome'     : 'chrome'
  , 'chromium'          : 'chromium'
  , 'microsoft-edge'    : 'edge'
  , 'brave-browser'     : 'brave'
  , 'vivaldi'           : 'vivaldi'
  , 'opera'             : 'opera'
  , 'firefox'           : 'firefox'
};

/**
 * Windows ProgId prefixes → short name mapping.
 * @constant
 * @type {Object<string, string>}
 */
var PROGID_MAP = {
    'ChromeHTML'     : 'chrome'
  , 'ChromiumHTM'    : 'chromium'
  , 'MSEdgeHTM'      : 'edge'
  , 'BraveHTML'      : 'brave'
  , 'VivaldiHTM'     : 'vivaldi'
  , 'OperaStable'    : 'opera'
  , 'FirefoxURL'     : 'firefox'
};


/**
 * Detect the default browser on macOS by reading Launch Services plist.
 * Falls back to `'safari'` (the OS default).
 *
 * @inner
 * @returns {string} Browser short name
 */
function detectDarwin() {
    try {
        var plistPath = process.env.HOME
            + '/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';

        if (!fs.existsSync(plistPath)) return 'safari';

        var raw = child.execSync(
            'plutil -convert json -o - "' + plistPath + '"'
          , { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        var plist    = JSON.parse(raw);
        var handlers = plist.LSHandlers || [];
        for (var i = 0; i < handlers.length; i++) {
            var h = handlers[i];
            if (h.LSHandlerURLScheme === 'https' && h.LSHandlerRoleAll) {
                var bid = h.LSHandlerRoleAll.toLowerCase();
                for (var key in BUNDLE_ID_MAP) {
                    if (bid === key) return BUNDLE_ID_MAP[key];
                }
            }
        }
    } catch (e) { /* plist unreadable — fall through */ }
    return 'safari';
}

/**
 * Detect the default browser on Linux via `xdg-settings`.
 * Falls back to `'firefox'`.
 *
 * @inner
 * @returns {string} Browser short name
 */
function detectLinux() {
    try {
        var desktop = child.execSync(
            'xdg-settings get default-web-browser 2>/dev/null'
          , { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim().toLowerCase();
        for (var prefix in DESKTOP_MAP) {
            if (desktop.indexOf(prefix) !== -1) return DESKTOP_MAP[prefix];
        }
    } catch (e) { /* xdg not available */ }
    return 'firefox';
}

/**
 * Detect the default browser on Windows via registry query.
 * Falls back to `'edge'` (the OS default).
 *
 * @inner
 * @returns {string} Browser short name
 */
function detectWindows() {
    try {
        var raw = child.execSync(
            'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId 2>nul'
          , { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        var match = raw.match(/ProgId\s+REG_SZ\s+(\S+)/);
        if (match) {
            var progId = match[1];
            for (var prefix in PROGID_MAP) {
                if (progId.indexOf(prefix) !== -1) return PROGID_MAP[prefix];
            }
        }
    } catch (e) { /* registry unreadable */ }
    return 'edge';
}

/**
 * Detect the default browser for the current platform.
 *
 * @inner
 * @returns {string} Browser short name
 */
function detectDefaultBrowser() {
    var platform = os.platform();
    if (platform === 'darwin') return detectDarwin();
    if (platform === 'linux')  return detectLinux();
    if (platform === 'win32')  return detectWindows();
    return 'chrome';
}

/**
 * Check whether a binary is available on the system PATH (Linux/Windows).
 *
 * @inner
 * @param {string} bin - Binary name to look up
 * @returns {boolean}
 */
function hasBin(bin) {
    try {
        var cmd = (os.platform() === 'win32')
            ? 'where ' + bin + ' 2>nul'
            : 'which ' + bin + ' 2>/dev/null';
        child.execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
    } catch (e) { return false; }
}

/**
 * Resolve the executable path for a browser on Windows.
 * Tries the `paths` list (with env var expansion) before falling back to
 * `where` lookup on the short binary name.
 *
 * @inner
 * @param {object} winDef - The `win32` entry from the BROWSERS registry
 * @returns {string|null} Resolved path or null
 */
function resolveWindowsPath(winDef) {
    if (!winDef) return null;
    var paths = winDef.paths || [];
    for (var i = 0; i < paths.length; i++) {
        try {
            var expanded = child.execSync(
                'echo ' + paths[i]
              , { encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            if (fs.existsSync(expanded)) return expanded;
        } catch (e) { /* skip */ }
    }
    var bins = winDef.bins || [];
    for (var b = 0; b < bins.length; b++) {
        if (hasBin(bins[b])) return bins[b];
    }
    return null;
}

/**
 * Build the shell command to open a URL in a specific browser.
 *
 * @inner
 * @param {string} shortName - Browser short name from BROWSERS
 * @param {string} url - The URL to open
 * @returns {{ cmd: string, appMode: boolean }|null}
 */
function buildLaunchCmd(shortName, url) {
    var browser  = BROWSERS[shortName];
    if (!browser) return null;

    var platform = os.platform();
    var platDef  = browser[platform];
    if (!platDef) return null;

    var appFlag  = browser.appMode ? ('--app=' + url) : '';

    if (platform === 'darwin') {
        if (browser.appMode) {
            // Chromium-based: call the binary directly so --app= works even
            // when the browser is already running. `open --args` is unreliable
            // in that case — macOS sends the URL to the existing instance as a
            // regular navigation, ignoring --app=.
            var binPath = '/Applications/' + platDef.app + '.app/Contents/MacOS/' + platDef.app;
            if (!fs.existsSync(binPath)) return null;
            return {
                cmd     : '"' + binPath + '" --app="' + url + '"'
              , appMode : true
            };
        }
        // Non-app-mode browsers (Firefox, Safari): use `open -a`
        return {
            cmd     : 'open -a "' + platDef.app + '" "' + url + '"'
          , appMode : false
        };
    }

    if (platform === 'linux') {
        var bins = platDef.bins || [];
        var bin  = null;
        for (var i = 0; i < bins.length; i++) {
            if (hasBin(bins[i])) { bin = bins[i]; break; }
        }
        if (!bin) return null;
        var linuxArgs = browser.appMode
            ? bin + ' --app="' + url + '"'
            : bin + ' "' + url + '"';
        return { cmd: linuxArgs, appMode: browser.appMode };
    }

    if (platform === 'win32') {
        var winBin = resolveWindowsPath(platDef);
        if (!winBin) return null;
        var quoted = (winBin.indexOf(' ') !== -1) ? '"' + winBin + '"' : winBin;
        var winArgs = browser.appMode
            ? 'start "" ' + quoted + ' --app="' + url + '"'
            : 'start "" ' + quoted + ' "' + url + '"';
        return { cmd: winArgs, appMode: browser.appMode };
    }

    return null;
}


/**
 * Reads `inspector.url` from `~/.gina/${shortVersion}/settings.json`
 * using the `GINA_HOMEDIR` and `GINA_SHORT_VERSION` env vars set by `bin/cli`.
 *
 * @inner
 * @returns {string|null} Configured URL or null
 */
function readGlobalInspectorUrl() {
    try {
        var home         = getEnvVar('GINA_HOMEDIR');
        var shortVersion = getEnvVar('GINA_SHORT_VERSION');
        if (!home || !shortVersion) return null;
        var globalPath = _(home + '/' + shortVersion + '/settings.json', true);
        if (!fs.existsSync(globalPath)) return null;
        var globalSettings = requireJSON(globalPath);
        if (globalSettings && globalSettings.inspector && globalSettings.inspector.url) {
            return globalSettings.inspector.url;
        }
    } catch (e) { /* unreadable or malformed — fall through */ }
    return null;
}

/**
 * Resolves the Inspector base URL for launch (#INS8).
 *
 * Resolution order:
 *   1. `urlOverride` — the `--url=<url>` CLI flag.
 *   2. The bundle's `config/settings.json > inspector.url`, when a project
 *      and bundle context exist (i.e. neither `--port` nor a URL target was
 *      used alone).
 *   3. Global `~/.gina/${shortVersion}/settings.json > inspector.url` — per-user
 *      default, useful when the Inspector SPA runs on the host and bundles run
 *      on Docker or remote envs.
 *   4. `null` — caller should fall back to the embedded
 *      `<target>/_gina/inspector/` path.
 *
 * The returned base is the raw URL; trailing-slash normalisation happens
 * in `buildInspectorUrl()`.
 *
 * @inner
 * @param {object} self - CmdHelper-populated handler state
 * @param {string|null} bundleName - Bundle name from argv, or null
 * @param {string|null} urlOverride - Value of `--url=`, or null
 * @param {number|null} portOverride - Value of `--port=`, or null
 * @param {string|null} targetOverride - Positional URL target, or null
 * @returns {string|null} Base URL, or null for the embedded fallback
 */
function resolveInspectorBase(self, bundleName, urlOverride, portOverride, targetOverride) {
    if (urlOverride) return urlOverride;

    // Bundle-level settings only when we actually have a bundle context —
    // skipped for `--port` alone and for positional URL target mode.
    if (!portOverride && !targetOverride
        && bundleName && self.projectName
        && self.projects && self.projects[self.projectName]
        && self.projects[self.projectName].path
        && self.projectData && self.projectData.bundles
        && self.projectData.bundles[bundleName]) {

        var bundleSrc = self.projectData.bundles[bundleName].src;
        if (bundleSrc) {
            var settingsPath = _(
                self.projects[self.projectName].path + '/' + bundleSrc + '/config/settings.json'
              , true
            );
            if (fs.existsSync(settingsPath)) {
                try {
                    // requireJSON tolerates `//` and `/* */` comments that settings.json
                    // files routinely include.
                    var settings = requireJSON(settingsPath);
                    if (settings && settings.inspector && settings.inspector.url) {
                        return settings.inspector.url;
                    }
                } catch (e) { /* parse error — fall through */ }
            }
        }
    }

    // Global per-user fallback (covers URL mode, --port mode, and bundle mode
    // when no bundle-level override is set).
    var globalUrl = readGlobalInspectorUrl();
    if (globalUrl) return globalUrl;

    return null;
}

/**
 * Builds the final Inspector launch URL.
 *
 * When `inspectorBase` is set, returns `<base>/?target=<encoded-target>`
 * (trailing slashes on the base are stripped, then exactly one is appended,
 * matching the statusbar normalisation).
 *
 * When `inspectorBase` is null, returns the embedded popup URL
 * `<target>/_gina/inspector/?target=<encoded-target>`.
 *
 * @inner
 * @param {string|null} inspectorBase - Resolved base URL, or null = embedded
 * @param {string} target - Target bundle origin (e.g. "http://localhost:3100")
 * @returns {string}
 */
function buildInspectorUrl(inspectorBase, target) {
    if (inspectorBase) {
        var base = inspectorBase.replace(/\/+$/, '') + '/';
        return base + '?target=' + encodeURIComponent(target);
    }
    return target + '/_gina/inspector/?target=' + encodeURIComponent(target);
}


function Open(opt, cmd) {
    var self = {};

    /**
     * Parse argv, validate project/bundle, resolve port, and launch browser.
     *
     * @inner
     * @private
     */
    var init = function () {

        // import CMD helpers — provides isCmdConfigured(), isDefined(), etc.
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        var browserOverride = null;
        var portOverride    = null;
        var urlOverride     = null;   // #INS8 — explicit Inspector base URL
        var targetOverride  = null;   // positional URL — arbitrary target origin
        var bundleName      = null;
        var i;

        for (i = 3; i < process.argv.length; i++) {
            var arg = process.argv[i];
            if (/^--browser=/.test(arg)) {
                browserOverride = arg.split('=')[1].toLowerCase();
            } else if (/^--port=/.test(arg)) {
                portOverride = parseInt(arg.split('=')[1], 10);
            } else if (/^--url=/.test(arg)) {
                // Take everything after the first `=` so URLs with `?a=b` survive.
                urlOverride = arg.replace(/^--url=/, '');
            } else if (/^https?:\/\//i.test(arg)) {
                // Positional URL → target origin for cross-origin inspection
                // (Inspector on host, bundles on Docker, remote envs, …).
                // Strip trailing slashes so the SPA can append `/_gina/...` cleanly.
                targetOverride = arg.replace(/\/+$/, '');
            } else if (!/^--/.test(arg) && !/^@/.test(arg)) {
                bundleName = arg;
            }
        }

        // When --port or a URL target is given, skip project/bundle validation entirely
        if (!portOverride && !targetOverride) {
            // check CMD configuration (project existence, etc.)
            if ( !isCmdConfigured() ) return false;

            // validate the bundle if one was specified
            if (bundleName && !isDefined('bundle', bundleName)) {
                console.error(
                    'Bundle [ ' + bundleName + ' ] is not registered inside `@'
                    + self.projectName + '`.\n'
                    + 'Did you run `gina bundle:add ' + bundleName
                    + ' @' + self.projectName + '` first?'
                );
                process.exit(1);
                return;
            }
        }

        // Resolve the target port from ports.reverse.json (skipped in URL mode)
        var port = portOverride || null;
        if (!portOverride && !targetOverride && bundleName) {
            try {
                var key          = bundleName + '@' + self.projectName;
                var portsReverse = self.portsReverseData || {};
                var bundlePorts  = portsReverse[key];
                if (bundlePorts) {
                    // Use dev env by default, fall back to the first available env
                    var env      = bundlePorts['dev'] ? 'dev' : Object.keys(bundlePorts)[0];
                    var envPorts = bundlePorts[env];
                    // Prefer http/1.1 http port
                    if (envPorts['http/1.1'] && envPorts['http/1.1']['http']) {
                        port = envPorts['http/1.1']['http'];
                    } else if (envPorts['http/1.1'] && envPorts['http/1.1']['https']) {
                        port = envPorts['http/1.1']['https'];
                    }
                }
            } catch (e) { /* use fallback */ }
        }
        if (!port && !targetOverride) {
            port = 3100;
        }

        var target        = targetOverride || ('http://localhost:' + port);
        // #INS8 — dual-mode resolution: --url > bundle settings > global settings > embedded.
        var inspectorBase = resolveInspectorBase(self, bundleName, urlOverride, portOverride, targetOverride);
        var url           = buildInspectorUrl(inspectorBase, target);

        // Resolve browser
        var shortName = browserOverride || detectDefaultBrowser();
        if (!BROWSERS[shortName]) {
            console.error(
                'Unknown browser "' + shortName + '". '
                + 'Available: ' + Object.keys(BROWSERS).join(', ')
            );
            process.exit(1);
            return;
        }

        // If the resolved browser doesn't support app mode and the user
        // didn't explicitly pick it, try to find an installed Chromium
        // browser that does.
        if (!browserOverride && !BROWSERS[shortName].appMode) {
            var appModeBrowsers = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'opera'];
            for (var a = 0; a < appModeBrowsers.length; a++) {
                var candidate = buildLaunchCmd(appModeBrowsers[a], url);
                if (candidate) {
                    shortName = appModeBrowsers[a];
                    break;
                }
            }
        }

        var launch = buildLaunchCmd(shortName, url);
        if (!launch) {
            // No app-mode browser found — fall back to system default
            console.warn(
                'No app-mode browser found. '
                + 'Opening in system default browser.'
            );
            var fallbackCmd = (os.platform() === 'win32')
                ? 'start "" "' + url + '"'
                : (os.platform() === 'darwin')
                    ? 'open "' + url + '"'
                    : 'xdg-open "' + url + '"';
            child.exec(fallbackCmd);
            process.exit(0);
            return;
        }

        var modeLabel = launch.appMode ? 'app mode' : 'normal window';
        console.log(
            'Opening Inspector in ' + BROWSERS[shortName].name
            + ' (' + modeLabel + ')'
        );
        console.log(url);

        child.exec(launch.cmd, function (err) {
            if (err) {
                console.warn('Browser launch failed, trying system default.');
                var fallback = (os.platform() === 'win32')
                    ? 'start "" "' + url + '"'
                    : (os.platform() === 'darwin')
                        ? 'open "' + url + '"'
                        : 'xdg-open "' + url + '"';
                child.exec(fallback);
            }
            process.exit(0);
        });
    };

    init();
}

module.exports = Open;
