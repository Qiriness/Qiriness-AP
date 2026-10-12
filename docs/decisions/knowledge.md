<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Knowledge

### Company policies are written once, linked by reference, and never decide a case (2026-09-30)

Policy text (delivery times, where we deliver, returns, refunds) lived in two wrong places:
- **knowledge articles** found by similarity search: « Livraisons et retours » and « Refund policy »;
- **rule skeletons** that re-typed it. D-07 `D07_reponse_generique` spells out the delivery delays, and D-33 has two branches on `policy_answer` (`answered` vs `none/weak/unknown`) that exist only because the search can miss.

The owner asked for a central library before the Rules tab. It replaces the policy articles, and **the owner writes the policies**: the library starts empty and nothing was copied from the articles.

- **Deterministic, not retrieved.** A policy is read by its key, whole, not found by similarity. The question « is this the company's rule? » is not left to a score.
- **One tool, `getPolicy(policy_key)`, not one function per policy.** Its argument is an enum of the shop's active keys, and its description lists each with its `purpose`. The model sees every policy it may read and cannot name another. This scales to 20 or 30 policies without 30 function definitions.
- **Three ways in, all recorded** on `ticket_investigations.company_policies` (`{key, version, source}`):
  - **situation**: linked to the matched situation, read as an opening move with no model turn, because every reply there needs it;
  - **rule**: linked to the selected rule, attached after selection, since the rule is only known after the tool loop;
  - **agent**: any other active policy the model fetched for a second question, e.g. a delivery problem plus « how long does it normally take? ».
- **A policy never decides.** `getPolicy` raises no caveat, satisfies no need and moves no verdict. The policy answers « what is the company's rule? »; the rules still answer « what happens in this case? ». `policy_answer` and `searchKnowledge` stay as they were for rules not yet moved.
- **References, never copies.** A link names the policy. Drafting reads each policy's **current** text by key, so an edit reaches the next draft of every linked situation and rule. Each version's text is kept (`company_policy_versions`), and the draft's `prompt_inputs` records the versions it used.
- **Numbers stay in Parameters.** A policy may quote `{dispatch_days}`. One whose parameter is unset is withheld (from the tool and from the draft) rather than shown with a brace, as a skeleton is.
- **One instruction for all of them** in the drafting prompt: use only what answers the question, do not invent, extend or contradict, and if the policy is not enough, follow the situation and rule.
- **Naming.** The rulebook was already « policy » in the code (`policy-service.ts`, `PolicyRule`, `exemplar_match.policy`). The new thing is **company policies** in code and tables, and **Policies** on screen.

**Still to do, once the policies are written:** move D-07 and D-33 onto them (link the policy to the situation, remove the re-typed text and the `policy_answer` branches, keep the fallback wording), and unapprove the articles they replace.

### The search path to policies and the « Core setup » checklist are retired (2026-10-01)

With 15 policies written and 36 links made, the owner asked to remove what stood in for them:

- **`policy_answer` is no longer a need.** It scored « what an approved policy says » from a knowledge search. A policy is now read by key, and it never sets a finding. The need is gone from `evidence-rules.mjs`, from the 20 situations that declared it (migration 56) and from the need labels.
- **A policy question branches on `policy_attached`, not on what the policy says.** Asked for by the owner: one branch for « the policy is attached », one fallback for the day it is switched off or deleted. The finding is `attached` only when a policy linked to the matched situation was read as an opening move (a policy the agent fetched for a side question does not count), otherwise `not_attached`. It describes availability, never content, so « a policy never decides » still holds. The collector never proposes `getPolicy` (it has no key to give it).
- **The four rules that named `policy_answer` were moved** (2026-10-01, before → after printed and kept in the session):
  - **D-33:** `d33_livraison_documentee` is now approved, on `attached`, answering the named country from the policy with « say we will confirm » when the country is not named. `d33_livraison_non_documentee` stays approved, on `not_attached`, routing to a person.
  - **D-07:** `d07_delais` is on `attached`, giving the delays as the policy states them. `D07_reponse_generique` (the owner's, already in parameters) is now approved, on `not_attached`, as the fallback.
  - **Live change:** D-33 questions are now answered from the policy instead of always going to a person.
- **`searchKnowledge` stays** for product properties and brand questions (`product_property`, `brand_answer`), which are not policies.
- **The « Core setup » checklist is gone** from Knowledge: five empty slots (order policies, delivery & returns, confidentiality, locations, FAQs). No article held one. `core_topic` keeps only `brand`, the Brand voice every draft is written with.

### Cosmetovigilance answers from its policy, and says nothing the policy does not (2026-10-01)

The owner asked for every cosmetovigilance rule to work the way D-33 does. The trigger: a rehearsed « rougeurs et irritations » reply told the customer how to start using the product again (« reprise prudente… petite quantité… »). That came from the rule skeletons written 2026-08-30 (§ *The cosmetovigilance rules answer…*). `product_reaction_complaint_policy` says none of it. The policy asks for the product and batch number, the reaction (a photo if the customer is willing) and the place of purchase. It says what happens next for an online purchase and for a distributor's, and it recommends a specialist if symptoms persist or worsen.

- **Each of CV-01, CV-02 and CV-04 has three rules.** With the policy `attached`, one rule where the product is named and one where it is not (`reaction_product` as before). These answer from the policy only, and the skeleton forbids any advice it does not contain: stopping the product, resuming it, any care. With `not_attached`, one fallback that acknowledges the report, hands it to a person (`needs_human`) and asks nothing. The attached rules keep their old keys, so earlier case files still name them.
- **The attached rules ask what the policy asks**: `lot_number` and `purchase_channel`, plus `reaction_product_name` when no product was named. CV-01 used to ask nothing when the product was known; the policy asks for the batch number on every report, so it does too. CV-02 and CV-04 keep « the team is handling it, nothing promised ».
- **CV-03 (« can I use this given my health? ») gets the same two branches**, both `needs_human`. The policy is about reactions that have happened, so only its « see a specialist » is reused.
- **Product unknown and the catch-all are unchanged.** `reaction_product = unknown` still falls to `reaction_signalee`, as does a ticket matched to no situation: no situation means no policy read as an opening move.
- **Forwarding is untouched by all of this.** It goes by the ticket's category, never its situation, so every cosmetovigilance ticket, in any branch, goes to the Cosmétovigilance destination once our first reply is out. A reaction filed under another category is not forwarded.

Rehearsed on the same message afterwards: CV-01, policy attached, `reaction_conduite_a_tenir`. The reply asks for the product, batch number and place of purchase, invites a photo, explains both purchase routes and recommends a specialist. Every check passed; the old reply had failed `no_unsuitability_claim` on « déconseillée ».

**Found on the way:** an article that a « Test the agent » run had tested could not be deleted. The FK sets the run's `expect_document_id` to null, but `agent_test_runs_article_verdict_needs_document_check` refuses a verdict with no article. `deleteArticle` now clears that run's verdict first; the run itself is kept.

### Knowledge articles are FAQs, one question per heading (2026-10-01)

With the company's rules in Policies, the owner asked for the knowledge base to hold FAQ articles only, with Brand story kept as it is.

- **Labels, not new values.** The stored category is still the shared subject, so a ticket's subject still filters straight into its articles. On screen an article category reads « Order FAQ », « Product FAQ »…, `faq` reads « General FAQ » and `brand_story` « Brand story » (`articleCategory.*`). `category.*` stays the ticket label.
- **`other` is no longer an article category.** It is the categoriser's catch-all, so it stays a ticket subject (`TICKET_ONLY_SUBJECTS`). An article with no named subject is a General FAQ, which every ticket already searches. The new-article default, the mapper fallback and the import inference fallback are `faq`. Migration 58 narrowed the check; no article was filed under `other`.
- **The format** (the « How to write an FAQ » panel in the article editor): one question per Heading 2, as a customer asks it; 2–3 real rewordings underneath as plain lines; then a short answer. It works because of how articles are embedded: every heading starts a section, and each chunk is embedded as `title + heading + body`. So the question and its rewordings travel with the answer, as a situation's example messages do. Rewordings as sub-headings would each become a chunk with no answer, which is why the panel says plain lines.
- **An FAQ section stays one chunk.** Every section of a non-brand-story article is a whole unit up to 1,200 tokens (`knowledge-chunker.mjs`). The 450-token packing would split a long answer and leave the second half with the heading but none of the rewordings. Past the ceiling, a section is not FAQ-shaped (a long imported page) and is packed as before. On 2026-10-01 every section over 450 tokens was in a brand story, so no existing chunk changed.
- **Order, delivery and promotions search each other** (asked by the owner). The categoriser splits them on wording the customer does not choose: « ma commande n'est pas arrivée » can be filed as order or delivery. So a ticket in any of the three searches all three, its own first, then `faq` and `brand_story`. Other subjects search only their own (`SEARCH_GROUPS` in `retrieval-rules.mjs`).
- **An FAQ does not restate a policy.** The panel says so: delivery times, returns and refunds live in Policies and are read by key (§ Company policies are written once…).

**Known gap, not acted on:** a Product FAQ is only searched for product tickets. « Le masque LED n'était pas dans mon colis » (in « Masque LED Visage — Questions fréquentes », still filed `faq`) is a delivery question. Filed as Product FAQ, it would be hidden from the delivery tickets that ask it. Move such a question to an Order FAQ rather than widening the group.

### « Format as FAQ » arranges an article, it does not write one (2026-10-04)

The Optimize button was a client-side stub that only removed empty paragraphs. The owner asked for it to put an article into the FAQ format above, as a formatter rather than a text generator, and cheaply.

- **The model answers with block numbers, not text.** The article is split into numbered blocks (a heading, a line, a whole list or table); the model says which block is each question, which are its rewordings and which answer it; `scripts/lib/faq-format.mjs` rebuilds the HTML from the original blocks. An answer therefore comes out word for word, links and lists included. Every index is checked: one out of range or already used is ignored, so a bad plan can misplace a block but never duplicate or drop one.
- **The one thing it may write is a missing question.** A topic under a label (« Livraison ») or under no heading gets a question written from its answer, because a section without a question heading is not an FAQ entry. A heading the plan did not use is dropped: a label with no text of its own was already skipped by `htmlToSections`, so no chunk changes.
- **It never writes rewordings.** The guide says to take them from real emails; invented ones would look real and steer retrieval. The toast counts the questions that have none.
- **Nothing is lost.** A content block the plan did not place is kept ahead of the first question and counted in the toast.
- **Formats the editor, saves nothing.** The result lands unsaved, demotes an approved article like any edit, and waits for Save. Hidden on the brand voice (the drafting prompt) and on Brand story (not an FAQ).
- **Model: `gpt-6-luna`**, the cheapest on the rate card ($0.10 in / $0.50 out per 1M), overridable with `KNOWLEDGE_FORMAT_MODEL`. Placing blocks is classification, not writing. Measured 2026-10-04 on the two largest real articles: « Masque LED Visage — Questions fréquentes » (46 blocks) cost 2,105 + 842 tokens, about $0.0006; « FAQ » (35 blocks, imported with H3s) 1,509 + 702. Both came out as 12 H2 questions with every answer unchanged. Recorded in `llm_usage` as pass `other`: a pass of its own would need the check constraint widened, for a click.

Nothing auto-writes `knowledge_documents`; the catalog sync only fills `shopify_content_sources`. `source_type` → `manual` **is** the manual-edit lock — no separate flag, and resync is then unavailable.

The one fixed slot is the Brand voice (`core_topic = 'brand'`): shown as a placeholder until created, never a database row before then. The « Core setup » checklist was removed 2026-10-01 (§ The search path to policies…).
