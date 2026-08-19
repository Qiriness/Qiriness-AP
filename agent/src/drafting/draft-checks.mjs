import { CAVEATS, MISSING_FIELDS } from '../investigation/case-file.mjs';

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
  'product_ambiguous'
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
 * Runs every check against a drafted body.
 *
 * Returns one entry per check with `passed` either true, false, or null for the
 * advisory ones — never a bare list of failures, because the record of what was
 * examined is the part that stays useful after the draft is approved.
 */
export function runDraftChecks({
  body = '',
  doNotClaim = [],
  missing = [],
  verdict = 'answerable',
  closingLine = '',
  signature = ''
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
  for (const { check, label, pattern } of FORBIDDEN_PATTERNS) {
    const hit = text.match(pattern);
    checks.push({
      check,
      passed: !hit,
      detail: hit ? `${label} — « ${hit[0]} »` : label
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

      checks.push({
        check: `asks:${key}`,
        passed: absent.length === 0,
        detail:
          absent.length === 0
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
  if (signature) {
    checks.push({
      check: 'signature',
      // ENDS WITH, not contains: a signature in the middle of a reply is a
      // model that carried on writing after signing off.
      passed: normalise(text).endsWith(normalise(signature)),
      detail: 'se termine par la signature approuvée'
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
  product_name: ['produit'],
  // « en boutique ou sur le site » is the question, and `boutique` is the half a
  // reply cannot omit — the whole point is to find out whether the sale happened
  // somewhere Shopify never saw.
  purchase_channel: ['boutique'],
  photo: ['photo'],
  promotion_code: ['code'],
  order_date_or_amount: ['date', 'montant']
};

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
