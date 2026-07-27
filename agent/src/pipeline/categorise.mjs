// Phase 3 categoriser — assigns the (subject, request kind) pair that drives
// routing, knowledge retrieval, and the handling level.
//
// Restricted to classification only (least privilege): it reads the email text
// and returns labels. No tools, no order lookup, no database access — that is
// the runner's job.
//
// Three layers keep the output inside the taxonomy:
//   1. Structured Outputs enums built FROM the taxonomy module, so the model
//      cannot emit an off-list value in the first place.
//   2. normaliseCategorisation() below, which re-checks every field and fixes
//      the combinations a per-field enum cannot express (a `contact` kind on a
//      non-relationship subject, a secondary that repeats the primary).
//   3. The database check constraints in 03_categorisation.sql.
//
// Unlike the spam gate this does NOT fail open into a default label: a failed
// call leaves the ticket uncategorised so it is retried. Only the runner, after
// repeated failures, falls back — and it falls back *towards a human*.
//
// It also reads two signals off the same email — the reply language and the
// customer's happiness — because it has already paid to read the text; see
// SIGNALS_PROMPT. They qualify the ticket rather than classify it.
//
// Stateless by design: re-categorising a thread that has grown calls exactly this
// function again with the fuller thread, and it is never shown the labels it
// produced last time. Anchoring the model on its own previous answer would make
// it defend a first call that may well have been wrong (the same reason the
// human review set is labelled blind). Stability is bought in the runner instead,
// where the level ratchet stops a re-run walking a ticket backwards.

import {
  TICKET_SUBJECTS,
  REQUEST_KINDS,
  CONTACT_ONLY_SUBJECTS,
  REPLY_LANGUAGES,
  HAPPINESS_SCORES,
  defaultLevel,
  clampLevel,
  defaultTeam
} from '../../../scripts/lib/support-taxonomy.mjs';

// Enums come straight from the taxonomy module: adding a subject there updates
// the model's allowed values, the DB constraint (via a migration) and the
// dashboard from one place, with no second list to forget.
const CATEGORISATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: [...TICKET_SUBJECTS] },
    request_kind: { type: 'string', enum: [...REQUEST_KINDS] },
    // Nullable enums rather than optional properties: strict Structured Outputs
    // requires every property in `required`, so "absent" is expressed as null.
    secondary_category: { type: ['string', 'null'], enum: [...TICKET_SUBJECTS, null] },
    secondary_request_kind: { type: ['string', 'null'], enum: [...REQUEST_KINDS, null] },
    // enum, not minimum/maximum — strict mode does not support numeric bounds.
    level: { type: 'integer', enum: [1, 2, 3, 4] },
    // Two signals about the ticket rather than classifications of it. They ride
    // along on this call because the model has already read the email: asking
    // separately would double the cost to re-read the same text.
    //
    // There is deliberately no `confidence` field. It was asked for and came back
    // `high` on 171 of 171 real tickets and 40 of 40 review cases — Structured
    // Outputs emits fields in order, so the model rated an answer it had already
    // committed to, in the same forward pass, with nothing pushing it toward
    // calibration. A field that is constant carries no information and invites
    // exactly the wrong decision downstream. tickets.categorisation_confidence
    // survives, but only the runner's failure paths write it (see there).
    language: { type: 'string', enum: [...REPLY_LANGUAGES] },
    happiness: { type: 'integer', enum: [...HAPPINESS_SCORES] },
    reason: { type: 'string' }
  },
  required: [
    'category',
    'request_kind',
    'secondary_category',
    'secondary_request_kind',
    'level',
    'language',
    'happiness',
    'reason'
  ]
};

// Written in French (the mailbox is mostly French); the label *values* stay
// English because they are code enums.
const SUBJECT_GLOSSARY = [
  "- order : la commande AVANT son expédition — contenu, erreur de saisie, ajout ou retrait d'un article, annulation, prix ou quantité, confirmation de commande non reçue.",
  "- delivery : tout ce qui suit l'expédition — suivi, numéro de suivi, retard, colis perdu ou endommagé, article manquant à la réception, changement d'adresse d'un colis déjà parti, problème transporteur.",
  '- return_exchange : retour, échange, rétractation, remboursement.',
  "- product : question ou conseil sur un produit (utilisation, ingrédients, routine, résultats attendus).",
  '- product_stock : disponibilité, rupture de stock, réassort.',
  '- payment : paiement, moyen de paiement, débit, facture client.',
  '- account : compte client (connexion, mot de passe, newsletter, données du compte).',
  '- promotions : codes promo, réductions, offres, fidélité.',
  "- cosmetovigilance : effet indésirable, réaction cutanée, allergie, tout problème de santé lié à un produit.",
  '- legal_privacy : RGPD, données personnelles, mentions légales, demande juridique.',
  '- b2b : revendeurs, grossistes, pharmacies, achats professionnels, facturation B2B.',
  '- partner_collaboration : influenceurs, partenariats, presse, collaborations marketing.',
  "- careers : candidatures, stages, offres d'emploi.",
  '- other : rien de ce qui précède.'
].join('\n');

const KIND_GLOSSARY = [
  "- question : une réponse d'information suffit à satisfaire le client, sans consulter son dossier ni rien modifier.",
  "- problem : quelque chose ne va pas pour ce client précis, ou satisfaire sa demande exige de consulter son dossier (commande, livraison, compte, code promo) ou de MODIFIER quelque chose.",
  "- complaint : UNIQUEMENT une insatisfaction sans demande traitable — le client exprime son mécontentement mais ne demande rien qu'on puisse corriger. Dès qu'une demande concrète est formulée (remboursement, renvoi, suivi, correction), c'est un problem, même si le ton est très mécontent.",
  `- contact : PREMIÈRE prise de contact entrante d'une personne ou d'une entreprise qui n'est pas encore en relation — proposition de partenariat, candidature, demande de référencement. Uniquement pour ${CONTACT_ONLY_SUBJECTS.join(', ')}. Un partenaire ou revendeur DÉJÀ client qui pose une question (relevé de compte, facture, commande) n'est pas un contact : c'est une question ou un problem.`
].join('\n');

// The request kind is where the review set showed the model failing, in both
// directions: it read politeness as a question ("est-ce possible d'ajouter un
// produit ?" needs the order modified), and then, once told to look past the
// phrasing, read a plain status enquiry as an incident. So the rule is stated
// symmetrically — what must be DONE decides, and each branch names the cases the
// other one keeps stealing.
const KIND_TIEBREAKER = [
  "Pour choisir le type, demande-toi ce qu'il faut FAIRE, pas comment la phrase est tournée :",
  "- question : une réponse générale suffit, valable pour n'importe qui (« quel est le délai de rétractation ? », « ce produit convient-il aux peaux sensibles ? », « acceptez-vous PayPal ? »).",
  "- problem : il faut ouvrir le dossier DE CE CLIENT pour répondre (« où est mon colis ? », « mon code promo est refusé », « je n'ai pas reçu ma facture ») ou modifier quelque chose (remboursement, renvoi, annulation, changement d'adresse). Une demande polie ou tournée en question reste un problem.",
  "- complaint : réservé au mécontentement SANS demande traitable. « Colis perdu, remboursez-moi » écrit en colère est un problem, pas un complaint : la colère se traduit par le niveau, pas par le type. « Votre service est lamentable » sans autre demande est un complaint.",
  "- Un compliment ou un remerciement n'est jamais un complaint : utilise question."
].join('\n');

// The per-ticket signals. Kept as their own block because they answer
// "what else does the next stage need to know about this email", not "what is
// this email about" — and because the happiness scale is the one place the model
// is explicitly told NOT to let its judgement leak into the level.
const SIGNALS_PROMPT = [
  "Langue de réponse (language) : la langue dans laquelle le client a écrit, donc celle dans laquelle il faudra lui répondre.",
  `Valeurs possibles : ${REPLY_LANGUAGES.filter((code) => code !== 'other').join(', ')}, ou other.`,
  "Utilise other UNIQUEMENT si la langue n'est dans aucune de ces valeurs. Si le message mélange deux langues, choisis celle du corps du message, pas celle de la formule de politesse.",
  '',
  "Satisfaction du client (happiness), échelle 1 à 4 — ce que RESSENT le client, pas la gravité du dossier :",
  '- 1 : client content — remerciements, compliment, ton chaleureux, ou simple satisfaction exprimée.',
  "- 2 : neutre — demande factuelle, aucune émotion particulière. C'est le cas le plus fréquent.",
  "- 3 : mécontentement exprimé — agacement, déception, impatience, reproche, « c'est décevant », « je suis déçue », relance polie mais sèche.",
  '- 4 : très mécontent — le client dit que la situation est inacceptable, menace de ne plus commander, parle de mauvaise expérience générale, exige une réponse, ou signale qu\'il a déjà écrit plusieurs fois sans réponse.',
  "Un client qui relance pour la deuxième ou troisième fois sans avoir eu de réponse est au minimum 3, et 4 s'il le reproche explicitement.",
  "IMPORTANT : happiness et level sont indépendants. Un client furieux qui demande seulement où est son colis reste un level 2 : sa colère se met dans happiness, pas dans level. À l'inverse un client parfaitement aimable qui demande un remboursement est un level 3 avec un happiness 2."
].join('\n');

const SYSTEM_PROMPT = [
  "Tu es l'agent de catégorisation du service client de Qiriness, une marque de soin de la peau. La plupart des e-mails sont en français.",
  '',
  "Tu classes chaque e-mail sur DEUX axes séparés : le sujet (de quoi il s'agit) et le type de demande (ce que veut l'expéditeur).",
  '',
  'Sujets possibles (category) :',
  SUBJECT_GLOSSARY,
  '',
  'Types de demande possibles (request_kind) :',
  KIND_GLOSSARY,
  KIND_TIEBREAKER,
  '',
  "Choisis le sujet PRINCIPAL, celui qui motive l'e-mail.",
  "Exception : si l'e-mail signale un effet indésirable, une réaction ou un problème de santé lié à un produit, le sujet principal est TOUJOURS cosmetovigilance et le type est problem — même si la question explicitement posée porte sur autre chose (composition, remboursement, retour). Un signalement d'effet indésirable n'est jamais une simple question : le signalement prime sur la question.",
  "En revanche, une question préventive, où AUCUNE réaction n'a eu lieu (« je suis allergique au nickel / enceinte, vos produits me conviennent-ils ? »), reste une question sur le produit : ce n'est pas un signalement.",
  "secondary_category : la plupart des e-mails n'en ont PAS — mets null par défaut.",
  "Ne le renseigne que si l'e-mail contient DEUX demandes distinctes, qui pourraient être traitées séparément par deux personnes différentes (par ex. un colis abîmé ET une question de réapprovisionnement pour un futur achat).",
  "Une seule demande vue sous deux angles n'est PAS un second sujet : une erreur de commande qui impliquerait un retour, un colis non livré rattaché à une commande, une facture liée à un paiement — dans tous ces cas, choisis le sujet principal et laisse secondary_category à null.",
  'Ne répète jamais le sujet principal. Si tu renseignes secondary_category, renseigne aussi secondary_request_kind, qui peut différer du premier.',
  '',
  'Niveau de traitement (level), échelle 1 à 4 :',
  "- 1 : répondable à partir de la base de connaissances seule.",
  "- 2 : il suffit de CONSULTER (commande, livraison, compte, code promo) puis de répondre — rien n'est modifié. C'est le cas le plus fréquent : « où est mon colis », « mon code promo est refusé », « quel est le numéro de suivi ». Vaut aussi pour un conseil qui règle la demande, par ex. une réaction cutanée légère.",
  "- 3 : il faut MODIFIER quelque chose pour satisfaire le client (remboursement, renvoi, annulation, changement d'adresse, geste commercial, suppression de données RGPD, correction de compte). Une demande RGPD ou juridique ordinaire est un niveau 3 : elle est traitée par un humain, pas par un responsable.",
  "  La différence 2 / 3 est exactement « consulter et répondre » contre « changer quelque chose ».",
  "  Attention : regarde ce qu'il faudra FAIRE pour résoudre la situation, pas seulement ce que le client écrit. Beaucoup de clients demandent poliment « des informations » alors que seul un acte règle leur problème. Sont des niveaux 3 même formulés comme une demande d'information :",
  "    · colis perdu, jamais livré, retourné à l'expéditeur, ou bloqué depuis longtemps (il faudra renvoyer ou rembourser) ;",
  '    · articles manquants ou cassés à la réception (il faudra renvoyer ou rembourser) ;',
  "    · changement ou correction d'adresse ;",
  '    · demande de remboursement, de geste commercial, de renvoi, de retour, ou de frais de port offerts ;',
  '    · réclamation formelle sur une commande.',
  "  Reste au niveau 2 quand la réponse est réellement une information à retrouver et à transmettre : numéro de suivi existant, statut d'un colis en cours d'acheminement normal, contenu ou date d'une commande, raison du refus d'un code promo.",
  "- 4 : RARE. Uniquement dans ces trois cas, et jamais par défaut :",
  "    · menace explicite d'action en justice, de plainte, d'avocat ou de mise en cause publique (presse, réseaux sociaux) ;",
  '    · hospitalisation ;',
  '    · blessure grave ou danger grave pour la personne.',
  "  Le niveau 4 dépend de la GRAVITÉ décrite dans l'e-mail, jamais du sujet. Une réaction cutanée, une allergie légère, une irritation, un client très mécontent ou une demande RGPD ne sont PAS des niveaux 4.",
  "  Si tu choisis 4, nomme explicitement le déclencheur dans reason (par ex. « menace de plainte » ou « hospitalisation »).",
  "Le niveau plancher est calculé automatiquement à partir de (sujet, type) et ne peut jamais être abaissé : ta valeur ne sert qu'à signaler une escalade quand l'e-mail est plus grave que sa catégorie ne le laisse penser.",
  '',
  SIGNALS_PROMPT,
  '',
  "reason : une seule ligne très courte (12 mots maximum) justifiant le classement.",
  "N'invente aucune information et ne réponds pas au client : tu ne fais que classer."
].join('\n');

export function createCategoriser(openai, { model, maxBodyChars = 3000 } = {}) {
  /**
   * @param {{subject?: string, messages: Array<{subject?: string, body_text?: string, received_at?: string}>}} input
   * @returns {Promise<{category, request_kind, secondary_category, secondary_request_kind, level, responsible_team, language, happiness, reason, model}>}
   */
  async function categorise(input) {
    const raw = await openai.completeJson({
      model,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input, maxBodyChars),
      schema: CATEGORISATION_SCHEMA,
      schemaName: 'ticket_categorisation',
      maxTokens: 300
    });
    return { ...normaliseCategorisation(raw), model };
  }

  return { categorise };
}

/**
 * Re-derives every stored field from the model's raw answer. Exported for tests
 * and reusable by any future re-categorisation path (a human relabelling a
 * ticket must land on the same level and team as the agent would).
 */
export function normaliseCategorisation(raw = {}) {
  const category = TICKET_SUBJECTS.includes(raw.category) ? raw.category : 'other';

  // Fallback kind is `problem`, not `question`: an unusable answer should raise
  // the level floor (3 -> a human sees it), never lower it.
  let requestKind = REQUEST_KINDS.includes(raw.request_kind) ? raw.request_kind : 'problem';
  requestKind = coerceContactKind(category, requestKind);

  const { secondaryCategory, secondaryRequestKind } = normaliseSecondary(raw, category);

  // The floor is the strictest of both pairs: an order question that also asks
  // for a return is level 3, not level 2, because the secondary pair is what
  // actually needs the action. The model may escalate above the floor
  // (clampLevel) but never below it.
  const primaryLevel = clampLevel(category, requestKind, raw.level);
  const secondaryFloor = secondaryCategory ? defaultLevel(secondaryCategory, secondaryRequestKind) : 1;

  return {
    category,
    request_kind: requestKind,
    secondary_category: secondaryCategory,
    secondary_request_kind: secondaryRequestKind,
    level: Math.max(primaryLevel, secondaryFloor),
    // Routing follows the primary subject; Phase 5 consumes this.
    responsible_team: defaultTeam(category),
    // Null rather than a default: "we do not know what language this is" is a
    // real state the drafting agent must handle, and defaulting to fr (or to a
    // neutral 2) would hide it behind a value that looks measured.
    language: REPLY_LANGUAGES.includes(raw.language) ? raw.language : null,
    happiness: HAPPINESS_SCORES.includes(raw.happiness) ? raw.happiness : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null
  };
}

/**
 * `contact` describes an inbound relationship approach, so it is meaningless on
 * a customer-service subject. A per-field enum cannot express that pair rule, so
 * (order, contact) is read as a plain enquiry instead.
 */
function coerceContactKind(subject, kind) {
  if (kind === 'contact' && !CONTACT_ONLY_SUBJECTS.includes(subject)) {
    return 'question';
  }
  return kind;
}

function normaliseSecondary(raw, primaryCategory) {
  const candidate = raw.secondary_category;
  // A secondary that repeats the primary carries no information, and a secondary
  // kind without a subject violates tickets_secondary_pair_check — drop the pair
  // in both cases rather than writing a row the database would reject.
  if (!TICKET_SUBJECTS.includes(candidate) || candidate === primaryCategory) {
    return { secondaryCategory: null, secondaryRequestKind: null };
  }
  const kind = REQUEST_KINDS.includes(raw.secondary_request_kind)
    ? coerceContactKind(candidate, raw.secondary_request_kind)
    : 'question';
  return { secondaryCategory: candidate, secondaryRequestKind: kind };
}

/**
 * The first inbound message defines what the ticket is about; a later one can
 * change it (an order question that becomes a complaint), so the most recent is
 * appended when the thread has grown. Both ends matter and the middle rarely
 * does: the first says what was originally asked, the latest says where the
 * customer stands now — which is what happiness and any escalation are read from.
 *
 * Deliberately sends subject + body only — no sender address or display name,
 * which classification does not need.
 */
function buildUserPrompt(input, maxBodyChars) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const first = messages[0];
  const latest = messages.length > 1 ? messages[messages.length - 1] : null;

  const lines = [
    `Objet : ${input?.subject || first?.subject || '(aucun)'}`,
    '',
    'Premier message du client :',
    truncate(first?.body_text, maxBodyChars) || '(vide)'
  ];

  if (latest) {
    lines.push('', 'Dernier message du fil :', truncate(latest.body_text, maxBodyChars) || '(vide)');
  }

  return lines.join('\n');
}

function truncate(text, maxChars) {
  return String(text || '').slice(0, maxChars);
}
