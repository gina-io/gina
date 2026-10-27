'use strict';

/**
 * The body a page sent, readable by an e2e spec on every engine.
 *
 * gina's staged-upload layer sends its multipart body as a Blob (`xhr.send(new Blob([...]))`).
 * Playwright's WebKit gives the Node side no body for such a request: `request.postDataBuffer()`
 * is `null` in a route handler and in a `request` listener alike, while Chromium returns the
 * bytes (measured on WebKit 2370 and Chromium 1234). A mock that reads the staged file names out
 * of the body then answers "no files" on WebKit only, and the page fills nothing.
 *
 * `copyBlobBodies` is an init script: before a request leaves, it copies each Blob body the page
 * hands to `XMLHttpRequest.prototype.send` into the `x-e2e-request-body` request header (base64,
 * read synchronously through a `blob:` URL). `requestBody(request)` returns the native body when
 * Playwright has one, else the bytes of that header, else `null`. The copy suits the small bodies
 * e2e specs send.
 *
 * Usage, once per spec file:
 *
 *   const { copyBlobBodies, requestBody } = require('./helpers/request-body');
 *   test.beforeEach(async ({ context }) => { await context.addInitScript(copyBlobBodies); });
 */

/** The request header the init script writes. @constant {string} */
const HEADER = 'x-e2e-request-body';

/**
 * Init script: copies every Blob request body into the `x-e2e-request-body` header. Playwright
 * serializes the function into the page, so it closes over nothing: the header name is written
 * out in it.
 *
 * @returns {void}
 * @example
 *   test.beforeEach(async ({ context }) => { await context.addInitScript(copyBlobBodies); });
 */
function copyBlobBodies() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        if (body && typeof Blob !== 'undefined' && body instanceof Blob) {
            try {
                const url = URL.createObjectURL(body);
                const reader = new XMLHttpRequest();
                open.call(reader, 'GET', url, false);
                reader.overrideMimeType('text/plain; charset=x-user-defined');
                send.call(reader);
                URL.revokeObjectURL(url);
                const text = reader.responseText;
                let bytes = '';
                for (let i = 0; i < text.length; i++) { bytes += String.fromCharCode(text.charCodeAt(i) & 0xff); }
                this.setRequestHeader('x-e2e-request-body', btoa(bytes));
            } catch (e) {
                window.__e2eRequestBodyError = String(e);
            }
        }
        return send.apply(this, arguments);
    };
}

/**
 * The body of a request as the page sent it.
 *
 * @param {import('@playwright/test').Request} request - `route.request()`, or a `request` event's request
 * @returns {Buffer|null} the native body, else the copy `copyBlobBodies` put in the header, else `null`
 * @example
 *   const s = (requestBody(route.request()) || Buffer.alloc(0)).toString('latin1');
 */
function requestBody(request) {
    const native = request.postDataBuffer();
    if (native) { return native; }
    const copy = request.headers()[HEADER];
    return copy ? Buffer.from(copy, 'base64') : null;
}

module.exports = { copyBlobBodies, requestBody, HEADER };
