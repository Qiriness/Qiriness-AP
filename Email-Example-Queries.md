# Email example queries — the Q&A set to write

Derived from **248 customer messages** ingested from `contact@qiriness.com`
(2026-05-21 → 2026-08-08, 214 tickets), clustered by `npm run cluster:tickets`.
Message counts are the measured demand behind each question, not an estimate.

Internal, contractor and logistics senders are excluded via `sender_directory`,
so these counts are customers only.

---

## How an entry is structured, and why

Three artefacts, deliberately kept apart. Only the first is indexed.

| Part | Lives in | Embedded? |
|---|---|---|
| **Question + real phrasings** | knowledge chunk | ✅ the match target |
| **Contenu stable** — true for every customer, no branching | same chunk | ✅ |
| **needs** — what answering requires | `evidence-rules.mjs` (already written) | ❌ |
| **Exemplaires** — one per outcome state | separate doc, own category | ❌ |

**Do not write the `needs` list into the knowledge base.** It already exists as a
closed vocabulary in `agent/src/investigation/evidence-rules.mjs`. The keys below
reference it; a second copy would drift. Likewise the *"if the order number is
missing, ask for it"* branch is already deterministic — an unsatisfied need
carries an `asksCustomer` key, `MISSING_FIELDS` in `case-file.mjs` owns the exact
sentence, and the verdict becomes `needs_customer_input`. Never write that branch
as prose.

**Exemplars attach to STATES, not to questions.** A draft per question per state
would be 32 × 5 ≈ 160 drafts. Per state it is ~15, and states are shared: *"pas
encore expédiée"* answers both D-01 and O-09.

**Keep exemplars out of `knowledge_chunks` under a searchable category.**
`categoriesToSearch()` returns `[subject, 'faq', 'brand_story']` — give exemplars
their own category and retrieval can never reach them. Otherwise a customer
asking *"où est ma commande"* retrieves a **draft reply** as though it were policy.

### Reading the markers

- 🟢 reachable today with the tools that exist
- 🔒 blocked — names the missing tool. Write the question and the stable content;
  leave the exemplar until the tool exists. (Same discipline as `checkout_state`
  in `evidence-rules.mjs`: listed, unwired, so the report argues for building it.)

---

## State vocabularies

Referenced by the entries below so each state is written once.

### `commande` — order & delivery lifecycle
| State | Reachable |
|---|---|
| `info_manquante` | 🟢 deterministic — `MISSING_FIELDS`, no exemplar needed |
| `non_expediee` | 🟢 Shopify fulfilment status |
| `expediee_dans_delai` | 🟢 fulfilment status + tracking number |
| `expediee_hors_delai` | 🔒 carrier API (GLS / La Poste — **not** Chronopost, per the corpus) |
| `livree_contestee` | 🔒 carrier API |
| `perdue_reclamation` | 🔒 carrier API + claims process |

### `promo` — promotions
| State | Reachable |
|---|---|
| `info_manquante` | 🟢 |
| `code_valide_eligible` | 🟢 `lookupPromotion` → eligible |
| `code_valide_non_eligible` | 🟢 `lookupPromotion` → blocked |
| `code_inexistant_ou_expire` | 🟢 |
| `panier_invisible` | 🔒 `checkout_state` — deliberately unwired |

### `retour` — returns & refunds
| State | Reachable |
|---|---|
| `info_manquante` | 🟢 |
| `retour_possible` | 🟢 order context + policy |
| `retour_hors_delai` | 🟢 |
| `remboursement_en_cours` | 🔒 refund state beyond Shopify's own record |

### `produit` — product questions
| State | Reachable |
|---|---|
| `reponse_dans_la_base` | 🟢 `policy_answer` / `product_property` satisfied |
| `produit_ambigu` | 🟢 `lookupProduct` → ambiguous, must ask |
| `aucune_source` | 🟢 → `needs_human`, claim nothing |

---

# Livraison — 8 questions · 70 messages

### D-01 · Où en est ma commande ? Je l'ai passée il y a plusieurs semaines et je ne l'ai toujours pas reçue.
`delivery` · `problem` · **19 msgs** — largest single cluster · 🟢 partial

**Variantes réelles**
- « j'ai passé deux commandes fin juin et je n'ai toujours pas reçu mes articles »
- « URGENT — Commande #6216 du 27 juin 2026. Je n'ai toujours pas reçu cette commande, payée et encaissée »
- « Ma commande 6669 n'a pas été livrée mais le montant bien débité de mon compte »
- « Je suis toujours en attente de ma commande numéro 6275 qui devait être livrée hier »

**needs** `order_identity`, `delivery_state`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

### D-02 · Il manque un article dans le colis que j'ai reçu.
`delivery` · `problem` · **12 msgs** · 🟢

**Variantes réelles**
- « J'ai effectué une commande #5953 et je viens de recevoir mon colis. Il manque un article »
- « J'ai reçu ce jour ma commande 6045 du 10/06/26. J'avais commandé 2x caressé source d'eau… »

**needs** `order_identity`, `order_state`, `policy_answer`
**exemplaires** → jeu `commande` (+ un état `article_manquant_confirme`)

**Contenu stable** _(à rédiger)_
>

---

### D-03 · Ma commande est indiquée comme livrée mais je n'ai rien reçu.
`delivery` · `problem` · **10 msgs** · cohesion 0.84 — very tight · 🔒 carrier API

**Variantes réelles**
- « Je viens de voir que mon colis a été livré dans ma boîte aux lettres mais il n'y a rien »
- « Le livreur GLS a livré mon colis ailleurs que chez moi malgré mes précisions »
- « Le livreur a déposé mon colis chez un voisin ou à une adresse qui n'est pas la mienne » _(authored — was D-04's canonical question)_

**needs** `order_identity`, `delivery_state`
**exemplaires** → jeu `commande`, état `livree_contestee`

> **D-04 merged in, 2026-08-12.** It was never a different situation, only a more
> specific one: *the carrier says delivered, the customer does not have it* —
> "left at a neighbour's" is a reason, not a second question. Identical `needs`,
> identical state, and `Email-Example-Responses.md` sent both to the one answer
> `commande_livree_contestee`.
>
> **Its phrasing is the reason to merge rather than to delete.** « Le livreur GLS
> a livré mon colis ailleurs que chez moi » shares almost no vocabulary with
> « livré dans ma boîte aux lettres mais il n'y a rien » — same situation, very
> different words. That is exactly the spread the phrasing rows exist to hold,
> and as two exemplars they were splitting it and competing on the margin.
>
> Count stays **10** — D-04 was measured inside this cluster.
> **`D-04` is now a retired key** and its draft row survives in the database.

**Contenu stable** _(à rédiger)_
>

---

### D-05 · Le suivi de mon colis n'a pas bougé depuis plusieurs jours.
`delivery` · `problem` · **2 msgs** · 🔒 carrier API

**Variantes réelles**
- « La commande est bloquée depuis deux semaines. Le statut n'a pas changé sur le site GLS »

**needs** `order_identity`, `delivery_state`
**exemplaires** → jeu `commande`, état `expediee_hors_delai`

**Contenu stable** _(à rédiger)_
>

---

### D-06 · Mon colis est revenu chez vous — pouvez-vous le réexpédier ?
`delivery` · `problem` · **2 msgs** · 🟢

**Variantes réelles**
- « Vous avez tenté de me joindre concernant ma commande qui est revenue chez vous »

**needs** `order_identity`, `order_state`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

### D-07 · Quels sont vos délais de préparation et de livraison ?
`delivery` · `question` · _no cluster — see note_ · 🟢

**Variantes réelles**
- « J'ai passé une commande, le 29 courant, sur votre site pour la 1ère fois et j'aimerais savoir quel est votre délai moyen pour préparation et expédition ? »

> **Added deliberately.** No cluster of its own, but it is the implied background
> to D-01, O-09 and O-11: none of those can be answered well without stating the
> normal delivery window somewhere. Cut it only if that window lives in another
> article already.
>
> **First real phrasing added 2026-08-12**, from the review folder. The eval had
> already independently named this message as D-07's closest ticket (0.559, its
> best score anywhere) while it still had nothing but the canonical question.
>
> **The heading was asking two questions and now asks one.** It used to run
> *"…et vers quels pays livrez-vous ?"*, which put a timing question and a
> destination question behind a single vector. The destination half is now
> **D-33**, which has real mail of its own; this entry keeps the timing half,
> which is the one every order-status question quietly depends on.

**needs** `policy_answer`
**exemplaires** → jeu `produit`, état `reponse_dans_la_base`

**Contenu stable** _(à rédiger)_
>

---

### D-08 · J'ai reçu un produit qui ne correspond pas à ce que j'avais commandé.
`delivery` · `problem` · **2 msgs** (ES) · 🟢

**Variantes réelles**
- « Mi pedido num. 6298 ha venido erróneo, el producto "CARESSE TEMPS SUBLIME NUIT"… »

**needs** `order_identity`, `product_identity`, `policy_answer`
**exemplaires** → jeu `retour`

**Contenu stable** _(à rédiger)_
>

---

### D-33 · Livrez-vous dans mon pays ? Votre site n'accepte pas mon adresse à l'étranger.
`delivery` · `question` · _no cluster — from the review folder, 2026-08-12_ · 🟢

**Variantes réelles**
- « Malheureusement, votre boutique en ligne ne fonctionne pas avec mon adresse allemande. Quelles autres options pouvez-vous me proposer pour obtenir des produits Qiriness ? »
- « en raison des difficultés économiques de votre partenaire de distribution, les produits ne sont plus disponibles dans mon pays »

> **Split out of D-07, which was asking two questions at once.** That entry's
> heading ran *"quels sont vos délais de livraison, et vers quels pays
> livrez-vous ?"* — a timing question and a destination question sharing one
> vector. They have different answers and different askers: the timing question
> comes from someone who has already ordered, this one from someone who cannot.
>
> **It has real mail behind it and D-07 never did.** A German customer whose
> distributor collapsed, and an English enquiry about duties on a US shipment,
> neither of which matched anything in the corpus.
>
> **One phrasing is still missing and cannot be added yet:** « hello. is there
> additional duties or taxes for shipments to USA? » is English, and a phrasing
> has no way to declare its language in this document. It is the clearest single
> case for finishing that parser change.
>
> **Scope, deliberately narrow.** This is the pre-purchase question *can I order
> from here*. It is **not** the post-purchase billing dispute (« j'ai reçu une
> facture des douanes suisse… je crois que je ne dois pas payer la TVA
> française ») — that is a tax argument, not a delivery question, and it is left
> out as too rare to author against.

**needs** `policy_answer`
**exemplaires** → jeu `produit`, état `reponse_dans_la_base`

**Contenu stable** _(à rédiger)_
>

---

# Commande — 4 questions · 65 messages

### O-09 · Ma commande n'est toujours pas expédiée. Quel est le délai entre la commande et l'expédition ?
`order` · `problem` · **22 msgs** · 🟢

**Variantes réelles**
- « Je constate que ma commande #6686 du 28 juillet 2026 n'est toujours pas traitée »
- « Pouvez-vous m'indiquer le délai entre une commande et son traitement ? »
- « Ma carte bleue est bien débitée mais la commande est toujours indiquée… »
- « Ma carte a été débitée mais ma commande est toujours indiquée en attente » _(authored — was O-10's canonical question)_
- « Commande R4F8FH09J — J'ai passé une commande le 24 mai et ai reçu la confirmation à la fin… » _(was O-11)_
- « J'ai reçu la confirmation de commande puis plus aucune nouvelle » _(authored — was O-11's canonical question)_

**needs** `order_identity`, `order_state`, `payment_state`, `policy_answer`
**exemplaires** → jeu `commande`, état `non_expediee`

> **O-10 merged in, 2026-08-12.** It was split from this on the theory that the
> answers differ — dispatch time vs. how card authorisation works. They do not:
> `Email-Example-Responses.md` sends both to `commande_non_expediee`, and that
> answer's own client phrases already include the card-debited line. The eval
> agreed from the other side — O-10 never won a single ticket, because it sat
> inside this cluster and lost the margin every time.
>
> The count stays **18**: O-10 was measured *within* this cluster, so its
> messages were always counted here.
>
> **`O-10` is now a retired key.** The importer upserts and never deletes an
> exemplar that leaves this document, so its draft row survives in
> `support_exemplars` until someone removes it. Harmless — a draft holds no
> vector and is unreachable — but it is still there.

> **O-11 merged in, 2026-08-30, and this one was measured rather than argued.**
> The 44 stored situation matches were reviewed by hand: most are right, and the
> wrong ones are wrong between near-identical situations. Replaying every
> confusable pair through the rule selector settled which of those matter —
> **O-09 and O-11 select the same rule in all 20 evidence positions the
> `commande` set can distinguish.** They are one situation with two names, and
> the matcher spent 7 tickets choosing between them at a margin of 0.11.
>
> The count becomes **22**: unlike O-10, O-11 was its own cluster, so its 4
> messages were counted separately from these 18.
>
> **`O-11` IS NOT MERELY RETIRED, it had to be soft-deleted.** O-10 was a draft,
> which holds no vector and is unreachable, so leaving it cost nothing. O-11 was
> approved and embedded — it would have gone on winning matches against the
> question that absorbed it. `deleted_at` is what the retrieval function checks.

**Contenu stable** _(à rédiger)_
>

---

### O-12 · Je me suis trompé(e) d'adresse de livraison — pouvez-vous la modifier ?
`order` · `problem` · **7 msgs** · 🟢

**Variantes réelles**
- « je viens de passer une commande je vous remercie de l'envoyer au 12 allée Jacques Bainvi… »
- « je viens de passer une commande (6501). Toutefois l'adresse indiquée n'est pas… »
- « nouvelle adresse pour recevoir mon coli car ma commande est l'ancienne adresse » _(objet du message — le corps est notre réponse)_

**needs** `order_identity`, `order_state`
**exemplaires** → jeu `commande` — the answer hinges on `non_expediee` vs already dispatched

**Contenu stable** _(à rédiger)_
>

---

### O-13 · Je souhaite annuler ma commande.
`order` · `problem` · **3 msgs** · 🟢

**Variantes réelles**
- « Je souhaite annuler ma commande. Pourriez-vous faire le nécessaire svp ? »

**needs** `order_identity`, `order_state`, `policy_answer`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

### O-14 · Puis-je ajouter un article à une commande déjà passée ?
`order` · `question` · **2 msgs** · 🟢

**Variantes réelles**
- « J'ai effectué une commande hier et j'ai oublié de rajouter les trois échantillons »

**needs** `order_identity`, `order_state`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

# Promotions — 5 questions · 21 messages

> The crispest, highest-volume group and entirely within your control — worth
> writing first even though delivery ranks above it.

### P-15 · Je me suis inscrit(e) à la newsletter pour la remise de 20 % mais je n'ai jamais reçu le code.
`promotions` · `problem` · **14 msgs** — biggest single-issue cluster in the corpus · 🟢

**Variantes réelles**
- « je suis inscrite à newsletter pour bénéficier de la remise de 20 %. Mais je ne reçois pas de code de réduction, comment avoir la remise de ma 1ère commande lors de paiement ? »
- « Je me suis inscrite à votre newsletter avec cette adresse e-mail afin de bénéficier de l'offre de bienvenue de -20 %. J'ai bien confirmé mon inscription, vérifié mes spams… »
- « 2 fois que je m'inscris à la newsletter afin d'obtenir les 20% su ma première commande, mais je ne reçois aucun mail »
- « je me suis inscrit à la newlecteurs je ne reçois pas le coupon de 20%, pouvez-vous m'aider ? »
- « Je n'arrive pas à avoir les 20% avec la newletter je me suis inscrite mais je n'ai jamais rien reçu comme remise. Que faire j'ai besoin de commander svp ?? »
- « Je voudrais savoir pourquoi je n ai pas reçu de code pour les -20% pour la 1ere commande alors que je me suis inscrite » _(extrait — la question « puis-je l'utiliser sur les soldes ? » qui suit est sur P-18)_

**needs** `customer_account_state`, `promotion_validity`
**exemplaires** → jeu `promo`, état `code_non_recu`

> **Narrowed to the code never arriving, 2026-08-12** — and this partly reverses
> the P-16 merge made earlier the same day.
>
> **The merge axis was wrong, and the corpus says so plainly.** It was made on
> the claim that the customer cannot tell the causes apart. They can: *"I signed
> up and no code came"* and *"I have the code and it will not apply"* are
> different observations from where the customer sits, not different diagnoses of
> one observation. Reading all 21 promotions tickets end to end, **14 are the
> first and 3 are the second** — the split is the strongest signal in the
> promotions data, and folding it away lost it.
>
> **What stays merged.** The eligibility half of P-16 did not come back here; it
> went to **P-18**, which is now the "my code does not work" situation. So this
> entry is one situation with one answer again — `promo_code_non_recu` — rather
> than one exemplar spanning three.
>
> **Register note.** Four of the five phrasings misspell *newsletter*
> (« newlecteurs », « newletters », « news letters »). That is not noise to tidy
> up; it is the single most distinctive token this situation has, and correcting
> it would make these match worse.

**Contenu stable** _(à rédiger)_
>

---

### P-17 · Le masque offert ne s'ajoute pas à mon panier quand je clique sur « je le veux ».
`order` / `promotions` · `problem` · **9 msgs** across two clusters · 🔒 `checkout_state`

**Variantes réelles**
- « on m'offre un masque gratuit lors de ma commande mais quand je clique sur "je le veux" »
- « Je viens de passer commande et je devais avoir un masque offert mais quand je l'ajoutais… »

**needs** `promotion_validity`, `promotion_eligibility`, `checkout_state`
**exemplaires** → jeu `promo`

**Contenu stable** _(à rédiger)_
>

---

### P-18 · Mon code promotionnel ne fonctionne pas : la remise ne s'applique pas à ma commande.
`promotions` · `problem` · **5 msgs** · 🟢 / 🔒 for `panier_invisible`

**Variantes réelles**
- « je souhaite passer une commande mais la promo de 20% pour la première commande ne s'applique pas ? et je n arrive pas à vous joindre par téléphone…. »
- « J'essaie de passer ma PREMIÈRE commande sur votre site mais les 20 % "promis" ne s'appliquent pas… »
- « La réduction ne se calcule pas avant le paiement » _(objet du message — le corps est notre réponse)_
- « j'essaie de faire une première commande, je me doute que je ne peux pas bénéficier des 20% de 1er commande sur des articles soldés ? »
- « puis-je l'utiliser sur les soldes ? » _(extrait — la première moitié du message est sur P-15)_

**needs** `promotion_identity`, `promotion_validity`, `promotion_eligibility`
**exemplaires** → jeu `promo`

> **Rewritten 2026-08-12. It used to ask « puis-je cumuler plusieurs offres ? »
> and that was never a real question.** Its only quoted phrasing was *our own
> reply*, which the importer refused to embed, so it went to the eval with
> nothing but a canonical question and never won a ticket.
>
> **The question had been reverse-engineered from our answers.** Every sentence
> in the corpus about offers being cumulable is one we wrote — the NEWYEAR26
> explanation, the wrap-vitaminé reply, the soldes note. Searched across 296
> stored messages and the review folder: **no customer has ever asked whether
> codes stack.** They report the symptom instead — the code will not apply.
>
> **Eligibility questions live here now, phrased as customers actually ask them.**
> « puis-je bénéficier des 20 % sur des articles soldés ? » is the question the
> old heading was groping toward, and it belongs with "my code does not work"
> rather than in its own entry: both resolve through the same findings, and both
> land on `promo_code_valide_non_eligible` when the code is real but the basket
> does not qualify.
>
> **The boundary with P-15 is what the customer can observe**, not what turns out
> to be true: no code ever arrived → P-15; a code exists and will not apply →
> here. **Not P-19**, which is a displayed promotional *price* differing at
> checkout with no code involved.

**Contenu stable** _(à rédiger)_
>

---

### P-19 · Le prix promotionnel affiché sur le site n'est pas celui appliqué au paiement.
`promotions` · `problem` · **3 msgs** · already `covered by faq (0.61)` · 🟢

**Variantes réelles**
- « j'aimerai vous commander votre offre EAU QI prix promo 37,80 €. Le prix de 54 € n'est pas… »

**needs** `promotion_validity`, `product_property`
**exemplaires** → jeu `promo`

**Contenu stable** — partially covered already; check before rewriting
>

---

### P-20 · Je n'ai pas reçu les échantillons offerts avec ma commande.
`order` / `promotions` · `problem` · **4 msgs** · 🟢

**Variantes réelles**
- « Pour une première #5907 commande, je n'ai pas reçu mon échantillon ? »
- « He olvidado pedir las tres muestras de regalo… »

**needs** `order_identity`, `policy_answer`
**exemplaires** → jeu `promo`

**Contenu stable** _(à rédiger)_
>

---

# Retours et remboursements — 3 questions · 16 messages

### R-21 · Comment retourner un produit ? Je ne trouve pas l'adresse de retour.
`return_exchange` · `question` · **5 msgs** (EN, cohesion 0.89) · 🟢

**Variantes réelles**
- « Hi, accidently ordered the wrong products. How can I return? I do not see a return address on the… »
- « Pourquoi je ne peux pas le déposer au magasin ? » _(extrait — la question sur les frais de retour qui l'accompagne est sur R-22)_

**needs** `return_eligibility`, `policy_answer`
**exemplaires** → jeu `retour`

**Contenu stable** _(à rédiger)_
>

---

### R-22 · Les frais de retour sont-ils à ma charge ou remboursés ?
`return_exchange` · `question` · **3 msgs** · 🟢 · **follow-up register**

**Variantes réelles**
- « il y aura t il un remboursement des frais d'envoi ? Car je ne suis pas responsable si le produit a un problème » _(extrait — « pourquoi je ne peux pas le déposer au magasin ? » est sur R-21)_

> **Neither rare nor phrased wrong — measured somewhere it cannot appear.**
> 2026-08-12: the source message was pulled back out of the corpus, and the
> truncated quote was hiding two things.
>
> **It is a mid-thread reply, not an opening message.** Subject *"RE: RE:
> PROBLEME MASQUE LED"* — the customer is four messages into a broken-LED-mask
> conversation. `diagnose-exemplars.mjs` scores only the **first inbound message**
> of each ticket, deliberately, so this phrasing's own message is never a query in
> the eval. R-22 winning nothing was never evidence about R-22.
>
> **Nobody opens with this question**, and that is the general point: return
> costs, refund timing and "any news?" are *follow-up* questions by nature. An
> eval built on trigger messages is structurally blind to them, and the fix is to
> say so rather than to keep tuning phrasings against a corpus that excludes them.
>
> **The reason is load-bearing and was cut off by the "…".** « je ne suis pas
> responsable si le produit a un problème » — this is a **defective-goods**
> return, where who pays is not a matter of goodwill. A change-of-mind return is
> a different answer to the same sentence, which is why this stays its own
> question rather than merging into R-21.
>
> **Not fixed here:** `retour_possible` currently serves R-21, R-22, D-08 *and*
> PR-26 without distinguishing faulty from unwanted. That is an answer-side
> condition on `return_eligibility`, and it is the open question below.

**needs** `policy_answer`, `return_eligibility`
**exemplaires** → jeu `retour`

**Contenu stable** _(à rédiger)_
>

---

### R-23 · Sous quel délai suis-je remboursé(e) après réception de mon retour ?
`return_exchange` · `question` · **4 msgs** (ES) · 🔒 `remboursement_en_cours`

**Variantes réelles**
- « Hasta la fecha no he recibido contestación a mi correo de reclamación »

**needs** `refund_state`, `policy_answer`
**exemplaires** → jeu `retour`

**Contenu stable** _(à rédiger)_
>

---

# Produits et disponibilité — 6 questions · 22 messages

> Five are subject `product`; **S-34 is `product_stock`**, a different subject in
> the taxonomy and the only entry that carries it.

### PR-24 · Vos produits sont-ils vegan et non testés sur les animaux ?
`product` · `question` · **5 msgs** · 🟢 — crispest question in the whole set

**Variantes réelles**
- « Je souhaiterais savoir si vos produits (gamme active énergie notamment) sont vegans »
- « vos produits sont-ils testés sur les animaux ? »
- « Je voudrais savoir si vos masques type Wrap apaisant sont vegan svp »

**needs** `product_property`, `brand_answer`
**exemplaires** → jeu `produit`

**Contenu stable** _(à rédiger)_
>

---

### PR-25 · Quelle routine me conseillez-vous pour mon type de peau ?
`product` · `question` · **3 msgs** · currently **NO ARTICLE** · 🟢

**Variantes réelles**
- « J'aimerais avoir des conseils personnalisés pour ma routine svp merci »
- « je suis femme de 57 ans et j'ai toujours eu des poches sous les yeux… »cpu

**needs** `product_identity`, `product_property`
**exemplaires** → jeu `produit` — `produit_ambigu` is the likely default here

**Contenu stable** _(à rédiger)_
>

---

### PR-26 · Mon masque LED ne se recharge plus / la batterie ne tient pas.
`product` · `problem` · **2 msgs** · 🟢

**Variantes réelles**
- « j'ai acheté un masque led fast masque qiriness, celui-ci ne se charge plus »
- « je suis très déçue de la batterie qui tient… »

**needs** `product_identity`, `product_property`, `policy_answer`
**exemplaires** → jeu `produit` + `retour` (warranty path)

**Contenu stable** _(à rédiger)_
>

---

### PR-27 · À quoi sert le mode pulsé du masque LED ?
`product` · `question` · **2 msgs** · 🟢

**Variantes réelles**
- « Pouvez-vous me dire à quoi sert le mode pulsé sur le masque qiriness que je viens d'acquérir »

**needs** `product_property`
**exemplaires** → jeu `produit`

**Contenu stable** _(à rédiger)_
>

---

### PR-28 · Quelles sont les caractéristiques du masque LED (longueurs d'onde, irradiance, durée de séance) ?
`product` · `question` · **3 msgs** — pre-purchase · 🟢

**Variantes réelles**
- « Je m'intéresse de près à votre Masque LED visage et je souhaiterais quelques précisions »
- « Avant de me décider, je souhaiterais connaître quelques caractéristiques techniques qui ne figurent pas sur la fiche produit : l'irradiance (ou densité de puissance), exprimée en mW/cm² ; la fluence, délivrée au cours d'une séance de 10 minutes »

**needs** `product_property`
**exemplaires** → jeu `produit`

**Contenu stable** _(à rédiger)_
>

---

### S-34 · Le produit ou le cadeau est en rupture de stock — dois-je attendre, ou sera-t-il envoyé plus tard ?
`product_stock` · `question` · _no cluster — from the review folder, 2026-08-12_ · 🟢

**Variantes réelles**
- « je souhaite commander 2 produits qui sont actuellement dans mon panier, or, le cadeau pour ces deux produits de la même gamme est en rupture de stock. Dois-je attendre qu'il soit à nouveau en stock pour passer ma commande, où sera-t-il envoyé ultérieurement ? »

> **The first exemplar for `product_stock`, a subject that has been switched on
> the whole time.** `ENABLED_SUBJECTS` already contains it, so tickets have been
> routed there and found nothing to match against.
>
> **Fully reachable today, unusually.** `LOOKUP_STOCK` exists and
> `product_availability` resolves to `in_stock` / `out_of_stock` / `unknown` —
> so unlike most of this set, the branch this question turns on is one the tools
> can actually decide. It is the cheapest answer in the document to write.
>
> **Two questions in one sentence, and the second is the hard half.** *Is it in
> stock* is a lookup; *will you send it on afterwards* is a fulfilment promise,
> and nothing in the system knows it. That is a merchant policy decision before
> it is an answer.
>
> **Not P-17.** That is the gift refusing to go into the basket — a checkout
> bug, blocked on `checkout_state`. Here the basket works fine and the gift is
> simply not there to give.

**needs** `product_identity`, `product_availability`, `promotion_eligibility`
**exemplaires** → jeu `produit` — needs a new state, `rupture_de_stock`; the
existing three (`reponse_dans_la_base`, `produit_ambigu`, `aucune_source`) are
about whether we *know* the answer, not about what the stock actually is

**Contenu stable** _(à rédiger)_
>

---

# Compte et paiement — 4 questions · 17 messages

### A-29 · Je n'arrive pas à réinitialiser mon mot de passe ni à me connecter.
`account` · `problem` · **5 msgs** · ✅ **ALREADY WORKS — retrieves at 0.61–0.62**

> **This is the control, not a task.** It is the only question in the set that
> already clears the answerable bar against the existing library, and therefore
> the only end-to-end proof the pipeline works. **Do not rewrite it.** Use its
> chunk as the format template for everything above.

**Variantes réelles**
- « Bonjour je n'arrive pas à réinitialiser mon mot de passe »
- « Impossible de me connecter à mon compte même en changeant le mot de passe »

**needs** `customer_account_state`, `policy_answer`
---

### PA-30 · Comment obtenir une facture pour ma commande ?
`payment` · `question` · **6 msgs** — check the B2B/consumer split first · 🟢

**Variantes réelles**
- « Réf. client : C0000294 — Je vous prie de bien vouloir me faire parvenir la facture… »
- « Je ne reçois aucune facture de votre laboratoire. Pourriez-vous m'indiquer la démarche »

**needs** `order_identity`, `policy_answer`
**exemplaires** → jeu `commande`

> Some of this cluster was `lap-groupe.com` before the sender directory landed.
> Re-check how much is genuine consumer demand before sizing the answer.

**Contenu stable** _(à rédiger)_
>

---

### PA-31 · Des frais supplémentaires apparaissent au moment du paiement.
`payment` · `problem` · **2 msgs** · 🟢

**Variantes réelles**
- « au moment de payer (73 euros) il y a des frais supplémentaires demandés »

**needs** `policy_answer`, `payment_state`
**exemplaires** → jeu `promo` / `commande`

**Contenu stable** _(à rédiger)_
>

---

### PA-32 · Je n'arrive pas à finaliser le paiement de ma commande.
`payment` · `problem` · **2 msgs** (NL) · currently **NO ARTICLE** · 🟢

**Variantes réelles**
- « Kan geen bestelling plaatsen, is er iets mis ofzo? »
- « wil iets anders bestellen en hang elke keer vast bij de betaling »

**needs** `payment_state`, `policy_answer`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

# Cosmétovigilance — 3 questions · 3 messages

> **Read the split before writing here.** Eight tickets carried this subject and
> only three belong to it: four were physically defective products — masks
> arriving dried out, one contaminated — and one is an internal thread. The
> categoriser was sharpened on 2026-08-30 so a defective item goes to `product`
> ("le produit lui-même pose problème, pas la peau du client"), which is why the
> counts here are small and honest rather than large and mixed.
>
> **Nothing in this family is ever answered by the agent.** The `cosmetovigilance`
> answer set carries a rule routing every ticket to a person whatever the
> evidence says, and a rule cannot route to `answerable` at all. The situations
> below exist to shape the acknowledgement and to tell a reviewer what they are
> looking at — not to open a path to a reply.

### CV-01 · J'ai eu des rougeurs ou des boutons après avoir utilisé un produit.
`cosmetovigilance` · `problem` · **1 msgs** · 🟢

**Variantes réelles**
- « J'ai voulu essayer une autre gamme la crème d'exception qui malheureusement m'a provoqué des rougeurs et boutons sur les joues, le nez et le front. Je vous précise avoir une peau mature très sensible et déshydratée »
- « J'ai utilisé votre soin et j'ai eu des rougeurs et des démangeaisons » _(authored)_
- « Après application j'ai ressenti des picotements et une sensation d'échauffement sur tout le visage » _(authored)_
- « Ma peau a mal réagi à votre masque, j'ai des plaques depuis hier » _(authored)_
- « Je pense être allergique à un ingrédient de votre crème, que me conseillez-vous ? » _(authored)_
- « J'ai eu de petits boutons après deux utilisations. Dois-je arrêter le produit ou continuer ? » _(authored)_

**needs** `customer_identity`, `product_identity`, `policy_answer`
**exemplaires** → jeu `cosmetovigilance`

> **The mild end, and it does not look like a complaint.** The real message thanks
> us for the product she is still buying, reports the reaction almost in passing,
> and asks for a sample of a third cream. `product_identity` is declared and
> **cannot be satisfied** — this subject has no product tool — so it reports as a
> gap, which is the honest state: a reviewer needs to know which cream, and the
> agent cannot tell them.

**Contenu stable** _(à rédiger)_
>

---

### CV-02 · J'ai eu une réaction sévère et je demande un remboursement.
`cosmetovigilance` · `problem` · **1 msgs** · 🟢

**Variantes réelles**
- « After using the product, I experienced a serious reaction. The reaction has been so severe that I have not been able to step out of my home due to the condition of my skin. Given the adverse reaction caused by your product, I expect a full refund at the earliest »
- « J'ai fait une réaction très importante à votre produit et je demande le remboursement complet de ma commande » _(authored)_
- « Mon visage a gonflé et me brûle depuis que j'ai appliqué votre soin. J'exige un dédommagement » _(authored)_
- « J'ai dû consulter un médecin après avoir utilisé votre produit. Je veux être remboursée intégralement » _(authored)_
- « Réaction violente, je ne peux plus sortir de chez moi. Que comptez-vous faire ? » _(authored)_
- « Votre produit m'a abîmé la peau, je demande le remboursement et je compte le faire savoir » _(authored)_

**needs** `customer_identity`, `product_identity`, `purchase_verified`, `policy_answer`
**exemplaires** → jeu `cosmetovigilance`

> **Separate from CV-01 because the answer is separate.** A mild reaction wants
> care and advice; this one arrives with a refund demand, a photograph of the
> skin, and — in the real message — a purchase made on Amazon rather than from
> us. Both go to a person, and the person needs to know which of the two they
> have opened before reading a line.
>
> **`purchase_verified` is declared and unsatisfiable here**, deliberately: no
> refund decision can be made without knowing whether the purchase was ours, and
> this subject has no purchase tool. The gap is the report.
>
> The first variant is **English**, stored as `fr`: the importer reads no language
> annotation, and `match_support_exemplars` reports the language but never filters
> on it. The vector is right; the label is not.

**Contenu stable** _(à rédiger)_
>

---

### CV-03 · Puis-je utiliser ce produit compte tenu de mon état de santé ?
`cosmetovigilance` · `problem` · **1 msgs** · 🟢

**Variantes réelles**
- « je viens d'acquérir un masque Qiriness. pouvez vous me dire quels sont les effets secondaires pour les yeux. D'autre part j'ai été opérée il y a plusieurs années, j'espère qu'il n'y a pas de risque » _(generalised — see the note below)_
- « Puis-je utiliser ce produit si je suis enceinte ou si je suis un traitement dermatologique ? » _(authored)_
- « J'allaite, est-ce que votre soin est compatible ? » _(authored)_
- « J'ai de l'eczéma / de la rosacée, votre masque est-il adapté à ma peau ? » _(authored)_
- « Y a-t-il des contre-indications à utiliser le masque LED ? » _(authored)_
- « Je suis sous traitement pour la peau, puis-je utiliser vos produits en même temps ? » _(authored)_

**needs** `product_identity`, `policy_answer`
**exemplaires** → jeu `cosmetovigilance`

> **Asked BEFORE use, which is what makes it its own situation.** Nothing has gone
> wrong yet; the customer is asking whether it will. It goes to a person every
> time, with no evidence branch to reach for: a question about someone's health is
> never answered from an article, however good the article is.
>
> **THE REAL PHRASING WAS GENERALISED, and the diagnosis removed.** It named the
> condition a customer had been operated on for. A phrasing is embedded and kept
> for as long as the corpus lives, and that detail bought nothing — matching turns
> on the SHAPE ("I have a history, is this safe?"), which the surrounding words
> carry perfectly well. Keeping it would have stored one customer's medical record
> in a retrieval index to answer somebody else's question.

**Contenu stable** _(à rédiger)_
>

---

# Deliberately absent

### The Nocibé reorder flow
**10 msgs, cohesion 1.00** — the sixth-largest topic in the corpus, and *not* a
knowledge article. « Dear partner, Please find attached a new reorder n°3086105.
Thanks in advance for confirming » is a **workflow**, not a question. It needs a
B2B path — confirm, route to sales, acknowledge — not a chunk. `sender_directory`
labels `nocibe.fr` as `retailer` precisely so this stays visible as real demand
rather than being filtered away as noise.

---

# Open decisions

**1. Non-French mail.** 14 tickets (7 en · 3 it · 2 es · 2 other), ~7%.
Measured on real tickets: as written they score a median **0.448** — below the
`WEAK` floor of 0.50, so **most retrieve nothing at all** and route to a human.
Translated to French before embedding: **0.519**, and translation helped in
**11/11 cases**. French control median is 0.559.

~~Recommendation: translate the **query**, never the library.~~ **Reversed
2026-08-12.** Two things were wrong with it.

**The premise was already false.** "Keep the library French so the comparison
stays French↔French" — but R-21 is English and D-08 and R-23 are Spanish. The
library has been mixed-language since the day it was written.

**Query translation trades one mismatch for another.** It does help (0.448 →
0.519, 11/11) but it cannot close the gap, because machine-translating a messy
English email produces *tidy* French — and tidy-against-messy is exactly the
register gap the variants exist to close. It is also a model call in the hot
path of every non-French ticket, on text nobody reviews.

**Now:** phrasings carry a `language`, and the fix is library-side — real
non-French phrasings where the corpus has them, machine translation to fill the
rest. Done once, offline, reviewed at approval like everything else.

Measured 2026-08-12 on exemplars: `fr` median **0.637**, `en` **0.476**,
`es` **0.814** (n=2 — and D-08 is the one with a real Spanish phrasing).

**Sequencing, and it matters:** translate **last**, once every question has its
full set of verbatim phrasings. Each authored phrasing added afterwards is
another thing to translate, so translating early means paying twice. The schema
is ready (`language`, `translated`, index space at 100+); nothing generates
translations yet, by choice.

**2. Merge candidates — three resolved 2026-08-12, a fourth 2026-08-30.** O-09/O-10, D-03/D-04 and P-15/P-16 were merged then; **O-09/O-11** now. This document holds **33** questions, and `support_exemplars` **33 live rows** once O-11 is soft-deleted — counted rather than carried forward, because the “32 → 29” written here in August never matched what the importer parses.

The three had three different justifications, and the difference is worth
keeping: **O-09/O-10** and **D-03/D-04** shared a single answer, so the split was
simply wrong. **P-15/P-16** did *not* — it spans three answers, and was merged on
the stronger claim that which of the three applies is a **finding rather than a
question**, since the customer writing in cannot tell them apart either.

Retired keys, whose draft rows survive in `support_exemplars` because the
importer upserts and never deletes: **O-10, D-04, P-16**.

**O-11 is different, and the difference is the lesson.** The other three were
retired while still drafts, so their rows are unreachable and leaving them costs
nothing. O-11 was **approved and embedded**, so removing it from this document
would have removed it from nowhere — it would have gone on competing for matches
against the question that absorbed it. An approved exemplar leaving this file
needs `deleted_at` set as well.

The fourth merge is also the first argued from a **measurement rather than a
reading**: every confusable pair the matcher produced on real tickets was
replayed through the rule selector, and O-09/O-11 was the pair whose confusion
changed no outcome in any evidence position. The pairs that DO change an outcome
all turned out to share a shape — a specific complaint losing narrowly to the
generic `D-01` — and merging cannot fix those, because they are not duplicates.

**2b. Faulty vs change-of-mind returns — who pays.** `retour_possible` serves
R-21, R-22, D-08 and PR-26 as one answer, but R-22's real message asks about
return costs *because the mask is broken*, and D-08 is a wrong item sent. Those
are not goodwill decisions. This wants a condition on `return_eligibility`
splitting the answer, not another exemplar — **your call on the policy, then one
answer row.**

**2c. Follow-up questions are invisible to the eval.** R-22 arrives four
messages into a thread, and `diagnose-exemplars.mjs` scores only first inbound
messages. R-23 ("any news on my refund?") is the same shape. Neither can be
assessed as things stand; scoring later messages would work, but it also pulls
our own vocabulary into the corpus, which is why the eval excludes them.

**3. Re-measure after writing.** The French control median of 0.559 says the
library — not language — is the binding constraint today. Re-run
`npm run eval:retrieval` and the cross-lingual probe once these land; the
translation gain will look different against a library that covers the questions.
