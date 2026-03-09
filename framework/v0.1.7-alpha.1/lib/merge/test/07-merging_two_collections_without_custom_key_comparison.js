var helpers     = require(__dirname +'/../../../helpers');
var reporter    = null;
try {
    reporter    = require('nodeunit').reporters.default;
} catch (reporterErr) {
    reporter    = null
}

var merge       = require(__dirname + '/../src/main');// Not needed if the framework installed
var filename    = __filename;
var file        = filename.split(/\//g).slice(-1);

var a = null;
var b = null;

var originalA = {
    "isValid": true,
    "trigger": "revival4",
    "status": "warning",
    "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 4/5",
    "callToActions": [
        {
            "name": "Relancer",
            "title": "Envoyer une relance",
            "type": "send",
            "icon": "send"
        },
        {
            "name": "Encaisser",
            "title": "Enregistrer un paiement",
            "type": "add",
            "icon": "add"
        }
    ]
};

var originalB = {
    "isValid": false,
    "trigger": "revival5",
    "status": "error",
    "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 5/5",
    "callToActions": [
        {
            "name": "Relancer",
            "title": "Envoyer une relance 5",
            "type": "send",
            "icon": "send"
        },
        {
            "name": "Encaisser",
            "title": "Enregistrer un paiement 5",
            "type": "add",
            "icon": "add"
        }
    ]
};


var setVariable = function () {
    a = JSON.clone(originalA);
    b = JSON.clone(originalB);
};


exports['Merge : B<-A without override without key comparison'] = function(test) {
    setVariable();
    // No comparison keys, should take first prop as key comaparison
    var BtoAwithoutOverride    = merge(a, b);

    var res = {
        "isValid": true,
        "trigger": "revival4",
        "status": "warning",
        "subject": "Retard sur le paiement {{ document.label.ofTheDocument }} <strong>{{ document.documentId }}</strong> 4/5",
        "callToActions": [
            {
                "name": "Relancer",
                "title": "Envoyer une relance",
                "type": "send",
                "icon": "send"
            },
            {
                "name": "Encaisser",
                "title": "Enregistrer un paiement",
                "type": "add",
                "icon": "add"
            }
        ]
    };

    test.equal( Array.isArray(BtoAwithoutOverride.callToActions), true );

    test.deepEqual(BtoAwithoutOverride, res);
    test.deepEqual(originalA, a);
    test.deepEqual(originalB, b);

    test.done()
}

// for debug purpose
if (reporter)
    reporter.run(['test/'+file]);