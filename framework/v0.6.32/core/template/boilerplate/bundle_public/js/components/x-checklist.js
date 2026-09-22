/**
 * <x-checklist> — reference client-side component (developer surface).
 *
 * Behavior-only class for the server-rendered markup authored in
 * templates/html/includes/x-checklist.html (the designer surface). The class
 * binds and enhances its own light-DOM subtree and holds NO markup strings —
 * repeatable markup is cloned from the <template data-role="item"> the server
 * renders inside the element.
 *
 * Conventions demonstrated (see the Client Components guide):
 *  - hydration: scalars via attributes (`collapsed`), one JSON payload via the
 *    component-owned `data-x-checklist` attribute;
 *  - data DOWN via observed attributes (attributeChangedCallback);
 *  - events UP via a composed, bubbling CustomEvent (`x-checklist:changed`);
 *  - eager definition: this file is a plain external script, declared once in
 *    config/templates.json `javascripts` and served from public/ (never from
 *    templates/handlers/ — handler files get the serve-time onGinaReady wrap);
 *  - open live resources (sockets, timers) in connectedCallback and close them
 *    in disconnectedCallback — this example holds none.
 *
 * The `gina-*` tag prefix is reserved for framework components; application
 * components pick their own prefix (`x-` here).
 */
(function () {
    'use strict';

    class XChecklist extends HTMLElement {

        static get observedAttributes() {
            return ['collapsed'];
        }

        /**
         * Binds the server-rendered subtree. Runs on every insertion —
         * including XHR-injected content such as popin bodies — so no manual
         * rebinding is ever needed. `_bound` guards re-insertion (moving the
         * element re-fires this callback).
         */
        connectedCallback() {
            if (this._bound) { return; }
            this._bound = true;

            var config = {};
            try {
                config = JSON.parse(this.getAttribute('data-x-checklist') || '{}');
            } catch (err) {
                config = {};
            }
            this._statusText = config.statusText || '%s of %s done';

            this._status   = this.querySelector('[data-role="status"]');
            this._list     = this.querySelector('ul');
            this._template = this.querySelector('template[data-role="item"]');

            var self = this;
            this.addEventListener('change', function (event) {
                if (event.target && /^checkbox$/i.test(event.target.type || '')) {
                    self._update();
                }
            });

            var form = this.querySelector('form[data-role="add"]');
            if (form) {
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    var input = form.querySelector('input[name="label"]');
                    var label = input ? input.value.trim() : '';
                    if (!label) { return; }
                    self.addItem(label);
                    input.value = '';
                });
            }

            this._applyCollapsed();
            this._update();
            if (this._status) {
                this._status.hidden = false;
            }
        }

        /**
         * Data DOWN — reacts to attribute writes from outside (a page handler,
         * another component's event wire, or plain DOM code).
         * @param {string} name
         */
        attributeChangedCallback(name) {
            if (name === 'collapsed' && this._bound) {
                this._applyCollapsed();
            }
        }

        /**
         * Appends one item cloned from the server-rendered template — dynamic
         * markup never comes from JS strings.
         * @param {string} label
         */
        addItem(label) {
            if (!this._template || !this._list) { return; }
            var fragment = this._template.content.cloneNode(true);
            var slot = fragment.querySelector('[data-role="item-label"]');
            if (slot) { slot.textContent = label; }
            this._list.appendChild(fragment);
            this._update();
        }

        /**
         * Applies the `collapsed` attribute state to the list.
         * @private
         */
        _applyCollapsed() {
            if (this._list) {
                this._list.hidden = this.hasAttribute('collapsed');
            }
        }

        /**
         * Renders the status line and emits the component's outbound event —
         * events UP, named `<tag>:<verb>`, composed + bubbling so page
         * handlers and peer components can subscribe at document level.
         * @private
         */
        _update() {
            if (!this._list) { return; }
            var total = this._list.querySelectorAll('input[type="checkbox"]').length;
            var done  = this._list.querySelectorAll('input[type="checkbox"]:checked').length;
            if (this._status) {
                this._status.textContent = this._statusText
                    .replace('%s', String(done))
                    .replace('%s', String(total));
            }
            this.dispatchEvent(new CustomEvent('x-checklist:changed', {
                bubbles  : true,
                composed : true,
                detail   : { done: done, total: total }
            }));
        }
    }

    customElements.define('x-checklist', XChecklist);
}());
