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

**needs** `order_identity`, `delivery_state`
**exemplaires** → jeu `commande`, état `livree_contestee`

**Contenu stable** _(à rédiger)_
>

---

### D-04 · Le livreur a déposé mon colis chez un voisin ou à une adresse qui n'est pas la mienne.
`delivery` · `problem` · _(within D-03's cluster)_ · 🔒 carrier API

**Variantes réelles**
- « Le livreur GLS a livré mon colis ailleurs que chez moi malgré mes précisions »

**needs** `order_identity`, `delivery_state`
**exemplaires** → jeu `commande`, état `livree_contestee`

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

### D-07 · Quels sont vos délais de livraison, et vers quels pays livrez-vous ?
`delivery` · `question` · _no cluster — see note_ · 🟢

> **Added deliberately.** No cluster of its own, but it is the implied background
> to D-01, O-09 and O-11: none of those can be answered well without stating the
> normal delivery window somewhere. Cut it only if that window lives in another
> article already.

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

# Commande — 6 questions · 65 messages

### O-09 · Ma commande n'est toujours pas expédiée. Quel est le délai entre la commande et l'expédition ?
`order` · `problem` · **18 msgs** · 🟢

**Variantes réelles**
- « Je constate que ma commande #6686 du 28 juillet 2026 n'est toujours pas traitée »
- « Pouvez-vous m'indiquer le délai entre une commande et son traitement ? »

**needs** `order_identity`, `order_state`, `policy_answer`
**exemplaires** → jeu `commande`, état `non_expediee`

**Contenu stable** _(à rédiger)_
>

---

### O-10 · Ma carte a été débitée mais ma commande est toujours indiquée « en attente ».
`order` · `problem` · _(within O-09's cluster)_ · 🟢

**Variantes réelles**
- « Ma carte bleue est bien débitée mais la commande est toujours indiquée… »

**needs** `order_identity`, `payment_state`
**exemplaires** → jeu `commande`, état `non_expediee`

> **Merge candidate with O-09.** Split because the answers differ — dispatch
> time vs. how card authorisation works. Collapse if they turn out the same.

**Contenu stable** _(à rédiger)_
>

---

### O-11 · J'ai reçu la confirmation de commande puis plus aucune nouvelle.
`order` · `problem` · **4 msgs** · 🟢

**Variantes réelles**
- « Commande R4F8FH09J — J'ai passé une commande le 24 mai et ai reçu la confirmation à la fin… »

**needs** `order_identity`, `order_state`
**exemplaires** → jeu `commande`

**Contenu stable** _(à rédiger)_
>

---

### O-12 · Je me suis trompé(e) d'adresse de livraison — pouvez-vous la modifier ?
`order` · `problem` · **7 msgs** · 🟢

**Variantes réelles**
- « je viens de passer une commande je vous remercie de l'envoyer au 12 allée Jacques Bainvi… »
- « je viens de passer une commande (6501). Toutefois l'adresse indiquée n'est pas… »

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

# Promotions — 6 questions · 21 messages

> The crispest, highest-volume group and entirely within your control — worth
> writing first even though delivery ranks above it.

### P-15 · Je me suis inscrit(e) à la newsletter pour la remise de 20 % mais je n'ai jamais reçu le code.
`promotions` · `problem` · **16 msgs** — biggest single-issue cluster · 🟢

**Variantes réelles**
- « je suis inscrite à newsletter pour bénéficier de la remise de 20 %. Mais je ne reçois pas… »
- « Je me suis inscrite à votre newsletter avec cette adresse e-mail afin de bénéficier de… »

**needs** `customer_account_state`, `promotion_validity`
**exemplaires** → jeu `promo`

**Contenu stable** _(à rédiger)_
>

---

### P-16 · Le code de 20 % première commande ne s'applique pas à mon panier.
`promotions` · `problem` · _(within P-15's cluster)_ · 🟢 / 🔒 for `panier_invisible`

**Variantes réelles**
- « J'essaie de passer ma PREMIÈRE commande sur votre site mais les 20 % "promis" ne s'appliquent pas »

**needs** `promotion_identity`, `promotion_validity`, `promotion_eligibility`
**exemplaires** → jeu `promo`

> **Merge candidate with P-15.** Split because one is email deliverability and
> the other is eligibility conditions — different answers, I think.

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

### P-18 · Puis-je cumuler plusieurs offres ou codes promotionnels ?
`promotions` · `question` · **3 msgs** · 🟢

**Variantes réelles**
- « Les offres ne sont effectivement pas cumulables… » _(our own reply — the customer-side phrasing needs writing)_

**needs** `policy_answer`, `promotion_eligibility`
**exemplaires** → jeu `promo`

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

**needs** `return_eligibility`, `policy_answer`
**exemplaires** → jeu `retour`

**Contenu stable** _(à rédiger)_
>

---

### R-22 · Les frais de retour sont-ils à ma charge ou remboursés ?
`return_exchange` · `question` · **3 msgs** · 🟢

**Variantes réelles**
- « il y aura t il un remboursement des frais d'envoi ? Pourquoi je ne peux pas le déposer à… »

**needs** `policy_answer`
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

# Produits — 5 questions · 22 messages

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
- « je suis femme de 57 ans et j'ai toujours eu des poches sous les yeux… »

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
- « Avant de me décider, je… »

**needs** `product_property`
**exemplaires** → jeu `produit`

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

Recommendation: translate the **query**, never the library — that keeps the
comparison French↔French so the 0.60/0.50 thresholds stay valid. One
`gpt-4o-mini` call, only when `tickets.language` isn't `fr`. Not yet wired.

**2. Merge candidates.** O-09/O-10 and P-15/P-16 may collapse once written.
Merging later is cheap; the eval will show it.

**3. Re-measure after writing.** The French control median of 0.559 says the
library — not language — is the binding constraint today. Re-run
`npm run eval:retrieval` and the cross-lingual probe once these land; the
translation gain will look different against a library that covers the questions.
