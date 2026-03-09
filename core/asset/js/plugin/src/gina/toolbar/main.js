define('gina/toolbar', [ 'require', 'jquery', 'vendor/uuid','utils/merge', 'utils/collection', 'gina/storage' ], function (require) {

    var $           = require('jquery');
    var merge       = require('utils/merge');
    var Collection  = require('utils/collection');
    var Storage     = require('gina/storage');

    function Toolbar() {

        //console.log('Toolbar jquery is ', $.fn.jquery);

        var self = {
            version         : '1.0.2',
            foldingPaths    : {},
            foldingClass    : null,
            isUnfolded      : null
        };

        var bucket      = new Storage({bucket: 'gina'}) // <Bucket>
            , plugins   = bucket.Collection('plugin'); // <Collection>

        var $toolbar             = null
            , settings           = null
            , isCollapsed        = false
            , $tabs              = null
            , $logo              = null
            , $panelsContainer   = null
            , $panels            = null
            , $currentPanel      = null
            , panelId            = ''
            , $verticalPos       = null
            , $horizontalPos     = null
            , $toolbarPos        = null
            , position           = ''
            , $toolbarWidth      = null
            , width              = 0
            , $toolbarHeight     = null
            , toolbarHeight      = 0
            , contentHeight      = 0
            , keynum             = ''
            , lastPressedKey     = {}
            , coockie            = null
            , $json              = null
            , $ginaJson          = null
            , $jsonRAW           = null
            , originalData       = null
            , jsonObject         = null
            , ginaJsonObject     = null
            , $htmlData          = null
            , $codeFoldingToggle = null
            , codeFolding        = true
            , timeoutId          = null
            , $copyCache         = null
            , copyValue          = null
            ;

        var init = function () {
            // Get elements
            $toolbar           = $('#gina-toolbar');
            $tabs              = $toolbar.find('.gina-toolbar-tab > a');
            $logo              = $('#gina-toolbar-toggle');
            $panelsContainer   = $('#gina-toolbar-panels');
            $panels            = $panelsContainer.find('.gina-toolbar-panel');
            $verticalPos       = $('#gina-toolbar-vposition');
            $horizontalPos     = $('#gina-toolbar-hposition');
            $toolbarPos        = $verticalPos.add($horizontalPos);
            $toolbarWidth      = $('#gina-toolbar-width');
            $toolbarHeight     = $toolbar.find('.gina-toolbar-main');
            $json              = $('#gina-toolbar-json');
            $ginaJson          = $('#gina-toolbar-gina-json');
            $jsonRAW           = $('#gina-toolbar-toggle-code-raw');
            $htmlData          = $('#gina-toolbar-data-html');
            $codeFoldingToggle = $('#gina-toolbar-code-toggle');

            // Append textarea for copy/paste then select it
            $toolbar.prepend('<textarea class="gina-toolbar-copy"></textarea>');
            $copyCache         = $toolbar.find('.gina-toolbar-copy');

            // Get toolbar settings
            settings = plugins.findOne({_name: 'toolbar'});

            if ( !settings ) {
                // default settings
                settings = {
                    _name           : 'toolbar',
                    _version        : self.version,
                    _description    : 'Toolbar settings',
                    _licence        : 'MIT',
                    _author         : [
                        {name: 'Fabrice Delaneau', company: 'Freelancer'},
                        {name: 'Martin-Luther Etouman', company: 'Rhinostone'}
                    ],
                    position        : 'top-right',
                    width           : '30',
                    panelId         : '#gina-toolbar-data',
                    isCollapsed     : true,
                    isUnfolded      : []
                };
                // saving default settings
                plugins.insert(settings);

            }

            // in case of local storage schema update;
            if (settings._version != self.version) {
                checkSchemaUpdate();
            }

            position    = settings.position;
            width       = settings.width;
            panelId     = settings.panelId;
            isCollapsed = settings.isCollapsed;

            $toolbar.removeClass('gina-toolbar-hidden');
            handle() // Bind behaviors
        };


        var checkSchemaUpdate = function () {
            // Run every update from your current version up to the head

            if (settings._version < '1.0.1') {
                if (!settings.isUnfolded ) {
                    settings.isUnfolded = [];
                }
                if (settings.codeFolding != undefined) {
                    delete settings.codeFolding;
                }
            }

            if ( typeof(settings.isUnfolded) != 'undefined' && !Array.isArray(settings.isUnfolded) ) {
                settings.isUnfolded = [];
            }

            // update version number
            settings._version = self.version;

            // save all changes
            settings.save(true);
        }

        /**
         * loadData
         *
         * @param {object} [section]
         * @param {object} [data]
         * @param {object} [ginaData]
         *
         * */
        var loadData = function (section, data, ginaData) {

            try {
                var txt = $json.text();
                if (txt == '' || txt == 'null' ) {
                    $json.text('Empty')
                } else {
                    jsonObject = JSON.parse(txt);
                    ginaJsonObject = JSON.parse($ginaJson.text());
                    $json.text('');

                    // backing up document data
                    if (!originalData) {
                        originalData = {
                            jsonObject      : JSON.parse(JSON.stringify(jsonObject)),
                            ginaJsonObject  : JSON.parse(JSON.stringify(ginaJsonObject))
                        }
                    }
                }

            } catch (err) {
                $json.text('Could not load data');
            }

            if (jsonObject) {

                if (data && !ginaData) {
                    if ( !jsonObject[section] )
                        jsonObject[section] = {};

                    jsonObject[section] = ginaJsonObject[section] = data;

                } else if ( section == 'data-xhr' && !data && jsonObject['data-xhr'] ) {
                    // reset xhr
                    delete jsonObject['data-xhr'];
                } else if (ginaData) {
                    jsonObject      = data;
                    ginaJsonObject  = ginaData;
                }

                // Make folding paths
                makeFoldingPaths(jsonObject, '');
                // Create DOM from JSON
                $htmlData.html('<ul class="gina-toolbar-code">' + parseObject(jsonObject, ginaJsonObject) +'</ul>');

                // Manage folding state
                settings.currentFile = jsonObject.file;
                if (!settings.currentFile) {
                    // Init currentFile if none exists
                    settings.currentFile = jsonObject.file;
                } else if (jsonObject.file == settings.currentFile) {
                    // If current page is the same as the previous page, unfold code as neede
                    $(document).ready(function () {
                        if ( settings.isUnfolded.length > 0)
                            initFoldingState(settings.isUnfolded, settings.isUnfolded.length, 0);
                    })
                }
            }
        }
        
        var initFoldingState = function (unfolded, len, i) {

            if (i == len) return false;

            var key = unfolded[i];

            if ( unfolded.indexOf(key) > -1 ) {

                toggleCodeFolding( $('.gina-toolbar-folding-state-'+ key), function onCodeToggled() {
                    i += 1;
                    initFoldingState(unfolded, len, i)
                });

            } else {
                i += 1;
                initFoldingState(unfolded, len, i)
            }
        }

        var handle = function () {


            // Add folding behavior
            $htmlData.off('click', 'a').on('click', 'a', function(event) {
                event.preventDefault();

                toggleCodeFolding($(this))
            });

            // Expand/collapse all code
            $codeFoldingToggle.off('click').on('click', function(event) {
                event.preventDefault();

                toggleCodeFolding('all')
            });

            // Add value to the clipboard
            $htmlData.off('click', '.gina-toolbar-value').on('click', '.gina-toolbar-value', function(event) {
                event.preventDefault();
                try {
                    copyValue = $(this).text();
                    $copyCache.text(copyValue);
                    $copyCache.select();
                    document.execCommand('copy', false, null);
                    $copyCache.blur();
                } catch(err) {
                    alert('Please press Ctrl/Cmd+C to copy the value');
                    // throw err;
                }

            });

            // display RAW
            $jsonRAW.off('click').on('click', function(event){
                if (jsonObject) {
                    var jsonOut = window.open("", "JSON RAW", "width=400,height=100");
                    //jsonOut.document.write( '<pre>' + JSON.stringify(jsonObject, null, 2) + '</pre>' );
                    jsonOut.document.write( JSON.stringify(jsonObject) );
                }
            });

            // Tabs
            $tabs.off('click').on('click', function(event) {
                event.preventDefault();

                // Hide all panels
                $tabs.removeClass('gina-toolbar-active');
                $panels.removeClass('gina-toolbar-active');

                // Show selected tab
                $(this).addClass('gina-toolbar-active');

                // Show selected panel
                panelId = $(this).attr('href');
                $currentPanel = $(panelId).addClass('gina-toolbar-active');

                // Save current active tab to coockie
                settings.panelId = panelId;
                settings.save()
            });

            // Show/hide Toolbar
            $logo.off('click').on('click', function(event) {
                event.preventDefault();

                $toolbar.toggleClass('gina-toolbar-collapsed');

                // Save current visibility state to coockie
                isCollapsed = $toolbar.hasClass('gina-toolbar-collapsed')
                settings.isCollapsed = isCollapsed;
                settings.save()
            });

            // Toolbar position
            $toolbarPos.off('change').on('change', function(event) {
                event.preventDefault();

                // Get selected option value
                var vposition = $verticalPos.val();
                var hposition = $horizontalPos.val();
                position = vposition + '-' + hposition
                changeToolbarPosition(position);

                // Save new position to coockie
                settings.position = position;
                settings.save()
            });

            // Toolbar width
            $toolbarWidth.off('change').on('change', function(event) {
                event.preventDefault();

                // Get selected option value
                width = $toolbarWidth.val();
                changeToolbarWidth(width);

                // Save new width to coockie
                settings.width = width;
                settings.save()
            });

            // Toolbar height
            $(window).off('resize').on('resize', function() {
                changeToolbarHeight();
            });

            // Show/hide toolbar using gg shorcut
            $('body').off('keypress').on('keypress', function(event) {
                // console.log('event', event);
                if(event.keyCode) {
                    // IE
                    keynum = event.keyCode;
                } else if(event.which) {
                    // Netscape/Firefox/Opera
                    keynum = event.which;
                } else {
                    // Chrome/Safari
                    keynum = event.charCode;
                }
                var now = new Date();
                if (
                    typeof lastPressedKey.keynum != "undefined"
                    && lastPressedKey.keynum == keynum
                    && typeof lastPressedKey.pressTime != "undefined"
                    && now.getTime() - lastPressedKey.pressTime < 500
                ) {
                    switch (keynum) {
                        case 103: //This is the "g" key
                            $toolbar.toggle();
                            // variousTools.setCookie("gina-toolbar[hub]", params.display.hub, 365);
                            break;
                    }
                }
                lastPressedKey.pressTime = now.getTime();
                lastPressedKey.keynum = keynum;
            });


            // Updates Toolbar with current values

            // Select the current tab
            $tabs.filter('[href="' + panelId +'"]').trigger('click');

            // Open toolbar if needed
            if (!isCollapsed) {
                $('#gina-toolbar-toggle').trigger('click');
            }

            // Change Toolbar Position and init selects
            changeToolbarPosition(position);

            var positions = position.split('-');
            $verticalPos.val(positions[0]);
            $horizontalPos.val(positions[1]);

            // Change Toolbar Width and init select
            changeToolbarWidth(width);

            $toolbarWidth.val(width);

            // Change Toolbar max-Height;
            changeToolbarHeight();

            // Parse JSON
            var txt = $json.text();
            // dev only - allows HTML 5 mock
            if ( /^\{\{ (.*) \}\}/.test(txt) ) {
                // loading mock
                //var url = document.location.protocol + '//' + document.location.pathname.replace('index.html', '');
                //url + 'mock.json';
                loadJSON(txt, loadData); //parse

            } else {
                loadData()
            }
        }


        var changeToolbarPosition = function (position) {
            $toolbar
                .removeClass('gina-toolbar-top-left gina-toolbar-top-right gina-toolbar-bottom-left gina-toolbar-bottom-right')
                .addClass('gina-toolbar-'+ position);
        }

        var changeToolbarWidth = function (width) {
            $toolbar
                .removeClass('gina-toolbar-auto gina-toolbar-100 gina-toolbar-80 gina-toolbar-60 gina-toolbar-50 gina-toolbar-40 gina-toolbar-30')
                .addClass('gina-toolbar-'+ width);
        }

        var changeToolbarHeight = function () {
            // Use window height - 32px for the header
            toolbarHeight = window.innerHeight - 32;
            $toolbar
                .find('.gina-toolbar-main')
                .css('max-height', toolbarHeight +'px');

            checkContentHeight()
        }

        var checkContentHeight = function () {
            // check toolbar content against window height
            var $currentMain = $currentPanel.find('.gina-toolbar-main');
            var $currentContent = $currentMain.find('.gina-toolbar-content');
            contentHeight = $currentMain.height();
            if (contentHeight == toolbarHeight) {
                $currentContent.addClass('gina-toolbar-content-end')
            } else {
                $currentContent.removeClass('gina-toolbar-content-end')
            }
        }

        var toggleCodeFolding = function ($el, cb) {

            if ($el != undefined && $el.length && $el != 'all') {

                $el.next('ul').slideToggle('fast');
                $el.toggleClass('gina-toolbar-unfolded');

                // Check container height after animation
                // if (timeoutId != null) {
                //     window.clearTimeout(timeoutId)
                // }
                // timeoutId = window.setTimeout(checkContentHeight, 300);

                // Save element folding state
                self.foldingClass = $el.attr('class');
                self.foldingClass = self.foldingClass.match(/gina-toolbar-folding-state-([-a-z]+)/)[1]

                if ($el.hasClass('gina-toolbar-unfolded')) {
                    if ( settings.isUnfolded.indexOf(self.foldingClass) < 0 )
                        settings.isUnfolded.push(self.foldingClass);

                    //settings.isUnfolded[self.foldingClass] = true;
                    settings.save()
                } else {
                    //delete settings.isUnfolded[self.foldingClass];
                    if ( settings.isUnfolded.indexOf(self.foldingClass) > -1 )
                        settings.isUnfolded.splice( settings.isUnfolded.indexOf(self.foldingClass) );

                    settings.save(true)
                }

                if ( typeof(cb) != 'undefined' )
                    cb()
            }
        }

        var orderKeys = function(obj) {

            var newObj  = {}
                , k     = null
                , keys  = []
                , i     = 0
                , len   = null
                ;

            for (k in obj) {
                if ( obj.hasOwnProperty(k) ){
                    keys[i] = k;
                    ++i
                }
            }

            len = keys.length;
            keys.sort();

            for (i = 0; i < len; ++i) {
                k = keys[i];
                newObj[k] = obj[k];
            }

            return newObj
        }

        var parseObject = function(obj, ginaObj, id) {
            var html = '';
            var id = id || '';
            var count = '';
            var objType = '';

            obj     = orderKeys(obj);
            ginaObj = orderKeys(ginaObj);

            for (var i in obj) {
                //console.log('i', i);
                if ( typeof(obj[i]) == 'object' && !Array.isArray(obj[i]) && obj[i] !== null ) { // parse
                    id += i + '-';
                    html += '<li class="gina-toolbar-object">';
                    html +=  '<a href="#" class="gina-toolbar-key gina-toolbar-folding-state-'+ id.substr(0, id.length - 1) +'">'+ i +' <span>{ }</span></a>';
                    html +=  '<ul class="gina-toolbar-object">'+ parseObject(obj[i], ginaObj[i], id) +'</ul>';
                    html += '</li>';
                    // clear one level
                    id = id.substr(0, id.length - i.length - 1);
                } else if ( Array.isArray(obj[i]) ) {
                    id += i + '-';
                    html += '<li class="gina-toolbar-collection">';
                    html +=  '<a href="#" class="gina-toolbar-key gina-toolbar-folding-state-'+ id.substr(0, id.length - 1) +'">'+ i +' <span>['+ obj[i].length +']</span></a>';
                    html +=  '<ul class="gina-toolbar-collection">'+ parseCollection(obj[i], ginaObj[i], id)  +'</ul>';
                    html += '</li>';
                    // clear one level
                    id = id.substr(0, id.length - i.length - 1);
                } else {
                    objType = (ginaObj[i] === null) ? 'null' : typeof(ginaObj[i]);
                    if ( objType == 'undefined' ) { // new key  declaration added by user
                        html += '<li class="gina-toolbar-key-value">';
                        html +=     '<span class="gina-toolbar-key gina-toolbar-key-added">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span>';
                        html += '</li>';
                    } else {

                        if (/^_comment/.test(i) ) continue;

                        if (obj[i] !== ginaObj[i] ) {
                            html += '<li class="gina-toolbar-key-value gina-toolbar-is-overridden">';
                            html +=     '<span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value">'+ ginaObj[i] +'</span>';
                            html += '</li>';

                            html += '<li class="gina-toolbar-key-value">';
                            html +=     '<span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span>';
                            html += '</li>';
                        } else {
                            html += '<li class="gina-toolbar-key-value">';
                            html +=     '<span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span>';
                            html += '</li>';
                        }
                    }
                }
            }
            return html
        }

        var parseCollection = function (arr, ginaArr, id) {
            var html = '';
            var id = id || '';
            for (var i = 0, len = arr.length; i<len; ++i) {
                if ( typeof(arr[i]) == 'object' && !Array.isArray(arr[i]) ) {
                    id   += i + '-';
                    html += '<li class="gina-toolbar-object">';
                    html +=   '<a href="#" class="gina-toolbar-key gina-toolbar-folding-state-'+ id.substr(0, id.length - 1) +'">'+ i +' <span>{ }</span></a>';
                    html +=   '<ul class="gina-toolbar-object">' + parseObject(arr[i], ginaArr[i], id) +'</ul>';
                    html += '</li>';
                    // clear one level
                    id = id.substr(0, id.length - i.toString().length - 1);

                } else if ( Array.isArray(arr[i]) ) {
                    id   += i + '-';
                    html += '<li class="gina-toolbar-collection">';
                    html +=   '<a href="#" class="gina-toolbar-key gina-toolbar-folding-state-'+ id.substr(0, id.length - 1) +'"">'+ i +'<span>[ ]</span></a>';
                    html +=   '<ul class="gina-toolbar-collection">' + parseCollection(arr[i], ginaArr[i], id)  +'</ul>';
                    html += '</li>';
                    // clear one level
                    id = id.substr(0, id.length - i.toString().length - 1);
                } else {
                    html += '<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value">'+ arr[i] +'</span></li>';
                }
            }
            return html
        }

        var createInputFile = function(id, label) {
            var html = '';
            html  = '<label class="gina-toolbar-input-file">',
                html += '<input type="file" multiple id="' + id +'">'
            html += label
            html += '</label>'
            return html
        }

        var loadJSON = function(txt, cb) {

            var html = createInputFile('mock', 'Select your JSON file');
            $htmlData.html(html);
            $json.text('');

            $htmlData.find('input').off('change').on('change', function(e) {

                var files   = $(this)[0].files;
                var file    = null;


                if (files.length == 1) {
                    file        = $(this)[0].files[0]; // jQuery way
                    var reader  = new FileReader();
                    reader.addEventListener('load', function(){
                        // user
                        $json.text(reader.result);
                        // gina <- being duplicated to prevent bugs
                        $ginaJson.text(reader.result);
                        cb();
                    }, false);

                    reader.readAsBinaryString(file)
                } else {
                    var done = 0;
                    var complete = function (done) {

                        if (done == files.length) {
                            cb()
                        }
                    };
                    var reader  = [];

                    for (var i = 0, len = files.length; i < len; ++i) {
                        file = files[i];
                        switch (true) {
                            case /user/.test(file.name):

                                reader[i]  = new FileReader();
                                reader[i].addEventListener('load', function(e){

                                    // user
                                    $json.text(e.currentTarget.result);
                                    ++done;
                                    complete(done)
                                }, false);

                                reader[i].readAsBinaryString(file);

                                break;

                            case /gina/.test(file.name):
                                //console.log(file);
                                reader[i]  = new FileReader();
                                reader[i].addEventListener('load', function(e){
                                    // gina
                                    $ginaJson.text(e.currentTarget.result);
                                    ++done;
                                    complete(done)
                                }, false);

                                reader[i].readAsBinaryString(file);

                                break;
                        }
                    }
                }

            });

            return false;
        }

        var makeFoldingPaths = function(obj, tmp) {
            for (var r in obj) {
                if ( typeof(obj[r]) == 'object' ) {
                    self.foldingPaths[tmp + r] = tmp + r;
                    makeFoldingPaths(obj[r], tmp + r+'-');
                }
            }
        }

        this.update = function (section, data) {
            loadData(section, data);
        }

        this.restore = function () {
            loadData('data', originalData.jsonObject, originalData.ginaJsonObject);
        }

        init();
    };

    return Toolbar
})