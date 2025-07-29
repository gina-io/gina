var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var helpers     = require('../../../helpers');// Not needed if the framework installed
var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json'))
} ;


var hotels = new Collection(data.hotels);
var result = null, mocks = null;


exports['[ delete ] Hotel  [ where ] `country` = `France` '] = function(test) {
     
    //for(var i = 0, len = result.length; i < len; ++i){ console.log(i +' -> '+ result[i].name)}
   
    mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/find/findHotelOrderByNameLimit10.json');
    //mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/find/findHotelOrderByNameLimit10_heterogeneous.json');
     
    result  = new Collection(mocks)
                //.delete({ country: 'France'})
                .delete({ vacancy: true })
                .toRaw();
        
    test.equal(Array.isArray(result), true);    
    //test.equal(result.length, 7); // country
    test.equal(result.length, 4); // vacancy
    //test.deepEqual(result, mocks);

    test.done()
}



// for debug purpose
if (reporter)
    reporter.run(['test/05-delete.js']);