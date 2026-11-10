/* Advisor loader, kept under Theme Check's 10 KB: the launcher and banner; the panel loads on first open. */
(function () {
  'use strict';

  var ROOT_ID = 'storefront-advisor';
  var STORAGE_KEY = 'storefront-advisor:v1';
  var BANNER_KEY = 'storefront-advisor:banner-closed';
  var SEEN_KEY = 'storefront-advisor:since';
  var MOBILE_QUERY = '(max-width: 640px)';
  var TEASED_KEY = 'storefront-advisor:teased';
  var BUBBLE = ['M12 3.5c-4.97 0-9 3.36-9 7.5 0 2.1 1.04 4 2.72 5.36L5 20.5l4.3-2.03c.86.2 1.76.3 2.7.3 4.97 0 9-3.35 9-7.5s-4.03-7.5-9-7.5Z'];

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
    // Weglot: advisor-strings.js.
    var shopLang = String((config.context || {}).locale || '').slice(0, 2);
    var pageLang = String((location.pathname.match(/^\/([a-z]{2})(\/|$)/) || [])[1] || document.documentElement.lang || '').slice(0, 2);
    if (config.stringsScript && (window.Weglot || (pageLang && pageLang !== shopLang))) {
      var s = document.createElement('script');
      s.src = config.stringsScript;
      s.onload = s.onerror = function () {
        var words = window.StorefrontAdvisorStrings;
        if (!words) return draw(root, config);
        words.ready(function () {
          var lang = words.detect();
          if (lang && lang !== shopLang) words.apply(config, lang);
          draw(root, config);
        });
      };
      return document.head.appendChild(s);
    }
    draw(root, config);
  }

  function draw(root, config) {
    var strings = config.strings || {};
    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'sa-launcher';
    launcher.setAttribute('aria-controls', ROOT_ID + '-panel');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', strings.open || '');
    launcher.appendChild(bubbleIcon());
    var label = document.createElement('span');
    label.className = 'sa-launcher__label';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = strings.launcher || '';
    // Theme setting `launcher_bubble`; hidden on phones by the stylesheet.
    if (config.launcherBubble !== false && label.textContent) {
      try { if (!sessionStorage.getItem(TEASED_KEY)) launcher.appendChild(label); } catch (error) { launcher.appendChild(label); }
    }

    var loading = null;
    var mounted = false;
    var advisor = null;

    function mount(openNow, start) {
      if (mounted) {
        if (start && advisor) advisor.start(start);
        return;
      }
      loadFonts(config.fontsUrl);
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
      if (label.parentNode) label.parentNode.removeChild(label);
      try { sessionStorage.setItem(TEASED_KEY, '1'); } catch (error) { /* this page */ }
      if (!mounted) mount(true);
    });

    // `delay` s into the visit: the cookie banner first.
    var wait = visitWait((config.banner || {}).delay);
    if (wasLeftOpen()) { wait = 0; mount(false); }
    setTimeout(function () { root.insertBefore(launcher, root.firstChild); }, wait);
    routineBanner(root, config, function (start) { mount(true, start); }, wait);
    // advisor-ask block: open and ask.
    var ask = function (q) { label.remove(); mount(true, q); };
    window.StorefrontAdvisor = { ask: ask };
    (window.StorefrontAdvisorAsks || []).splice(0).forEach(ask);
  }

  /* The routine banner (docs/decisions/storefront-advisor.md). */
  function routineBanner(root, config, start, wait) {
    var banner = config.banner || {};
    if (!banner.enabled || !banner.text || !banner.button || bannerClosed(banner.hours)) return;
    loadFonts(config.fontsUrl);
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

    // Other bottom widgets: lifted above the bar.
    var lifted = [];
    var watch = null;
    function lift() {
      if (!banner.lift) return;
      var found;
      try { found = document.querySelectorAll(banner.lift); } catch (error) { return; }
      for (var i = 0; i < found.length; i++) {
        if (!root.contains(found[i]) && lifted.indexOf(found[i]) < 0) lifted.push(found[i]);
      }
      lifted.forEach(function (el) { el.style.setProperty('margin-bottom', bar.offsetHeight + 'px', 'important'); });
    }
    function hide(remember) {
      if (watch) watch.disconnect();
      lifted.forEach(function (el) { el.style.removeProperty('margin-bottom'); });
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
      lift();
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
      if (banner.lift && window.MutationObserver) {
        watch = new MutationObserver(lift);
        watch.observe(document.body, { childList: true, subtree: true });
      }
      window.requestAnimationFrame(function () { bar.classList.add('sa-banner--in'); });
    }, Math.max(1200, wait));
  }

  function visitWait(s) {
    var at = Date.now();
    try { at = Number(sessionStorage.getItem(SEEN_KEY)) || at; sessionStorage.setItem(SEEN_KEY, at); } catch (error) { /* this page */ }
    return Math.max(0, (typeof s === 'number' ? s : 15) * 1000 + at - Date.now());
  }

  function loadFonts(url) {
    if (typeof url !== 'string' || url.indexOf('https://') !== 0 || document.getElementById('sa-fonts')) return;
    var link = document.createElement('link');
    link.id = 'sa-fonts';
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }

  function bannerClosed(hours) {
    try {
      var at = Number(window.localStorage.getItem(BANNER_KEY));
      return Boolean(at) && Date.now() - at < (Number(hours) || 4) * 3600000;
    } catch (error) {
      return false;
    }
  }

  /* Liquid's `t` HTML-escapes; we write textContent. */
  function decodeConfigText(config) {
    var parser = typeof DOMParser === 'function' ? new DOMParser() : null;
    function decode(value) {
      if (!parser || typeof value !== 'string' || value.indexOf('&') < 0) return value;
      return parser.parseFromString('<!doctype html><body>' + value, 'text/html').body.textContent || '';
    }
    [config.strings, config.banner].forEach(function (group) {
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

  function bubbleIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    BUBBLE.forEach(function (d) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
