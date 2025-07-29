var reporter    = require('nodeunit').reporters.default;
var jsonHelper  = require('../src/main')();// Not needed if the framework installed

var app = __dirname + '/data/app.json';
var app2 = __dirname + '/data/app2.json';
var appPlaceholdersCase = __dirname + '/data/app.placeholders.json';
var crons = __dirname + '/data/crons.json';
var routing = __dirname + '/data/routing.json';
var settings = __dirname + '/data/settings.json';
var statics = __dirname + '/data/statics.json';
var templates = __dirname + '/data/templates.json';

var setVariable = function (path) {
    return requireJSON(path);
};



// you can also write it this way
var appCase  = setVariable(app);
var app2Case  = setVariable(app2);
var appPlaceholdersCase  = setVariable(appPlaceholdersCase);
var cronsCase  = setVariable(crons);
var routingCase  = setVariable(routing);
var settingsCase  = setVariable(settings);
var staticsCase  = setVariable(statics);
var templatesCase  = setVariable(templates);


exports['requireJSON: app.json case'] = function(test) {
    var res = {
        "name": "coreapi",
        "_comment": "`version` is the current API version: to link to the new documentation, change this value",
        "version": "0.0.1",
        "fonts": "//fonts.gstatic.com/s/trirong/v3/gzxgezrghzh.ttf",
        "session": {
          "secret": "864xxxxg6egc&xxxk7rah8n!$((4yls9#v@%#$8af!8%f!xxn(iwi%n267",
          "expire": "60000*120"
        },

        "admin": {
          "email": "m.etouman@rhinostone.com"
        },

        "smtp": {
          "defaultProvider": "mailjet"
        },

        "scrypt": {
          "key": "xxxyls9#v@9igltxx^x4z8zy7x+_dzf%dppdsong82uvpt6#^b)475vj_%o#_9^7",
          "maxtime": {
            "N": 1,
            "r": 1,
            "p": 1
          }
        },

        "notes": {
          "_comment": "Used to inform the user (e.g.: /entreprise/preferences)",
          "terms": {
            "estimate": {
              "legend": "Devis",
              "intro": "La combinaison de vos prestations et de ces conditions, constitue un contrat que vous et votre client vous engagez à respecter."
            },
            "invoice": {
              "legend": "Facture",
              "intro": "Attention, seules les conditions qui figurent sur un contrat préalable ou découlent d’une obligation légale ont une réelle valeur."
            },
            "amendment": {
              "legend": "Avenant",
              "intro": "Introduire de nouvelles conditions dans un avenant étend ou modifie le contrat préexistant."
            }
          }
        },

        "documents": {
          "_comment": "see https://nodejs.org/api/util.html#util_util_format_format_args",
          "infos": {
            "estimate-draft": "brouillon",
            "estimate-pending": "en attente de validation",
            "estimate-confirmed": "restant à facturer",
            "estimate-rejected": "rejeté",
            "estimate-expired": "périmé",
            "estimate-canceled": "abandonné",

            "invoice-draft": "brouillon",
            "invoice-pending": "en attente de paiement",
            "invoice-paid": "payé",
            "invoice-overdue": "en retard depuis le %s",
            "invoice-canceled": "annulé"
          },
          "types": {
            "estimate": "devis",
            "estimate-the": "le devis",
            "estimate-this": "ce devis",
            "estimate-ofthe": "du devis",
            "estimate-from": "devis du %s",

            "amendment": "avenant",
            "amendment-the": "l’avenant",
            "amendment-this": "ce devis",
            "amendment-ofthe": "de l’avenant",
            "amendment-from": "avenant du %s",

            "invoice": "facture",
            "invoice-the": "la facture",
            "invoice-this": "cette facture",
            "invoice-ofthe": "de la facture",
            "invoice-from": "facture du %s",

            "creditNote": "avoir",
            "creditNote-the": "l’avoir",
            "creditNote-this": "cet avoir",
            "creditNote-ofthe": "de l’avoir",
            "creditNote-from": "avoir du %s"
          }
        },
        "legalMentions": {
          "aga": {
            "isAgaMember": "Membre d’une association de gestion agréé, paiement par chèque accepté"
          },
          "vat": {
            "_comment": "Company isVatExempted",
            "isVatExempted": "Franchise en base de TVA (article 293B du CGI)",
            "isVatExemptedDom": "TVA non applicable (article 294 du CGI)",
            "_comment.vat": "Client lives in the EEC and has a valid VAT number",
            "vatExportEuropeServices": "TVA déclarée par le preneur (article 283-2 du CGI)",
            "_comment.dom": "Client lives outside of France, the DOM or the EEC",
            "vatExportServices": "Exonération de TVA (article 262 I du CGI)",
            "vatTeachingRelated": "Exonération de TVA (article 261 IV du CGI)"
          }
        }
      };

    test.equal( typeof(appCase), 'object' );
    test.deepEqual(appCase, res );

    test.done()
}

exports['requireJSON: app2.json case'] = function(test) {
    var res = {
        "name" : "dashboard",
        "version" : "0.0.1",
        "proxy": {
            "coreapi": {
                "_comment": "this is the targeted host to send API queries: pointing to coreapi env",
                "ca": "{projectPath}/ssl/server/*.domain.com.local.pem",
                "hostname" : "coreapi@freelancer",
                "_protocol": "https",
                "port": "coreapi@freelancer",
                "path": "/api"
            },
            "dashboard": {
              "_comment": "this is the targeted host to send Dashboard queries: pointing to Dashboard env",
              "ca": "{projectPath}/ssl/server/*.domain.com.local.pem",
              "hostname" : "dashboard@freelancer",
              "port": "dashboard@freelancer",
              "path": "/"
            }
        },

        "apis": {
            "googleFonts": {
                "apiKey": "xxxXafazgzegzegzerggze"
            }
        },

        "isoCountries" : {
            "af" : "Afghanistan",
            "ax" : "Aland Islands",
            "al" : "Albania",
            "dz" : "Algeria",
            "as" : "American Samoa",
            "ad" : "Andorra",
            "ao" : "Angola",
            "ai" : "Anguilla",
            "aq" : "Antarctica",
            "ag" : "Antigua And Barbuda",
            "ar" : "Argentina",
            "am" : "Armenia",
            "aw" : "Aruba",
            "au" : "Australia",
            "at" : "Austria",
            "az" : "Azerbaijan",
            "bs" : "Bahamas",
            "bh" : "Bahrain",
            "bd" : "Bangladesh",
            "bb" : "Barbados",
            "by" : "Belarus",
            "be" : "Belgium",
            "bz" : "Belize",
            "bj" : "Benin",
            "bm" : "Bermuda",
            "bt" : "Bhutan",
            "bo" : "Bolivia",
            "ba" : "Bosnia And Herzegovina",
            "bw" : "Botswana",
            "bv" : "Bouvet Island",
            "br" : "Brazil",
            "io" : "British Indian Ocean Territory",
            "bn" : "Brunei Darussalam",
            "bg" : "Bulgaria",
            "bf" : "Burkina Faso",
            "bi" : "Burundi",
            "kh" : "Cambodia",
            "cm" : "Cameroon",
            "ca" : "Canada",
            "cv" : "Cape Verde",
            "ky" : "Cayman Islands",
            "cf" : "Central African Republic",
            "td" : "Chad",
            "cl" : "Chile",
            "cn" : "China",
            "cx" : "Christmas Island",
            "cc" : "Cocos (Keeling) Islands",
            "co" : "Colombia",
            "km" : "Comoros",
            "cg" : "Congo",
            "cd" : "Congo, Democratic Republic",
            "ck" : "Cook Islands",
            "cr" : "Costa Rica",
            "ci" : "Cote D\"Ivoire",
            "hr" : "Croatia",
            "cu" : "Cuba",
            "cy" : "Cyprus",
            "cz" : "Czech Republic",
            "dk" : "Denmark",
            "dj" : "Djibouti",
            "dm" : "Dominica",
            "do" : "Dominican Republic",
            "ec" : "Ecuador",
            "eg" : "Egypt",
            "sv" : "El Salvador",
            "gq" : "Equatorial Guinea",
            "er" : "Eritrea",
            "ee" : "Estonia",
            "et" : "Ethiopia",
            "fk" : "Falkland Islands (Malvinas)",
            "fo" : "Faroe Islands",
            "fj" : "Fiji",
            "fi" : "Finland",
            "fr" : "France",
            "gf" : "French Guiana",
            "pf" : "French Polynesia",
            "tf" : "French Southern Territories",
            "ga" : "Gabon",
            "gm" : "Gambia",
            "ge" : "Georgia",
            "de" : "Germany",
            "gh" : "Ghana",
            "gi" : "Gibraltar",
            "gr" : "Greece",
            "gl" : "Greenland",
            "gd" : "Grenada",
            "gp" : "Guadeloupe",
            "gu" : "Guam",
            "gt" : "Guatemala",
            "gg" : "Guernsey",
            "gn" : "Guinea",
            "gw" : "Guinea-Bissau",
            "gy" : "Guyana",
            "ht" : "Haiti",
            "hm" : "Heard Island & Mcdonald Islands",
            "va" : "Holy See (Vatican City State)",
            "hn" : "Honduras",
            "hk" : "Hong Kong",
            "hu" : "Hungary",
            "is" : "Iceland",
            "in" : "India",
            "id" : "Indonesia",
            "ir" : "Iran, Islamic Republic Of",
            "iq" : "Iraq",
            "ie" : "Ireland",
            "im" : "Isle Of Man",
            "il" : "Israel",
            "it" : "Italy",
            "jm" : "Jamaica",
            "jp" : "Japan",
            "je" : "Jersey",
            "jo" : "Jordan",
            "kz" : "Kazakhstan",
            "ke" : "Kenya",
            "ki" : "Kiribati",
            "kr" : "Korea",
            "kw" : "Kuwait",
            "kg" : "Kyrgyzstan",
            "la" : "Lao People\"s Democratic Republic",
            "lv" : "Latvia",
            "lb" : "Lebanon",
            "ls" : "Lesotho",
            "lr" : "Liberia",
            "ly" : "Libyan Arab Jamahiriya",
            "li" : "Liechtenstein",
            "lt" : "Lithuania",
            "lu" : "Luxembourg",
            "mo" : "Macao",
            "mk" : "Macedonia",
            "mg" : "Madagascar",
            "mw" : "Malawi",
            "my" : "Malaysia",
            "mv" : "Maldives",
            "ml" : "Mali",
            "mt" : "Malta",
            "mh" : "Marshall Islands",
            "mq" : "Martinique",
            "mr" : "Mauritania",
            "mu" : "Mauritius",
            "yt" : "Mayotte",
            "mx" : "Mexico",
            "fm" : "Micronesia, Federated States Of",
            "md" : "Moldova",
            "mc" : "Monaco",
            "mn" : "Mongolia",
            "me" : "Montenegro",
            "ms" : "Montserrat",
            "ma" : "Morocco",
            "mz" : "Mozambique",
            "mm" : "Myanmar",
            "na" : "Namibia",
            "nr" : "Nauru",
            "np" : "Nepal",
            "nl" : "Netherlands",
            "an" : "Netherlands Antilles",
            "nc" : "New Caledonia",
            "nz" : "New Zealand",
            "ni" : "Nicaragua",
            "ne" : "Niger",
            "ng" : "Nigeria",
            "nu" : "Niue",
            "nf" : "Norfolk Island",
            "mp" : "Northern Mariana Islands",
            "no" : "Norway",
            "om" : "Oman",
            "pk" : "Pakistan",
            "pw" : "Palau",
            "ps" : "Palestinian Territory, Occupied",
            "pa" : "Panama",
            "pg" : "Papua New Guinea",
            "py" : "Paraguay",
            "pe" : "Peru",
            "ph" : "Philippines",
            "pn" : "Pitcairn",
            "pl" : "Poland",
            "pt" : "Portugal",
            "pr" : "Puerto Rico",
            "qa" : "Qatar",
            "re" : "Reunion",
            "ro" : "Romania",
            "ru" : "Russian Federation",
            "rw" : "Rwanda",
            "bl" : "Saint Barthelemy",
            "sh" : "Saint Helena",
            "kn" : "Saint Kitts And Nevis",
            "lc" : "Saint Lucia",
            "mf" : "Saint Martin",
            "pm" : "Saint Pierre And Miquelon",
            "vc" : "Saint Vincent And Grenadines",
            "ws" : "Samoa",
            "sm" : "San Marino",
            "st" : "Sao Tome And Principe",
            "sa" : "Saudi Arabia",
            "sn" : "Senegal",
            "rs" : "Serbia",
            "sc" : "Seychelles",
            "sl" : "Sierra Leone",
            "sg" : "Singapore",
            "sk" : "Slovakia",
            "si" : "Slovenia",
            "sb" : "Solomon Islands",
            "so" : "Somalia",
            "za" : "South Africa",
            "gs" : "South Georgia And Sandwich Isl.",
            "es" : "Spain",
            "lk" : "Sri Lanka",
            "sd" : "Sudan",
            "sr" : "Suriname",
            "sj" : "Svalbard And Jan Mayen",
            "sz" : "Swaziland",
            "se" : "Sweden",
            "ch" : "Switzerland",
            "sy" : "Syrian Arab Republic",
            "tw" : "Taiwan",
            "tj" : "Tajikistan",
            "tz" : "Tanzania",
            "th" : "Thailand",
            "tl" : "Timor-Leste",
            "tg" : "Togo",
            "tk" : "Tokelau",
            "to" : "Tonga",
            "tt" : "Trinidad And Tobago",
            "tn" : "Tunisia",
            "tr" : "Turkey",
            "tm" : "Turkmenistan",
            "tc" : "Turks And Caicos Islands",
            "tv" : "Tuvalu",
            "ug" : "Uganda",
            "ua" : "Ukraine",
            "ae" : "United Arab Emirates",
            "gb" : "United Kingdom",
            "us" : "United States",
            "um" : "United States Outlying Islands",
            "uy" : "Uruguay",
            "uz" : "Uzbekistan",
            "vu" : "Vanuatu",
            "ve" : "Venezuela",
            "vn" : "Viet Nam",
            "vg" : "Virgin Islands, British",
            "vi" : "Virgin Islands, U.S.",
            "wf" : "Wallis And Futuna",
            "eh" : "Western Sahara",
            "ye" : "Yemen",
            "zm" : "Zambia",
            "zw" : "Zimbabwe"
        }
    };

    test.equal( typeof(app2Case), 'object' );
    test.deepEqual(app2Case, res );

    test.done()
}

exports['requireJSON: app.placeholders.json case'] = function(test) {
  var res = {
    "_comment_disabled": [
        {
            "key": "[NOM DU CLIENT]",
            "label": "nom du client",
            "value": "{% if client && client.lastName %}{{ client.lastName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[PRÉNOM DU CLIENT]",
            "label": "prénom du client",
            "value": "{% if client && client.firstName %}{{ client.firstName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[RÉFÉRENCE DU DOCUMENT]",
            "label": "reference du document",
            "value": "{% if document && document.documentId %}{{ document.documentId }}{% else %}null{% endif %}"
        },
        {
            "key": "[LIEN D'ACCÈS CLIENT AU DOCUMENT]",
            "label": "lien d'accès au document",
            "value": "http://www.google.com"
        },
        {
            "key": "[TAUX DES INDEMNITÉS À VERSER EN CAS DE DÉDIT]",
            "label": "taux des indemnités à verser en cas de dédit",
            "value": "{{ company.global.damagesRate }} %"
        },
        {
            "key": "[MONTANT DE L’ACOMPTE]",
            "label": "montant de l’acompte",
            "value": "{% if document.depositType == 'value' %}{{ document.depositValue }} €{% else %}{{ document.depositRate }} %{% endif %}"
        },
        {
            "key": "[DATE DE CONFIRMATION DU DEVIS]",
            "label": "date de confirmation du devis",
            "value": "5 avril 2017"
        },
        {
            "key": "[ADRESSE DE L’ORGANISME]",
            "label": "adresse de l’organisme",
            "value": "null",
            "isHidden": "{% if session.company.socialSecurityOrganism == 'mda' %}true{%else%}false{% endif %}"
        },
        {
            "key": "[SITE DE L’ORGANISME]",
            "label": "site de l’organisme",
            "value": "null",
            "isHidden": "{% if session.company.socialSecurityOrganism == 'mda' %}true{%else%}false{% endif %}"
        }
    ],
    "terms": [
        {
            "key": "[TYPE DE DOCUMENT]",
            "label": "document",
            "value": "{% if document.documentType == 'estimate' %}devis{% elseif document.documentType == 'invoice' %}facture{% else %}avenant{% endif %}"
        },
        {
            "key": "[LE TYPE DE DOCUMENT]",
            "label": "le document",
            "value": "{% if document.documentType == 'estimate' %}le devis{% elseif document.documentType == 'invoice' %}la facture{% else %}l’avenant{% endif %}"
        },
        {
            "key": "[CE TYPE DE DOCUMENT]",
            "label": "ce document",
            "value": "{% if document.documentType == 'estimate' %}ce devis{% elseif document.documentType == 'invoice' %}cette facture{% else %}cet avenant{% endif %}"
        },
        {
            "key": "[DU TYPE DE DOCUMENT]",
            "label": "du document",
            "value": "{% if document.documentType == 'estimate' %}du devis{% elseif document.documentType == 'invoice' %}de la facture{% else %}de l’avenant{% endif %}"
        },
        {
            "key": "[DÉLAI AVANT EXPIRATION DU DEVIS]",
            "label": "délai avant expiration",
            "value": "{{ document.validityPeriod }} jours",
            "isHidden": "{% if document.documentType == 'invoice' %}true{%else%}false{% endif %}"
        },
        {
            "key": "[DÉLAI DE PAIEMENT DE LA FACTURE]",
            "label": "délai de paiement de la facture",
            "value": "{% if document.paymentPeriod == 5 %}dès réception{% else %}sous {{ document.paymentPeriod }} jours{% endif %}"
        },
        {
            "key": "[DATE LIMITE DE PAIEMENT DE LA FACTURE]",
            "label": "date limite de paiement de la facture",
            "value": "avant le {{ document.invoicePeriod }}",
            "isHidden": "{% if document._collection != 'invoice' %}true{%else%}false{% endif %}"
        },
        {
            "key": "[L’ORGANISME]",
            "label": "l’organisme",
            "value": "{% if session.company.socialSecurityOrganism == 'mda' %}la Maison des Artistes{%else%}l’AGESSA{% endif %}",
            "isHidden": "{% if session.company.socialSecurityOrganism == 'mda' %}true{%else%}false{% endif %}"
        }
    ],
    "mails": [
        {
            "key": "[RÉFÉRENCE DU DOCUMENT]",
            "label": "reference du document",
            "value": "{% if document && document.documentId %}{{ document.documentId }}{% else %}null{% endif %}"
        },
        {
            "key": "[LIEN D’ACCÈS CLIENT AU DOCUMENT]",
            "label": "lien d’accès au document",
            "value": "http://www.google.com"
        },
        {
            "key": "[NOM DU PROJET]",
            "label": "nom du projet",
            "value": "{% if document.project && document.project.name %}{{ document.project.name }}{% else %}null{% endif %}"
        },
        {
            "key": "[CHÈRE MADAME]",
            "label": "Chère Madame, Cher Monsieur",
            "value": "{% if session.company.firmType == 'company' %}Chère Madame, Cher Monsieur{% else %}{% if session.company.civility == 'mr' || contact.civility == 'mr' %}Cher Monsieur{% else %}Chère Madame{% endif %}{% endif %}"
        },
        {
            "key": "[MADAME]",
            "label": "Madame, Monsieur",
            "value": "{% if recipient && recipient.type == 'company' %}Madame, Monsieur{% else %}{% if recipient.civility == 'mr' %}Monsieur{% else %}Madame{% endif %}{% endif %}"
        },
        {
            "key": "[NOM DU CLIENT]",
            "label": "Nom du client",
            "value": "{% if recipient.lastName != '' %}{{ recipient.lastName }}{% endif %}"
        },
        {
            "key": "[PRÉNOM DU CLIENT]",
            "label": "Prénom du client",
            "value": "{% if recipient.firstName != '' %}{{ recipient.firstName }}{% endif %}"
        }
    ],
    "signatures": [
        {
            "_comment": "defined in dashboard/controller.settings.js -> this.editXML",
            "key": "[NOM]",
            "label": "nom",
            "value": "{% if session && session.lastName != '' %}{{ session.lastName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[PRÉNOM]",
            "label": "prénom",
            "value": "{% if session && session.firstName != '' %}{{ session.firstName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[NOM DE LA SOCIÉTÉ]",
            "label": "nom de la société",
            "value": "{% if company && company.fullName %}{{ company.fullName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[NOM COMMERCIAL]",
            "label": "nom commercial",
            "value": "{% if company && company.tradingName %}{{ company.tradingName }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[RUE]",
            "label": "rue",
            "value": "{% if company && company.address %}{{ company.address }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[CODE POSTAL]",
            "label": "code postal",
            "value": "{% if company && company.zip %}{{ company.zip }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[VILLE]",
            "label": "ville",
            "value": "{% if company && company.city %}{{ company.city }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[PAYS]",
            "label": "pays",
            "value": "{% if company && company.country %}{{ company.country }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[SITE INTERNET]",
            "label": "site internet",
            "value": "{% if company && company.extra && company.extra.website %}{{ company.extra.website }}{% else %}{{ null }}{% endif %}"
        },
        {
            "key": "[TELEPHONE PORTABLE]",
            "label": "telephone portable",
            "value": "{% if company && company.extra && company.extra.mobile %}{{ company.extra.mobile }}{% else %}{{ null }}{% endif %}"
        }
    ]
  };

  test.equal( typeof(appPlaceholdersCase), 'object' );
  test.deepEqual(appPlaceholdersCase, res );

  test.done()
}

exports['requireJSON: crons.json case'] = function(test) {
  var res = {
    "_comment": "Configuration for cron lib",
    "mailing": {
        "active": true,
        "_comment": "This cron checks every 30 seconds if there are mails to be sent",
        "interval": "30s",
        "task": "checkForMailsToBeSent"
    },
    "fonts": {
        "active": true,
        "_comment": "This cron checks every day at 4:55am if there are new fonts to be added from Google fonts API",
        "interval": "55 4 * * *",
        "task": "downloadNewFonts",
        "tmp": "{tmpPath}/google.fonts.json",
        "target": "{bundlePath}/config/google.fonts.json",
        "url": "https://www.googleapis.com/webfonts/v1/webfonts",
        "apiKey": "wxxxzgfGEZGZgzefz"
    },
    "robot": {
        "active": false,
        "_comment": "This cron says Hi every 10 seconds if there are mails to be sent",
        "interval": "10s",
        "task": "sayHi"
    }
  };

  test.equal( typeof(cronsCase), 'object' );
  test.deepEqual(cronsCase, res );

  test.done()
}

exports['requireJSON: routing.json case'] = function(test) {
  var res = {

    "404": {
        "url": "/404.html",
        "param": { "control": "throw404" }
    },
    "home": {
        "url": "/",
        "param": {
            "control": "home"
        },
        "middleware": [ "middlewares.session.update" ]
    },
    "register-xml": {
        "namespace": "account",
        "url": "/account/register.ajax",
        "method": "POST",
        "param": { "control": "registerXML" }
    },
    "help": {
        "url": [
            "/help",
            "/resources"
        ],
        "param": {
            "control": "help",
            "title": "Resources"
        }
    },
    "docs": {
        "namespace": "docs",
        "url": [
            "/docs",
            "/documentation"
        ],
        "param": {
            "control": "renderFromMock"
        }
    },
    "doc": {
        "namespace": "docs",
        "url": [
            "/docs/:id",
            "/documentation/:id"
        ],
        "param": {
            "control":    "renderFromMock",
            "id":        ":id"
        },
        "requirements": {
            "id":      "([-a-z0-9]+)"
        }
    },
    "tutorials": {
        "url": [
            "/tutorials",
            "/tutorials"
        ],
        "param": {
            "control": "tutorials"
        }
    },

    "factsheets": {
        "namespace": "factsheets",
        "url": [
            "/factsheets/:section",
            "/fiches-pratiques/:section"
        ],
        "requirements": {
            "section": "mda-agessa|urssaf"
        },
        "param": {
            "control":    "renderFromMock",
            "section":   ":section"
        }
    },
    "factsheet": {
        "namespace": "factsheets",
        "url": [
            "/factsheets/:section/:id",
            "/fiches-pratiques/:section/:id"
        ],
        "param": {
            "control":    "renderFromMock",
            "section":   ":section",
            "id":        ":id"
        },
        "requirements": {
            "section": "mda-agessa|urssaf",
            "id":      "([-a-z0-9]+)"
        }
    },

    "roadmap": {
        "url": [
            "/roadmap",
            "/feuille-de-route"
        ],
        "param": {
            "control": "roadmap"
        }
    },

    "about": {
        "url": [
            "/about",
            "/a-propos"
        ],
        "param": {
            "control": "about"
        }
    },

    "cgu": {
        "url": [
            "/cgu",
            "/cgv"
        ],
        "param": {
            "control": "cgu"
        }
    },

    "privacy": {
        "url": [
            "/privacy",
            "/politique-de-confidentialite"
        ],
        "param": {
            "control": "privacy"
        }
    },

    "newsletter": {
        "url": "/:section/:file",
        "param": {
            "path": "{bundlesPath}/coreapi/views/emailing/src/:section/:file",
            "control":    "renderNewsletter",
            "section": ":section",
            "file": ":file"
        },
        "requirements": {
            "section": "(messages|newsletters)",
            "file":    "([-a-z0-9]+).html$"
        }
    }
  };

  test.equal( typeof(routingCase), 'object' );
  test.deepEqual(routingCase, res );

  test.done()
}

exports['requireJSON: settings.json case'] = function(test) {
  var res = {
    "server": {
      "engine": "isaac",
      "credentials": {
        "_comment": "Project ENV override: SSL Credentials: private key & certificate",
        "privateKey": "{projectPath}/ssl/server.key",
        "certificate": "{projectPath}/ssl/server.crt",
        "allowHTTP1": true
      }
    },
    "upload": {
      "_comment": "for more details, check out https://github.com/andrewrk/node-multiparty",
      "encoding": "utf8",
      "maxFieldsSize": "2MB",
      "maxFields": "1000"
    },
    "cache": {},
    "engine.io": {
      "port": 8888
    },
    "livereload": {},
    "locale": {
      "preferedLanguages": [ "en-US" ],
      "region": "EN",
      "firstDayOfWeek": 1,
      "calendar": "gregorian",
      "temperature": "celsius",
      "number": {
        "grouping": null,
        "decimal": "."
      },
      "currency": {
        "code": "usd",
        "grouping": null,
        "decimal": "."
      },
      "measurementUnits": "metric",
      "dateFormat": {
        "short": "mm/dd/yyyy",
        "medium": "mmm d, yyyy",
        "long": "mmmm d, yyyy",
        "full": "dddd, mmmm d, yyyy"
      },
      "24HourTimeFormat": true,
      "timeFormat": {
        "default": {
          "short": "h:MM:ss",
          "medium": "h:MM:ss",
          "long": "h:MM:ss TT"
        },
        "24H": {
          "short": "HH:MM",
          "medium": "HH:MM:ss",
          "long": "HH:MM:ss TT"
        }
      }
    }
  };

  test.equal( typeof(settingsCase), 'object' );
  test.deepEqual(settingsCase, res );

  test.done()
}

exports['requireJSON: statics.json case'] = function(test) {
    var res = {
      "html": "{templatesPath}/html",
      "sass": "{templatesPath}/sass",
      "handlers": "{handlersPath}",
      "js/vendor/gina": "{gina}/framework/v{version}/core//vendor/gina/js"
    };

    test.equal( typeof(staticsCase), 'object' );
    test.deepEqual(JSON.stringify(staticsCase), JSON.stringify(res));

    test.done()
}

exports['requireJSON: templates.json case'] = function(test) {
    var res = {
        "_common": {
          "layout": "{templatesPath}/html/layout.html",
          "noLayout": "{gina}/framework/v{version}/core/asset/html/nolayout.html",
          "templates": "{templatesPath}",
          "html": "{templatesPath}/html",
          "theme": "default_theme",
          "forms": "{templatesPath}/forms",
          "handlers": "{templatesPath}/handlers",
          "routeNameAsFilenameEnabled": true,
          "ginaEnabled": true,
          "http-metas": {
            "content-type": "text/html"
          },
          "stylesheets": [
            {
              "name"    : "gina",
              "media"   : "screen",
              "rel"     : "stylesheet",
              "type"    : "text/css",
              "url"     : "/js/vendor/gina/gina.min.css"
            }
          ],
          "javascriptsDeferEnabled": true,
          "javascripts": [
            {
              "name"    : "gina",
              "type"   : "text/javascript",
              "url"     : "/js/vendor/gina/gina.min.js"
            }
          ],
          "pluginLoader": "{src:{gina}/framework/v{version}/core/asset/plugin/dist/vendor/gina/js/gina.onload.min.js}"
        }
      };

    test.equal( typeof(templatesCase), 'object' );
    test.deepEqual(JSON.stringify(templatesCase), JSON.stringify(res));

    test.done()
}

// for debug purpose
if (reporter)
    reporter.run(['test/01-require_json.js']);