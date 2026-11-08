// The product page's question box (extensions/storefront-advisor/assets/advisor-ask.js), on a hand-made DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The script runs in its own context: its objects compared as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));
const SOURCE = readFileSync(new URL('../../../extensions/storefront-advisor/assets/advisor-ask.js', import.meta.url), 'utf8');

function node(attrs = {}, children = []) {
  const listeners = {};
  const n = {
    attrs: { ...attrs }, children, parent: null, hidden: false, value: '', textContent: '', focused: 0, blurred: 0,
    getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
    setAttribute: (k, v) => { n.attrs[k] = String(v); },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    listeners,
    // Bubbles, as clicks and submits do.
    fire: (type) => {
      const e = { target: n, preventDefault() { e.prevented = true; } };
      for (let x = n; x; x = x.parent) for (const fn of x.listeners[type] ?? []) fn(e);
      return e;
    },
    querySelector: (sel) => n.all().find((c) => c.matches(sel)) ?? null,
    all: () => n.children.flatMap((c) => [c, ...c.all()]),
    matches: (sel) => (sel === 'form' || sel === 'input' ? n.attrs.tag === sel : sel.startsWith('[') && sel.slice(1, -1) in n.attrs),
    closest: (sel) => { for (let x = n; x; x = x.parent) if (x.matches(sel)) return x; return null; },
    focus: () => { n.focused += 1; },
    blur: () => { n.blurred += 1; }
  };
  for (const c of children) c.parent = n;
  return n;
}

function page({ embed = true, designMode = false, advisor = true } = {}) {
  const text = node({ 'data-sa-ask-text': '' }); text.textContent = ' Comment utiliser\n ce soin ? ';
  const usage = node({ 'data-sa-ask-chip': '', 'data-action': '' }, [node(), text]);
  const delivery = node({ 'data-sa-ask-chip': '', 'data-action': 'delivery' }, [Object.assign(node({ 'data-sa-ask-text': '' }), { textContent: 'Temps de livraison' })]);
  const icon = node();
  delivery.children.push(icon); icon.parent = delivery;
  const input = node({ tag: 'input' });
  const form = node({ tag: 'form' }, [input]);
  const box = node({ 'data-sa-ask': '' }, [delivery, usage, form]);
  const asked = [];
  const window = { Shopify: designMode ? { designMode: true } : {}, ...(advisor ? { StorefrontAdvisor: { ask: (q) => asked.push(q) } } : {}) };
  const document = {
    readyState: 'complete',
    getElementById: (id) => (embed && id === 'storefront-advisor' ? {} : null),
    querySelectorAll: () => [box],
    addEventListener: () => {}
  };
  vm.runInNewContext(SOURCE, { window, document });
  return { box, delivery, usage, icon, input, form, asked, window };
}

test('a preset asks its action with its label; a typed preset asks its hidden question', () => {
  const p = page();
  p.icon.fire('click');
  p.usage.fire('click');
  assert.deepEqual(plain(p.asked), [{ id: 'delivery', label: 'Temps de livraison' }, { id: '', label: 'Comment utiliser ce soin ?' }]);
});

test('a typed question is asked once, the bar emptied; an empty bar asks nothing', () => {
  const p = page();
  p.input.value = '   ';
  assert.equal(p.form.fire('submit').prevented, true);
  assert.equal(p.input.focused, 1);
  p.input.value = '  Convient-il aux peaux sensibles ?  ';
  p.form.fire('submit');
  assert.deepEqual(plain(p.asked), [{ id: '', label: 'Convient-il aux peaux sensibles ?' }]);
  assert.equal(p.input.value, '');
  assert.equal(p.input.blurred, 1);
});

test('before the advisor is drawn, questions wait in the queue advisor.js drains', () => {
  const p = page({ advisor: false });
  p.delivery.fire('click');
  assert.deepEqual(plain(p.window.StorefrontAdvisorAsks), [{ id: 'delivery', label: 'Temps de livraison' }]);
});

test('without the app embed the box hides on the shop, and stays in the theme editor', () => {
  assert.equal(page({ embed: false }).box.hidden, true);
  assert.equal(page({ embed: false, designMode: true }).box.hidden, false);
});
