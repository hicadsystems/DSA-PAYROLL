// ============================================================================
// CUSTOM DROPDOWN  (v2)
// Replaces native <select>/<iselect> with a searchable dropdown while keeping
// a select-compatible API (value, options, selectedIndex, innerHTML,
// appendChild/add/remove, disabled, required, hidden, events ...).
//
// v2 fixes
//  1. No stale ID cache: getElementById always resolves against the live DOM,
//     so re-visited / sibling sections (same ids) get the live dropdown.
//  2. innerHTML = "" / placeholder-only / textContent = "" / replaceChildren()
//     really reset the list. appendChild/add/append/insertAdjacentHTML are
//     handled synchronously and additively; option.selected / disabled /
//     data-* are respected. Native "first option is selected" semantics.
//  3. Element.querySelector(All), matches() and closest() are patched too, and
//     a `select` type selector also matches converted dropdowns
//     (form.querySelectorAll("input, select"), cell.querySelector("select")).
//  4. hidden / required / class "hidden" / inline on* handlers / style / name
//     are carried to the wrapper. .value returns "" (never null).
//  5. Programmatic .value / selectedIndex only fire `change` when the value
//     actually changes, and never re-entrantly (no cascade loops).
//     innerHTML / option loading never fires events.
//  6. Numeric labels in search, single shared document/window listeners
//     (no leak per section), list is portaled to <body> (works inside
//     transformed modals), keyboard navigation, form reset, label[for].
//
// Opt-out: add `data-native` to a <select> (or to any ancestor container).
// ============================================================================

(function (global) {
  'use strict';

  if (global.__customDropdownLoaded) return; // guard against double include
  global.__customDropdownLoaded = true;

  // --------------------------------------------------------------------------
  // Native references (captured before any patching)
  // --------------------------------------------------------------------------
  const NATIVE = {
    getElementById: Document.prototype.getElementById,
    docQuerySelector: Document.prototype.querySelector,
    docQuerySelectorAll: Document.prototype.querySelectorAll,
    elQuerySelector: Element.prototype.querySelector,
    elQuerySelectorAll: Element.prototype.querySelectorAll,
    matches: Element.prototype.matches,
    closest: Element.prototype.closest,
    appendChild: Node.prototype.appendChild,
    insertBefore: Node.prototype.insertBefore,
    replaceChild: Node.prototype.replaceChild,
    remove: Element.prototype.remove,
    append: Element.prototype.append,
    prepend: Element.prototype.prepend,
    insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
    getAttribute: Element.prototype.getAttribute,
    setAttribute: Element.prototype.setAttribute,
    removeAttribute: Element.prototype.removeAttribute,
    inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'),
  };

  const WRAPPER_CLASS = 'custom-dropdown-wrapper';
  const LIST_CLASS = 'custom-dropdown-list';
  const instances = new Set();

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const same = (a, b) =>
    a !== null && a !== undefined && b !== null && b !== undefined &&
    str(a).trim() === str(b).trim();

  const escapeHtml = (s) =>
    str(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  function isOptionLike(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.__cddOption) return true; // pseudo option from wrapper.options[...]
    if (node.nodeType === 1) return node.tagName === 'OPTION' || node.tagName === 'OPTGROUP';
    if (node.nodeType === 11) return !!node.querySelector('option');
    return false;
  }

  function collectOptions(node, out) {
    if (!node) return out;
    if (node.nodeType === 1 && node.tagName === 'OPTION') {
      out.push(node);
    } else if (node.nodeType === 1) {
      Array.prototype.forEach.call(NATIVE.elQuerySelectorAll.call(node, 'option'), (o) => out.push(o));
    } else if (node.nodeType === 11) {
      Array.prototype.forEach.call(node.querySelectorAll('option'), (o) => out.push(o));
    }
    return out;
  }

  // fromMarkup = parsed from an HTML string (use the `selected` attribute);
  // otherwise use the live `selected` property (createElement + .selected = true).
  function readOptionNode(opt, fromMarkup) {
    const text = (opt.textContent || '').trim();
    const value = (opt.hasAttribute('value') ? opt.getAttribute('value') : text).trim();
    const attrs = {};
    Array.prototype.forEach.call(opt.attributes, (a) => { attrs[a.name] = a.value; });
    const group = opt.parentNode && opt.parentNode.tagName === 'OPTGROUP' ? opt.parentNode : null;
    return {
      value,
      text,
      selected: fromMarkup ? opt.hasAttribute('selected') : (opt.selected || opt.hasAttribute('selected')),
      disabled: !!(opt.disabled || (group && group.disabled)),
      attrs,
    };
  }

  function parseOptionsHTML(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = str(html);
    return Array.from(tpl.content.querySelectorAll('option'));
  }

  // Classes from the original <select> that are safe/meaningful on the wrapper.
  const STYLE_CLASS_RE = /^(?:[\w-]+:)*-?(?:border(?:-|$)|bg-|text-|p[xytblrse]?-(?:\d|px|\[)|rounded|shadow|ring(?:-|$)|outline|font-|leading-|tracking-|placeholder-|appearance-|cursor-|transition|duration-|ease-|h-|min-h-|max-h-|form-(?:select|input|control)|focus:|hover:)/;
  const TEXT_SIZE_RE = /^(?:[\w-]+:)*text-(?:xs|sm|base|lg|xl|\dxl)$/;

  function splitClasses(className) {
    const keep = [];
    const inputExtra = [];
    str(className).split(/\s+/).filter(Boolean).forEach((cls) => {
      if (TEXT_SIZE_RE.test(cls)) inputExtra.push(cls);
      if (!STYLE_CLASS_RE.test(cls) && cls !== WRAPPER_CLASS) keep.push(cls);
    });
    return { keep, inputExtra };
  }

  global.storageAvailable = (() => {
    try {
      const t = '__storage_test__';
      localStorage.setItem(t, t);
      localStorage.removeItem(t);
      return true;
    } catch (e) {
      return false;
    }
  })();

  // --------------------------------------------------------------------------
  // CustomDropdown
  // --------------------------------------------------------------------------
  class CustomDropdown {
    constructor(element, options = {}) {
      const el = typeof element === 'string'
        ? NATIVE.docQuerySelector.call(document, element)
        : element;
      if (!el) throw new Error('CustomDropdown: element not found');

      const defaults = {
        placeholder: 'Select...',
        searchEnabled: true,
        apiUrl: null,
        data: [],
        valueField: 'id',
        labelField: 'name',
        labelFormat: null,
        hiddenInputName: null,
        onSelect: null,
        className: '',
        maxHeight: '240px',
        loadingText: 'Loading...',
        errorText: 'Failed to load data',
        noResultsText: 'No results found',
        fetchHeaders: {},
        cacheData: true,
      };
      this.config = Object.assign({}, defaults);
      Object.keys(options).forEach((k) => {
        if (options[k] !== undefined) this.config[k] = options[k];
      });

      this.originalElement = el;
      this.element = null;

      // data / selection state
      this._data = [];
      this._cachedData = null;
      this.placeholderOption = null;
      this.selectedValue = null;
      this.selectedText = null;
      this.selectedItem = null;
      this.pendingValue = null;
      this._pendingFromUser = false;
      this._restoreValue = null;
      this._explicit = false;
      this._autoSelected = false;
      this._defaultValue = null;

      // ui state
      this.isOpen = false;
      this.isLoading = false;
      this.hasLoadedData = false;
      this._fetched = false;
      this._rendered = [];
      this._activeIndex = -1;
      this._focusOpenedAt = 0;
      this._dispatching = false;
      this.validationMessage = '';
      this.dataLoadedCallbacks = [];
      this.isInitialized = false;

      this._build();
    }

    // ---------------------------------------------------------------- data
    get data() { return this._data; }
    set data(value) {
      if (!Array.isArray(value)) {
        console.warn('CustomDropdown: data must be an array, got:', typeof value);
        value = [];
      }
      this._data = value;
      this.hasLoadedData = value.length > 0;
    }

    get pendingValueSet() { return this.pendingValue !== null; }

    _vf() { return this.config.valueField; }
    _lf() { return this.config.labelField; }
    _label(item) {
      if (!item) return '';
      return str(this.config.labelFormat ? this.config.labelFormat(item) : item[this._lf()]);
    }

    _findItem(value) {
      if (value === null || value === undefined || value === '') return null;
      const vf = this._vf();
      return this._data.find((i) => same(i[vf], value)) ||
             this._data.find((i) => same(this._label(i), value)) || null;
    }

    // ---------------------------------------------------------------- build
    _build() {
      const orig = this.originalElement;
      const parent = orig.parentNode;
      if (!parent) throw new Error('CustomDropdown: element is not attached to a parent');

      // read everything we need from the native select first
      const nativeOptions = orig.options ? Array.from(orig.options) : collectOptions(orig, []);
      const nativeSelected = (orig.selectedIndex >= 0 && orig.options) ? orig.options[orig.selectedIndex] : null;
      const firstOpt = nativeOptions[0];
      if (firstOpt && (firstOpt.value || '').trim() === '' && (firstOpt.textContent || '').trim()) {
        this.config.placeholder = firstOpt.textContent.trim();
      }

      const state = {
        id: orig.id,
        name: orig.getAttribute('name') || this.config.hiddenInputName || '',
        disabled: orig.disabled || orig.hasAttribute('disabled'),
        required: orig.required || orig.hasAttribute('required'),
        hidden: orig.hidden || orig.hasAttribute('hidden'),
        autofocus: orig.autofocus || orig.hasAttribute('autofocus'),
        tabIndex: orig.hasAttribute('tabindex') ? orig.tabIndex : null,
        attrs: Array.from(orig.attributes).map((a) => [a.name, a.value]),
      };
      const classes = splitClasses(orig.className);

      // wrapper
      const wrapper = document.createElement('div');
      wrapper.className = ['custom-dropdown-wrapper', 'relative']
        .concat(classes.keep, str(this.config.className).split(/\s+/).filter(Boolean))
        .join(' ');
      if (state.id) wrapper.id = state.id;

      const ro = this.config.searchEnabled ? '' : 'readonly style="cursor:pointer;"';
      wrapper.innerHTML = `
        <div class="relative w-full">
          <input type="text"
            class="custom-dropdown-search w-full border border-blue-500 focus:border-yellow-500 bg-transparent rounded-md px-3 py-2 focus:outline-none pr-10 ${classes.inputExtra.join(' ')}"
            placeholder="${escapeHtml(this.config.placeholder)}"
            autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" ${ro}>
          <span class="custom-dropdown-clear" title="Clear selection" aria-label="Clear selection" role="button" style="display:none;">&times;</span>
          <span class="custom-dropdown-arrow absolute inset-y-0 right-0 flex items-center pr-3 transition-transform duration-200" style="cursor:pointer;">
            <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        </div>
        <div class="${LIST_CLASS} bg-yellow-50 border border-gray-300 rounded-md shadow-lg overflow-hidden" role="listbox">
          <div class="py-1 custom-dropdown-items" style="max-height:${escapeHtml(this.config.maxHeight)};overflow-y:auto;overflow-x:hidden;"></div>
        </div>
        <input type="hidden" class="custom-dropdown-hidden">`;

      this.element = wrapper;
      this.searchInput = NATIVE.elQuerySelector.call(wrapper, '.custom-dropdown-search');
      this.dropdownList = NATIVE.elQuerySelector.call(wrapper, '.' + LIST_CLASS);
      this.dropdownItems = NATIVE.elQuerySelector.call(wrapper, '.custom-dropdown-items');
      this.hiddenInput = NATIVE.elQuerySelector.call(wrapper, '.custom-dropdown-hidden');
      this.arrow = NATIVE.elQuerySelector.call(wrapper, '.custom-dropdown-arrow');
      this.clearBtn = NATIVE.elQuerySelector.call(wrapper, '.custom-dropdown-clear');
      this.hiddenInput.name = state.name;
      this.dropdownList._customDropdown = this;

      // carry over attributes (data-*, aria-*, title, style, on*, form ...)
      const SKIP = new Set(['id', 'class', 'name', 'multiple', 'size', 'value', 'type',
        'disabled', 'required', 'hidden', 'autofocus', 'tabindex', 'data-dropdown-converted']);
      state.attrs.forEach(([name, value]) => {
        if (SKIP.has(name)) return;
        if (name === 'form') { this.hiddenInput.setAttribute('form', value); return; }
        try { NATIVE.setAttribute.call(wrapper, name, value); } catch (e) { /* ignore */ }
        if (name.startsWith('aria-')) this.searchInput.setAttribute(name, value);
      });
      if (state.name) NATIVE.setAttribute.call(wrapper, 'name', state.name);
      NATIVE.setAttribute.call(wrapper, 'data-dropdown-converted', 'true');

      // swap into the DOM
      NATIVE.replaceChild.call(parent, wrapper, orig);

      this._defineSelectApi();
      this._overrideDomMethods();
      this._setupOptionObserver();
      this._bindEvents();

      // initial options
      if (Array.isArray(this.config.data) && this.config.data.length > 0) {
        this.setData(this.config.data);
      } else if (nativeOptions.length) {
        const entries = nativeOptions.map((o) => Object.assign(readOptionNode(o, false), { selected: false }));
        this._addEntries(entries, { autoFirst: false, silent: true });
        if (nativeSelected && (nativeSelected.value || '').trim() !== '') {
          const item = this._findItem(nativeSelected.value.trim());
          if (item) this._applyItem(item);
        }
      }
      this._defaultValue = this.selectedValue;

      // attributes that map to behaviour
      if (state.disabled) wrapper.disabled = true;
      if (state.required) wrapper.required = true;
      if (state.hidden) wrapper.hidden = true;
      if (state.tabIndex !== null) this.searchInput.tabIndex = state.tabIndex;
      if (state.autofocus) {
        this.searchInput.autofocus = true;
        queueMicrotask(() => { try { this.searchInput.focus(); } catch (e) { /* ignore */ } });
      }

      wrapper._customDropdown = this;
      instances.add(this);
      this.isInitialized = true;
    }

    // --------------------------------------------------- select-compatible API
    _defineSelectApi() {
      const self = this;
      const w = this.element;
      const def = (prop, desc) =>
        Object.defineProperty(w, prop, Object.assign({ enumerable: true, configurable: true }, desc));

      def('value', {
        get: () => (self.selectedValue === null ? '' : str(self.selectedValue)),
        set: (v) => { self.setValue(v, true); },
      });
      def('text', { get: () => self.selectedText || '' });
      def('name', {
        get: () => self.hiddenInput.name,
        set: (v) => {
          self.hiddenInput.name = str(v);
          NATIVE.setAttribute.call(w, 'name', str(v));
        },
      });
      def('type', { get: () => 'select-one' });
      def('multiple', { get: () => false, set: () => {} });
      def('length', { get: () => self._optionList().length });

      def('disabled', {
        get: () => self.searchInput.disabled,
        set: (val) => {
          const on = !!val;
          self.searchInput.disabled = on;
          self.hiddenInput.disabled = on;
          if (on) {
            NATIVE.setAttribute.call(w, 'disabled', '');
            w.classList.add('opacity-50', 'cursor-not-allowed');
            self.searchInput.classList.add('cursor-not-allowed');
            self.close();
          } else {
            NATIVE.removeAttribute.call(w, 'disabled');
            w.classList.remove('opacity-50', 'cursor-not-allowed');
            self.searchInput.classList.remove('cursor-not-allowed');
          }
          self._updateClearBtn();
        },
      });

      def('hidden', {
        get: () => w.hasAttribute('hidden') || w.style.display === 'none',
        set: (val) => {
          if (val) {
            NATIVE.setAttribute.call(w, 'hidden', '');
            w.style.display = 'none';
            self.close();
          } else {
            NATIVE.removeAttribute.call(w, 'hidden');
            if (w.style.display === 'none') w.style.display = '';
          }
        },
      });

      def('required', {
        get: () => self.searchInput.required,
        set: (val) => {
          self.searchInput.required = !!val;
          if (val) NATIVE.setAttribute.call(w, 'required', '');
          else NATIVE.removeAttribute.call(w, 'required');
        },
      });

      def('readOnly', {
        get: () => self.searchInput.readOnly,
        set: (val) => { self.searchInput.readOnly = !!val; },
      });

      def('tabIndex', {
        get: () => self.searchInput.tabIndex,
        set: (val) => { self.searchInput.tabIndex = val; },
      });

      def('options', { get: () => self._optionList() });
      def('selectedOptions', {
        get: () => self._optionList().filter((o) => o.selected && (o.value !== '' || self.selectedValue === null)),
      });

      def('selectedIndex', {
        get: () => self._optionList().findIndex((o) => o.selected),
        set: (index) => {
          const list = self._optionList();
          const i = Number(index);
          if (!(i >= 0) || i >= list.length || list[i].value === '') {
            self._clearSelection(true);
            return;
          }
          self.setValue(list[i].value, true);
        },
      });

      def('innerHTML', {
        get: () => self._optionsHTML(),
        set: (html) => {
          self._resetOptions();
          const nodes = parseOptionsHTML(html);
          if (nodes.length) self._addNodes(nodes, true);
          else self._afterDataChange();
        },
      });

      const resetText = {
        get: () => self._optionList().map((o) => o.text).join(''),
        set: () => { self._resetOptions(); self._afterDataChange(); },
      };
      def('textContent', resetText);
      def('innerText', resetText);

      def('validationMessage', { get: () => self.validationMessage || self.searchInput.validationMessage });
      def('validity', { get: () => self.searchInput.validity });
      def('willValidate', { get: () => !self.searchInput.disabled });
      def('form', { get: () => self.hiddenInput.form });
      def('labels', {
        get: () => (w.id ? Array.from(NATIVE.docQuerySelectorAll.call(document, `label[for="${CSS.escape(w.id)}"]`)) : []),
      });

      w.setCustomValidity = (message) => {
        self.validationMessage = message || '';
        self.searchInput.setCustomValidity(message || '');
      };
      w.checkValidity = () => self.searchInput.checkValidity();
      w.reportValidity = () => self.searchInput.reportValidity();
      w.focus = (opts) => self.searchInput.focus(opts);
      w.blur = () => self.searchInput.blur();
      w.item = (i) => self._optionList()[i] || null;
      w.namedItem = (n) => self._optionList().find((o) => o.getAttribute('id') === n || o.getAttribute('name') === n) || null;

      w.getAttribute = function (attr) {
        if (attr === 'name') return self.hiddenInput.name || NATIVE.getAttribute.call(w, attr);
        if (attr === 'value') return w.value;
        return NATIVE.getAttribute.call(w, attr);
      };
      w.setAttribute = function (attr, value) {
        const a = str(attr).toLowerCase();
        if (a === 'name') { w.name = value; return; }
        if (a === 'disabled') { w.disabled = true; return; }
        if (a === 'required') { w.required = true; return; }
        if (a === 'hidden') { w.hidden = true; return; }
        if (a === 'readonly') { w.readOnly = true; return; }
        if (a === 'value') { w.value = value; return; }
        if (a === 'placeholder') { self._setPlaceholder(value); return; }
        NATIVE.setAttribute.call(w, attr, value);
      };
      w.removeAttribute = function (attr) {
        const a = str(attr).toLowerCase();
        if (a === 'disabled') { w.disabled = false; return; }
        if (a === 'required') { w.required = false; return; }
        if (a === 'hidden') { w.hidden = false; return; }
        if (a === 'readonly') { w.readOnly = false; return; }
        NATIVE.removeAttribute.call(w, attr);
      };

      // form.elements[name] returns the hidden input; keep it in sync both ways
      Object.defineProperty(this.hiddenInput, 'value', {
        configurable: true,
        get: () => w.value,
        set: (v) => { self.setValue(v, true); },
      });
    }

    _overrideDomMethods() {
      const self = this;
      const w = this.element;

      w.appendChild = function (node) {
        if (isOptionLike(node)) { self._addNodes([node], false); return node; }
        return NATIVE.appendChild.call(this, node);
      };
      w.insertBefore = function (node, ref) {
        if (isOptionLike(node)) { self._addNodes([node], false); return node; }
        return NATIVE.insertBefore.call(this, node, ref);
      };
      w.append = function (...nodes) {
        const opts = nodes.filter(isOptionLike);
        const rest = nodes.filter((n) => !isOptionLike(n));
        if (opts.length) self._addNodes(opts, false);
        if (rest.length) NATIVE.append.apply(this, rest);
      };
      w.prepend = function (...nodes) {
        const opts = nodes.filter(isOptionLike);
        const rest = nodes.filter((n) => !isOptionLike(n));
        if (opts.length) self._addNodes(opts, false);
        if (rest.length) NATIVE.prepend.apply(this, rest);
      };
      w.add = function (option) { if (option) self._addNodes([option], false); };
      w.remove = function (index) {
        if (typeof index === 'number') { self._removeAt(index); return; }
        self.destroy();
      };
      w.replaceChildren = function (...nodes) {
        self._resetOptions();
        const opts = nodes.filter(isOptionLike);
        if (opts.length) self._addNodes(opts, false);
        else self._afterDataChange();
      };
      w.insertAdjacentHTML = function (position, html) {
        if (/<option/i.test(str(html))) { self._addNodes(parseOptionsHTML(html), true); return; }
        return NATIVE.insertAdjacentHTML.call(this, position, html);
      };
    }

    // Fallback for options inserted with untracked native calls
    _setupOptionObserver() {
      this.cleanupObserver = new MutationObserver((mutations) => {
        const found = [];
        mutations.forEach((m) => {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'OPTION' || n.tagName === 'OPTGROUP') collectOptions(n, found);
          });
        });
        if (found.length) this._addNodes(found, false);
      });
      this.cleanupObserver.observe(this.element, { childList: true, subtree: true });
    }

    // ------------------------------------------------------ option handling
    _addNodes(nodes, fromMarkup) {
      const opts = [];
      const pseudo = [];
      nodes.forEach((n) => {
        if (n && n.__cddOption) pseudo.push(n);
        else collectOptions(n, opts);
      });
      // Re-inserted options taken from .options[i] (e.g. "save first option,
      // clear, append it back"). Their old `selected` flag is ignored so the
      // normal restore/pending logic decides the selection.
      const entries = pseudo.map((o) => ({
        value: str(o.value).trim(),
        text: str(o.text).trim(),
        selected: false,
        disabled: !!o.disabled,
        attrs: Object.assign({}, o.__attrs || {}),
      })).concat(opts.map((o) => readOptionNode(o, fromMarkup)));
      opts.forEach((o) => { if (o.parentNode && o.parentNode.nodeType === 1) o.parentNode.removeChild(o); });
      this._addEntries(entries, { autoFirst: true });
    }

    _addEntries(entries, { autoFirst = true, silent = false } = {}) {
      const vf = this._vf();
      const lf = this._lf();
      const before = this.selectedValue;
      let fireForPending = false;

      entries.forEach((e) => {
        const isFirst = this._data.length === 0 && !this.placeholderOption;

        if (e.value === '') {
          if (!this.placeholderOption) this.placeholderOption = { text: e.text, attrs: e.attrs || {} };
          if (e.text) this._setPlaceholder(e.text);
          if (e.selected) {
            this._explicit = true;
            this._autoSelected = false;
            this._applyItem(null);
          }
          return;
        }

        const item = { [vf]: e.value, [lf]: e.text, __disabled: !!e.disabled, __attrs: e.attrs || {} };
        this._data.push(item);

        if (e.selected) {
          this._explicit = true;
          this._autoSelected = false;
          this.pendingValue = null;
          this._applyItem(item);
          return;
        }
        if (this._explicit) return;
        if (this.selectedValue !== null && !this._autoSelected) return;

        if (this.pendingValue !== null && (same(item[vf], this.pendingValue) || same(e.text, this.pendingValue))) {
          this._applyItem(item);
          this._autoSelected = false;
          if (this._pendingFromUser) fireForPending = true;
          this.pendingValue = null;
          this._pendingFromUser = false;
          return;
        }
        if (this._restoreValue !== null && same(item[vf], this._restoreValue)) {
          this._applyItem(item);
          this._autoSelected = false;
          return;
        }
        if (autoFirst && isFirst && this.selectedValue === null) {
          this._applyItem(item);
          this._autoSelected = true;
        }
      });

      this._afterDataChange();
      if (!silent && fireForPending && !same(before, this.selectedValue)) {
        this._emitChange(this.selectedItem, false);
      }
    }

    _resetOptions() {
      this._restoreValue = this.selectedValue;
      this._data = [];
      this.placeholderOption = null;
      this._explicit = false;
      this._autoSelected = false;
      this.hasLoadedData = false;
      this._applyItem(null);
    }

    _removeAt(index) {
      const offset = this.placeholderOption ? 1 : 0;
      if (offset && index === 0) {
        this.placeholderOption = null;
      } else {
        const i = index - offset;
        if (i < 0 || i >= this._data.length) return;
        const [removed] = this._data.splice(i, 1);
        if (removed && same(removed[this._vf()], this.selectedValue)) this._applyItem(null);
      }
      this._afterDataChange();
    }

    _afterDataChange() {
      this.hasLoadedData = this._data.length > 0;
      if (this.isOpen && !this.isLoading) this.renderItems(this._data);
      this.triggerDataLoaded();
    }

    _optionList() {
      const list = [];
      const self = this;
      const make = (value, text, attrs, disabled, selected) => {
        const a = attrs || {};
        const dataset = {};
        Object.keys(a).forEach((k) => {
          if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = a[k];
        });
        const opt = {
          value,
          text,
          label: text,
          textContent: text,
          innerText: text,
          index: list.length,
          selected,
          defaultSelected: Object.prototype.hasOwnProperty.call(a, 'selected'),
          disabled: !!disabled,
          dataset,
          tagName: 'OPTION',
          nodeName: 'OPTION',
          __cddOption: true,
          __attrs: a,
          remove: () => self._removeAt(list.indexOf(opt)),
          getAttribute: (n) => (n === 'value' ? value : (Object.prototype.hasOwnProperty.call(a, n) ? a[n] : null)),
          hasAttribute: (n) => n === 'value' || Object.prototype.hasOwnProperty.call(a, n),
        };
        return opt;
      };
      if (this.placeholderOption) {
        list.push(make('', this.placeholderOption.text, this.placeholderOption.attrs, false, this.selectedValue === null));
      }
      this._data.forEach((item) => {
        list.push(make(str(item[this._vf()]), this._label(item), item.__attrs, item.__disabled,
          same(item[this._vf()], this.selectedValue)));
      });
      list.selectedIndex = list.findIndex((o) => o.selected);
      list.item = (i) => list[i] || null;
      list.add = (opt) => self.element.add(opt);
      list.remove = (i) => self._removeAt(i);
      return list;
    }

    _optionsHTML() {
      let html = '';
      if (this.placeholderOption) {
        html += `<option value=""${this.selectedValue === null ? ' selected' : ''}>${escapeHtml(this.placeholderOption.text)}</option>`;
      }
      this._data.forEach((item) => {
        const v = item[this._vf()];
        html += `<option value="${escapeHtml(v)}"${same(v, this.selectedValue) ? ' selected' : ''}${item.__disabled ? ' disabled' : ''}>${escapeHtml(this._label(item))}</option>`;
      });
      return html;
    }

    _setPlaceholder(text) {
      this.config.placeholder = str(text);
      if (this.searchInput) this.searchInput.placeholder = str(text);
    }

    // ---------------------------------------------------------- selection
    _applyItem(item) {
      if (item) {
        this.selectedValue = item[this._vf()];
        this.selectedText = this._label(item);
        this.selectedItem = item;
      } else {
        this.selectedValue = null;
        this.selectedText = null;
        this.selectedItem = null;
      }
      if (this.searchInput) this.searchInput.value = this.selectedText || '';
      if (this.hiddenInput) NATIVE.inputValue.set.call(this.hiddenInput, this.selectedValue === null ? '' : str(this.selectedValue));
      this._updateClearBtn();
    }

    _updateClearBtn() {
      if (!this.clearBtn) return;
      const show = this.selectedValue !== null && !(this.searchInput && this.searchInput.disabled);
      this.clearBtn.style.display = show ? 'flex' : 'none';
      if (this.searchInput) this.searchInput.style.paddingRight = show ? '4rem' : '';
    }

    // user cleared the field (placeholder item or the × button)
    _userClear() {
      const had = this.selectedValue !== null;
      this._clearSelection(false);
      this._explicit = true;
      this.close();
      if (had) this._emitChange(null, true);
    }

    _emitChange(item, withInput) {
      if (this._dispatching) return; // no re-entrant cascades
      this._dispatching = true;
      try {
        const value = this.selectedValue;
        const text = this.selectedText || '';
        if (item && typeof this.config.onSelect === 'function') {
          try { this.config.onSelect(value, text, item); } catch (e) { console.error('CustomDropdown onSelect error:', e); }
        }
        if (withInput) this.element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        this.element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        this.element.dispatchEvent(new CustomEvent('dropdown:change', {
          detail: { value, text, data: item || null },
          bubbles: true,
          cancelable: true,
        }));
      } finally {
        this._dispatching = false;
      }
    }

    _clearSelection(fireEvents) {
      const had = this.selectedValue !== null;
      this.pendingValue = null;
      this._pendingFromUser = false;
      this._restoreValue = null;
      this._autoSelected = false;
      this._applyItem(null);
      if (fireEvents && had) this._emitChange(null, false);
    }

    // user picked an item from the list
    selectItem(value, text, fullData) {
      const item = fullData || this._findItem(value);
      if (!item || item.__disabled) return;
      const changed = !same(this.selectedValue, item[this._vf()]);
      this.pendingValue = null;
      this._pendingFromUser = false;
      this._restoreValue = null;
      this._autoSelected = false;
      this._explicit = true;
      this._applyItem(item);
      this.close();
      if (changed) this._emitChange(item, true);
    }

    getValue() { return this.selectedValue === null ? '' : str(this.selectedValue); }
    getText() { return this.selectedText || ''; }

    _setValueInternal(value, fireEvents = true) {
      if (value === null || value === undefined || str(value).trim() === '') {
        this._clearSelection(fireEvents);
        return true;
      }
      const item = this._findItem(value);
      if (item) {
        const changed = !same(this.selectedValue, item[this._vf()]);
        this.pendingValue = null;
        this._pendingFromUser = false;
        this._restoreValue = null;
        this._autoSelected = false;
        this._applyItem(item);
        if (fireEvents && changed) this._emitChange(item, false);
        return true;
      }
      // not available (yet): remember it and apply when options arrive
      this.pendingValue = value;
      this._pendingFromUser = !!fireEvents;
      this._restoreValue = null;
      if (this.selectedValue !== null) this._applyItem(null);
      return false;
    }

    setValue(value, fireEvents = true) {
      return this._setValueInternal(value, fireEvents);
    }

    clear() { this._clearSelection(true); }

    _resetToDefault() {
      if (this._defaultValue !== null) this._setValueInternal(this._defaultValue, false);
      else this._clearSelection(false);
    }

    // ------------------------------------------------------------- remote
    setData(data) {
      if (!Array.isArray(data)) {
        console.warn('CustomDropdown.setData: data must be an array');
        data = [];
      }
      const keep = this.selectedValue;
      const target = this.pendingValue !== null ? this.pendingValue : keep;
      const fromUser = this.pendingValue !== null && this._pendingFromUser;
      this._data = data.slice();
      this._applyItem(null);
      if (target !== null) {
        const item = this._findItem(target);
        if (item) {
          this._applyItem(item);
          if (this.pendingValue !== null) {
            this.pendingValue = null;
            this._pendingFromUser = false;
            if (fromUser && !same(keep, this.selectedValue)) {
              this._afterDataChange();
              this._emitChange(item, false);
              return;
            }
          }
        }
      }
      this._afterDataChange();
    }

    async fetchData(openAfter = false) {
      if (this.config.cacheData && this._cachedData && this._cachedData.length > 0) {
        this.setData(this._cachedData);
        this._fetched = true;
        if (openAfter) this.open();
        else if (this.isOpen) this.renderItems(this._data);
        return;
      }
      if (this.isLoading || !this.config.apiUrl) return;

      this.isLoading = true;
      if (openAfter) this.showLoading();
      try {
        const token = global.storageAvailable ? localStorage.getItem('token') : null;
        const headers = Object.assign({ 'Content-Type': 'application/json' },
          token ? { Authorization: `Bearer ${token}` } : {}, this.config.fetchHeaders);
        const response = await fetch(this.config.apiUrl, { method: 'GET', headers });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();

        let rows = [];
        if (Array.isArray(result)) rows = result;
        else if (result && Array.isArray(result.data)) rows = result.data;

        if (this.config.cacheData) this._cachedData = rows;
        this._fetched = true;
        this.isLoading = false;
        this.setData(rows);
        if (this.isOpen) this.renderItems(this._data);
      } catch (error) {
        console.error('CustomDropdown fetch error:', error);
        this.isLoading = false;
        this.showError();
      } finally {
        this.isLoading = false;
      }
    }

    refresh() {
      this._cachedData = null;
      this._fetched = false;
      this.hasLoadedData = false;
      this._data = [];
      if (this.config.apiUrl) this.fetchData();
    }

    onDataLoaded(callback) {
      if (this._data.length > 0) callback();
      else this.dataLoadedCallbacks.push(callback);
    }

    triggerDataLoaded() {
      if (this._data.length === 0) return;
      while (this.dataLoadedCallbacks.length > 0) {
        const cb = this.dataLoadedCallbacks.shift();
        try { cb(); } catch (e) { console.error('Error in data loaded callback:', e); }
      }
    }

    // ---------------------------------------------------------------- UI
    _bindEvents() {
      const input = this.searchInput;

      input.addEventListener('focus', () => {
        if (this.element.disabled) return;
        if (!this.isOpen) {
          this._focusOpenedAt = Date.now();
          this.open();
        }
        if (this.config.searchEnabled) {
          try { input.select(); } catch (e) { /* ignore */ }
        }
      });

      input.addEventListener('click', (e) => {
        if (this.element.disabled) return;
        if (!this.isOpen) { this.open(); return; }
        if (!this.config.searchEnabled && Date.now() - this._focusOpenedAt > 300) {
          e.preventDefault();
          this.close();
        }
      });

      // typing in the search box is NOT a value change for page listeners
      input.addEventListener('input', (e) => {
        e.stopPropagation();
        if (!this.config.searchEnabled) return;
        if (!this.isOpen) this.open();
        this.filterItems(input.value);
      });
      input.addEventListener('change', (e) => e.stopPropagation());

      input.addEventListener('keydown', (e) => this._onKeyDown(e));

      input.addEventListener('blur', () => {
        setTimeout(() => {
          const active = document.activeElement;
          if (active && (this.element.contains(active) || this.dropdownList.contains(active))) return;
          this.close();
        }, 150);
      });

      this.arrow.addEventListener('mousedown', (e) => e.preventDefault());
      this.arrow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.element.disabled) return;
        if (this.isOpen) this.close();
        else { this.open(); input.focus(); }
      });

      this.clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
      this.clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.element.disabled) return;
        this._userClear();
      });

      // keep focus in the input while interacting with the list
      this.dropdownList.addEventListener('mousedown', (e) => e.preventDefault());
      this.dropdownItems.addEventListener('click', (e) => {
        const el = e.target.closest ? NATIVE.closest.call(e.target, '.custom-dropdown-item') : null;
        if (!el) return;
        this._pickRendered(this._rendered[Number(el.getAttribute('data-index'))]);
      });
    }

    _pickRendered(item) {
      if (!item) return;
      if (item.__placeholder) { this._userClear(); return; }
      this.selectItem(item[this._vf()], this._label(item), item);
    }

    _onKeyDown(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!this.isOpen) this.open();
          else this._moveActive(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!this.isOpen) this.open();
          else this._moveActive(-1);
          break;
        case 'Enter':
          if (this.isOpen) {
            e.preventDefault();
            this._pickRendered(this._rendered[this._activeIndex]);
          }
          break;
        case 'Escape':
          if (this.isOpen) { e.preventDefault(); this.close(); }
          break;
        case 'Tab':
          this.close();
          break;
        default:
          break;
      }
    }

    _moveActive(step) {
      const n = this._rendered.length;
      if (!n) return;
      let i = this._activeIndex;
      for (let k = 0; k < n; k++) {
        i = (i + step + n) % n;
        if (!this._rendered[i].__disabled) break;
      }
      this._setActive(i);
    }

    _setActive(i) {
      this._activeIndex = i;
      const nodes = NATIVE.elQuerySelectorAll.call(this.dropdownItems, '.custom-dropdown-item');
      nodes.forEach((n, idx) => n.classList.toggle('cdd-active', idx === i));
      const node = nodes[i];
      if (!node) return;
      // scroll only the list container (scrollIntoView could scroll the page)
      const c = this.dropdownItems;
      const top = node.offsetTop - c.offsetTop;
      if (top < c.scrollTop) c.scrollTop = top;
      else if (top + node.offsetHeight > c.scrollTop + c.clientHeight) {
        c.scrollTop = top + node.offsetHeight - c.clientHeight;
      }
    }

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    // The placeholder ("Select ...") is shown faint at the top of the list;
    // picking it clears the selection. Hidden while a search filter is active.
    _placeholderEntry() {
      const text = (this.placeholderOption && this.placeholderOption.text) ||
        (this.config.apiUrl ? this.config.placeholder : '');
      return text ? { __placeholder: true, text } : null;
    }

    renderItems(items, showPlaceholder = true) {
      const list = (items || []).slice();
      const ph = showPlaceholder && list.length ? this._placeholderEntry() : null;
      if (ph) list.unshift(ph);
      this._rendered = list;
      if (!list.length) {
        this.dropdownItems.innerHTML = `<div class="px-3 py-4 text-center text-gray-500">${escapeHtml(this.config.noResultsText)}</div>`;
        this._activeIndex = -1;
        return;
      }
      let active = -1;
      let html = '';
      this._rendered.forEach((item, idx) => {
        if (item.__placeholder) {
          html += `<div class="custom-dropdown-item cdd-placeholder px-3 py-2 cursor-pointer border-b border-gray-100" role="option" aria-selected="${this.selectedValue === null}" data-index="${idx}">${escapeHtml(item.text)}</div>`;
          return;
        }
        const selected = same(item[this._vf()], this.selectedValue);
        if (selected) active = idx;
        const cls = 'custom-dropdown-item px-3 py-2 cursor-pointer border-b border-gray-100 transition-colors' +
          (selected ? ' cdd-selected bg-blue-100' : '') + (item.__disabled ? ' cdd-disabled' : '');
        html += `<div class="${cls}" role="option" aria-selected="${selected}" data-index="${idx}">${escapeHtml(this._label(item))}</div>`;
      });
      this.dropdownItems.innerHTML = html;
      this._setActive(active);
    }

    filterItems(searchText) {
      const q = str(searchText).trim().toLowerCase();
      const filtered = !q ? this._data : this._data.filter((item) => this._label(item).toLowerCase().includes(q));
      this.renderItems(filtered, !q);
      if (q && filtered.length) {
        const first = this._rendered.findIndex((i) => !i.__disabled && !i.__placeholder);
        if (first >= 0) this._setActive(first);
      }
    }

    _portal() {
      if (this.dropdownList.parentNode !== document.body) {
        NATIVE.appendChild.call(document.body, this.dropdownList);
      }
    }

    _unportal() {
      if (this.dropdownList.parentNode === document.body) {
        if (this.element.isConnected) NATIVE.appendChild.call(this.element, this.dropdownList);
        else this.dropdownList.parentNode.removeChild(this.dropdownList);
      }
    }

    positionDropdown() {
      if (!this.element.isConnected) { this.close(); return; }
      const rect = this.searchInput.getBoundingClientRect();
      const vh = window.innerHeight;
      const below = vh - rect.bottom;
      const above = rect.top;
      const wanted = parseInt(this.config.maxHeight, 10) || 240;
      const list = this.dropdownList.style;

      list.position = 'fixed';
      list.zIndex = '2147483000';
      list.left = rect.left + 'px';
      list.width = rect.width + 'px';
      if (below < wanted + 8 && above > below) {
        list.top = 'auto';
        list.bottom = (vh - rect.top + 4) + 'px';
        this.dropdownItems.style.maxHeight = Math.min(wanted, above - 12) + 'px';
      } else {
        list.bottom = 'auto';
        list.top = (rect.bottom + 4) + 'px';
        this.dropdownItems.style.maxHeight = Math.min(wanted, Math.max(below - 12, 120)) + 'px';
      }
    }

    open() {
      if (this.element.disabled || this.searchInput.disabled) return;
      if (!this.element.isConnected) return;

      instances.add(this); // re-register if it was pruned while detached

      if (this.config.apiUrl && !this._fetched && !this.hasLoadedData) {
        this.fetchData(true);
        return;
      }

      this._portal();
      this.dropdownList.classList.add('cdd-open');
      this.isOpen = true;
      this.searchInput.setAttribute('aria-expanded', 'true');
      this.positionDropdown();
      this.renderItems(this._data);
      if (this.arrow) this.arrow.style.transform = 'scaleY(-1)';
    }

    close() {
      if (this.dropdownList) {
        this.dropdownList.classList.remove('cdd-open');
        this._unportal();
      }
      if (this.arrow) this.arrow.style.transform = 'scaleY(1)';
      if (this.searchInput) {
        this.searchInput.setAttribute('aria-expanded', 'false');
        // drop any half-typed search text; show the real selection
        this.searchInput.value = this.selectedText || '';
      }
      this.isOpen = false;
      this._activeIndex = -1;
      if (this.dropdownItems && !this.isLoading) this.dropdownItems.innerHTML = '';
    }

    showLoading() {
      this._portal();
      this.dropdownList.classList.add('cdd-open');
      this.isOpen = true;
      this.positionDropdown();
      this.dropdownItems.innerHTML = `
        <div class="px-3 py-4 text-center text-gray-500">
          <svg class="cdd-spin h-5 w-5 mx-auto mb-2" style="width:20px;height:20px;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle style="opacity:.25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path style="opacity:.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          ${escapeHtml(this.config.loadingText)}
        </div>`;
    }

    showError() {
      this.dropdownItems.innerHTML = `<div class="px-3 py-4 text-center text-red-500">${escapeHtml(this.config.errorText)}</div>`;
    }

    destroy() {
      this.close();
      if (this.cleanupObserver) this.cleanupObserver.disconnect();
      instances.delete(this);
      if (this.dropdownList && this.dropdownList.parentNode) this.dropdownList.parentNode.removeChild(this.dropdownList);
      NATIVE.remove.call(this.element);
    }
  }

  CustomDropdown.instances = instances;
  global.CustomDropdown = CustomDropdown;

  // --------------------------------------------------------------------------
  // Shared document/window listeners (one set for all instances)
  // --------------------------------------------------------------------------
  function pruneAndEachOpen(fn) {
    instances.forEach((inst) => {
      if (!inst.element.isConnected) {
        // section was replaced: release it (open() re-registers if re-attached)
        if (inst.isOpen) inst.close();
        instances.delete(inst);
        return;
      }
      if (inst.isOpen) fn(inst);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    pruneAndEachOpen((inst) => {
      if (!inst.element.contains(t) && !inst.dropdownList.contains(t)) inst.close();
    });
  }, true);

  // <label for="id"> → focus the dropdown
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    const label = NATIVE.closest.call(t, 'label[for]');
    if (!label) return;
    const target = NATIVE.getElementById.call(document, label.getAttribute('for'));
    if (target && target._customDropdown) target._customDropdown.searchInput.focus();
  });

  window.addEventListener('scroll', (e) => {
    const t = e.target;
    pruneAndEachOpen((inst) => {
      if (t && t.nodeType === 1 && inst.dropdownList.contains(t)) return;
      inst.positionDropdown();
    });
  }, true);

  window.addEventListener('resize', () => pruneAndEachOpen((inst) => inst.positionDropdown()));

  document.addEventListener('reset', (e) => {
    const form = e.target;
    setTimeout(() => {
      instances.forEach((inst) => {
        if (inst.element.isConnected && form.contains && form.contains(inst.element)) inst._resetToDefault();
      });
    }, 0);
  }, true);

  // --------------------------------------------------------------------------
  // Styles
  // --------------------------------------------------------------------------
  const style = document.createElement('style');
  style.setAttribute('data-custom-dropdown', '');
  style.textContent = `
    select:not([data-native]):not([data-dropdown-failed]):not([multiple]):not([size]) { opacity: 0; }
    [data-native] select { opacity: 1 !important; }
    .custom-dropdown-wrapper { opacity: 1 !important; }
    /* page CSS written for the <select> (e.g. .pr-select) may land on the
       wrapper: drop its box styling so only the inner input draws a border */
    .custom-dropdown-wrapper {
      border: 0 !important; padding: 0 !important; background: transparent !important;
      box-shadow: none !important; outline: none !important; border-radius: 0 !important;
      height: auto !important; appearance: none !important;
    }
    .custom-dropdown-wrapper[hidden] { display: none !important; }
    .custom-dropdown-list { display: none; position: fixed; z-index: 2147483000; background: #fefce8; border: 1px solid #d1d5db; border-radius: 6px; box-shadow: 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1); overflow: hidden; color: #111827; text-align: left; }
    .custom-dropdown-list.cdd-open { display: block; }
    .custom-dropdown-items { min-height: 0; box-sizing: border-box; }
    .custom-dropdown-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f3f4f6; }
    .custom-dropdown-item:hover, .custom-dropdown-item.cdd-active { background: #eff6ff; }
    .custom-dropdown-item.cdd-selected { background: #dbeafe; }
    .custom-dropdown-item.cdd-disabled { opacity: .5; cursor: not-allowed; }
    .custom-dropdown-item.cdd-placeholder { color: #9ca3af; background: transparent; }
    .custom-dropdown-item.cdd-placeholder:hover, .custom-dropdown-item.cdd-placeholder.cdd-active { color: #6b7280; background: #f3f4f6; }
    .custom-dropdown-clear { position: absolute; top: 0; bottom: 0; right: 2.25rem; align-items: center; padding: 0 .25rem; font-size: 1.25rem; line-height: 1; color: #9ca3af; cursor: pointer; user-select: none; }
    .custom-dropdown-clear:hover { color: #ef4444; }
    .custom-dropdown-items::-webkit-scrollbar { width: 8px; }
    .custom-dropdown-items::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 4px; }
    .custom-dropdown-items::-webkit-scrollbar-thumb { background: #888; border-radius: 4px; }
    .custom-dropdown-items::-webkit-scrollbar-thumb:hover { background: #555; }
    .custom-dropdown-search:focus { border-color: #eab308 !important; outline: none; }
    .custom-dropdown-search:disabled { cursor: not-allowed; }
    @keyframes cdd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .cdd-spin { animation: cdd-spin 1s linear infinite; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // --------------------------------------------------------------------------
  // Auto conversion
  // --------------------------------------------------------------------------
  const converted = new WeakMap();

  function getDropdownConfig() {
    if (global.dropdownConfig) {
      return { searchEnabled: true, configs: global.dropdownConfig, type: 'structured' };
    }
    return global.customDropdownConfig || { searchEnabled: true, searchable: [], type: 'simple' };
  }

  function getSearchableConfig(element, config) {
    if (element.hasAttribute('data-searchable')) return element.getAttribute('data-searchable') !== 'false';
    if (element.hasAttribute('searchable')) return true;
    if (config.type === 'structured') return true;
    if (Array.isArray(config.searchable) && config.searchable.length > 0 && element.id) {
      return config.searchable.includes(element.id);
    }
    return config.searchEnabled !== false;
  }

  function getElementDropdownConfig(element, config) {
    if (config.type !== 'structured' || !config.configs || !element.id) return null;
    for (const [fieldName, fc] of Object.entries(config.configs)) {
      const expectedId = `field-${fieldName.replace(/\s+/g, '-').toLowerCase()}`;
      if (element.id === expectedId) {
        return {
          apiUrl: fc.endpoint ? `/reference/${fc.endpoint}` : null,
          valueField: fc.value || fc.valueField || 'id',
          labelField: fc.text || fc.labelField || 'name',
          placeholder: `Select ${fieldName}`,
        };
      }
    }
    return null;
  }

  function isConvertible(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag !== 'SELECT' && tag !== 'ISELECT') return false;
    if (!el.parentNode) return false;
    if (el.hasAttribute('data-native') || el.hasAttribute('data-dropdown-failed')) return false;
    if (el.multiple || el.hasAttribute('multiple')) return false;
    if (tag === 'SELECT' && el.size > 1) return false;
    if (NATIVE.closest.call(el, '[data-native]')) return false;
    if (NATIVE.closest.call(el, 'template')) return false;
    return true;
  }

  function upgradeISelect(el) {
    const select = document.createElement('select');
    Array.from(el.attributes).forEach((a) => select.setAttribute(a.name, a.value));
    while (el.firstChild) NATIVE.appendChild.call(select, el.firstChild);
    NATIVE.replaceChild.call(el.parentNode, select, el);
    return select;
  }

  function convertElement(element) {
    if (!element || element.nodeType !== 1) return element;
    if (element._customDropdown) return element; // already a wrapper
    if (converted.has(element)) return converted.get(element);
    if (!isConvertible(element)) return element;

    const original = element;
    try {
      let el = element;
      if (el.tagName === 'ISELECT') el = upgradeISelect(el);

      const globalConfig = getDropdownConfig();
      const opts = {
        searchEnabled: getSearchableConfig(el, globalConfig),
        valueField: 'value',
        labelField: 'name',
      };
      const elementConfig = getElementDropdownConfig(el, globalConfig);
      if (elementConfig) Object.assign(opts, elementConfig);

      const dropdown = new CustomDropdown(el, opts);
      converted.set(original, dropdown.element);
      converted.set(el, dropdown.element);
      return dropdown.element;
    } catch (err) {
      console.error('[CustomDropdown] conversion failed, keeping native select:', err, original);
      try { NATIVE.setAttribute.call(original, 'data-dropdown-failed', ''); } catch (e) { /* ignore */ }
      return original;
    }
  }

  function convertWithin(root) {
    if (!root) return;
    if (root.nodeType === 1 && isConvertible(root)) { convertElement(root); return; }
    let list;
    if (root.nodeType === 9) list = NATIVE.docQuerySelectorAll.call(root, 'select, iselect');
    else if (root.nodeType === 1) list = NATIVE.elQuerySelectorAll.call(root, 'select, iselect');
    else if (root.nodeType === 11) list = root.querySelectorAll('select, iselect');
    else return;
    Array.from(list).forEach((s) => { if (isConvertible(s)) convertElement(s); });
  }

  // --------------------------------------------------------------------------
  // DOM API patches
  // --------------------------------------------------------------------------
  // `select` used as a type selector also matches converted wrappers.
  const SELECT_TYPE_RE = /(^|[\s,>+~(])select(?=$|[\s,.#[:>+~)])/gi;
  function rewriteSelector(sel) {
    if (typeof sel !== 'string' || !/select/i.test(sel)) return null;
    const out = sel.replace(SELECT_TYPE_RE, '$1:is(select,.' + WRAPPER_CLASS + ')');
    return out === sel ? null : out;
  }
  function runQuery(nativeFn, ctx, sel) {
    const rw = rewriteSelector(sel);
    if (rw) {
      try { return nativeFn.call(ctx, rw); } catch (e) { /* fall back to original */ }
    }
    return nativeFn.call(ctx, sel);
  }
  function convertResult(el) {
    return el && isConvertible(el) ? convertElement(el) : el;
  }
  function convertList(list) {
    for (let i = 0; i < list.length; i++) {
      if (isConvertible(list[i])) return Array.from(list, convertResult);
    }
    return list;
  }

  Document.prototype.getElementById = function (id) {
    return convertResult(NATIVE.getElementById.call(this, id));
  };
  Document.prototype.querySelector = function (sel) {
    return convertResult(runQuery(NATIVE.docQuerySelector, this, sel));
  };
  Document.prototype.querySelectorAll = function (sel) {
    return convertList(runQuery(NATIVE.docQuerySelectorAll, this, sel));
  };
  Element.prototype.querySelector = function (sel) {
    return convertResult(runQuery(NATIVE.elQuerySelector, this, sel));
  };
  Element.prototype.querySelectorAll = function (sel) {
    return convertList(runQuery(NATIVE.elQuerySelectorAll, this, sel));
  };
  Element.prototype.matches = function (sel) {
    return runQuery(NATIVE.matches, this, sel);
  };
  Element.prototype.closest = function (sel) {
    return runQuery(NATIVE.closest, this, sel);
  };

  // --------------------------------------------------------------------------
  // Watch for injected content (sections, modals, iframes' own pages)
  // --------------------------------------------------------------------------
  const bodyObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n._customDropdown || (n.classList && n.classList.contains(LIST_CLASS))) continue;
        if (n.tagName === 'OPTION' || n.tagName === 'OPTGROUP') continue;
        if (n.parentNode && n.parentNode.nodeType === 1 && NATIVE.closest.call(n.parentNode, '.' + WRAPPER_CLASS)) continue;
        convertWithin(n);
      }
    }
  });

  function start() {
    convertWithin(document);
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // Only scan after parsing: converting a <select> mid-parse would lose the
  // options the parser has not appended yet. Lookups (getElementById etc.)
  // from inline scripts still convert on demand.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  global.convertSelectToDropdown = convertElement;
  global.convertAllSelects = () => convertWithin(document);
})(window);
