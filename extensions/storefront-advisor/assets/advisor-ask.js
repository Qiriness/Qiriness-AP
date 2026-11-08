/* The product page's question box (blocks/advisor-ask.liquid): a preset or a typed question opens the advisor and asks it. */
(function () {
  'use strict';

  // advisor.js sets window.StorefrontAdvisor once drawn; a question sent before that waits in the queue it drains.
  function ask(question) {
    if (window.StorefrontAdvisor && typeof window.StorefrontAdvisor.ask === 'function') return window.StorefrontAdvisor.ask(question);
    (window.StorefrontAdvisorAsks = window.StorefrontAdvisorAsks || []).push(question);
  }

  function wire(box) {
    if (box.getAttribute('data-ready')) return;
    box.setAttribute('data-ready', 'true');
    // Without the app embed there is nothing to open: hidden on the shop, kept in the theme editor (its note says why).
    var designMode = window.Shopify && window.Shopify.designMode;
    if (!document.getElementById('storefront-advisor') && !designMode) {
      box.hidden = true;
      return;
    }

    box.addEventListener('click', function (event) {
      var chip = event.target.closest && event.target.closest('[data-sa-ask-chip]');
      if (!chip) return;
      var text = chip.querySelector('[data-sa-ask-text]');
      ask({ id: chip.getAttribute('data-action') || '', label: (text || chip).textContent.replace(/\s+/g, ' ').trim() });
    });

    var form = box.querySelector('form');
    var input = box.querySelector('input');
    if (!form || !input) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return input.focus();
      input.value = '';
      input.blur();
      ask({ id: '', label: text });
    });
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-sa-ask]'), wire);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // The theme editor re-renders a section in place.
  document.addEventListener('shopify:section:load', boot);
})();
