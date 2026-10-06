/* Shared browser/server whitelist. This module never reads or writes customer data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QirinessCart = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var MAX_LINES = 40;
  function integer(n, max) { return Number.isSafeInteger(n) && n >= 0 && n <= max; }
  function gid(value, type) {
    var text = String(value || '');
    if (/^[1-9][0-9]{0,19}$/.test(text)) return 'gid://shopify/' + type + '/' + text;
    return new RegExp('^gid://shopify/' + type + '/[1-9][0-9]{0,19}$').test(text) ? text : null;
  }
  function code(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value.toUpperCase() : null; }
  function label(value, max) {
    if (typeof value !== 'string' || value.length > max) return null;
    var plain = value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    return plain || null;
  }
  function needsShoppingContext(message, action, context) {
    return action === 'offers' || /\b(panier|cart|basket|stock|disponib|availab|promo|offre|offer|discount|remise|reduction|réduction|code|cumul|stack|checkout|quantit)/i.test(message || '') || Boolean(context && context.pageType === 'cart' && /\b(they|them|these|adapt|suit|convien|ces|ils|elles)|(?:can you see|voyez.vous)/i.test(message || ''));
  }
  function needsCartSnapshot(message, action, context) {
    if (!needsShoppingContext(message, action, context)) return false;
    if (/panier|cart|basket|tout|everything/i.test(message || '')) return true;
    if ((action === 'offers' || /\b(offres?|promotions?|offers?)\s+(?:sont\s+)?(?:disponib|availab)|offres?.*(?:moment|actuell)|current offers/i.test(message || '')) && !/code|cumul|stack|manque|appliqu|fonctionn|eligib|éligib/i.test(message || '')) return false;
    if (/stock|disponib|availab/i.test(message || '') && context && context.productHandle && !/promo|offre|code|discount/i.test(message || '')) return false;
    return true;
  }
  function normalizeSnapshot(raw) {
    if (!raw || !Array.isArray(raw.lines) || raw.lines.length > MAX_LINES || !/^[A-Z]{3}$/.test(raw.currency || '')) return null;
    if (![raw.originalSubtotal, raw.subtotal, raw.total].every(function (n) { return integer(n, 10000000000); })) return null;
    var lines = raw.lines.map(function (line) {
      if (!line || !gid(line.productId, 'Product') || !gid(line.variantId, 'ProductVariant') || !integer(line.quantity, 999) || !line.quantity) return null;
      if (![line.unitPrice, line.originalTotal, line.finalTotal].every(function (n) { return integer(n, 10000000000); }) || line.finalTotal > line.originalTotal) return null;
      if (Math.abs(line.unitPrice * line.quantity - line.originalTotal) > line.quantity) return null;
      return { productId: gid(line.productId, 'Product'), variantId: gid(line.variantId, 'ProductVariant'), productName: label(line.productName, 200), variantTitle: label(line.variantTitle, 100), quantity: line.quantity, unitPrice: line.unitPrice, originalTotal: line.originalTotal, finalTotal: line.finalTotal, controlledPricing: line.controlledPricing === true };
    });
    if (lines.some(function (l) { return !l; })) return null;
    if (lines.reduce(function (n, l) { return n + l.originalTotal; }, 0) !== raw.originalSubtotal || lines.reduce(function (n, l) { return n + l.finalTotal; }, 0) !== raw.subtotal || raw.total > raw.subtotal) return null;
    if (!Array.isArray(raw.discounts) || raw.discounts.length > 40 || !Array.isArray(raw.codes) || raw.codes.length > 10) return null;
    var discounts = raw.discounts.map(function (d) {
      if (!d || typeof d.title !== 'string' || d.title.length > 160 || !integer(d.amount, 10000000000) || !['automatic', 'code', 'unknown'].includes(d.type)) return null;
      return { title: d.title.replace(/[\u0000-\u001f]/g, ''), type: d.type, amount: d.amount };
    });
    if (discounts.some(function (d) { return !d; })) return null;
    return { currency: raw.currency, originalSubtotal: raw.originalSubtotal, subtotal: raw.subtotal, total: raw.total, lines: lines, discounts: discounts, codes: raw.codes.map(code).filter(Boolean), enteredCodesAvailable: raw.enteredCodesAvailable === true };
  }
  function fromAjaxCart(raw) {
    if (!raw || !Array.isArray(raw.items)) return null;
    var applications = new Map();
    function add(app, amount) {
      if (!app) return;
      var type = app.type === 'discount_code' ? 'code' : app.type === 'automatic' ? 'automatic' : 'unknown';
      var key = type + ':' + app.title;
      var current = applications.get(key) || { title: app.title, type: type, amount: 0 };
      current.amount += amount;
      applications.set(key, current);
    }
    (raw.cart_level_discount_applications || []).forEach(function (a) { add(a, a.total_allocated_amount); });
    var lines = raw.items.map(function (l) {
      (l.line_level_discount_allocations || []).forEach(function (a) { add(a.discount_application, a.amount); });
      return { productId: l.product_id, variantId: l.variant_id, productName: l.product_title, variantTitle: l.variant_title, quantity: l.quantity, unitPrice: l.original_price, originalTotal: l.original_line_price, finalTotal: l.final_line_price, controlledPricing: Boolean(l.selling_plan_allocation || l.parent_relationship || l.item_components && l.item_components.length) };
    });
    return normalizeSnapshot({ currency: raw.currency, originalSubtotal: raw.original_total_price, subtotal: raw.items_subtotal_price, total: raw.total_price, lines: lines, discounts: Array.from(applications.values()), codes: Array.from(applications.values()).filter(function (a) { return a.type === 'code'; }).map(function (a) { return a.title; }), enteredCodesAvailable: false });
  }
  return { normalizeSnapshot: normalizeSnapshot, fromAjaxCart: fromAjaxCart, needsShoppingContext: needsShoppingContext, needsCartSnapshot: needsCartSnapshot, gid: gid, code: code };
});
