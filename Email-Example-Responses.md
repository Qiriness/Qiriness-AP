# Example responses — staging file

Draft the replies here, then transfer into the `reply_exemplars` table.
Each block below is one future row.

**One block per situation, not per question.** Several questions share the same
reply once you know the situation — "where is my order?" and "why isn't my order
processed?" both get the *hasn't shipped yet* reply. Write it once.

## Fields (these become the columns)

| Field | Becomes | Notes |
|---|---|---|
| `situation` | `situation` text | the key, e.g. `commande_non_expediee` |
| `category` | `category` text | one of the 14 ticket subjects |
| `serves` | — | which questions route here. Reference only |
| **Phrases client** | `match_text` → **embedded** | ⚠️ this is what gets vectorised |
| **Réponse** | `body_text` | the draft itself. NOT embedded |
| `établi` / `ne pas affirmer` | `requires` / `forbids` | guard rails for the reply |
| `status` | `status` | `ready` or `blocked` |

**Embed the "Phrases client", not the "Réponse".** The incoming email is a
customer question, so it has to be matched against customer questions. Embedding
the reply prose would compare a support answer to a question — different shapes,
weak scores. The reply rides along as the payload.

**Status `blocked`** means the situation can't be detected yet because a tool is
missing. Write the phrases now; leave the reply empty until the tool exists.

---

# Jeu `commande` — order & delivery

## 1. `commande_info_manquante` — we don't know which order
`category: delivery` · `status: ready` · **skip — already automatic**

> The agent already asks for the order number and purchase email by itself, using
> a fixed sentence it owns. Don't write a reply here — it would be a second,
> competing version of a sentence that already exists.

---

## 2. `commande_non_expediee` — not shipped yet
`category: order` · `status: ready`

**serves** D-01, D-06, O-09, O-10, O-11, O-12, O-13, O-14

**Phrases client** _(embedded)_
- « Je constate que ma commande #6686 du 28 juillet 2026 n'est toujours pas traitée »
- « Pouvez-vous m'indiquer le délai entre une commande et son traitement ? »
- « Ma carte bleue est bien débitée mais la commande est toujours indiquée en attente »
- « J'ai passé une commande le 24 mai et ai reçu la confirmation, depuis plus rien »

**établi** numéro de commande · statut d'expédition
**ne pas affirmer** une date d'expédition précise

**Réponse**
>

---

## 3. `commande_expediee_dans_delai` — shipped, still on time
`category: delivery` · `status: ready`

**serves** D-01, D-05, O-11

**Phrases client** _(embedded)_
- « j'ai passé une commande fin juin et je n'ai toujours pas reçu mes articles »
- « Je suis toujours en attente de ma commande numéro 6275 »
- « pourriez-vous m'indiquer svp le délai de livraison »

**établi** numéro de commande · numéro de suivi · date d'expédition
**ne pas affirmer** une date de livraison garantie

**Réponse**
>

---

## 4. `commande_expediee_hors_delai` — shipped but late
`category: delivery` · `status: blocked` 🔒 carrier API (GLS / La Poste)

**serves** D-01, D-05

**Phrases client** _(embedded)_
- « La commande est bloquée depuis deux semaines. Le statut n'a pas changé sur le site GLS »
- « URGENT — Commande #6216 du 27 juin 2026, payée et encaissée, toujours rien »

**Réponse** _(laisser vide — l'état ne peut pas encore être détecté)_
>

---

## 5. `commande_livree_contestee` — carrier says delivered, customer says no
`category: delivery` · `status: blocked` 🔒 carrier API

**serves** D-03, D-04

**Phrases client** _(embedded)_
- « Je viens de voir que mon colis a été livré dans ma boîte aux lettres mais il n'y a rien »
- « Le livreur GLS a livré mon colis ailleurs que chez moi malgré mes précisions »

**Réponse** _(laisser vide)_
>

---

## 6. `commande_article_manquant` — parcel arrived, item missing
`category: delivery` · `status: ready`

**serves** D-02

**Phrases client** _(embedded)_
- « je viens de recevoir mon colis. Il manque un article »
- « J'avais commandé 2x caressé source d'eau et je n'en ai reçu qu'un »

**établi** numéro de commande · contenu de la commande
**ne pas affirmer** que l'article a été expédié ou non sans l'avoir vérifié

**Réponse**
>

---

## 7. `commande_modification` — change address / cancel / add an item
`category: order` · `status: ready`

**serves** O-12, O-13, O-14, D-06

> The answer splits on one thing only: has it shipped yet. If that turns out to
> need two different replies, split this into `_avant_expedition` and
> `_apres_expedition`.

**Phrases client** _(embedded)_
- « je viens de passer une commande, l'adresse indiquée n'est pas la bonne »
- « Je souhaite annuler ma commande. Pourriez-vous faire le nécessaire svp ? »
- « J'ai effectué une commande hier et j'ai oublié de rajouter les trois échantillons »

**établi** numéro de commande · statut d'expédition
**ne pas affirmer** qu'une modification est possible avant d'avoir vérifié le statut

**Réponse**
>

---

# Jeu `promo` — promotions

## 8. `promo_code_non_recu` — signed up, no code arrived
`category: promotions` · `status: ready`

**serves** P-15

**Phrases client** _(embedded)_
- « je suis inscrite à newsletter pour bénéficier de la remise de 20 %. Mais je ne reçois pas le code »
- « Je me suis inscrite à votre newsletter avec cette adresse e-mail afin de bénéficier de la remise »

**établi** état de l'inscription newsletter · existence du code
**ne pas affirmer** que le code a été envoyé si rien ne le montre

**Réponse**
>

---

## 9. `promo_code_valide_non_eligible` — code is real, customer doesn't qualify
`category: promotions` · `status: ready`

**serves** P-16, P-18

**Phrases client** _(embedded)_
- « J'essaie de passer ma PREMIÈRE commande mais les 20 % promis ne s'appliquent pas »
- « je me doute que je ne peux pas bénéficier des deux offres »

**établi** le code existe et est actif · la condition non remplie
**ne pas affirmer** ce que contient le panier — la boutique ne l'expose pas

**Réponse**
>

---

## 10. `promo_code_inexistant_ou_expire`
`category: promotions` · `status: ready`

**serves** P-16, P-19

**Phrases client** _(embedded)_
- « Il semble avoir un code promo pour la première commande mais il ne fonctionne pas »
- « votre offre EAU QI prix promo 37,80 €, le prix de 54 € n'est pas modifié »

**établi** le code n'existe pas / est expiré
**ne pas affirmer** qu'il a été refusé à tort

**Réponse**
>

---

## 11. `promo_cadeau_non_ajoute` — free gift won't go in the basket
`category: promotions` · `status: blocked` 🔒 `checkout_state` unwired

**serves** P-17

**Phrases client** _(embedded)_
- « on m'offre un masque gratuit mais quand je clique sur je le veux, rien ne se passe »
- « Je viens de passer commande et je devais avoir un masque offert »

**Réponse** _(laisser vide — le panier n'est pas visible)_
>

---

## 12. `promo_echantillons` — free samples missing / how to get them
`category: promotions` · `status: ready`

**serves** P-20

**Phrases client** _(embedded)_
- « Pour une première commande #5907, je n'ai pas reçu mon échantillon ? »
- « j'ai oublié de rajouter les trois échantillons »

**établi** numéro de commande · règle applicable aux échantillons
**Réponse**
>

---

# Jeu `retour` — returns & refunds

## 13. `retour_possible` — return still allowed, here's how
`category: return_exchange` · `status: ready`

**serves** R-21, R-22, D-08, PR-26

**Phrases client** _(embedded)_
- « Hi, accidently ordered the wrong products. How can I return? I do not see a return address »
- « il y aura t il un remboursement des frais d'envoi ? »
- « Mi pedido ha venido erróneo »

**établi** date de commande · délai de retour applicable
**ne pas affirmer** un remboursement des frais avant d'avoir vérifié la cause

**Réponse**
>

---

## 14. `retour_hors_delai`
`category: return_exchange` · `status: ready`

**serves** R-21, R-22

**Phrases client** _(embedded)_
- « J'ai commandé il y a plusieurs mois, puis-je encore retourner le produit ? »

**établi** date de commande · délai dépassé
**Réponse**
>

---

## 15. `remboursement_en_cours`
`category: return_exchange` · `status: blocked` 🔒 refund state beyond Shopify's record

**serves** R-23

**Phrases client** _(embedded)_
- « Hasta la fecha no he recibido contestación a mi correo de reclamación »
- « Je voulais juste savoir où en est mon remboursement »

**Réponse** _(laisser vide)_
>

---

# Jeu `produit` — product questions

## 16. `produit_reponse_connue` — the library answers it
`category: product` · `status: ready`

**serves** PR-24, PR-27, PR-28, D-07

**Phrases client** _(embedded)_
- « vos produits sont-ils vegan ? » · « sont-ils testés sur les animaux ? »
- « à quoi sert le mode pulsé sur le masque ? »
- « je souhaiterais quelques précisions sur le Masque LED »

**établi** la caractéristique, citée depuis un article approuvé
**ne pas affirmer** quoi que ce soit qui ne figure pas dans l'article

**Réponse**
>

---

## 17. `produit_ambigu` — we don't know which product they mean
`category: product` · `status: ready`

**serves** PR-25, PR-26

**Phrases client** _(embedded)_
- « J'aimerais avoir des conseils personnalisés pour ma routine svp »
- « je suis une femme de 57 ans et j'ai des poches sous les yeux »

**établi** rien — c'est le point
**ne pas affirmer** un produit choisi parmi plusieurs · faire préciser

**Réponse**
>

---

## 18. `produit_aucune_source` — no approved article covers it
`category: product` · `status: ready`

**serves** any product question the library doesn't cover

> Not a fallback to pad out — this is the reply that keeps the agent honest when
> it has nothing. It should hand over to a human without promising anything.

**établi** rien
**ne pas affirmer** ne rien inventer sur ce point

**Réponse**
>

---

# Compte et paiement

## 19. `compte_mot_de_passe` — password reset / can't log in
`category: account` · `status: ready` · ✅ **the library already answers this at 0.61–0.62**

**serves** A-29

**Phrases client** _(embedded)_
- « je n'arrive pas à réinitialiser mon mot de passe »
- « Impossible de me connecter à mon compte même en changeant le mot de passe »

**Réponse** — write this one first and use it as the template. It's the only
question already retrieving above the answerable bar, so it's the one case where
you can check the whole chain end to end.
>

---

## 20. `facture_demandee` — customer wants an invoice
`category: payment` · `status: ready`

**serves** PA-30

**Phrases client** _(embedded)_
- « Je vous prie de bien vouloir me faire parvenir la facture »
- « Je ne reçois aucune facture de votre laboratoire, pourriez-vous m'indiquer la démarche »

**établi** numéro de commande · procédure de facturation
**Réponse**
>

---

## 21. `paiement_bloque` — can't complete payment / unexpected fees
`category: payment` · `status: ready`

**serves** PA-31, PA-32

**Phrases client** _(embedded)_
- « au moment de payer il y a des frais supplémentaires demandés »
- « Kan geen bestelling plaatsen, is er iets mis ofzo? »

**établi** rien côté paiement — le tunnel n'est pas visible
**ne pas affirmer** la cause du refus
**Réponse**
>

---

# Summary

**21 situations**, of which **17 are `ready`** and **4 are `blocked`** on a
missing tool (3 on the carrier API, 1 on checkout visibility).
Situation 1 needs no reply — the agent already writes that sentence itself.

So there are **16 replies to draft**, covering all 32 questions.

Start with `compte_mot_de_passe` (#19): it's the only one whose retrieval already
works, so it's the one that proves the whole chain before you write the other 15.
