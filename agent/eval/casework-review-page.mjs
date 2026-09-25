import {
  CASE_STATES,
  COMMON_INTERNAL_CHECKS,
  CUSTOMER_QUESTIONS,
  FIELDS_BY_DIRECTION,
  INBOUND_EFFECTS,
  INTERNAL_CHECKS,
  NEXT_ACTIONS,
  OUTBOUND_EFFECTS,
  REQUIRED_BY_DIRECTION
} from './casework-vocabulary.mjs';

// The page a person labels the multi-turn set on.
//
// IT QUOTES REAL CUSTOMER MAIL, so it is written to a gitignored `*-review.html`
// name and never published. The labels it exports carry ids and choices only.
//
// ALL TEXT REACHES THE PAGE AS DATA. The threads travel as one JSON block and
// the script renders them with `textContent`, so a message body containing
// markup is shown as the characters it is rather than interpreted.
//
// ONE THREAD AT A TIME, TOP TO BOTTOM, with the form under each message. Read
// down and label each message as of the moment it landed: the question is what
// the pipeline should have decided then, not what we know now.
//
// PROGRESS SURVIVES A CLOSED TAB — the labels autosave in this browser — and
// the Export button is what hands them back. Two sittings is the expected cost.

export function renderReviewPage({ threads, generatedAt, prefillModel = null }) {
  const data = {
    generatedAt,
    prefillModel,
    vocab: {
      inboundEffects: INBOUND_EFFECTS,
      outboundEffects: OUTBOUND_EFFECTS,
      customerQuestions: CUSTOMER_QUESTIONS,
      internalChecks: INTERNAL_CHECKS,
      caseStates: CASE_STATES,
      nextActions: NEXT_ACTIONS,
      commonInternalChecks: COMMON_INTERNAL_CHECKS,
      fieldsByDirection: FIELDS_BY_DIRECTION,
      requiredByDirection: REQUIRED_BY_DIRECTION
    },
    threads
  };
  // `</` would end the script element early; `<` is the same character to
  // JSON.parse and nothing to the HTML parser.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Casework labels</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="bar">
    <strong>Jeu de test multi-tours</strong>
    <span id="progress"></span>
    <span class="spacer"></span>
    <button id="prev">←</button>
    <select id="jump"></select>
    <button id="next">→</button>
    <button id="export" class="primary">Exporter</button>
    <label class="file">Importer<input id="import" type="file" accept="application/json" hidden></label>
  </div>
  <p class="lede">Lisez de haut en bas. Sous chaque message : ce qu'il a changé, et ce que le pipeline devait décider <em>à ce moment-là</em>, sans tenir compte de la suite. Les valeurs <span class="sugg">suggérées</span> viennent du Case Manager actuel — à corriger, pas à croire.</p>
</header>
<main id="thread"></main>
<script type="application/json" id="data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root { --ink:#16211c; --sub:#5d6b64; --line:#dfe5e1; --bg:#f7f9f8; --card:#fff; --teal:#0f766e; --tealbg:#e6f3f1; --amber:#a3541a; --amberbg:#fdf3e8; --ours:#eef2f7; }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif; color:var(--ink); background:var(--bg); }
header { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:.6rem 1rem .4rem; }
.bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
.spacer { flex:1; }
#progress { color:var(--sub); font-size:.9rem; }
button, .file, select { font:inherit; font-size:.9rem; border:1px solid var(--line); background:var(--card); border-radius:6px; padding:.25rem .6rem; cursor:pointer; }
select#jump { max-width:22rem; }
.primary { background:var(--teal); border-color:var(--teal); color:#fff; }
.lede { color:var(--sub); font-size:.88rem; margin:.4rem 0 0; max-width:60rem; }
.sugg { background:var(--amberbg); color:var(--amber); border-radius:4px; padding:0 .3rem; }
main { max-width:58rem; margin:0 auto; padding:1rem 1rem 6rem; }
h2 { font-size:1.05rem; margin:.2rem 0; }
.meta { color:var(--sub); font-size:.85rem; margin-bottom:1rem; }
.msg { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.8rem 1rem; margin:0 0 .5rem; }
.msg.out { background:var(--ours); }
.who { font-size:.8rem; color:var(--sub); margin-bottom:.35rem; display:flex; gap:.5rem; flex-wrap:wrap; }
.who b { color:var(--ink); }
.body { white-space:pre-wrap; overflow-wrap:anywhere; }
details.quoted { margin-top:.4rem; color:var(--sub); font-size:.85rem; }
details.quoted pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
.form { border:1px solid var(--line); border-left:3px solid var(--teal); border-radius:8px; background:var(--card); padding:.6rem .8rem; margin:0 0 1.2rem 1.2rem; }
.form.done { border-left-color:#9aa8a1; }
.row { display:grid; grid-template-columns:11rem 1fr; gap:.2rem .8rem; align-items:start; margin:.3rem 0; }
.row > span { font-size:.82rem; color:var(--sub); padding-top:.2rem; }
.chips { display:flex; flex-wrap:wrap; gap:.3rem; }
.chip { font-size:.8rem; border:1px solid var(--line); border-radius:999px; padding:.1rem .55rem; cursor:pointer; user-select:none; background:var(--card); }
.chip.on { background:var(--tealbg); border-color:var(--teal); color:var(--teal); }
.chip.sugg-on { box-shadow:inset 0 0 0 1px var(--amber); }
details.more > summary { font-size:.8rem; color:var(--sub); cursor:pointer; margin:.2rem 0; }
textarea { width:100%; font:inherit; font-size:.85rem; border:1px solid var(--line); border-radius:6px; padding:.3rem .5rem; min-height:2.2rem; }
.hint { font-size:.8rem; color:var(--amber); margin:.2rem 0 0; }
@media (max-width: 640px) { .row { grid-template-columns:1fr; } .form { margin-left:0; } }
`;

// Plain browser JavaScript. Kept free of template-literal interpolation so this
// file's own backticks cannot collide with it.
const SCRIPT = String.raw`
const DATA = JSON.parse(document.getElementById('data').textContent);
const V = DATA.vocab;
const KEY = 'casework-labels:' + DATA.generatedAt;
let labels = {};
try { labels = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { labels = {}; }
let at = 0;
try { at = Math.min(Number(localStorage.getItem(KEY + ':at')) || 0, DATA.threads.length - 1); } catch {}

const cuts = DATA.threads.flatMap((t) => t.cuts.map((c) => ({ ...c, ticketId: t.ticketId })));
const cutById = Object.fromEntries(cuts.map((c) => [c.messageId, c]));

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(labels)); localStorage.setItem(KEY + ':at', String(at)); } catch {}
  progress();
}
function isDone(id) {
  const l = labels[id];
  const c = cutById[id];
  return !!(l && c && V.requiredByDirection[c.direction].every((f) => l[f]));
}
function subset(keys) { return Object.fromEntries(keys.map((k) => [k, V.internalChecks[k]])); }
const commonChecks = subset(V.commonInternalChecks);
const otherChecks = subset(Object.keys(V.internalChecks).filter((k) => !V.commonInternalChecks.includes(k)));
function progress() {
  const done = cuts.filter((c) => isDone(c.messageId)).length;
  document.getElementById('progress').textContent = done + ' / ' + cuts.length + ' messages étiquetés · fil ' + (at + 1) + ' / ' + DATA.threads.length;
  const jump = document.getElementById('jump');
  [...jump.options].forEach((o, i) => {
    const t = DATA.threads[i];
    const n = t.cuts.filter((c) => isDone(c.messageId)).length;
    o.textContent = (n === t.cuts.length ? '✓ ' : n ? '… ' : '· ') + (i + 1) + '. ' + (t.subject || '(sans objet)').slice(0, 50);
  });
}

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}

function labelFor(cut) {
  if (!labels[cut.messageId]) {
    const p = cut.prefill || {};
    labels[cut.messageId] = {
      effect: p.effect || null, answered: p.answered || [], waitingCustomer: p.waitingCustomer || [],
      waitingInternal: [], caseState: null, nextAction: null, note: '', fromPrefill: !!cut.prefill
    };
  }
  return labels[cut.messageId];
}

function single(cut, field, options) {
  const label = labelFor(cut);
  const sugg = cut.prefill && cut.prefill[field];
  return el('div', { class: 'chips' }, Object.entries(options).map(([value, text]) =>
    el('span', {
      class: 'chip' + (label[field] === value ? ' on' : '') + (sugg === value ? ' sugg-on' : ''),
      title: value,
      onclick: () => { label[field] = label[field] === value ? null : value; save(); render(); }
    }, text)));
}

function multi(cut, field, options) {
  const label = labelFor(cut);
  const sugg = (cut.prefill && cut.prefill[field]) || [];
  return el('div', { class: 'chips' }, Object.entries(options).map(([value, text]) =>
    el('span', {
      class: 'chip' + (label[field].includes(value) ? ' on' : '') + (sugg.includes(value) ? ' sugg-on' : ''),
      title: value,
      onclick: () => {
        label[field] = label[field].includes(value) ? label[field].filter((v) => v !== value) : [...label[field], value];
        save(); render();
      }
    }, text)));
}

function form(cut) {
  const label = labelFor(cut);
  const effects = cut.direction === 'outbound' ? V.outboundEffects : V.inboundEffects;
  const has = new Set(V.fieldsByDirection[cut.direction]);
  const rareOpen = (field) => label[field].some((k) => k in otherChecks);
  const checks = (field) => el('div', {}, multi(cut, field, commonChecks),
    el('details', { class: 'more', ...(rareOpen(field) ? { open: '' } : {}) }, el('summary', {}, 'autres vérifications'),
      multi(cut, field, otherChecks)));
  return el('div', { class: 'form' + (isDone(cut.messageId) ? ' done' : '') },
    el('div', { class: 'row' }, el('span', {}, 'Ce message'), single(cut, 'effect', effects)),
    has.has('answered') ? el('div', { class: 'row' }, el('span', {}, 'A répondu à (client)'), multi(cut, 'answered', V.customerQuestions)) : null,
    has.has('answered') ? el('div', { class: 'row' }, el('span', {}, 'A répondu à (vérification)'), checks('answered')) : null,
    el('div', { class: 'row' }, el('span', {}, 'On attend du client'), multi(cut, 'waitingCustomer', V.customerQuestions)),
    el('div', { class: 'row' }, el('span', {}, 'On attend de nous / d’un prestataire'), checks('waitingInternal')),
    el('div', { class: 'row' }, el('span', {}, 'Le dossier est'), single(cut, 'caseState', V.caseStates)),
    has.has('nextAction') ? el('div', { class: 'row' }, el('span', {}, 'Ensuite, le pipeline'), single(cut, 'nextAction', V.nextActions)) : null,
    el('div', { class: 'row' }, el('span', {}, 'Note'),
      el('textarea', { placeholder: 'Pourquoi, si ce n’est pas évident', oninput: (e) => { label.note = e.target.value; save(); } }, label.note)),
    cut.prefill && cut.prefill.failed ? el('p', { class: 'hint' }, 'La suggestion a échoué pour ce message : rien n’est pré-rempli.') : null
  );
}

function render() {
  const t = DATA.threads[at];
  const main = document.getElementById('thread');
  const y = window.scrollY;
  main.replaceChildren(
    el('h2', {}, t.subject || '(sans objet)'),
    el('div', { class: 'meta' }, t.ticketId.slice(0, 8) + ' · ' + t.group + ' · ' + t.messages.length + ' messages · ' + t.category),
    // Spread, because replaceChildren stringifies an array rather than walking it.
    ...t.messages.flatMap((m, i) => {
      const cut = t.cuts.find((c) => c.messageId === m.id);
      return [
        el('div', { class: 'msg' + (m.direction === 'outbound' ? ' out' : '') },
          el('div', { class: 'who' }, el('b', {}, m.roleName), m.at ? m.at.slice(0, 16).replace('T', ' ') : '', i === 0 ? '· message d’ouverture' : ''),
          el('div', { class: 'body' }, m.own || '(vide)'),
          m.quoted ? el('details', { class: 'quoted' }, el('summary', {}, 'historique cité'), el('pre', {}, m.quoted)) : null),
        cut ? form(cut) : null
      ];
    }).filter(Boolean)
  );
  window.scrollTo(0, y);
  progress();
}

function go(i) { at = Math.max(0, Math.min(DATA.threads.length - 1, i)); save(); render(); window.scrollTo(0, 0); }

const jump = document.getElementById('jump');
DATA.threads.forEach((t, i) => jump.append(el('option', { value: String(i) })));
jump.addEventListener('change', () => go(Number(jump.value)));
document.getElementById('prev').addEventListener('click', () => go(at - 1));
document.getElementById('next').addEventListener('click', () => go(at + 1));

document.getElementById('export').addEventListener('click', () => {
  const out = {};
  for (const c of cuts) if (labels[c.messageId]) out[c.messageId] = { ticketId: c.ticketId, direction: c.direction, ...labels[c.messageId] };
  const blob = new Blob([JSON.stringify({ version: 1, generatedAt: DATA.generatedAt, exportedAt: new Date().toISOString(), labels: out }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'casework-labels.json' });
  document.body.append(a); a.click(); a.remove();
});

document.getElementById('import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    let n = 0;
    for (const [id, l] of Object.entries(parsed.labels || {})) if (cutById[id]) { labels[id] = l; n += 1; }
    save(); render();
    document.getElementById('progress').textContent += ' · ' + n + ' importé(s)';
  } catch (err) { console.log('import failed', err); }
  e.target.value = '';
});

jump.value = String(at);
render();
`;
