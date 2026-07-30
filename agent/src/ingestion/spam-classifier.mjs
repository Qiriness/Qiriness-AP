// LLM spam classifier — the second pass after the deterministic blocklist. Runs
// on new-conversation mail before it is written, so classified spam is dropped
// and never stored. Fails OPEN: any error keeps the email (never lose genuine mail).

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', enum: ['keep', 'spam', 'irrelevant'] },
    reason: { type: 'string' }
  },
  required: ['label', 'reason']
};

// Context is written in French (the mailbox is mostly French). The label *values*
// stay English because they are code enums (keep | spam | irrelevant); only the
// instructions are French.
const SYSTEM_PROMPT = [
  "Tu es un filtre anti-spam pour la boîte de réception du service client de Qiriness, une marque de soin de la peau. La plupart des e-mails sont en français.",
  "Classe chaque e-mail avec exactement une étiquette :",
  "- \"spam\" : e-mails non sollicités, démarchage commercial, prospection SEO/netlinking, propositions d'essai gratuit d'un produit (e-mails de vente), rapports DMARC, hameçonnage, arnaques, publicité sans rapport.",
  "- \"irrelevant\" : pas du spam, mais sans rapport avec le support client : notifications automatiques de systèmes ou de prestataires (paiement, publicité, hébergement), newsletters simplement reçues par la marque, e-mails de test, accusés de réception automatiques.",
  "ATTENTION : un e-mail interne (entre collègues de Qiriness) qui concerne un CLIENT — relance d'une cliente, numéro de suivi à transmettre, décision de remboursement, demande de réinitialisation de mot de passe — n'est PAS irrelevant : c'est du travail client transmis en interne, à garder. N'utilise irrelevant que si aucun client n'est concerné.",
  "- \"keep\" : tout message légitime que le support doit voir — questions ou problèmes concernant un produit, une commande ou Qiriness en général ; livraison et retours ; réclamations ; conseils produit ; e-mails B2B financiers ou logistiques (par ex. facture manquante, avis de problème de stock ou d'inventaire) ; propositions d'influenceurs ou de collaboration, y compris candidatures et offres d'emploi (« je suis influenceur/influenceuse dans ce domaine », CV joint, portfolio, etc.).",
  "Indice : un expéditeur au nom d'une personne réelle (prénom + nom) avec une adresse grand public (gmail.com, outlook.com, hotmail.fr, yahoo.fr, etc.) est en général un client — à garder.",
  "Expéditeurs de confiance connus : mailer@shopify.com (notifications Qiriness/Shopify) et les personnes physiques.",
  "En cas de doute, choisis \"keep\". Ne classe jamais en \"spam\" un e-mail potentiellement authentique d'un client.",
  "Donne toujours un \"reason\" : une seule ligne très courte (12 mots maximum) justifiant l'étiquette.",
  "Si tu choisis \"keep\" par précaution, sans être réellement certain que l'e-mail est légitime, écris exactement \"unsure\" comme reason."
].join('\n');

// `irrelevant` drops as well as `spam`. It was previously labelled and then kept
// anyway, which made the label decorative: automated notices, FYI forwards of a
// payment provider's mail and test messages all became tickets a human had to
// close. Both outcomes still write a spam_audit row, so a wrongly dropped email
// is reviewable and can be promoted back by hand — the audit trail is the
// "irrelevant section", not a silent deletion.
//
// The risk this adds is real and bounded: previously nothing could be lost to an
// `irrelevant` verdict. The prompt is explicit that internal mail ABOUT a
// customer is customer work — measured on this mailbox, 17 of 20 purely internal
// threads were exactly that (relances, tracking numbers, refund decisions), and
// dropping them would have destroyed live level-3 cases.
export function createSpamClassifier(
  openai,
  { model, dropLabels = ['spam', 'irrelevant'], logger, maxBodyChars = 2000 } = {}
) {
  const drop = new Set(dropLabels);

  async function triage(item) {
    const message = item?.message;
    if (!message) {
      return { spam: false };
    }

    try {
      const result = await openai.completeJson({
        model,
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(message, maxBodyChars),
        schema: CLASSIFICATION_SCHEMA,
        schemaName: 'spam_classification',
        maxTokens: 200
      });
      // reason and model are carried through for the spam_audit trail: a dropped
      // email is never stored, so the audit row is the only record of why.
      return { spam: drop.has(result.label), label: result.label, reason: result.reason, model };
    } catch (error) {
      // Fail open — a classifier error must never discard a real email. The reason
      // says so explicitly, so an audited keep is not mistaken for a judged one.
      logger?.warn?.('triage.error', { message: error.message });
      return {
        spam: false,
        label: 'keep',
        reason: `classifier error, kept by fail-open: ${error.message}`,
        model,
        error: true
      };
    }
  }

  return { triage };
}

function buildUserPrompt(message, maxBodyChars) {
  const domain = domainOf(message.from_email);
  const body = String(message.body_text || '').slice(0, maxBodyChars);
  return [
    `Domaine de l'expéditeur : ${domain || '(inconnu)'}`,
    `Objet : ${message.subject || '(aucun)'}`,
    '',
    'Corps :',
    body || '(vide)'
  ].join('\n');
}

function domainOf(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}
