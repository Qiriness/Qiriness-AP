import { loadConfig, loadEnv } from './lib/sync-config.mjs';
import { createSupabaseClient, supabaseSelectAll, supabaseUpsert } from './lib/supabase-rest-client.mjs';

// The clause every returns skeleton has to neutralise. The approved Refund
// policy is Shopify's template, and its exceptions list still says « produits de
// soins personnels (tels que les produits de beauté) » are non-returnable —
// which is the entire Qiriness catalogue, and contradicts the 30-day policy four
// paragraphs above it in the same document. Retrieval can surface either half.
const JAMAIS_REFUSER =
  '\n\nNE JAMAIS DIRE QU’UN PRODUIT N’EST PAS RETOURNABLE. La politique approuvée contient une liste ' +
  'd’exceptions issue d’un modèle générique qui cite « les produits de soins personnels » — c’est-à-dire ' +
  'tout notre catalogue — et qui contredit la politique de retour de 30 jours figurant dans le même ' +
  'document. Ne pas s’appuyer dessus, ne pas la citer, et laisser une personne trancher tout refus.';

const PROCEDURE =
  'Le client demande comment retourner un produit, ou cherche l’adresse de retour.' +
  '\n\nL’ORDRE COMPTE ET IL EST CONTRE-INTUITIF : la demande de retour vient AVANT l’envoi. La politique ' +
  'approuvée est explicite — un colis renvoyé sans demande préalable n’est pas accepté. Donc : indiquer ' +
  'd’abord qu’il faut nous en faire la demande, puis qu’une étiquette de retour et les instructions ' +
  'd’envoi lui sont adressées une fois le retour accepté. Ne pas laisser entendre qu’il peut poster son ' +
  'colis dès maintenant.' +
  '\n\nL’adresse de retour est {returns_address}. La donner s’il la demande, en précisant qu’elle ne ' +
  'dispense pas de la demande préalable.' +
  '\n\nRappeler l’état attendu du produit (non utilisé, emballage d’origine, preuve d’achat) sans en ' +
  'faire une condition qu’on lui oppose : c’est une information, pas un refus.';

const R21_POSSIBLE =
  PROCEDURE +
  '\n\nLe délai de retour court toujours pour cette commande : le dire, cela répond à l’inquiétude ' +
  'implicite de la plupart de ces messages.' +
  JAMAIS_REFUSER;

const R21_HORS_DELAI =
  PROCEDURE +
  '\n\nLe délai de retour est dépassé pour cette commande. NE PAS REFUSER pour autant, et surtout ne pas ' +
  'l’annoncer comme une fin de non-recevoir : un geste commercial reste possible et c’est une personne ' +
  'qui en décide. Accuser réception, expliquer la procédure, et dire que l’équipe revient vers lui.' +
  JAMAIS_REFUSER;

const R21_INCONNU =
  PROCEDURE +
  '\n\nNOUS NE SAVONS PAS si le délai court encore — la date de livraison n’est pas connue pour cette ' +
  'commande. Ne rien affirmer sur le délai, ni dans un sens ni dans l’autre : la procédure ci-dessus est ' +
  'la même quoi qu’il en soit, et c’est elle qu’il faut donner.' +
  JAMAIS_REFUSER;

const R22 =
  'Le client demande qui paie les frais de retour, ou s’ils lui seront remboursés.' +
  '\n\nAUCUN ARTICLE APPROUVÉ NE RÉPOND À CETTE QUESTION. La politique de retour mentionne l’envoi d’une ' +
  'étiquette de retour une fois le retour accepté, mais ne dit nulle part qui en supporte le coût. ' +
  'Ne pas le déduire de l’existence de l’étiquette, ne pas l’inventer, et ne rien promettre.' +
  '\n\nAccuser réception de la question, dire qu’une personne de l’équipe lui confirme la prise en charge ' +
  'des frais, et enchaîner sur ce qui est certain : la marche à suivre pour demander le retour.' +
  '\n\nSi le client explique que le retour est dû à une erreur de notre part ou à un produit défectueux, ' +
  'le reprendre dans la réponse — c’est l’élément qui pèsera dans la décision — sans en tirer de conclusion.' +
  JAMAIS_REFUSER;

const R23_ATTENTE =
  'Le client demande sous quel délai il sera remboursé. Aucun remboursement n’est encore parti pour ' +
  'cette commande.' +
  '\n\nDonner la séquence dans l’ordre : nous recevons le retour, nous l’inspectons, nous confirmons ' +
  'l’accord ou le refus, puis le remboursement part sur le moyen de paiement d’origine sous ' +
  '{refund_processing_days} jours ouvrables. Ajouter que la banque ou l’émetteur de la carte peut ensuite ' +
  'demander quelques jours pour l’afficher — c’est la cause la plus fréquente de la relance suivante.' +
  '\n\nNe pas annoncer de date, et ne pas dire que le remboursement est « en cours » : il ne l’est pas encore.';

const R23_RETOUR_OUVERT =
  'Le client demande sous quel délai il sera remboursé, et un retour est ouvert pour cette commande sans ' +
  'qu’aucun remboursement soit encore parti.' +
  '\n\nLe dire clairement — son retour est bien enregistré chez nous — puis donner la suite : inspection, ' +
  'accord, puis remboursement sous {refund_processing_days} jours ouvrables sur le moyen de paiement ' +
  'd’origine, et le délai bancaire éventuel par-dessus.' +
  '\n\nNe pas dater l’inspection et ne pas promettre l’accord : c’est ce que le retour n’a pas encore franchi.';

const R23_REMBOURSE =
  'Le client demande sous quel délai il sera remboursé, et un remboursement est DÉJÀ parti pour cette ' +
  'commande.' +
  '\n\nC’est l’information principale et elle doit venir en premier. Les montants et dates figurent dans ' +
  'les faits établis : les reprendre tels quels, ne rien recalculer et ne rien arrondir.' +
  '\n\nExpliquer ensuite que l’affichage dépend de la banque, ce qui est presque toujours l’explication ' +
  'quand un client écrit sans l’avoir vu arriver. S’il s’agit d’un remboursement partiel, ne pas laisser ' +
  'croire qu’il est total : le dire, sans justifier la différence si rien dans le dossier ne l’explique.';

const R23_INCONNU =
  'Le client demande sous quel délai il sera remboursé, mais aucune commande n’est rattachée à ce ' +
  'message — nous ne pouvons donc rien dire de son remboursement en particulier.' +
  '\n\nLui demander son numéro de commande. En attendant, donner le principe général, qui ne dépend ' +
  'd’aucun dossier : après réception et acceptation du retour, le remboursement part sous ' +
  '{refund_processing_days} jours ouvrables sur le moyen de paiement d’origine.' +
  '\n\nNe rien affirmer sur l’état de SON remboursement : nous ne l’avons pas regardé.';

export const RULES = [
  {
    answer_key: 'retour_procedure',
    situation_key: 'R-21',
    when_conditions: { return_eligibility: ['possible'] },
    route: null,
    ask: [],
    answer_skeleton: R21_POSSIBLE
  },
  {
    answer_key: 'retour_hors_delai',
    situation_key: 'R-21',
    when_conditions: { return_eligibility: ['out_of_window'] },
    route: 'needs_human',
    ask: [],
    answer_skeleton: R21_HORS_DELAI
  },
  {
    answer_key: 'retour_delai_inconnu',
    situation_key: 'R-21',
    when_conditions: { return_eligibility: ['unknown'] },
    route: null,
    ask: [],
    answer_skeleton: R21_INCONNU
  },
  {
    answer_key: 'frais_de_retour',
    situation_key: 'R-22',
    when_conditions: {},
    route: 'needs_human',
    ask: [],
    answer_skeleton: R22
  },
  {
    answer_key: 'remboursement_a_venir',
    situation_key: 'R-23',
    when_conditions: { refund_state: ['none'] },
    route: null,
    ask: [],
    answer_skeleton: R23_ATTENTE
  },
  {
    answer_key: 'remboursement_retour_ouvert',
    situation_key: 'R-23',
    when_conditions: { refund_state: ['return_open'] },
    route: null,
    ask: [],
    answer_skeleton: R23_RETOUR_OUVERT
  },
  {
    answer_key: 'remboursement_deja_parti',
    situation_key: 'R-23',
    when_conditions: { refund_state: ['refunded_partial', 'refunded_full'] },
    route: null,
    ask: [],
    answer_skeleton: R23_REMBOURSE
  },
  {
    answer_key: 'remboursement_commande_inconnue',
    situation_key: 'R-23',
    when_conditions: { refund_state: ['unknown'] },
    route: 'needs_customer_input',
    ask: ['shopify_order_number'],
    answer_skeleton: R23_INCONNU
  }
];

if (process.argv[2] === 'apply') {
  const config = loadConfig(loadEnv());
  const supabase = createSupabaseClient(config);
  const shopId = (await supabaseSelectAll(supabase, 'shops', {}, 'id'))[0].id;
  await supabaseUpsert(
    supabase,
    'support_answers',
    RULES.map((r) => ({
      ...r,
      shop_id: shopId,
      answer_set: 'returns',
      priority: 0,
      is_fallback: false,
      approval_status: 'approved'
    })),
    'shop_id,answer_set,answer_key'
  );
  console.log('upserted ' + RULES.length + ' rules into returns');
}
