// Trimmed copy of a live templates/page.faq.json fetch: the full real `faq`
// section (all 3 categories x 11 questions, verbatim block_order) plus one
// disabled `rich-text` section and one disabled `advanced-accordion` section,
// both with the exact Shopify starter-theme placeholder strings, kept for
// disabled-skip and placeholder-denylist coverage.
export const faqPageTemplateFixture = {
  order: [
    '07ccae1d-ce78-4a94-8de9-ce939f13158e',
    '66632692-7433-4517-ad18-26c389dc55fe',
    'faq_XnTkzc'
  ],
  sections: {
    '07ccae1d-ce78-4a94-8de9-ce939f13158e': {
      type: 'rich-text',
      disabled: true,
      blocks: {
        'heading-0': {
          type: 'heading',
          settings: { title: '<em>Rich</em> text', heading_size: 'h0', text_highlight: 'handwrite' }
        },
        'text-0': {
          type: 'text',
          settings: {
            enlarge_text: false,
            text: '<p>Use this text to share information about your brand with your customers. Describe a product, share announcements, or welcome customers to your store.</p>'
          }
        }
      },
      block_order: ['heading-0', 'text-0'],
      settings: { align_text: 'center', narrow_column: true, color_scheme: 'none', divider: false }
    },
    '66632692-7433-4517-ad18-26c389dc55fe': {
      type: 'advanced-accordion',
      disabled: true,
      blocks: {
        'accordion-block-0': {
          type: 'text_block',
          settings: {
            image_width: 100,
            image_mask: 'none',
            align_text: 'left',
            title: 'Example title',
            text: '<p>Use this section to explain a set of product features, to link to a series of pages, or to answer common questions about your products. Add images for emphasis.</p>',
            button_label: '',
            button_link: ''
          }
        },
        'accordion-block-1': {
          type: 'text_block',
          settings: {
            image_width: 100,
            image_mask: 'none',
            align_text: 'left',
            title: 'Example title',
            text: '<p>Use this section to explain a set of product features, to link to a series of pages, or to answer common questions about your products. Add images for emphasis.</p>',
            button_label: '',
            button_link: ''
          }
        }
      },
      block_order: ['accordion-block-0', 'accordion-block-1'],
      settings: { title: 'Advanced Accordion', per_row: 3, two_per_row_mobile: false, opened: false, disabled: false }
    },
    faq_XnTkzc: {
      type: 'faq',
      disabled: false,
      blocks: {
        rich_text_8LJwCb: { type: 'rich-text', settings: { title: 'Ma commande', text: '', align_text: 'left' } },
        question_TnrqAT: {
          type: 'question',
          settings: {
            title: 'Comment puis-je vérifier et suivre les étapes de ma commande ?',
            text: '<p>Vous venez de valider votre commande sur le site.</p><p>Un email de confirmation vous sera envoyé.</p>'
          }
        },
        question_pKYWTx: {
          type: 'question',
          settings: {
            title: 'Dois-je créer un compte pour passer une commande ?',
            text: '<p>Vous ne pouvez pas passer directement votre commande sans vous enregistrer.</p>'
          }
        },
        question_FcNHVC: {
          type: 'question',
          settings: {
            title: 'Que dois-je faire en cas de souci concernant ma commande ?',
            text: '<p>Veuillez contacter notre Service Client Qiriness.</p>'
          }
        },
        question_my7VrT: {
          type: 'question',
          settings: {
            title: 'Y-a-t-il une limite de montant d’achat par commande ?',
            text: '<p>Vous avez la possibilité de commander 3 quantités maximum par référence.</p>'
          }
        },
        rich_text_U4tfUc: { type: 'rich-text', settings: { title: 'Livraison et retour', text: '', align_text: 'left' } },
        question_Fmj4K8: {
          type: 'question',
          settings: {
            title: 'Comment puis-je modifier mon adresse de livraison ?',
            text: '<p>Par défaut votre adresse de livraison correspond à votre adresse de facturation.</p>'
          }
        },
        question_yYeegj: {
          type: 'question',
          settings: {
            title: 'Puis-je me faire livrer à l’étranger ?',
            text: '<p>Les commandes peuvent être livrées uniquement dans certains pays.</p>'
          }
        },
        rich_text_PecJCb: { type: 'rich-text', settings: { title: 'Autres questions', text: '', align_text: 'left' } },
        question_Kziy9q: {
          type: 'question',
          settings: {
            title: 'Je ne me souviens plus de mon identifiant ou de mon mot de passe, que faire ?',
            text: '<p>Vous pouvez récupérer votre mot de passe en cliquant sur « Mot de passe oublié ».</p>'
          }
        },
        question_zEXyyt: {
          type: 'question',
          settings: {
            title: 'Comment puis-je modifier mes données personnelles ?',
            text: '<p>Vous pouvez modifier vos données personnelles en vous rendant sur « Mon Compte ».</p>'
          }
        },
        question_99g7C6: {
          type: 'question',
          settings: {
            title: 'Quels sont les produits disponibles sur le site Qiriness ?',
            text: '<p>Tous les produits Qiriness sont disponibles sur notre site.</p>'
          }
        },
        question_n363JW: {
          type: 'question',
          settings: {
            title: 'Comment puis-je obtenir des conseils sur les produits Qiriness ?',
            text: '<p>Vous pouvez poser vos questions au Service Consommateur Qiriness par mail.</p>'
          }
        },
        question_NaXQKq: {
          type: 'question',
          settings: {
            title: 'Comment s’abonner et gérer ses abonnements à la newsletter Qiriness ?',
            text: '<p>Inscrivez-vous à la newsletter Qiriness pour être informé de nos nouveautés.</p>'
          }
        }
      },
      block_order: [
        'rich_text_8LJwCb',
        'question_TnrqAT',
        'question_pKYWTx',
        'question_FcNHVC',
        'question_my7VrT',
        'rich_text_U4tfUc',
        'question_Fmj4K8',
        'question_yYeegj',
        'rich_text_PecJCb',
        'question_Kziy9q',
        'question_zEXyyt',
        'question_99g7C6',
        'question_n363JW',
        'question_NaXQKq'
      ],
      custom_css: ['.collapsible-trigger-btn {text-transform: uppercase; font-weight: 500;}'],
      settings: { title: 'FAQs', heading_size: 'h1', heading_position: 'center' }
    }
  }
};
