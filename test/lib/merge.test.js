var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');

var merge = require('../../framework/v0.1.6-alpha.177/lib/merge/src/main');
var helpers = require('../../framework/v0.1.6-alpha.177/helpers');


// 01 — Merging two objects
describe('01 - Merging two objects', function () {

    var a, b;
    var setVariable = function () {
        a = {
            status: 'ok',
            msg: 'hello world !',
            page: {
                content: 'index.html',
                list: ['apple', 'orange', 'mango'],
                javascripts: [ '/entreprise/handlers/client/main.js' ]
            }
        };
        b = {
            "status": "ko",
            "msg": "hello Jane !",
            "page": {
                "control": "home",
                "ext": ".html",
                "content": "home.html",
                "javascripts": [
                    "/entreprise/handlers/client/edit.js",
                    "/js/lib/jquery.min.js"
                ]
            }
        };
    };

    var AtoBwithOverride, BtoAwithOverride, AtoBwithoutOverride, BtoAwithoutOverride;

    beforeEach(function () {
        setVariable();
        AtoBwithOverride = merge(a, b, true);
        setVariable();
        BtoAwithOverride = merge(b, a, true);
        setVariable();
        AtoBwithoutOverride = merge(a, b);
        setVariable();
        BtoAwithoutOverride = merge(b, a);
    });

    it('Merge : A<-B with override', function () {
        var res = {
            "status": "ko",
            "msg": "hello Jane !",
            "page": {
                "content": "home.html",
                "list": [ "apple", "orange", "mango" ],
                "javascripts": [
                    "/entreprise/handlers/client/edit.js",
                    "/js/lib/jquery.min.js"
                ],
                "control": "home",
                "ext": ".html"
            }
        };
        assert.equal(typeof(AtoBwithOverride), 'object');
        assert.deepStrictEqual(AtoBwithOverride, res);
    });

    it('Merge : B<-A with override', function () {
        var res = {
            "status": "ok",
            "msg": "hello world !",
            "page": {
                "content": "index.html",
                "list": [ "apple", "orange", "mango" ],
                "javascripts": [ "/entreprise/handlers/client/main.js" ],
                "control": "home",
                "ext": ".html"
            }
        };
        assert.equal(typeof(BtoAwithOverride), 'object');
        assert.deepStrictEqual(BtoAwithOverride, res);
    });

    it('Merge : A<-B without override', function () {
        var res = {
            "status": "ok",
            "msg": "hello world !",
            "page": {
                "content": "index.html",
                "list": [ "apple", "orange", "mango" ],
                "javascripts": [
                    "/entreprise/handlers/client/main.js",
                    "/entreprise/handlers/client/edit.js",
                    "/js/lib/jquery.min.js"
                ],
                "control": "home",
                "ext": ".html"
            }
        };
        assert.equal(typeof(AtoBwithoutOverride), 'object');
        assert.deepStrictEqual(AtoBwithoutOverride, res);
    });

    it('Merge : B<-A without override', function () {
        var res = {
            "status": "ko",
            "msg": "hello Jane !",
            "page": {
                "content": "home.html",
                "list": [ "apple", "orange", "mango" ],
                "javascripts": [
                    "/entreprise/handlers/client/edit.js",
                    "/js/lib/jquery.min.js",
                    "/entreprise/handlers/client/main.js"
                ],
                "control": "home",
                "ext": ".html"
            }
        };
        assert.equal(typeof(BtoAwithoutOverride), 'object');
        assert.deepStrictEqual(BtoAwithoutOverride, res);
    });

    it('Compare : A<-B with override & B<-A without override', function () {
        assert.notDeepStrictEqual(AtoBwithOverride, BtoAwithoutOverride);
    });

    it('Compare : B<-A with override & A<-B without override', function () {
        assert.notDeepStrictEqual(AtoBwithoutOverride, BtoAwithOverride);
    });
});


// 01b — Merging two objects (deep nested + financial)
describe('01b - Merging two objects (deep nested)', function () {

    var a, b, amounts, defaultAmounts;
    var setVariable = function () {
        a = {
            "page": { "view": { "params": { "section": "urssaf" } } },
            "form": { "rule": { "testField": { "isString": [25] } } }
        };
        b = {
            "page": { "view": { "file": "factsheets" } },
            "form": { "rule": { "testField": { "isString": [25, 25] } } }
        };
        amounts = {
            "gross": 775, "deposit": 0, "depositValue": 0, "depositType": "rate",
            "discountValue": 0, "discountType": "rate", "rebateValue": 0, "rebateType": "rate",
            "net": 775,
            "vat": [ { "20": 155 } ],
            "grandTotal": 930, "artistCreationValue": 0, "discount": 0,
            "rebate": 0, "freelanceTotal": 930, "organismTotal": 0
        };
        defaultAmounts = {
            "gross": 0, "deposit": 0, "depositValue": 0, "depositType": "rate",
            "discountValue": 0, "discountType": "rate", "rebateValue": 0, "rebateType": "rate",
            "net": 0, "vat": [], "grandTotal": 0
        };
    };

    it('Merge : A<-B without override', function () {
        setVariable();
        var result = merge(a, b);
        var res = {
            "page": { "view": { "params": { "section": "urssaf" }, "file": "factsheets" } },
            "form": { "rule": { "testField": { "isString": [25, 25] } } }
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : amounts<-defaultAmounts without override', function () {
        setVariable();
        var result = merge(amounts, defaultAmounts);
        var res = {
            "gross": 775, "deposit": 0, "depositValue": 0, "depositType": "rate",
            "discountValue": 0, "discountType": "rate", "rebateValue": 0, "rebateType": "rate",
            "net": 775,
            "vat": [ { "20": 155 } ],
            "grandTotal": 930, "artistCreationValue": 0, "discount": 0,
            "rebate": 0, "freelanceTotal": 930, "organismTotal": 0
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });
});


// 01c — Merging three objects
describe('01c - Merging three objects', function () {

    it('Merge : A<-B<-C without override', function () {
        var a = {
            "name": "dashboard", "version": "0.0.1",
            "proxy": {
                "coreapi": {
                    "_comment": "this is the targeted host to send API queries: pointing to coreapi env",
                    "ca": "{projectPath}/ssl/server/myproject.local.pem",
                    "hostname": "coreapi@myproject",
                    "port": "coreapi@myproject",
                    "path": "/api"
                },
                "dashboard": {
                    "_comment": "this is the targeted host to send Dashboard queries: pointing to Dashboard env",
                    "ca": "{projectPath}/ssl/server/myproject.local.pem",
                    "hostname": "dashboard@myproject",
                    "port": "dashboard@myproject",
                    "path": "/"
                }
            },
            "apis": { "googleFonts": { "apiKey": "464vzvgzeghéhzzr644h684hz4hrz8rhk4khjj" } }
        };
        var b = {
            "proxy": {
                "coreapi": { "rejectUnauthorized": false, "ca": "{projectPath}/ssl/server/myproject.local.pem" },
                "dashboard": { "rejectUnauthorized": false, "ca": "{projectPath}/ssl/server/myproject.local.pem" }
            }
        };
        var bUnordered = {
            "proxy": {
                "dashboard": { "rejectUnauthorized": false, "ca": "{projectPath}/ssl/server/myproject.local.pem" },
                "coreapi": { "rejectUnauthorized": false, "ca": "{projectPath}/ssl/server/myproject.local.pem" }
            }
        };
        var c = {
            host: undefined, hostname: undefined, path: undefined,
            port: 80, method: 'GET', keepAlive: true, auth: undefined,
            rejectUnauthorized: true,
            headers: { 'content-type': 'application/json', 'content-length': 327 },
            agent: false
        };

        var result1 = merge(a.proxy.dashboard, b.proxy.dashboard, c);
        var result2 = merge(a.proxy.dashboard, bUnordered.proxy.dashboard, c);

        var res = {
            "_comment": "this is the targeted host to send Dashboard queries: pointing to Dashboard env",
            "ca": "{projectPath}/ssl/server/myproject.local.pem",
            "hostname": "dashboard@myproject",
            "port": "dashboard@myproject",
            "path": "/",
            "rejectUnauthorized": false,
            "method": "GET",
            "keepAlive": true,
            "headers": { "content-type": "application/json", "content-length": 327 },
            "agent": false
        };

        assert.equal(typeof(result1), 'object');
        assert.deepStrictEqual(result1, res);
        assert.equal(typeof(result2), 'object');
        assert.deepStrictEqual(result2, res);
    });
});


// 02 — Merging two literal objects (with functions)
describe('02 - Merging two literal objects', function () {

    var a, b;
    var setVariable = function () {
        a = {
            name: 'Julia Roberts', job: 'actress',
            getName: function () { return this.name },
            getJob: function () { return this.job }
        };
        b = {
            name: 'Michael Jackson', age: 46, job: 'singer',
            getAge: function () { return this.age },
            getJob: function () { return 'Job : ' + this.job }
        };
    };

    var AtoBwithOverride, BtoAwithOverride, AtoBwithoutOverride, BtoAwithoutOverride;

    beforeEach(function () {
        setVariable();
        AtoBwithOverride = merge(a, b, true);
        setVariable();
        BtoAwithOverride = merge(b, a, true);
        setVariable();
        AtoBwithoutOverride = merge(a, b);
        setVariable();
        BtoAwithoutOverride = merge(b, a);
    });

    it('Merge : A<-B with override', function () {
        assert.equal(typeof(AtoBwithOverride), 'object');
        assert.equal(AtoBwithOverride.getName(), 'Michael Jackson');
        assert.equal(AtoBwithOverride.getAge(), 46);
        assert.equal(AtoBwithOverride.getJob(), 'Job : singer');
    });

    it('Merge : B<-A with override', function () {
        assert.equal(typeof(BtoAwithOverride), 'object');
        assert.equal(BtoAwithOverride.getName(), 'Julia Roberts');
        assert.equal(BtoAwithOverride.getAge(), 46);
        assert.equal(BtoAwithOverride.getJob(), 'actress');
    });

    it('Merge : A<-B without override', function () {
        assert.equal(typeof(AtoBwithoutOverride), 'object');
        assert.equal(AtoBwithoutOverride.getName(), 'Julia Roberts');
        assert.equal(AtoBwithoutOverride.getAge(), 46);
        assert.equal(AtoBwithoutOverride.getJob(), 'actress');
    });

    it('Merge : B<-A without override', function () {
        assert.equal(typeof(BtoAwithoutOverride), 'object');
        assert.equal(BtoAwithoutOverride.getName(), 'Michael Jackson');
        assert.equal(BtoAwithoutOverride.getAge(), 46);
        assert.equal(BtoAwithoutOverride.getJob(), 'Job : singer');
    });

    it('Compare : A<-B with override & B<-A without override', function () {
        assert.equal(AtoBwithOverride.getName(), BtoAwithoutOverride.getName());
        assert.equal(AtoBwithOverride.getAge(), BtoAwithoutOverride.getAge());
        assert.equal(AtoBwithOverride.getJob(), BtoAwithoutOverride.getJob());
    });

    it('Compare : B<-A with override & A<-B without override', function () {
        assert.equal(AtoBwithoutOverride.getName(), BtoAwithOverride.getName());
        assert.equal(AtoBwithoutOverride.getAge(), BtoAwithOverride.getAge());
        assert.equal(AtoBwithoutOverride.getJob(), BtoAwithOverride.getJob());
    });
});


// 03 — Merging multiple objects (3-way permutations)
describe('03 - Merging multiple objects', function () {

    var a, b, c;
    var setVariable = function () {
        a = { "actress": "julia roberts", "job": "actress", "films": [ "pretty woman", "mirror, mirror" ] };
        b = { "actor": "tom hanks", "job": "actor", "films": [ "philadelphia", "forrest gump" ] };
        c = { "singer": "michael jackson", "job": "singer", "films": [ "captain eo", "The Wiz" ] };
    };

    it('Merge : A<-B<-C with override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts", "job": "singer",
            "films": [ "captain eo", "The Wiz" ], "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(a, b, c, true), res);
    });

    it('Merge : A<-C<-B with override', function () {
        setVariable();
        var res = {
            "actress": "julia roberts", "job": "actor",
            "films": [ "philadelphia", "forrest gump" ],
            "actor": "tom hanks", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(a, c, b, true), res);
    });

    it('Merge : B<-A<-C with override', function () {
        setVariable();
        var res = {
            "actress": "julia roberts", "job": "singer",
            "films": [ "captain eo", "The Wiz" ],
            "actor": "tom hanks", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(b, a, c, true), res);
    });

    it('Merge : B<-C<-A with override', function () {
        setVariable();
        var res = {
            "actress": "julia roberts", "job": "actress",
            "films": [ "pretty woman", "mirror, mirror" ],
            "actor": "tom hanks", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(b, c, a, true), res);
    });

    it('Merge : C<-A<-B with override', function () {
        setVariable();
        var res = {
            "actress": "julia roberts", "job": "actor",
            "films": [ "philadelphia", "forrest gump" ],
            "actor": "tom hanks", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(c, a, b, true), res);
    });

    it('Merge : C<-B<-A with override', function () {
        setVariable();
        var res = {
            "actress": "julia roberts", "job": "actress",
            "films": [ "pretty woman", "mirror, mirror" ],
            "actor": "tom hanks", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(c, b, a, true), res);
    });

    it('Merge : A<-B<-C without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "pretty woman", "mirror, mirror", "philadelphia", "forrest gump", "captain eo", "The Wiz" ],
            "job": "actress", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(a, b, c), res);
    });

    it('Merge : A<-C<-B without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "pretty woman", "mirror, mirror", "captain eo", "The Wiz", "philadelphia", "forrest gump" ],
            "job": "actress", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(a, c, b), res);
    });

    it('Merge : B<-A<-C without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "philadelphia", "forrest gump", "pretty woman", "mirror, mirror", "captain eo", "The Wiz" ],
            "job": "actor", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(b, a, c), res);
    });

    it('Merge : B<-C<-A without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "philadelphia", "forrest gump", "captain eo", "The Wiz", "pretty woman", "mirror, mirror" ],
            "job": "actor", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(b, c, a), res);
    });

    it('Merge : C<-A<-B without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "captain eo", "The Wiz", "pretty woman", "mirror, mirror", "philadelphia", "forrest gump" ],
            "job": "singer", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(c, a, b), res);
    });

    it('Merge : C<-B<-A without override', function () {
        setVariable();
        var res = {
            "actor": "tom hanks", "actress": "julia roberts",
            "films": [ "captain eo", "The Wiz", "philadelphia", "forrest gump", "pretty woman", "mirror, mirror" ],
            "job": "singer", "singer": "michael jackson"
        };
        assert.deepStrictEqual(merge(c, b, a), res);
    });

    it('Compare : (A<-B<-C && A<-C<-B without override) && (B<-C<-A && C<-B<-A with override)', function () {
        setVariable();
        var AtoBtoCwithoutOverride = merge(a, b, c);
        setVariable();
        var AtoCtoBwithoutOverride = merge(a, c, b);
        setVariable();
        var BtoCtoAwithOverride = merge(b, c, a, true);
        setVariable();
        var CtoBtoAwithOverride = merge(c, b, a, true);

        assert.notDeepStrictEqual(AtoBtoCwithoutOverride, AtoCtoBwithoutOverride);
        assert.notDeepStrictEqual(AtoCtoBwithoutOverride, BtoCtoAwithOverride);
        assert.deepStrictEqual(BtoCtoAwithOverride, CtoBtoAwithOverride);
        assert.notDeepStrictEqual(CtoBtoAwithOverride, AtoBtoCwithoutOverride);
    });

    it('Compare : (B<-A<-C && B<-C<-A without override) && (A<-C<-B && C<-A<-B with override)', function () {
        setVariable();
        var BtoAtoCwithoutOverride = merge(b, a, c);
        setVariable();
        var BtoCtoAwithoutOverride = merge(b, c, a);
        setVariable();
        var AtoCtoBwithOverride = merge(a, c, b, true);
        setVariable();
        var CtoAtoBwithOverride = merge(c, a, b, true);

        assert.notDeepStrictEqual(BtoAtoCwithoutOverride, BtoCtoAwithoutOverride);
        assert.notDeepStrictEqual(BtoCtoAwithoutOverride, AtoCtoBwithOverride);
        assert.deepStrictEqual(AtoCtoBwithOverride, CtoAtoBwithOverride);
        assert.notDeepStrictEqual(CtoAtoBwithOverride, BtoAtoCwithoutOverride);
    });

    it('Compare : (C<-A<-B && C<-B<-A without override) && (A<-B<-C && B<-A<-C with override)', function () {
        setVariable();
        var CtoAtoBwithoutOverride = merge(c, a, b);
        setVariable();
        var CtoBtoAwithoutOverride = merge(c, b, a);
        setVariable();
        var AtoBtoCwithOverride = merge(a, b, c, true);
        setVariable();
        var BtoAtoCwithOverride = merge(b, a, c, true);

        assert.notDeepStrictEqual(CtoAtoBwithoutOverride, CtoBtoAwithoutOverride);
        assert.notDeepStrictEqual(CtoBtoAwithoutOverride, AtoBtoCwithOverride);
        assert.deepStrictEqual(AtoBtoCwithOverride, BtoAtoCwithOverride);
        assert.notDeepStrictEqual(BtoAtoCwithOverride, CtoAtoBwithoutOverride);
    });
});


// 04 — Merging two arrays
describe('04 - Merging two arrays', function () {

    var a, b, c, d, e, f, g;
    var setVariable = function () {
        a = [];
        b = ['apple', 'orange', 'mango'];
        c = ['green', 'yellow'];
        d = [2021];
        e = [2021];
        f = [
            { "id": "robot", "name": "Gina", "email": "robot@gina.io" },
            { "id": "contact", "name": "Gina", "email": "contact@gina.io" },
            { "id": "newsletter", "name": "Gina", "email": "newsletter@gina.io" }
        ];
        g = [
            { "id": "robot", "name": "Gina", "email": "dev.freelancer@gina.io" },
            { "id": "contact", "name": "Gina", "email": "contact@freelancer.app" },
            { "id": "newsletter", "name": "Gina", "email": "newsletter@freelancer.app" }
        ];
    };

    it('Merge : A<-B with override', function () {
        setVariable();
        var res = ['apple', 'orange', 'mango'];
        var result = merge(a, b, true);
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
    });

    it('Merge : B<-A with override', function () {
        setVariable();
        var res = [];
        var result = merge(b, a, true);
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : B<-C with override', function () {
        setVariable();
        var res = ['green', 'yellow'];
        var result = merge(b, c, true);
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : A<-B without override', function () {
        setVariable();
        var res = ['apple', 'orange', 'mango'];
        var result = merge(a, b);
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : B<-A without override', function () {
        setVariable();
        var res = ['apple', 'orange', 'mango'];
        var result = merge(b, a);
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : B<-C without override', function () {
        setVariable();
        var res = ['apple', 'orange', 'mango', 'green', 'yellow'];
        var result = merge(b, c);
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : G<-F without override', function () {
        setVariable();
        var res = [
            { "id": "robot", "name": "Gina", "email": "dev.freelancer@gina.io" },
            { "id": "contact", "name": "Gina", "email": "contact@freelancer.app" },
            { "id": "newsletter", "name": "Gina", "email": "newsletter@freelancer.app" }
        ];
        var result = merge(g, f);
        assert.equal(typeof(result), 'object');
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
    });

    it('Compare : A<-B with override & B<-A without override', function () {
        setVariable();
        var AtoBwithOverride = merge(a, b, true);
        setVariable();
        var BtoAwithoutOverride = merge(b, a);
        assert.deepStrictEqual(AtoBwithOverride, BtoAwithoutOverride);
    });

    it('Compare : B<-A with override & A<-B without override', function () {
        setVariable();
        var AtoBwithoutOverride = merge(a, b);
        setVariable();
        var BtoAwithOverride = merge(b, a, true);
        assert.notDeepStrictEqual(AtoBwithoutOverride, BtoAwithOverride);
    });
});


// 05 — Merging two collections
describe('05 - Merging two collections', function () {

    var a, b, c, d;
    var terms, terms2, settingTerms, design, newFonts, designNew, template;

    var originalA = [];
    var originalB = [
        { id: 1, value: 'apple' },
        { id: 2, value: 'orange' },
        { id: 3, value: 'mango' }
    ];
    var originalC = [
        { id: 1, value: 'green' },
        { id: 4, value: 'yellow' },
        { id: 3, value: 'mango' },
        { id: 5, value: 'lemon', createdAt: '2018-01-01T00:00:00' }
    ];
    var originalD = [
        { id: 1, value: 'apple' },
        { id: 2, value: 'mint' },
        { id: 3, value: 'mango' }
    ];

    var originalTerms = [
        {
            _comment: "force update 1",
            _uuid: "208e4cb0-1b07-4a07-8d90-c020493f7173",
            createdAt: "2017-01-01T00:00:00",
            details: "- Le pr\u00e9sent [TYPE DE DOCUMENT] pr\u00e9voit l\u2019int\u00e9gralit\u00e9 des prestations que le prestataire s\u2019engage \u00e0 r\u00e9aliser pour le Client.\n- Toute prestation suppl\u00e9mentaire demand\u00e9e par le Client donnera lieu \u00e0 l\u2019\u00e9mission d\u2019un nouveau devis ou d\u2019un avenant.\n- Le pr\u00e9sent document est valable durant [D\u00c9LAI AVANT EXPIRATION DU DEVIS] \u00e0 compter de sa date d\u2019\u00e9mission.\n- Une fois valid\u00e9 par le Client, le pr\u00e9sent document a valeur de contrat.\n- Dans le cas d\u2019une demande d\u2019acompte, une facture d\u2019acompte \u00e0 r\u00e9gler d\u00e8s r\u00e9ception sera communiqu\u00e9e au Client \u00e0 la validation du pr\u00e9sent document.\n- Dans l\u2019hypoth\u00e8se d\u2019une rupture de contrat \u00e0 l\u2019initiative du Client, ce dernier s\u2019engage \u00e0 r\u00e9gler les prestations r\u00e9alis\u00e9es.\n- En cas d\u2019acceptation du puis de d\u00e9dit, complet ou partiel, du client, ce dernier devra r\u00e9gler une quote-part de 20% des sommes correspondant aux prestations non encore r\u00e9alis\u00e9es.",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-1",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: false,
            title: "\u00c0 propos de ce document", type: "estimate"
        },
        {
            _uuid: "ce112986-659a-431b-964c-f0516b963fb4",
            createdAt: "2017-01-01T00:00:00",
            details: "- La facture correspondante sera payable [D\u00c9LAI DE PAIEMENT DE LA FACTURE].\n- Cette facture pourra \u00eatre communiqu\u00e9e par courrier \u00e9lectronique.\n- Tout r\u00e8glement effectu\u00e9 apr\u00e8s expiration de ce d\u00e9lai donnera lieu \u00e0 une p\u00e9nalit\u00e9 de retard journali\u00e8re de 10 Euros ainsi qu\u2019\u00e0 l\u2019application d\u2019un int\u00e9r\u00eat \u00e9gal \u00e0 de 12 points de pourcentage. Enfin, dans le cas o\u00f9 le Client est un professionnel, une indemnit\u00e9 forfaitaire de 40 Euros sera \u00e9galement due.\n- Les p\u00e9nalit\u00e9s de retard sont exigibles sans qu\u2019un rappel soit n\u00e9cessaire.",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-2",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: false,
            title: "En conformit\u00e9 de l\u2019article L 441-6 du Code de commerce", type: "estimate"
        },
        {
            _uuid: "e81328a4-0109-4b12-803e-7f2e091eaf60",
            createdAt: "2017-01-01T00:00:00",
            details: "- \u00c0 moins que le prestataire ne lui pr\u00e9sente une dispense \u00e0 jour, le Client doit retenir certaines cotisations bas\u00e9es le montant de la r\u00e9mun\u00e9ration artistique brute hors taxes. Il devra ensuite d\u00e9clarer et verser ce pr\u00e9compte directement \u00e0 [L\u2019ORGANISME] (article R382-27 du Code de la s\u00e9curit\u00e9 sociale).\n- Le Client doit \u00e9galement s\u2019acquitter aupr\u00e8s de [L\u2019ORGANISME] d\u2019une contribution personnelle \u00e9galement bas\u00e9e sur la r\u00e9mun\u00e9ration artistique brute hors taxes (article L382-4 du Code de la s\u00e9curit\u00e9 sociale et L6331-65 du Code du travail).\n- Pour plus d\u2019information consulter le site de http://www.secu-artistes-auteurs.fr",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-3",
            isArtistAuthor: true, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: true,
            title: "Informations concernant les artistes-auteurs", type: "estimate"
        },
        {
            _uuid: "b42de67b-2469-41cb-958f-94b0ccc36e59",
            createdAt: "2017-01-01T00:00:00",
            details: "- Le prestataire ne c\u00e8de que les droits d\u2019exploitation de la cr\u00e9ation limit\u00e9s aux termes du pr\u00e9sent document.\n- Le prestataire reste propri\u00e9taire de l\u2019int\u00e9gralit\u00e9 des cr\u00e9ations tant que la prestation n\u2019est pas enti\u00e8rement r\u00e9gl\u00e9e.\n- Toute utilisation sortant du cadre initialement pr\u00e9vu dans ce devis est interdite; sauf autorisation expresse et \u00e9crite du prestataire.",
            hasChanged: false, hasCopyrights: true, id: "sys-estimate-5",
            isArtistAuthor: true, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: true,
            title: "Informations concernant les droits d\u2019exploitation", type: "estimate"
        },
        {
            _uuid: "08b058f1-ce80-4cf8-98bc-35a6ee9b7585",
            createdAt: "2017-01-01T00:00:00",
            details: "- Cette facture doit \u00eatre r\u00e9gl\u00e9e [D\u00c9LAI DE PAIEMENT DE LA FACTURE].\n- Tout r\u00e8glement effectu\u00e9 apr\u00e8s expiration de ce d\u00e9lai donnera lieu \u00e0 une p\u00e9nalit\u00e9 de retard journali\u00e8re de 10 Euros ainsi qu\u2019\u00e0 l\u2019application d\u2019un int\u00e9r\u00eat \u00e9gal \u00e0 de 12 points de pourcentage. Enfin, dans le cas o\u00f9 le Client est un professionnel, une indemnit\u00e9 forfaitaire de 40 Euros sera \u00e9galement due.\n- Les p\u00e9nalit\u00e9s de retard sont exigibles sans qu\u2019un rappel soit n\u00e9cessaire.",
            hasChanged: false, hasCopyrights: false, id: "sys-invoice-1",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: false, isPassedOnInvoices: false,
            title: "En conformit\u00e9 de l\u2019article L 441-6 du Code de commerce", type: "invoice"
        },
        {
            _uuid: "8d871f6e-8dfa-4c95-b475-b4abfb98f237",
            createdAt: "2017-12-04T15:42:34", details: "- poupou",
            hasChanged: false, hasCopyrights: false, id: "8911b6e0-7f41-4909-b725-e6498e422bea",
            isArtistAuthor: false, isDefault: false, isPassedOnInvoices: true,
            title: "\u00c0 propos de ce devis 5", type: "estimate"
        },
        {
            _uuid: "b6ec2817-e89f-4175-9b89-e77b7470aea1",
            createdAt: "2017-12-04T15:53:31", details: "- bla 2",
            hasChanged: true, hasCopyrights: false, id: "75758512-00d7-4426-bb44-7b417939b57b",
            isArtistAuthor: false, isDefault: false, isPassedOnAmendments: true, isPassedOnInvoices: true,
            title: "\u00c0 propos de ce devis 7", type: "estimate"
        }
    ];

    var originalSettingTerms = [
        {
            _comment: "force update 1",
            createdAt: "2017-01-01T00:00:00",
            details: "- Le pr\u00e9sent [TYPE DE DOCUMENT] pr\u00e9voit l\u2019int\u00e9gralit\u00e9 des prestations que le prestataire s\u2019engage \u00e0 r\u00e9aliser pour le Client.\n- Toute prestation suppl\u00e9mentaire demand\u00e9e par le Client donnera lieu \u00e0 l\u2019\u00e9mission d\u2019un nouveau devis ou d\u2019un avenant.\n- Le pr\u00e9sent document est valable durant [D\u00c9LAI AVANT EXPIRATION DU DEVIS] \u00e0 compter de sa date d\u2019\u00e9mission.\n- Une fois valid\u00e9 par le Client, le pr\u00e9sent document a valeur de contrat.\n- Dans le cas d\u2019une demande d\u2019acompte, une facture d\u2019acompte \u00e0 r\u00e9gler d\u00e8s r\u00e9ception sera communiqu\u00e9e au Client \u00e0 la validation du pr\u00e9sent document.\n- Dans l\u2019hypoth\u00e8se d\u2019une rupture de contrat \u00e0 l\u2019initiative du Client, ce dernier s\u2019engage \u00e0 r\u00e9gler les prestations r\u00e9alis\u00e9es.\n- En cas d\u2019acceptation du puis de d\u00e9dit, complet ou partiel, du client, ce dernier devra r\u00e9gler une quote-part de 20% des sommes correspondant aux prestations non encore r\u00e9alis\u00e9es.",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-1",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: false,
            title: "\u00c0 propos de ce document", type: "estimate"
        },
        {
            createdAt: "2017-01-01T00:00:00",
            details: "- La facture correspondante sera payable [D\u00c9LAI DE PAIEMENT DE LA FACTURE].\n- Cette facture pourra \u00eatre communiqu\u00e9e par courrier \u00e9lectronique.\n- Tout r\u00e8glement effectu\u00e9 apr\u00e8s expiration de ce d\u00e9lai donnera lieu \u00e0 une p\u00e9nalit\u00e9 de retard journali\u00e8re de 10 Euros ainsi qu\u2019\u00e0 l\u2019application d\u2019un int\u00e9r\u00eat \u00e9gal \u00e0 de 12 points de pourcentage. Enfin, dans le cas o\u00f9 le Client est un professionnel, une indemnit\u00e9 forfaitaire de 40 Euros sera \u00e9galement due.\n- Les p\u00e9nalit\u00e9s de retard sont exigibles sans qu\u2019un rappel soit n\u00e9cessaire.",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-2",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: false,
            title: "En conformit\u00e9 de l\u2019article L 441-6 du Code de commerce", type: "estimate"
        },
        {
            createdAt: "2017-01-01T00:00:00",
            details: "- \u00c0 moins que le prestataire ne lui pr\u00e9sente une dispense \u00e0 jour, le Client doit retenir certaines cotisations bas\u00e9es le montant de la r\u00e9mun\u00e9ration artistique brute hors taxes. Il devra ensuite d\u00e9clarer et verser ce pr\u00e9compte directement \u00e0 [L\u2019ORGANISME] (article R382-27 du Code de la s\u00e9curit\u00e9 sociale).\n- Le Client doit \u00e9galement s\u2019acquitter aupr\u00e8s de [L\u2019ORGANISME] d\u2019une contribution personnelle \u00e9galement bas\u00e9e sur la r\u00e9mun\u00e9ration artistique brute hors taxes (article L382-4 du Code de la s\u00e9curit\u00e9 sociale et L6331-65 du Code du travail).\n- Pour plus d\u2019information consulter le site de http://www.secu-artistes-auteurs.fr",
            hasChanged: false, hasCopyrights: false, id: "sys-estimate-3",
            isArtistAuthor: true, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: true,
            title: "Informations concernant les artistes-auteurs", type: "estimate"
        },
        {
            createdAt: "2017-01-01T00:00:00",
            details: "- Le prestataire ne c\u00e8de que les droits d\u2019exploitation de la cr\u00e9ation limit\u00e9s aux termes du pr\u00e9sent document.\n- Le prestataire reste propri\u00e9taire de l\u2019int\u00e9gralit\u00e9 des cr\u00e9ations tant que la prestation n\u2019est pas enti\u00e8rement r\u00e9gl\u00e9e.\n- Toute utilisation sortant du cadre initialement pr\u00e9vu dans ce devis est interdite; sauf autorisation expresse et \u00e9crite du prestataire.",
            hasChanged: false, hasCopyrights: true, id: "sys-estimate-5",
            isArtistAuthor: true, isDefault: true, isPassedOnAmendments: true, isPassedOnInvoices: true,
            title: "Informations concernant les droits d\u2019exploitation", type: "estimate"
        },
        {
            createdAt: "2017-01-01T00:00:00",
            details: "- Cette facture doit \u00eatre r\u00e9gl\u00e9e [D\u00c9LAI DE PAIEMENT DE LA FACTURE].\n- Tout r\u00e8glement effectu\u00e9 apr\u00e8s expiration de ce d\u00e9lai donnera lieu \u00e0 une p\u00e9nalit\u00e9 de retard journali\u00e8re de 10 Euros ainsi qu\u2019\u00e0 l\u2019application d\u2019un int\u00e9r\u00eat \u00e9gal \u00e0 de 12 points de pourcentage. Enfin, dans le cas o\u00f9 le Client est un professionnel, une indemnit\u00e9 forfaitaire de 40 Euros sera \u00e9galement due.\n- Les p\u00e9nalit\u00e9s de retard sont exigibles sans qu\u2019un rappel soit n\u00e9cessaire.",
            hasChanged: false, hasCopyrights: false, id: "sys-invoice-1",
            isArtistAuthor: false, isDefault: true, isPassedOnAmendments: false, isPassedOnInvoices: false,
            title: "En conformit\u00e9 de l\u2019article L 441-6 du Code de commerce", type: "invoice"
        }
    ];

    var originalDesign = {
        id: "sys-desing-1",
        fonts: [
            { id: "font-1", name: "Titles", value: "Poiret One", weight: 400 },
            { id: "font-2", name: "Text", value: "Open Sans", weight: 400 }
        ]
    };
    var originalDesignNew = {
        id: "sys-desing-1",
        fonts: [ { id: "font-1", name: "Titles", value: "Open Sans", weight: 300 } ]
    };
    var originalNewFonts = {
        fonts: [ { id: "font-3", name: "Text Bold", value: "Open Sans", weight: 600 } ]
    };
    var originalTemplate = {
        "_common": {
            "routeNameAsFilenameEnabled": true,
            "http-metas": { "content-type": "text/html" },
            "stylesheets": [ { "name": "default", "media": "screen", "url": "/css/dashboard.css" } ]
        },
        "home": {
            "stylesheets": [],
            "javascripts": [ "/handlers/home.js" ]
        },
        "contact": {
            "javascripts": [ "/handlers/contact.js" ]
        }
    };

    var setVariable = function () {
        a = JSON.clone(originalA);
        b = JSON.clone(originalB);
        c = JSON.clone(originalC);
        d = JSON.clone(originalD);
        terms = JSON.clone(originalTerms);
        settingTerms = JSON.clone(originalSettingTerms);
        design = JSON.clone(originalDesign);
        designNew = JSON.clone(originalDesignNew);
        newFonts = JSON.clone(originalNewFonts);
        template = JSON.clone(originalTemplate);
    };

    it('Merge : A<-B with override', function () {
        setVariable();
        var result = merge(a, b, true);
        var res = [
            { id: 1, value: 'apple' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
    });

    it('Merge : B<-A with override', function () {
        setVariable();
        var result = merge(b, a, true);
        var res = [];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
    });

    it('Merge : B<-C with override', function () {
        setVariable();
        var result = merge(b, c, true);
        var res = [
            { id: 1, value: 'green' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' },
            { id: 4, value: 'yellow' },
            { id: 5, value: 'lemon', createdAt: '2018-01-01T00:00:00' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });

    it('Merge : A<-B without override', function () {
        setVariable();
        var result = merge(a, b);
        var res = [
            { id: 1, value: 'apple' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.notDeepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
    });

    it('Merge : B<-A without override', function () {
        setVariable();
        var result = merge(b, a);
        var res = [
            { id: 1, value: 'apple' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
    });

    it('Merge : B<-C without override', function () {
        setVariable();
        var result = merge(b, c);
        var res = [
            { id: 1, value: 'apple' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' },
            { id: 4, value: 'yellow' },
            { id: 5, value: 'lemon', createdAt: '2018-01-01T00:00:00' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });

    it('Merge : C<-B without override', function () {
        setVariable();
        var result = merge(c, b);
        var res = [
            { id: 1, value: 'green' },
            { id: 4, value: 'yellow' },
            { id: 3, value: 'mango' },
            { id: 5, value: 'lemon', createdAt: '2018-01-01T00:00:00' },
            { id: 2, value: 'orange' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
    });

    it('Merge : B<-D without override', function () {
        setVariable();
        var result = merge(b, d);
        var res = [
            { id: 1, value: 'apple' },
            { id: 2, value: 'orange' },
            { id: 3, value: 'mango' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
    });

    it('Merge : terms<-settingTerms without override', function () {
        setVariable();
        var result = merge(terms, settingTerms);
        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 7);
        assert.equal(result[0].id, 'sys-estimate-1');
        assert.equal(result[0]._uuid, '208e4cb0-1b07-4a07-8d90-c020493f7173');
    });

    it('Merge : terms2<-settingTerms without override', function () {
        var fixture = require('./fixtures/terms2-settingTerms.json');
        var t2 = JSON.clone(fixture.terms2);
        var st = JSON.clone(fixture.settingTerms);
        var result = merge(t2, st);
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, fixture.expected);
    });

    it('Merge : design<-newFonts without override', function () {
        setVariable();
        var result = merge(design, newFonts);
        var res = {
            id: "sys-desing-1",
            fonts: [
                { id: "font-1", name: "Titles", value: "Poiret One", weight: 400 },
                { id: "font-2", name: "Text", value: "Open Sans", weight: 400 },
                { id: "font-3", name: "Text Bold", value: "Open Sans", weight: 600 }
            ]
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : design.fonts<-newFonts.fonts without override', function () {
        setVariable();
        var result = merge(design.fonts, newFonts.fonts);
        var res = [
            { id: "font-1", name: "Titles", value: "Poiret One", weight: 400 },
            { id: "font-2", name: "Text", value: "Open Sans", weight: 400 },
            { id: "font-3", name: "Text Bold", value: "Open Sans", weight: 600 }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
    });

    it('Merge : designNew<-design without override', function () {
        setVariable();
        var result = merge(designNew, design);
        var res = {
            id: "sys-desing-1",
            fonts: [
                { id: "font-1", name: "Titles", value: "Open Sans", weight: 300 },
                { id: "font-2", name: "Text", value: "Open Sans", weight: 400 }
            ]
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : design<-designNew with override', function () {
        setVariable();
        var result = merge(design, designNew, true);
        var res = {
            "id": "sys-desing-1",
            "fonts": [
                { "id": "font-1", "name": "Titles", "value": "Open Sans", "weight": 300 },
                { "id": "font-2", "name": "Text", "value": "Open Sans", "weight": 400 }
            ]
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : template._common<-template.home with override', function () {
        setVariable();
        var result = merge.setKeyComparison('url')(template._common, template.home, true);
        var res = {
            "routeNameAsFilenameEnabled": true,
            "http-metas": { "content-type": "text/html" },
            "stylesheets": [],
            "javascripts": [ "/handlers/home.js" ]
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Merge : template._common<-template.contact with override', function () {
        setVariable();
        var result = merge.setKeyComparison('url')(template._common, template.contact, true);
        var res = {
            "routeNameAsFilenameEnabled": true,
            "http-metas": { "content-type": "text/html" },
            "stylesheets": [ { "name": "default", "media": "screen", "url": "/css/dashboard.css" } ],
            "javascripts": [ "/handlers/contact.js" ]
        };
        assert.equal(typeof(result), 'object');
        assert.deepStrictEqual(result, res);
    });

    it('Compare : A<-B with override & B<-A without override', function () {
        setVariable();
        var AtoBwithOverride = merge(a, b, true);
        setVariable();
        var BtoAwithoutOverride = merge(b, a);
        assert.deepStrictEqual(AtoBwithOverride, BtoAwithoutOverride);
    });
});


// 06 — Merging two collections with custom key comparison
describe('06 - Merging two collections with custom key comparison', function () {

    var a, b, c;
    var originalA = [
        { media: 'screen', name: 'default', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' }
    ];
    var originalB = [
        { media: 'screen', name: 'public', rel: 'stylesheet', type: 'text/css', url: '/js/css/public.min.css' }
    ];
    var originalC = [
        { media: 'print', name: 'pdf', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' }
    ];

    var setVariable = function () {
        a = JSON.clone(originalA);
        b = JSON.clone(originalB);
        c = JSON.clone(originalC);
    };

    it('Merge : B<-A without override using key `url`', function () {
        setVariable();
        merge.setKeyComparison('url');
        var result = merge(a, b);
        var res = [
            { media: 'screen', name: 'default', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' },
            { media: 'screen', name: 'public', rel: 'stylesheet', type: 'text/css', url: '/js/css/public.min.css' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });

    it('Merge : A<-B without override using key `url`', function () {
        setVariable();
        var result = merge.setKeyComparison('url')(b, a);
        var res = [
            { media: 'screen', name: 'public', rel: 'stylesheet', type: 'text/css', url: '/js/css/public.min.css' },
            { media: 'screen', name: 'default', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });

    it('Merge : A<-C without override using key `url`', function () {
        setVariable();
        merge.setKeyComparison('url');
        var result = merge(a, c);
        var res = [
            { media: 'screen', name: 'default', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });

    it('Merge : A<-C with override using key `url`', function () {
        setVariable();
        merge.setKeyComparison('url');
        var result = merge(a, c, true);
        var res = [
            { media: 'print', name: 'pdf', rel: 'stylesheet', type: 'text/css', url: '/js/vendor/gina/gina.min.css' }
        ];
        assert.equal(Array.isArray(result), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
        assert.deepStrictEqual(originalC, c);
    });
});


// 07 — Merging two collections without custom key comparison
describe('07 - Merging two collections without custom key comparison', function () {

    var a, b;
    var originalA = {
        "isValid": true, "trigger": "revival4", "status": "warning",
        "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 4/5",
        "callToActions": [
            { "name": "Relancer", "title": "Envoyer une relance", "type": "send", "icon": "send" },
            { "name": "Encaisser", "title": "Enregistrer un paiement", "type": "add", "icon": "add" }
        ]
    };
    var originalB = {
        "isValid": false, "trigger": "revival5", "status": "error",
        "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 5/5",
        "callToActions": [
            { "name": "Relancer", "title": "Envoyer une relance 5", "type": "send", "icon": "send" },
            { "name": "Encaisser", "title": "Enregistrer un paiement 5", "type": "add", "icon": "add" }
        ]
    };

    var setVariable = function () {
        a = JSON.clone(originalA);
        b = JSON.clone(originalB);
    };

    it('Merge : B<-A without override without key comparison', function () {
        setVariable();
        var result = merge(a, b);
        var res = {
            "isValid": true, "trigger": "revival4", "status": "warning",
            "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 4/5",
            "callToActions": [
                { "name": "Relancer", "title": "Envoyer une relance", "type": "send", "icon": "send" },
                { "name": "Encaisser", "title": "Enregistrer un paiement", "type": "add", "icon": "add" }
            ]
        };
        assert.equal(Array.isArray(result.callToActions), true);
        assert.deepStrictEqual(result, res);
        assert.deepStrictEqual(originalA, a);
        assert.deepStrictEqual(originalB, b);
    });
});
