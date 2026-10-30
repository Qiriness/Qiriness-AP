<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Storefront advisor

### Six languages, built to take more (2026-10-30)

Owner: the Qiriness store publishes « English, Italian, Deutch, German and French » (German and Dutch, confirmed), « also we should add spanish even if its not on the site », and « build it so that this is expandable to more languages if required. If this requires refactoring existing things then please do ». Before this, anything not English fell back to French: the widget's text, the builder's questions and buttons, the cart answers, and the words that read a typed message.

- **One folder per language, `scripts/lib/i18n/<code>/`**, holding three files: `lexicon.mjs` (how customers describe their skin, moved from `advisory/lexicon-fr|en.mjs`), `words.mjs` (every other word the chat reads: yes / no, the cart, orders, references such as « les deux », policy topics, shopping cues, the widget's words) and `messages.mjs` (every sentence the server writes itself). `languages.mjs` registers them. Adding a language means copying a folder, adding one line there and one widget locale file, and running `npm run widget:words`; no code changes. `i18n.test.mjs` fails until every file has every key of the French one, with the same message arguments and the same `{placeholders}`.
- **Every language's words still run on every message**, in registry order (French, English, then the others). Each language-specific pattern was split into its French and English parts and rebuilt from the packs. The rebuilt patterns are byte-identical to the old ones, and eval:advisory, advisor:score and eval:resolution gave the same output before and after. A new language's words must not be everyday words in another language. So Dutch « de » and « en » are no separators or articles (they are French), Spanish « esta » is no article (« mi piel está seca »), Italian « prima » is an ordinal only after its article (alone it means "before"), and Italian « i » is not an article (it is English's "I").
- **Which language the server writes in:** the message's language, then the conversation's, then the storefront's (the site's own setting, owner: « use the language parameters of the website »). A language the chat does not speak gets **English** (owner's choice). With no locale at all, the shop's own language (`SOURCE_LANGUAGE`, French). The model's instructions say the same; before, its fallback was French.
- **The formal « you »** in every language, as the French « vous »: « Lei », « Sie », « u », « usted ». The code's sentences use it, and the model is told to. The owner may prefer « tú » for Spanish when reviewing it.
- **A brand label in a language** is read along a fallback chain (`localized`): the language, then English, then French. The Rules tab gained one column per language (`label_it`, `label_de`, `label_nl`, `label_es`; owner's choice, the spreadsheet stays the master), filled for the 39 rows a customer sees. The routine settings (questions, concern and eye buttons) and the config's labels (`qiriness.json`) have the four languages too. The importer reads `label_<code>` and `name_<code>` for every supported language.
- **German keeps its capitals:** a concern named inside a sentence starts in lower case (« vos rides ») except in German (« ideal bei Falten »). The treat sentence uses a construction without an article in each new language (« in caso di », « bei », « bij », « en caso de »), so it reads right whatever the concern's gender.
- **Letters beyond English.** `norm` turns « ß » into « ss » (it made « weiß » into « wei »). The cart and offer answers use word edges that know accented letters: JavaScript's `\b` sees no edge after « Sì » or « pensaré ». For plain French and English words both behave the same.
- **The widget** gets a locale file per language (Shopify picks the storefront's), and its two word patterns (the cart helper shared with the server, and the order words of the waiting message) are generated from the packs into a marked block (`npm run widget:words`). A test fails while they differ. Numbers in the routine view use the language's decimal mark.
- **The advisory core may import `i18n/`**, which imports nothing outside itself (isolation.test.mjs). Both go together when the core is lifted out for the email agent.
- **Not yet:** product names, descriptions and FAQs are still the French catalogue's in every language (Shopify's translations are not synced). The Italian, German and Dutch texts and words were written without a native speaker's review; the owner reviews the Spanish (VALIDATION_LOG).

### The routine laid out as the prototype: at a glance, then each product once (2026-10-30)

The owner shared a prototype (`qiriness_chatbot_preview.html`): « I like the structure of this little prototype », adapted to our designs. The rules of § « The routine cards » (2026-10-18) and § « tick the serum and the cream first » (2026-10-19) stand. What changes is how the routine is laid out (`RoutineView` in `advisor-panel.js`):

- **A tick belongs to the product, not the moment** (owner, same day: « when i added compléter ma routine for night, it added the eye serum to the night but not the day one … same thing for the lotion hydratante »). This supersedes the per-moment ticks of 2026-10-19. A product is in or out in every moment that uses it; the moments only say when it is applied. A new routine ticks a product when the brand preselects one of its steps in a moment they chose. A product that is only in the other moment is ticked when that moment preselects it. « Compléter ma routine » therefore adds the evening's preselected products that are not already chosen (the night cream), and changes nothing they ticked or unticked. With « jour et nuit », the lotion (preselected in neither moment) now starts unticked; before, it came in through the evening. A choice saved in the old per-moment format is started again.
- **A cleanser or a make-up remover is « Nettoyer »** (owner: « 1st one for night should be Nettoyer »), whatever its sheet stage (the make-up remover is « prepare » there).
- **At a glance (left, or on top when narrow).** Both moments as numbered steps: the stage, the product, its state (« Inclus », « Facultatif », « Déjà le matin », « Indisponible »). Clicking a step row ticks or unticks its product, and a ticked step shows a check instead of its number. « Compléter ma routine » stays under the moment that was not chosen. In the 400 px panel and on a phone, the steps fold under « Voir mes gestes du matin et du soir », so the products come first.
- **Each product once (right).** A product used morning and evening is one card (« Optimiser · Matin & Soir »). It used to be one card per moment. A product ticked at first in the chosen moment is a full card under « Les essentiels pour vous ». The others are small cards under « Compléter mon rituel ». The card's « Inclus » / « Ajouter » ticks or unticks the product in every moment. A product whose moments are not in the routine yet says « Avec la routine du soir » instead of a button. « Pourquoi pour vous ? » opens the reasons and the three folds. A product not included is greyed, but its button is not.
- **The checkout strip, as short as it can be** (owner, same day: « when it first shows up the height is too high »). One row: the count and the discount minimum on the left, the crossed-out total, the price and « Économie » on the right. The add button sits on the same row when the panel is wide and under it, full width, when narrow. It stays sticky at the bottom.
- **The product they are viewing, in the header** (owner, same day, from a screenshot of another brand's chat: « just pic, name and price … dont make the height of this card too high »). On a product page the header opens a little for one short card: a 48 px picture, the name (two lines at most) and the price of the variant chosen on the page, read again each time the panel opens. It comes from the shop's own `/products/<handle>.js`, the same fetch as the routine images. It is not a link, because they are already on that page. Nothing shows on other pages or when the shop does not answer.
- **Typography** (owner's table). Cormorant Garamond: the chat title 25/500 in a softer ink (`#4a443d`; owner: « slightly less black », over the table's 600), section headings 25–30/500, product names 21/500. DM Sans: messages 15/400, descriptions 13–14/400, buttons 12/600, small uppercase labels 11/600. Two places are smaller, so the cards stay short: the small « Compléter mon rituel » cards (18 px names) and the header's product card (18 px). The fonts are theme-editor settings (heading font, body font, fonts stylesheet; Google Fonts by default), so another shop names its own. The loader fetches the stylesheet only once the banner or the panel shows, never on every page view. Before, the widget followed the theme's font variables and loaded no web font.
- **The panel is modernised** (owner: « rounding the edges of the popup, adding a slight shadow, rounding the input box, making it slightly taller »). The panel has 20 px corners and a two-layer shadow. It is 440 px wide and reaches up to just under the shop's header: the widget reads the header's bottom edge (`--sa-top`, read again on resize and scroll), and uses the gap when no header is in view. The composer is a softly rounded field (14 px corners, 40 px input) with no focus outline of its own; the field shows the focus. The send button is a dark rounded square with a white arrow (`.sa-root .sa-send`, because the generic button colour turned the arrow dark on dark). The cards have 14 px corners. On a phone the panel is still a full-screen sheet with square corners.

### Asked to add, the chat asks to confirm; « ajouter svp » is a yes (2026-10-29)

Owner: « When a customer asks to add something to cart, the agent should check do you want to add this product to the cart and then the customer can confirm yes or no or say it ». Also, under « Souhaitez-vous que j'ajoute cette routine à votre panier ? », « ajouter svp » got « je ne peux pas ajouter directement les produits » from the model: only « oui », « ok »… counted as a yes.

- **A request to add** (`asksToAdd`, FR/EN: « ajoutez-la au panier », « je la prends », "add it to my cart", "I'll take it"; never « ne l'ajoutez pas », "remove") is a code turn with no model call. It asks « Souhaitez-vous que j'ajoute X à votre panier ? » with « Oui, ajouter » / « Je cherche encore », even for a product asked about before. The answer, clicked or typed, goes through the existing cart path: one size added, otherwise its page for the size.
- **Which product:** the one named; else the last bubble's card; else the routine it showed, while its ref is in the flow (the routine question and its discount); else the page's product. Several cards and no routine: the model asks which.
- **While the cart question is pending,** add-words are a yes (« ajouter svp », « ajoutez », « mettez-les », « vas-y », "add them", "go ahead"); « ne l'ajoutez pas », « retirez » are a no.

### An exfoliant can be asked for; « une masque » is a mask (2026-10-29)

Owner: « products suggested but not given », on « je cherche aussi une masque exfoliant pour aider avec ma peau grasse, jai aussi des imperfections ». The lexicon read the oily skin and the imperfections but not the type: « exfoliant » was no type a customer could ask for, and the mask needed « un » or « le ». So the engine recommended the Lotion Tonique, and the model named two masks in its text only.

- **« Exfoliant » is a requestable type** through the brand's config: a slot of kind `exfoliant` in `qiriness.json` (the requestable types are the slots' kinds), filled by products typed « Exfoliant ». FR « exfoliant », « gommage », « gommant », « peeling »; EN "exfoliant", "exfoliator", "exfoliating", "scrub", but never "peel", since "my skin peels" is dryness. It is read before the mask: « un masque exfoliant » is an exfoliant.
- **A mask asked for** takes « une », « la », « des », « mon », « ma » too.
- For oily skin with imperfections, the Gommage Grains Wrap Exfolys au Riz comes first: it is the exfoliant that also treats blemishes.

### A signed-in customer opening the chat hears about their favourite product, if it is due (2026-10-29)

Owner: « are they logged in, yes — do they have products in the repurchase window, yes — identify favourite product (prioritise creams, serums, lotions etc. (tissue masks last) then repurchased most, then most recent, most expensive) », and say so after the greeting: « I noticed from your past purchases you really like so and so product, would you like to re-purchase it? ». This is the owner's decision. It relaxes two rules of 2026-10-13 for this one moment: « a purchase is a question, not a fact » and « a consultant offers, never pushes a reorder ». Everything else in the purchase-history rules stands.

- **Signed in** means Shopify's signed id, with purchase history switched on (§ identity from the signature only). The widget asks only when the theme says a customer is signed in, once per tab, **on page load** with the chat still empty, so the message is there when the chat opens (owner, same day: « I waited 3 seconds … this is deterministic so surely it should be rapid »). « Nouvelle conversation » does not ask again.
- **Not again for 30 days once seen** (owner: « a cached functionality … deterministic and instant check »): the widget keeps the time it was shown in an open panel in `localStorage`, per signed-in customer, and makes no request at all within 30 days. It is per device: another browser may show it once more. One fetched while the chat stayed closed does not count as seen.
- **The owner's words** (FR, and EN to match): « Nous avons remarqué que vous aviez déjà apprécié « X ». Cela fait maintenant **N jours** que vous ne l'avez pas commandé. Souhaitez-vous en reprendre ? », the days in bold (the widget renders `**…**` in the advisor's bubbles), with the cart question's « Oui, ajouter » / « Je cherche encore ». The starter buttons are hidden under it.
- **An offer on the product** (owner: « give them the discount, no need to name »): « On a même une promo de 20 % sur ce produit en ce moment », only for an automatic offer (it applies by itself when the product is added; a code would have to be named, and codes are not volunteered) with a percentage or amount off, no minimum and no « buy X ». Its reward only, never its name.
- **The window** (`repurchase_opening` in the routine settings): from the product's interval (measured, else « Durée d'utilisation ») less the larger of 20 % and 14 days (« something like 20 %, or 2 weeks »), to half the interval after it (`window_after_share`; owner, same day: « not forever … like 50 % »): just before they run out counts, and so does a while after. Unlike « running low », any product with an interval qualifies, sheet masks included, since the owner ranks them; never an accessory, a device, a kit or a coffret. Never a free line, a return, or a product no longer sold or out of stock.
- **The favourite:** `type_order` (creams, serums, lotions…, sheet masks last), then bought most often, then most recent, then the dearer.
- **Code, not the model:** the sentence (« en reprendre » since a product's name does not say « le » or « la ») and the product's card. No model call, so no cost and nothing invented.
- **Stored when answered, not when shown:** `/opening` writes nothing (faster, and no conversation for a customer who never opens the chat). The first message sent under it carries `opening: true`; the server makes the message again (the purchase summary is cached 10 minutes, never taken from the browser) and stores it as the new session's first assistant row, with the product pending in the cart question (`context.advisor.flow`). So « Oui », or a typed « oui », adds it, and the model sees what was offered.

### An accessory or a device only when asked for (2026-10-29)

Owner: « Agent should not propose accessories unless explicitly asked », after « products under 40 pounds » got the Gua Sha Quartz Rose (« Accessoire », €22.90, « Petit plaisir » in the sheet). The search tool listed every product a query word reached, accessories included, and the model chose from that list.

- **Asked means:** the message names the kind (« accessoire », « outil », « appareil », « roller », « gua sha », « masque LED »; "tool", "device"…: `accessoryAsk` in the FR and EN lexicons), names the product (the resolver found it), or is sent from its own page.
- **Otherwise the turn holds them back** (`isAccessory`: knowledge type `tool` or `device`): `search_products` skips them, and a card the model lists for one is dropped. This is done in code, not in the prompt, so the model can't override it.
- **The engine never adds one either:** the « petit plaisir » is never an accessory or a device, whatever the sheet's column says. Puffiness no longer gets the roller after the eye care. This reverses the last sentence of the 2026-10-19 rule below; the roller still comes when it is named.

### The chat reads the policies switched on for it, each by its key and purpose (2026-10-20)

Owner: « Can the agent access new politics, I just added a gamme specific one ». It could not: « Parle moi de la gamme temps sublime » got « je ne peux pas vous en dire davantage », because `get_policy` only knew the eight topics `knowledge-topics.mjs` binds to fixed keys. Exposing every active policy was not the answer: five of them (lost parcel, product reaction, defective or missing item, retailer order) are instructions for the support agent (« Appliquer… », « Ne pas appliquer automatiquement… »), and the chat sends those cases to customer service. So **`company_policies.storefront`** (migration 99, off by default, a « Chat boutique » switch in Agent setup → Policies) says which policies the chat may read and quote; the migration switched on the eleven it already read. **Every switched-on policy no topic binds is its own `get_policy` topic, by key**, its name and purpose in the tool's description (the purpose is now read): a new one works on save, within the 5-minute knowledge cache, with no code. Such a policy goes **whole** while it is under 6,000 characters: « Gamme Qiriness » puts each range's name in a paragraph of its own and its text in the next, so the passage choice could keep a name without its text, and a comparison of ranges needs them all. The prompt has the model fetch one before saying it cannot tell more. This supersedes « no schema changes » in § Storefront knowledge adapts existing storage: the switch is the one change, and the support agent ignores it.

### The routine cards tick the serum and the cream first; an unticked card greys (2026-10-19)

Owner: « only the cream and the serum will be selected at first (but all four will show) », the evening's eye serum and cream; « when a product is not inclus it grey out in the same way that the other unselected routine is ». The settings' `preselected` names, per moment, the Routines tab's step numbers ticked at first (`default`: morning 2 Sérum and 4 Crème, evening 3 Contour des yeux and 4 Crème; the eye routine Y: 3 and 4 both times). The engine marks the others `preselected: false`; the cards start them unticked and greyed (`sa-rcard--off`, the not-chosen moment's opacity), and ticking one ungreys it. *Superseded 2026-10-30: the ticks are per product (§ The routine laid out as the prototype).* The ticks are now per moment and product: the evening's « déjà dans votre routine du matin » holds only while the morning's card for it is ticked, else it is an ordinary card (its eye serum, ticked). The chat's « Oui, ajouter » and the routine's cart add only the ticked steps; with « jour et nuit » the eye cream counts once, ticked by the evening. A choice saved before keeps its product-id unticks. No entry in `preselected`: every step ticked, as before.

### An accessory is never the eye care; « poches » gets the eye step's own choice (2026-10-19)

Owner: « autre category should not be prioritised over an actual soin », on « J'ai les poches sous les yeux » answered with the Roller Yeux alone. The roller was the sheet's only « Yeux » product, so it filled the eye step, and the only one made for puffiness. Its type is now « Accessoire » (Products tab G93, the JSON re-imported), so it fills no step. With nothing made for an eye concern (cernes, poches, rides du contour des yeux), the single eye product is the one the Routines tab's eye step would choose, which needs no concern: the range's eye care, else the generic one (« sinon le Sérum Élixir Regard Éclat »). The accessory made for that concern comes after it, as its first alternative, never before. A face concern asked about the eyes (« des taches autour des yeux ») still gets none, said honestly (§ the owner's notes v4). Supersedes « poches → the roller » of the notes v4.

### Redness and irritation are blemishes on a sensitive skin (2026-10-19)

Owner: « rougeur, irritation should trigger imperfections as well as peaux sensibles ». Since 2026-10-16 redness and reactivity are no main concern (the sensitive skin is a skin type), so « J'ai des rougeurs persistantes » got « quelle autre préoccupation ? » and no advice. Now the settings' `concern_also` makes a customer's word count as another standard concern too: `redness` and `irritation` add `blemishes` (B Imperfections), which becomes the main concern, while their own concern (Rules tab: « Type de peau sensible ») keeps the skin sensitive, so the products are never « Déconseillé » and lean to the gentle ones (the gentle cleanser and lotion instead of the purifying ones). « Irritation » is its own lexicon concern (FR « irritée », « irritations »; EN "irritated", "irritation"), mapped to `reactivity`. « Peau sensible » alone adds nothing and still asks its concern. Brand data: another brand leaves `concern_also` empty.

### The owner's notes v4: the offer waits, caution turns, the hands and body, the eyes (2026-10-19)

The owner tested 21 conversations on the dev store (`data/advisor/qiriness-advisor-conversation-notes-v4.xlsx`). Owner's choices: a man gets the same routine with men's products where one exists (already so: `timedKey` ranks them first); the body gets its products now and a body routine later; brand knowledge goes on the to-do list. Each rule is gated as narrowly as it could be; eval:advisory, advisor:score and eval:resolution are unchanged by it.

- **The routine offer waits for the conversation** (« routine builder does not wait for the conversation to finish »; « this doubling of messages »). It is chosen before the model writes, so it landed under the model's own question. Now it is held back, never consumed, when the engine still asks a question (`engineAsks`), and dropped after the model when the reply ends with a question (`endsWithQuestion`): it comes on a later turn. This reverses « the offer had taken its turn » (2026-10-13). A typed « oui » meant for the model's question is no longer read as the offer's.
- **No routine offer after a referral or after nothing** (« should not suggest a routine when we don't even offer a product »): not when the reply sends them to customer service (`contact`) or to a doctor, a dermatologist or a pharmacist (`PROFESSIONAL_WORDS`, FR/EN), not after `no_match`, not under the hands', lips', feet's or body's products (there is no routine for them).
- **A caution turn: no card, no offer, no treat, no buttons** (« medical question, should not provide products as this is misleading »). The lexicons' `caution` key (FR/EN): a treatment they are on, a medicine, a mole, an allergy, a burn, red patches, a reaction, eczema, psoriasis, pregnancy, breastfeeding. Not « rougeurs », « peau sensible », « rosacée » (those get sensitive-skin care), nor a treatment asked for (« un traitement anti-acné », "an acne cream"). The model gets no ADVICE and a CAUTION note; a product the customer asks to see is still shown; the profile reader is skipped. « allergique à X » still records X as avoided.
- **The concern buttons only under the concern question** (« De quelle crème s'agit-il ? » came with the six buttons, and a click gave unrelated products). Outside the builder, the reply must name two of its options or ask about their concern (`asksConcern`, FR/EN); otherwise the buttons are dropped and the question is not counted as asked, so it can come later. The builder's questions are untouched.
- **The hands, lips, feet and body get their own products** (« should prioritise a hand cream over a face cream »; « it should suggest the body lotions, creams or lait »). The lexicons read the zones (« main » alone only after an article: every table reads every message, and "my main concern" is English; « le dos des mains » is the hands) and « sèches », « gercées », "chapped" there as dryness. The engine gives up to three of that area's products for the need: the need as their main concern, among their others, then a concern of the same main concern (dryness and the hand cream's dehydration are both Hydration); daily care before occasional (the hand cream before the hand mask), an « Autre » only when it treats the need itself and last (the shower oil after the body cream and milk), never a kit, a coffret or a device. Nothing there for the need: the routine settings' `area_fallback` (the face's product for dry hands or lips, owner: « the falling back to that cream is fine »), said as such; any other need, nothing, said (spots on the hands). No concern yet: no buttons (they are the face's), the model asks. A « rituel » for the body does not open the face builder; the builder itself ignores a body area said earlier and builds the face routine.
- **The eyes asked about get eye answers** (« SPECIFICALLY asking about eyes, not getting an eye response »). With the eyes and no concern, the concern question has the eye buttons (`questions.eye_concern_buttons`: Cernes, Poches, Rides du contour des yeux, Déshydratation); a face button pressed while the eyes are discussed records its eye version (« Rides » → `eye_wrinkles`); a face concern asked about the eyes gets the eye products for it, else the face's. The routine builder keeps its own buttons and meanings.
- **The marks old spots leave are dark spots** (« should be the crème and serum Éclat Parfait »): « marques / traces / cicatrices (laissées par d'anciens) boutons », « post-acné », "acne scars", "marks left by old spots", read before « boutons », so the Éclat Parfait products come; « boutons » alone stays blemishes. The LED mask is a device and fills no step: it is not offered.
- **« ma crème » is a cream asked for**, as « mon sérum » was a serum; **a type asked for while the concern is still open** (asked and unanswered) gets three examples of that type, one per range first (« it should give more than one example … prioritise the creams or the serums that are in a gamme »). Before the concern is asked, the concern question comes as before.
- **The contact form is truthful and asks for the order number** (« untrue because they have to contact via the contact form which cannot use the chatbot conversation »; « n'oubliez pas de nous partager votre numéro de commande »). The prompt forbids saying the conversation reaches customer service. When the reply carries the contact form and the message is about an order (`ORDER_WORDS`, FR/EN), the code adds « N'oubliez pas d'indiquer votre numéro de commande dans le formulaire. » / "Don't forget to include your order number in the form.", unless the reply already says it.
- **A brand question is answered from the shop's description only** (« Qu'est-ce qui différencie Qiriness ? » got three product names), or since 2026-10-20 from a policy switched on for the chat (§ The chat reads the policies switched on for it): otherwise the model says it cannot tell more here, never with products, never searching for it. Brand knowledge (a Brand History policy, FAQs) is VALIDATION_LOG's open item.

### The routine cards: both moments, the content, the saving (2026-10-18)

The owner's screenshots (« Vos quatre soins », « Votre rituel, matin et soir », « Votre avantage diagnostic »): « when we enter routine mode I would like for the agent chatbot to increase in size … refactor how we present the routines … it should also show the routine day and the routine night even if they didnt select jour et nuit ».

- **Routine mode widens the panel.** The first builder question (and the finished routine) carry `layout: 'routine'`; the widget opens wide once, and the header's expand / collapse button switches it back either way. On a phone the panel is already full screen: no button.
- **Both moments, always.** The engine's `advise()` gives a builder routine its `moments`: the chosen one as built, the other from a « jour et nuit » build of the same answers, so the products agree. The night of a « jour et nuit » build leaves out what the day has; the cards put those steps back, marked « Déjà dans votre routine du matin ». The moment not chosen is greyed with « Compléter ma routine »: its steps already theirs are counted once, the rest join the routine. « They can still have a night routine without buying extra »: when nothing is missing, the card says so.
- **Each card** (`routine-view.mjs`, from the catalogue, never the model): the ritual stage, the image (the shop's own `/products/<handle>.js`, in the browser), name, size, price, stars, « Inclus », « Pourquoi pour vous ? » and three foldable sections: « Ingrédients clés », « Bienfaits », « Application ».
- **« Pourquoi pour vous ? » is code, not the model** (owner's choice): their skin type and the concern the product was chosen for (its own skin and concern reason codes; never a guess), named from the Rules tab, then the product's short description. No model call is added to the builder.
- **The content comes from named metafields only** (`CONTENT_METAFIELDS` in `product-repository.mjs`: Qiriness's Accentuate fields, Shopify's `reviews.*` ratings). Another shop changes that map. The model does not read the new fields.
- **The dev store copies its content from production.** Its products lacked the metafields (3–8 of 51 had them, production all 51). The advisor app has read scopes only, so the dev sync fills the dev store's own Supabase rows from the production row with the same handle (`scripts/dev-store/copy-production-content.mjs`), empty fields only. The advisor still reads only its own catalogue.
- **« Inclus » with a minimum for the discount** (owner's choice). The customer can untick products; the total follows. The routine discount applies from `routine_discount.min_products` (3) or the Shopify code's own minimum, the higher. Below it, the cards say « La remise routine s'applique dès 3 soins » and the button adds the products without the code.
- **The saving, never the code** (owner's choice). The banner says « −20 % sur votre routine, appliqué automatiquement » with an « Ajouter ma routine » button in place of the screenshot's code (owner, 2026-10-19: it was a badge « Automatique »; the button adds the same selection as the footer's); the footer shows the crossed-out total, the discounted one and « Économie ». The percentage comes from the code's synced Shopify rule, read on its own by its code (`createRoutineCodeReader`): private codes' rules stay out of the shopping data the model's tools read. Unknown value: no saving shown, the code still applied.
- **The cart question stays under the cards** (owner, same day, reversing the first version: « the agent should still ask voulez-vous que je l'ajoute à votre panier, rather than proposing the petit plaisir straight away »). Its « Oui » adds what the cards include at that moment: the reply carries the routine's `routine_ref`, and the widget adds the cards' selection, not the server's list. Either answer brings the treat.
- **No model reply above the cards** (owner: « no need for the text reply »). The model's paragraph listed every product again under cards that already say it. The finished routine is a code turn: one sentence (« Voici votre routine personnalisée, matin et soir. »), the cards, the cart question. A routine the model built through `advise` gets the same sentence in place of its text.
- **« Je cherche encore » is a code turn** (owner: « after this cherche encore message it should just propose a petit plaisir not restart on another routine set »). Sent to the model, the answer came back as a paragraph and three product cards from the earlier routine, above the treat. Now: « Très bien, prenez votre temps. » / "Of course, take your time.", then the petit plaisir when one is due, no model call. Only the button or the few words alone count; a longer message (« pas encore, un sérum pour les rides ? ») is a request and goes to the model.
- **A concern named later is the main one** (owner: « the agent is not able to adapt to new concerns and remains focused on the old ones »). Not only « je cherche… » and « ma préoccupation est… »: a question (« que dois-je faire pour des rides », « comment enlever mes taches », "what can I do about wrinkles", "how do I get rid of dark spots") or a concern said with no question pending replaces the main concern, and the earlier care type goes with it. It stays a second concern with « aussi » / "also", or when typed as the answer to another builder question (« peau grasse avec des imperfections » while the skin type is asked). After an eye concern, a new concern with no eye word is the face's (« cernes », then « rides » was read as eye wrinkles), and « visages » / "faces" count as the face. The type alone (« un serum », "a serum", three words at most) answers « sérum ou crème ? »; « un creme » is a cream.
- **Product cards show the product's image**, fetched by the widget from the shop's `/products/<handle>.js`, as the routine cards do (the server sends none). Only for same-shop links.
- **A range names a product even when its title does not say it** (owner, 2026-10-19: « the comparison flow seems to not work properly »). « la crème contour des yeux Temps Sublime » asked to choose between three face creams: the eye cream's title is « Crème Contour des Yeux Anti-âge - Caresse Regard Sublime », without « Temps », and a product had to carry every name word in its title. The product knowledge's `range` column now counts as part of the name when matching (`buildResolutionIndex(…, { ranges })`), never when learning the vocabulary. The shop has no range collections to use instead (checked on the live catalogue). In the same flow, « la Caresse Temps Sublime Riche et la Light »: a short second mention with one name word borrows the line just named (« Temps Sublime Light »); alone, « la light » stays plain words.
- **No routine offer while a « which one? » question is asked.** One product named and one to choose showed « Souhaitez-vous que je vous construise une routine ? » under « laquelle souhaitez-vous comparer ? ». The offer waits until the products are settled.
- **The treat after a routine names their concern** (owner, 2026-10-19): « Et pour un moment de douceur, parfait pour atténuer vos imperfections, ce petit plaisir pourrait vous plaire : » / "…perfect for easing your dark spots…". The concern's name is the brand's label (Rules tab), « vos » before a plural, « votre » otherwise; no concern known, the plain sentence.
- **Product cards: the name, the image and a magnifier open the product page** (owner, 2026-10-19: « remove découvrir and add it as a search icon in the top right »). The name is the one link in the tab order; the image and the icon are extra ways in for a pointer.
- **One product for a concern treats that concern.** « Est-ce que vous avez un sérum pour les taches » got an anti-fatigue serum (the spot serum out of stock; the other counted through its range's concerns), then « je ne trouve pas » three times. Now, outside the builder, a single product is picked among those whose own concerns include theirs when any exist. When the type asked for has none in stock, the best product of another type that treats it is given, and the reply names what is out of stock (`asked_type`, reason `asked_type_unavailable`). A routine keeps its foundation rules.
- **The type asked for breaks a foundation tie** (« je veux une crème pour les taches » right after a routine for wrinkles: « rides » stays a second concern, the brand's order chose the anti-wrinkle cream). Only for one product of a named type; a routine keeps the brand's order (§ 3.1). « je veux », « avez-vous », "is there", "have you got" now read as asking for a product, so the type is read.
- **The answer to « laquelle ? » keeps what was found beside it** (owner: « to compare the agent must get both products »). « Sérum Temps Sublime ou Élixir Temps Sublime ? » answered dropped the Exception serum already found, and the label « Sérum Temps Sublime » typed back was both serums again, so the question looped. Now the clarification remembers the products settled with it and its labels: a chip or a label typed back resolves the option plus those products. A label is never one another option's title also contains (the full title instead). When the model calls `resolve_products` again in its own words after the answer, the answer settles it. No routine offer under a « laquelle ? » the model asked through its own call.
- **A routine or ritual asked for starts the builder, FR and EN** (owner, 2026-10-19: « for English as well routine, ritual etc. should trigger the routine builder »): a verb of asking then the word (« je veux une routine », « proposez-moi un rituel », "I'd like a routine", "suggest a ritual", "I need a new regimen"), lexicon `routineAsk`. A routine described (« ma routine actuelle est… », "my routine is…") does not.
- **The model opens the routine builder only when the customer talks about a routine**, and then from the first question (owner, 2026-10-19). "What spa treatments would you recommend", after a routine, showed that routine again: the model called `use_skill` on its own (no routine word in the message), and opening the builder kept every earlier answer, so the routine came back finished. Now `use_skill routine_builder` is refused unless the message names a routine (lexicon `routineWord`, FR/EN: « routine », « rituel », « du matin au soir », "regimen", "morning to night"…); the model then answers the question. Opened after a routine or once its questions were asked, it restarts as the « Construire ma routine » button does.
- **A routine banner across the bottom of the screen** (owner, 2026-10-19: « Construisez votre routine personnalisée pour une offre exclusive », a button that opens the chat and starts the routine builder, an × to close it). Drawn by the loader, so it costs no panel download; it slides up 1.2 s after the page loads. The button opens the panel and runs the « Construire ma routine » quick action (in a conversation already under way too). The × or the button hides it for 4 hours in this browser (owner, 2026-10-19: was 7 days; localStorage; theme setting 1–72 hours); without storage it simply comes back. Hidden while the panel is open; the launcher sits above it. Its text and button label are the locale's (FR/EN) unless the theme editor overrides them, so another shop words its own offer; it can be switched off there.
- **The cards stay live after an add** (owner: « if they accidentally clear their cart they cannot re-add it … should still be able to select and unselect products even after adding »). The button adds as often as asked: what the routine includes now and the cart (`/cart.js`) lacks, so nothing is added twice and a cleared cart is filled again; the discount from the minimum on. Unticking never removes from the cart.
- **A routine product's size is chosen for them** (owner: « between normale and riche, normale should have been chosen »). Three products have several variants (Normale / Riche / Légère; Crème / Recharge). The texture their skin type calls for comes from the Rules tab (dry → rich, normal → standard, combination and oily → light), found in the variant's name by `variant_choice` words in the routine settings; without a skin type or a match, the default (standard); a refill never while the jar exists. Nothing matches uniquely: no choice, « Choisissez la taille sur sa page ». Single-product cards outside a routine still leave the size to the customer. The card shows the chosen variant's name and price.
- **« Refaire ma routine » starts over** (owner: « the agent just returns the routine rather than restarting the questionnaire »). The builder asked for again once its questions were asked (the quick action, « refaire / recommencer ma routine », « nouvelle routine », "redo my routine", "new routine") drops the builder's answers and starts at the first question, a code turn; its treat and cart question come again. What the same message says still counts.
- **The « petit plaisir » is a mask, a sheet mask or a kit, nothing else** (owner: « petit plaisir is only mask, masque tissu and kits »). `treats.types` in the routine settings decides, over the sheet's « Petit plaisir » column, for every treat (after a routine, after a « Non », a small budget), still under `treats.max_price` (25 €). Out: the patches (Flash Patch®, Hyal-Éclat), the gua sha, the facial sauna, the bath stones, the body coffret. This reverses « the cream mask is not a treat » (2026-10-14); under 25 € only the Terre d'Orient clay mask qualifies. No `types`: the column decides, as before.
- **Starting over forgets the care type too** (owner: « when restarting the routine the old routine version happens »). A « sérum » said before « refaire ma routine » survived the restart and turned the new routine into « quel type de soin souhaitez-vous privilégier ? » with two cards. The restart drops what limits a search to one product (the care type, a targeted scope) with the builder's answers.
- **A new concern asked for is the main one** (owner: « if the user has previously chosen or mentioned a concern, but then later mentions they are looking for a product for another concern, the agent should look for that concern »). « je cherche un produit pour les rides », « ma préoccupation, ce sont mes rides », "I'm looking for something for wrinkles", "my main concern is wrinkles" replace the main concern (an explicit answer, over a button's); a care type said earlier for the old need is dropped unless the same message names one. « j'ai aussi des rides » stays a second concern.
- **One product for a need: the concern first, the skin type ranks** (owner: « skin type is not a priority, the concern is; skin type helps narrow down between multiple products »). When nothing for the need suits their skin type, the products for the need still count, ranked lower and marked `skin_type_mismatch`; sensitivity and avoided ingredients stay hard. A routine keeps the skin type hard. On today's sheet no need is blocked by skin type alone: the live miss (wrinkles, oily skin, « je ne trouve pas de sérum adapté ») came from the old concern and the old « sérum », both fixed above; the search now gives the Élixir Temps Sublime serum.
- **Wide, each side keeps its column.** In the wide panel a bubble is at most 68 % (620 px) of the width, theirs on the right, ours on the left; the routine cards and product cards take the full width (owner: « the width doesn't adapt to the expanded version »): two or three product cards share it, up to 300 px each, more scroll, their text still in our column. A « Nouvelle conversation » button in the header starts a fresh session.

### The routine reply, its treat and the routine discount (2026-10-17)

The owner's notes on the first routines (`data/advisor/qiriness-advisor-conversation-notes-v2.xlsx`).

- **No prices in a routine** (« remove the prices and dont talk about them in the text, this are obvious on the product cards »). The day / night buttons have no price, the advice the model reads has no `total_price` and no step price. A budget is the exception: `total_price` is still given with a budget, a « trop cher » alternative or a budget treat, where the price is the point.
- **Why a product suits them: their skin type and their concern only** (« not tranche d'age »). The model reads only those reason codes (`SPOKEN_REASONS` in `advisor-tools.mjs`). The age range, the line, the moment and the step's own product still choose the products, and stay in the trace and the events.
- **Each step is named by its ritual stage** (Products tab « Étape du rituel »: Préparer, Activer, Optimiser, Régénérer), in the customer's language. The owner wrote « traiter »; the sheet's value is « Activer », and the sheet is what is read. A product without a stage is named by its type.
- **The treat fits them** (« this also needs to be adapted to the concerns and type of skin »; an anti-blemish patch followed an anti-age routine for dry skin). It must treat one of their concerns (the eye routine's other eye concern too) and suit their skin (not « Non adapté », not « Déconseillé » for sensitive skin, no exclusion). Its area is the routine's: the eyes after the eye routine, the face or the eyes otherwise, never the body. None fits: no treat.
- **The routine discount** (« add to basket … and at the same time apply the promotional code (MAROUTINE20) … NO need to name it … only apply code to basket if the routine has been completed »). The code is brand data (`routine_discount` in the routine settings) and must exist in Shopify. It comes only with a routine the builder finished:
  - the cart question says « Votre remise routine s'y appliquera automatiquement », button « Oui, ajouter avec la remise »; the routine button reads « Ajouter la routine au panier avec la remise »;
  - the widget adds the products, then the code with the shop's `/cart/update.js` `discount` (Shopify, 2025-05). That call sets the cart's codes, so the codes already in the cart are read from `/cart.js` and kept;
  - the model never sees the code. The prompt tells it the discount is applied to the basket and, asked about it, to invite the customer to check their basket. The shopping data says « remise routine » in its place (`hideCodes`), and the reply backstop removes the code whoever wrote it. A customer who types the code themselves gets it named back like any other code (owner: « thats fine if the customer types it »): typed in the conversation, it is no longer hidden.

### The eye routine, every question asked, the answers kept (2026-10-17)

The owner's changes after reading the questions back: « Replace Teint terne with Tache et Teint Terne, Add Cernes et Poches. Remove je ne sais pas, and … dont skip question 3 », and « we need to save the data from these answers (personalised routine ID number, answer to four questions, dont save customer name) ».

- **Question 1's buttons are the settings'** (`questions.concern_buttons`, one per main concern): label FR/EN and the value recorded. « Taches et teint terne » records `dark_spots+dullness`: dull complexion the main concern, dark spots the other (the last of a chip's values is the main one, `mergeProfile`).
- **Every question is asked** (`questions.ask_all`), even when its answer does not change the routine: the age for hydration too. The answers are statistics now, so a skipped one is a hole in the data. Supersedes « asked only when its answer changes the routine » of 2026-10-16. The skin type has no « Je ne sais pas » in the day / night routine.
- **The eye routine is a main concern, Y « Cernes et poches »** (Rules tab), not the eyes module: « Cernes », « Poches », « Rides du contour des yeux » lead to it. Its steps are its own, on the Routines tab (column « Préoccupation principale » = Y), so the common steps are untouched. In the settings it is `area: eyes` (sensitive area, no skin type) with its own question order: the main concern, **another concern around the eyes** (« Rides ou ridules », « Déshydratation », « Taches »: `eye_concern`; no « Aucune autre », owner: one of the three), the age, the moment. The eye concern counts only once the eye routine is chosen: « Déshydratation » there is no vote for Hydration. Outside the builder « mes cernes » is still one eye product (the old eyes module path).
- **Steps with a fixed product** (Routines tab column « Produit », « Choisi par » = Produit): the owner named every eye step's product. The day: the cleanser, « Lotion Tonique Hydratante Éclat Parfait » (owner, in place of the micellar water first proposed), the gold eye patches, the « Sérum Élixir Regard Éclat », the eye cream. The night: the « Démaquillant Yeux Biphase », the same lotion, the eye serum, the eye cream. Both: the day, then the night's eye make-up remover (the rest is already in the day). A fixed product is never dropped for its moment (« Soir », « Matin »).
- **The eye cream: by range, for their concern, else the standard one.** « Choisi par » Gamme, Préoccupation with a « Produit »: the eye cream of their age's range, only if it treats one of their concerns, else « Caresse Regard Énergie » (owner: « if none fit »). Today: Regard d'Exception at 45+ for wrinkles or dehydration; Temps Sublime's eye cream at 25–44 for wrinkles only; everything else the standard one (no eye cream treats dark spots). Imperfections' range « Éclat Parfait » (Rules tab, 2026-10-17) is intended (owner).
- **No model call between the questions.** A button answer, « Oui » to the routine offer or the routine quick action gets the next question in its own sentence (`questions.text`, FR and EN) with its buttons (`trace.model_skipped = builder_question`). A typed answer still goes to the model: it may need answering, and the lexicon fills `eye_concern` from it. The finished routine is still one model call: the explanation.
- **The routine is kept, anonymously** (`advisor_routines`, migration 98, `routine-record.mjs`): the routine number (`id`), the answers as codes with how each was given, the products and total, and when it was added to the cart. No customer, no session, no words; an age said in years is kept as its range. The products are kept, not only the answers: the same four answers can give another routine (the product they came for, their purchases, stock, a budget, exclusions). « Added to the cart » goes through the routine's `ref`, carried in the chat flow (the log keeps it only for the session's retention) and in « Ajouter la routine au panier »'s beacon, so no session id is stored with the row.

### The routine is a day routine, a night routine, or both (2026-10-16)

The owner's model, replacing the foundations' sizes and their required / optional steps in the builder: « we ask major concern, then we ask skin type… Then we ask for age. Instead of complete routine we ask routine jour, nuit or both ». The steps are the Routines tab (one row per step, `Jour` or `Nuit`); the main concerns, the age ranges and the moments are the Rules tab. `foundations.mjs` (`timed`), `routine-knowledge.mjs`, `assemble-routines.mjs`.

- **The questions, in order:** the main concern (A Hydratation, B Imperfections, D Éclat, E Anti-âge, F Fermeté et lift), the skin type (sèche, normale, mixte, grasse, sensible), the age (moins de 25, 25–34, 35–44, 45+), then day, night or both, each with its price. A question is still asked only when its answer changes the routine: the age is asked for anti-age only (hydration, 2026-10-16: straight from the skin type to the moment). *Superseded 2026-10-17: every question is asked, and Y « Cernes et poches » is a sixth main concern (§ The eye routine, every question asked, the answers kept).* An age said in words (« j'ai 32 ans », "I'm 52") answers it. No size, no « what do you already use »: the routine is always the day, the night or both (owner).
- **Sensitive and oily skin are skin types, not concerns** (owner): foundations C (Peaux sensibles), G (Peaux grasses) and H (Routine de base: « it defeats the point of a personalised routine ») are gone. « Excès de sébum » and « Pores dilatés » go to B Imperfections; « Rougeurs », « Inconfort », « Réactivité » lead to the sensitive skin type (`Type de peau sensible`): the sensitive column of the Products tab decides and « Déconseillé » is never used.
- **Four products a routine.** Day: a cleanser or a lotion, the serum, the eye care, the cream. Night: a make-up remover (the eye make-up remover only on request: its area is the eyes), a lotion, the eye care, the cream. Both: the day, then the night without a product the day already has (`also_in_day_routine`): the lotion when the day took one, the eye care, the cream unless the range has a night one (Temps Sublime's crème nuit). On the sheet: Temps Sublime at 35–44, dry skin, is six products; Exception at 45+ is five.
- **Each step's product by its criteria, the first deciding first** (`Choisi par`): the cleanser or lotion, the make-up remover and the night lotion by skin type then concern (owner: « the opposite of the creams »), a tie to the lotion (owner: « if it cannot be differentiated, pick lotion »: the first type of the cell); the serum by range then concern; the cream by range, concern, (night: moment), skin type with the texture of the Rules tab (rich for dry, light for oily and combination); the eye care by « Gamme ou générique ». Then the price.
- **The range:** the main concern's (Source d'Eau, Éclat Parfait; none for Imperfections), or by age for anti-age (owner: Active Énergie under 25, Temps Sublime 25–44, Exception 45+, « longevity »; « wrinkles + under 25 is likely first signs of ageing »). The serum's range then carries to the eye care and the cream (owner: « The serum and creme unless impossible should pretty much always match »). The two anti-age main concerns (E, F) are one family: the age chooses the range, not « Rides » versus « Ridules » (without it, fine lines at 45 got Active Énergie, whose serum alone is tagged « Ridules »).
- **The eye care:** the range's own (Temps Sublime's eye cream, Active Énergie's, Exception's « Regard d'Exception », owner: Exception gives the eye cream, not a serum), else the eye product with no range, the « Sérum Élixir Regard Éclat ». The owner retyped the eye products as « Sérum » or « Crème » with the area « Yeux »; the step takes both.
- **Moment:** never outside it (a « Soir » product is not in the day, a « Matin » one not at night); at night the range's night version first. Only the range's: with no range, the only night cream (Temps Sublime's, anti-age) came first for blemishes.
- **Never pad stays where it matters:** the serum must treat the need (`Vide si aucun produit pour la préoccupation`), so Imperfections has no serum today (no serum in the sheet targets it). The other steps always take the best suited product, even when none targets the concern.
- **Kept:** the modules (not added to the routines, owner: « keep the optional modules for now just in case »); one product for one need outside the builder (the day types, the serum first, else the first that treats it: the purifying lotion for blemishes); « trop cher », the budget ceiling (the serum last), the treats, men's products only for a man, exclusions.
- **Cards:** a routine shows every step's card, in order (four to seven); the cap of three stays for everything else.
- **The invented bench keeps the foundations' sizes** (`data/advisor/sample-routines/`, `advisor:score`): the engine runs the day / night routine when the routines carry `routine_steps`.

### The knowledge spreadsheet is live (2026-10-16)

The owner's go-ahead (« you can make the spreadsheet live ») after the first dev-store test, where the widget still ran the playbooks: the hand cream's « Adapté » for sensitive skin was never read, and no routine had a cleanser.

- **In Supabase, one version per load** (`advisor_knowledge`, migration 97): the products as the rules keep them, by handle, and the routines assembled for the engine. One `active` per shop; a load archives the previous one, so a load can be compared or rolled back. Not a file read at runtime: the deployed dashboard has no repo files, and every other advisor table is in the database too.
- **`npm run advisor:load` writes it**, with the config, from `<brand>-knowledge.json` (the transcription) and `<brand>-routine-settings.json`. An error in the sheet writes nothing; a warning is printed and stored with the version.
- **What the sheet does not carry is brand data in the settings file**, never code: which steps must treat the concern (`targets`; PROPOSED from the bench: A, D, E, F the serum; B the cleanser and lotion; C the cream and serum; G the cleanser and exfoliant), the skin types that pick a foundation, tolerance first (C), the basic routine (H), the customer's words → the standard concerns, the priority, the questions, the treats. Qiriness to confirm.
- **A range is matched as the products spell it** (« Source d'Eau » on the Routines tab, « Source d’Eau » on the Products tab); a preferred range on no product is a warning (B's cell is a description: « Soin Bonne Mine + Patch + Exfoliant »).
- **The service reads the active version with the config** (one row, about 60 KB, with each 5-minute agent rebuild); the engine is the foundations and the agent gets the same product knowledge. No version, or a failed read: the playbooks, as before.

### The knowledge spreadsheet is imported as a transcription (2026-10-15)

- **The spreadsheet is the master; git holds its transcription.** `npm run advisor:import` writes every cell as typed into `data/advisor/<brand>-knowledge.json`, with each row's line in the spreadsheet. Nobody edits the JSON: a correction is made in the spreadsheet and imported again, so it shows as a diff.
- **The rules apply when the file is read, not when it is written.** The transcription keeps rejected and unapproved rows; the report says what the advisor would keep, what is still « À valider », and what is rejected and why. A rule that changes later applies to the same file without a new import.
- **Python reads the spreadsheet** (openpyxl, already used for the template); no Excel library in the Node project.
- **The tabs must agree, and a disagreement is said, not resolved:** a concern the Rules tab sends to a foundation must be one of that foundation's main concerns on the Routines tab, under the same name.

### A card only for a product new to the conversation (2026-10-16)

The owner's rule, « good for now, may change later ». The first dev-store test showed the same night cream's card on five replies, including an offer answer and after it was in the cart.

- **A card is shown for a product newly proposed this turn**, never for one already shown in this conversation (the links each earlier reply stored) or already in the cart (the widget's cart lines), and **none on a policy or offer answer**.
- **Unless the customer asks to see it** (« montrez », « voir », « le lien », "show me", "link").
- **A routine keeps all its cards**, shown before or not (owner, same day), even a routine of one step in the builder: they are the recommendation, with its « Ajouter la routine au panier ».
- The conversation's memory (`refs`) still holds every product the reply was about, shown or not, so « les deux » keeps working. `newCardsOnly` in `llm-agent.mjs`.

### A product's approved FAQ is read by the code, not left to the model (2026-10-16)

The LED mask's approved FAQ answers « ne se recharge pas » and « combien de séances » (3 to 4 sessions of 10 minutes); in the first dev-store test the reply said it had no instructions. The model never called `get_product_policy`, which the prompt keeps as a second path.

- **Read before the model** when one product is in focus: the one resolved this turn, else the page's, else the one just discussed when the message names none. Not in the routine builder, not on a policy or offer question, not during a « which product? » clarification.
- **And with `get_product`**: its result carries `approved_guidance`, once per turn.
- **Whole, not matched first**: the customer's spelling defeats the keyword matcher (« reachrge », « se seance » matched none of the 12 entries), so the entries go most relevant first, capped as the tool's digest. The model is told to answer only from an entry that addresses the question and never to quote a 【placeholder】.
- **Cost:** one small read per product in focus, cached 5 minutes per product.
- **The product's Shopify FAQ too (2026-10-29).** Until then only the dashboard-approved guidance went whole; Shopify's FAQ got the single-question matcher alone, so « combien de fois par semaine » missed « À quelle fréquence utiliser les patchs yeux ? » and the reply said the frequency was not given. The Shopify entries now join the same digest, ahead of the approved guidance. Cost: up to 6,000 characters on most product turns, since 55 of 123 products have a Shopify FAQ and none needed a read before.
- **And with `resolve_products`** when the model resolves exactly one product: « et pour caresse jour et nuit » was resolved there, never read with `get_product`, and the reply said no age was given (the FAQ says 25).
- **Dev store:** its products carry almost no Shopify FAQ (3 of 109), so each takes the dashboard product's FAQ by handle (`withDashboardFaqs` in `storefront-chat-service.ts`).

### Purchase history: identity from the signature only (2026-10-13)

Purchase history (plan § 5) needs to know who is asking. Phase 0 settles who, and what may be read; nothing is read yet. Approved by the owner on 2026-10-13 when Phase 0 was started.

- **Identity is Shopify's signed `logged_in_customer_id`, and nothing else.** The app proxy adds it to the query it signs, and the route already verifies that signature. An email, an order number or the widget's `loggedIn` flag proves nothing: anyone can type someone else's. Not signed in means the anonymous advisor.
- **Off by default.** Unless `STOREFRONT_CHAT_PURCHASE_HISTORY=on`, every request is anonymous and the id goes no further than `customer-identity.mjs`. The same reason as `STOREFRONT_CHAT_AGENT`: the production dashboard carries this route, and a deploy must never start reading purchases on its own.
- **The id is never stored.** A conversation is bound to its customer by an HMAC of shop + id keyed with the app secret (`context.identity` on the assistant row, where the profile already lives, so no migration). A plain hash would not do: Shopify ids are sequential, so trying every id reverses it.
- **One conversation, one person.** A customer's session is continued only by that customer. Another account, or the same tab after signing out, gets a new session, so one person's purchases never reach the next person on a shared device. An anonymous conversation may be continued after signing in, because it holds nobody's purchases. The widget applies the same rule to the bubbles it keeps in `sessionStorage` (the theme's `customer.id`, on that customer's own page).
- **The rule « the agent never reads customers or orders » becomes « it reads only the signed-in customer's own purchase summary, through one narrow typed function ».** Still no SQL, and no other customer. `data-access.test.mjs` fails if any storefront file but the future `purchase-summary-repository.mjs` names the customer or order tables.
- **What the model may see is a shape, not a query.** `toPurchaseSummary` keeps product id, title, first and last purchase day, how many orders held it, returned and free-gift flags, and drops everything else. Addresses, emails, names, order numbers and amounts paid can never leave, even if a reader returns them. A €0 line is a promotional gift (about half of Wrap lines), never a preference.
- **Before anything was read** (done with Phase 1): each read is logged in `data_access_events`, the use is stated in `MERCHANT_DATA_USE_DISCLOSURE.md`, and marketplace orders are excluded. The shop's own privacy notice is the owner's to review.

### A slow reply says something, worded from the question (2026-10-14)

Measured on the customer batch (43 turns, live model): median 3.7 s, 90 % within 5.1 s; a turn where the model calls a tool takes about 1–1.5 s more. Streaming the reply was considered and set aside for now: the widget calls through the Shopify app proxy (which proves the signed-in customer) and it is not yet tested whether the proxy passes a streamed response through; the reply is also one JSON object, checked once complete.

- **What the widget does instead:** after 1.5 s without a reply the dots get « Je regarde ça pour vous… » / "Looking into it for you…" (« Je vérifie votre commande… » / "Checking your order…" when the message names an order, a parcel or an order number), and after 6 s « Encore un instant… » / "Just a moment more…". Code-written turns (under 0.1 s) never show it.
- **Worded from the customer's message, never from the server's work:** the widget only hears back once the whole answer is ready, so it cannot know whether a tool runs; a line that claimed one could be untrue. The texts are theme locale strings (FR, EN).
- **Next, if the proxy streams** (to test on the dev store): stream the reply's text, then the cards and buttons at the end.

### Adding to the cart: the customer's click, never the model's (2026-10-13)

The owner's design: « Ajouter la routine au panier » under a routine, and « Souhaitez-vous que je l'ajoute à votre panier ? » with « Oui, ajouter » / « Je cherche encore ».

- **The server never holds the customer's cart** (it lives in their browser session), so nothing is added server-side and the model has no cart tool. The widget adds, through the shop's `/cart/add.js`, on the customer's click only: the routine button, a card's button, or « Oui, ajouter » (then the reply carries `cart.add` and the widget adds it once, never on a re-render). Every add is recorded as `added_to_cart`.
- **Only products with one size to buy are added**; the others are named with « choisissez la taille sur sa page », since the size is the customer's choice.
- **The question is the code's** (routine-flow.mjs), like the routine offer: after a recommended routine (in place of the treat, which follows the answer) and after a single product once the routine offer has had its turn, never twice for the same product, never after top choices (« this » would be ambiguous). A typed « oui » or « je cherche encore » answers it, on the next turn only: a question passed over is dropped (2026-10-16, dev store: left pending, a « oui » four turns later to the model's own question added the retinol cream the customer had just excluded). « Oui, ajouter » is a code-written turn with no model call. If the model builds the routine itself during its turn (through `advise`), the question is added after its reply.

### The routine engine follows the foundations (2026-10-13)

> In the builder, Qiriness's routine is now the day / night routine (« The routine is a day routine, a night routine, or both », 2026-10-16): no sizes, no required or optional steps, no products already used, no C, G or H. What follows still holds for one product outside the builder, the budget and « trop cher », and for the invented bench.

The owner's model (plan § 3.1–3.4): a routine is a foundation's ordered list of product TYPES, each step filled by the product of that type that best targets the customer's concern or combination of concerns. `scripts/lib/advisory/foundations.mjs`.

- **Everything is data**: the brand's routines (foundations, sizes, modules, the concern map, the question order, treats) and its product knowledge (type, concerns, skin types, texture, sensitivity, men, premium, treat, gift, kit). No Shopify tag decides a product's fit.
- **Side by side** (owner): `createAdvisor` uses the foundations when a shop has routines and product knowledge, the playbooks otherwise. Qiriness runs the foundations since 2026-10-16 (« The knowledge spreadsheet is live » below); a shop with no knowledge loaded keeps the playbooks.
- **The foundation:** a concern chosen with a button decides. Otherwise each concern votes for its foundation and a tie goes to `foundation_priority` (proposed C, F, E, B, G, A, D; Qiriness to confirm). A skin type picks the foundation that names it (`skin_types`: dry → A Hydration, oily → G Oily skin, owner 2026-10-14) only when no concern is there, and stands for that foundation's concern. « Excès de sébum » and « Pores dilatés » belong to G, not B (owner, 2026-10-14). Eye concerns alone are the eyes module; the basic routine (the foundation marked `only_on_explicit_request`, H in Qiriness's sheet) only on « routine de base ».
- **Sizes are rules over the list:** essential = the daily required steps; complete = every daily step plus the relevant modules (eyes for an eye concern; SPF in Taches); spa adds the occasional steps; targeted is one (the type asked for, else the step that targets the concern). A small budget is essential, with no treat.
- **An owned type is not doubled** (owner): « j'utilise déjà un nettoyant » skips the cleanser step, unless that step is the one their concern needs (`targets: primary`): « j'ai un sérum hydratant mais des taches » still gets the anti-spot serum, with `concern_needs_specific_product` so the reply says why.
- **A required step with no product is replaced** by the foundation's next optional step that has one, without asking (owner, 2026-10-16: imperfections with a cleanser and a cream owned got « nothing to add » while the patch was there). One for one, in the foundation's order, never in « un soin ciblé »; the step carries `replaces_missing_step` and the reply presents it as part of the routine.
- **Hard rules before the score:** stock, « Ne pas conseiller », type and area, men's products only for a man, skin « Non adapté », « Déconseillé » for sensitive skin, the customer's exclusions, and a concern step needs a product that targets the concern (never pad). **The score:** the primary concern, the secondary ones, skin « Idéal », « Idéal » for sensitive skin when the customer's is (owner, 2026-10-15), texture by skin type, the preferred range, premium only when a concern justifies it, men's first for a man, the customer's range.
- **§ 3.4:** « cadeau » gives gift sets first, « soirée spa » the spa treat routine, both new profile `request` values read by the lexicon (FR/EN).
- **Budget** (owner, 2026-10-13, replacing the plan's « small budget: no upsell »):
  - a small budget, said either way (« petit budget », « pas cher », or « c'est trop cher », « vous avez moins cher ? », "too expensive", "can't afford"), gets a « petit plaisir » for their concern INSTEAD of a routine, because treats are usually cheaper; no routine offer and no second treat after it;
  - a ceiling (« moins de 60 € », « 40 euros max », "under 60"; a number under 5 or followed by « ans », « produits », « étapes » is not a price) cuts the routine to fit: optional steps first, then the required ones that are not the concern's step, the concern's step last; what was left out is said (`over_budget`), and when even that step is over, a treat within the ceiling;
  - with a budget, the cheaper of two products within 0.15 of the best fit;
  - the routine's price (`total_price`) and each size's price on its button come from the engine; the model quotes them, never adds them up.
- **Outside the builder, a need gets our top choices** (owner, 2026-10-13): the best product of each type that targets that need (dehydration: a serum, a cream, a lotion), up to three, each presented with why; never a cleanser unless the foundation says it treats the need (Imperfections). A type they asked for (« juste un sérum ») keeps its own alternatives. The builder never shows top choices: it builds the routine.
- **« Trop cher » just after one product** (owner, 2026-10-13; widened 2026-10-16), `playbook cheaper`, in order: (1) the same type, passing the same hard rules, for the MAIN need (`cheaper_alternative`); (2) a coffret or kit for that need (`cheaper_bundle`; owner: « it should be able to offer a kit »); (3) the same type, suitable for them but not for that need (`cheaper_generic`; owner: « if there are no options… suggest a generic one »), and the reply says it is not specific to their concern; only when none, the « petit plaisir ». Each costs at most 90 % of the first product (`CHEAPER_RATIO`) and is never premium unless their concern justifies it: on the real catalogue the Caresse d'Exception at €96.90 was offered for « trop cher » on the €98.50 night cream; now it is the Temps Sublime coffret at €60.83. A side concern of the first product never counts as their need (in a test, a radiance serum « matched » a hydrating serum's « ridules »). In the builder the budget rules above stay.
- **From the customer batch (2026-10-13):** a man's range comes first among the suitable products (a sensitive-skin cleanser had outscored his); « vous avez autre chose ? » gives the next products for the same need, never those already shown (`no_other_option` when there are none); body care only when the customer says it, not when the model reader guesses it from « after showering ».
- **One product proposed comes with its offer** (owner, 2026-10-13; foundation engine): the public offers running on that product now (its own, a collection it is in, or every product; never free shipping or a private code; at most two), from the synced promotions the shopping tools read. The model mentions it once, as given, and never promises it applies to their cart. A routine of several products gets none here: its offers stay the shopping tools' (`simulate_offers`).
- **Measured:** `npm run advisor:score` 44/44 on the bench with the budget cases (the playbooks: 14/38 before them). The bench is invented: the real score waits for Qiriness's spreadsheet.

### The routine builder is a skill: its rules and tools only while it is open (2026-10-13)

The owner's rule. Building a routine is one bundle, `skills/routine-builder.mjs`, with its instructions, tools and guardrails; the base prompt keeps only targeted advice (the top choices for a need, a product's facts).

- **Open while `mode === 'routine_builder'`,** so the code and the model can both open it and it stays open across turns. The code opens it on « Oui » to the offer (button or typed), the `build_routine` action, the routine words, or a routine size in the customer's words (« tout organiser du matin au soir »). The model opens it with `use_skill`, offered only while no skill is open, when the customer asks for a routine in their own words.
- **Inside:** the skill's rules (one question per turn, steps only from ADVICE, owned products kept, purchases and treats the app's) and its tools: `advise` in routine mode (any routine size), and `get_past_purchases` for a signed-in customer.
- **Outside, `advise` gives one product.** Its scope is `targeted` only, and the runner ignores a routine size the model sends: in a live run the model built a whole routine through the targeted tool instead of opening the skill. A reply that already shows a routine is never followed by the routine offer.
- **The flow decisions stay in code** (`routine-flow.mjs`): the offer, the purchase turn, the product built around, the treat. The skill gives the model what it needs to converse while building.

### The storefront agent reads one order's status by its number (2026-10-13)

The owner's rule. « Où est ma commande #1234 ? » gets the status, not a referral.

- **By number, for anyone who has it** (owner): guest checkouts are most orders, so « signed-in only » would answer almost no one. The risk is that order numbers are sequential, so someone trying numbers learns other orders' status and day. Against it: only the status and the days come back (no name, email, phone, address, amount, product or tracking), 3 lookups a conversation, marketplace orders are « not found », and every lookup is logged in `data_access_events` (hashed shop and number). A lookup that cannot be logged is not used.
- **One reader** (`order-status-repository.mjs`), named columns; the destination country is read only to choose the home or abroad delivery time and never leaves it. `data-access.test.mjs` allows it and the purchase reader, nothing else.
- **The status is the shop's own timings** (`order-status.mjs`, working days): not shipped within `dispatch_days`, being prepared; past it, sorry for the delay; shipped within `france_delivery_days` / `abroad_delivery_days`, on its way; past them, late, sorry. Also delivered, cancelled, partly shipped (judged on what is left). An unset timing is never guessed (`timing_unknown`; JavaScript reads `null >= 0` as true, caught by a test).
- **The tool returns the dispatch and delivery passages** of the policy with the status, so the reply explains the timing in the shop's words.
- **The model may ask for the order number, and only that.** This replaces « never ask for an order number ». Never an email, a name or an address.
- **Off unless `STOREFRONT_CHAT_ORDER_STATUS=on`.**

### Every « contact us » carries the contact form (2026-10-13)

The owner's rule. Whenever the advisor sends someone to customer service, and after every order answer, the contact form's link is under the reply.

- **The model sets `contact_link`; the code makes it certain.** It is forced on whenever the order tool ran, or the reply names customer service or contacting us (FR/EN words).
- **The link is the shop's**: the parameter `contact_form_path`, default Shopify's `/pages/contact`, a path on the shop's own site only (anything else falls back). The widget builds it from `Shopify.routes.root`, so it opens in the visitor's language. The model never writes a link, an email or a phone number.

### The routine builder flow: offered after products, built around what they came for (2026-10-13)

The owner's design. A conversation leads to a personalised routine naturally: entered from a product question (its facts), a concern (our top choices) or « construisez-moi une routine » (straight in).

- **The flow is code, not prompt** (`routine-flow.mjs`). The app writes its own follow-up message, words and buttons together, so they always agree. The model is told only that a message follows and what it does, never its words: quoted, the model copied it (live run). This replaces Phase 1's model-asked purchase question, which had the text ask one thing and the buttons answer another.
- **The offer** follows a reply about products: cards shown, or the product the conversation is about (its page, or one they named). It is a second message, « Souhaitez-vous que je vous construise une routine personnalisée ? », with Oui / Non; typed words count while it is pending (FR and EN). Once per conversation; after « Non », only their own request starts the builder.
- **« Oui » is a routine, not one more product:** a care type or targeted scope from the first question is dropped, or « une crème pour mon visage déshydraté » then « oui » built one cream again. ~~The engine's concern question still gets its buttons the turn after (the offer had taken its turn).~~ Reversed 2026-10-19 (owner's notes v4): the engine's question goes first and the offer waits for its answer; see « The owner's notes v4 ».
- **The anchor** is the one product they focused on (owner): the page product, else the one they named, else our top pick. In the builder it is put into its step (`pinned`), even when the chosen size lacks that step (the step is added from the full routine). It must still pass the hard checks and the suitability floor, else it is left out and the reason given. For « un soin ciblé » it is the product.
- **The purchase question:** builder only, signed in, once, once the concern is known. It is the whole turn, written by the code with no model call: told to ask nothing, the model still added its own question beside it in two live runs. The three answers: « Construire ma routine autour » (theirs: it fills its step, its range nudges), « Il m'en reste peu » (the always-offered option, owner; its card follows with « Voir le produit » and « Ajouter au panier », and it goes into its step), « Me concentrer sur ma préoccupation » (left aside). A consultant offers, never pushes a reorder.
- **One question per turn.** A follow-up that asks takes the engine's question's place; the engine asks it next turn, and the model sees `waiting_for_follow_up` with nothing to ask. A follow-up without buttons (a card) carries the engine's buttons, since only the last bubble's are live.
- **One treat at most** (« petit plaisir »): after the routine is recommended, or right after « Non ». The brand's « Petit plaisir » products once the knowledge is imported; until then the config's `treats` (masks and patches, `max_price` €25, owner). Never a product in the routine or one they own.
- **« Ajouter au panier » on cards** (owner): only when the product has one purchasable size in stock; with several sizes the choice is the customer's, on the product page. The widget adds one unit to the shop's own cart on the customer's click and records `added_to_cart`.

### Purchase history, Phases 2–3: what they use fills the routine; what runs out is asked about (2026-10-13)

- **A product they build around fills its step and counts toward the routine size.** Only what the customer confirmed (« Construire ma routine autour »; « Je l'utilise encore » before the flow), never a purchase alone. The step is skipped as `already_owned` with their product's name; the model says to keep it and recommends the other steps. It is never offered again, not even as an alternative. A step they asked for by type (« une crème ») is still filled: they asked.
- **Which step a product fills is the brand's knowledge**: the spreadsheet's « Type fonctionnel » (the main types; « Masque » is a cream mask and « Masque tissu » a sheet mask, 2026-10-14: the type alone says whether a mask is a treat, sheet yes, cream no, and only a cream mask fills a routine's mask step; « Démaquillant » also fills a « Nettoyant » step, never the reverse, 2026-10-14, `fillsStep`; « Coffret » and « Kit » are two, 2026-10-14, both standing for their contents and filling no step themselves, treated alike until the owner says how they differ; « Autre » for anything outside them, described in « Autre type », 2026-10-14: an « Autre » product fills no step) and « Zone », mapped to step kinds by the brand config's `functional_types` (data, validated against the slots). Without knowledge, the step's own catalogue rules decide. One product fills one step at most: one cream is not a day and a night cream.
- **A kit stands for what it contains** (« Contenu du coffret »); the kit itself fills nothing. Kits and sets are in 52.8 % of orders.
- **« Ne pas conseiller » is never recommended**, whatever its signals. The importer keeps those rows for that reason; « À valider » rows are not imported.
- **Running low is a question, never a claim.** For daily care only (knowledge `frequency: daily`; never a mask, kit, tool, treat or gift), when the expected interval has passed and less than three intervals have (past that they have most likely stopped or buy elsewhere). The interval is the shop's measured median when 10+ repurchases were seen, else the brand's « Durée d'utilisation ». Measured on own-store orders, 2026-10-13: repeat rates 4–36 %, daily creams and serums 10–20 weeks with a narrow spread, masks and patches all over the place (Wrap d'Or 3–23 weeks), hence never scheduled. The consultant may ask once (« il vous en reste ? »); no pushed reminder, no reorder pressure.
- **Measured is when they rebuy, not how long it lasts**, so it never replaces the brand's figure in the spreadsheet. Measured under half or over twice the stated duration is flagged for the brand (`durationsDisagree`).
- **A range they use is a nudge, not a reason**: ranges of products they still use or paid for more than once add 0.15 to routine fit (below the playbook's family, 0.5, and the slot name, 0.2), after suitability. It reorders suitable products; it never lifts an unsuitable one. Never from a gift or a free line.
- **Not built:** commercial adjustments (the treat policy, § 3.4 of the plan) and measuring the effect on cart additions and later purchases.

### Purchase history, Phase 1: asked about, never assumed (2026-10-13)

- **A purchase is a question, not a fact about the customer.** It does not prove they use it, still have it, liked it or bought it for themselves. So the consultant asks about one (« I can see you bought X — still using it? »), with chips from the code, never the model. Only the answer is recorded (`context.advisor.purchases`: product ids under using / finished / gift).
- **Read only when the turn needs it:** a consultation turn, a purchase chip, or a message about past purchases (« ma dernière commande », « reorder »). A policy, product or cart question never reads orders. The agent is handed a loader instead of data, so a turn that does not need purchases costs no query. A customer's summary is reused for 10 minutes: a consultation lasts a few minutes, and egress is what restricted the project in October 2026.
- **When and how to ask:** superseded the same day by « The routine builder flow » above (builder only, once, the code's own turn).
- **What is worth asking about:** a product probably running low first (Phase 3); then the latest purchase they paid for and kept, still sold. On the same day, the one bought most often, then the more expensive (the shop’s current price, cheapest variant; owner’s rule, 2026-10-13). The price ranks only and never reaches the prompt. Never a €0 line (a promotional gift or sample: about half of Wrap lines), never a return, never a product no longer sold.
- **An unlogged read is not used.** If the `data_access_events` write fails, the read fails and the turn carries no purchases. A slow or failed read (1.5 s cap) does the same: the advisor answers as if anonymous.
- **« Still using it » keeps their product.** Since Phase 2 their product fills its step (below); before, the step was only marked.
- **Marketplaces come from `sales_channels`, not a list in code**, as for every per-person metric (their customers are synthetic, one per order).

### The lexicon has a model backup, not a model replacement (2026-10-12)

The lexicon stays first because it is instant, free and testable. It reads a customer's words into the profile before the one reply call, so the engine (not the model) decides the advice. Its weakness is coverage, and a partial reading is worse than none: « tight and dull » read as « dull » produced a firming serum, and the reply model, handed finished advice, did not correct it.

- **The lexicon reports its own gaps.** Content words that no pattern, marker or filler explains are its `residue`. An empty residue means the lexicon read the whole message.
- **The model reads only what the lexicon could not**, and only for the consultation. A chip, a product question, a policy or cart question, or a message with nothing about the skin never pays for the call. On the stored dev-store messages, 4 % do.
- **It writes the same values, at a lower rank.** Its updates are `model_inferred`, so a phrase the lexicon read is never overridden. It only fills gaps.
- **It never holds the turn.** A 2.5 s cap, with reasoning off. Readings at the default effort took up to 4 s for no better result.
- **The `advise` tool stays.** The reply model can still correct the profile. The reader only makes sure the advice it is handed was computed from the whole message.

### French and English are the minimum, for every layer (2026-10-12)

*Extended 2026-10-30 to six languages (§ Six languages, built to take more).*

French and English together are about 99 % of customers, and the owner made both the bar for anything built in the chatbot. A feature counts as done only once both work. Most of the chatbot decides before the model (lexicon, routing, resolution, chips), so a French-only rule fails silently in English: no error, just a vaguer reply. Measured on 2026-10-12, English resolved 34 of 52 product mentions and extracted no skin type from « very dry and dehydrated skin ».

- **Language words live in tables, one per language, with the same keys.** `i18n/<code>/lexicon.mjs` (moved 2026-10-30, § Six languages) share one engine (`lexicon.mjs`). A test fails when one table has a key the other lacks. A new language is a new table, not new code.
- **Every table runs on every message.** Customers mix languages (« j'ai des dark spots »), and a one-word answer carries no language.
- **Deterministic text follows the customer, not the store.** Chips use the message's language, then the conversation's, then the page's. Labels exist for every value in both languages, and a test checks it.
- **Words map to the catalogue's language, never the reverse.** Care words (`toCatalogueWords`) and ingredients (`ingredients.mjs`) are groups of equivalents. The customer's word becomes the form the catalogue uses, so an English-titled shop needs no change. Brand and product names are never translated.
- **Lexical matching against French-only content is told so.** FAQ entries are French, so an English question cannot match them word for word. The model is told the FAQ language (from the data) and searches in it. A product FAQ with no shared word returns all its entries.
- **Every test set covers both languages.** The advice, resolution, policy-routing and shopping-opening cases each have an English version, and a feature without one is not finished.

### Neutral replies retain the conversation language (2026-10-06)

The owner reported an English cart/shipping conversation switching to French
after “France”. The prompt explicitly defaulted short/unclear messages to French,
and the destination continuation only recognized prepositions such as “en France”.
Regression tests reproduced both gaps. The model now returns a bounded BCP 47
reply language, stored in existing assistant context JSON; neutral country/ISO,
yes/no, number, emoji and clarification answers reuse that language. For old rows
without metadata the prompt uses conversation history. Explicit language requests
or substantive language changes still win. No new table or language-detection call.

Bare country answers continue only the immediate assistant's delivery topic,
not an older delivery discussion after a topic change. Internal cart verification
and missing variant metadata should not appear in simple cart listings; a limitation
is explained only when it affects the question. The dev shop still lacks synced
promotion rules. For dev testing, public brand offers now have a separate read-only
preview path for an allow-listed unsynced shop. It reads only the catalogue shop's
public promotion rows and explicitly leaves store/cart eligibility unconfirmed.
Only `get_active_promotions` may use that path; stock, cart identities and eligibility
never borrow production data. A source outage does not trigger preview. This lets
the dev advisor describe the brand's public offers without creating false eligibility.

The reported free-shipping question also exposed a lookup gap: current offer listing
excluded shipping offers entirely. An explicit `free_shipping` topic now reads only
published public promotion terms (dates, threshold, destinations), never rates or
estimated costs. It remains separate from shipping eligibility, which is not implemented.

### Shopping uses the signed shop and existing public promotion gates (2026-10-06)

**Cart labels must survive without a synced shop (2026-10-06 fix).** The owner
reported counts arriving but names missing for cart suitability questions. The
browser whitelist discarded `product_title`/`variant_title`, and the tool sourced
names exclusively from synced products. An integration regression using both
reported messages reproduced this before the fix. Keep bounded, plain cart labels
through browser/backend validation and mark their source as `cart_observation`.
Same-shop synced names take precedence. Observed labels are sufficient to name
cart contents, not to establish catalogue identity, ingredients, suitability or
stock. Cart-page pronoun/suitability follow-ups also retrieve fresh cart context;
payment FAQs still avoid cart reads. No cross-shop mapping or new API is needed.

The current dev widget uses the production advice catalogue. That is acceptable
for product discovery links, but a dev cart's Shopify IDs cannot safely be checked
against production stock or promotion rules. A read-only source check found the
dev shop has no synced shopping data. The new shopping reader therefore keys on
the signed proxy shop domain and returns unavailable for that shop; no title/handle
cross-store mapping or production fallback. Existing promotions, variant JSON and
collection membership are sufficient; no schema redesign or customer-history read.

Public code rows are filtered by the existing merchant `offerable_in_replies` flag
before retrieval. Automatic offers use `describable_in_replies`. Raw cart labels
can contain a private code, so unknown discounts become unnamed amounts rather
than being echoed. Only public codes returned by tools can survive the reply code
backstop; absence from public records is not evidence a code is invalid.

The proxy proves the shop, not the browser's posted cart. Shopify Ajax snapshots
are whitelisted on both sides, transient, and explicitly unverified; no token,
properties or personal data. Failed checkout-only entered codes are unavailable
unless the shopper supplies them. Synced variant quantities and timestamps are
the existing stock source; a 36-hour freshness guard covers the daily sync cadence
without claiming live availability. Missing selected variants, stale inventory,
restricted customer eligibility, unsupported app/bundle rules and currency or
discount-allocation ambiguity are unknown. Shopify checkout remains final authority.

The existing support classifier, combination flags and common basket checks are
reused without changing support behavior. Buy/reward quantities need a separate
storefront guard: support's multi-buy path assumes overlapping scopes, while a
current cart can contain distinct purchase and reward products. Shipping and any
checkout mutations remain outside this layer.

### A separate Shopify app, in its own directory (2026-10-05)

The support app (`shopify.app.toml`, client_id `1d69…`) is installed on the production store, `qiriness.myshopify.com`. A theme app extension shipped through it would appear in the production theme editor. The app proxy is app-wide config, so adding one would add it to production too. The advisor is therefore **its own app** (`storefront-app/shopify.app.toml`), installed on the dev store only. It sits in **its own CLI project directory** because the Shopify CLI deploys every extension under the project it runs in: with the extension under the repo root, a routine `shopify app deploy` of the support app would carry it to production. The directory boundary makes that impossible rather than merely discouraged.

The route's **shop allow-list** (`STOREFRONT_CHAT_ALLOWED_SHOPS`, where empty serves no shop) is the second guard. A production request would be refused with 403 even if the advisor app were installed there by mistake.

### The app proxy, not a direct call to the backend

The browser posts to `/apps/storefront-advisor/chat` on its own storefront domain. That needs no CORS, and no backend URL appears in theme code (the URL lives in the advisor app's toml). Shopify signs every proxied query with the app secret, which proves the request came through a store and names which one. A direct fetch to Vercel would have needed an open CORS origin and something else to prove the shop. The proxy strips cookies, so the session travels in the body. The token is **minted server-side**: one the browser sends is honoured only if it names an active session of the same shop.

### No SQL tool, ever, for the customer-facing agent

The management chat lets its model write SQL, as a read-only role over curated views (§ Management chat). That works because its users are signed-in staff. The storefront agent talks to the public internet, so it gets **narrow, typed, read-only functions** (Phase 3: `search_products`, `get_product` through a product repository returning whitelisted fields) and never a query language or a database handle. It never reads customers or orders, with two exceptions since 2026-10-13, each one typed function: the signed-in customer's own purchase summary (§ Purchase history: identity from the signature only) and one order's status by its number (§ The storefront agent reads one order's status by its number).

### Caps before the model

The per-session turn cap and the per-shop daily cap on customer messages ship in Phase 1, while replies are still mocked. Attaching an LLM in Phase 2 then attaches it behind a door that is already limited, rather than leaving the limit as an afterthought on a public, paid endpoint.

### The loader is small because Theme Check says so

App-embed JavaScript is capped at 10 KB by Theme Check (`AssetSizeAppBlockJavaScript`), and the full widget was 16 KB. Only the launcher loads on every page (`advisor.js`, about 4 KB). The panel (`advisor-panel.js`) is fetched on first open, or straight away on desktop when the previous page left it open. A visitor who never opens the advisor pays only for the launcher.

### Nothing brand-specific in the code

The header reads « Conseiller Beauté {shop} », filled from `shop.name`. The proxy subpath is `storefront-advisor`, and the strings live in the extension's locale files. Another shop installs the same extension unchanged.

### Phase 2: one model call, opt-in, bounded (2026-10-05)

- **Opt-in by `STOREFRONT_CHAT_AGENT=llm`.** The production dashboard carries `/api/storefront/chat` too. A key being set must never be what starts storefront spend.
- **`gpt-6-luna` by default** (the owner's choice, same day). The first model was `gpt-4o-mini`: 2–5 s, about 570 input and 40 output tokens, $0.0001 a reply. `gpt-6-luna` on the same eight questions: 1.6–3.5 s, about 560 input and 60–190 output tokens (its reasoning counts as output), and about the same $0.0001 at $0.10 / $0.50 per million. That is under 6 cents a day at the 500-message cap, with the same rule-following and more natural French. The shared client treats it as a reasoning model (no `temperature`, a 4,000-token output ceiling), which costs only the tokens actually produced.
- **A shopper does not wait out a rate limit.** The worker's client waits up to two minutes on a 429. Here a request is cut at 12 s, the retry wait is refused, and a wall-clock deadline sits on top: one live request ran 51 s behind Next's patched `fetch`. A failure answers 503, and the widget shows « Réessayer ».
- **The prompt is in English.** A French prompt saying « réponds dans la langue du client » answered English and Spanish questions in French on gpt-4o-mini (3 of 3). In English it answered in the customer's language, though declines still came back in French until the rule said it covers declines too. French stays the default for a message that gives no clue (« Bonjour », a French button label).
- **The prompt forbids, per phase, what the agent cannot know.** Products, prices, stock, offers, delivery and returns are all forbidden now. Each later phase relaxes exactly the rule its tool makes answerable, and nothing is left for the model to know from training.
- **Spend is on the message row, not in `llm_usage`.** `llm_usage` is the support pipeline's ledger, constrained to its passes. Each assistant row carries its model and tokens, which is enough to price the advisor separately.

### Phase 3: read-only product tools, built for reply speed (2026-10-05)

- **The catalogue is held in memory, whole.** It's about 100 live products and 28 active collections, read once every 5 minutes by `product-repository.mjs` (about 1 s) and refreshed stale-while-revalidate. A tool call therefore costs no database round trip, and the reply time is the model's alone.
- **The repository is the only reader**, column by column. The raw Shopify payload is never read: the review badge HTML lives in `structured_facts`. Stock reaches the model only as in stock or not.
- **`collection` is an enum of the team's active advice collections.** The model filters on curated lists (« Peaux Sensibles », « Sérums Visage ») rather than guessing words, and in the live check it chose a collection on every product question.
- **The page's product goes into the prompt.** « Est-ce que ça convient aux peaux sensibles ? » on a product page is one call (1.7 s), not a lookup and then an answer.
- **At most 2 tool rounds, then a forced answer with a note.** Without the note, after two good searches the model answered « je ne peux pas vérifier » with no card (measured). Asked to request several searches in one step, it ran two collections in parallel: one round, not two.
- **No search before a need is known.** « Construire ma routine » used to spend two searches and then ask a question anyway (3 calls). Now it is one call and the question.
- **A card is only ever a product a tool returned.** The model writes a handle and a reason, and the catalogue writes the name, price and link. A handle the model invents is dropped.
- **In stock first.** The only matching anti-taches sérum was out of stock. Before the in-stock rule, it was suggested alone. Now it's named as unavailable, and an in-stock alternative is shown as a card.
- **No images yet.** The product sync stores none (`raw_shopify_payload` has no `featuredImage`), so cards use the placeholder until the sync reads one.
- **Measured through the route:** 2–4 s for a search plus an answer, about 2 s with no tool call, and an occasional 6 s on a slow OpenAI call. About 1,800 input tokens per call: the tool definitions and the collection list are a stable prefix, eligible for prompt caching.

### Product resolution: which products, before the model (2026-10-06)

- **Resolution is not discovery.** « la crème Source d'Eau Riche » and « les deux » are references to settle; « quels sérums anti-âge ? » is a search. `resolve_products` and `search_products` are separate tools, and later tools (compare, ingredients, routine) take the resolved `id`s.
- **It runs before the model, deterministically** (median 0.5 ms). A named product, a clarification answer or « ça » on a product page costs one model call and no tool (measured 1.7–2.4 s).
- **No hand-written vocabulary.** On this catalogue the title's last segment is the commercial name customers use (« … – Caresse Source d'Eau Riche »), and the head noun is the care type. Brand synonyms are learned as the head noun most of a commercial prefix's products share (Élixir → Sérum, Caresse → Crème, Wrap → Masque, Rituel → Coffret). The unit tests run on an invented brand to keep it that way. The owner asked for this (« don't hardcode any of this into the prompt »).
- **Identity words versus attribute words.** A word is identity when at least half its title occurrences are in commercial names. Even so, « temps » and « parfum » are ordinary French, so **a lone name word needs a care word just before it**: « combien de temps », « sans parfum » and « la lune est belle » never resolve, while « le masque Hyal-Aqua » and « la Lip Beauty » (two words) do. Description frequency was measured as an alternative and rejected: it would demote « riche » (25 other descriptions, 2 titles) and miss « temps » (3:12).
- **Typo correction follows how people mistype:** a dropped, swapped or doubled letter, never a stray extra one. « matin » corrected to « main » broke a page question. Grammar words (« trois », « premier ») are never corrected: « trois » once became « trio ».
- **Never a silent pick; the clarification is data.** Three or fewer candidates, or candidates that share one care type, give `choose_product` with the top 3. More, across several types, gives `choose_care_type` (« Crème / Coffret / Sérum »). Labels are the commercial name when unique and still containing the customer's words, else care type plus last segment (« Crème Source d'Eau 50 ml »). Chips send a `choice`, so the answer resolves by id with no re-parsing. The prompt carries only the generic rule « ask it with exactly its options ».
- **A plural the memory can't satisfy is reported, not filled.** After one card, « les deux premiers » made the model search and describe a second product the customer had never seen. The resolver now returns the one product plus the cue as unresolved, and the model asked which two.
- **SKUs can sit on two listings** (the 50 ml multi-size listing reuses E046N). The listing where the SKU stands alone wins; otherwise the result is ambiguous.
- **Memory lives on the assistant row** (`context.refs`, `context.resolution`), so the question can still be logged in parallel with the model call. No table. Curated aliases wait for a measured miss that only an alias can fix.
- **Samples left the advisor's catalogue.** They're excluded through the support matcher's own `isCustomerFacing`. Phase 3 had included the 9 `SAMPLE PRODUCT` rows.

### A range is a collection the team marks « Gamme » (2026-10-06)

- **Ranges used to be guessed from titles.** « toute la gamme Source d'Eau » meant every live title containing « source » and « eau ». That works while every line repeats its name in every title. It drifts when one doesn't, and when a word is shared by accident.
- **The shop already curates them in Shopify:** « Temps Sublime » (11 products), « Source d'Eau » (6), « Active Énergie » (5), « Exception » (4). They were inactive in `advice_collections`, because the only axes were concern and category.
- **So `axis` gained `range`** (migration 77, chosen in Agent setup → « What we can advise on »). An active range collection is **the** membership of « la gamme X »: the resolver checks the curated ranges first, taking the most specific one the customer's words cover. The title-derived range is the fallback for a line nobody curated. The resolution's `range.source` says which was used.
- **The support agent ignores ranges** (`supportCollections` in `advice-collections.mjs`). Its intersection treats every non-category collection as a concern, so a range there would silently become a ranking requirement. Whether support should read ranges is its own decision.
- **Membership needs the collection active.** `product_ids` is refreshed for active collections only (§ Advice comes from collections), so a range is read only after it is switched on and synced.

### Storefront knowledge adapts existing storage (2026-10-06)

The owner explicitly asked to preserve policy/FAQ storage because support already
depends on it. The storefront therefore has its own read-only adapter, topic/key
bindings and runtime FAQ records. No shared writer, editor, support retrieval or
schema changes. The live inventory found 15 active policies and existing parameter
references; structured delivery/return/refund facts use those references and the
existing typed parsers rather than extracting numbers from prose.

**A number alone is not the policy.** `shipping_cost_policy` says free delivery
may be offered periodically above `{free_shipping_threshold}` in France. Returning
that number as unconditional free shipping would change the rule. Facts therefore
travel with bounded source passages, applicability, restrictions and source versions.
Missing/invalid parameters withhold the policy. The existing historical returns
contradiction is not copied: the current company return policy is the source.

**FAQ is intent; policy is authority.** A policy-related heading redirects to the
bound company policy and drops its embedded answer. General FAQ retrieval excludes
product-linked documents. Product guidance requires a resolved product ID and
catalogue facts already supplied in the turn; the reader filters by that ID, lazily.
Published Shopify product FAQs are part of catalogue facts, before curated guidance.

**Conservative lexical retrieval first.** Exact questions and explicit leading
question aliases precede keyword/topic and single-edit fuzzy matching. A broad topic
never selects an answer alone. Ties return clarification questions, oversized units
are withheld whole, and no embeddings are added. 15/15 live retrieval checks passed
with a warm median of 0.59 ms; generated replies and widget latency remain to review.

**Freshness is bounded.** General knowledge and per-product guidance expire after
five minutes. An agent may retain a catalogue while its background refresh fails,
but it cannot keep answering policies from an expired knowledge snapshot. Source
failure returns unavailable and transport details never reach the model.

### Free delivery is evaluated against the cart; codes stay private (2026-10-06)

- **Measured on the synced dev store.** Its only public offer is automatic free delivery (FR, from €70). « Quelles sont les offres du moment ? » answered « aucune offre », because the listing excluded shipping offers by default. « Mon panier a-t-il droit à la livraison gratuite ? » on an €80.78 cart answered « je ne peux pas confirmer », because shipping eligibility had been recorded as « not implemented ».
- **The listing now includes free delivery by default** (`topic: all`), with its published terms and `delivery_cost: not_calculated`.
- **Free delivery is evaluated on its minimum only.** The cart total after discounts is compared with the threshold:
  - met → `eligible` with the destination as a condition (« si livraison en France »);
  - short → `not_eligible` with the exact amount missing (€58.17 on €11.83);
  - an order discount between total and subtotal → `unknown`, not guessed;
  - another currency, or an offer limited to some customers → `unknown`.
  - It never gives a delivery cost.
- **Codes are not volunteered** (owner, 2026-10-06: « codes are not usually publicly disclosed »). The advisor talks about the offers the website shows, i.e. the automatic ones. The 5 dev codes stay `offerable_in_replies = false`, and a code the shopper types is still evaluated under the existing rule.

### Codes the shopper entered are named back; one product discount per line (2026-10-06)

- **A code already applied in this cart is named back to the shopper,** even when it isn't shareable (QIRINESS20 and BIENVENUE20 on the dev store showed as « Réduction appliquée »). Naming back a code they typed discloses nothing to them, and without it stacking could not be judged.
  - The shop's active codes are read into a separate `cartCodeRows`, used **only** to recognise a code applied in the cart.
  - Those rows never enter the offer listing or an evaluation. The repository test asserts it.
  - Public codes keep the `offerable_in_replies` gate. « Does X work? » about such a code is answered `applied` when it is in the cart, and stays `not_found` otherwise.
- **Shopify applies one product discount per cart line by default** (`productDiscountsWithTagsOnSameCartLine` is Plus only, and the dev store doesn't use it). September Rose (30 %) was « eligible » by its combination flags while both its lines already held a product discount (the 2-for-1 and the gift).
  - The widget now sends each line's discount names (`discountTitles`).
  - A product discount whose every target line already carries another one is `not_eligible`, reason `line_already_discounted`, with `blocked_by` naming the blockers.
- **A follow-up carries the cart:** after a reply that used the cart, the widget sends it with the next message. The server treats a carted follow-up to a shopping reply as a shopping question.
- **An amount or a name points at the offer meant.** « 30 % » or an offer's title evaluates that offer on its own (`mentioned_by_customer`). Left to the model, the link was made on one run and missed on the next. After the change it was made 3 runs out of 3.
- **Product, offer and code names are never translated.** An English reply had invented « Revitalising Body Spa Ritual Kit ».

### A product's own FAQ is read whole when no question matches (2026-10-07)

Product FAQs are scoped to one product the customer has named, and small (the LED mask has 12 entries). The keyword matcher stays first, because a clean single match is the cheapest and most precise answer. But it reads the questions only, and customers ask in words the headings don't use. Failing that, the model gets the product's entries sharing words with the question, answers included, capped at 6,000 characters. Reading a few entries is what the model does well; « not found » with the answer in hand is not acceptable. General FAQs (not product-scoped) keep the strict matcher: across the whole knowledge base, a loose match would pick the wrong topic.

### A code the advisor cannot see is reasoned about from the cart (2026-10-07)

A private code stays private: its rules are never read for the customer, and the reply never says it exists, is valid or what it gives. But « je ne peux pas confirmer » alone is not an answer when the cart holds the likely reason. An applied offer whose `combines_with` refuses a class blocks any new discount of that class, whatever the code is. So a not-found code comes with `cart_reasoning`:
- the applied offers that refuse new order, product or shipping discounts;
- whether the 5-code limit is reached;
- otherwise, the usual hidden conditions.

The customer's own typed code may be repeated back; it discloses nothing to them.

### The advisor speaks as the shop, never as its platform (2026-10-07)

The owner's rule: customers never hear « Shopify » (nor Alpha, apps or tool names). Replies say « votre panier », « automatiquement », « la plus avantageuse pour votre panier a été retenue ». The platform's rules still drive every verdict; only the wording is the shop's. Internal prompt lines may name Shopify to explain the data to the model, never as customer wording.

### The agent is never served past its knowledge's lifetime (2026-10-07)

Stale-while-refresh was right for the catalogue but wrong for policies: `getPolicy` refuses knowledge older than `KNOWLEDGE_TTL_MS`, and the agent's lifetime was the same five minutes. So the first customer after any pause got « no reliable information » on every policy. The agent now refreshes one minute ahead, and one past its lifetime is awaited (about a second, only after five idle minutes) rather than served. The five-minute edit boundary is kept.

### A shopping question with a cart always evaluates it (2026-10-07)

The opening's word lists decide which tools run, and they missed an ordinary English question. When the shopping route is taken with a cart and the lists select nothing, the cart and a full evaluation are fetched anyway: a wasted read costs milliseconds, a missed one costs a « cannot confirm ». Every cart evaluation also carries `simulate_offers`, because « why this offer and not that one » is answered by the combination, not by any single verdict.

### The advisor follows Shopify's discount rules, not the shared outcome check (2026-10-06)

The rules are researched in `docs/shopify-discount-rules.md`; this is why the evaluator encodes them itself.

- **An applied Buy X Get Y locks its « buys » line too.** `cart.js` allocates the discount to the « gets » line only, so the per-line check saw the cream under TEST02 as free and called September Rose eligible on it. On non-Plus, Shopify excludes both items. The lock is read from the applied offer's scopes, not from the allocations. A `shopifyPlus` option exists (default false) and leaves only the « buys » line locked.
- **Each money minimum is measured the way Shopify measures it for that class** (order: before AND after product discounts; product: after other product discounts; Buy X Get Y: « buys » items at full price). The shared check in `agent/src/retrieval/promotion-outcome.mjs` (support replies) answers `undetermined` whenever a cart straddles a minimum before and after discounts. Here the cart's own allocations are known, so the straddle is decidable. The support side is left as it is: it judges orders, where those allocations are not always in hand.
- **Which offers apply together is solved, not guessed.** Shopify keeps the allowed combination with the largest saving, which no per-offer verdict can show. Carts are small and offers few, so an exhaustive search (≤ 10 offers) is cheaper and more predictable than any heuristic. It is exposed as a tool (`simulate_offers`), not run on every turn, because only « what would apply / what if I add » questions need it.
  - Only automatic offers and codes **already entered** are reached: Shopify applies no code nobody typed, and the advisor never offers a private one.
  - On a real cart, Shopify's result in the cart wins. The solver flags a disagreement rather than overriding it.
- **A sale price is the price.** Promotions are computed on the current variant price (an Alpha sale included); compare-at is display only. It is synced so the advisor can say « already on sale », never to recompute a discount from it.

### The engine decides the advice; the model converses (2026-10-07)

- **Why not the old way.** Advice used to be `search_products` on a collection: the products that came up most often won. Nothing remembered the customer. Nothing encoded how Qiriness trains its advisers. Nothing separated « suits this customer » from « the brand wants to sell it ».
- **What replaces it.** A deterministic engine in `scripts/lib/advisory/`, with no model and no I/O:
  - a profile, where each field carries a value, source, confidence and turn;
  - the brand's playbooks;
  - eligibility, then suitability, then routine fit, then merchandising, with each term returned as reason codes.
  - It runs before the model, in about 0.1 ms. The model gets the advice as data, asks the one question it carries, or explains the routine from reason codes and product facts. A turn is one model call unless the lexicon missed something, and then the model calls `advise` with `profile_updates`.
- **The playbooks are the brand's, as data.** Qiriness supplied 11 routine playbooks (2026-10-07). `data/advisor/qiriness.json` transcribes them faithfully, and `npm run advisor:load` loads them into `advisor_playbooks` / `advisor_mappings` / `advisor_merchandising` (migration 80).
  - The prose rules are kept as `notes`. The model reads them as guidance, never as claims.
  - Keys marked `_added` are interpretations needed to execute them, and Qiriness should confirm them:
    - the concern lists of the men's routes;
    - their targeted slot;
    - `distinguish_by`, how a concern is offered when two playbooks tie.
- **No product id anywhere in the config.** Families map to range collections (« Active Énergie Lift » = the Active Énergie range narrowed by the name word « lift »). Slots map to category collections, care types (the title's head noun) and name words. Concerns, skin types, textures and areas map to tags and collections. `checkCatalogue` reports every reference that resolves to nothing, at load and in `eval:advisory`.
- **The user's eleven rules are tests, not intentions.** `advisory.test.mjs` has one test per rule on an invented brand. `eval:advisory` checks the same rules as invariants over every concern × skin type × sensitivity × target × scope × age × routine combination of the live catalogue: 3,936 profiles, 0 violations.
  - **Stock, area and target** are hard filters.
  - **Eye steps** in a face routine take eye products, because the slot carries its own area.
  - **Men's products only on an explicit request.** An unknown target means the main catalogue, never men's products.
  - **Age** adds at most 0.05 and is never read by playbook selection.
  - **Skin type picks the texture before any behaviour.** « mixte et déshydratée » first went to the standard cream because the dehydration group came first; skin type now wins.
  - **The current routine removes its steps.** « Targeted » picks the first priority step not already covered.
- **A treatment step must address the need.** On the 12-product dev catalogue, « premières rides » got the only serum there, an anti-spot one, recommended as « the best available ». Steps marked `concern_required` (serums, treatments, eye care, masks, lotions, the booster) now take only a product matching one of the customer's concerns or in the preferred family. A cleanser or cream may be generic. A targeted reply then moves to the next priority step and never mentions the step it passed over.
- **Merchandising cannot rescue an unsuitable product.**
  - A tier boost (at most 0.2) applies only to eligible products within `tie_window` (0.15) of the best suitability in that step, and never below the suitability floor.
  - A tolerance-first playbook (sensitive skin) boosts only products made for sensitive skin.
  - No priorities are loaded yet: Qiriness has given the tiers, not the products.
- **One question, and only one that changes something.**
  - **Selection gates:**
    - **Area, then primary concern**, with two exceptions: two plausible playbooks give one question built from the concerns that tell them apart; a skin type implies the face (« peau mixte et déshydratée » is not a body question).
  - **Questions in the routine builder:**
    - **Which field:** the next field in the brand's `selection_priority` whose possible answers would change the playbook, steps or products. This is checked by running the engine with each answer.
    - **Never asked:** sex and age. « Je ne sais pas » counts as an answer, and a field is never asked twice.
  - **Conversation mode** recommends at once, as soon as a playbook is selected.
- **Chips come from the engine, never the model.** Their value is `profile:<field>:<value>`, recorded with source `quick_choice`, and it outranks an inference. The resolver's « which product? » clarification wins over an advice question.
- **The profile lives on the assistant row** (`context.advisor`), folded back like `refs`. There is no table: the consultation is per conversation, and the message log already has retention.

### Advice is built to be lifted out for email, later (2026-10-07)

- **The rule.** `scripts/lib/advisory/` imports nothing outside itself (it carries its own `norm` and care type). Nothing outside the storefront advisor may import it yet. `isolation.test.mjs` enforces both rules.
- **Stays the same for email:**
  - profile, lexicon, config, selection, ranking, reason codes;
  - the event schema;
  - the config repository.
- **Changes for email:**
  - **Where the profile comes from:** a thread or case file instead of a turn.
  - **What a `next_question` becomes:** at most two questions in a draft, or stated assumptions (replies are asynchronous).
  - **How the advice is delivered:** drafting instead of cards and chips.
  - **Events:** `channel: 'email'`, with `conversation_ref` set to the ticket id.
- **Kept chat-only:** the chat glue (`advisor-tools.mjs`, `advisor-state.mjs`, the prompt section, the widget).
- **Not touched:** nothing in `agent/`, the support prompts or the dashboard changed. The only shared-app change is the middleware's public path for `/api/storefront/event`, which carries the same signature and allow-list as `/api/storefront/chat`.

### Advisory events are channel-aware and hold no words (2026-10-07)

- **Storage.** `advisory_events`: channel, conversation_ref, event_type, playbook_key, product_ids, payload (codes, counts, ids).
- **Writing.** Events are derived per turn from the state before and after (`turnEvents`) and written after the reply without being waited for. Card clicks arrive by beacon through `/apps/storefront-advisor/event`.
- **Shape.** There is no foreign key to sessions or shops (an email's conversation is a ticket), the same as 76. There is no customer identity, and no free text: `profile_field_collected` records the field and its source, not what was said.
- **Not built yet:**
  - `added_to_cart` (from the next cart snapshot);
  - `recommendation_abandoned` (derived later);
  - `purchase` (order attribution);
  - `unresolved_question` / `support_handoff`.
  - All four types are in the schema already. Dashboard integration is a separate task (`docs/storefront-chatbot.md` § Advice).
