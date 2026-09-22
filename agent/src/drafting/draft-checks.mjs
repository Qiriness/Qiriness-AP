import { CAVEATS, MISSING_FIELDS } from '../investigation/case-file.mjs';
import { findLinkMarkers, normaliseReplyLink } from '../../../scripts/lib/reply-link.mjs';

// What is checked against the drafted text, in code.
//
// WHY THIS EXISTS AT ALL. `do_not_claim` reaches the model as lines in a
// prompt, and the plan is explicit that this is the weakest kind of guardrail
// in the codebase: the failure mode it guards against is a model filling a gap
// with something plausible, which is precisely the state in which it is least
// likely to be reading its instructions carefully. A prohibition that is also
// checked afterwards is a different kind of thing from one that is only asked
// for.
//
// WHAT THIS IS NOT. It is not a claim that a clean draft is correct. A check
// here can prove a specific sentence is ABSENT; nothing here can prove the rest
// of the reply is true. `checks_passed` therefore means "nothing known-wrong was
// found", and the review queue exists because that is a much weaker statement
// than "this is right".
//
// HONEST ABOUT COVERAGE. Four of the ten caveats are not mechanically checkable
// at all — "ne rien inventer sur ce point" has no textual signature — and they
// are reported as `advisory` rather than quietly counted as passes. A check
// suite that reports 100% while testing 60% is worse than one that says which
// 60%, because the first number is the one that gets quoted.

/**
 * Prohibitions with a textual signature, keyed by the caveat that raises them.
 *
 * Each pattern matches THE CLAIM THE CAVEAT FORBIDS, not the subject it is
 * about. `stock_unknown` forbids announcing availability, so the pattern looks
 * for an announcement — not for the word "stock", which a correct reply
 * explaining that we cannot confirm stock would obviously contain.
 *
 * HIGH PRECISION OVER RECALL, deliberately. A false positive sends a correct
 * draft to a human, which costs a minute; a false negative is a wrong sentence
 * in a customer's inbox. But a check that fires on correct drafts gets ignored
 * within a week, so the patterns are narrow enough to mean something when they
 * do fire.
 */
export const MECHANICAL_PROHIBITIONS = {
  stock_unknown: {
    label: 'annonce une disponibilité ou un réassort',
    pattern:
      /\b(de retour en stock|réassort(?:i|é)?(?:\s+(?:le|à partir|prévu))?|sera disponible|de nouveau disponible|en stock (?:le|à partir|dès))\b/i
  },
  eligibility_undetermined: {
    label: 'affirme que le code promotionnel fonctionnera',
    pattern:
      /\b(le code (?:est|sera) (?:bien )?(?:valide|valable|actif|accepté)|votre code (?:est|sera) (?:bien )?(?:valide|valable|actif|accepté)|devrait fonctionner|fonctionnera (?:bien|correctement)?)\b/i
  },
  purchase_unverified: {
    label: 'nie l’achat ou la qualité de client',
    pattern:
      /\b(aucune commande (?:n['’]a été |n['’]est |)?(?:trouvée|enregistrée|passée)|vous n['’]avez (?:rien |jamais )?(?:acheté|commandé)|vous n['’]êtes pas (?:un(?:e)? )?client)\b/i
  },
  delivery_unscanned: {
    label: 'décrit le suivi transporteur ou l’avancement du colis',
    // MEASURED: 8 of 81 drafts said this to a customer before the prohibition
    // existed, several naming the carrier — « pas encore de scan de suivi de la
    // part de Colissimo ». No carrier feeds scan events into Shopify for this
    // store, so that blamed the carrier for a gap in our own integration.
    pattern:
      /\b(scan\w*|aucune? (?:information|donnée) de suivi|le suivi (?:n['’]est pas|n['’]affiche|indique)|pas (?:encore )?(?:de|d['’]) ?(?:mise à jour|information) de suivi|en cours d['’]acheminement|le colis (?:se trouve|est actuellement))/i
  },
  attachments_unrecorded: {
    label: 'affirme qu’aucune photo n’a été reçue',
    pattern:
      /\b(aucune (?:photo|pièce jointe)|nous n['’]avons (?:pas |rien )?reçu (?:de |aucune )?(?:photo|pièce jointe)|sans (?:photo|pièce jointe) jointe)\b/i
  },
  basket_unseeable: {
    label: 'décrit le contenu du panier du client',
    pattern: /\b(votre panier (?:contient|comporte|est composé)|dans votre panier, )/i
  },
  customer_unknown: {
    label: 'suppose un compte ou un historique client',
    pattern:
      /\b(votre compte (?:client|Qiriness)?(?: indique| montre| affiche)|vos commandes précédentes|votre historique (?:de commandes|d['’]achats))\b/i
  },
  // CHECKED RATHER THAN ADVISORY, which is the harder choice and the right one.
  // « Ne rien inventer sur ce point » has no signature and is listed as
  // unexaminable below; « ce produit a provoqué votre réaction » has a very
  // specific one, because a causal claim in French needs a causal verb.
  //
  // BOTH DIRECTIONS ARE THE SAME OFFENCE. « ne peut pas provoquer » sits here
  // beside « a provoqué » on purpose: a reply defending the product makes an
  // unfounded safety claim just as surely as one blaming it, and it is the
  // likelier of the two to be written.
  //
  // The ingredient clause catches the explanation rather than the verdict —
  // « en raison de la présence de … » is how a reply reaches a diagnosis without
  // ever using a causal verb.
  reaction_cause_unestablished: {
    label: 'affirme, ou nie, que le produit est à l’origine de la réaction',
    pattern:
      /\b((?:a|ont|aurait|auraient) (?:pu )?(?:être |été )?(?:provoqu|caus|déclench|entraîn|occasionn)ée?s?|(?:est|sont|serait) (?:bien )?(?:à l['’]origine|responsable)s? de|ne (?:peut|peuvent) pas (?:avoir )?(?:provoqu|caus|déclench)er|(?:est|sont) (?:dû|due|dues|dus) (?:à|au)|s['’]explique par|en raison de la présence d|il s['’]agit (?:bien )?d['’]une (?:allergie|réaction allergique|intolérance))/i
  }
};

/**
 * Caveats with no textual signature — reported, never scored.
 *
 * "Ne rien inventer sur ce point" forbids a class of sentence rather than a
 * phrasing, and any pattern broad enough to catch it would fire on correct
 * replies. They are listed so a reviewer reading the checks sees what was NOT
 * examined, rather than inferring from a clean list that everything was.
 */
export const ADVISORY_CAVEATS = [
  'knowledge_weak',
  'knowledge_none',
  'order_unconfirmed',
  'product_ambiguous',
  // "Do not improvise a recommendation" forbids a class of sentence rather than
  // a phrasing: any product name in a reply could be a recommendation or could
  // be the product the customer themselves named, and no pattern separates
  // those. Listed so a reviewer sees it was not examined.
  'recommendation_uncurated',
  // ADVISORY BY DECISION, NOT FOR WANT OF A PATTERN — the odd one out in this
  // list. « sans limite d'utilisation », « pas de date d'expiration »,
  // « illimité » are a short, catchable set, so a mechanical check is available
  // whenever the desk wants one. It was deliberately not built (2026-09-18): the
  // tool no longer states the absence of a limit at all, which removes the
  // source rather than policing the wording. Listed here so a reviewer sees this
  // prohibition was reported and not examined.
  'promotion_limits_internal',
  // ADVISORY BY DECISION, LIKE THE ONE ABOVE. The wording IS catchable, and it
  // is caught — by `no_unsuitability_claim` in FORBIDDEN_PATTERNS, which runs on
  // every reply rather than only on the tickets that raised this caveat. A
  // per-caveat copy of the same pattern would flag one sentence twice, and a
  // reviewer reading two lines for one problem learns to skim both.
  'product_fit_unstated'
];

/**
 * Things no reply may contain, whatever the case file said.
 *
 * The first two are identifiers the tool layer withheld on purpose — the
 * drafting projection is narrower than the human brief, and a model that has
 * been shown an order bundle can still quote a join key back at a customer who
 * has never seen one. The third is the guardrail list's own rule about internal
 * machinery, which is checkable exactly because it names concrete nouns.
 */
export const FORBIDDEN_PATTERNS = [
  {
    check: 'no_internal_identifier',
    label: 'cite un identifiant technique',
    pattern: /(gid:\/\/shopify|\bSKU\b|\bvariant[_ ]?id\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i
  },
  {
    check: 'no_email_address',
    label: 'cite une adresse e-mail',
    // Any address at all. The shop's own is not needed — the reply arrives FROM
    // it — and a customer's is withheld by default, so there is no address a
    // correct draft has a reason to contain.
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/
  },
  {
    check: 'no_unsuitability_claim',
    label: 'dit qu’un produit n’est pas adapté',
    // NOT GATED ON THE CAVEAT, like the carrier-scan rule below and for the same
    // reason: a product is presented for what it answers and never for what it
    // does not, on every ticket, whatever the case file happened to raise
    // (owner's rule, 2026-09-20). Measured: a reply told a customer with
    // reactive skin that two cleansers « ne sont pas spécifiquement adaptés aux
    // peaux sensibles » — a sentence that helps nobody and reads as a warning
    // about products we had just recommended.
    //
    // IT WILL ALSO FIRE ON A SAFETY WARNING taken from an approved article
    // (« déconseillé pendant la grossesse »). That is a reviewer flag rather
    // than a wrong sentence, and a failed check sends the draft to a person
    // instead of blocking it — which is the right cost for the one case where
    // the negative is the answer.
    pattern:
      /\b(n['’](?:est|a)\s+pas\s+(?:spécifiquement\s+|vraiment\s+|particulièrement\s+)?(?:adapté|adaptée|conçu|conçue|formulé|formulée|recommandé|recommandée|indiqué|indiquée)|ne\s+sont\s+pas\s+(?:spécifiquement\s+|vraiment\s+|particulièrement\s+)?(?:adaptés|adaptées|conçus|conçues|formulés|formulées|recommandés|recommandées|indiqués|indiquées)|ne\s+convien(?:t|nent)\s+pas|déconseillé)/i
  },
  {
    check: 'no_internal_selection_name',
    label: 'cite une sélection interne ou une marque entre crochets',
    // MEASURED on ticket 05c1b539 (2026-09-20): a reply went out with
    // « **Crèmes Hydratantes, Soins Hydratants** » as a heading and « *Caresse
    // Sensi Zen* [Soins Peaux Sensibles] » as a line. Both are the shop's own
    // grouping, restated to a customer as if it were advice — the case file
    // carried them as notation and both models copied them through.
    //
    // The tool no longer emits either (tool-registry `adviceText` names the
    // group in the customer's own word and states the fit in prose). This is the
    // check that says so, on every reply.
    //
    // THE LINK MARKER IS THE ONE BRACKET A REPLY MAY CARRY — « [[ici]] » is the
    // approved placeholder, so it is removed before the rest is examined.
    prepare: (body) => body.replace(/\[\[[^\]]*\]\]/g, ' '),
    // Bracket notation of any kind, and the « Diag - » prefix the shop's quiz
    // collections carry. No collection title is hard-coded: the titles are the
    // shop's and change whenever somebody curates.
    pattern: /(\[[^\]]{3,}\]|\bDiag\s*-\s)/
  },
  {
    check: 'no_carrier_scan_wording',
    label: 'révèle que nous ne recevons aucun scan transporteur',
    // NOT GATED ON THE CAVEAT, unlike the prohibition above. This wording is a
    // statement about our own integration — that no carrier feeds scan events
    // back to us — and it is not the customer's business on any ticket, whatever
    // the case file happened to raise.
    pattern: /\b(scan\w*)/i
  },
  {
    check: 'no_web_link',
    label: 'contient un lien',
    // NOTHING IN A CASE FILE IS A URL, so every link in a draft is one the model
    // produced from its own weights — a carrier page, a help centre, a shop
    // link. At best right and ugly; at worst a plausible address that goes
    // nowhere, sent by us, about their parcel.
    //
    // THE TRACKING LINK IS NOT AN EXCEPTION, it is the case that produced this
    // rule. Giving the model the fulfilment URL does put a link in the reply —
    // pasted in full mid-sentence, and once as « [Suivi Colissimo](https://…) »,
    // markdown that nothing renders because the reply is plain text. The parcel
    // NUMBER carries the same information and `TrackingText` makes it the link
    // on every surface that shows it, so the reply never needs the URL.
    //
    // Measured before the rule existed: of 92 stored drafts, ZERO contain one.
    // This forbids nothing the drafting has ever done.
    // Four shapes: a bare URL, a bare host, a markdown link, an HTML anchor.
    pattern: /(https?:\/\/\S+|\bwww\.\S+|\[[^\]]*\]\(\s*\S+\s*\)|<a\s[^>]*href=)/i
  },
  {
    check: 'no_internal_machinery',
    label: 'mentionne un rouage interne',
    // Straight out of the guardrails on the Brand voice page: no agents, tools,
    // databases, APIs, knowledge bases, search systems or internal processes.
    pattern:
      /\b(base de (?:connaissances|données)|notre (?:outil|système) (?:interne|de recherche)|une? (?:agent|assistant) (?:IA|automatique)|intelligence artificielle|notre API|dossier interne|niveau [1-4] |case file)\b/i
  }
];

/**
 * What an ACKNOWLEDGEMENT may not contain, on top of everything else.
 *
 * These apply only to a `needs_human` draft, and they exist because that reply
 * is written from the case file that could not resolve anything — sometimes from
 * no established fact at all. The prompt forbids all of it; these say whether it
 * obeyed.
 *
 * A DEADLINE IS THE ONE THAT COSTS MONEY. « Nous revenons vers vous sous 24
 * heures » is the single most natural sentence to end a holding reply with, it
 * is a commitment nobody in the building agreed to, and the customer who does
 * not hear back in 24 hours now has a second complaint that is entirely our
 * fault. It is also the only one with a clean textual signature, which is why it
 * is checked rather than hoped for.
 *
 * ASKING IS THE OTHER. The case file named nothing to ask for; a question in an
 * acknowledgement is one the model invented, and the customer will answer it.
 */
export const ACKNOWLEDGEMENT_PROHIBITIONS = [
  {
    check: 'no_promised_deadline',
    label: 'annonce un délai de réponse',
    pattern:
      /\b(sous \d+\s*(?:h|heures?|jours?|semaines?)|d[’']ici (?:demain|lundi|mardi|mercredi|jeudi|vendredi|la fin|le)|dans les (?:\d+|prochaines?|prochains?)\s*(?:\d+\s*)?(?:h|heures?|jours?)|sous \d+\s*à\s*\d+|avant (?:demain|la fin de (?:la journée|la semaine)))/i
  },
  {
    check: 'no_promise',
    label: 'promet une issue',
    // « nous allons VOUS rembourser » is how it is actually written, so the
    // optional pronoun is the difference between this firing and never firing.
    pattern:
      /\b(nous (?:allons|vous|pourrons) (?:vous )?(?:rembours|renvoy|réexpédi|remplac|procéder au rembours)\w*|un (?:remboursement|renvoi|remplacement) (?:vous )?(?:sera|est) |nous vous (?:rembourserons|renverrons|enverrons|remplacerons))/i
  },
  {
    check: 'no_completed_action',
    label: 'laisse entendre qu’une vérification a déjà eu lieu',
    // « Après vérification, nous avons constaté… » is a real sentence from this
    // desk's own outbound mail, and on a needs_human ticket it is false: the
    // verification is the thing that has NOT happened yet. « Nous avons bien
    // reçu votre message » is fine and must stay fine, so the pattern is keyed
    // on the verbs of checking, never on « nous avons ».
    pattern:
      /\b(nous avons (?:bien )?(?:vérifié|contrôlé|examiné|confirmé|constaté|contacté|traité|corrigé|résolu)|après (?:vérification|examen|contrôle|analyse)|notre équipe a (?:déjà )?(?:vérifié|examiné|confirmé|contacté|traité))/i
  }
];

/**
 * The language the approved closing line and signature are written in.
 *
 * A CONSTANT AND NOT A FIELD, honestly: the whole brand voice — role, tone,
 * framework, guardrails, signature — is authored in French in the dashboard, and
 * the drafting prompt is itself French. There is nowhere to store "which
 * language is this wording in" and nothing that would write it. Named here so
 * the assumption is visible rather than implied by a `!== 'fr'`.
 */
export const SIGNATURE_LANGUAGE = 'fr';

/**
 * Runs every check against a drafted body.
 *
 * Returns one entry per check with `passed` either true, false, or null for the
 * advisory ones — never a bare list of failures, because the record of what was
 * examined is the part that stays useful after the draft is approved.
 */
/**
 * The subjects where a parcel number is part of the answer.
 *
 * `order` and `delivery` only. The other subjects can carry a confirmed order —
 * a return, a payment question, a reaction — without the parcel being what the
 * customer asked about.
 */
const PARCEL_SUBJECTS = ['order', 'delivery'];

export function runDraftChecks({
  body = '',
  doNotClaim = [],
  missing = [],
  verdict = 'answerable',
  // True when the thread proves the customer wrote again before we answered.
  chased = false,
  closingLine = '',
  signature = '',
  // The reply's language. Only the signature check reads it, and only to know
  // whether the approved wording should have been reproduced or translated.
  language = SIGNATURE_LANGUAGE,
  // The parcels on this ticket's CONFIRMED order, as `resolved_context` holds
  // them. Empty for the ticket with no confirmed order, which is most of them.
  parcels = [],
  // The ticket's subject. Read by one check, to know whether this reply is about
  // where a parcel is.
  category = null,
  // The `{ url, label }` the matched rule offered, or null. Read by the two link
  // checks: one marker when there is a link, none when there is not.
  replyLink = null,
  // True when this draft is the short reply that closes the case. Read by one
  // check, which stands down rather than failing a reply for not apologising.
  closing = false
} = {}) {
  const isHandover = verdict === 'needs_human';
  const text = String(body || '');
  const checks = [];

  // --- the prohibitions this case file actually raised -----------------------
  //
  // `do_not_claim` stores the RENDERED sentence, not the code that produced it
  // (04_support.sql), so the table is inverted to get back to the codes. Only
  // the caveats this ticket raised are checked: running all of them would flag
  // a draft for a prohibition nobody imposed on it.
  const codes = caveatCodesFor(doNotClaim);

  for (const code of codes) {
    const prohibition = MECHANICAL_PROHIBITIONS[code];
    if (!prohibition) {
      continue;
    }
    const hit = text.match(prohibition.pattern);
    checks.push({
      check: `do_not_claim:${code}`,
      passed: !hit,
      detail: hit ? `${prohibition.label} — « ${hit[0]} »` : prohibition.label
    });
  }

  for (const code of codes.filter((code) => ADVISORY_CAVEATS.includes(code))) {
    checks.push({
      check: `do_not_claim:${code}`,
      // NULL, NOT TRUE. This prohibition was imposed and not examined, and
      // recording it as a pass would make the suite claim coverage it has not
      // got.
      passed: null,
      detail: `not mechanically checkable — read it: ${CAVEATS[code]}`
    });
  }

  // --- what no reply may contain -------------------------------------------
  for (const { check, label, pattern, prepare } of FORBIDDEN_PATTERNS) {
    // A check may exempt part of the reply before matching — the approved link
    // marker « [[ici]] » is the one bracket a draft is allowed to carry.
    const hit = (prepare ? prepare(text) : text).match(pattern);
    checks.push({
      check,
      passed: !hit,
      detail: hit ? `${label} — « ${hit[0]} »` : label
    });
  }

  // --- the link a rule offers ---------------------------------------------
  //
  // THE MARKER IS HOW THE LINK TRAVELS, so both directions are checked. With a
  // link: exactly one marker — none leaves the customer without it, two puts two
  // anchors on one page. Without one: no marker at all, because a marker nothing
  // can link reaches the customer as « [[ici]] ».
  const markers = findLinkMarkers(text);
  const link = normaliseReplyLink(replyLink);
  if (link) {
    checks.push({
      check: 'link_placed',
      passed: markers.length === 1,
      detail:
        markers.length === 1
          ? `propose le lien — « ${markers[0].anchor} »`
          : markers.length === 0
            ? `le dossier propose un lien (${link.label}) et la réponse ne l’inclut pas`
            : `place le lien ${markers.length} fois au lieu d’une`
    });
  } else if (markers.length > 0) {
    checks.push({
      check: 'no_orphan_link_marker',
      passed: false,
      detail: `contient un marqueur de lien sans lien à y mettre — « [[${markers[0].anchor}]] »`
    });
  }

  // --- the parcel number, when we are holding one --------------------------
  //
  // NOT A PROHIBITION BUT AN OBLIGATION, and the only one in this file. Every
  // other check here proves a sentence is ABSENT; this one proves a fact was
  // PASSED ON. It exists because the alternative is leaving it to the model's
  // discretion, and a tracking number withheld is a customer who has to write
  // again to ask for the thing we were already holding.
  //
  // WHY A CHECK RATHER THAN CODE THAT APPENDS IT. The same reason the signature
  // is prompted and then verified rather than concatenated: the number belongs
  // in a sentence, not bolted to the end of one, and the mechanism is proven —
  // the signature check passes 81/81. The prompt already carries the number and
  // never the URL (`toOrderContextText`), so `no_web_link` still forbids the
  // link and this asks only that the number itself was used.
  //
  // SCOPED TO ORDER AND DELIVERY, deliberately narrow. A cosmetovigilance reply
  // about a reaction has no business quoting a tracking number just because the
  // order it came from carries one, and firing there would be the check
  // overreaching — which is how a check earns being ignored.
  //
  // MEASURED BEFORE IT WAS WRITTEN: of 1,487 fulfilled web orders, 1,483 carry a
  // number, so this fires on nearly every dispatched order ticket. The four that
  // do not are why the SKELETON must stay conditional — an instruction to give a
  // number the dossier lacks is how one gets invented.
  const numbers = (Array.isArray(parcels) ? parcels : [])
    .map((parcel) => String(parcel?.number ?? '').trim())
    .filter(Boolean);

  if (numbers.length > 0 && PARCEL_SUBJECTS.includes(category)) {
    // Spaces stripped on both sides: a model that writes « 6C21 1087 11964 » has
    // passed the number on, and failing that would be pedantry about whitespace.
    const packed = text.replace(/\s+/g, '');
    const given = numbers.filter((number) => packed.includes(number.replace(/\s+/g, '')));
    checks.push({
      check: 'tracking_number_given',
      passed: given.length > 0,
      detail:
        given.length > 0
          ? `parcel number passed to the customer — ${given.join(', ')}`
          : `the dossier holds ${numbers.join(', ')} and the reply names no parcel number`
    });
  }

  // --- asking, and when it is allowed at all ------------------------------
  //
  // ONE RULE ACROSS ALL THREE VERDICTS: a reply may ask for a fact only if the
  // case file named it. That single line implements three separate instructions
  // — « ne pas demander d'information supplémentaire » on an answer, « demander
  // uniquement cette information » on a question, and « ne demander une
  // information que si le dossier en nomme une » on a handover — because they
  // are the same rule seen from three sides.
  //
  // An `answerable` case file never licenses a question, even if it happens to
  // carry a `missing` entry: the verdict says the dossier is sufficient, and a
  // follow-up question on top of a complete answer is the padding the brand
  // voice explicitly rejects.
  const mustAsk = verdict !== 'answerable' && missing.length > 0;

  if (mustAsk) {
    for (const field of missing) {
      const key = field?.field;
      const ask = MISSING_FIELDS[key]?.ask;
      if (!ask) {
        continue;
      }
      const haystack = foldAccents(normalise(text).toLowerCase());
      const terms = ASK_TERMS[key] || [];
      const absent = terms.filter((term) => !haystack.includes(foldAccents(term)));

      // ASK_TERMS IS FRENCH VOCABULARY, so on a reply in another language this
      // can only report absence of French words from a correct foreign-language
      // question — « numero d'ordine » does not contain « commande ». Advisory
      // there, for the same reason the translated signature is: a check that
      // cannot examine something must say so rather than fail it.
      //
      // Not yet observed, and that is luck rather than safety: all 5 non-French
      // drafts so far were `needs_human` or `answerable`, and this fires only on
      // `needs_customer_input`. The first foreign-language question would have
      // been held back for missing words it had no reason to contain.
      const examinable = language === SIGNATURE_LANGUAGE;
      checks.push({
        check: `asks:${key}`,
        passed: examinable ? absent.length === 0 : null,
        detail: !examinable
          ? `réponse en ${language} — les termes attendus sont français, à lire : ${MISSING_FIELDS[key].label}`
          : absent.length === 0
            ? `demande bien ${MISSING_FIELDS[key].label}`
            : `ne demande pas ${MISSING_FIELDS[key].label} (« ${absent.join(' », « ')} » absent)`
      });
      checks.push({
        check: `asks_verbatim:${key}`,
        // ADVISORY. Reproduced word for word or not — worth counting across a
        // batch, never a reason to hold a draft back.
        passed: null,
        detail: haystack.includes(foldAccents(normalise(ask).toLowerCase()))
          ? `reprise mot pour mot (${key})`
          : `reformulée (${key})`
      });
    }
  } else {
    // Nothing was named, so any request is one the model invented — and the
    // customer will answer it, which turns a finished reply into a thread
    // nobody meant to open.
    const asked = text.match(
      /(?:pourriez|pouvez|puis-je|merci de nous (?:indiquer|communiquer|préciser|transmettre))[^.?!]*\?/i
    );
    checks.push({
      check: 'no_invented_question',
      passed: !asked,
      detail: asked
        ? `pose une question que le dossier ne demande pas — « ${asked[0].trim()} »`
        : 'ne pose aucune question non demandée'
    });
  }

  // --- what only a handover reply is forbidden -----------------------------
  if (isHandover) {
    for (const { check, label, pattern } of ACKNOWLEDGEMENT_PROHIBITIONS) {
      const hit = text.match(pattern);
      checks.push({ check, passed: !hit, detail: hit ? `${label} — « ${hit[0]} »` : label });
    }
  }

  // --- the apology we owe --------------------------------------------------
  //
  // ONLY WHEN THE THREAD PROVES IT. The rule in the prompt is broader — it also
  // covers a customer who says they have been waiting — but a check has to rest
  // on something checkable, and "they wrote again before we replied" is a fact
  // about the envelopes. The stated-only cases stay the prompt's job.
  // A CLOSING REPLY IS EXEMPT, and `1e4890dd` is why. The thread proves a chase —
  // consecutive inbound messages with nothing back — so the check fires; but the
  // message being answered is « Je vous remercie d'avoir répondu à mes messages ».
  // The customer is telling us the wait ended. An apology for our delay, in the
  // three-line reply that closes the case, answers a complaint they have just
  // withdrawn.
  //
  // REPORTED, NOT DROPPED. `passed: null` keeps the line visible with the reason,
  // the same treatment every other unexaminable check gets, so a reviewer sees
  // the chase was noticed and deliberately not apologised for.
  if (chased && closing) {
    checks.push({
      check: 'apologises_for_delay',
      passed: null,
      detail: 'réponse de clôture — le client a confirmé avoir reçu nos réponses'
    });
  } else if (chased) {
    // ALL FOUR LANGUAGES THE CORPUS ACTUALLY DRAFTS IN (fr 77 · it 2 · es 1 ·
    // en 1). The first version matched French only and failed an Italian draft
    // that opened « Ci scusiamo per il ritardo nella risposta » — a correct reply
    // marked wrong, which is how a check earns being ignored.
    const apology = text.match(APOLOGY);
    checks.push({
      check: 'apologises_for_delay',
      passed: Boolean(apology),
      detail: apology
        ? `s’excuse du délai — « ${apology[0]} »`
        : 'le client a écrit plusieurs fois sans réponse et la réponse ne s’en excuse pas'
    });
  }

  // --- the approved closing line, and anything invented beside it ----------
  //
  // MEASURED 2026-08-19: left to the model, 31 of 81 drafts ended with a
  // courtesy line and worded it 31 different ways. The line is worth saying, so
  // it is approved once and reproduced — checked here exactly as the signature
  // is, which is the mechanism already proven at 81/81.
  if (closingLine) {
    checks.push({
      check: 'closing_line',
      passed: normalise(text).includes(normalise(closingLine)),
      detail: 'reprend la formule de clôture approuvée'
    });
  }

  // What is left after removing every APPROVED block is a closer the model wrote
  // itself. ADVISORY, NOT A FAILURE: it is a weak sentence, not a wrong one, and
  // `checks_passed` gates auto-send — refusing an otherwise correct reply for
  // being too polite would be the check overreaching.
  //
  // THE SIGNATURE IS STRIPPED TOO, and that is not belt-and-braces. Whoever
  // maintains the brand voice may put the courtesy sentence in either field —
  // measured on the live row, it was written into the signature before this
  // field existed — and text a person approved is not text a model invented,
  // wherever it was approved.
  const withoutApproved = [closingLine, signature]
    .filter(Boolean)
    .reduce((acc, approved) => acc.split(normalise(approved)).join(' '), normalise(text));
  const invented = withoutApproved.match(INVENTED_CLOSER);
  checks.push({
    check: 'empty_closer',
    passed: null,
    detail: invented
      ? `formule de politesse non approuvée — « ${invented[0]} »`
      : 'aucune formule de politesse inventée'
  });

  // --- the approved signature ----------------------------------------------
  //
  // THREE STATES, BECAUSE THE APPROVED WORDING IS FRENCH. A reply in Italian
  // that ends « Bien Cordialement, / Service Client Qiriness » obeyed the prompt
  // exactly and is still wrong, and that is what shipped: all 5 non-French
  // drafts written before this closed in French, and all 5 passed.
  //
  //   fr        — character-for-character, as it always was.
  //   other     — advisory. A translated signature cannot be compared to the
  //               source, and a pattern loose enough to accept every language
  //               would accept anything.
  //   other, but ENDING IN THE FRENCH WORDING — a real failure, and the only
  //               mechanical statement worth making here: the model reproduced
  //               the source instead of translating it.
  if (signature) {
    const endsWithApproved = normalise(text).endsWith(normalise(signature));
    const translated = language !== SIGNATURE_LANGUAGE;

    checks.push({
      check: 'signature',
      // ENDS WITH, not contains: a signature in the middle of a reply is a
      // model that carried on writing after signing off.
      passed: translated ? (endsWithApproved ? false : null) : endsWithApproved,
      detail: translated
        ? endsWithApproved
          ? `réponse en ${language} terminée par la signature française, non traduite`
          : `signature traduite en ${language} — non comparable au texte approuvé, à lire`
        : 'se termine par la signature approuvée'
    });
  }

  return checks;
}

/**
 * Whether a draft may be treated as sendable.
 *
 * An advisory check (`passed: null`) does NOT fail the draft — it was never
 * examined, and refusing every draft carrying an unexaminable prohibition would
 * refuse most of them. It is why `checks_passed` means "nothing known-wrong was
 * found" and not "this is correct".
 */
export function checksPassed(checks = []) {
  return checks.every((check) => check.passed !== false);
}

/** The failures, as a reviewer needs to read them. */
export function failedChecks(checks = []) {
  return checks.filter((check) => check.passed === false).map((check) => check.detail);
}

/**
 * The words that NAME each requestable fact. All of them must appear.
 *
 * A third copy of the `MISSING_FIELDS` vocabulary, which this codebase normally
 * refuses — and the reason it earns an exception is that neither of the other
 * two copies can do this job. The `ask` is a whole sentence, most of it
 * grammatical scaffolding the model is right to rewrite; the `label` carries
 * filler adjectives (« le produit *concerné* ») that a correct question has no
 * reason to repeat. What is left is the noun a reply cannot ask for this fact
 * without using, and that has to be stated somewhere.
 *
 * SHORT AND STEMMED, on purpose. `numero` rather than `numéro de commande` so
 * word order does not matter, and accents are folded before comparison because
 * « e-mail » and « é-mail » are the same word to a reader. Matched as
 * substrings, so `commande` also covers `commandes`.
 *
 * The migration-test pattern guards the copy: `draft-checks.test.mjs` asserts
 * every `MISSING_FIELDS` key has an entry here, so adding a requestable fact
 * without deciding how to check for it fails the suite.
 */
export const ASK_TERMS = {
  shopify_order_number: ['numero', 'commande'],
  purchase_email: ['adresse', 'mail'],
  // `compte` rather than `mail`, which is what separates this from the question
  // above: both ask for an address, and only the noun says WHICH address.
  account_email: ['adresse', 'compte'],
  product_name: ['produit'],
  // « en boutique ou sur le site » is the question, and `boutique` is the half a
  // reply cannot omit — the whole point is to find out whether the sale happened
  // somewhere Shopify never saw.
  purchase_channel: ['boutique'],
  photo: ['photo'],
  promotion_code: ['code'],
  order_date_or_amount: ['date', 'montant'],
  // `produit` ALONE, not « quel produit » — the question gets asked a dozen ways
  // (« lequel de nos soins », « le produit que vous utilisiez ») and the noun is
  // the only word all of them share. Same reasoning as `product_name` above,
  // which this duplicates rather than aliases: the two fields ask different
  // questions and could diverge.
  reaction_product_name: ['produit'],
  lot_number: ['lot']
};

// WHAT WE ALREADY ASKED FOR IS NOT DETECTABLE FROM `ASK_TERMS`, AND IT WAS TRIED.
//
// The obvious check on top of the thread history is: read our own sent replies
// through this same vocabulary, and flag a draft that asks again. It was built
// and measured over the 25 threads that carry both a customer reply and one of
// ours, and it does not work.
//
// MEASURED 2026-09-21. Whole-body matching claimed 2.4 fields per thread —
// `product_name` and `reaction_product_name` fired on 10 threads each, always
// together, because they share the single term « produit », which any reply
// mentioning a product contains. Narrowed to sentences carrying a request cue
// (« pourriez-vous », a question mark) it fell to 0.3 per thread and about half
// of what was left was still wrong: « Avez-vous effectué un retour de produit ? »
// is not a request for the product's name.
//
// THE DIRECTION IS WHAT BREAKS IT. `ASK_TERMS` exists to check that a draft DOES
// ask for something, where a false positive costs a reviewer a minute. Read
// backwards the failure inverts: a wrong hit suppresses a question the case file
// licensed, and the customer is never asked for the one fact that would let us
// help them. A check that fires on correct drafts is ignored within a week.
//
// So nothing is checked here, and the fix is the prompt instead: drafting is now
// shown our own replies and told not to repeat what they ask. Turning that into
// a guardrail needs the question recorded when it is ASKED rather than recovered
// from prose afterwards — which is the case state, not a regex.

/** « e-mail » and « é-mail » are the same word to a reader and must be here too. */
function foldAccents(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** The rendered prohibition back to the caveat code that produced it. */
function caveatCodesFor(doNotClaim) {
  const byText = new Map(Object.entries(CAVEATS).map(([code, line]) => [normalise(line), code]));
  return doNotClaim
    .map((line) => byText.get(normalise(String(line))))
    .filter(Boolean);
}

/**
 * Courtesy closers the model writes when nothing stops it.
 *
 * Includes « n'hesitez pas a revenir vers nous », which the brand voice's own
 * negative constraints call out by name. That phrase is not banned — it is the
 * approved closing line's own wording — so this pattern is only ever applied to
 * the text with the approved line removed. What it finds is therefore a second,
 * invented closer.
 */
export const INVENTED_CLOSER =
  /\b(merci (?:de|pour) votre (?:patience|comprehension|compréhension|cooperation|coopération)|nous restons . votre disposition|votre satisfaction est notre priorité|je vous remercie d['’]avance pour votre (?:cooperation|coopération)|n['’]hésitez pas . (?:revenir vers nous|nous contacter|nous écrire))/i;

/**
 * Apologising, in the languages this corpus is drafted in.
 *
 * Kept beside the other patterns rather than inlined because it is the one that
 * has to grow with `REPLY_LANGUAGES`: a language added to the taxonomy without
 * a token here produces a correct reply that fails a check.
 */
export const APOLOGY =
  /\b(désolé\w*|navré\w*|excus\w*|pardon|sorry|apolog\w*|scus\w*|spiacenti|rammarico|disculp\w*|lamentamos|sentimos)/i;

/** The blank-line-separated blocks of a reply. The last is the signature. */
function paragraphs(value) {
  return String(value)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/** Whitespace is the only difference that never matters here. */
function normalise(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
