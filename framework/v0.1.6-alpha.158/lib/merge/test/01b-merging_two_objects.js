var merge = require('../src/main');// Not needed if the framework installed

var a = null;
var b = null;
var amounts = null;
var defaultAmounts = null;
var setVariable = function () {

    a = {
        "page":{
            "view":{
                "params":{
                    "section":"urssaf"
                }
            }
        },
        "form" :{
            "rule": {
                "testField" :{
                    "isString": [25]
                }
            }
        }
    };

    b = {
        "page": {
            "view": {
                "file": "factsheets"
            }
        },
        "form" :{
            "rule": {
                "testField" :{
                    "isString": [25, 25]
                }
            }
        }
    };
    
    amounts = {
        "gross": 775,
        "deposit": 0,
        "depositValue": 0,
        "depositType": "rate",
        "discountValue": 0,
        "discountType": "rate",
        "rebateValue": 0,
        "rebateType": "rate",
        "net": 775,
        "vat": [
            {
                "20": 155
            }
        ],
        "grandTotal": 930,
        "artistCreationValue": 0,
        "discount": 0,
        "rebate": 0,
        "freelanceTotal": 930,
        "organismTotal": 0
    };
    
    defaultAmounts =  {
        "gross": 0,
        "deposit": 0,
        "depositValue": 0,
        "depositType": "rate",
        "discountValue": 0,
        "discountType": "rate",
        "rebateValue": 0,
        "rebateType": "rate",
        "net": 0,
        "vat": [],
        "grandTotal": 0
    };
    
};

setVariable();
var AtoBwithoutOverride = merge(a, b);
var DefaultAmountsToAmountsWithoutOverride = merge(amounts, defaultAmounts);
// setVariable();
// var AtoBwithOverride    = merge(a, b, true);

exports['Merge : A<-B without override'] = function(test) {
    var res = {
        "page":{
            "view":{
                "params":{
                    "section":"urssaf"
                },
                "file": "factsheets"
            }
        },
        "form" :{
            "rule": {
                "testField" :{
                    "isString": [25, 25]
                }
            }
        }
    };
    test.equal( typeof(AtoBwithoutOverride), 'object' );
    test.deepEqual(AtoBwithoutOverride, res);

    test.done()
}

exports['Merge : amounts<-defaultAmounts without override'] = function(test) {
    var res = {
        "gross": 775,
        "deposit": 0,
        "depositValue": 0,
        "depositType": "rate",
        "discountValue": 0,
        "discountType": "rate",
        "rebateValue": 0,
        "rebateType": "rate",
        "net": 775,
        "vat": [
            {
                "20": 155
            }
        ],
        "grandTotal": 930,
        "artistCreationValue": 0,
        "discount": 0,
        "rebate": 0,
        "freelanceTotal": 930,
        "organismTotal": 0
    };
    test.equal( typeof(DefaultAmountsToAmountsWithoutOverride), 'object' );
    test.deepEqual(DefaultAmountsToAmountsWithoutOverride, res);

    test.done()
}

// exports['Merge : A<-B with override'] = function(test) {
//     var res = {
//         "page":{
//             "view": {
//                 "file": "factsheets"
//             }
//         }
//     };
//     test.equal( typeof(AtoBwithOverride), 'object' );
//     test.deepEqual(AtoBwithOverride, res);
//
//     test.done()
// }
