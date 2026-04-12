var Open;
/**
 * @module gina/lib/cmd/inspector/open
 *
 * Opens the dev-mode Inspector SPA in a chromeless browser window (app mode).
 *
 * Usage:
 *   gina inspector:open [<bundle>] [@<project>] [--browser=<name>] [--port=<port>]
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
 * When `--port` is used, `@<project>` is optional.
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
        var bundleName      = null;
        var i;

        for (i = 3; i < process.argv.length; i++) {
            var arg = process.argv[i];
            if (/^--browser=/.test(arg)) {
                browserOverride = arg.split('=')[1].toLowerCase();
            } else if (/^--port=/.test(arg)) {
                portOverride = parseInt(arg.split('=')[1], 10);
            } else if (!/^--/.test(arg) && !/^@/.test(arg)) {
                bundleName = arg;
            }
        }

        // When --port is given, skip project/bundle validation entirely
        if (!portOverride) {
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

        // Resolve the target port from ports.reverse.json
        var port = portOverride || null;
        if (!portOverride && bundleName) {
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
        if (!port) {
            port = 3100;
        }

        var target = 'http://localhost:' + port;
        var url    = target + '/_gina/inspector/?target=' + encodeURIComponent(target);

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
