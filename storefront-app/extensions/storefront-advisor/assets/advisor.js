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
  var BANNER_KEY = 'storefront-advisor:banner-closed';
  var BANNER_DELAY_MS = 1200;
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
    var advisor = null;

    // `start`: a quick action run once the panel is open (the banner's « Construire ma routine »).
    function mount(openNow, start) {
      if (mounted) {
        if (start && advisor) advisor.start(start);
        return;
      }
      if (!loading) loading = loadPanel(config.panelScript);
      launcher.setAttribute('aria-busy', 'true');
      loading.then(function () {
        launcher.removeAttribute('aria-busy');
        if (mounted || !window.StorefrontAdvisorPanel) return;
        mounted = true;
        advisor = window.StorefrontAdvisorPanel.mount(root, config, launcher, openNow, start) || null;
      }, function () {
        launcher.removeAttribute('aria-busy');
        loading = null;
      });
    }

    launcher.addEventListener('click', function () {
      if (!mounted) mount(true);
    });

    if (wasLeftOpen()) mount(false);
    routineBanner(root, config, function (start) { mount(true, start); });
  }

  /*
   * THE ROUTINE BANNER (owner, 2026-10-19): a bar across the bottom of the screen inviting the
   * visitor to build their routine for the shop's offer. Its button opens the advisor and starts
   * the routine builder; its × hides it for `days` days (this browser only). Hidden while the
   * panel is open; the launcher sits above it.
   */
  function routineBanner(root, config, start) {
    var banner = config.banner || {};
    if (!banner.enabled || !banner.text || !banner.button || bannerClosed(banner.days)) return;
    var bar = document.createElement('div');
    bar.className = 'sa-banner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', banner.text);
    var text = document.createElement('p');
    text.className = 'sa-banner__text';
    text.textContent = banner.text;
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'sa-banner__button';
    go.textContent = banner.button;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'sa-banner__close';
    close.setAttribute('aria-label', banner.close || '');
    close.setAttribute('title', banner.close || '');
    close.textContent = '\u00d7';
    bar.appendChild(text);
    bar.appendChild(go);
    bar.appendChild(close);

    function hide(remember) {
      if (remember) {
        try { window.localStorage.setItem(BANNER_KEY, String(Date.now())); } catch (error) { /* shown again next page */ }
      }
      root.classList.remove('sa-root--banner');
      root.style.removeProperty('--sa-banner-h');
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      window.removeEventListener('resize', measure);
    }
    function measure() {
      root.style.setProperty('--sa-banner-h', bar.offsetHeight + 'px');
    }
    go.addEventListener('click', function () {
      hide(true);
      start(banner.action ? { id: 'build_routine', label: banner.action } : { id: 'build_routine', label: banner.button });
    });
    close.addEventListener('click', function () { hide(true); });

    setTimeout(function () {
      root.appendChild(bar);
      measure();
      root.classList.add('sa-root--banner');
      window.addEventListener('resize', measure);
      // Next frame: slide up from the bottom edge.
      window.requestAnimationFrame(function () { bar.classList.add('sa-banner--in'); });
    }, BANNER_DELAY_MS);
  }

  function bannerClosed(days) {
    try {
      var at = Number(window.localStorage.getItem(BANNER_KEY));
      return Boolean(at) && Date.now() - at < (Number(days) || 7) * 86400000;
    } catch (error) {
      return false;
    }
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
    [config.strings, config.mock, config.banner].forEach(function (group) {
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
