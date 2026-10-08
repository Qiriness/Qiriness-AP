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
    send: ['M3.5 12h16', 'M14.5 7l5 5-5 5']
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

  /* Session storage can throw (private mode, blocked storage): the widget works without it. */
  function loadState() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.sessionId === 'string' && Array.isArray(parsed.messages)) return parsed;
    } catch (error) { /* fall through */ }
    return null;
  }

  function saveState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId: state.sessionId,
        open: state.open,
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

  function safeImage(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
  }

  /* ---------- transports ---------- */

  /*
   * A card click as a beacon to the proxy's /event route, next to /chat. It
   * never delays the navigation and never reports an error to the shopper.
   */
  function reportClick(endpoint, sessionId, productId) {
    try {
      var url = String(endpoint).replace(/\/chat$/, '/event');
      var body = JSON.stringify({ sessionId: sessionId, productId: productId });
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () {});
    } catch (e) { /* a lost click is a lost data point, nothing more */ }
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

  function ProductCard(product, strings) {
    var link = safeLink(product.url);
    var image = safeImage(product.image);
    var title = typeof product.title === 'string' ? product.title : '';
    return el('article', { className: 'sa-card' }, [
      el('div', { className: 'sa-card__media' }, [
        image ? el('img', { src: image, alt: '', loading: 'lazy', width: '160', height: '160' }) : el('span', { className: 'sa-card__placeholder', 'aria-hidden': 'true' })
      ]),
      el('div', { className: 'sa-card__body' }, [
        el('h3', { className: 'sa-card__title', text: title }),
        product.rationale ? el('p', { className: 'sa-card__rationale', text: String(product.rationale) }) : null,
        product.price ? el('p', { className: 'sa-card__price', text: String(product.price) }) : null,
        link ? el('a', {
          className: 'sa-card__cta',
          href: link.href,
          target: link.external ? '_blank' : null,
          rel: link.external ? 'noopener noreferrer' : null,
          text: strings.discover,
          'aria-label': strings.discover + ' — ' + title,
          onClick: function () { if (onCardClick && typeof product.id === 'string') onCardClick(product.id); }
        }) : null
      ])
    ]);
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

  function Bubble(message, strings, onRetry, onChoice) {
    var isUser = message.role === 'user';
    var node = el('div', { className: 'sa-message sa-message--' + (isUser ? 'user' : 'assistant') }, [
      el('span', { className: 'sa-visually-hidden', text: (isUser ? strings.you : strings.advisor) + ' : ' }),
      el('p', { className: 'sa-bubble', text: message.text })
    ]);
    if (!isUser && Array.isArray(message.products) && message.products.length) {
      node.appendChild(ProductList(message.products, strings));
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

  function TypingIndicator(strings) {
    return el('div', { className: 'sa-message sa-message--assistant sa-typing', role: 'status' }, [
      el('span', { className: 'sa-visually-hidden', text: strings.typing }),
      el('span', { className: 'sa-typing__dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')])
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

  function createAdvisor(root, config, launcher, openNow) {
    var strings = config.strings || {};
    var actions = Array.isArray(config.quickActions) ? config.quickActions.filter(function (a) { return a && a.id && a.label; }) : [];
    var send = config.transport === 'proxy' && config.endpoint ? createProxyTransport(config) : createMockTransport(config);
    if (config.transport === 'proxy' && config.endpoint) onCardClick = function (productId) { reportClick(config.endpoint, state.sessionId, productId); };
    var mobile = window.matchMedia ? window.matchMedia(MOBILE_QUERY) : { matches: false };

    var stored = loadState();
    var state = {
      sessionId: stored ? stored.sessionId : newSessionId(),
      open: stored ? Boolean(stored.open) : false,
      messages: stored ? stored.messages : [],
      pending: false
    };

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

    var panel = el('section', {
      id: panelId,
      className: 'sa-panel',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': titleId,
      hidden: true
    }, [
      el('header', { className: 'sa-header' }, [
        el('div', { className: 'sa-header__text' }, [
          el('p', { className: 'sa-eyebrow', text: strings.eyebrow }),
          el('h2', { id: titleId, className: 'sa-title', text: strings.title })
        ]),
        el('button', { type: 'button', className: 'sa-close', 'aria-label': strings.close, onClick: function () { setOpen(false); } }, [icon(ICONS.close)])
      ]),
      log,
      actionsSlot,
      composer,
      el('p', { className: 'sa-disclaimer', text: strings.disclaimer })
    ]);

    root.appendChild(panel);
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

    render();
    // Reopened across page loads on desktop only: a full-screen sheet greeting
    // every page on a phone would be in the customer's way.
    if (openNow) setOpen(true);
    else if (state.open && !mobile.matches) setOpen(true, true);
    else state.open = false;

    function setOpen(open, silent) {
      state.open = open;
      panel.hidden = !open;
      launcher.hidden = open;
      launcher.setAttribute('aria-expanded', String(open));
      root.classList.toggle('sa-root--open', open);
      syncScrollLock();
      saveState(state);
      if (open) {
        scrollToEnd();
        if (!silent) input.focus();
      } else if (!silent) {
        launcher.focus();
      }
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
      render();
      send({
        sessionId: state.sessionId,
        message: userMessage.text,
        action: userMessage.action || null,
        choice: userMessage.choice || null,
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
          choices: Array.isArray(body.reply.choices) ? body.reply.choices : []
        });
      }).catch(function () {
        userMessage.failed = true;
      }).then(function () {
        state.pending = false;
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
      state.messages.forEach(function (message) {
        // Only the latest reply's chips are live: an old question is not re-asked.
        var onChoice = message === last && !state.pending
          ? function (choice) { ask(choice.label, null, choice.value); }
          : null;
        log.appendChild(Bubble(message, strings, function () { deliver(message); }, onChoice));
      });
      if (state.pending) log.appendChild(TypingIndicator(strings));

      actionsSlot.textContent = '';
      var started = state.messages.some(function (m) { return m.role === 'user'; });
      if (!started) {
        var chips = QuickActions(actions, strings, function (action) {
          if (!state.pending) ask(action.label, action.id);
        });
        if (chips) actionsSlot.appendChild(chips);
      }

      sendButton.disabled = state.pending;
      composer.setAttribute('aria-busy', String(state.pending));
      scrollToEnd();
    }

    function scrollToEnd() {
      log.scrollTop = log.scrollHeight;
    }
  }

  window.StorefrontAdvisorPanel = { mount: createAdvisor };
})();
