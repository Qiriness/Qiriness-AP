import { readFileSync, writeFileSync } from 'node:fs';

import { createSupabaseClient, supabaseSelect } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS, T } from '../../../scripts/lib/tables.mjs';
import { createTicketRecord } from '../../../scripts/lib/ticket-record.mjs';

import { loadAgentConfig } from '../config.mjs';
import { resolveShopId } from '../lib/shop.mjs';
import { renderThread } from '../casework/reconstruct.mjs';
import { createSenderDirectoryStore } from '../ingestion/sender-directory.mjs';

// Turns `cases:reconstruct --json` into something a person can actually correct.
//
//   npm run cases:review -- --in out.json --out cases-review.html
//
// WHY A FILE AND NOT A DASHBOARD PAGE. What this shows is a draft reading of a
// finished thread, with the thread beside it, and the job is to disagree with it
// once. A page in the app would have to be built, routed, permissioned and then
// kept — for a review that happens on a corpus, not on a queue.
//
// `*-review.html` IS A GITIGNORED NAME, and that is the point rather than an
// accident: these quote real customer messages in full, which is what makes them
// useful and what makes committing one a personal-data incident.
//
// NO MODEL CALL AND NO WRITE. It reads the JSON the reconstruction produced and
// the threads it read, and renders them.

const args = process.argv.slice(2);
const inPath = value(args, '--in') || 'reconstruction.json';
const outPath = value(args, '--out') || 'cases-review.html';

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const rows = JSON.parse(readFileSync(inPath, 'utf8'));
  const config = loadAgentConfig();
  const supabase = createSupabaseClient(config);
  const shopId = await resolveShopId(supabase, config.shopDomain);
  const record = createTicketRecord(supabase, { shopId });
  const senderDirectory = await createSenderDirectoryStore(supabase).load(shopId, {
    supportMailbox: config.graph.mailbox
  });

  // THE LIBRARY THE DROPDOWN OFFERS — the same approved keys the reconstruction
  // was allowed to choose from, so a correction can only name a situation the
  // rules layer can act on.
  const situations = await supabaseSelect(
    supabase,
    T.SUPPORT_EXEMPLARS,
    { shop_id: shopId, approval_status: 'approved', deleted_at: { operator: 'is', value: 'null' } },
    'exemplar_key,canonical_question',
    { order: 'exemplar_key.asc' }
  );

  const cards = [];
  for (const [index, row] of rows.entries()) {
    const conversation = row.ticketId
      ? await record.conversation(row.ticketId, { columns: COLUMNS.threadForDrafting })
      : [];
    cards.push(card(row, index + 1, conversation, senderDirectory, situations));
  }

  const done = rows.filter((row) => !row.error);
  writeFileSync(outPath, page(rows, done, cards.join('\n')), 'utf8');
  console.log(`${rows.length} fil(s) → ${outPath}`);
}

function card(row, n, conversation, senderDirectory, situations = []) {
  if (row.error) {
    return `<section class="card"><header><span class="key">${n}. ${esc(row.ticketId?.slice(0, 8))}</span>
      <span class="flip down">ÉCHEC — ${esc(row.error)}</span></header></section>`;
  }

  const asks = row.askedByQiriness
    .map((a) => `<li>${esc(a.what)} — <b class="${a.answered ? 'ok' : 'warn'}">${a.answered ? 'répondu' : 'sans réponse'}</b></li>`)
    .join('');
  const commits = row.commitments
    .map((c) => `<li>${esc(c.what)} <span class="tag">${esc(c.status)}</span></li>`)
    .join('');

  return `<section class="card">
    <header>
      <span class="key">${n}. ${esc(row.ticketId?.slice(0, 8))}</span>
      <span class="meta">${row.inbound} reçus / ${row.outbound} envoyés · ${esc(row.status)}</span>
      <span class="sit ${row.situationKey ? 'has' : 'none'}">${esc(row.situationKey || 'aucune situation')}</span>
      ${row.openIssue ? '<span class="flip down">en suspens</span>' : '<span class="flip up">rien en suspens</span>'}
      ${row.rejectedSituationKey ? `<span class="flip down">clé inventée : ${esc(row.rejectedSituationKey)}</span>` : ''}
    </header>
    ${row.contradictions.map((c) => `<p class="contra">⚠ ${esc(c)}</p>`).join('')}
    <p class="summary">${esc(row.caseSummary)}</p>
    <div class="cols">
      <div>
        <h3>Objectif du client</h3><p>${esc(row.customerObjective) || '—'}</p>
        <h3>Établi</h3>${bullets(row.establishedFacts)}
        <h3>Ce que nous avons demandé</h3>${asks ? `<ul>${asks}</ul>` : '<p class="dim">—</p>'}
      </div>
      <div>
        <h3>Ce que nous avons promis</h3>${commits ? `<ul>${commits}</ul>` : '<p class="dim">—</p>'}
        <h3>Attendu du client</h3>${bullets(row.pendingCustomerInputs)}
        <h3>À faire de notre côté</h3>${bullets(row.pendingInternalActions)}
        <h3>Point en suspens</h3><p>${esc(row.openIssue) || '<span class="dim">—</span>'}</p>
        <h3>Remboursement</h3>
        <p>le fil dit <b>${esc(row.claims.refund)}</b> · la commande montre <b>${esc(row.backend.refund)}</b><br>
           <span class="dim">remplacement : ${esc(row.backend.replacement)}</span></p>
      </div>
    </div>
    <details><summary>Le fil (${conversation.length} messages)</summary>
      <pre class="thread">${esc(renderThread(conversation, senderDirectory))}</pre></details>
    ${correctionForm(row, situations)}
  </section>`;
}

/**
 * The two answers a person gives per thread, pre-filled with the model's.
 *
 * TWO, AND NOT MORE, ON PURPOSE. Situation and "still open" are what a
 * regression suite can actually score; everything else on the card is context
 * for judging those two. A form asking a reviewer to re-type every fact would be
 * a form nobody finishes, and 36 half-finished cards are worth less than 36
 * finished ones.
 *
 * PRE-FILLED, so a correct reading costs one click — « vérifié » — and only a
 * wrong one costs more.
 */
function correctionForm(row, situations) {
  const options = [
    `<option value=""${row.situationKey ? '' : ' selected'}>aucune situation</option>`,
    ...situations.map(
      (s) =>
        `<option value="${esc(s.exemplar_key)}"${s.exemplar_key === row.situationKey ? ' selected' : ''}>` +
        `${esc(s.exemplar_key)} — ${esc(s.canonical_question).slice(0, 70)}</option>`
    )
  ].join('');
  const open = Boolean(row.openIssue);
  return `<form class="fix" data-ticket="${esc(row.ticketId)}"
      data-model-situation="${esc(row.situationKey || '')}" data-model-open="${open}">
    <label>Situation <select name="situation">${options}</select></label>
    <label>Encore quelque chose en suspens ?
      <select name="open"><option value="true"${open ? ' selected' : ''}>oui</option>
      <option value="false"${open ? '' : ' selected'}>non</option></select></label>
    <label class="wide">Remarque <input name="note" type="text" placeholder="facultatif — ce qui est faux"></label>
    <label class="check"><input name="verified" type="checkbox"> vérifié</label>
  </form>`;
}

function page(rows, done, cards) {
  const tally = {};
  for (const row of done) tally[row.situationKey || '(aucune)'] = (tally[row.situationKey || '(aucune)'] || 0) + 1;
  const situations = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li>${esc(k)} <span>${n}</span></li>`)
    .join('');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reconstruction des dossiers — à corriger</title>
<style>
  :root { --ink:#16211c; --sub:#5d6b64; --line:#dfe5e1; --bg:#f7f9f8; --teal:#0f766e; --red:#9b2c2c; --amber:#a3541a; }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1.25rem 5rem; font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  .wrap { max-width:74rem; margin:0 auto; }
  h1 { font-size:1.6rem; margin:0 0 .35rem; letter-spacing:-.01em; }
  .lede { color:var(--sub); margin:0 0 1.25rem; max-width:54rem; }
  .tally { display:flex; flex-wrap:wrap; gap:.4rem; list-style:none; padding:0; margin:0 0 2rem; }
  .tally li { background:#fff; border:1px solid var(--line); border-radius:999px; padding:.2rem .7rem; font-size:.85rem; }
  .tally span { color:var(--sub); }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin:0 0 1rem; }
  .card header { display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap; margin-bottom:.6rem; }
  .key { font-weight:700; color:var(--teal); }
  .meta { color:var(--sub); font-size:.85rem; }
  .sit { font-size:.8rem; border-radius:999px; padding:.1rem .6rem; background:#eef4f1; }
  .sit.none { background:#fbf1e6; color:var(--amber); }
  .flip { font-size:.78rem; border-radius:999px; padding:.1rem .6rem; }
  .flip.down { background:#fdeaea; color:var(--red); }
  .flip.up { background:#e8f5ee; color:var(--teal); }
  .contra { background:#fdeaea; color:var(--red); border-radius:8px; padding:.5rem .7rem; margin:.3rem 0 .6rem; font-size:.9rem; }
  .summary { margin:0 0 .9rem; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:1.4rem; }
  @media (max-width:820px) { .cols { grid-template-columns:1fr; } }
  h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--sub); margin:.9rem 0 .25rem; }
  h3:first-child { margin-top:0; }
  ul { margin:.2rem 0; padding-left:1.1rem; font-size:.92rem; }
  .tag { font-size:.75rem; background:#eef4f1; border-radius:999px; padding:0 .45rem; color:var(--sub); }
  .ok { color:var(--teal); } .warn { color:var(--red); }
  .dim { color:var(--sub); }
  details { margin-top:.9rem; } summary { cursor:pointer; color:var(--sub); font-size:.9rem; }
  .bar { position:sticky; top:0; z-index:2; display:flex; gap:1rem; align-items:center; flex-wrap:wrap;
         background:var(--bg); padding:.7rem 0; margin:0 0 1rem; border-bottom:1px solid var(--line); }
  .bar .count { font-weight:700; color:var(--teal); }
  .bar button { font:inherit; font-weight:600; background:var(--teal); color:#fff; border:0; border-radius:8px;
               padding:.5rem 1rem; cursor:pointer; }
  .bar .hint { color:var(--sub); font-size:.85rem; }
  form.fix { display:flex; flex-wrap:wrap; gap:.6rem 1.2rem; align-items:center; margin-top:1rem;
             padding-top:.9rem; border-top:1px dashed var(--line); font-size:.9rem; }
  form.fix select, form.fix input[type=text] { font:inherit; padding:.3rem .4rem; border:1px solid var(--line);
             border-radius:6px; background:#fff; max-width:100%; }
  form.fix select[name=situation] { max-width:32rem; }
  form.fix .wide { flex:1 1 16rem; display:flex; gap:.4rem; align-items:center; }
  form.fix .wide input { flex:1; }
  form.fix .check { font-weight:600; }
  form.fix.changed { background:#fff8ec; margin-left:-1.2rem; margin-right:-1.2rem; padding-left:1.2rem;
             padding-right:1.2rem; }
  .card.done { border-color:#9fd3c4; box-shadow:inset 4px 0 0 var(--teal); }
  pre.thread { white-space:pre-wrap; font:13.5px/1.55 inherit; background:#fbfcfb; border:1px solid var(--line); border-radius:8px; padding:.8rem; margin:.5rem 0 0; }
</style></head><body><div class="wrap">
<h1>Reconstruction des dossiers — à corriger</h1>
<p class="lede">Une lecture par fil, produite en un appel sur la conversation entière. <b>Rien n'a été écrit
en base.</b> Ce que dit le fil et ce que montre la commande sont rapportés séparément et ne sont jamais
fusionnés. À faire : corriger ce qui est faux — c'est la version corrigée, pas celle-ci, qui sert de
référence à une suite de tests.</p>
<ul class="tally">
  <li>${rows.length} fils <span>${rows.length - done.length} échec(s)</span></li>
  <li>${done.filter((r) => r.openIssue).length} <span>avec un point en suspens</span></li>
  <li>${done.filter((r) => r.contradictions.length).length} <span>contradictions fil / commande</span></li>
  <li>${done.filter((r) => r.rejectedSituationKey).length} <span>clés inventées</span></li>
</ul>
<ul class="tally">${situations}</ul>
<div class="bar">
  <span><span class="count" id="progress">0</span> / ${rows.length} vérifiés</span>
  <button type="button" id="export">Exporter les corrections</button>
  <span class="hint">Enregistré automatiquement dans ce navigateur. L’export ne contient que des
  identifiants et vos réponses — aucun message.</span>
</div>
${cards}
</div>
<script>
// Everything stays on this machine: the page is a local file quoting real mail,
// and it makes no network call. Answers are kept in localStorage so closing the
// tab loses nothing, and the export carries ids and answers only.
(() => {
  const KEY = 'cases-review:' + document.title;
  const forms = [...document.querySelectorAll('form.fix')];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }

  const read = (f) => ({
    ticketId: f.dataset.ticket,
    situationKey: f.situation.value || null,
    stillOpen: f.open.value === 'true',
    note: f.note.value.trim(),
    verified: f.verified.checked,
    // What the model said, beside the answer, so the export also records
    // WHERE the reconstruction was wrong — the number worth tracking.
    modelSituationKey: f.dataset.modelSituation || null,
    modelStillOpen: f.dataset.modelOpen === 'true'
  });

  const paint = (f) => {
    const a = read(f);
    f.classList.toggle('changed', a.situationKey !== a.modelSituationKey || a.stillOpen !== a.modelStillOpen);
    f.closest('.card').classList.toggle('done', a.verified);
  };
  const progress = () => {
    document.getElementById('progress').textContent = forms.filter((f) => f.verified.checked).length;
  };

  for (const f of forms) {
    const s = saved[f.dataset.ticket];
    if (s) {
      f.situation.value = s.situationKey || '';
      f.open.value = String(s.stillOpen);
      f.note.value = s.note || '';
      f.verified.checked = Boolean(s.verified);
    }
    const update = () => {
      saved[f.dataset.ticket] = read(f);
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
      paint(f); progress();
    };
    // Both: 'input' is what a text field fires as you type, 'change' is what
    // a checkbox and a select fire in every browser.
    f.addEventListener('input', update);
    f.addEventListener('change', update);
    paint(f);
  }
  progress();

  document.getElementById('export').addEventListener('click', () => {
    const labels = forms.map(read);
    const blob = new Blob([JSON.stringify(labels, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'case-labels.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
</script>
</body></html>`;
}

function bullets(items) {
  return items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="dim">—</p>';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 || index === argv.length - 1 ? undefined : argv[index + 1];
}
