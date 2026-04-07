var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.js');


// 01 — strParts path building (Array.push + join replaces str += key + '.' in setOptions loop)
describe('01 - setOptions routing param: strParts path building (Array.push + join)', function() {

    it('push key onto [page] yields page.key via join', function() {
        var strParts = ['page'];
        strParts.push('title');
        assert.equal(strParts.join('.'), 'page.title');
    });

    it(':value branch — strParts = [page, view, params, key] yields page.view.params.key', function() {
        var key = 'id';
        var strParts = ['page', 'view', 'params', key];
        assert.equal(strParts.join('.'), 'page.view.params.id');
    });

    it('file/title branch — strParts = [page, view, key] yields page.view.key', function() {
        var key = 'title';
        var strParts = ['page', 'view', key];
        assert.equal(strParts.join('.'), 'page.view.title');
    });

    it('reset to [page] yields page and length 1', function() {
        var strParts = ['page', 'title'];
        strParts = ['page'];
        assert.equal(strParts.join('.'), 'page');
        assert.equal(strParts.length, 1);
    });

    it('multiple outer iterations accumulate when inner branch does not reset', function() {
        // mirrors original str += behaviour: str starts 'page.', += 'key1.' → 'page.key1.'
        // then without reset: += 'key2.' → 'page.key1.key2.'
        var strParts = ['page'];
        strParts.push('key1');
        assert.equal(strParts.join('.'), 'page.key1');
        strParts.push('key2');
        assert.equal(strParts.join('.'), 'page.key1.key2');
    });

    it('join result matches str.substring(0, str.length-1) equivalence', function() {
        // original: str = 'page.' + key + '.' → str.substring(0, str.length-1) = 'page.' + key
        var key = 'file';
        var str = 'page.' + key + '.';
        var strParts = ['page', key];
        assert.equal(strParts.join('.'), str.substring(0, str.length - 1));
    });

});


// 02 — valueParts accumulation (Array.push + join replaces value += obj[prop] in inner loop)
describe('02 - setOptions routing param: valueParts accumulation (Array.push + join)', function() {

    it('single push joins to itself', function() {
        var valueParts = [];
        valueParts.push('hello');
        assert.equal(valueParts.join(''), 'hello');
    });

    it('multiple pushes join without separator', function() {
        var valueParts = [];
        valueParts.push('hello');
        valueParts.push(' world');
        assert.equal(valueParts.join(''), 'hello world');
    });

    it('empty parts join to empty string', function() {
        var valueParts = [];
        assert.equal(valueParts.join(''), '');
    });

    it('join result matches sequential += for same inputs', function() {
        var value = '';
        value += 'foo';
        value += 'bar';
        var valueParts = [];
        valueParts.push('foo');
        valueParts.push('bar');
        assert.equal(valueParts.join(''), value);
    });

});


// 03 — source structure: string += replaced with Array.push/join in setOptions (#P26)
describe('03 - source structure: string += replaced with Array.push/join in setOptions (#P26)', function() {

    it('strParts.push(key) is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('strParts.push(key)') > -1,
            'expected `strParts.push(key)` — #P26 not applied'
        );
    });

    it('valueParts.push(obj[prop]) is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('valueParts.push(obj[prop])') > -1,
            'expected `valueParts.push(obj[prop])` — #P26 not applied'
        );
    });

    it("strParts.join('.') is present in source", function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("strParts.join('.')") > -1,
            "expected `strParts.join('.')` — #P26 not applied"
        );
    });

    it("valueParts.join('') is present in source", function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("valueParts.join('')") > -1,
            "expected `valueParts.join('')` — #P26 not applied"
        );
    });

    it('str += key pattern is gone from setOptions loop (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/str\s*\+=\s*key/.test(stripped),
            'old `str += key` still present outside comments — #P26 not applied'
        );
    });

    it('value += obj[prop] pattern is gone from setOptions loop (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/value\s*\+=\s*obj\[/.test(stripped),
            'old `value += obj[` still present outside comments — #P26 not applied'
        );
    });

    it('source contains #P26 replaced comment', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('#P26') > -1,
            'expected #P26 marker — comment convention not applied'
        );
    });

});


// 04 — source structure: setEarlyHints (#EH1)
describe('04 - source structure: setEarlyHints (#EH1)', function() {

    it('setEarlyHints is defined in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('this.setEarlyHints = function(') > -1,
            'expected `this.setEarlyHints = function(` — #EH1 not applied'
        );
    });

    it('source contains #EH1 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#EH1') > -1, 'expected #EH1 marker in source');
    });

    it('HTTP/2 path uses stream.additionalHeaders with :status 103', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("':status': 103") > -1,
            "expected `':status': 103` — HTTP/2 early-hints header missing"
        );
        assert.ok(
            src.indexOf('additionalHeaders') > -1,
            'expected `additionalHeaders` call for HTTP/2 early hints'
        );
    });

    it('HTTP/1.1 path uses writeEarlyHints', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('writeEarlyHints') > -1,
            'expected `writeEarlyHints` — HTTP/1.1 early-hints path missing'
        );
    });

    it('implementation is guarded by headersSent check', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        // find setEarlyHints block
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('headersSent') > -1,
            'expected headersSent guard inside setEarlyHints'
        );
    });

    it('implementation wraps in try/catch so errors are swallowed', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('try {') > -1, 'expected try/catch in setEarlyHints');
        assert.ok(block.indexOf('catch') > -1,  'expected catch in setEarlyHints');
    });

    it('implementation returns self for chaining', function() {
        var src   = fs.readFileSync(SOURCE, 'utf8');
        var start = src.indexOf('this.setEarlyHints = function(');
        var end   = src.indexOf('\n    };', start) + 7;
        var block = src.slice(start, end);
        assert.ok(block.indexOf('return self') > -1, 'expected `return self` for chaining');
    });

    it('render() auto-sends 103 from h2Links before delegating to render-swig', function() {
        var src         = fs.readFileSync(SOURCE, 'utf8');
        var renderStart = src.indexOf('this.render = function (userData');
        var renderEnd   = src.indexOf('\n    }', renderStart) + 6; // closing brace of render
        var block       = src.slice(renderStart, renderEnd);
        assert.ok(
            block.indexOf('_h2Links') > -1,
            'expected h2Links auto-hint block inside render()'
        );
        assert.ok(
            block.indexOf('setEarlyHints(_hints)') > -1,
            'expected self.setEarlyHints(_hints) call inside render()'
        );
    });

    it('render() auto-hint trims trailing comma from h2Links', function() {
        var src         = fs.readFileSync(SOURCE, 'utf8');
        var renderStart = src.indexOf('this.render = function (userData');
        var renderEnd   = src.indexOf('\n    }', renderStart) + 6;
        var block       = src.slice(renderStart, renderEnd);
        assert.ok(
            block.indexOf('.slice(0, -1)') > -1,
            'expected trailing comma trim (.slice(0, -1)) in render() auto-hint'
        );
    });

});


// 05 — setEarlyHints: pure logic
describe('05 - setEarlyHints: pure logic', function() {

    // Minimal replica of the setEarlyHints body for isolated testing
    function makeEarlyHintsEnv(opts) {
        opts = opts || {};
        var calls = { additionalHeaders: [], writeEarlyHints: [] };

        var stream = opts.streamHeadersSent
            ? { headersSent: true }
            : (opts.noStream ? null : {
                headersSent: false,
                additionalHeaders: function(h) { calls.additionalHeaders.push(h); }
            });

        var res = {
            stream: stream || undefined,
            headersSent: opts.resHeadersSent || false,
            writeEarlyHints: opts.noWriteEarlyHints ? undefined : function(h) { calls.writeEarlyHints.push(h); }
        };

        var self = {};

        function headersSent(_res) {
            _res = _res || res;
            if (typeof _res.stream !== 'undefined' && _res.stream && _res.stream.headersSent === true) return true;
            if (typeof _res.headersSent !== 'undefined') return _res.headersSent;
            return false;
        }

        function setEarlyHints(links) {
            if (!links) return self;
            var _link;
            if (Array.isArray(links)) { _link = links.filter(Boolean).join(', '); }
            else { _link = String(links).trim(); }
            if (!_link) return self;
            if (headersSent(res)) return self;
            try {
                if (res.stream && !res.stream.headersSent) {
                    res.stream.additionalHeaders({ ':status': 103, 'link': _link });
                } else if (typeof res.writeEarlyHints === 'function') {
                    res.writeEarlyHints({ 'link': _link });
                }
            } catch(e) {}
            return self;
        }

        return { calls: calls, res: res, self: self, setEarlyHints: setEarlyHints };
    }

    it('HTTP/2: calls stream.additionalHeaders with :status 103 and link', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.additionalHeaders.length, 1);
        assert.equal(env.calls.additionalHeaders[0][':status'], 103);
        assert.equal(env.calls.additionalHeaders[0]['link'], '</app.css>; rel=preload; as=style');
    });

    it('HTTP/2: does not call writeEarlyHints when stream is present', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('HTTP/1.1: calls writeEarlyHints when no stream', function() {
        var env = makeEarlyHintsEnv({ noStream: true });
        env.setEarlyHints('</app.css>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 1);
        assert.equal(env.calls.writeEarlyHints[0]['link'], '</app.css>; rel=preload; as=style');
    });

    it('HTTP/1.1: no-ops silently when writeEarlyHints is not a function', function() {
        var env = makeEarlyHintsEnv({ noStream: true, noWriteEarlyHints: true });
        assert.doesNotThrow(function() {
            env.setEarlyHints('</app.css>; rel=preload; as=style');
        });
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('array of links is joined with ", "', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints(['</app.css>; rel=preload; as=style', '</app.js>; rel=preload; as=script']);
        assert.equal(
            env.calls.additionalHeaders[0]['link'],
            '</app.css>; rel=preload; as=style, </app.js>; rel=preload; as=script'
        );
    });

    it('null input: no-ops and returns self', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints(null);
        assert.strictEqual(result, env.self);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('undefined input: no-ops and returns self', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints(undefined);
        assert.strictEqual(result, env.self);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('empty string: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints('');
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('empty array: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints([]);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('array with only falsy entries: no-ops', function() {
        var env = makeEarlyHintsEnv();
        env.setEarlyHints([null, '', undefined]);
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('returns self for optional chaining', function() {
        var env = makeEarlyHintsEnv();
        var result = env.setEarlyHints('</x>; rel=preload; as=style');
        assert.strictEqual(result, env.self);
    });

    it('no-ops when HTTP/2 stream.headersSent is true', function() {
        var env = makeEarlyHintsEnv({ streamHeadersSent: true });
        env.setEarlyHints('</x>; rel=preload; as=style');
        assert.equal(env.calls.additionalHeaders.length, 0);
    });

    it('no-ops when HTTP/1.1 res.headersSent is true', function() {
        var env = makeEarlyHintsEnv({ noStream: true, resHeadersSent: true });
        env.setEarlyHints('</x>; rel=preload; as=style');
        assert.equal(env.calls.writeEarlyHints.length, 0);
    });

    it('swallows errors thrown by additionalHeaders (best-effort)', function() {
        var env = makeEarlyHintsEnv();
        env.res.stream.additionalHeaders = function() { throw new Error('stream closed'); };
        assert.doesNotThrow(function() {
            env.setEarlyHints('</x>; rel=preload; as=style');
        });
    });

    it('swallows errors thrown by writeEarlyHints (best-effort)', function() {
        var env = makeEarlyHintsEnv({ noStream: true });
        env.res.writeEarlyHints = function() { throw new Error('socket error'); };
        assert.doesNotThrow(function() {
            env.setEarlyHints('</x>; rel=preload; as=style');
        });
    });

});


// 06 — render() auto-hint from h2Links
describe('06 - render() auto-hint from h2Links (#EH1)', function() {

    // Minimal replica of the render() auto-hint block for isolated testing
    function simulateRenderAutoHint(h2Links, hintsSent) {
        var sent = [];

        function setEarlyHints(hints) { sent.push(hints); return {}; }
        function headersSent() { return false; }

        // replica of the auto-hint block
        var _h2Links = h2Links;
        if (_h2Links) {
            var _hints = /,$/.test(_h2Links) ? _h2Links.slice(0, -1) : _h2Links;
            if (_hints) setEarlyHints(_hints);
        }

        return sent;
    }

    it('sends 103 with h2Links when populated', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload,</js/app.js>; as=script; rel=preload,');
        assert.equal(sent.length, 1);
    });

    it('trims trailing comma from h2Links before sending', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload,');
        assert.equal(sent[0], '</css/app.css>; as=style; rel=preload');
    });

    it('passes through value without trailing comma unchanged', function() {
        var sent = simulateRenderAutoHint('</css/app.css>; as=style; rel=preload');
        assert.equal(sent[0], '</css/app.css>; as=style; rel=preload');
    });

    it('multiple links are passed through as a single string', function() {
        var sent = simulateRenderAutoHint('</a.css>; as=style; rel=preload,</b.js>; as=script; rel=preload,');
        assert.equal(sent[0], '</a.css>; as=style; rel=preload,</b.js>; as=script; rel=preload');
    });

    it('no-ops when h2Links is empty string', function() {
        var sent = simulateRenderAutoHint('');
        assert.equal(sent.length, 0);
    });

    it('no-ops when h2Links is null', function() {
        var sent = simulateRenderAutoHint(null);
        assert.equal(sent.length, 0);
    });

    it('no-ops when h2Links is undefined', function() {
        var sent = simulateRenderAutoHint(undefined);
        assert.equal(sent.length, 0);
    });

    it('trailing-comma-only string results in empty hint — no send', function() {
        // edge case: h2Links was set to just ',' (degenerate case)
        var sent = simulateRenderAutoHint(',');
        // after slice(0, -1) → '' → falsy → no send
        assert.equal(sent.length, 0);
    });

});


// ─── 07 — throwError: explicit 3-digit status code is preserved ───────────────

describe('07 - throwError: explicit 3-digit HTTP status code is preserved', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('source contains the /^\\d{3}$/ guard that preserves an explicit code', function() {
        // The fix: /^\d{3}$/.test(String(code)) before falling back to res.status || 500
        assert.ok(/\\d\{3\}/.test(src) && /String\(code\)/.test(src),
            'throwError must test String(code) against /^\\d{3}$/ before falling back to res.status');
    });

    it('a 3-digit number string passes the guard', function() {
        assert.ok(/^\d{3}$/.test(String(404)));
        assert.ok(/^\d{3}$/.test(String(400)));
        assert.ok(/^\d{3}$/.test(String(500)));
        assert.ok(/^\d{3}$/.test(String(201)));
    });

    it('non-numeric or short code does NOT pass the guard (falls back)', function() {
        assert.ok(!/^\d{3}$/.test(String(undefined)));
        assert.ok(!/^\d{3}$/.test(String(null)));
        assert.ok(!/^\d{3}$/.test(String('foo')));
        assert.ok(!/^\d{3}$/.test(String(50)));   // 2-digit
        assert.ok(!/^\d{3}$/.test(String(5000)));  // 4-digit
    });

    it('inline replica: throwError(res, 404, msg) preserves 404', function() {
        // Inline replica of the fixed code branch
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 200 };
        assert.equal(resolveCode(fakeRes, 404), 404, 'explicit 404 must not be overridden by res.status');
    });

    it('inline replica: throwError(res, undefined, msg) falls back to res.status', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 422 };
        assert.equal(resolveCode(fakeRes, undefined), 422, 'missing code falls back to res.status');
    });

    it('inline replica: throwError(res, undefined, msg) falls back to 500 when res.status absent', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        assert.equal(resolveCode({}, undefined), 500, 'missing code and missing res.status must default to 500');
    });

    it('inline replica: throwError(res, 400, msg) preserves 400', function() {
        function resolveCode(res, code) {
            return (/^\d{3}$/.test(String(code))) ? code
                 : (res && typeof(res.status) != 'undefined') ? res.status
                 : 500;
        }
        var fakeRes = { status: 500 };
        assert.equal(resolveCode(fakeRes, 400), 400, 'explicit 400 must not be overridden by res.status=500');
    });
});


// ─── 08 — getConfig: proxy hostname override guard ───────────────────────────

describe('08 - getConfig: proxy hostname override guard', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure ─────────────────────────────────────────────────

    it('source contains the PROXY_HOSTNAME undefined guard in getConfig', function() {
        // The fix: typeof(process.gina.PROXY_HOSTNAME) != 'undefined' prevents
        // overwriting a valid hostname with undefined when proxy detection is
        // a false positive (browser Origin header triggers isProxyHost = true
        // but no PROXY_HOSTNAME was ever set).
        var start = src.indexOf('this.getConfig = function(name)');
        assert.ok(start > -1, 'getConfig definition not found in source');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("typeof(process.gina.PROXY_HOSTNAME) != 'undefined'") > -1,
            'expected PROXY_HOSTNAME undefined guard inside getConfig'
        );
    });

    it('source contains the isProxyHost context check in getConfig', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("getContext('isProxyHost')") > -1,
            "expected getContext('isProxyHost') inside getConfig"
        );
    });

    it('source contains the tmp.hostname existence check in getConfig', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf("typeof(tmp.hostname) != 'undefined'") > -1,
            'expected tmp.hostname existence guard inside getConfig'
        );
    });

    it('proxy override assigns both hostname and host', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('tmp.hostname') > -1 && block.indexOf('tmp.host') > -1,
            'expected both tmp.hostname and tmp.host assignments inside getConfig'
        );
        assert.ok(
            block.indexOf('process.gina.PROXY_HOSTNAME') > -1
            && block.indexOf('process.gina.PROXY_HOST') > -1,
            'expected assignment from process.gina.PROXY_HOSTNAME and PROXY_HOST'
        );
    });

    it('getConfig uses JSON.clone for read-only copies', function() {
        var start = src.indexOf('this.getConfig = function(name)');
        var end = src.indexOf('\n    }', start) + 6;
        var block = src.slice(start, end);
        assert.ok(
            block.indexOf('JSON.clone(local.options.conf.content[name])') > -1,
            'expected JSON.clone for named config lookup'
        );
        assert.ok(
            block.indexOf('JSON.clone(local.options.conf)') > -1,
            'expected JSON.clone for full config clone'
        );
    });

    // ── (b) pure logic — inline replica ──────────────────────────────────────
    //
    // Minimal replica of getConfig that mirrors the actual guard logic. We
    // cannot require the full controller module (it needs a running gina
    // server), so we test the logic in isolation.

    function makeGetConfigEnv(opts) {
        opts = opts || {};

        // Simulate JSON.clone as a deep copy (same contract as the polyfill)
        function clone(obj) {
            if (obj == null || typeof obj != 'object') return obj;
            return JSON.parse(JSON.stringify(obj));
        }

        var local = {
            options: {
                conf: opts.conf || {
                    hostname: 'app.example.com',
                    host: 'app.example.com:3100',
                    content: {
                        routing: { home: { url: '/' } },
                        settings: { port: 3100, host: 'app.example.com' }
                    }
                }
            }
        };

        var contextStore = {
            isProxyHost: opts.isProxyHost || false
        };

        var savedGina = null;

        function setup() {
            savedGina = process.gina;
            process.gina = process.gina ? clone(process.gina) : {};
            if (typeof opts.proxyHostname != 'undefined') {
                process.gina.PROXY_HOSTNAME = opts.proxyHostname;
            }
            if (typeof opts.proxyHost != 'undefined') {
                process.gina.PROXY_HOST = opts.proxyHost;
            }
        }

        function teardown() {
            process.gina = savedGina;
        }

        function getContext(key) {
            return contextStore[key];
        }

        function getConfig(name) {
            var tmp = null;
            if ( typeof(name) != 'undefined' ) {
                try {
                    tmp = clone(local.options.conf.content[name]);
                } catch (err) {
                    return undefined;
                }
            } else {
                tmp = clone(local.options.conf);
            }

            if (
                getContext('isProxyHost')
                && typeof(tmp.hostname) != 'undefined'
                && typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
            ) {
                tmp.hostname    = process.gina.PROXY_HOSTNAME;
                tmp.host        = process.gina.PROXY_HOST;
            }
            return tmp;
        }

        return {
            local: local,
            getConfig: getConfig,
            setup: setup,
            teardown: teardown
        };
    }

    it('normal return with no proxy: hostname unchanged', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'app.example.com',
                'hostname must be preserved when isProxyHost is false');
            assert.equal(conf.host, 'app.example.com:3100',
                'host must be preserved when isProxyHost is false');
        } finally {
            env.teardown();
        }
    });

    it('proxy override when PROXY_HOSTNAME is defined and isProxyHost is true', function() {
        var env = makeGetConfigEnv({
            isProxyHost: true,
            proxyHostname: 'proxy.example.com',
            proxyHost: 'proxy.example.com:8080'
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'proxy.example.com',
                'hostname must be overridden to PROXY_HOSTNAME');
            assert.equal(conf.host, 'proxy.example.com:8080',
                'host must be overridden to PROXY_HOST');
        } finally {
            env.teardown();
        }
    });

    it('guard: no override when PROXY_HOSTNAME is undefined even if isProxyHost is true', function() {
        // This is the bug fix scenario: browser Origin header triggers
        // isProxyHost = true, but PROXY_HOSTNAME was never set. Without the
        // guard, hostname would be overwritten with undefined.
        var env = makeGetConfigEnv({
            isProxyHost: true
            // proxyHostname intentionally omitted — stays undefined on process.gina
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.equal(conf.hostname, 'app.example.com',
                'hostname must be preserved when PROXY_HOSTNAME is undefined (bug fix)');
            assert.equal(conf.host, 'app.example.com:3100',
                'host must be preserved when PROXY_HOSTNAME is undefined (bug fix)');
        } finally {
            env.teardown();
        }
    });

    it('no override when tmp has no hostname property (e.g. named sub-config)', function() {
        var env = makeGetConfigEnv({
            isProxyHost: true,
            proxyHostname: 'proxy.example.com',
            proxyHost: 'proxy.example.com:8080'
        });
        env.setup();
        try {
            // 'routing' sub-config has no hostname property
            var conf = env.getConfig('routing');
            assert.ok(typeof conf.hostname == 'undefined',
                'routing sub-config should not have a hostname injected');
            assert.deepEqual(conf, { home: { url: '/' } },
                'named config must return content[name] unchanged');
        } finally {
            env.teardown();
        }
    });

    it('named config lookup returns content[name]', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var settings = env.getConfig('settings');
            assert.deepEqual(settings, { port: 3100, host: 'app.example.com' },
                'getConfig("settings") must return conf.content.settings');
        } finally {
            env.teardown();
        }
    });

    it('named config lookup returns undefined for missing key', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var result = env.getConfig('nonexistent');
            assert.equal(result, undefined,
                'getConfig for a missing key must return undefined');
        } finally {
            env.teardown();
        }
    });

    it('no-arg call returns full conf clone', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf = env.getConfig();
            assert.ok(typeof conf.hostname != 'undefined', 'full conf must include hostname');
            assert.ok(typeof conf.content != 'undefined', 'full conf must include content');
        } finally {
            env.teardown();
        }
    });

    it('clone isolation: mutating returned object does not affect original', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var conf1 = env.getConfig();
            conf1.hostname = 'mutated.example.com';
            conf1.content.routing.injected = true;

            var conf2 = env.getConfig();
            assert.equal(conf2.hostname, 'app.example.com',
                'second call must return original hostname, not mutated value');
            assert.equal(typeof conf2.content.routing.injected, 'undefined',
                'second call must not see mutation from first call');
        } finally {
            env.teardown();
        }
    });

    it('clone isolation: named config mutation does not affect original', function() {
        var env = makeGetConfigEnv({
            isProxyHost: false
        });
        env.setup();
        try {
            var routing1 = env.getConfig('routing');
            routing1.home.url = '/mutated';

            var routing2 = env.getConfig('routing');
            assert.equal(routing2.home.url, '/',
                'second call must return original routing, not mutated value');
        } finally {
            env.teardown();
        }
    });

    it('all three guard conditions must be true for override to apply', function() {
        // Test matrix: only the (true, true, true) combination applies the override
        var cases = [
            { isProxy: false, hasHostname: true,  hasPH: true,  expect: 'app.example.com', label: 'F,T,T' },
            { isProxy: true,  hasHostname: true,  hasPH: false, expect: 'app.example.com', label: 'T,T,F' },
            { isProxy: true,  hasHostname: false, hasPH: true,  expect: undefined,          label: 'T,F,T' },
            { isProxy: true,  hasHostname: true,  hasPH: true,  expect: 'proxy.example.com', label: 'T,T,T' }
        ];

        cases.forEach(function(c) {
            var confObj = c.hasHostname
                ? { hostname: 'app.example.com', host: 'app.example.com:3100', content: {} }
                : { content: {} };
            var envOpts = {
                isProxyHost: c.isProxy,
                conf: confObj
            };
            if (c.hasPH) {
                envOpts.proxyHostname = 'proxy.example.com';
                envOpts.proxyHost = 'proxy.example.com:8080';
            }
            var env = makeGetConfigEnv(envOpts);
            env.setup();
            try {
                var result = env.getConfig();
                assert.equal(result.hostname, c.expect,
                    'case [' + c.label + ']: hostname mismatch');
            } finally {
                env.teardown();
            }
        });
    });

});
