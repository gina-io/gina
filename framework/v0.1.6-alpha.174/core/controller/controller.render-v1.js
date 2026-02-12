const fs = require('fs');
const {promises: {readFile}} = require("fs");
// Inherited from controller
var self, local, SuperController, getData, hasViews, setResources, SwigFilters, headersSent;
/**
 * Render HTML templates : Swig is the default template engine
 *
 *  Extend default filters
 *  - length
 *
 * Available filters:
 *  - getWebroot()
 *  - getUrl()
 *
 *  N.B.: Filters can be extended through your `<project>/src/<bundle>/controllers/setup.js`
 *
 *
 * @param {object} userData
 * @param {boolean} [displayToolbar]
 * @param {object} [errOptions]
 * @returns {void}
 * */
module.exports = async function render(userData, displayToolbar, errOptions, deps) {
    console.info('render V1');
    self            = deps.self;
    local           = deps.local;
    SuperController = deps.SuperController;
    getData         = deps.getData;
    hasViews        = deps.hasViews;
    setResources    = deps.setResources;
    swig            = deps.swig;
    SwigFilters     = deps.SwigFilters;
    headersSent     = deps.headersSent;

    var err = null;
    var isRenderingCustomError = (
                                typeof(userData.isRenderingCustomError) != 'undefined'
                                && /^true$/i.test(userData.isRenderingCustomError)
                            ) ? true : false;
    if (isRenderingCustomError)
        delete userData.isRenderingCustomError;

    var localOptions = (errOptions) ? errOptions : local.options;
    localOptions.renderingStack.push( self.name );
    // preventing multiple call of self.render() when controller is rendering from another required controller
    if ( localOptions.renderingStack.length > 1 && !isRenderingCustomError ) {
        return false;
    }


    var data                = null
        , layout            = null
        , template          = null
        , file              = null
        , path              = null
        , plugin            = null
        // By default
        , isWithoutLayout   = (localOptions.isWithoutLayout) ? true : false
    ;

    try {
        data = getData();
        // Display session
        if (
            typeof(local.req.session) != 'undefined'
        ) {
            if ( typeof(data.page.data) == 'undefined' ) {
                data.page.data = {};
            }

            if ( typeof(local.req.session.cookie._expires) != 'undefined' ) {
                var dateEnd = local.req.session.cookie._expires;
                var dateStart = ( typeof(local.req.session.lastModified) != 'undefined')
                                ? new Date(local.req.session.lastModified)
                                : new Date()
                ;
                var elapsed = dateEnd - dateStart;
                // var expiresAt =
                if ( typeof(data.page.data.session) == 'undefined' ) {
                    data.page.data.session = {
                        id          : local.req.session.id,
                        lastModified: local.req.session.lastModified
                    };
                }
                // In milliseconds
                data.page.data.session.createdAt    = local.req.session.createdAt;
                data.page.data.session.expiresAt    = dateEnd.format('isoDateTime');
                data.page.data.session.timeout      = elapsed;

                dateEnd     = null;
                dateStart   = null;
                elapsed     = null;
            }
        }

        // in case `local.req.routing.param.file` has been changed on the fly
        if (
            local.req.routing.param.file
            && local.req.routing.param.file != data.page.view.file
        ) {
            data.page.view.file = local.req.routing.param.file;
        }
        if (
            local.req.routing.param.ext
            && local.req.routing.param.ext != data.page.view.ext
        ) {
            data.page.view.ext = local.req.routing.param.ext;
        }
        file = (isRenderingCustomError) ? localOptions.file : data.page.view.file;
        // making path thru [namespace &] file
        if ( typeof(localOptions.namespace) != 'undefined' && localOptions.namespace ) {
            // excepted for custom paths
            var fileNamingConvention = file.replace(localOptions.namespace+'-', '');
            if ( !/^(\.|\/|\\)/.test(file) && file != fileNamingConvention ) {
                var _ext = data.page.view.ext;

                console.warn('file `'+ file +'` used in routing `'+ localOptions.rule +'` does not respect gina naming convention ! You should rename the file `'+ file + _ext +'` to `'+ ''+ fileNamingConvention + _ext +'`');
                console.warn('The reason you are getting this message is because your filename begins with `<namespace>-`\n If you don\‘t want to rename, use template path like ./../'+ localOptions.namespace +'/'+file);
                file = ''+ file.replace(localOptions.namespace+'-', '');
            }
            fileNamingConvention = null;
            _ext = null;


            // means that rule name === namespace -> pointing to root namespace dir
            if (!file || file === localOptions.namespace) {
                file = 'index'
            }
            path = (isRenderingCustomError) ? _(file) : _(localOptions.template.html +'/'+ localOptions.namespace + '/' + file)
        } else {
            if ( localOptions.path && !/(\?|\#)/.test(localOptions.path) ) {
                path = _(localOptions.path);
                var re = new RegExp( data.page.view.ext+'$');
                if ( data.page.view.ext && re.test(data.page.view.file) ) {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');

                    path            = path.replace(re, '');
                    data.page.view.file  = data.page.view.file.replace(re, '');

                } else {
                    data.page.view.path = path.replace('/'+ data.page.view.file, '');
                }
                re = null;
            } else {
                    path = (!isRenderingCustomError && !/^(\.|\/|\\)/.test(file))
                        ? _(localOptions.template.html +'/'+ file)
                        : file
            }
        }

        if (data.page.view.ext && !new RegExp(data.page.view.ext+ '$').test(file) ) {
            path += data.page.view.ext
        }

        data.page.view.path = path;
    } catch (dataErr) {
        return self.throwError(dataErr);
    }

    // isWithoutLayout from content
    var pageContentObj  = new _(data.page.view.path);
    var _templateContent = null;
    try {
        _templateContent = fs.readFileSync(path).toString()
    } catch (pathException) {
            console.warn("Path exception: ", pathException);
    }
    var hasLayoutInPath = /\{\%(\s+extends|extends)/.test(_templateContent) || false;
    var layoutPath      = null;

    if (
        !isWithoutLayout
        && !isRenderingCustomError
        && pageContentObj.existsSync()
        && !hasLayoutInPath
    ) {
        isWithoutLayout = true;
    }
    pageContentObj = null;

    // Retrieve layoutPath from content
    if (hasLayoutInPath && _templateContent) {
        var extendFound = _templateContent.match(/\{\%(\s+extends|extends)(.*)\%}/);
        if (extendFound && Array.isArray(extendFound)) {
            var extendPath = null;
            try {
                // localOptions.template.templates +'/'+
                layoutPath = extendFound[0].match(/(\"|\')(.*)(\"|\')/)[0].replace(/(\"|\')/g, '');
                data.page.view.layout = layoutPath;
                layoutPath = localOptions.template.templates +'/'+ layoutPath;
                localOptions.template.layout = layoutPath;
            } catch (extendErr) {
                // nothing to do
            }
            extendPath = null;
        }
        extendFound = null;
    }
    hasLayoutInPath     = null;
    _templateContent    = null;

    localOptions.debugMode = ( typeof(displayToolbar) == 'undefined' ) ? undefined : ( (/true/i.test(displayToolbar)) ? true : false ); // only active for dev env

    // specific override
    if (
        self.isCacheless()
        && typeof(local.req[ local.req.method.toLowerCase() ]) != 'undefined'
        && typeof(local.req[ local.req.method.toLowerCase() ].debug) != 'undefined'
    ) {
        if ( !/^(true|false)$/i.test(local.req[ local.req.method.toLowerCase() ].debug) ) {
            console.warn('Detected wrong value for `debug`: '+ local.req[ local.req.method.toLowerCase() ].debug);
            console.warn('Switching `debug` to `true` as `cacheless` mode is enabled');
            local.req[ local.req.method.toLowerCase() ].debug = true;
        }
        localOptions.debugMode = ( /^true$/i.test(local.req[ local.req.method.toLowerCase() ].debug) ) ? true : false;
    } else if (
        self.isCacheless()
        && hasViews()
        && !isWithoutLayout
        && localOptions.debugMode == undefined
    ) {
        localOptions.debugMode = true;
    } else if ( localOptions.debugMode == undefined  ) {
        localOptions.debugMode = self.isCacheless()
    }

    try {

        if (!userData) {
            userData = { page: { view: {}}}
        } else if ( userData && !userData['page']) {

            if ( typeof(data['page']['data']) == 'undefined' )
                data['page']['data'] = userData;
            else
                data['page']['data'] = (isRenderingCustomError) ? userData : merge( userData, data['page']['data'] );
        } else {
            data = (isRenderingCustomError) ? userData : merge(userData, data)
        }

        template = localOptions.rule.replace('\@'+ localOptions.bundle, '');
        var localTemplateConf = localOptions.template;
        if ( isWithoutLayout ) {
            localTemplateConf = JSON.clone(localOptions.template);
            localTemplateConf.javascripts = new Collection(localTemplateConf.javascripts).find({ isCommon: false}, { isCommon: true, name: 'gina' });
            localTemplateConf.stylesheets = new Collection(localTemplateConf.stylesheets).find({ isCommon: false}, { isCommon: true, name: 'gina' });
        }
        setResources(localTemplateConf);

        // Allowing file & ext override
        if (
            typeof(local.req.routing.param.file) != 'undefined'
            && data.page.view.file !== local.req.routing.param.file
        ) {
            data.page.view.file = localOptions.file = local.req.routing.param.file
        }
        if (
            typeof(local.req.routing.param.ext) != 'undefined'
            && data.page.view.ext !== local.req.routing.param.ext
        ) {
            data.page.view.ext = localOptions.template.ext = local.req.routing.param.ext
        }


        // pre-compiling variables
        data = merge(data, getData()); // needed !!

        if  (typeof(data.page.data) == 'undefined' ) {
            data.page.data = {}
        }


        if (
            !local.options.isRenderingCustomError
            && typeof(data.page.data.status) != 'undefined'
            && !/^2/.test(data.page.data.status)
            && typeof(data.page.data.error) != 'undefined'
        ) {

            var errorObject = {
                status  : data.page.data.status,
                error   : statusCodes[data.page.data.status] || msg.error || msg,
                message : data.page.data.message || data.page.data.error,
                stack   : data.page.data.stack
            };
            if ( typeof(data.page.data.session) != 'undefined' ) {
                errorObject.session = data.page.data.session;
            }

            return self.throwError(errorObject);
        }


        // data.page.view.path = path;

        var dic = {}, msg = '';
        for (let d in data.page) {
            dic['page.'+d] = data.page[d]
        }



        // please, do not start with a slashe when including...
        // ex.:
        //      /html/inc/_partial.html (BAD)
        //      html/inc/_partial.html (GOOD)
        //      ./html/namespace/page.html (GOOD)

        if ( !fs.existsSync(path) ) {
            msg = 'could not open "'+ path +'"' +
                        '\n1) The requested file does not exists in your templates/html (check your template directory). Can you find: '+path +
                        '\n2) Check the following rule in your `'+localOptions.conf.bundlePath+'/config/routing.json` and look around `param` to make sure that nothing is wrong with your file declaration: '+
                        '\n' + options.rule +':'+ JSON.stringify(options.conf.content.routing[options.rule], null, 4) +
                        '\n3) At this point, if you still have problems trying to run this portion of code, you can contact us telling us how to reproduce the bug.'
                        //'\n\r[ stack trace ] '
                        ;
            err = new ApiError(msg, 500);
            console.error(err.stack);
            self.throwError(err);
            return;
        }

        var localRequestPort = local.req.headers.port || local.req.headers[':port'];
        var isProxyHost = (
            typeof(local.req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            &&  /^(80|443)$/.test(localRequestPort)
            && localOptions.conf.server.scheme +'://'+ local.req.headers.host+':'+ localRequestPort != localOptions.conf.hostname.replace(/\:\d+$/, '') +':'+ localOptions.conf.server.port
            ||
            typeof(local.req.headers[':authority']) != 'undefined'
            && localOptions.conf.server.scheme +'://'+ local.req.headers[':authority'] != localOptions.conf.hostname
            ||
            typeof(local.req.headers.host) != 'undefined'
            && typeof(localRequestPort) != 'undefined'
            && /^(80|443)$/.test(localRequestPort)
            && local.req.headers.host == localOptions.conf.host
            ||
            typeof(local.req.headers['x-nginx-proxy']) != 'undefined'
            && /^true$/i.test(local.req.headers['x-nginx-proxy'])
            ||
            typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) ? true : false;


        // setup swig default filters
        var filters = SwigFilters({
            options     : JSON.clone(localOptions),
            isProxyHost : isProxyHost,
            throwError  : self.throwError,
            req         : local.req,
            res         : local.res
        });

        try {

            // Extends default `length` filter
            swig.setFilter('length', filters.length);



            // Allows you to get a bundle web root
            swig.setFilter('getWebroot', filters.getWebroot);

            swig.setFilter('getUrl', filters.getUrl);

        } catch (err) {
            // [ martin ]
            // i sent an email to [ paul@paularmstrongdesigns.com ] on 2014/08 to see if there is:
            // a way of retrieving swig compilation stack traces
            //var stack = __stack.splice(1).toString().split(',').join('\n');
            // -> no response...
            self.throwError(local.res, 500, new Error('template compilation exception encoutered: [ '+path+' ]\n'+(err.stack||err.message)));
            return;
        }



        var  assets                 = null
            , mapping               = null
            , XHRData               = null
            , XHRView               = null
            , isDeferModeEnabled    = null
            , hasExternalsPlugins    = null
            , viewInfos             = null
            , filename              = null
            , isWithSwigLayout      = null
            , isUsingGinaLayout     = (!isWithoutLayout && typeof(localOptions.template.layout) != 'undefined' && fs.existsSync(local.options.template.layout)) ? true : false
        ;

        if ( isWithoutLayout || isUsingGinaLayout ) {
            layoutPath = (isWithoutLayout) ? localOptions.template.noLayout : localOptions.template.layout;
            // user layout override
            if ( isUsingGinaLayout && !isWithoutLayout ) {
                layoutPath = localOptions.template.layout;
            }
            if (isWithoutLayout) {
                data.page.view.layout = layoutPath;
            }
        }
        // without layout case
        else {

            // by default
            layoutPath = localOptions.template.layout;
            if ( !/^\//.test(layoutPath)) {
                layoutPath = localOptions.template.templates +'/'+ layoutPath;
            }
            // default layout
            if (
                !isWithoutLayout  && !fs.existsSync(layoutPath) && layoutPath == localOptions.template.templates +'/index.html'
            ) {
                console.warn('Layout '+ local.options.template.layout +' not found, replacing with `nolayout`: '+ localOptions.template.noLayout);
                layoutPath = localOptions.template.noLayout
                isWithoutLayout = true;
                data.page.view.layout = layoutPath;
            }
            // user defiend layout
            else if ( !isWithoutLayout && !fs.existsSync(layoutPath) ) {
                isWithSwigLayout = true;
                layoutPath = localOptions.template.noLayout;
                data.page.view.layout = layoutPath;
            }
            // layout defiendd but not found
            else if (!fs.existsSync(layoutPath) ) {
                err = new ApiError(options.bundle +' SuperController exception while trying to load your layout `'+ layoutPath +'`.\nIt seems like you have defined a layout, but gina could not locate the file.\nFor more informations, check your `config/templates.json` declaration around `'+ local.options.rule.replace(/\@(.*)/g, '') +'`', 500);
                self.throwError(err);
                return;
            }
        }

        var isLoadingPartial = false;
        try {
            assets  = {assets:"${assets}"};

            /**
             * retrieve template & layout
             * */
            var tpl = null;
            // tpl = fs.readFileSync(path).toString();
            // layout = fs.readFileSync(layoutPath).toString();

            await Promise.all([
                    readFile(layoutPath),
                    readFile(path)
                ])
                .then(([_layout, _tpl]) => {
                    layout  = _layout.toString();
                    tpl     = _tpl.toString();
                })
                .catch(error => {
                    console.error(error.message);
                    return;
                });


            // mappin conf
            mapping = { filename: path };
            if (isRenderingCustomError) {
                // TODO - Test if there is a block call `gina-error` in the layout & replace block name from tpl

                if ( !/\{\%(\s+extends|extends)/.test(tpl) ) {
                    tpl = "\n{% extends '"+ layoutPath +"' %}\n" + tpl;
                }
                if (!/\{\% block content/.test(tpl)) {
                    // TODO - test if lyout has <body>
                    tpl = '{% block content %}<p>If you view this message you didn’t define a content block in your template.</p>{% endblock %}' + tpl;
                }

                tpl = tpl.replace(/\{\{ page\.content \}\}/g, '');
            }

            if ( isWithoutLayout || isWithSwigLayout) {
                layout = tpl;
            } else if (isUsingGinaLayout) {
                mapping = { filename: path };
                if ( /(\{\{|\{\{\s+)page\.content/.test(layout) ) {

                    if ( /\{\%(\s+extends|extends)/.test(tpl) ) {
                        err = new Error('You cannot use at the same time `page.content` in your layout `'+ layoutPath +'` while calling `extends` from your page or content `'+ path +'`. You have to choose one or the other');
                        self.throwError(local.res, 500, err);
                        return
                    }
                    layout = layout.replace('{{ page.content }}', tpl);
                } else {
                    layout = layout.replace(/\<\/body\>/i, '\t'+tpl+'\n</body>');
                }

            } else {
                tpl = tpl.replace('{{ page.view.layout }}', data.page.view.layout);
                if (/\<\/body\>/i.test(layout)) {
                    layout = layout.replace(/\<\/body\>/i, '\t'+tpl+'\n</body>');
                }
                    else {
                    layout += tpl;
                }
            }

            // precompilation needed in case of `extends` or in order to display the toolbar
            if ( hasViews() && self.isCacheless() || /\{\%(\s+extends|extends)/.test(layout) ) {
                layout = swig.compile(layout, mapping)(data);
            }
            //dic['page.content'] = layout;

            tpl = null;

        } catch(err) {
            err.stack = 'Exception, bad syntax or undefined data found: start investigating in '+ mapping.filename +'\n' + err.stack;
            return self.throwError(local.res, 500, err);
        }
        mapping = null;
        filename = null;

        isLoadingPartial = (
            !/\<html/i.test(layout)
            || !/\<head/i.test(layout)
            || !/\<body/i.test(layout)
        ) ? true : false;

        // if (isLoadingPartial) {
        //     console.warn('----------------> loading partial `'+ path);
        // }

        isDeferModeEnabled = localOptions.template.javascriptsDeferEnabled || localOptions.conf.content.templates._common.javascriptsDeferEnabled || false;
        hasExternalsPlugins = (localOptions.template.externalPlugins.length > 0) ? true : false;

        // iframe case - without HTML TAG
        if (!self.isXMLRequest() && !/\<html/.test(layout) ) {
            layout = '<html>\n\t<head></head>\n\t<body class="gina-iframe-body">\n\t\t'+ layout +'\n\t</body>\n</html>';
        }

        // adding stylesheets
        if (!isWithoutLayout && data.page.view.stylesheets && !/\{\{\s+(page\.view\.stylesheets)\s+\}\}/.test(layout) ) {
            layout = layout.replace(/\<\/head\>/i, '\n\t{{ page.view.stylesheets }}\n</head>')
        }

        if (hasViews() && isWithoutLayout) {
            // $.getScript(...)
            //var isProxyHost = ( typeof(local.req.headers.host) != 'undefined' && localOptions.conf.server.scheme +'://'+ local.req.headers.host != localOptions.conf.hostname || typeof(local.req.headers[':authority']) != 'undefined' && localOptions.conf.server.scheme +'://'+ local.req.headers[':authority'] != localOptions.conf.hostname  ) ? true : false;
            //var hostname = (isProxyHost) ? localOptions.conf.hostname.replace(/\:\d+$/, '') : localOptions.conf.hostname;



            var scripts = data.page.view.scripts;
            scripts = scripts.replace(/\s+\<script/g, '\n<script');

            if (!isProxyHost) {
                var webroot = data.page.environment.webroot;
                scripts = scripts.replace(/src\=\"\/(.*)\"/g, 'src="'+ webroot +'$1"');
                //stylesheets = stylesheets.replace(/href\=\"\/(.*)\"/g, 'href="'+ webroot +'$1"')
                webroot = null;
            }

            // iframe case - without HTML TAG
            if (self.isXMLRequest() || !/\<html/.test(layout) ) {
                layout += scripts;
                //layout += stylesheets;
            }

        }

        // adding plugins
        // means that we don't want GFF context or we already have it loaded
        viewInfos = JSON.clone(data.page.view);
        if ( !isWithoutLayout )
                viewInfos.assets = assets;

        if (
            hasViews() && self.isCacheless() && !isWithoutLayout
            && localOptions.debugMode
            ||
            hasViews() && self.isCacheless() && !isWithoutLayout
            && typeof(localOptions.debugMode) == 'undefined'
            ||
            hasViews() && localOptions.debugMode
        ) {

            layout = ''
                // + '{%- set ginaDataInspector                    = JSON.clone(page) -%}'
                + '{%- set ginaDataInspector                    = JSON.clone(page) -%}'
                // + '{%- set ginaDataInspector                    = { view: {}, environment: { routing: {}}} -%}'
                + '{%- set ginaDataInspector.view.assets        = {} -%}'
                + '{%- set ginaDataInspector.view.scripts       = "ignored-by-toolbar" -%}'
                + '{%- set ginaDataInspector.view.stylesheets   = "ignored-by-toolbar" -%}'
                + layout
            ;

            plugin = '\t'
                + '{# Gina Toolbar #}'
                + '{%- set userDataInspector                    = JSON.clone(page) -%}'
                // + '{%- set userDataInspector                    = { view: {}, environment: { routing: {}}} -%}'
                + '{%- set userDataInspector.view.scripts       = "ignored-by-toolbar"  -%}'
                + '{%- set userDataInspector.view.stylesheets   = "ignored-by-toolbar"  -%}'
                + '{%- set userDataInspector.view.assets        = '+ JSON.stringify(assets) +' -%}'
                + '{# END Gina Toolbar #}'
                + '{%- include "'+ getPath('gina').core +'/asset/plugin/dist/vendor/gina/html/toolbar.html" with { gina: ginaDataInspector, user: userDataInspector } -%}'// jshint ignore:line
            ;


            if (isWithoutLayout && localOptions.debugMode || localOptions.debugMode ) {

                if (self.isXMLRequest()) {
                    XHRData = '\t<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeRFC5987ValueChars(JSON.stringify(data.page.data)) +'">\n\r';
                    XHRView = '\n<input type="hidden" id="gina-without-layout-xhr-view" value="'+ encodeRFC5987ValueChars(JSON.stringify(viewInfos)) +'">';
                    if ( /<\/body>/i.test(layout) ) {
                        layout = layout.replace(/<\/body>/i, XHRData + XHRView + '\n\t</body>');
                    } else {
                        // Popin case
                        // Fix added on 2023-01-25
                        layout += XHRData + XHRView + '\n\t'
                    }
                }


            }

            if (self.isCacheless() || localOptions.debugMode ) {
                layout = layout.replace(/<\/body>/i, plugin + '\n\t</body>');
            }

            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            // placed in the HEAD excepted when rendering a partial or when `isDeferModeEnabled` == true
            if (isLoadingPartial) {
                layout += '\t{{ page.view.scripts }}';
            } else {
                // placed in the HEAD
                if ( isDeferModeEnabled  ) {
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
            }

            // ginaLoader cannot be deferred
            if ( !localOptions.template.javascriptsExcluded || localOptions.template.javascriptsExcluded != '**' ) {
                layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.ginaLoader +'\n</head>');
            }

        } else if ( hasViews() && self.isCacheless() && self.isXMLRequest() ) {

            if (isWithoutLayout) {
                delete data.page.view.scripts;
                delete data.page.view.stylesheets;
            }
            // means that we don't want GFF context or we already have it loaded
            // viewInfos = JSON.clone(data.page.view);
            // if ( !isWithoutLayout )
            //     viewInfos.assets = assets;


            XHRData = '\n<input type="hidden" id="gina-without-layout-xhr-data" value="'+ encodeRFC5987ValueChars(JSON.stringify(data.page.data)) +'">';
            XHRView = '\n<input type="hidden" id="gina-without-layout-xhr-view" value="'+ encodeRFC5987ValueChars(JSON.stringify(viewInfos)) +'">';
            if ( /<\/body>/i.test(layout) ) {
                layout = layout.replace(/<\/body>/i, XHRData + XHRView + '\n\t</body>');
            } else {
                // Popin case
                // Fix added on 2023-01-25
                layout += XHRData + XHRView + '\n\t'
            }

            // layout += XHRData + XHRView;

        } else { // other envs like prod ...

            // adding javascripts
            // cleanup first
            layout.replace('{{ page.view.scripts }}', '');
            // placed in the HEAD excepted when rendering a partial or when `isDeferModeEnabled` == true
            // if (isLoadingPartial) {
            //     layout += '\t{{ page.view.scripts }}';
            // } else {
            //     if ( isDeferModeEnabled  ) {
            //         layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
            //     } else { // placed in the BODY
            //         layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
            //         if (hasExternalsPlugins) {
            //             for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
            //                 layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
            //             }
            //         }
            //     }
            // }

            // // ginaLoader cannot be deferred
            // if ( !localOptions.template.javascriptsExcluded || localOptions.template.javascriptsExcluded != '**' ) {
            //     layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.ginaLoader +'\n</head>');
            // }

            // adding javascripts
            layout.replace('{{ page.view.scripts }}', '');
            if (isLoadingPartial) {
                layout += '\t{{ page.view.scripts }}\n';
                if ( !localOptions.template.javascriptsExcluded || localOptions.template.javascriptsExcluded != '**' ) {
                    layout += '\t'+ localOptions.template.ginaLoader +'\n';
                }
            } else {
                // placed in the HEAD
                if ( isDeferModeEnabled && /\<\/head\>/i.test(layout) ) { // placed in the HEAD
                    layout = layout.replace(/\<\/head\>/i, '\t{{ page.view.scripts }}\n\t</head>');
                }
                // placed in the BODY
                else {
                    layout = layout.replace(/\<\/body\>/i, '\t{{ page.view.scripts }}\n</body>');
                    if (hasExternalsPlugins) {
                        for (let i =0, len = localOptions.template.externalPlugins.length; i<len; i++) {
                            layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.externalPlugins +'\n</head>');
                        }
                    }
                }
                // ginaLoader cannot be deferred
                if ( !localOptions.template.javascriptsExcluded || localOptions.template.javascriptsExcluded != '**' ) {
                    layout = layout.replace(/\<\/head\>/i, '\t'+ localOptions.template.ginaLoader +'\n</head>');
                }
            }
        }


        layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
        dic['page.content'] = layout;
        /**
        // special case for template without layout in debug mode - dev only
        if ( hasViews() && localOptions.debugMode && self.isCacheless() && !/\{\# Gina Toolbar \#\}/.test(layout) ) {
            try {

                layout = layout.replace(/<\/body>/i, plugin + '\n\t</body>');
                layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
                //swig.invalidateCache();
                layout = swig.compile(layout, mapping)(swigData);


            } catch (err) {
                filename = localOptions.template.html;
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(local.res, 500, new Error('Compilation error encountered while trying to process template `'+ filename + '`\n'+(err.stack||err.message)));
                return;
            }
        }
        else if (hasViews() && localOptions.debugMode && self.isCacheless()) {
            try {
                //layout = whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g );
                layout = swig.compile(layout, mapping)(swigData);
            } catch (err) {
                filename = localOptions.template.html;
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(local.res, 500, new Error('Compilation error encountered while trying to process template `'+ filename + '`\n'+(err.stack||err.message)));
                return;
            }
        }
        */


        // if ( !local.res.headersSent ) {
        if ( !headersSent() ) {
            //catching errors
            local.res.statusCode = ( typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status])  != 'undefined' ) ? data.page.data.status : 200; // by default

            // HTTP/2 (RFC7540 8.1.2.4):
            // This standard for HTTP/2 explicitly states that status messages are not supported.
            // In HTTP/2, the status is conveyed solely by the numerical status code (e.g., 200, 404, 500),
            // and there is no field for a human-readable status message.
            if (
                typeof(data.page.data.errno) != 'undefined'
                    && /^2/.test(data.page.data.status)
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(local.options.conf.server.protocol)
                ||
                typeof(data.page.data.status) != 'undefined'
                    && !/^2/.test(data.page.data.status)
                    && typeof(localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status]) != 'undefined'
                    && !/http\/2/.test(local.options.conf.server.protocol)
            ) {

                try {
                    local.res.statusMessage = localOptions.conf.server.coreConfiguration.statusCodes[data.page.data.status];
                } catch (err){
                    local.res.statusCode    = 500;
                    local.res.statusMessage = err.stack||err.message||localOptions.conf.server.coreConfiguration.statusCodes[local.res.statusCode];
                }
            }

            local.res.setHeader('content-type', localOptions.conf.server.coreConfiguration.mime['html'] + '; charset='+ localOptions.conf.encoding );

            try {

                // escape special chars
                var blacklistRe = new RegExp('[\<\>]', 'g');
                // DO NOT REPLACE IT BY JSON.clone() !!!!

                data.page.data = JSON.parse(JSON.stringify(data.page.data).replace(blacklistRe, '\$&'));
                blacklistRe = null;
            } catch (err) {
                filename = localOptions.template.html;
                filename += ( typeof(data.page.view.namespace) != 'undefined' && data.page.view.namespace != '' && new RegExp('^' + data.page.view.namespace +'-').test(data.page.view.file) ) ? '/' + data.page.view.namespace + data.page.view.file.split(data.page.view.namespace +'-').join('/') + ( (data.page.view.ext != '') ? data.page.view.ext: '' ) : '/' + data.page.view.file+ ( (data.page.view.ext != '') ? data.page.view.ext: '' );
                self.throwError(local.res, 500, new Error('Controller::render(...) compilation error encountered while trying to process template `'+ filename + '`\n' + (err.stack||err.message||err) ));
                filename = null;
                blacklistRe = null;
                return;
            }



            // Only available for http/2.0 for now
            if ( !self.isXMLRequest() && /http\/2/.test(localOptions.conf.server.protocol) ) {
                var assets = null;
                try {
                    // TODO - button in toolbar to empty url assets cache
                    if ( /**  self.isCacheless() ||*/ typeof(localOptions.template.assets) == 'undefined' || typeof(localOptions.template.assets[local.req.url]) == 'undefined' ) {
                        // assets string -> object
                        //assets = self.serverInstance.getAssets(localOptions.conf, layout.toString(), swig, data);
                        assets = self.serverInstance.getAssets(localOptions.conf, layout, swig, data);
                        localOptions.template.assets = JSON.parse(assets);
                    }

                    //  only for toolbar - TODO hasToolbar()
                    if (
                        self.isCacheless() && hasViews() && !isWithoutLayout
                        || hasViews() && localOptions.debugMode
                        || self.isCacheless() && hasViews() && self.isXMLRequest()
                    ) {
                        layout = layout.replace('{"assets":"${assets}"}', assets );
                    }

                    if ( !self.isCacheless() ) {
                        var links = local.options.template.h2Links;
                        for (let l in localOptions.template.assets) {
                            let link = localOptions.template.assets[l]
                            if (
                                /^_/.test(l)
                                || typeof(link.as) == 'undefined'
                                || typeof(link.as) != 'undefined'
                                    && link.as != 'null'
                                    && !link.isAvailable
                                || !link.as
                            ) {
                                // ignoring
                                continue;
                            }

                            links += '<'+ l +'>; as='+ link.as +'; '
                            if ( link.imagesrcset) {
                                links += 'imagesrcset='+ link.imagesrcset +'; ';
                            }
                            if ( link.imagesizes) {
                                links += 'imagesizes='+ link.imagesizes +'; ';
                            }
                            links += 'rel=preload,'

                        }
                        if ( /\,$/.test(links) ) {
                            links = links.substring(0, links.length-1);
                        }
                        local.res.setHeader('link', links);
                        links = null;
                    }

                    assets = null;

                } catch (err) {
                    assets = null;
                    self.throwError(local.res, 500, new Error('Controller::render(...) calling getAssets(...) \n' + (err.stack||err.message||err) ));
                    return;
                }
            }

            // Last compilation before rendering
            // Now we can use `data` instead of `swigData`
            layout = swig.compile(layout, mapping)(data);

            if ( !headersSent() ) {
                if ( local.options.isRenderingCustomError ) {
                    local.options.isRenderingCustomError = false;
                }
                console.info(local.req.method +' ['+local.res.statusCode +'] '+ local.req.url);
                local.res.end(layout);
                layout = null;
            }

            if ( typeof(local.next) != 'undefined' ) {
                return local.next();
            }
            return;
        }


        if ( typeof(local.req.params.errorObject) != 'undefined' ) {
            return self.throwError(local.req.params.errorObject);
        }
        local.res.end('Unexpected controller error while trying to render.');

        if (typeof(local.next) != 'undefined') {
            return local.next();
        }

        return;

    } catch (err) {
        return self.throwError(local.res, 500, err);
    }
};