/*
 * Storefront advisor — the loader. Draws the launcher only; the panel
 * (advisor-panel.js) is fetched the first time a customer opens it, or at once
 * when the panel was left open on the previous page (desktop).
 *
 * Everything shop-specific arrives in the JSON config the app embed writes next
 * to the root element. Nothing here knows a backend URL, a shop or a key.
 */
(function () {
  'use strict';

  var ROOT_ID = 'storefront-advisor';
  var STORAGE_KEY = 'storefront-advisor:v1';
  var MOBILE_QUERY = '(max-width: 640px)';
  var SPARK = [
    'M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z',
    'M18.5 15.5c.25 1.6 1 2.35 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5Z'
  ];

  function boot() {
    var root = document.getElementById(ROOT_ID);
    var configEl = document.getElementById(ROOT_ID + '-config');
    if (!root || !configEl || root.getAttribute('data-ready')) return;
    var config;
    try {
      config = JSON.parse(configEl.textContent);
    } catch (error) {
      return;
    }
    root.setAttribute('data-ready', 'true');
    decodeConfigText(config);

    var strings = config.strings || {};
    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'sa-launcher';
    launcher.setAttribute('aria-controls', ROOT_ID + '-panel');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', strings.open || '');
    launcher.appendChild(sparkIcon());
    var label = document.createElement('span');
    label.className = 'sa-launcher__label';
    label.textContent = strings.launcher || '';
    launcher.appendChild(label);
    root.appendChild(launcher);

    var loading = null;
    var mounted = false;

    function mount(openNow) {
      if (mounted) return;
      if (!loading) loading = loadPanel(config.panelScript);
      launcher.setAttribute('aria-busy', 'true');
      loading.then(function () {
        launcher.removeAttribute('aria-busy');
        if (mounted || !window.StorefrontAdvisorPanel) return;
        mounted = true;
        window.StorefrontAdvisorPanel.mount(root, config, launcher, openNow);
      }, function () {
        launcher.removeAttribute('aria-busy');
        loading = null;
      });
    }

    launcher.addEventListener('click', function () {
      if (!mounted) mount(true);
    });

    if (wasLeftOpen()) mount(false);
  }

  /*
   * Liquid's `t` filter HTML-escapes every translation (« dites-m'en » arrives
   * as `dites-m&#39;en`), and the widget writes text with textContent, never as
   * HTML, so the entity would show literally. Decode once here; the panel gets
   * plain text. DOMParser builds an inert document: nothing in it runs.
   */
  function decodeConfigText(config) {
    var parser = typeof DOMParser === 'function' ? new DOMParser() : null;
    function decode(value) {
      if (!parser || typeof value !== 'string' || value.indexOf('&') < 0) return value;
      return parser.parseFromString('<!doctype html><body>' + value, 'text/html').body.textContent || '';
    }
    [config.strings, config.mock].forEach(function (group) {
      if (!group) return;
      Object.keys(group).forEach(function (key) { group[key] = decode(group[key]); });
    });
    (config.quickActions || []).forEach(function (action) {
      if (action) action.label = decode(action.label);
    });
  }

  function wasLeftOpen() {
    try {
      var mobile = window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return !mobile && Boolean(raw && JSON.parse(raw).open);
    } catch (error) {
      return false;
    }
  }

  function loadPanel(src) {
    return new Promise(function (resolve, reject) {
      if (window.StorefrontAdvisorPanel) return resolve();
      if (!src) return reject(new Error('panel script missing'));
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { script.remove(); reject(new Error('panel script failed')); };
      document.head.appendChild(script);
    });
  }

  function sparkIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    SPARK.forEach(function (d) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
