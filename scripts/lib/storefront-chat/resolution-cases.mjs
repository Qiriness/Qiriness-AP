/**
 * The product-resolution test set: French messages as customers write them,
 * against the LIVE Qiriness catalogue (`npm run eval:resolution`).
 *
 * TEST DATA, NOT RUNTIME. Product names appear here only as expectations
 * (title patterns resolved to ids when the eval runs); nothing in the resolver
 * reads this file.
 *
 * A case:
 *   message   what the customer typed
 *   page      title pattern of the product page they are on
 *   refs      conversation memory: { lastSet: [pattern], lastRecommended: [pattern], focus: pattern }
 *   pending   a clarification just asked: { mention, among: pattern } (every live product matching it)
 *   choice    a chip clicked: a pattern (product) or a care-type label
 *   expect    { status, products: [pattern] (exactly these, any order),
 *               clarification: 'choose_product' | 'choose_care_type', range: true }
 *
 * `hard` is the default; `soft` marks an expectation a person could argue.
 */
export const RESOLUTION_CASES = [
  // --- exact names and SKUs -------------------------------------------------
  { cat: 'exact', message: 'Crème Hydratante Peau Sèche - Caresse Source d’Eau Riche', expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'exact', message: 'Je voudrais des infos sur E046N', expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'exact', message: 'le produit R035N est-il disponible ?', expect: { status: 'resolved', products: [/Flash Patch/] } },
  { cat: 'exact', message: 'Masque LED Visage Éclat & Régénération', expect: { status: 'resolved', products: [/Masque LED/] } },

  // --- shortened commercial names ------------------------------------------
  { cat: 'short', message: 'la Caresse Source d’Eau Riche', expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'short', message: 'que pensez-vous de l’Élixir Temps Sublime ?', expect: { status: 'resolved', products: [/Élixir Temps Sublime/] } },
  { cat: 'short', message: 'la Lip Beauty convient aux lèvres gercées ?', expect: { status: 'resolved', products: [/Lip Beauty/] } },
  { cat: 'short', message: 'le Voile Source d’Eau', expect: { status: 'resolved', products: [/Voile Source d.Eau/] } },
  { cat: 'short', message: 'la caresse mains velours', expect: { status: 'resolved', products: [/Mains Velours/] } },
  { cat: 'short', message: 'le wrap exfolys au riz', expect: { status: 'resolved', products: [/Wrap Exfolys au riz/] } },
  { cat: 'short', message: 'la Temps Sublime Light', expect: { status: 'resolved', products: [/Temps Sublime Light/] } },
  { cat: 'short', message: 'l’élixir d’exception', expect: { status: 'resolved', products: [/Élixir d.Exception/] } },
  { cat: 'short', message: 'les patchs regard d’or', expect: { status: 'resolved', products: [/Regard d.Or/] } },
  { cat: 'short', message: 'la mousse divine', expect: { status: 'resolved', products: [/Mousse Divine/] } },

  // --- care type + line ------------------------------------------------------
  { cat: 'type+line', message: 'le sérum Source d’Eau', expect: { status: 'resolved', products: [/Élixir Source d.Eau/] } },
  { cat: 'type+line', message: 'la crème de nuit Temps Sublime', expect: { status: 'resolved', products: [/Crème Nuit Anti-Âge.*Caresse Temps Sublime/] } },
  { cat: 'type+line', message: 'le masque Hyal-Aqua', expect: { status: 'resolved', products: [/Masque Hydratant & Repulpant - Hyal-Aqua/] } },
  { cat: 'type+line', message: 'le sérum Éclat Parfait', expect: { status: 'resolved', products: [/Élixir Éclat Parfait/] } },
  { cat: 'type+line', message: 'la lotion Éclat Parfait', expect: { status: 'resolved', products: [/Lotion Tonique Anti-tache - Éclat Parfait/] } },
  { cat: 'type+line', message: 'la crème Éclat Parfait', expect: { status: 'resolved', products: [/Caresse Éclat Parfait/] } },
  { cat: 'type+line', message: 'le contour des yeux Regard Énergie', expect: { status: 'resolved', products: [/Caresse Regard Énergie/] } },

  // --- misspellings ------------------------------------------------------------
  { cat: 'typo', message: 'la caresse sourse d’eau riche', expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'typo', message: 'la temp sublime light', expect: { status: 'resolved', products: [/Temps Sublime Light/] } },
  { cat: 'typo', message: 'l’élixir d’éxeption', expect: { status: 'resolved', products: [/Élixir d.Exception/] } },
  { cat: 'typo', message: 'le baume lip beuaty', expect: { status: 'resolved', products: [/Lip Beauty/] } },
  { cat: 'typo', message: 'la caresse sensi zenn', expect: { status: 'resolved', products: [/Caresse Sensi Zen/] } },

  // --- several products ----------------------------------------------------------
  { cat: 'multiple', message: 'la Lip Beauty et la crème mains Velours', expect: { status: 'resolved', products: [/Lip Beauty/, /Mains Velours/] } },
  { cat: 'multiple', message: 'quelle différence entre l’Élixir Source d’Eau et le Voile Source d’Eau ?', expect: { status: 'resolved', products: [/Élixir Source d.Eau/, /Voile Source d.Eau/] } },
  { cat: 'multiple', message: 'compare la Caresse Sensi Zen avec la Brume Sensi Zen', expect: { status: 'resolved', products: [/Caresse Sensi Zen/, /Brume Hydratante Protectrice - Sensi Zen/] } },
  { cat: 'multiple', message: 'compare le sérum et la crème Temps Sublime', expect: { status: 'ambiguous' }, soft: true },
  { cat: 'multiple', message: 'la mousse divine, le fluide lacté exquis et la lotion exquise', expect: { status: 'resolved', products: [/Mousse Divine/, /Fluide Lacté Exquis/, /Lotion Exquise/] } },

  // --- conversation references -------------------------------------------------------
  { cat: 'reference', message: 'quelle est la différence entre les deux ?', refs: { lastSet: [/Élixir Source d.Eau/, /Voile Source d.Eau/] }, expect: { status: 'resolved', products: [/Élixir Source d.Eau/, /Voile Source d.Eau/] } },
  { cat: 'reference', message: 'est-ce que les deux vont ensemble ?', refs: { lastSet: [/Lip Beauty/, /Mains Velours/] }, expect: { status: 'resolved', products: [/Lip Beauty/, /Mains Velours/] } },
  { cat: 'reference', message: 'et les trois que vous m’avez conseillés, je les mets dans quel ordre ?', refs: { lastRecommended: [/Mousse Divine/, /Lotion Exquise/, /Caresse Source d.Eau Riche/] }, expect: { status: 'resolved', products: [/Mousse Divine/, /Lotion Exquise/, /Caresse Source d.Eau Riche/] } },
  { cat: 'reference', message: 'et l’autre ?', refs: { lastSet: [/Élixir Source d.Eau/, /Voile Source d.Eau/], focus: /Élixir Source d.Eau/ }, expect: { status: 'resolved', products: [/Voile Source d.Eau/] } },
  { cat: 'reference', message: 'je préfère le premier', refs: { lastSet: [/Mousse Divine/, /Lotion Exquise/, /Caresse Source d.Eau Riche/] }, expect: { status: 'resolved', products: [/Mousse Divine/] } },
  { cat: 'reference', message: 'et le dernier, il sent bon ?', refs: { lastSet: [/Mousse Divine/, /Lotion Exquise/, /Caresse Source d.Eau Riche/] }, expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'reference', message: 'celui-ci est-il sans parfum ?', refs: { lastSet: [/Caresse Sensi Zen/] }, expect: { status: 'resolved', products: [/Caresse Sensi Zen/] } },
  { cat: 'reference', message: 'cette crème convient aux peaux grasses ?', refs: { lastSet: [/Caresse Source d.Eau Riche/] }, expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'reference', message: 'quelle est la différence entre les deux premiers ?', refs: { lastRecommended: [/Caresse Source d.Eau Riche/], lastSet: [/Caresse Source d.Eau Riche/] }, expect: { status: 'partial', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'reference', message: 'celui-ci ?', refs: { lastSet: [/Lip Beauty/, /Mains Velours/] }, expect: { status: 'ambiguous', clarification: 'choose_product' } },

  // --- current page --------------------------------------------------------------------
  { cat: 'page', message: 'Est-ce que ça convient aux peaux sèches ?', page: /Caresse Source d.Eau Riche/, expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'page', message: 'ce soin s’utilise le matin ou le soir ?', page: /Élixir Temps Sublime/, expect: { status: 'resolved', products: [/Élixir Temps Sublime/] } },
  { cat: 'page', message: 'et la Lip Beauty ?', page: /Caresse Source d.Eau Riche/, expect: { status: 'resolved', products: [/Lip Beauty/] } },
  { cat: 'page', message: 'ça se garde combien de temps une fois ouvert ?', page: /Masque LED/, refs: { lastSet: [/Lip Beauty/] }, expect: { status: 'resolved', products: [/Lip Beauty/] }, soft: true },

  // --- ambiguous: never a silent pick ----------------------------------------------------
  { cat: 'ambiguous', message: 'le soin Source d’Eau', expect: { status: 'ambiguous', clarification: 'choose_care_type' } },
  { cat: 'ambiguous', message: 'la crème Temps Sublime', expect: { status: 'ambiguous', clarification: 'choose_product' } },
  { cat: 'ambiguous', message: 'le coffret Temps Sublime', expect: { status: 'ambiguous' } },
  { cat: 'ambiguous', message: 'la crème Source d’Eau', expect: { status: 'ambiguous', clarification: 'choose_product' } },
  { cat: 'ambiguous', message: 'le sérum Temps Sublime', expect: { status: 'ambiguous', clarification: 'choose_product' } },

  // --- clarification follow-ups ------------------------------------------------------------
  { cat: 'follow-up', message: 'le sérum', pending: { mention: 'le soin source d eau', among: /Source d.Eau/ }, expect: { status: 'resolved', products: [/Élixir Source d.Eau/] } },
  { cat: 'follow-up', message: 'la crème', pending: { mention: 'le soin source d eau', among: /Source d.Eau/ }, expect: { status: 'ambiguous', clarification: 'choose_product' } },
  { cat: 'follow-up', message: 'Caresse Source d’Eau Riche', choice: /Caresse Source d.Eau Riche/, pending: { mention: 'la crème source d eau', among: /Source d.Eau/ }, expect: { status: 'resolved', products: [/Caresse Source d.Eau Riche/] } },
  { cat: 'follow-up', message: 'Sérum', choice: 'Sérum', pending: { mention: 'le soin source d eau', among: /Source d.Eau/ }, expect: { status: 'resolved', products: [/Élixir Source d.Eau/] } },

  // --- partial ---------------------------------------------------------------------------------
  { cat: 'partial', message: 'la Lip Beauty et la crème licorne magique', expect: { status: 'partial', products: [/Lip Beauty/] } },
  { cat: 'partial', message: 'la Lip Beauty et la crème Temps Sublime', expect: { status: 'partial', products: [/Lip Beauty/] } },

  // --- range ---------------------------------------------------------------------------------
  { cat: 'range', message: 'toute la gamme Source d’Eau', expect: { status: 'resolved', range: true } },
  { cat: 'range', message: 'la gamme Temps Sublime convient aux peaux sensibles ?', expect: { status: 'resolved', range: true } },

  // --- discovery: must NOT resolve -----------------------------------------------------------
  { cat: 'discovery', message: 'quels sérums anti-âge avez-vous ?', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'une crème pour peau sèche ?', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'que me conseillez-vous ?', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'je cherche un soin hydratant pour le visage', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'avez-vous des masques pour les mains ?', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'Trouver mon soin', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'Bonjour', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'vos produits sont-ils testés sur les animaux ?', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'je n’ai pas le temps de faire une longue routine', expect: { status: 'unresolved' } },
  { cat: 'discovery', message: 'je veux traiter la source du problème, pas cacher', expect: { status: 'unresolved' } },

  // --- descriptive references (no commercial name) ------------------------------------------
  { cat: 'descriptive', message: 'le démaquillant yeux biphasé', expect: { status: 'resolved', products: [/Regard Velours/] } },
  { cat: 'descriptive', message: 'le déodorant fleur d’oranger', expect: { status: 'resolved', products: [/Déodorant/] } },
  { cat: 'descriptive', message: 'le gua sha en quartz rose', expect: { status: 'resolved', products: [/Gua Sha/] } }
];
