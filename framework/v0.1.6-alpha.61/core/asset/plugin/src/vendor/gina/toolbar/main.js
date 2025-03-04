define('gina/toolbar', ['require', 'jquery', 'vendor/uuid'/**, 'lib/merge'*/, 'lib/collection', 'lib/routing', 'gina/storage', 'gina/validator' ], function (require) {

    var $           = require('jquery');

    $.noConflict();
    //var merge       = require('lib/merge');
    var routing     = require('lib/routing');
    var Collection  = require('lib/collection');
    var Storage     = require('gina/storage');
    //var Validator   = require('gina/validator');

    /**
     * Toolbar plugin
     *
     * TODO - search using `datatables` plugin (https://stackoverflow.com/questions/10400033/is-there-a-jquery-plugin-like-datatables-for-a-ul)
     */
    function Toolbar() {

        //console.debug('Toolbar jquery is ', $.fn.jquery);

        var self = {
            version         : '1.0.3',
            foldingPaths    : {},
            foldingClass    : null,
            isUnfolded      : null,
            isXHR           : false,
            isValidator     : false,
            hasParsedUrls   : false
        };

        var bucket      = new Storage({bucket: 'gina'}) // <Bucket>
            , plugins   = bucket.Collection('plugin') // <Collection>
            //, validator = new Validator() // <Validator>
        ;

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
            , lastJsonObjectState = null
            , ginaJsonObject     = null
            , forms              = null
            , formsIgnored       = '.gina-toolbar-options, .gina-toolbar-content'
            , $htmlConfigurationEnvironment = null
            , $htmlData          = null
            , $htmlView          = null
            , $htmlForms         = null
            , $codeFoldingToggle = null
            , codeFolding        = true
            , timeoutId          = null
            , $copyCache         = null
            , copyValue          = null
        ;

        var init = function () {
            // Get elements
            $toolbar           = $('#gina-toolbar');
            if (!$toolbar.length) return false;

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
            $forms             = $('form:not('+ formsIgnored +')');
            $htmlData          = $('#gina-toolbar-data-html');
            $htmlView          = $('#gina-toolbar-view-html');
            $htmlForms         = $('#gina-toolbar-forms-html');
            $htmlConfigurationEnvironment = $('#gina-toolbar-configuration-environment-html')
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
                    isUnfolded      : [],
                    debug           : {
                        forms   : {
                            active: false,
                            strategy: 'frontend' // by default
                        }
                    }
                };
                // saving default settings
                plugins.insert(settings);
                settings = plugins.findOne({_name: 'toolbar'});

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

            var $currentForms = null, txt = null;
            try {

                txt = ($json) ? $json.text() : '';
                if (txt == '' || txt == 'null' ) {
                    // $json.text('Empty')
                    $json.text('{}')
                } else {
                    jsonObject = JSON.parse( txt );
                    ginaJsonObject = JSON.parse($ginaJson.text());

                    $json.text('');

                    // backing up document data for restore action
                    if (!originalData) {
                        originalData = {
                            jsonObject      : JSON.clone(jsonObject),
                            ginaJsonObject  : JSON.clone( ginaJsonObject)
                        };
                        lastJsonObjectState = {}; // jsonObject.data
                    }
                }

            } catch (err) {

                var sectionStr = ( section ) ? ' [ '+ section + ' ] ' : ' ';
                // var _err = 'Could not load'+ sectionStr +'json\n' + (err.stack||err.message||err);
                var _err = 'Could not load'+ sectionStr +'json\n' + err.message +'\n'+ err.stack;
                console.error(_err);
                // if ($json) {
                //     $json.text(_err);
                // } else {
                //     throw _err;
                // }
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
                // -> Configuration::environment
                // filtering before
                if (ginaJsonObject.environment) {
                    delete ginaJsonObject.environment.routing;
                    delete ginaJsonObject.environment.reverseRouting;
                    delete ginaJsonObject.environment.forms;
                }

                if (jsonObject.environment) {
                    delete jsonObject.environment.routing;
                    delete jsonObject.environment.reverseRouting;
                    delete jsonObject.environment.forms;
                }
                // if (
                //     typeof(ginaJsonObject.environment) != 'undefined'
                //     && typeof(jsonObject.environment) != 'undefined'
                // ) {
                    $htmlConfigurationEnvironment.html(parseObject(jsonObject.environment, ginaJsonObject.environment));
                // }


                var userObject   = { data: jsonObject.data, view: jsonObject.view, forms: jsonObject.forms }
                    , ginaObject  = { data: ginaJsonObject.data, view: ginaJsonObject.view, forms: ginaJsonObject.forms } ;


                // xhr mode
                self.initiatedXhrFoldingState = false;
                // validator mode
                self.isValidator = false;

                var isXHR = null, isXHRViewData = false;

                if ( /^(view-xhr)$/.test(section) ) {

                    isXHR = true;

                    userObject.view = jsonObject[section];
                    ginaObject.view = ginaJsonObject[section];

                    userObject.data = jsonObject['data-xhr'];
                    ginaObject.data = ginaJsonObject['data-xhr'];
                }

                if ( !section || /^(data)$/.test(section) ) {


                    // -> Data
                    $htmlData.html('<ul class="gina-toolbar-code">' + parseObject(userObject.data, ginaObject.data, null, isXHR) +'</ul>');

                    // -> View
                    // init view
                    var htmlProp =  '<div id="gina-toolbar-view-html-properties" class="gina-toolbar-section">\n' +
                                    '    <h2 class="gina-toolbar-section-title">properties</h2>\n' +
                                    '    <ul class="gina-toolbar-properties"></ul>\n' +
                                    '</div>';

                    $htmlView.html(htmlProp);

                    $htmlView.html( parseView(userObject.view, ginaObject.view, null, isXHR, $htmlView) );

                    // -> Forms
                    $currentForms = $forms;
                    $htmlForms.html('');
                    $htmlForms.html( parseForms(userObject.forms, ginaObject.forms, $htmlForms, 0, $currentForms, $currentForms.length, isXHR) );
                    // Form binding
                    $htmlForms.find('div.gina-toolbar-section > h2').off('click').on('click', function(event) {
                        event.preventDefault();

                        $(this)
                            .parent()
                            .find('ul').first()
                            .slideToggle();
                    });

                    //$htmlForms.html( parseView(jsonObject.forms, ginaJsonObject.forms, null, $htmlForms) );
                } //else
                if ( /^(data-xhr|view-xhr)$/.test(section) ) {

                    // reset case
                    if ( typeof(jsonObject[section]) == 'undefined' || !jsonObject[section] || jsonObject[section] == 'null' ) {
                        return false;
                    }

                    // -> XHR Data
                    isXHR = true;
                    isXHRViewData = (typeof (jsonObject[section].isXHRViewData) != 'undefined') ? true : isXHRViewData;


                    // update data section without erasing old data
                    if (!isXHRViewData && !/^(view-xhr)$/.test(section)) {

                        // also update original data to handle restore action
                        if ( typeof (jsonObject['el-xhr']) != 'undefined' ) {
                            lastJsonObjectState.data = JSON.clone(jsonObject[section]);
                        }
                    }

                    // -> isXHRViewData (from popin) : cleanup
                    if (isXHRViewData) {
                        delete jsonObject[section].isXHRViewData;
                    }

                    if ( /^(data-xhr)$/.test(section) ) {
                        $htmlData.html('<ul class="gina-toolbar-code">' + parseObject(jsonObject[section], ginaJsonObject[section], null, isXHR) +'</ul>');
                    } else if ( /^(view-xhr)$/.test(section) ) {
                        //$htmlView.html( parseView(userObject.view, ginaObject.view, null, isXHR, $htmlView) );
                        // -> View
                        // init view
                        var htmlProp =  '<div id="gina-toolbar-view-html-properties" class="gina-toolbar-section">\n' +
                                        '    <h2 class="gina-toolbar-section-title">properties</h2>\n' +
                                        '    <ul class="gina-toolbar-properties"></ul>\n' +
                                        '</div>';

                        $htmlView.html(htmlProp);
                        $htmlView.html( parseView(jsonObject[section], ginaJsonObject[section], null, isXHR, $htmlView) );
                    }

                } //else
                if ( /^(el-xhr)$/.test(section) ) {
                    // -> XHR Forms
                    isXHR = true;
                    $currentForms = $('#' + data).find('form:not(' + formsIgnored + ')');
                    $htmlForms.html('');
                    $htmlForms.html( parseForms(userObject.forms, ginaObject.forms, $htmlForms, 0, $currentForms, $currentForms.length, isXHR ) );
                    // Form binding
                    $htmlForms.find('div.gina-toolbar-section > h2').off('click').on('click', function(event) {
                        event.preventDefault();

                        $(this)
                            .parent()
                            .find('ul').first()
                            .slideToggle();
                    });
                } //else
                if ( /^(forms)$/.test(section) ) {
                    isXHR = true;
                    self.isValidator = true;

                    var $form = $('#gina-toolbar-form-' + data.id);
                    // for live changes (eg.: on `Validator::getFormById()` call)
                    if ( !$form.length ) {
                        // crearte toolbar entry for the new form
                        $currentForms = $forms;
                        $htmlForms.html('');
                        $htmlForms.html( parseForms(userObject.forms, ginaObject.forms, $htmlForms, 0, $currentForms, $currentForms.length, isXHR) );
                        // Form binding
                        $htmlForms.find('div.gina-toolbar-section > h2').off('click').on('click', function(event) {
                            event.preventDefault();

                            $(this)
                                .parent()
                                .find('ul').first()
                                .slideToggle();
                        });
                    }

                    // form data sent
                    if ( typeof(data.rules) != 'undefined' ) {
                        updateForm(data.id, 'rules', data.rules, isXHR)
                    }

                    // form errors
                    if ( typeof(data.errors) != 'undefined' && data.errors.count() > 0 ) {
                        updateForm(data.id, 'errors', data.errors, isXHR)
                    }

                    // form data sent
                    if ( typeof(data.sent) != 'undefined' ) {
                        updateForm(data.id, 'sent', data.sent, isXHR)
                    }
                }


                // Manage folding state
                settings.currentFile = jsonObject.file;
                if (!settings.currentFile) {
                    // Init currentFile if none exists
                    settings.currentFile = jsonObject.file;
                }

                if (jsonObject.file == settings.currentFile) {
                    // If current page is the same as the previous page, unfold code as neede
                    $(document).ready(function () {

                        if (self.isValidator ) {
                            self.isXHR = true;
                            if (settings.isUnfolded.length > 0 && !self.initiatedXhrFoldingState) {
                                self.initiatedXhrFoldingState = true;
                                setTimeout(function () {
                                    if (settings.isUnfolded.length > 0)
                                        initFoldingState(settings.isUnfolded, settings.isUnfolded.length, 0);
                                }, 200)
                            }
                        } else {
                            if (!isXHR) {
                                self.isXHR = false;
                                setTimeout(function () {
                                    if (settings.isUnfolded.length > 0)
                                        initFoldingState(settings.isUnfolded, settings.isUnfolded.length, 0);
                                }, 200)
                            } else {
                                self.isXHR = true;
                                if (settings.isUnfolded.length > 0 && !self.initiatedXhrFoldingState) {
                                    self.initiatedXhrFoldingState = true;
                                    initFoldingState(settings.isUnfolded, settings.isUnfolded.length, 0);
                                }
                            }
                        }
                    })
                }
            }

            if ( !section || section == 'el-xhr' && !self.hasParsedUrls) {
                self.hasParsedUrls = (section && section == 'el-xhr' ) ? true : false;
                parseUrls(section);
            }
        }


        var initFoldingState = function (unfolded, len, i) {

            if (i == len) return false;

            var key = unfolded[i];
            var $kel = null;

            if ( self.isXHR && /^xhr-/.test(key) ) {
                key = key.replace(/^xhr-/, '');
                $kel = $('.gina-toolbar-xhr-folding-state-'+ key);
            } else {
                $kel = $('.gina-toolbar-folding-state-' + key);
            }

            toggleCodeFolding( $kel, function onCodeToggled() {
                i = i + 1;
                initFoldingState(unfolded, len, i)
            });
        }

        var handle = function () {


            // Add folding behavior
            $htmlData
                .add($htmlView).off('click', 'a').on('click', 'a', function(event) {
                    event.preventDefault();

                    toggleCodeFolding( $(this), null, true )
                })
                .add($htmlForms).off('click', 'a').on('click', 'a', function(event) {
                    event.preventDefault();

                    toggleCodeFolding( $(this), null, true )
                });

            $htmlConfigurationEnvironment
                .add($htmlView).off('click', 'a').on('click', 'a', function(event) {
                    event.preventDefault();

                    toggleCodeFolding( $(this), null, true )
                })
                .add($htmlForms).off('click', 'a').on('click', 'a', function(event) {
                    event.preventDefault();

                    toggleCodeFolding( $(this), null, true )
                });

            // Expand/collapse all code
            $codeFoldingToggle.off('click').on('click', function(event) {
                event.preventDefault();

                toggleCodeFolding('all', null, true)
            });

            // Add value to the clipboard
            $htmlData.add($htmlView, $htmlForms).off('click', '.gina-toolbar-value').on('click', '.gina-toolbar-value', function(event) {
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
                    jsonOut.document.write( JSON.stringify(jsonObject.data) );
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
            $('body').off('keypress').on('keypress', function onKeypressed(event){

                if (!/INPUT|TEXTAREA/.test(event.target.tagName )) {
                    if (event.keyCode) {
                        // IE
                        keynum = event.keyCode;
                    } else if (event.which) {
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
                }

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
            var txt = ($json) ? $json.text() : '';
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

        var toggleCodeFolding = function ($el, cb, toggledByClick) {

            if ( typeof(toggledByClick) == 'undefined' ) {
                var toggledByClick = false
            }

            if ($el != undefined && $el.length && $el != 'all') {

                // Save element folding state
                self.foldingClass = $el.attr('class');
                var hasXhrFlag = false;

                if ( /(gina-toolbar-folding-state-[a-z 0-9_-]+|gina-toolbar-xhr-folding-state-[a-z 0-9_-]+)/i.test(self.foldingClass) ) {

                    if ( /gina-toolbar-folding-state-[a-z0-9_-]+/i.test(self.foldingClass) ) {
                        self.foldingClass = self.foldingClass.match(/gina-toolbar-folding-state-[a-z0-9_-]+/i)[0].replace(/gina-toolbar-folding-state-/, '');
                    } else {
                        hasXhrFlag = true;
                        if ( typeof(self.foldingClass) != 'undefined' )
                            self.foldingClass = self.foldingClass.match(/gina-toolbar-xhr-folding-state-[a-z0-9_-]+/i)[0].replace(/gina-toolbar-xhr-folding-state-/, 'xhr-');
                    }

                    if ( settings.isUnfolded.indexOf(self.foldingClass) < 0 ) {

                        settings.isUnfolded.push(self.foldingClass);
                        settings.save();

                        if (!$el.hasClass('gina-toolbar-unfolded')) {
                            $el.addClass('gina-toolbar-unfolded');
                            $el.next('ul').slideToggle('fast');
                        }

                    } else {

                        if ( settings.isUnfolded.indexOf(self.foldingClass) > -1 && $el.hasClass('gina-toolbar-unfolded') ) {

                            // remove reference & sub-references
                            var re = new RegExp('^('+ self.foldingClass +')');
                            for (var i = 0, len = settings.isUnfolded.length; i < len; ++i) {
                                if ( re.test(settings.isUnfolded[i]) ) {
                                    if (!self.isValidator && toggledByClick || self.isValidator && hasXhrFlag || toggledByClick ) {
                                        settings.isUnfolded.splice(i, 1);
                                        --i
                                    }
                                }
                            }

                            settings.save(true);

                            if ( settings.isUnfolded.indexOf(self.foldingClass) < 0 ) {
                                $el.removeClass('gina-toolbar-unfolded');
                                $el.next('ul').slideToggle('fast');
                            }


                        } else {
                            $el.addClass('gina-toolbar-unfolded');
                            $el.next('ul').slideToggle('fast');
                        }
                    }
                }

            }

            if (typeof (cb) != 'undefined' && cb != null )
                cb()
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

        var normalizeFoldingStateName = function(stateSection, stateName) {

            var foldingStateName = '', section = null, name = null;

            if ( typeof(stateSection) != 'undefined' && stateSection != '' ) {

                section = stateSection;
                if ( typeof(stateSection) == 'string' ) {
                    section = stateSection
                        .replace(/(\]\[|\[)/g, '-')
                        .replace(/\]/, '')
                        .replace(/[^A-Za-z0-9_-]/g, '_')
                }

                foldingStateName += section + '-'
            }

            if ( typeof(stateName) != 'undefined' && stateName != '' ) {

                name = stateName;
                if ( typeof(stateName) == 'string' ) {
                    name = stateName
                        .replace(/(\]\[|\[)/g, '-')
                        .replace(/\]/, '')
                }

                foldingStateName += name
            } else {
                foldingStateName = foldingStateName.substr(0, foldingStateName.length-1)
            }

            return foldingStateName.trim()
        }

        var parseObject = function(obj, ginaObj, elId, elIsXHR, elSection) {

            var html            = '';
            var id              = ( typeof(elId) != 'undefined' && elId != null ) ? elId.replace(/[^A-Za-z0-9_-]/g, '_') : '';
            var section         = ( typeof(elSection) != 'undefined' && elSection != null ) ? elSection : '';
            var isXHR           = ( typeof(elIsXHR) != 'undefined' && elIsXHR != null ) ? '-xhr' : '';
            var count           = '';
            var objType         = '';
            var isEmptyClass    = null;

            if (!obj) {
                return;
            }

            obj     = orderKeys(obj);
            ginaObj = orderKeys(ginaObj);

            for (var i in obj) {
                //console.log('i', i);
                //if ( /^(_uuid)$/.test(i) ) continue;

                if ( typeof(obj[i]) == 'object' && !Array.isArray(obj[i]) && obj[i] !== null ) { // parse
                    //id += i + '-';
                    id += '-' + i.replace(/[^A-Za-z0-9_-]/g, '_');
                    isEmptyClass = (obj[i].count() > 0 || typeof(ginaObj[i]) != 'undefined' && ginaObj[i].count() > 0) ? '' : ' is-empty';

                    html += '<li class="gina-toolbar-object">';
                    html +=  '<a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( section, i.replace(/[^A-Za-z0-9_-]/g, '_') ) + isEmptyClass +'">'+ i +' <span>{ }</span></a>';
                    html += '<ul class="gina-toolbar-object">' + parseObject(obj[i], ginaObj[i], id, elIsXHR, elSection) +'</ul>';
                    html += '</li>';
                    // clear one level
                    //id = id.substr(0, id.length - i.length - 1);
                    id = id.substr(0, id.length - i.length);
                } else if ( Array.isArray(obj[i]) ) {
                    //id += i + '-';
                    id += '-' + i.replace(/[^A-Za-z0-9_-]/g, '_');
                    isEmptyClass = (obj[i].length > 0 || typeof(ginaObj[i]) != 'undefined' && ginaObj[i].length > 0) ? '' : ' is-empty';

                    html += '<li class="gina-toolbar-collection">';
                    html +=  '<a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( section, i.replace(/[^A-Za-z0-9_-]/g, '_') ) + isEmptyClass +'">'+ i +' <span>['+ obj[i].length +']</span></a>';
                    html += '<ul class="gina-toolbar-collection">' + parseCollection(obj[i], ginaObj[i], id, elIsXHR, elSection)  +'</ul>';
                    html += '</li>';
                    // clear one level
                    //id = id.substr(0, id.length - i.length - 1);
                    id = id.substr(0, id.length - i.length);
                } else {
                    objType = (ginaObj[i] === null) ? 'null' : typeof(ginaObj[i]);
                    if ( objType == 'undefined' ) { // new key  declaration added by user
                        html += '<li class="gina-toolbar-key-value">';
                        html +=     '<span class="gina-toolbar-key gina-toolbar-key-added">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span>';
                        html += '</li>';
                    } else {

                        //if (/^_comment/.test(i) ) continue;

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

        var parseCollection = function (arr, ginaArr, elId, elIsXHR, elSection) {
            var html            = '';
            var id              = ( typeof(elId) != 'undefined' && elId != null ) ? elId : '';
            var section         = ( typeof(elSection) != 'undefined' && elSection != null ) ? elSection : '';
            var isXHR           = ( typeof(elIsXHR) != 'undefined' && elIsXHR != null ) ? '-xhr' : '';

            // patch
            if (!ginaArr) {
                ginaArr = [];
            }
            for (var i = 0, len = arr.length; i<len; ++i) {
                if ( typeof(arr[i]) == 'object' && !Array.isArray(arr[i]) ) {
                    //id   += i + '-';
                    // patch
                    if (!ginaArr[i]) {
                        ginaArr[i] = arr[i]
                    }

                    id   += '-'+ i;
                    if (section == '') {
                        section = id;
                    }
                    html += '<li class="gina-toolbar-object">';
                    html +=   '<a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( section, i ) +'">'+ i +' <span>{ }</span></a>';
                    html += '<ul class="gina-toolbar-object">' + parseObject(arr[i], ginaArr[i], id, elIsXHR, elSection) +'</ul>';
                    html += '</li>';
                    // clear one level
                    id = id.substr(0, id.length - i.toString().length - 1);

                } else if ( Array.isArray(arr[i]) ) {
                    //id   += i + '-';
                    id   += '-'+ i;
                    if (section == '') {
                        section = id;
                    }
                    html += '<li class="gina-toolbar-collection">';
                    html +=   '<a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( section, i ) +'">'+ i +'<span>[ ]</span></a>';
                    html += '<ul class="gina-toolbar-collection">' + parseCollection(arr[i], ginaArr[i], id, elIsXHR, elSection)  +'</ul>';
                    html += '</li>';
                    // clear one level
                    //id = id.substr(0, id.length - i.toString().length - 1);
                    id = id.substr(0, id.length - i.toString().length);
                } else {
                    html += '<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value">'+ arr[i] +'</span></li>';
                }
            }
            return html
        }

        var parseView = function (obj, ginaObj, elId, elIsXHR, $html, $root) {

            var id          = (elId != null) ? elId.replace(/[^A-Za-z0-9_-]/g, '_') : '';
            var section     = null;
            var isXHR       = ( typeof(elIsXHR) != 'undefined' && elIsXHR != null ) ? '-xhr' : '';
            var count       = '';
            var objType     = '';
            var hasParent   = false;
            var $parent     = null;
            var parentId    = null;

            obj     = orderKeys(obj);
            ginaObj = orderKeys(ginaObj);

            if (!$root)
                $root = $html;

            for (var i in obj) {
                section = i;
                if ( typeof(obj[i]) == 'object' && !Array.isArray(obj[i]) && obj[i] !== null ) { // parse

                    $parent = $('#gina-toolbar-view-' + id.substr(0, id.length - 1));
                    hasParent = ( $parent.length ) ? true : false;

                    if (!hasParent ) {
                        id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                        if (i == 'params') { // force to top
                            var htmlParams =    '<div id="gina-toolbar-view-'+ id.substr(0, id.length - 1) +'" class="gina-toolbar-section">' +
                                                    '<h2 class="gina-toolbar-section-title">'+ id.substr(0, id.length - 1) +'</h2>' +
                                                    '<ul class="'+ id.substr(0, id.length - 1) +'"></ul>' +
                                                '</div>';

                            $('#gina-toolbar-view-html-properties')
                                .before(htmlParams);
                        } else {

                            if ( !/^html/.test(id) ) {

                                var htmlOther = '<div id="gina-toolbar-view-'+ id.substr(0, id.length - 1) +'" class="gina-toolbar-section">' +
                                                '<h2 class="gina-toolbar-section-title">'+ id.substr(0, id.length - 1) +'</h2>' +
                                                '<ul class="'+ id.substr(0, id.length - 1) +'"></ul>' +
                                            '</div>';

                                $html
                                    .append(htmlOther);
                            }/** else { // add to properties section
                                $root
                                    .find('.gina-toolbar-properties')
                                    .append('ul.' + id.substr(0, id.length - 1))
                            }*/

                        }

                        parseView(obj[i], ginaObj[i], id, elIsXHR, $html.find('ul.'+ id.substr(0, id.length - 1)), $root );

                    } else {

                        parentId = id + i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                        $parent
                            .find('ul.'+ id.substr(0, id.length - 1))
                            .append('<li class="gina-toolbar-object"><a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( i.replace(/[^A-Za-z0-9_-]/g, '_'), parentId.substr(0, parentId.length - 1) ) +'">'+ i +' <span>{ }</span></a><ul class="gina-toolbar-object '+ parentId.substr(0, parentId.length - 1) +'"></ul></li>');

                        parseView(obj[i], ginaObj[i], parentId, elIsXHR, $parent.find('ul.'+ id.substr(0, id.length - 1)), $root );

                        id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                    }


                    // clear one level
                    id = id.substr(0, id.length - i.length - 1);


                } else if ( Array.isArray(obj[i]) ) { // parse collection



                    $parent = $('#gina-toolbar-view-' + id.substr(0, id.length - 1));

                    hasParent = ( $parent.length ) ? true : false;

                    if ( !hasParent || /^html/.test(id) ) {

                        $parent = $('.' + id);
                        parentId = id + i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                        $parent
                            //.find('ul.'+ id.substr(0, id.length - 1))
                            .append('<li class="gina-toolbar-collection"><a href="#" class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( i.replace(/[^A-Za-z0-9_-]/g, '_'), parentId.substr(0, parentId.length - 1) ) +'">'+ i +' <span>['+ obj[i].length +']</span></a><ul> '+ parseCollection(obj[i], ginaObj[i], parentId, $parent.find('li ul.'+ id.substr(0, id.length - 1)), section )+'</ul></li>');


                        //parentId = parentId.substr(0, parentId.length - 1)+ '-';
                        //parentId = id.substr(0, id.length - i.length - 1);
                        //parseView(obj[i], ginaObj[i], parentId, elIsXHR, $parent.find('ul.'+ parentId.substr(0, parentId.length - 1)), $root );

                        //id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                        //$parent = $('#gina-toolbar-view-' + id.substr(0, id.length - 1));
                        id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                    } else {


                        parentId = id + i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                        $parent
                            .find('li.'+ id.substr(0, id.length - 1) +' ul')
                            .append('<li class="gina-toolbar-collection"><a class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( i.replace(/[^A-Za-z0-9_-]/g, '_'), parentId.substr(0, parentId.length - 1) ) +'">'+ i +' <span>['+ obj[i].length +']</span></a><ul>'+ parseCollection(obj[i], ginaObj[i], parentId, $parent.find('li ul.'+ id.substr(0, id.length - 1)), section ) +'</ul></li>');

                        id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                    }


                    // if ( !hasParent || /^html/.test(id) ) {
                    //     id = id + i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                    //     $root
                    //         .find('.gina-toolbar-properties')
                    //         .append('<li class="gina-toolbar-collection"><a class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( i.replace(/[^A-Za-z0-9_-]/g, '_'), id.substr(0, id.length - 1) ) +'">'+ i +' <span>['+ obj[i].length +']</span></a><ul>'+ parseCollection(obj[i], ginaObj[i], parentId, $root.find('.gina-toolbar-properties'), section) +'</ul></li>');


                    // } else {


                    //     parentId = id + i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';

                    //     $parent
                    //         .find('li.'+ id.substr(0, id.length - 1) +' ul')
                    //         .append('<li class="gina-toolbar-collection"><a class="gina-toolbar-key gina-toolbar'+ isXHR +'-folding-state-'+ normalizeFoldingStateName( i.replace(/[^A-Za-z0-9_-]/g, '_'), parentId.substr(0, parentId.length - 1) ) +'">'+ i +' <span>['+ obj[i].length +']</span></a><ul>'+ parseCollection(obj[i], ginaObj[i], parentId, $parent.find('li ul.'+ id.substr(0, id.length - 1)), section ) +'</ul></li>');

                    //     id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                    // }

                    // clear one level
                    id = id.substr(0, id.length - i.length - 1);
                } else {



                    objType = (ginaObj[i] === null) ? 'null' : typeof(ginaObj[i]);
                    if ( objType == 'undefined' ) { // new key  declaration added by user
                        if (/\-$/.test(id)) {
                            id = id.substr(0, id.length - 1);
                        }

                        if (!id) continue;

                        $html
                            .find('ul.' + id)
                            .append('<li class="gina-toolbar-key-value"><span class="gina-toolbar-key gina-toolbar-key-added">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i]+'</span></li>');

                    } else {

                        //if (/^_comment/.test(i) ) continue;

                        if (obj[i] !== ginaObj[i] ) {
                            if (!id) {
                                id += i.replace(/[^A-Za-z0-9_-]/g, '_') + '-';
                            }

                            try {
                                $html
                                    .find('ul.' + id)
                                    .append('<li class="gina-toolbar-key-value gina-toolbar-is-overridden"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value">'+ ginaObj[i] +'</span></li>');

                                $html
                                    .find('ul.' + id)
                                    .append('<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span></li>')

                            } catch (err) {
                                throw new Error('GinaToolbarError: `ul.'+ id +'` not found');
                            }

                        } else {

                            if ( !id || /^html\-properties/.test(id) ) { // properties case
                                // if (id) {
                                //     $html
                                //         .find('ul.' + id)
                                //         .append('<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span></li>')
                                // } else {
                                    $root
                                        .find('.gina-toolbar-properties')
                                        .append('<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span></li>')
                                //}

                            } else {

                                $root
                                    .find('ul.' + id.substr(0, id.length - 1))
                                    .append('<li class="gina-toolbar-key-value"><span class="gina-toolbar-key">'+ i +':</span> <span class="gina-toolbar-value gina-toolbar-value-type-is-'+ objType +'">'+ obj[i] +'</span></li>')
                            }
                        }
                    }
                }
            }

            return $root.html()
        }

        var parseSection = function (rules, id, elIsXHR, section) {

            return parseObject(rules, rules, id, elIsXHR, section)
        }

        var parseUrls = function(section) {

            var $el = null;
            var $currentPopin = (gina.hasPopinHandler) ? gina.popin.getActivePopin() : null;
            var isPopinContext = ( gina.hasPopinHandler ) ? true : false;
            if ( isPopinContext ) {
                $el = $('#' + $currentPopin.id );
            } else {
                $el = $('body');
            }

            // look for `404: `
            var found = {}
                , foundStr = null
                , formMethod = null
                , f = 0
                , fLen = 0
            ;
            var matched = $el.html().match(/404\:\[(.+)\](.+)@(.+)\"/gm);
            if (matched) {
                f = 0; fLen = matched.length;
                for (; f < fLen; ++f) {
                    foundStr = matched[f].replace(/\"(.*)|\"/g, '');
                    formMethod = foundStr.match(/\[(.*)\]/g, '')[0].replace(/\[|\]/g,'');

                    routing.getRouteByUrl(foundStr, formMethod)
                }
            }

            printLogs();

            //console.debug('popinIsActive: '+ isPopinContext +'isXHR: ', self.isXHR, ' -> ' + section, routing.notFound);
        }

        var printLogs = function() {
            fLen = routing.notFound.count();
            if ( fLen > 0 ) {
                for (f in routing.notFound) {
                    console.warn( '(x'+ routing.notFound[f].count +') ' + f + ' => ' + routing.notFound[f].message );
                }
            }
        }

        var parseForms = function (obj, ginaObj, $html, i, $forms, len, elIsXHR) {

            if (!len) return false;

            var attributes  = $forms[i].attributes;
            var formMethod  = null;
            var attrClass   = 'gina-toolbar-form-attributes';
            var id = $forms[i].getAttribute('id') || $forms[i].id;
            var section     = attrClass; // by default
            var isXHR       = ( typeof(elIsXHR) != 'undefined' && elIsXHR != null ) ? '-xhr' : '';
            // form fields set
            // var fields      = validator
            //                     .getFormById(id)
            //                     .fieldsSet;

            var $form = $(
                        '<div id="gina-toolbar-form-'+ id +'" class="gina-toolbar-section">' +
                            '<h2 class="gina-toolbar-section-title">'+ id +'</h2>' +
                            '<ul class="gina-toolbar-section-content gina-toolbar-code" style="display: none;">' +
                                '<li class="'+ attrClass +'">' +
                                    '<h3 class="gina-toolbar-sub-section-title">'+ attrClass.replace(/gina-toolbar-form-/, '') +'</h3>' +
                                    '<ul class="gina-toolbar-code"></ul>' +
                                '</li>' +
                            '</ul>' +
                        '</div>');

            var key         = null
                , val       = null
                , content   = null
                , hasEvents = false
                , routeObj  = null
            ;

            // testing for action attr to add action route


            // adding form attributes
            for ( var a = 0, aLen = attributes.length; a < aLen; ++a ) {

                key     = attributes[a].name;
                val     = attributes[a].nodeValue;

                // filters
                if ( /^method$/.test(key) )
                    val = val.toUpperCase();

                if ( /^class$/.test(key) && /\s+/.test(val) )
                    val = '<ul><li>'+ val.replace(/\s+/g, '</li><li>') +'</li></ul>';

                if ( /^action$/.test(key) ) {

                    formMethod  = ( typeof(attributes['method']) != 'undefined' ) ? attributes['method'].nodeValue : null;

                    if (!formMethod) {
                        console.warn('[ ToolbarFormHelper::UndefinedMethod : form `'+ (id||undefined) +'` method attribute cannot be left undefined !');
                    }

                    routeObj    = routing.getRouteByUrl(val, formMethod);

                    if ( typeof(routeObj) == 'undefined' || !routeObj ) {
                        routeObj = {
                            name: 'not found',
                            namespace: 'not found',
                            param: {
                                control: 'not found',
                                file: 'not found'
                            }
                        }
                    }

                    val =   '<ul>' +
                                '<li>' +
                                    '<span class="gina-toolbar-key">url</span>' +
                                    '<span class="gina-toolbar-value">' + (val || '#') + '</span>' +
                                '</li>' +
                                '<li>' +
                                    '<span class="gina-toolbar-key">route</span>' +
                                    '<span class="gina-toolbar-value">' + routeObj.name +'</span>' +
                                '</li>' +
                                '<li>' +
                                    '<span class="gina-toolbar-key">namespace</span>' +
                                    '<span class="gina-toolbar-value">' + (routeObj.namespace || 'root controller') + '</span>' +
                                '</li>' +
                                '<li>' +
                                    '<span class="gina-toolbar-key">control</span>' +
                                    '<span class="gina-toolbar-value">' + routeObj.param.control + '</span>' +
                                '</li>' +
                                '<li>' +
                                    '<span class="gina-toolbar-key">file</span>' +
                                    '<span class="gina-toolbar-value">' + routeObj.param.file + '</span>' +
                                '</li>' +
                            '<ul>';

                    content =   '<li>' +
                                    '<span class="gina-toolbar-key">' + key + ':</span>' +
                                    '<span class="gina-toolbar-value">' + val + '</span>' +
                                '</li>';
                }

                //content = val;


                // events
                if ( /^data-gina-form-event/.test(key) ) {
                    section     = 'events';
                    hasEvents   = ( $form
                                    .find('.'+ attrClass)
                                    .find('.gina-toolbar-key-events').length ) ? true : false;

                    key = key.replace(/^data-gina-form-event-/, '');

                    if (!hasEvents) {
                        // adding event sub section
                        $form
                            .find('ul.gina-toolbar-section-content')
                            .append('<li class="gina-toolbar-form-'+ section +'">' +
                                        '<h3 class="gina-toolbar-sub-section-title">'+ section +'</h3>' +
                                        '<ul class="gina-toolbar-code"></ul>' +
                                    '</li>');

                    }


                    content =   '<li>' +
                                    '<span class="gina-toolbar-key">'+ key +':</span>' +
                                    '<span class="gina-toolbar-value">'+ val +'</span>' +
                                '</li>';


                    $form
                        .find('ul.gina-toolbar-section-content')
                        .find('li.gina-toolbar-form-'+ section +' > ul')
                        .append(content)


                } else { // normal case

                    if (!/^action$/.test(key)) {
                        content = '<li>' +
                                    '<span class="gina-toolbar-key">' + key + ':</span>' +
                                    '<span class="gina-toolbar-value">' + val + '</span>' +
                                '</li>';
                    }

                    $form
                        .find('ul.gina-toolbar-section-content')
                        .find('li.'+ attrClass +' > ul')
                        .append(content)
                }


            }

            // adding form rules
            var rules = null;

            try {

                var dataRule = $forms[i].getAttribute('data-gina-form-rule');

                if ( typeof(dataRule) != 'undefined' && dataRule!= null ) {
                    rules = eval('gina.forms.rules.' + dataRule.replace(/-/g, '.'))
                } else {
                    rules = eval('gina.forms.rules.' + id.replace(/-/g, '.'))
                }

            } catch (err) {}

            if ( rules ) {
                section = 'rules';
                $form
                    .find('ul.gina-toolbar-section-content')
                    .append('<li class="gina-toolbar-form-'+ section +'">' +
                                '<h3 class="gina-toolbar-sub-section-title">'+ section +'</h3>' +
                                '<ul class="gina-toolbar-properties">'+ parseSection( rules, id, elIsXHR, section ) +'</ul>' +
                            '</li>');

            }



            $html.append($form);

            ++i;

            if (i < len) {
                parseForms(obj, ginaObj, $html, i, $forms, len, elIsXHR)
            }
        }

        var updateForm = function(id, section, obj, elIsXHR) {

            var $form = $('#gina-toolbar-form-' + id);

            // reset
            $section = $form
                .find('ul.gina-toolbar-section-content')
                .find('li.gina-toolbar-form-'+ section + '> ul');

            if ($section.length > 0) { // update

                if ( obj.count() == 0 ) { // no errors remove section
                    $form
                        .find('ul.gina-toolbar-section-content')
                        .find('li.gina-toolbar-form-' + section)
                        .remove();
                    return false
                }

                $section
                    .html( parseSection( obj, id, elIsXHR, section ) );

            } else { // init

                $form
                    .find('ul.gina-toolbar-section-content')
                    .append('<li class="gina-toolbar-form-'+ section +'">' +
                                '<h3 class="gina-toolbar-sub-section-title">'+ section +'</h3>' +
                                '<ul class="gina-toolbar-properties">'+ parseSection( obj, id, elIsXHR, section ) +'</ul>' +
                            '</li>');
            }

            // Form binding
            var $sectionContent = $form.find('ul.gina-toolbar-section-content');
            if ( !$sectionContent.is(':visible') ) {
                $sectionContent.slideToggle()
            }

        }

        var createInputFile = function(id, label) {

            var html = null;

            html  = '<label class="gina-toolbar-input-file">';
            html += '<input type="file" multiple id="' + id +'">';
            html += label;
            html += '</label>';

            return html
        }

        var loadJSON = function(txt, cb) {

            var html = createInputFile('mock', 'Select your JSON file');

            $htmlData.html(html);
            $json.text('');

            $htmlData.find('input').off('change').on('change', function(e) {

                var files   = $(this)[0].files;
                var file    = null;
                var reader  = null;


                if (files.length == 1) {
                    file        = $(this)[0].files[0]; // jQuery way
                    reader      = new FileReader();
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

                    reader  = [];

                    for (var i = 0, len = files.length; i < len; ++i) {
                        file = files[i];
                        switch (true) {
                            case /user/.test(file.name):

                                reader[i]  = new FileReader();
                                reader[i].addEventListener('load', function onEventListenerAdded(e){

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
                                reader[i].addEventListener('load', function onEventListenerAdded(e){
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
            // get last jsonObject.data state
            if (lastJsonObjectState && typeof (lastJsonObjectState.data) != 'undefined' ) {
                originalData.jsonObject.data = lastJsonObjectState.data;
            }

            loadData('data', originalData.jsonObject, originalData.ginaJsonObject);
            self.hasParsedUrls = false;
            routing.notFound = {};
        }


        if ( typeof(gina.validator) != 'undefined' ) {
            gina.validator.on('initialized', function onValidatorReady(){
                console.log('toolbar validator ready');
                init();
            })
        } else {
            init();
        }

    }

    return Toolbar
})