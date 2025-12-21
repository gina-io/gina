var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json'))
} ;


var hotels = new Collection(data.hotels);
var result = null, mocks = null;


exports['[ findOne by filter ] Hotel WHERE country === `France`\nAND name === `Le Clos Fleuri`\n  [ limit ] 1 '] = function(test) {
       
    result  = hotels
                .findOne({ country: 'France', name: 'Le Clos Fleuri' });
    
    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/findOneHotelWhereCountryIsFranceAndNameIs_Le Clos Fleuri.json'));
        
    test.deepEqual(result, mocks);

    test.done()
}

exports['[ findOne by filter ignoring case ] Hotel WHERE country === `France`\nAND name == `le Clos Fleuri`\n  [ isCaseSensitive: false ] 1 '] = function(test) {
    
    var searchOptions = {
        name: {
            isCaseSensitive: false
        }
    };
    
    result  = hotels
                .setSearchOption('name', 'isCaseSensitive', false)
                .findOne({ country: 'France', name: 'le clos fleuri' });
    
    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/findOneHotelWhereCountryIsFranceAndNameIs_Le Clos Fleuri.json'));
    
    test.deepEqual(result, mocks);

    test.done()
}


// for debug purpose
if (reporter)
    reporter.run(['test/03-findOne.js']);