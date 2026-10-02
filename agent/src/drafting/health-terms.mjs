// Words that put a customer's message about their own health in front of a
// person before any reply goes out. Read by `health-topic.mjs`.
//
// DATA, NOT LOGIC. Add a word here and the detector picks it up; nothing else
// changes. Written accent-free and lower case: the detector folds the message
// the same way, so « Épilepsie », « epilepsie » and « ÉPILEPSIE » all match
// `epilepsie`. A trailing `*` matches any ending (`medicament*` covers
// « médicaments »); a space matches any run of spaces.
//
// NOT A DIAGNOSIS OF THE MAIL. A hit means « a customer mentioned a health
// condition, a treatment or a body state in the message being answered », and
// the only consequence is that the draft cannot send itself. A false positive
// costs a person reading a draft they would have read anyway; a miss is a
// model telling someone with glaucoma that an LED mask is fine. Wide on purpose.
//
// MEASURED 2026-10-02 over every inbound customer message: 1,116 messages, 857
// tickets. NOT `allerg*`: it takes « allergènes », the ingredient-labelling
// regulation mails. NOT `medecin*`: it takes « médecine traditionnelle ». See
// DECISIONS.md § A health condition never sends itself.

export const HEALTH_TERMS = {
  fr: [
    'glaucome', 'cataracte', 'dmla', 'retine', 'ophtalmo*',
    'enceinte', 'grossesse', 'allaite*', 'allaitement',
    'epilep*', 'diabet*', 'cancer*', 'chimio*', 'radiotherapie',
    'pacemaker', 'stimulateur cardiaque',
    'pathologie*', 'maladie*', 'medicament*', 'medecin', 'medecins', 'dermatolog*',
    'sous traitement', 'traitement medical', 'traitement contre',
    'contre indication*', 'contre indique*', 'deconseille*',
    'eczema*', 'psoriasis', 'rosacee', 'dermatite', 'dermite', 'lupus',
    'photosensib*', 'allergi*',
    'chirurgi*', 'etat de sante', 'probleme de sante', 'problemes de sante'
  ],
  en: [
    'glaucoma', 'cataract*', 'pregnan*', 'breastfeeding', 'nursing mother',
    'epilep*', 'diabet*', 'chemotherapy', 'pacemaker',
    'medication*', 'doctor', 'dermatologist*', 'ophthalmologist*',
    'contraindicat*', 'eczema', 'psoriasis', 'rosacea', 'dermatitis',
    'photosensitiv*', 'allergy', 'allergies', 'allergic', 'medical condition', 'health condition', 'surgery'
  ],
  es: [
    'embarazada', 'embarazo', 'lactancia', 'epilepsia', 'quimioterapia', 'marcapasos',
    'medicamento*', 'medico', 'dermatolog*', 'oftalmolog*', 'contraindicad*',
    'eccema', 'rosacea', 'alergi*', 'alergic*', 'enfermedad*'
  ],
  it: [
    'incinta', 'gravidanza', 'allattamento', 'epilessia', 'diabete', 'cancro',
    'chemioterapia', 'farmac*', 'controindicat*', 'psoriasi', 'malattia', 'malattie'
  ],
  de: [
    'glaukom', 'gruner star', 'schwanger*', 'stillzeit', 'epilepsie', 'krebs',
    'chemotherapie', 'herzschrittmacher', 'medikament*', 'arzt', 'arztin', 'hautarzt*',
    'kontraindik*', 'ekzem*', 'neurodermitis', 'schuppenflechte', 'rosazea',
    'allergie*', 'allergisch*', 'krankheit*'
  ]
};
