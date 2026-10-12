<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Embeddings

### Every stored message is embedded; only approved knowledge chunks are

The corpora differ because their gates differ: a chunk holds a vector **iff** its parent document is currently `approved` and not brand-voice, and the vector matches the current input hash + model + dimensions — whereas a message is part of the corpus by virtue of existing.

Both share one determinism quadruple (`embedding_model`, `embedding_dimensions`, `embedded_input_hash`, `embedded_at`), so a re-run over unchanged text is a no-op for either. Verified on real data: 348 messages embedded, second run embedded 0.

Message hashes are additionally salted with the quoted-reply stripper version, so changing how history is stripped correctly invalidates every message vector without the version ever reaching the model. `embedded_input_hash` covers title + category too, so a rename invalidates the vector even though `content_hash` ignores it.

Unapproving regenerates chunks vectorless. Embedding runs both inline (on approval, best-effort) and via the reconciler.

### A subject we wrote ourselves is not a subject (2026-09-01)

The subject is prefixed to every message embedding because support subject lines carry real signal — « Colis bloqué », « remboursement commande #5229 ». On 39% of inbound mail it carries the opposite.

**Two shapes, and the second is the dangerous one.** « Nouveau message de client le 7 août 2026 à 09:51 » is the contact form notifying us: no content, and a date that hundreds of unrelated tickets then share. « Votre commande est confirmée » is the order mail the customer hit reply on — so a complaint that nothing arrived is embedded under a heading saying it was confirmed. Measured: O-09 (« pas encore expédiée ») outranked D-01 (« toujours pas reçue ») on exactly such a ticket.

**The argument already existed one file away.** `buildEmbeddingInput` excludes the category from knowledge chunks because "a constant contributes nothing to ranking while diluting the actual content". Nobody had applied it to the query side, where 39% of queries carried one.

**Matched on the subject only, never the body.** A customer writing « votre commande est confirmée ? » in a sentence is asking us something. Reply and forward markers are stripped first, because « RE: RE: Nouveau message de client » is the same worthless heading three replies later.

**Measured twice.** On 60 near-band tickets: 9 crossed into `matched`, 0 fell out, margin +13%, relevance proxy unchanged at 33/60. Across the whole corpus after re-embedding: matched 120 → 123, and the ≥0.80 band 24 → 38 — the gain is mostly in CONFIDENCE rather than in count, which is what removing a diluting constant should do.

**What it does not fix.** « Je n'ai toujours pas reçu ma commande » rose 0.606 → 0.628 and still misses: four lines of substance under a name and an Outlook footer. Mail-client footers survive in only 4% of embedded text, so there is no second lever of this size — the remaining near misses are short bodies, not noisy ones.

### One reconciler, three descriptors

The three embedded tables each had their own ~160-line script around the same five steps: find the rows that may hold a vector, read them, hash-gate, write what changed, clear vectors off rows that must not keep one. The pure part — the staleness gate in `embed-chunks.mjs` — was extracted and tested; the loop around it was copied three times and tested nowhere, which is where the interesting failures live, because the gate cannot be wrong about a row nobody read.

`lib/embeddings/reconcile.mjs` is that loop, once. A descriptor answers one question per table — **which rows should hold a vector** — as a parent (optional: `ticket_messages` has none, since every stored message is part of the corpus), a child, and the same question backwards for the orphan sweep. `--limit` caps parents where there are parents and rows where there are not. The three `embed:*` commands and their three reports are unchanged; what they no longer each own is the loop.

Collapsing them closed a live hole: the knowledge and exemplar orphan sweeps used a plain `supabaseSelect`, which PostgREST caps at `db-max-rows` (1000) with a 206 and no error — so past a thousand embedded rows they simply stopped seeing orphans. The message reconciler had already been fixed for this; now all three page.

### The category is never embedded

Retrieval always filters by category first, so embedding the category name into a chunk adds a near-constant to every candidate in the filtered set — no discriminative value, and it dilutes the content. `title` carries the topical anchoring instead.
