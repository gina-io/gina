//var console = require('./../../../lib/logger');
var merge = require('./../../../lib/merge');
var statusCodes = requireJSON(__dirname + '/../../../core/status.codes');
//var statusCodes = requireJSON( _( getPath('gina').core + '/status.codes') );
/**
 *
 * Usage:
 *  var e = null;
 *  // Server errors
 *  e = new ApiError('This is a generic server error.'); // default error.status -> 500
 *  e = new ApiError('This a server specific server error.', 501);
 *
 *  // Client errors
 *  e = new ApiError('This is client error.', 498);
 *  e = new ApiError('This is client error.', 'token', 498); // where `token` is the frontend field: <input type="hiden" name="token">
 *  or
 *  e = new ApiError('This is client error.', 'token');
 *  e.status = 498;
 *
 *  // Client bundled error
 *  e = new ApiError(['This is preconditioned #1 client error.', 'This is preconditioned #2 client error.'], ['firstName', 'lastName']);
 *
 * @param {string|array} errorMessage
 * @param {string} [fieldName]
 * @param {number} [errorStatus] - 500 by default for the server and 412 for the client
 *
 * @returns {object} errorObject
 */
function ApiError(errorMessage, fieldName, errorStatus) {
    var e = null;

    if ( typeof(merge) != 'function' ) {
        merge = require('./../../../lib/merge');
    }
    // if ( typeof(statusCodes) == 'undefined' ) {
        var statusCodes = requireJSON(__dirname + '/../../../core/status.codes');
    // }

    if ( typeof(errorMessage) == 'object' && errorMessage instanceof Error ) {
        e = JSON.clone(errorMessage);
        errorMessage = e.message || e.stack;
    } else {
        e = new Error(errorMessage);
    }

    var isClientError = (arguments.length == 3) ? true : false;
    if ( arguments.length == 2 ) {
        // server error
        if ( typeof(arguments[1]) == 'number' ) {
            errorStatus = arguments[1];
            if (!e.status) {
                e.status = errorStatus;
            }
            fieldName = null;
        }
        // client error
        else if ( Array.isArray(arguments[1]) || typeof(arguments[1]) == 'string' ) {
            isClientError = true;
            errorStatus = 412; // by default
        }
        else {
            throw new Error('ApiError: Bad usage.');
        }
    } else if (arguments.length == 1) {
        fieldName   = null;
        errorStatus = null;
    }
    // Server Error
    if (!isClientError) {
        // TODO - Reformat stack to remove the first lines
        if (!e.status)
            e.status    = errorStatus || 500;

        if ( typeof(statusCodes[e.status]) != 'undefined' ) {
            e.error = statusCodes[e.status];
        } else {
            console.warn('[ ApiValidator ] statusCode `'+ e.status +'` not matching any definition in `'+_( getPath('gina').core + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
        }
        if (!e.message)
            e.message   = errorMessage;

        return e;
    }
    // Client Error
    e.status = errorStatus || 412;
    if ( typeof(statusCodes[e.status]) != 'undefined' ) {
        e.error = statusCodes[e.status];
    } else {
        console.warn('[ ApiValidator ] statusCode `'+ e.status +'` not matching any definition in `'+_( corePath + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
    }
    if (!fieldName) { // Client error without defined field
        e.message   = errorMessage;
        return e;
    }
    var ctx             = getContext();
    var clientError     = merge({
        tag     : '', // internal framework reference
        fields  : {},
        path    : ''
    }, e);


    var formatClientError = function(ctx, error, errorMessage, fieldName) {
        error.fields[fieldName] = errorMessage;
        var bundleName      = ctx.bundle
            , stackObj      = __stack[2]
        ;
        if ( typeof(stackObj) == 'object' ) {
            try {
                error.tag += bundleName +':';
                var filename    = stackObj.getFileName();
                var re          = new RegExp('('+bundleName+'\/)(model|controller)');
                if ( re.test(filename) ) {
                    var paths = getPaths(), path = null;
                    // model
                    if ( /model/i.test(filename) ) {
                        path = paths.models.substr(paths.models.lastIndexOf(bundleName)) +'/'+ filename.substr(filename.lastIndexOf(bundleName+'\/models'));
                        error.tag += 'model:'
                    }
                    // controller
                    else {
                        path = paths.controllers.substr(paths.controllers.lastIndexOf(bundleName)) +'/'+ filename.substr(filename.lastIndexOf(bundleName+'\/controllers'));
                        error.tag += 'controller:';
                        var controllerInstanceString = path.match(/controller\.(.*)\.js/)[1] || null;
                        error.tag += (controllerInstanceString) ? controllerInstanceString : 'controller:';
                    }
                    error.path = path;
                }
                var funcName = stackObj.getFunctionName();
                error.tag += funcName.replace(/\./g, ':') +'  :'+stackObj.getLineNumber()+':'+stackObj.getColumnNumber();
                //error.fields[fieldName][funcName] = errorMessage;
            } catch (err) {
                error.tag   = 'N/A';
                error.stack = err.stack;
            }
        } else {
            //error.fields[fieldName]['isApiError'] = errorMessage;
            error.tag   = 'N/A';
        }

        return error;
    }

    if ( Array.isArray(fieldName) ) {
        for (let i = 0, len = errorMessage.length; i < len; i++) {
            clientError = formatClientError(ctx, clientError, errorMessage[i], fieldName[i]);
        }
    } else {
        clientError = formatClientError(ctx, clientError, errorMessage, fieldName);
    }

    return clientError;
}
if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = ApiError;
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return ApiError });
}