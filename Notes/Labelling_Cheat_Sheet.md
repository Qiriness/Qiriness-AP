# Labelling cheat sheet: how Qiriness support operates

For labelling the multi-turn set (`npm run cases:label`). Built on 2026-09-26 from
the live rulebook: 40 approved situations, 119 approved rules, the shop
parameters and the sender directory. **If a rule changes in `/agent-setup`,
this sheet is out of date; the rulebook wins.**

Lines marked **⚠ to confirm** are my reading of how the desk works, not
something the data states. Correct them once, and every later label follows.

---

## 1. Five rules for every label

1. **Label the moment, not the outcome.** Decide as if the thread stopped at
   this message.
2. **The state fields are the full picture after this message.** « On attend du
   client », the obligations, « Le dossier est » and « La suite revient à » repeat
   everything still open, not just what changed.
3. **The first time a problem needs a person, we still reply**: acknowledge and
   say we're checking. That is how every « person » rule below is written.
   → *Réponse complète*, plus an obligation for whoever checks.
4. **A chase while that check is still open, with nothing new to say** →
   *Aucune réponse : une personne doit agir d'abord* (as labelled on `1e4890dd`).
   If you think the customer needs another holding message, pick *Réponse
   complète* and write « holding » in the note.
5. **Never clear an obligation on an assumption.** Only a message that shows the
   answer clears it.

---

## 2. Who's who

| Sender | Actor | What they do in a case |
|---|---|---|
| `contact@qiriness.com`, and staff replying **to the customer** from a personal mailbox | **Nous (support)** | Answers, asks, closes |
| `@qiriness.com`, `@lap-groupe.com` writing **without** the customer | **Un collègue** | Internal instructions: reshipments, returns, refunds |
| Deret (`deret.fr`), the 3PL warehouse | **Un partenaire** | Stock, dispatch, packing. **Parcel disputes are settled with Deret, not the carrier** (directory note) |
| Colissimo / La Poste | **Un partenaire** | Tracking and carrier disputes |
| Nocibé, Marionnaud, Sephora | (retailer: trade) | Out of scope for the agent; see §5 |
| Dopweb (web agency), Shopify notifications | colleague / platform | Not customer demand |

**Confirmed 2026-09-26:** **refunds, cancellations, reshipments and address
changes before dispatch are done, or started, by Nous (support).** Their
obligation belongs to **Nous**, even when a colleague or Deret carries out part
of the work afterwards. An obligation moves to **Un partenaire** only while we
are waiting on Deret or a carrier for an answer (where a parcel is, what was
packed).

**Deret first, then us, for a reshipment or a refund.** Deret may first need to
confirm where the parcel is, e.g. that a returned parcel has reached the
warehouse, before a reshipment or refund is possible. This applies to late,
lost, not-received and returned parcels. The obligations then run in order:
1. **Un partenaire (Deret)**, `delivery_state` or `return_eligibility`: until
   Deret has confirmed;
2. **Nous (support)**, `refund_state` (or `other_fact` for a reshipment): until
   we have done or started it.

Don't ask Deret again when their confirmation is already in the thread at that
point.

---

## 3. The numbers the rules use

Set in `/agent-setup/parameters`.

| | Value | Decides |
|---|---|---|
| Dispatch | **3 working days** after the order | not shipped and ≤ 3 days = on time; > 3 = overdue, a person acts |
| Delivery after dispatch | **3 working days in France, 6 abroad** | beyond that = late, a person acts |
| Return window | **30 days** after delivery | ≤ 30 = explain the return; > 30 = a person decides |
| Legal withdrawal | 14 days | separate from the return window |
| Refund once a return is approved | **10 working days** | quoted to « when is my refund? » |
| Free delivery | from **70 €** | quoted for unexpected fees |
| Trade threshold | an order > **400 €** is a professional | out of scope for the agent |
| Returns address | 33 Avenue de Wagram, 75017 Paris | quoted in return replies |

**Never tell a customer a product can't be returned.** The Refund policy
template lists « produits de soins personnels », which covers the whole
catalogue; this is a known flaw in the article (DECISIONS).

---

## 4. Situation by situation

**How to read the columns:**
- **Reply now** = *Réponse complète*, with nothing left owed. After our reply,
  « La suite revient à » is **Personne**.
- **Ask** = *Réponse complète* that asks the customer something. After our
  reply: **Le client**.
- **Person** = *Réponse complète* acknowledging and announcing a check, and an
  obligation for its owner. After our reply: **that owner**.

### Order & delivery

| Situation | When | Label |
|---|---|---|
| **We don't know the order** (any order situation) | no order found | **Ask**: order number + purchase email |
| O-09 / D-01 « not shipped yet? » | not shipped, ≤ 3 working days | **Reply now** (on time) |
| | not shipped, > 3 working days | **Person**: partner (Deret), `dispatch_state` |
| | not shipped, **unpaid** | **Person**: support, `payment_state` |
| | order found but state unreadable | **Person**: support, `order_state` |
| D-01 / D-05 « where is my parcel? » | shipped, within 3 (FR) / 6 (abroad) days | **Reply now** (give the date, tracking if held) |
| | shipped, delivery late | **Person**: partner (Deret), `delivery_state` |
| | tracking stopped moving | **Person**: partner (Deret), `delivery_state` |
| D-03 / D-01 « marked delivered, not received » | always | **Person**: partner (Deret dispute), `delivery_state`. Never say they got it |
| D-37 carrier declared it lost | order found | **Person** (Deret): investigation with logisitics before support decides reship or refund, `delivery_state`. Never doubt the customer |
| D-36 « late: refund me or send another » | order found | **Person**: Deret checks the parcel first (`delivery_state`), then support refunds or reships (`refund_state`). The reply answers **both** asks; once options are offered, **Ask** `preferred_remedy` |
| D-02 item missing | no photo | **Ask**: photo |
| | photo attached | **Person**: partner (Deret checks the packing), `other_fact` |
| D-08 wrong item received | product unclear | **Ask**: which product |
| | otherwise | **Person**: partner, `other_fact` |
| D-06 parcel came back to us | always | **Person**: Deret confirms it reached the warehouse (`delivery_state`), then support reships. No date promised; if the address was the problem, **Ask** `postal_address` |
| O-12 wrong address | not shipped | **Person**: support changes it, `dispatch_state` |
| | already shipped | **Ask** what they want (it went to the original address) |
| O-13 cancel | already shipped | **Reply now**: explain the return instead |
| | not shipped | **Person**: support cancels. **⚠** no rule exists for this branch |
| O-14 add an item | not shipped | **Person**: support |
| | shipped | **Reply now**: suggest a new order |
| D-07 « how long does delivery take? » | always | **Reply now**: 3 days to dispatch, then 3 FR / 6 abroad |
| D-33 « do you deliver to my country? » | always | **Person**: support (no approved article; don't guess) |

### Promotions & gifts

| Situation | When | Label |
|---|---|---|
| P-15 newsletter code never arrived | we know the sender | **Reply now**: give the welcome code (the desk sends it; it doesn't diagnose why it didn't arrive) |
| | unknown sender | **Ask**: the email they signed up with |
| P-18 code doesn't work | expired / inactive / not started | **Reply now**: the code can't be used, « not your mistake » |
| | code active but not applying | **Reply now**: explain why (e.g. not cumulative with the sale) |
| | code not found / none quoted | **Ask**: the exact code |
| P-19 promo price not applied | always | **Ask** for details |
| P-20 free samples missing | order found | **Reply now** |
| | order unknown | **Ask**: order number |
| P-21 « any offer on? » | an offer exists for that product | **Reply now** with the code |
| P-22 « was my promo applied? » | yes (gift/discount found) | **Reply now**: say yes, name it |
| | nothing on the order | **Person**: support, `order_promotion` |
| P-17 free gift won't go in the basket | basket found | **Person**: support |
| | basket not visible | **Ask**: purchase email |
| Any commercial gesture | — | **Person**: support. A gesture is a merchant decision, never drafted |

Problem identified and not solved here: For promotions that apply to oders automatically on order, the agent doenst understand this yet. OUr tools are based on discount codes but some are automatic and dont work properly. There will be a tool that is able to check what automatic promotions have been applied, should have been applied and if there is disparity between the two. 

### Returns & refunds

| Situation | When | Label |
|---|---|---|
| R-21 how to return | within 30 days, or unknown | **Reply now**: request the return **first**, then send it to the returns address |
| | past 30 days | **Person**: support decides |
| R-22 who pays return postage? | always | **Person**: support (no approved answer) | if they have accepted the parcel unless otherwise decided the customer pays for postage, if they refuse the parcel then they dont need to pay for it, as it can be returned (this has not been installed yet but you will notice it in some emails)
| R-23 when is my refund? | refund already issued | **Reply now**: say it has gone out |
| | return open, or no refund yet | **Reply now**: the sequence, then 10 working days |
| | order unknown | **Ask**: order number |
| A return or refund is actually **performed** | — | obligation `refund_state`, owner **Nous (support)** |

### Products & stock

| Situation | When | Label |
|---|---|---|
| PR-24 vegan / animal testing | article answers | **Reply now** |
| PR-27 / PR-28 LED mask modes and specs | answered by the product page or article | **Reply now** |
| | not covered | **Person**: support (never invent a spec) |
| | several products match | **Ask**: which product |
| PR-25 / PR-29 routine advice, equivalent of another brand | curated recommendation exists | **Reply now** |
| | nothing curated | **Person**: support |
| | customer gave nothing to go on | **Ask** (skin type, need) |
| PR-26 LED mask won't charge | always | **Person**: support. **⚠** no approved rule yet |
| Any product question with no approved source | — | **Person**: support |
| S-34 out of stock? | in stock / out of stock known | **Reply now** |
| | availability unknown | **Person**: support |
| | product unclear | **Ask**: which product |

### Account & payment

| Situation | When | Label |
|---|---|---|
| A-29 can't log in | active account, or guest with no account | **Reply now** |
| | invited but never activated | **Person**: support |
| | unknown sender | **Ask**: account email |
| A-35 delete my account | known | **Person**: support, always (confirmed against the sender) |
| | unknown | **Ask**: account email |
| PA-30 invoice | order found | **Person**: support (the invoice PDF can't be produced automatically) |
| | order unknown | **Ask**: order number + email |
| PA-31 unexpected fees at checkout | order found | **Person**: support |
| | order unknown | **Ask**: order number |
| PA-32 can't complete payment | always | **Person**: support |

### Skin reactions (cosmetovigilance)

| Situation | When | Label |
|---|---|---|
| CV-01 reaction reported | product not named | **Ask**: which product |
| | product named | **Person**: support |
| CV-02 / CV-04 reaction + refund or compensation | always | **Ask**: product and/or **batch number**, then a person |
| CV-03 « can I use it with my condition? » | always | **Person**: support (no medical advice, ever) |

Nothing here is ever answered automatically: a person always releases the
reply. Never suggest a cause, a diagnosis or a treatment. This will likely be changed to out of scopre in the future so not a big worry

---

## 5. Out of scope: always a person, and the agent doesn't draft

Label these **Person** with « La suite revient à » = **Nous**, or **Un collègue**
where a colleague must act:

- **Level 4**: legal threat, hospitalisation, danger to health;
- **legal / privacy (RGPD)** requests: they leave the agent entirely;
- **trade / B2B**: a retailer (Nocibé, Marionnaud, Sephora) or an order above
  400 €;
- **partnership proposals, job applications**;
- **a thread a colleague opened**: no customer reply is drafted, but its checks
  still count as obligations.

---

## 6. Endings

| Moment | « Ce message » | Dossier | La suite | Pipeline |
|---|---|---|---|---|
| Customer thanks, **we had already closed** | closes_case | Clos par le client | Personne | Aucune réponse (`b781cfba`, `1d38908b`, `d6d0d1c3`) |
| Customer thanks **while we were asking**, or at the end of a complaint | closes_case | Clos par le client if nothing is owed | Nous | Courte réponse de clôture (`cffa55ff`, `9454eaa2`) |
| Customer thanks but **a check is still open** | closes_case | **Ouvert** (business rule, 25 Sept) | the owner of the check | Aucune réponse : une personne doit agir d'abord |
| Our final answer, nothing expected back | closes_case (ours) | Clos par nous | Personne | — |
| Our answer asks something | asks_customer | Ouvert | Le client | — |
| We tell the customer we're checking with Deret | holding + obligation (partner) | Ouvert | Un partenaire opérationnel | — |

---

## 7. Clearing an obligation

| Owner | Cleared by |
|---|---|
| Deret / carrier | their message **answering** the check (parcel found, reshipped, stock confirmed). « On regarde » doesn't count |
| Colleague | their message saying it's done (refund made, reship sent), or our message to the customer stating it |
| Support | our message to the customer giving the answer |
| Any | the case becoming moot: the customer cancels, or the parcel arrives |

---

## 8. When in doubt

Keep it **open**, keep the obligation, pick the safer reply, and write one line
in the note. Notes are how disagreements get settled, and several lines on this
sheet came from notes.
