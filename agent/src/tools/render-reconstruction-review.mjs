import { readFileSync, writeFileSync } from 'node:fs';

import { createSupabaseClient } from '../../../scripts/lib/supabase-rest-client.mjs';
import { COLUMNS } from '../../../scripts/lib/tables.mjs';
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

  const cards = [];
  for (const [index, row] of rows.entries()) {
    const conversation = row.ticketId
      ? await record.conversation(row.ticketId, { columns: COLUMNS.threadForDrafting })
      : [];
    cards.push(card(row, index + 1, conversation, senderDirectory));
  }

  const done = rows.filter((row) => !row.error);
  writeFileSync(outPath, page(rows, done, cards.join('\n')), 'utf8');
  console.log(`${rows.length} fil(s) → ${outPath}`);
}

function card(row, n, conversation, senderDirectory) {
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
  </section>`;
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
${cards}
</div></body></html>`;
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
