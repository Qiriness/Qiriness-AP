/*
 * Storefront advisor — the chat panel. Loaded by advisor.js on first open, so a
 * page that never opens the advisor pays only for the launcher.
 *
 * No framework, no dependency, no Liquid (theme extension assets are served as
 * they are). Everything shop-specific arrives in the JSON config the embed
 * writes next to the root element: strings, quick actions, page context and the
 * app proxy path. Nothing here knows a backend URL, a shop or a key.
 *
 * The browser only ever calls its own storefront domain (the app proxy); the
 * backend reloads history from its own store and never trusts the client's.
 *
 * Contract, request:  { sessionId, message, action, context }
 *           response: { sessionId, reply: { text, products: [ProductCard] } }
 */
(function () {
  'use strict';

  var ROOT_ID = 'storefront-advisor';
  var STORAGE_KEY = 'storefront-advisor:v1';
  var MAX_STORED_MESSAGES = 40;
  var MAX_MESSAGE_CHARS = 1000;
  var REQUEST_TIMEOUT_MS = 30000;
  var MOCK_DELAY_MS = 700;
  var MOBILE_QUERY = '(max-width: 640px)';
  /** Chips under one reply: a skin-type question has five, a concern question up to eight. */
  var MAX_CHOICES = 8;

  /* ---------- small helpers ---------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function icon(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    paths.forEach(function (d) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  var ICONS = {
    close: ['M6 6l12 12', 'M18 6L6 18'],
    expand: ['M14 4h6v6', 'M20 4l-7 7', 'M10 20H4v-6', 'M4 20l7-7'],
    collapse: ['M20 10h-6V4', 'M14 10l7-7', 'M4 14h6v6', 'M10 14l-7 7'],
    newChat: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    send: ['M3.5 12h16', 'M14.5 7l5 5-5 5'],
    search: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z', 'M20 20l-4.8-4.8'],
    check: ['M5 12.5l4 4L19 7'],
    plus: ['M12 5v14', 'M5 12h14'],
    chevron: ['M7 10l5 5 5-5'],
    sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
    moon: ['M20 15.7A8 8 0 0 1 8.3 4a8.3 8.3 0 1 0 11.7 11.7z']
  };

  function newSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  /*
   * Session storage can throw (private mode, blocked storage): the widget works without it.
   * A conversation is kept only for the viewer who had it (the signed-in customer, or
   * nobody): after signing out, or another account signing in on this tab, it starts afresh.
   */
  function loadState(viewer) {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.sessionId === 'string' && Array.isArray(parsed.messages) && (parsed.viewer || '') === viewer) return parsed;
    } catch (error) { /* fall through */ }
    return null;
  }

  function saveState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        viewer: state.viewer,
        sessionId: state.sessionId,
        open: state.open,
        wide: state.wide,
        openingAsked: Boolean(state.openingAsked),
        messages: state.messages.filter(function (m) { return !m.failed; }).slice(-MAX_STORED_MESSAGES)
      }));
    } catch (error) { /* not fatal */ }
  }

  /*
   * Only same-site paths, https links and https images reach the DOM: the
   * server is trusted, but a link is still a link. An https link is another
   * site's product page (the server's STOREFRONT_CHAT_PRODUCT_BASE_URL, set
   * while the dev store lacks the catalogue) and opens in a new tab.
   */
  function safeLink(url) {
    if (typeof url !== 'string') return null;
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') return { href: url, external: false };
    return /^https:\/\/[^\s/]+\//i.test(url) ? { href: url, external: true } : null;
  }

  /*
   * The contact form: a path on this shop's own site, in the visitor's market
   * and language (Shopify.routes.root, e.g. /en/). Anything else is dropped.
   */
  function contactHref(contact) {
    var path = contact && typeof contact.url === 'string' ? contact.url : '';
    if (!/^\/[A-Za-z0-9/_\-.%]{1,200}$/.test(path) || path.charAt(1) === '/') return null;
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return root.replace(/\/$/, '') + path;
  }

  function safeImage(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
  }

  /* ---------- transports ---------- */

  /*
   * A card click as a beacon to the proxy's /event route, next to /chat. It
   * never delays the navigation and never reports an error to the shopper.
   */
  function reportClick(endpoint, sessionId, productId, type) {
    try {
      var url = String(endpoint).replace(/\/chat$/, '/event');
      var body = JSON.stringify({ sessionId: sessionId, productId: productId, type: type || 'product_clicked' });
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () {});
    } catch (e) { /* a lost click is a lost data point, nothing more */ }
  }

  /* « Ajouter la routine au panier »: the routine's ref to the same /event route. */
  function reportRoutineAdded(endpoint, routineRef) {
    try {
      var url = String(endpoint).replace(/\/chat$/, '/event');
      var body = JSON.stringify({ routineRef: routineRef, type: 'routine_added_to_cart' });
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () {});
    } catch (e) { /* a lost data point, nothing more */ }
  }

  function createProxyTransport(config) {
    var cartModule = null;
    // A FOLLOW-UP CARRIES THE CART. « why did the 30 percent off not apply? »
    // named no cart word, so no cart was sent and the advisor said it could not
    // see the basket it had just described (dev store, 2026-10-06).
    var lastSentCart = false;
    function readCart(payload) {
      if (!config.cartScript) return Promise.resolve(null);
      var timer;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var work = (cartModule || (cartModule = import(config.cartScript).then(function () { return window.QirinessCart; }).catch(function () { cartModule = null; return null; }))).then(function (api) {
        if (!api || !(lastSentCart || api.needsCartSnapshot(payload.message, payload.action, payload.context))) return null;
        var root = window.Shopify && window.Shopify.routes && window.Shopify.routes.root || '/';
        if (!/^\/(?!\/)[A-Za-z0-9_/-]*\/$/.test(root) && root !== '/') root = '/';
        return fetch(root + 'cart.js', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller ? controller.signal : undefined }).then(function (response) {
          return response.ok ? response.json() : null;
        }).then(api.fromAjaxCart);
      });
      var deadline = new Promise(function (resolve) { timer = setTimeout(function () { if (controller) controller.abort(); resolve(null); }, 1500); });
      return Promise.race([work, deadline]).catch(function () { return null; }).finally(function () { clearTimeout(timer); });
    }
    function post(payload) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
      return fetch(config.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (body) {
          if (!response.ok || !body || !body.reply) {
            var error = new Error((body && body.error && body.error.code) || 'http_' + response.status);
            throw error;
          }
          return body;
        });
      }).finally(function () {
        if (timer) clearTimeout(timer);
      });
    }
    return function send(payload) {
      return readCart(payload).then(function (cart) {
        if (cart) payload.cart = cart;
        lastSentCart = Boolean(cart);
        return post(payload);
      });
    };
  }

  function createMockTransport(config) {
    var mock = config.mock || {};
    return function send(payload) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var products = payload.action === 'find_product'
            ? [{ title: mock.productName, rationale: mock.productRationale, price: null, image: null, url: '/collections/all' }]
            : [];
          resolve({
            sessionId: payload.sessionId,
            reply: { text: (payload.action && mock[payload.action]) || mock.default || '', products: products }
          });
        }, MOCK_DELAY_MS);
      });
    };
  }

  /* ---------- components ---------- */

  /* A card click, reported to the advisor (advisory_events): set by the proxy transport only. */
  var onCardClick = null;
  var onCardAdd = null;
  /* A routine added whole (advisor_routines): its ref only, never who added it. */
  var onRoutineAdd = null;
  /* The routine cards keep the customer's choices on their message: saved through this. */
  var persistState = function () {};

  /*
   * « Ajouter au panier »: the shop's own cart (Shopify's /cart/add.js, same
   * origin), on the customer's click only, one unit of the card's only size.
   * The theme is told the cart changed; a theme that does not listen shows it
   * on the next page.
   */
  function addToCart(variantGid) {
    return addAllToCart([variantGid]);
  }

  /* Several at once (a routine, or « Oui, ajouter »): one request, one unit each. */
  function addAllToCart(variantGids) {
    var ids = (variantGids || []).map(function (g) { return String(g || '').replace(/^gid:\/\/shopify\/ProductVariant\//, ''); });
    if (!ids.length || ids.some(function (id) { return !/^[1-9][0-9]{0,19}$/.test(id); })) return Promise.reject(new Error('variant'));
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return fetch(root + 'cart/add.js', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: ids.map(function (id) { return { id: Number(id), quantity: 1 }; }) })
    }).then(function (res) {
      if (!res.ok) throw new Error('cart ' + res.status);
      try {
        document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
        document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true }));
      } catch (e) { /* an old browser: the cart still has it */ }
    });
  }

  /*
   * A finished routine's discount (owner, 2026-10-17), applied with its products: the shop's
   * /cart/update.js `discount` sets the cart's codes, so the codes already there are kept. The code
   * is never shown. A failure leaves the products in the cart.
   */
  function applyDiscount(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(code)) return Promise.resolve();
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return fetch(root + 'cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : { discount_codes: [] }; })
      .then(function (cart) {
        var codes = (Array.isArray(cart && cart.discount_codes) ? cart.discount_codes : [])
          .map(function (d) { return d && typeof d.code === 'string' ? d.code : null; }).filter(Boolean);
        if (codes.some(function (c) { return c.toUpperCase() === code.toUpperCase(); })) return;
        return fetch(root + 'cart/update.js', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ discount: codes.concat([code]).join(',') })
        }).then(function () {
          try {
            document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
            document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true }));
          } catch (e) { /* an old browser */ }
        });
      })
      .catch(function () { /* the products are in the cart; the discount can still be entered at checkout */ });
  }

  function ProductCard(product, strings) {
    var link = safeLink(product.url);
    var image = safeImage(product.image);
    var title = typeof product.title === 'string' ? product.title : '';
    var media = image ? el('img', { src: image, alt: '', loading: 'lazy', width: '160', height: '160' }) : el('span', { className: 'sa-card__placeholder', 'aria-hidden': 'true' });
    // No image from the server: the shop's own, as the routine cards do (owner, 2026-10-18).
    var handle = !image && link && !link.external ? (link.href.match(/\/products\/([^/?#]+)/) || [])[1] : null;
    if (handle) {
      productImage(decodeURIComponent(handle)).then(function (src) {
        if (src && media.parentNode) media.parentNode.replaceChild(el('img', { src: src, alt: '', loading: 'lazy', width: '240', height: '240' }), media);
      });
    }
    // The image, the name and the magnifier in the corner all open the product page (owner,
    // 2026-10-19: « the name should be a link… remove découvrir, add it as a search icon »).
    // The image and the icon are extra ways in: one link in the tab order, the name's.
    function toPage(attrs, children) {
      return el('a', Object.assign({
        href: link.href,
        target: link.external ? '_blank' : null,
        rel: link.external ? 'noopener noreferrer' : null,
        onClick: function () { if (onCardClick && typeof product.id === 'string') onCardClick(product.id); }
      }, attrs), children);
    }
    return el('article', { className: 'sa-card' }, [
      el('div', { className: 'sa-card__media' }, [link ? toPage({ tabindex: '-1', 'aria-hidden': 'true' }, [media]) : media]),
      link ? toPage({ className: 'sa-card__view', tabindex: '-1', 'aria-hidden': 'true', title: strings.discover }, [icon(ICONS.search)]) : null,
      el('div', { className: 'sa-card__body' }, [
        el('h3', { className: 'sa-card__title' }, [link ? toPage({ className: 'sa-card__link', text: title, 'aria-label': strings.discover + ' — ' + title }) : document.createTextNode(title)]),
        product.rationale ? el('p', { className: 'sa-card__rationale', text: String(product.rationale) }) : null,
        product.price ? el('p', { className: 'sa-card__price', text: String(product.price) }) : null,
        typeof product.variantId === 'string' ? AddButton(product, strings) : null
      ])
    ]);
  }

  /* « Ajouter la routine au panier »: every product of the routine with one size; the others named. */
  function RoutineCartButton(routineCart, strings) {
    var items = Array.isArray(routineCart && routineCart.add) ? routineCart.add.filter(function (x) { return x && typeof x.variant_id === 'string'; }) : [];
    if (items.length < 2) return null;
    var discount = typeof routineCart.discount_code === 'string' ? routineCart.discount_code : null;
    var label = discount ? (strings.addRoutineDiscount || 'Ajouter la routine au panier avec la remise') : (strings.addRoutine || 'Ajouter la routine au panier');
    var button = el('button', { type: 'button', className: 'sa-card__add sa-routine-add', text: label });
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      addAllToCart(items.map(function (x) { return x.variant_id; })).then(function () {
        return applyDiscount(discount);
      }).then(function () {
        button.textContent = strings.added || 'Ajouté';
        button.className = 'sa-card__add sa-routine-add sa-card__add--done';
        if (onCardAdd) items.forEach(function (x) { if (typeof x.product_id === 'string') onCardAdd(x.product_id); });
        if (onRoutineAdd && typeof routineCart.routine_ref === 'string') onRoutineAdd(routineCart.routine_ref);
      }).catch(function () {
        button.textContent = strings.addFailed || 'Réessayer';
        button.disabled = false;
      });
    });
    var sizes = Array.isArray(routineCart.needs_size) ? routineCart.needs_size.filter(function (n) { return typeof n === 'string'; }) : [];
    return el('div', { className: 'sa-routine-cart' }, [
      button,
      sizes.length ? el('p', { className: 'sa-routine-cart__note', text: (strings.chooseSize || 'Choisissez la taille sur sa page :') + ' ' + sizes.join(', ') }) : null
    ]);
  }

  /*
   * THE ROUTINE CARDS (owner, 2026-10-18). Both moments, always: the chosen one included, the
   * other greyed with « Compléter ma routine » (its steps already theirs are marked, the rest
   * added). Each product: the stage, the image (from the shop's own /products/<handle>.js), name,
   * size, price, stars, « Inclus », « Pourquoi pour vous ? » and three foldable sections (laid out
   * since 2026-10-30 as in RoutineView below). The footer: the total, the routine saving from its minimum on, one button adding what is
   * included and then the routine discount (never shown). The choices live on the message, so a
   * re-render or the next page keeps them; a toggle updates the cards in place.
   */
  var productImages = {};

  /* The routine's moments that have steps. */
  function routineMoments(view) {
    return (Array.isArray(view && view.moments) ? view.moments : []).filter(function (m) { return m && Array.isArray(m.steps) && m.steps.length; });
  }

  /*
   * The ticks, per product (owner, 2026-10-30: « when i added compléter ma routine for night, it added
   * the eye serum to the night but not the day one »). A product is in the routine or not, in every
   * moment that uses it; the moments only say when it is applied. A new routine starts with the
   * products the brand ticks at first (2026-10-19: the serum and the cream in the morning, the eye
   * serum and the cream in the evening), read from the moments they chose; a product only in the
   * other moment, from that moment. The rest show unticked, greyed, theirs to tick.
   */
  var CLEANSING = { cleanser: true, makeup_remover: true };

  function routineFreshRemoved(view) {
    var moments = routineMoments(view);
    var removed = {};
    var seen = {};
    moments.forEach(function (m) { m.steps.forEach(function (s) { seen[s.product_id] = true; }); });
    Object.keys(seen).forEach(function (id) {
      var uses = [];
      moments.forEach(function (m) { m.steps.forEach(function (s) { if (s.product_id === id) uses.push({ m: m, s: s }); }); });
      var chosen = uses.filter(function (u) { return u.m.chosen; });
      var ticked = (chosen.length ? chosen : uses).some(function (u) { return u.s.preselected !== false; });
      if (!ticked) removed[id] = true;
    });
    return removed;
  }

  function routineChoiceOf(message) {
    var choice = message.routineChoice || (message.routineChoice = { added: {} });
    if (!choice.added) choice.added = {};
    // A choice saved before 2026-10-30 holds per-moment ticks (« night:<id> »): started again.
    if (!choice.removed || choice.perProduct !== true) {
      choice.removed = routineFreshRemoved(message.routineView);
      choice.perProduct = true;
    }
    return choice;
  }

  function routineActive(m, choice) { return m.chosen || Boolean(choice.added[m.part]); }
  function routineRemoved(m, s, choice) { return Boolean(choice.removed[s.product_id]); }

  /* « Déjà le matin »: the same product, ticked, in the other moment of the routine. */
  function routineOwned(view, m, s, choice) {
    if (!s.owned || routineRemoved(m, s, choice)) return false;
    return routineMoments(view).some(function (o) {
      return o.part !== m.part && routineActive(o, choice) && o.steps.some(function (x) { return !x.owned && x.product_id === s.product_id; });
    });
  }

  function routineBuyable(view, m, s) { return s.in_stock && typeof s.variant_id === 'string'; }

  /* What the routine includes now: the active moments' products they kept, each once. */
  function routineSelection(view, choice) {
    var seen = {};
    var items = [];
    routineMoments(view).forEach(function (m) {
      if (!routineActive(m, choice)) return;
      m.steps.forEach(function (s) {
        if (!routineBuyable(view, m, s) || routineRemoved(m, s, choice) || seen[s.product_id]) return;
        seen[s.product_id] = true;
        items.push(s);
      });
    });
    return items;
  }

  function routineQualifies(view, items) {
    var d = view && view.discount && typeof view.discount.code === 'string' ? view.discount : null;
    return Boolean(d && items.length >= (d.min_products || 1));
  }

  /* The variant ids already in the shop's cart; unknown: none (everything is added). */
  function cartVariantIds() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return fetch(root + 'cart.js', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cart) {
        var ids = {};
        (cart && Array.isArray(cart.items) ? cart.items : []).forEach(function (i) { if (i && i.variant_id) ids[String(i.variant_id)] = true; });
        return ids;
      })
      .catch(function () { return {}; });
  }

  /*
   * ADD THE ROUTINE (owner, 2026-10-18: « if they accidentally clear their cart they cannot re-add
   * it »): as often as they like, what the routine includes now and the cart lacks, then the
   * routine discount from its minimum on. A product already in the cart is not added twice.
   */
  function addRoutineToCart(view, choice) {
    var items = routineSelection(view, choice);
    if (!items.length) return Promise.reject(new Error('empty'));
    var qualifies = routineQualifies(view, items);
    return cartVariantIds().then(function (inCart) {
      var missing = items.filter(function (s) { return !inCart[s.variant_id.replace(/^gid:\/\/shopify\/ProductVariant\//, '')]; });
      return (missing.length ? addAllToCart(missing.map(function (s) { return s.variant_id; })) : Promise.resolve()).then(function () {
        return qualifies ? applyDiscount(view.discount.code) : null;
      }).then(function () {
        if (onCardAdd) missing.forEach(function (s) { if (typeof s.product_id === 'string') onCardAdd(s.product_id); });
        if (missing.length && onRoutineAdd && typeof view.ref === 'string') onRoutineAdd(view.ref);
        choice.addedKey = routineKey(items);
        return { items: items, added: missing, qualifies: qualifies };
      });
    });
  }

  function routineKey(items) {
    return items.map(function (s) { return s.variant_id; }).sort().join(',');
  }

  /* After an add: what happened, in their words. */
  function routineAddedText(view, result, strings) {
    var rs = strings.routine || {};
    var parts = [result.added.length ? (strings.cartAdded || 'C\'est dans votre panier.') : (rs.already_in_cart || 'Ces soins sont déjà dans votre panier.')];
    if (result.qualifies && typeof view.discount.percentage === 'number') parts.push(rs.discount_applied || 'Votre remise routine est appliquée.');
    else if (view.discount && !result.qualifies) parts.push(fill(rs.min_note || '', { min: view.discount.min_products }));
    return parts.filter(Boolean).join(' ');
  }

  /* The shop's own /products/<handle>.js, once per handle: the cards' images, the page's product. */
  var productJsons = {};
  function productJson(handle) {
    if (productJsons[handle]) return productJsons[handle];
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    productJsons[handle] = fetch(root + 'products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
    return productJsons[handle];
  }

  function productImage(handle) {
    if (productImages[handle]) return productImages[handle];
    productImages[handle] = productJson(handle).then(function (p) {
      var src = p && (p.featured_image || (Array.isArray(p.images) && p.images[0]));
      if (typeof src !== 'string' || !src) return null;
      src = src.indexOf('//') === 0 ? 'https:' + src : src;
      return safeImage(src) ? src + (src.indexOf('?') === -1 ? '?' : '&') + 'width=240' : null;
    });
    return productImages[handle];
  }

  /*
   * THE PRODUCT THEY ARE VIEWING (owner, 2026-10-30, from a screenshot): on a product page the header
   * opens a little for one short card, its picture, name and price (the variant chosen on the page).
   * Not a link: they are on its page. Nothing on another page, or when the shop does not answer.
   */
  function ViewingCard(handle, context, strings, variantOf) {
    var media = el('span', { className: 'sa-viewing__media', 'aria-hidden': 'true' });
    var name = el('p', { className: 'sa-viewing__name' });
    var price = el('p', { className: 'sa-viewing__price' });
    var card = el('div', { className: 'sa-viewing', role: 'group', 'aria-label': strings.viewing || 'Vous consultez', hidden: true }, [
      media,
      el('div', { className: 'sa-viewing__text' }, [name, price])
    ]);
    var product = null;
    var format;
    var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || context.currency || 'EUR';
    try { format = new Intl.NumberFormat(context.locale || document.documentElement.lang || 'fr', { style: 'currency', currency: currency }); } catch (e) { format = null; }
    // Prices in the shop's .js are in cents.
    function update() {
      if (!product) return;
      var id = String(variantOf() || '').replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      var variant = (product.variants || []).filter(function (v) { return String(v.id) === id; })[0];
      var cents = variant ? variant.price : product.price;
      price.textContent = typeof cents === 'number' && format ? format.format(cents / 100).replace(/ | /g, ' ') : '';
    }
    productJson(handle).then(function (p) {
      if (!p || typeof p.title !== 'string') return;
      product = p;
      name.textContent = p.title;
      update();
      productImage(handle).then(function (src) {
        if (src && media.parentNode) media.parentNode.replaceChild(el('img', { className: 'sa-viewing__media', src: src, alt: '', width: '96', height: '96' }), media);
      });
      card.hidden = false;
    });
    return { node: card, update: update };
  }

  function fill(template, values) {
    return String(template || '').replace(/\{(\w+)\}/g, function (all, key) { return values[key] !== undefined ? values[key] : all; });
  }

  function Stars(rating, count, strings) {
    if (typeof rating !== 'number' || rating <= 0) return null;
    var full = Math.round(rating);
    var stars = '';
    for (var i = 0; i < 5; i++) stars += i < full ? '★' : '☆';
    return el('p', { className: 'sa-rcard__rating' }, [
      el('span', { className: 'sa-rcard__stars', 'aria-hidden': 'true', text: stars }),
      el('span', { text: String(rating).replace('.', strings.decimal || ',') + (typeof count === 'number' ? ' · ' + count + ' ' + (strings.reviews || 'avis') : '') })
    ]);
  }

  function Fold(label, text) {
    if (typeof text !== 'string' || !text) return null;
    return el('details', { className: 'sa-rcard__fold' }, [
      el('summary', { text: label }),
      el('div', { className: 'sa-rcard__fold-body' }, text.split(/\n+/).map(function (line) { return el('p', { text: line }); }))
    ]);
  }

  /*
   * THE ROUTINE, LAID OUT (owner, 2026-10-30, from the prototype « Votre rituel, à votre rythme »).
   * Two columns. On the left, at a glance, both moments as numbered steps: each step is that moment's
   * tick (per moment and product, 2026-10-19), « Compléter ma routine » under the moment not chosen.
   * On the right each product once, however many moments use it: the ones ticked at first as full
   * cards, the others under « Compléter mon rituel »; their « Inclus » / « Ajouter » ticks or unticks
   * the product in every moment. Narrow (the 400 px panel, a phone) the columns stack and the steps
   * fold under one button, so the products come first.
   */
  function RoutineView(view, message, strings, persist) {
    var rs = strings.routine || {};
    var moments = routineMoments(view);
    if (!moments.length) return null;
    // The routine's language (any the chat speaks); numbers written its way (« 4,8 », "4.8").
    var lang = typeof view.locale === 'string' && /^[a-z]{2}$/.test(view.locale) ? view.locale : 'fr';
    var decimal = ',';
    try { decimal = (new Intl.NumberFormat(lang).formatToParts(1.5).filter(function (p) { return p.type === 'decimal'; })[0] || {}).value || ','; } catch (e) { /* the comma */ }
    var format;
    try { format = new Intl.NumberFormat(lang, { style: 'currency', currency: view.currency || 'EUR' }); } catch (e) { format = new Intl.NumberFormat('fr', { style: 'currency', currency: 'EUR' }); }
    var money = function (n) { return format.format(n).replace(/ | /g, ' '); };
    var discount = view.discount && typeof view.discount.code === 'string' ? view.discount : null;
    // The customer's choices, kept on the message: removed steps, moments added. They stay
    // theirs to change after an add (owner, 2026-10-18), and the button adds again.
    var choice = routineChoiceOf(message);
    var refreshers = [];

    var active = function (m) { return routineActive(m, choice); };
    var buyable = function (m, s) { return routineBuyable(view, m, s); };
    var owned = function (m, s) { return routineOwned(view, m, s, choice); };
    var removed = function (m, s) { return routineRemoved(m, s, choice); };
    function selection() { return routineSelection(view, choice); }
    // A cleanser or a make-up remover cleanses, whatever its sheet stage (owner, 2026-10-30: the evening's first step is « Nettoyer »).
    function stageLabel(s) { return CLEANSING[s.type] ? rs.stage_cleanse || null : s.stage && rs['stage_' + s.stage] ? rs['stage_' + s.stage] : null; }
    function partName(part, short) { return part === 'night' ? (short ? rs.evening_short : rs.evening) : (short ? rs.morning_short : rs.morning); }

    // Each product once, in the moments' order, with every step it fills.
    var products = [];
    var byProduct = {};
    moments.forEach(function (m) {
      m.steps.forEach(function (s) {
        var p = byProduct[s.product_id];
        if (!p) { p = byProduct[s.product_id] = { step: s, uses: [] }; products.push(p); }
        p.uses.push({ m: m, s: s });
      });
    });
    // Ticked at first in the moment they chose: the essentials; the rest is theirs to add.
    var essential = function (p) { return p.uses.some(function (u) { return u.m.chosen && u.s.preselected !== false; }); };
    var included = function (p, items) { return items.some(function (s) { return s.product_id === p.step.product_id; }); };
    var reachable = function (p) { return p.uses.some(function (u) { return active(u.m) && buyable(u.m, u.s); }); };

    function setProduct(id, on) {
      if (on) delete choice.removed[id]; else choice.removed[id] = true;
      persist();
      refresh();
    }

    var count = el('span', { className: 'sa-ritual__count' });
    var pill = el('span', { className: 'sa-picks__pill' });
    var totalLabel = el('p', { className: 'sa-routine__count' });
    var was = el('s', { className: 'sa-routine__was' });
    var now = el('strong', { className: 'sa-routine__now' });
    var saving = el('span', { className: 'sa-routine__saving' });
    var minNote = el('p', { className: 'sa-routine__min' });
    var addButton = el('button', { type: 'button', className: 'sa-routine__add' });
    var addStatus = el('p', { className: 'sa-routine__status', role: 'status' });

    function refresh() {
      var items = selection();
      var total = items.reduce(function (n, s) { return n + (typeof s.price_value === 'number' ? s.price_value : 0); }, 0);
      var qualifies = discount && items.length >= (discount.min_products || 1);
      var pct = qualifies && typeof discount.percentage === 'number' ? discount.percentage : 0;
      var after = Math.round(total * (100 - pct)) / 100;
      count.textContent = String(items.length);
      pill.textContent = fill(rs.selected_count || '{count}', { count: items.length });
      totalLabel.textContent = fill(rs.total || 'Routine — {count}', { count: items.length });
      was.textContent = pct ? money(total) : '';
      was.hidden = !pct;
      now.textContent = money(pct ? after : total);
      saving.textContent = pct ? fill(rs.saving || 'Économie {amount}', { amount: money(total - after) }) : '';
      saving.hidden = !pct;
      minNote.textContent = discount && !qualifies ? fill(rs.min_note || '', { min: discount.min_products }) : '';
      minNote.hidden = !minNote.textContent;
      // Added as it is now: said under the button, which still adds again (a cleared cart).
      var added = Boolean(items.length) && choice.addedKey === routineKey(items);
      addButton.textContent = fill(added ? (rs.add_again || rs.add) : rs.add || 'Ajouter — {amount}', { amount: money(pct ? after : total) });
      addButton.disabled = !items.length;
      addButton.className = 'sa-routine__add' + (added ? ' sa-routine__add--done' : '');
      if (bannerButton) {
        bannerButton.textContent = added ? (rs.banner_added || rs.added) : (rs.banner_add || 'Ajouter ma routine');
        bannerButton.disabled = !items.length;
        bannerButton.className = 'sa-routine__badge' + (added ? ' sa-routine__badge--done' : '');
      }
      if (!added) addStatus.textContent = '';
      addStatus.hidden = !addStatus.textContent;
      refreshers.forEach(function (r) { r(items); });
    }

    /* A step of a moment: its number (a tick once in), the stage, the product, its state. */
    function Step(m, s, index) {
      var mark = el('span', { className: 'sa-step__mark', 'aria-hidden': 'true' });
      var state = el('span', { className: 'sa-step__state' });
      var stage = stageLabel(s);
      var title = typeof s.title === 'string' ? s.title : '';
      var row = el('button', { type: 'button', className: 'sa-step' }, [
        mark,
        el('span', { className: 'sa-step__text' }, [
          el('strong', { text: stage || title }),
          stage ? el('small', { text: title }) : null
        ]),
        state
      ]);
      row.addEventListener('click', function () {
        if (row.disabled) return;
        setProduct(s.product_id, removed(m, s));
      });
      refreshers.push(function () {
        var isOwned = owned(m, s);
        var on = buyable(m, s) && !removed(m, s);
        var tickable = active(m) && buyable(m, s);
        mark.textContent = '';
        if (on) mark.appendChild(icon(ICONS.check)); else mark.textContent = String(index + 1);
        state.textContent = !s.in_stock ? rs.unavailable
          : typeof s.variant_id !== 'string' ? rs.choose_size
            : isOwned ? (m.part === 'night' ? rs.owned_short_morning : rs.owned_short_evening)
              : on ? rs.included : rs.optional;
        row.disabled = !tickable;
        if (tickable) row.setAttribute('aria-pressed', String(on)); else row.removeAttribute('aria-pressed');
        row.className = 'sa-step' + (on ? ' sa-step--on' : '');
      });
      return row;
    }

    function Moment(m) {
      var night = m.part === 'night';
      var toggle = m.chosen ? null : el('button', { type: 'button', className: 'sa-time__complete' });
      var note = m.chosen ? null : el('p', { className: 'sa-time__note' });
      if (toggle) toggle.addEventListener('click', function () {
        if (choice.added[m.part]) delete choice.added[m.part]; else choice.added[m.part] = true;
        persist();
        refresh();
      });
      var node = el('section', { className: 'sa-time' }, [
        el('header', { className: 'sa-time__head' }, [
          el('span', { className: 'sa-time__name' }, [icon(night ? ICONS.moon : ICONS.sun), el('strong', { text: partName(m.part) })]),
          el('small', { text: night ? rs.evening_eyebrow : rs.morning_eyebrow })
        ]),
        el('div', { className: 'sa-time__steps' }, m.steps.map(function (s, i) { return Step(m, s, i); })),
        note,
        toggle
      ]);
      refreshers.push(function () {
        node.className = 'sa-time' + (active(m) ? '' : ' sa-time--muted');
        // What « Compléter ma routine » would add, as ticked now.
        if (note) {
          var elsewhere = routineSelection(view, { removed: choice.removed, added: {} }).map(function (x) { return x.product_id; });
          var missing = m.steps.filter(function (s) { return buyable(m, s) && !removed(m, s) && elsewhere.indexOf(s.product_id) === -1; }).length;
          note.textContent = missing ? fill(rs.complete_note, { count: missing }) : rs.complete_none;
        }
        if (toggle) toggle.textContent = choice.added[m.part] ? (rs.remove || 'Retirer') : (rs.complete || 'Compléter ma routine');
      });
      return node;
    }

    /* A product once: full card for an essential, compact in « Compléter mon rituel ». */
    function Pick(p, compact) {
      var s = p.step;
      var media = el('span', { className: 'sa-pick__placeholder', 'aria-hidden': 'true' });
      var link = safeLink(s.url);
      if (link && !link.external && typeof s.handle === 'string') {
        productImage(s.handle).then(function (src) {
          if (src && media.parentNode) media.parentNode.replaceChild(el('img', { src: src, alt: '', loading: 'lazy', width: '120', height: '120' }), media);
        });
      }
      var title = typeof s.title === 'string' ? s.title : '';
      var stage = stageLabel(s);
      var parts = [];
      p.uses.forEach(function (u) { if (parts.indexOf(u.m.part) === -1) parts.push(u.m.part); });
      var when = parts.map(function (part) { return partName(part, true); }).filter(Boolean).join(' & ');
      var openPage = function () { if (onCardClick && typeof s.product_id === 'string') onCardClick(s.product_id); };

      var whyText = s.why && typeof s.why.text === 'string' ? s.why.text : '';
      var tags = s.why && Array.isArray(s.why.tags) ? s.why.tags.filter(function (t) { return typeof t === 'string'; }) : [];
      var folds = [Fold(rs.ingredients || 'Ingrédients clés', s.ingredients), Fold(rs.benefits || 'Bienfaits', s.benefits), Fold(rs.usage || 'Application', s.usage)].filter(Boolean);
      var detail = whyText || tags.length || folds.length
        ? el('div', { className: 'sa-pick__detail', hidden: true }, [
          whyText || tags.length ? el('p', { className: 'sa-pick__why' }, [
            tags.length ? el('strong', { text: tags.join(' · ') + ' — ' }) : null,
            document.createTextNode(whyText)
          ]) : null
        ].concat(folds))
        : null;
      var more = detail ? el('button', { type: 'button', className: 'sa-pick__more', 'aria-expanded': 'false' }, [el('span', { text: rs.why || 'Pourquoi pour vous ?' }), icon(ICONS.chevron)]) : null;
      var node;
      if (more) more.addEventListener('click', function () {
        var open = detail.hidden;
        detail.hidden = !open;
        more.setAttribute('aria-expanded', String(open));
        more.firstChild.textContent = open ? (rs.details_hide || 'Masquer les détails') : (rs.why || 'Pourquoi pour vous ?');
        node.classList.toggle('sa-pick--open', open);
      });

      var toggleLabel = el('span', { className: 'sa-pick__toggle-label' });
      var toggle = el('button', { type: 'button', className: 'sa-pick__toggle' });
      var status = el('span', { className: 'sa-pick__status' });
      toggle.addEventListener('click', function () { setProduct(s.product_id, !included(p, selection())); });

      node = el('article', { className: 'sa-pick' + (compact ? ' sa-pick--compact' : '') }, [
        el('div', { className: 'sa-pick__media' }, [media]),
        el('div', { className: 'sa-pick__main' }, [
          stage || when ? el('p', { className: 'sa-pick__eyebrow', text: (compact ? [stage || when] : [stage, when]).filter(Boolean).join(' · ') }) : null,
          link ? el('a', {
            className: 'sa-pick__title', href: link.href, target: link.external ? '_blank' : null, rel: link.external ? 'noopener noreferrer' : null, text: title, onClick: openPage
          }) : el('p', { className: 'sa-pick__title', text: title }),
          compact ? null : Stars(s.rating, s.rating_count, { reviews: rs.reviews, decimal: decimal }),
          more
        ]),
        el('div', { className: 'sa-pick__aside' }, [
          el('div', { className: 'sa-pick__price' }, [
            s.price ? el('p', { className: 'sa-pick__amount', text: String(s.price) }) : null,
            // The size chosen for them (« Normale 50 ml »), else the product's size.
            s.variant_title || s.volume ? el('p', { className: 'sa-pick__size', text: String(s.variant_title || s.volume) }) : null
          ]),
          toggle,
          status
        ]),
        detail
      ]);

      refreshers.push(function (items) {
        var on = included(p, items);
        var open = reachable(p);
        toggle.hidden = !open;
        toggle.setAttribute('aria-pressed', String(on));
        toggle.setAttribute('aria-label', (on ? rs.included : rs.add_one) + ' — ' + title);
        toggleLabel.textContent = on ? rs.included : rs.add_one;
        toggle.textContent = '';
        toggle.appendChild(icon(on ? ICONS.check : ICONS.plus));
        toggle.appendChild(toggleLabel);
        toggle.className = 'sa-pick__toggle' + (on ? ' sa-pick__toggle--on' : '');
        // Not to add from here: why (sold out, a size to choose, its moment not in the routine yet).
        var u = p.uses[0];
        status.textContent = open ? '' : !s.in_stock ? rs.unavailable : typeof s.variant_id !== 'string' ? rs.choose_size
          : (u.m.part === 'night' ? rs.with_evening : rs.with_morning);
        status.hidden = open;
        node.className = 'sa-pick' + (compact ? ' sa-pick--compact' : '') + (on ? ' sa-pick--on' : '') + (open ? '' : ' sa-pick--muted') + (detail && !detail.hidden ? ' sa-pick--open' : '');
      });
      return node;
    }

    // The footer button and the offer banner's « Ajouter ma routine » (owner, 2026-10-19) add the same selection.
    function addSelection() {
      if (addButton.disabled || !selection().length) return;
      addButton.disabled = true;
      if (bannerButton) bannerButton.disabled = true;
      addRoutineToCart(view, choice).then(function (result) {
        persist();
        addStatus.textContent = routineAddedText(view, result, strings);
        refresh();
      }).catch(function () {
        addButton.textContent = strings.addFailed || 'Réessayer';
        addButton.disabled = false;
        if (bannerButton) bannerButton.disabled = false;
      });
    }
    addButton.addEventListener('click', addSelection);

    var offered = discount && typeof discount.percentage === 'number';
    var bannerButton = offered ? el('button', { type: 'button', className: 'sa-routine__badge' }) : null;
    if (bannerButton) bannerButton.addEventListener('click', addSelection);
    var banner = offered
      ? el('div', { className: 'sa-routine__banner' }, [
        el('div', {}, [
          el('p', { className: 'sa-routine__banner-eyebrow', text: rs.banner_eyebrow }),
          el('p', { className: 'sa-routine__banner-title', text: fill(rs.banner_title, { percent: String(discount.percentage).replace('.', decimal) }) }),
          el('p', { className: 'sa-routine__banner-text', text: fill(rs.banner_text, { min: discount.min_products }) })
        ]),
        bannerButton
      ])
      : null;

    var expand = el('button', { type: 'button', className: 'sa-ritual__expand', 'aria-expanded': 'false' }, [el('span', { text: rs.show_steps }), icon(ICONS.chevron)]);
    var ritual = el('aside', { className: 'sa-ritual' }, [
      el('div', { className: 'sa-ritual__top' }, [
        el('div', {}, [
          el('p', { className: 'sa-routine__label', text: rs.glance }),
          el('h3', { className: 'sa-ritual__title', text: rs.ritual_title }),
          el('p', { className: 'sa-ritual__sub', text: rs.ritual_sub })
        ]),
        count
      ]),
      expand
    ].concat(moments.map(Moment)));
    expand.addEventListener('click', function () {
      var open = ritual.classList.toggle('sa-ritual--open');
      expand.setAttribute('aria-expanded', String(open));
      expand.firstChild.textContent = open ? rs.hide_steps : rs.show_steps;
    });

    var essentials = products.filter(essential);
    var extras = products.filter(function (p) { return !essential(p); });
    var picks = el('section', { className: 'sa-picks' }, [
      el('div', { className: 'sa-picks__intro' }, [
        el('div', {}, [
          el('p', { className: 'sa-routine__label', text: rs.selection }),
          el('h3', { className: 'sa-picks__title', text: rs.essentials })
        ]),
        pill
      ]),
      el('div', { className: 'sa-picks__list' }, essentials.map(function (p) { return Pick(p, false); })),
      extras.length ? el('div', { className: 'sa-picks__more' }, [
        el('div', {}, [
          el('p', { className: 'sa-routine__label', text: rs.more_eyebrow }),
          el('h4', { className: 'sa-picks__subtitle', text: rs.more_title })
        ]),
        el('span', { className: 'sa-picks__optional', text: rs.optional })
      ]) : null,
      extras.length ? el('div', { className: 'sa-picks__grid' }, extras.map(function (p) { return Pick(p, true); })) : null
    ]);

    var node = el('div', { className: 'sa-routine' }, [
      el('header', { className: 'sa-routine__head' }, [
        el('p', { className: 'sa-routine__eyebrow', text: rs.title || 'Votre routine' }),
        rs.headline ? el('h3', { className: 'sa-routine__headline', text: rs.headline }) : null,
        el('p', { className: 'sa-routine__hint', text: rs.hint })
      ]),
      banner,
      el('div', { className: 'sa-routine__layout' }, [ritual, picks]),
      el('footer', { className: 'sa-routine__footer' }, [
        el('div', { className: 'sa-routine__sum' }, [
          el('div', { className: 'sa-routine__copy' }, [totalLabel, minNote]),
          el('p', { className: 'sa-routine__prices' }, [was, now, saving])
        ]),
        addButton,
        addStatus
      ])
    ]);
    refresh();
    return node;
  }

  function AddButton(product, strings) {
    var button = el('button', { type: 'button', className: 'sa-card__add', text: strings.addToCart || 'Ajouter au panier' });
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      addToCart(product.variantId).then(function () {
        button.textContent = strings.added || 'Ajouté';
        button.className = 'sa-card__add sa-card__add--done';
        if (onCardAdd && typeof product.id === 'string') onCardAdd(product.id);
      }).catch(function () {
        button.textContent = strings.addFailed || 'Réessayer';
        button.disabled = false;
      });
    });
    return button;
  }

  function ProductList(products, strings) {
    var cards = products.slice(0, 6).map(function (p) { return ProductCard(p, strings); });
    if (!cards.length) return null;
    return el('div', { className: 'sa-products', role: 'group', 'aria-label': strings.productsLabel }, cards);
  }

  /*
   * Chips under the advisor's latest reply: a clarification's options (which
   * product?) or the consultation's next question (« Sèche », « Mixte », « Je
   * ne sais pas »). Labels and values come from the server, never from the
   * model; a click sends the label as the message and the value as `choice`.
   */
  function Choices(choices, onPick) {
    var valid = (choices || []).filter(function (c) { return c && typeof c.label === 'string' && typeof c.value === 'string'; }).slice(0, MAX_CHOICES);
    if (!valid.length) return null;
    return el('div', { className: 'sa-choices', role: 'group' }, valid.map(function (choice) {
      return el('button', { type: 'button', className: 'sa-chip sa-chip--choice', text: choice.label, onClick: function () { onPick(choice); } });
    }));
  }

  /* An advisor's text with its `**bold**` parts in bold (the repurchase message's days, owner 2026-10-29). Text nodes only. */
  function richText(text) {
    return String(text || '').split(/\*\*([^*]+)\*\*/).map(function (part, i) {
      return i % 2 ? el('strong', { text: part }) : document.createTextNode(part);
    });
  }

  function Bubble(message, strings, onRetry, onChoice) {
    var isUser = message.role === 'user';
    var node = el('div', { className: 'sa-message sa-message--' + (isUser ? 'user' : 'assistant') }, [
      el('span', { className: 'sa-visually-hidden', text: (isUser ? strings.you : strings.advisor) + ' : ' }),
      isUser ? el('p', { className: 'sa-bubble', text: message.text }) : el('p', { className: 'sa-bubble' }, richText(message.text))
    ]);
    // A finished routine: its cards replace the product cards and the routine button.
    var routine = !isUser && message.routineView ? RoutineView(message.routineView, message, strings, persistState) : null;
    if (routine) {
      node.className += ' sa-message--routine';
      node.appendChild(routine);
    } else if (!isUser && Array.isArray(message.products) && message.products.length) {
      node.className += ' sa-message--products';
      node.appendChild(ProductList(message.products, strings));
    }
    if (!isUser && typeof message.cartStatus === 'string') {
      node.appendChild(el('p', { className: 'sa-cart-status', role: 'status', text: message.cartStatus }));
    }
    if (!isUser && message.routineCart && !routine) {
      var routineButton = RoutineCartButton(message.routineCart, strings);
      if (routineButton) node.appendChild(routineButton);
    }
    var contact = !isUser ? contactHref(message.contact) : null;
    if (contact) {
      node.appendChild(el('a', { className: 'sa-contact', href: contact, text: strings.contactForm || 'Formulaire de contact' }));
    }
    if (!isUser && onChoice) {
      var chips = Choices(message.choices, onChoice);
      if (chips) node.appendChild(chips);
    }
    if (message.failed) {
      node.appendChild(ErrorNotice(strings, onRetry));
    }
    return node;
  }

  function ErrorNotice(strings, onRetry) {
    return el('div', { className: 'sa-error', role: 'alert' }, [
      el('span', { text: strings.error }),
      el('button', { type: 'button', className: 'sa-error__retry', text: strings.retry, onClick: onRetry })
    ]);
  }

  // A slow reply (an AI lookup takes 4-5 s): after a moment the dots get a line
  // of text, worded from what the customer asked, never from what the server
  // does (the widget only hears back once the whole answer is ready).
  var WAIT_TEXT_AFTER_MS = 1500;
  var WAIT_LONGER_AFTER_MS = 6000;
  // An order question, in every language the chat speaks: « ma commande », "my order", a parcel, an order number.
  // Generated: run `npm run widget:words` after changing a language pack.
  /* words:begin (generated by `npm run widget:words` from scripts/lib/i18n/<code>/words.mjs: do not edit) */
  var WORDS = {"order":"commandes?|colis|orders?|parcels?|packages?|ordin[ei]|pacc[oh]i?|bestellung\\w*|paket\\w*|bestelling\\w*|pakket\\w*|pedidos?|paquetes?"};
  /* words:end */
  var ORDER_WORDS = new RegExp('\\b(' + WORDS.order + ')\\b|#\\s?\\d{3,}', 'i');

  function waitText(stage, message, strings) {
    if (stage >= 2) return strings.waitLonger || 'Encore un instant…';
    if (stage === 1) return ORDER_WORDS.test(message || '') ? strings.waitOrder || 'Je vérifie votre commande…' : strings.waitLooking || 'Je regarde ça pour vous…';
    return '';
  }

  function TypingIndicator(strings, stage, message) {
    var text = waitText(stage, message, strings);
    return el('div', { className: 'sa-message sa-message--assistant sa-typing', role: 'status' }, [
      el('span', { className: 'sa-visually-hidden', text: text ? '' : strings.typing }),
      el('span', { className: 'sa-typing__dots', 'aria-hidden': text ? null : 'true' }, [
        el('i'), el('i'), el('i'),
        text ? el('span', { className: 'sa-typing__text', text: text }) : null
      ])
    ]);
  }

  function QuickActions(actions, strings, onPick) {
    if (!actions.length) return null;
    return el('div', { className: 'sa-actions', role: 'group', 'aria-label': strings.quickActionsLabel },
      actions.map(function (action) {
        return el('button', { type: 'button', className: 'sa-chip', text: action.label, onClick: function () { onPick(action); } });
      }));
  }

  /* ---------- the advisor ---------- */

  function createAdvisor(root, config, launcher, openNow, startAction) {
    var strings = config.strings || {};
    var actions = Array.isArray(config.quickActions) ? config.quickActions.filter(function (a) { return a && a.id && a.label; }) : [];
    var send = config.transport === 'proxy' && config.endpoint ? createProxyTransport(config) : createMockTransport(config);
    if (config.transport === 'proxy' && config.endpoint) {
      onCardClick = function (productId) { reportClick(config.endpoint, state.sessionId, productId); };
      onCardAdd = function (productId) { reportClick(config.endpoint, state.sessionId, productId, 'added_to_cart'); };
      onRoutineAdd = function (routineRef) { reportRoutineAdded(config.endpoint, routineRef); };
    }
    persistState = function () { saveState(state); };
    var mobile = window.matchMedia ? window.matchMedia(MOBILE_QUERY) : { matches: false };

    var viewer = typeof config.viewer === 'string' ? config.viewer : '';
    // The repurchase message, once seen, is not asked for again on this device for 30 days (askOpening).
    var OPENING_SEEN_KEY = STORAGE_KEY + ':opening-seen:' + viewer;
    var OPENING_QUIET_MS = 30 * 24 * 3600 * 1000;
    var stored = loadState(viewer);
    var state = {
      viewer: viewer,
      sessionId: stored ? stored.sessionId : newSessionId(),
      open: stored ? Boolean(stored.open) : false,
      messages: stored ? stored.messages : [],
      // Routine mode opens the panel wide (owner, 2026-10-18); the header button switches it back.
      wide: stored ? Boolean(stored.wide) : false,
      // The repurchase message is asked for once per tab (owner, 2026-10-29), « Nouvelle conversation » included.
      openingAsked: stored ? Boolean(stored.openingAsked) : false,
      pending: false,
      // 0 dots, 1 a line of text, 2 « encore un instant »: see waitText.
      waitStage: 0
    };
    var waitTimers = [];

    function startWaiting(message) {
      stopWaiting();
      [WAIT_TEXT_AFTER_MS, WAIT_LONGER_AFTER_MS].forEach(function (ms, i) {
        waitTimers.push(setTimeout(function () {
          if (!state.pending) return;
          state.waitStage = i + 1;
          var shown = log.querySelector('.sa-typing');
          if (shown) shown.parentNode.replaceChild(TypingIndicator(strings, state.waitStage, message), shown);
        }, ms));
      });
    }

    function stopWaiting() {
      waitTimers.forEach(clearTimeout);
      waitTimers = [];
      state.waitStage = 0;
    }

    var panelId = ROOT_ID + '-panel';
    var titleId = ROOT_ID + '-title';

    var log = el('div', { className: 'sa-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    var actionsSlot = el('div', { className: 'sa-actions-slot' });

    var input = el('textarea', {
      id: ROOT_ID + '-input',
      className: 'sa-input',
      rows: '1',
      maxlength: String(MAX_MESSAGE_CHARS),
      placeholder: strings.placeholder,
      autocomplete: 'off',
      enterkeyhint: 'send'
    });
    var sendButton = el('button', { type: 'submit', className: 'sa-send', 'aria-label': strings.send }, [icon(ICONS.send)]);
    var composer = el('form', { className: 'sa-composer', novalidate: true, onSubmit: onSubmit }, [
      el('label', { className: 'sa-visually-hidden', for: input.id, text: strings.inputLabel }),
      input,
      sendButton
    ]);

    var sizeButton = el('button', { type: 'button', className: 'sa-close sa-size', onClick: function () { setWide(!state.wide); } });
    // A new conversation (owner, 2026-10-18): a fresh session, the panel back to its size.
    var newChatButton = el('button', {
      type: 'button', className: 'sa-close sa-new', 'aria-label': strings.newChat || 'Nouvelle conversation', title: strings.newChat || 'Nouvelle conversation',
      onClick: function () { startOver(); }
    }, [icon(ICONS.newChat)]);

    var header;
    var panel = el('section', {
      id: panelId,
      className: 'sa-panel',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': titleId,
      hidden: true
    }, [
      header = el('header', { className: 'sa-header' }, [
        el('div', { className: 'sa-header__text' }, [
          el('p', { className: 'sa-eyebrow', text: strings.eyebrow }),
          el('h2', { id: titleId, className: 'sa-title', text: strings.title })
        ]),
        el('div', { className: 'sa-header__buttons' }, [
          newChatButton,
          sizeButton,
          el('button', { type: 'button', className: 'sa-close', 'aria-label': strings.close, onClick: function () { setOpen(false); } }, [icon(ICONS.close)])
        ])
      ]),
      log,
      actionsSlot,
      composer,
      el('p', { className: 'sa-disclaimer', text: strings.disclaimer })
    ]);

    root.appendChild(panel);
    var viewing = config.context && config.context.pageType === 'product' && config.context.productHandle
      ? ViewingCard(config.context.productHandle, config.context, strings, currentVariantId)
      : null;
    if (viewing) header.appendChild(viewing.node);
    launcher.addEventListener('click', function () { setOpen(true); });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        onSubmit(event);
      }
    });
    input.addEventListener('input', autosize);
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });
    if (mobile.addEventListener) mobile.addEventListener('change', syncScrollLock);

    setWide(state.wide, true);
    render();
    // Reopened across page loads on desktop only: a full-screen sheet greeting
    // every page on a phone would be in the customer's way.
    if (openNow) setOpen(true);
    else if (state.open && !mobile.matches) setOpen(true, true);
    else state.open = false;
    if (startAction) start(startAction);
    askOpening();

    /*
     * A quick action from outside the panel (the routine banner): the panel opens and the action
     * runs as its chip would. A conversation already under way gets it too: « Construire ma
     * routine » after other questions starts the builder.
     */
    function start(action) {
      if (!action || typeof action.id !== 'string' || typeof action.label !== 'string') return;
      setOpen(true);
      if (!state.pending) ask(action.label, action.id);
    }

    /*
     * The panel reaches up to just under the shop's header (owner, 2026-10-30): its bottom edge, read
     * from the theme's usual header elements, as --sa-top. No header in view (scrolled away, or none
     * found): the panel's own gap. Read again on resize and scroll while open (a sticky header hides).
     */
    var HEADER_SELECTOR = 'sticky-header, .shopify-section-header-sticky, #shopify-section-header, .section-header, header[role="banner"], .site-header, header';
    var fitQueued = false;
    function fitUnderHeader() {
      fitQueued = false;
      var header = document.querySelector(HEADER_SELECTOR);
      var bottom = header ? header.getBoundingClientRect().bottom : 0;
      var top = bottom > 0 && bottom < window.innerHeight / 2 ? Math.round(bottom) + 12 : null;
      if (top === null) root.style.removeProperty('--sa-top'); else root.style.setProperty('--sa-top', top + 'px');
    }
    function queueFit() {
      if (!state.open || fitQueued) return;
      fitQueued = true;
      (window.requestAnimationFrame || setTimeout)(fitUnderHeader);
    }
    window.addEventListener('resize', queueFit);
    window.addEventListener('scroll', queueFit, { passive: true });

    function setOpen(open, silent) {
      state.open = open;
      if (open) fitUnderHeader();
      // The variant chosen on the page may have changed since: its price.
      if (open && viewing) viewing.update();
      panel.hidden = !open;
      launcher.hidden = open;
      launcher.setAttribute('aria-expanded', String(open));
      root.classList.toggle('sa-root--open', open);
      syncScrollLock();
      saveState(state);
      if (open) {
        // Laid out again now it is visible: a reply with cards (the repurchase message, fetched while the
        // panel was closed) scrolls to its text, not to the bottom.
        render();
        if (!silent) input.focus();
        markOpeningSeen();
      } else if (!silent) {
        launcher.focus();
      }
    }

    /*
     * A signed-in customer with an empty chat: the proxy's /opening route may answer with their favourite
     * product to buy again (owner, 2026-10-29), shown under the greeting. Asked on page load, once per tab,
     * so it is there when the chat opens (« needs to come in much faster »). Not again on this device for
     * 30 days once seen (« deterministic and instant check »: no request at all). Nothing comes for an
     * anonymous visitor, and nothing is waited for: a customer who types first keeps their own turn.
     */
    function openingSeenRecently() {
      try {
        var at = Number(window.localStorage.getItem(OPENING_SEEN_KEY));
        return at > 0 && Date.now() - at < OPENING_QUIET_MS;
      } catch (error) { return false; }
    }
    /* Seen means shown in an open panel: one fetched while it stayed closed does not count. */
    function markOpeningSeen() {
      if (!state.open || !state.messages.some(function (m) { return m.opening; })) return;
      try { window.localStorage.setItem(OPENING_SEEN_KEY, String(Date.now())); } catch (error) { /* not fatal */ }
    }
    function askOpening() {
      if (config.transport !== 'proxy' || !config.endpoint || !viewer || state.openingAsked || state.messages.length || state.pending || openingSeenRecently()) return;
      state.openingAsked = true;
      saveState(state);
      var url = String(config.endpoint).replace(/\/chat$/, '/opening');
      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          context: { locale: config.context && config.context.locale || document.documentElement.lang || null, loggedIn: true }
        })
      }).then(function (response) {
        return response.status === 200 ? response.json() : null;
      }).then(function (body) {
        if (!body || !body.reply || typeof body.reply.text !== 'string' || !body.reply.text || state.messages.length || state.pending) return;
        state.messages.push({
          role: 'assistant',
          opening: true,
          text: body.reply.text,
          products: Array.isArray(body.reply.products) ? body.reply.products : [],
          choices: Array.isArray(body.reply.choices) ? body.reply.choices : []
        });
        markOpeningSeen();
        saveState(state);
        render();
      }).catch(function () { /* the greeting stands alone */ });
    }

    function setWide(wide, silent) {
      state.wide = Boolean(wide);
      panel.classList.toggle('sa-panel--wide', state.wide);
      var label = (strings.routine || {})[state.wide ? 'collapse' : 'expand'] || (state.wide ? 'Réduire' : 'Agrandir');
      sizeButton.setAttribute('aria-label', label);
      sizeButton.setAttribute('title', label);
      sizeButton.textContent = '';
      sizeButton.appendChild(icon(state.wide ? ICONS.collapse : ICONS.expand));
      if (!silent) saveState(state);
    }

    function startOver() {
      if (state.pending) return;
      state.messages = [];
      state.sessionId = newSessionId();
      state.showRoutine = false;
      setWide(false, true);
      saveState(state);
      render();
      input.value = '';
      autosize();
      if (!mobile.matches) input.focus();
    }

    function syncScrollLock() {
      document.documentElement.classList.toggle('sa-scroll-lock', state.open && mobile.matches);
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    function onSubmit(event) {
      event.preventDefault();
      var text = input.value.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || state.pending) return;
      input.value = '';
      autosize();
      ask(text, null);
    }

    function ask(text, actionId, choice) {
      state.messages.push({ role: 'user', text: text, action: actionId, choice: choice || null });
      deliver(state.messages[state.messages.length - 1]);
    }

    function deliver(userMessage) {
      userMessage.failed = false;
      state.pending = true;
      state.waitingFor = userMessage.text;
      render();
      startWaiting(userMessage.text);
      send({
        sessionId: state.sessionId,
        message: userMessage.text,
        action: userMessage.action || null,
        choice: userMessage.choice || null,
        // The first answer under the repurchase message: the server stores that message before it.
        opening: state.messages[0] && state.messages[0].opening === true && state.messages.filter(function (m) { return m.role === 'user'; }).length === 1,
        context: {
          pageType: config.context && config.context.pageType || null,
          productHandle: config.context && config.context.productHandle || null,
          collectionHandle: config.context && config.context.collectionHandle || null,
          locale: config.context && config.context.locale || document.documentElement.lang || null,
          country: config.context && config.context.country || null,
          currency: config.context && config.context.currency || null,
          market: config.context && config.context.market || null,
          loggedIn: config.context && config.context.loggedIn === true,
          variantId: currentVariantId(),
          path: window.location.pathname
        }
      }).then(function (body) {
        if (body.sessionId && typeof body.sessionId === 'string') state.sessionId = body.sessionId;
        state.messages.push({
          role: 'assistant',
          text: String(body.reply.text || ''),
          products: Array.isArray(body.reply.products) ? body.reply.products : [],
          choices: Array.isArray(body.reply.choices) ? body.reply.choices : [],
          contact: body.reply.contact && typeof body.reply.contact.url === 'string' ? { url: body.reply.contact.url } : null,
          routineCart: body.reply.routineCart && Array.isArray(body.reply.routineCart.add) ? body.reply.routineCart : null,
          routineView: body.reply.routineView && Array.isArray(body.reply.routineView.moments) ? body.reply.routineView : null,
          layout: body.reply.layout === 'routine' ? 'routine' : null
        });
        // Entering routine mode widens the panel once; a customer who collapses it keeps it collapsed.
        var before = state.messages.slice(0, -1).filter(function (m) { return m.role === 'assistant'; }).pop();
        if (body.reply.layout === 'routine' && !(before && before.layout === 'routine')) setWide(true);
        // A routine is long: it opens at its top, not at the end of the conversation.
        if (body.reply.routineView) state.showRoutine = true;
        // « Oui, ajouter »: the customer just clicked it; the widget adds, once, here (never on a re-render).
        var cart = body.reply.cart;
        var routineMessage = cart && typeof cart.routine_ref === 'string'
          ? state.messages.filter(function (m) { return m.routineView && m.routineView.ref === cart.routine_ref; }).pop()
          : null;
        if (routineMessage) {
          var said = state.messages[state.messages.length - 1];
          addRoutineToCart(routineMessage.routineView, routineChoiceOf(routineMessage)).then(function (result) {
            said.cartStatus = routineAddedText(routineMessage.routineView, result, strings);
          }).catch(function () {
            said.cartStatus = strings.cartFailed || 'L\'ajout au panier n\'a pas fonctionné : ajoutez-le depuis sa fiche produit.';
          }).then(function () { saveState(state); render(); });
        } else if (cart && Array.isArray(cart.add) && cart.add.length) {
          var answered = state.messages[state.messages.length - 1];
          addAllToCart(cart.add.map(function (x) { return x.variant_id; })).then(function () {
            return applyDiscount(cart.discount_code);
          }).then(function () {
            if (onCardAdd) cart.add.forEach(function (x) { if (typeof x.product_id === 'string') onCardAdd(x.product_id); });
            answered.cartStatus = strings.cartAdded || 'C\'est dans votre panier.';
          }).catch(function () {
            answered.cartStatus = strings.cartFailed || 'L\'ajout au panier n\'a pas fonctionné : ajoutez-le depuis sa fiche produit.';
          }).then(function () { saveState(state); render(); });
        }
        // The advisor's own second message (the routine offer, a question, a
        // card, a treat): its own bubble, with its own cards and buttons.
        var followUp = body.reply.followUp;
        if (followUp && typeof followUp.text === 'string' && followUp.text) {
          state.messages.push({
            role: 'assistant',
            text: followUp.text,
            products: Array.isArray(followUp.products) ? followUp.products : [],
            choices: Array.isArray(followUp.choices) ? followUp.choices : []
          });
        }
      }).catch(function () {
        userMessage.failed = true;
      }).then(function () {
        state.pending = false;
        stopWaiting();
        saveState(state);
        render();
        if (state.open && !mobile.matches) input.focus();
      });
    }

    function currentVariantId() {
      if (!config.context || !config.context.productHandle) return null;
      var selected = document.querySelector('form[action$="/cart/add"] [name="id"]');
      var id = selected && selected.value || new URLSearchParams(window.location.search).get('variant');
      return /^[1-9][0-9]{0,19}$/.test(id || '') ? 'gid://shopify/ProductVariant/' + id : config.context.variantId || null;
    }

    function render() {
      log.textContent = '';
      log.appendChild(Bubble({ role: 'assistant', text: strings.greeting }, strings));
      var last = state.messages[state.messages.length - 1];
      // The first reply since the customer last wrote that shows product cards: the scroll stops at its text.
      var lastUser = -1;
      state.messages.forEach(function (m, i) { if (m.role === 'user') lastUser = i; });
      var withCards = null;
      state.messages.forEach(function (message, i) {
        // Only the latest reply's chips are live: an old question is not re-asked.
        var onChoice = message === last && !state.pending
          ? function (choice) { ask(choice.label, null, choice.value); }
          : null;
        var node = Bubble(message, strings, function () { deliver(message); }, onChoice);
        if (!withCards && i > lastUser && message.role !== 'user' && node.querySelector('.sa-card')) withCards = node;
        log.appendChild(node);
      });
      if (state.pending) log.appendChild(TypingIndicator(strings, state.waitStage, state.waitingFor));

      actionsSlot.textContent = '';
      // The repurchase message counts as started: its own buttons replace the quick actions.
      var started = state.messages.some(function (m) { return m.role === 'user' || m.opening; });
      if (!started) {
        var chips = QuickActions(actions, strings, function (action) {
          if (!state.pending) ask(action.label, action.id);
        });
        if (chips) actionsSlot.appendChild(chips);
      }

      sendButton.disabled = state.pending;
      newChatButton.disabled = state.pending || !started;
      composer.setAttribute('aria-busy', String(state.pending));
      var routines = state.showRoutine && !state.pending ? log.querySelectorAll('.sa-message--routine') : [];
      if (routines.length) {
        state.showRoutine = false;
        log.scrollTop = Math.max(0, routines[routines.length - 1].offsetTop - log.offsetTop - 12);
      } else if (withCards && !state.pending) scrollToText(withCards);
      else scrollToEnd();
    }

    /*
     * A reply with product cards (owner, 2026-10-29: « it would be best if it didn't include the product card
     * in the scroll »): scrolled until its text is in view, the cards below it, not to the bottom of the cards.
     * A text taller than the panel shows from its top.
     */
    function scrollToText(message) {
      var text = message.querySelector('.sa-bubble');
      if (!text) return scrollToEnd();
      var box = log.getBoundingClientRect();
      var at = text.getBoundingClientRect();
      var shift = at.height + 24 > box.height ? at.top - box.top - 12 : at.bottom - box.bottom + 12;
      log.scrollTop = Math.max(0, Math.min(log.scrollHeight, log.scrollTop + shift));
    }

    function scrollToEnd() {
      log.scrollTop = log.scrollHeight;
    }

    return { start: start };
  }

  window.StorefrontAdvisorPanel = { mount: createAdvisor };
})();
