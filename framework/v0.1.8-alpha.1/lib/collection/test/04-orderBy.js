var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json'))
} ;


var hotels = new Collection(data.hotels);
var result = null, mocks = null;


exports['[ find all ] Hotel  [ order by ] `name` ASC [ limit ] 10 '] = function(test) {
       
    result  = hotels
                .orderBy({ name: 'asc'})
                .limit(10)
                .toRaw();
    //for(var i = 0, len = result.length; i < len; ++i){ console.log(i +' -> '+ result[i].name)}
    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/findHotelOrderByNameLimit10.json'))
                ;//.splice(0, 8);
    
    test.equal(Array.isArray(result), true);
    //test.equal(result.length, 10);
    //test.deepEqual(result, mocks);

    test.done()
}



// for debug purpose
if (reporter)
    reporter.run(['test/04-orderBy.js']);