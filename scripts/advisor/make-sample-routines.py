"""Writes data/advisor/sample-routines/: INVENTED routines (plan § 3.1–3.4), an
invented catalogue to fill them, complete knowledge rows. No real product.

A routine is built from products: each step is a product TYPE, and each product
targets one concern or a combination (owner, 2026-10-13). Collections and tags
are the real config's (data/advisor/qiriness.json), so today's engine can be
scored on them; the knowledge rows say the same thing in the brand's own terms.
"""
import json, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT = 'data/advisor/sample-routines'
os.makedirs(OUT, exist_ok=True)

# Engine signals per concern (the real config's collections), so a product targeting a concern is found by today's engine.
SIGNAL = {
    'Déshydratation': ['soins-hydratants'], 'Sécheresse': ['soins-hydratants', 'cremes-hydratantes'],
    'Rides': ['cremes-anti-age-anti-rides', 'diag-anti-age'], 'Ridules': ['diag-rides-legeres'], 'Perte de fermeté': [], 'Perte d\'élasticité': [],
    'Teint terne': ['eclat-et-bonne-mine-1'], 'Signes de fatigue': ['anti-fatigue'],
    'Imperfections': ['anti-imperfections'], 'Pores dilatés': ['anti-imperfections'], 'Excès de sébum': ['anti-imperfections'], 'Grain de peau irrégulier': [],
    'Rougeurs': ['peaux-sensibles'], 'Inconfort': ['peaux-sensibles'], 'Réactivité': ['peaux-sensibles'],
    'Taches': ['anti-taches-et-anti-rougeurs'], 'Teint irrégulier': ['anti-taches-et-anti-rougeurs'],
    'Cernes': ['diag-cernes-et-poches'], 'Poches': ['diag-cernes-et-poches'], 'Rides du contour des yeux': ['diag-rides-et-ridules'],
}
TAG = {'Perte de fermeté': ['liftant'], 'Rides': ['rides', 'anti-âge'], 'Teint terne': ['éclat'], 'Excès de sébum': ['matifiant'], 'Pores dilatés': ['pores dilatés', 'purifiant'], 'Rougeurs': ['apaisant'], 'Taches': ['anti-taches'], 'Cernes': ['anti-cernes']}
# The step a functional type is found in by today's engine (the real config's slot collections).
SLOT = {
    'Nettoyant': ['nettoyants-et-lotions'], 'Lotion': ['exfoliant-lotion-gommage'], 'Exfoliant': ['exfoliant-lotion-gommage'],
    'Sérum': ['serums-visage'], 'Crème': ['cremes-hydratantes', 'cremes-de-jour'], 'Yeux': ['soins-contour-des-yeux'],
    'Masque': ['masques-patch'], 'SPF': [], 'Coffret / kit': [], 'Accessoire': [], 'Hors routine': [],
}
SKIN_TAGS = {'dry': 'peaux sèches', 'normal': 'peaux normales', 'combination': 'peaux mixtes', 'oily': 'peaux grasses'}
# The real config's ranges (families), so « preferred range » means something to today's engine.
RANGE_COLLECTION = {'Aqua (test)': 'source-deau', 'Énergie (test)': 'active-energie-soins-coup-de-boost-pour-un-teint-eclatant-une-peau-revitalisee', 'Temps (test)': 'gamme-anti-age-temps-sublime', 'Exception (test)': 'exception-la-ligne-anti-age-regenerante-pour-peaux-exigeantes', 'Lumière (test)': 'eclat-parfait', 'Calme (test)': 'peaux-sensibles'}

ALL = ('Adapté', 'Adapté', 'Adapté', 'Adapté')
DRY = ('Idéal', 'Adapté', 'Non adapté', 'Non adapté')
OILY = ('Non adapté', 'Adapté', 'Idéal', 'Idéal')
NORMAL = ('Adapté', 'Idéal', 'Adapté', 'Adapté')

P = []
def p(handle, name, price, rng, ftype, primary, others='', skin=ALL, texture='Standard', sensitive='Adapté', freq='Quotidien', time='Matin et soir', area='Visage', weeks=10, stage='Optimiser', contains='Glycérine', men='Non', premium='Non', treat='Non', gift='Non', kit='', status='Validé', in_stock=True, extra_collections=(), extra_tags=()):
    P.append(dict(handle=handle, name=name, price=price, range=rng, functional_type=ftype, primary=primary, others=others, skin=skin, texture=texture, sensitive=sensitive, frequency=freq, time=time, area=area, weeks=weeks, stage=stage, contains=contains, men=men, premium=premium, treat=treat, gift=gift, kit=kit, status=status, in_stock=in_stock, extra_collections=list(extra_collections), extra_tags=list(extra_tags)))

# A — Hydratation (Aqua)
p('t-lait-aqua', 'Lait Démaquillant Aqua (test)', 21, 'Aqua (test)', 'Nettoyant', 'Déshydratation', 'Inconfort', NORMAL, stage='Préparer', weeks=12)
p('t-lotion-aqua', 'Lotion Hydratante Aqua (test)', 24, 'Aqua (test)', 'Lotion', 'Déshydratation', 'Teint terne', ALL, 'Légère', stage='Préparer', weeks=10)
p('t-serum-aqua', 'Sérum Hydratant Aqua (test)', 39, 'Aqua (test)', 'Sérum', 'Déshydratation', 'Sécheresse, Ridules', ALL, 'Légère', stage='Activer', weeks=8)
p('t-creme-aqua-riche', 'Crème Aqua Riche (test)', 42, 'Aqua (test)', 'Crème', 'Sécheresse', 'Déshydratation, Inconfort', DRY, 'Riche', weeks=10, contains='Parfum')
p('t-creme-aqua', 'Crème Aqua (test)', 38, 'Aqua (test)', 'Crème', 'Déshydratation', 'Sécheresse', NORMAL, 'Standard', weeks=10)
p('t-creme-aqua-light', 'Crème Aqua Light (test)', 38, 'Aqua (test)', 'Crème', 'Déshydratation', 'Excès de sébum', OILY, 'Légère', time='Matin', weeks=10)
p('t-gommage-aqua', 'Gommage Doux Aqua (test)', 26, 'Aqua (test)', 'Exfoliant', 'Grain de peau irrégulier', 'Teint terne', ALL, freq='Occasionnel', time='Soir', weeks=12, stage='Préparer')
p('t-masque-aqua', 'Masque Wrap Aqua (test)', 12, 'Aqua (test)', 'Masque', 'Déshydratation', 'Teint terne', ALL, freq='Occasionnel', time='Soir', weeks=1, stage='Régénérer', treat='Oui')
p('t-serum-aqua-intense', 'Sérum Aqua Intense (test)', 49, 'Aqua (test)', 'Sérum', 'Déshydratation', 'Sécheresse', ALL, in_stock=False, stage='Activer')
# B — Imperfections (Pure)
p('t-gel-pure', 'Gel Nettoyant Pure (test)', 20, 'Pure (test)', 'Nettoyant', 'Imperfections', 'Excès de sébum, Pores dilatés', OILY, 'Légère', sensitive='Avec précaution', stage='Préparer', contains='Acide salicylique')
p('t-lotion-pure', 'Lotion Purifiante Pure (test)', 23, 'Pure (test)', 'Lotion', 'Pores dilatés', 'Excès de sébum, Imperfections', OILY, 'Légère', sensitive='Avec précaution', stage='Préparer', contains='Acide salicylique')
p('t-serum-pure', 'Sérum Anti-imperfections Pure (test)', 34, 'Pure (test)', 'Sérum', 'Imperfections', 'Grain de peau irrégulier', OILY, 'Légère', stage='Activer', time='Soir', contains='Niacinamide')
p('t-creme-pure-light', 'Crème Matifiante Pure Light (test)', 32, 'Pure (test)', 'Crème', 'Excès de sébum', 'Déshydratation, Imperfections', OILY, 'Légère', time='Matin')
p('t-gommage-pure', 'Gommage Purifiant Pure (test)', 22, 'Pure (test)', 'Exfoliant', 'Pores dilatés', 'Grain de peau irrégulier', OILY, freq='Occasionnel', time='Soir', weeks=12, stage='Préparer')
p('t-masque-pure', 'Masque Argile Pure (test)', 14, 'Pure (test)', 'Masque', 'Excès de sébum', 'Pores dilatés', OILY, freq='Occasionnel', time='Soir', weeks=1, stage='Régénérer', treat='Oui')
# C — Peaux sensibles (Calme)
p('t-lait-calme', 'Lait Nettoyant Calme (test)', 22, 'Calme (test)', 'Nettoyant', 'Réactivité', 'Inconfort, Rougeurs', ALL, sensitive='Adapté', stage='Préparer', contains='Aucun parfum')
p('t-creme-calme', 'Crème Apaisante Calme (test)', 36, 'Calme (test)', 'Crème', 'Rougeurs', 'Inconfort, Déshydratation', NORMAL, sensitive='Adapté', contains='Aucun parfum')
p('t-serum-calme', 'Sérum Apaisant Calme (test)', 38, 'Calme (test)', 'Sérum', 'Inconfort', 'Rougeurs, Réactivité', ALL, 'Légère', sensitive='Adapté', stage='Activer', contains='Aucun parfum')
p('t-masque-calme', 'Masque Apaisant Calme (test)', 13, 'Calme (test)', 'Masque', 'Inconfort', 'Rougeurs', ALL, freq='Occasionnel', time='Soir', weeks=1, stage='Régénérer', treat='Oui', contains='Aucun parfum')
# D — Éclat (Énergie)
p('t-mousse-energie', 'Mousse Nettoyante Énergie (test)', 21, 'Énergie (test)', 'Nettoyant', 'Teint terne', 'Signes de fatigue', ALL, 'Légère', stage='Préparer')
p('t-serum-energie', 'Sérum Booster Éclat Énergie (test)', 36, 'Énergie (test)', 'Sérum', 'Teint terne', 'Signes de fatigue, Ridules', ALL, 'Légère', time='Matin', weeks=6, stage='Activer', contains='Vitamine C')
p('t-creme-energie', 'Crème Éclat Énergie (test)', 39, 'Énergie (test)', 'Crème', 'Teint terne', 'Déshydratation', NORMAL, time='Matin')
p('t-gommage-energie', 'Gommage Éclat Énergie (test)', 25, 'Énergie (test)', 'Exfoliant', 'Teint terne', 'Grain de peau irrégulier', ALL, freq='Occasionnel', time='Soir', weeks=12, stage='Préparer', contains='AHA')
p('t-masque-energie', 'Masque Éclat Énergie (test)', 12, 'Énergie (test)', 'Masque', 'Signes de fatigue', 'Teint terne', ALL, freq='Occasionnel', time='Soir', weeks=1, stage='Régénérer', treat='Oui')
# E — Anti-âge (Temps), premium (Exception)
p('t-lait-temps', 'Lait Démaquillant Temps (test)', 24, 'Temps (test)', 'Nettoyant', 'Rides', 'Sécheresse', ALL, stage='Préparer')
p('t-lotion-temps', 'Lotion Lissante Temps (test)', 27, 'Temps (test)', 'Lotion', 'Ridules', 'Teint terne', ALL, stage='Préparer')
p('t-serum-temps', 'Sérum Anti-âge Lift Temps (test)', 55, 'Temps (test)', 'Sérum', 'Rides', 'Perte de fermeté, Ridules', ALL, stage='Activer', time='Soir', contains='Rétinol', extra_tags=['liftant'])
p('t-creme-temps', 'Crème Anti-âge Jour Temps (test)', 48, 'Temps (test)', 'Crème', 'Rides', 'Perte de fermeté, Sécheresse', NORMAL, time='Matin')
p('t-creme-temps-riche', 'Crème Anti-âge Riche Temps (test)', 52, 'Temps (test)', 'Crème', 'Rides', 'Sécheresse, Perte d\'élasticité', DRY, 'Riche')
p('t-creme-temps-nuit', 'Crème de Nuit Temps (test)', 54, 'Temps (test)', 'Crème', 'Rides', 'Perte d\'élasticité', ALL, 'Riche', time='Soir', stage='Régénérer', contains='Rétinol', extra_collections=['creme-de-nuit', 'cremes-visage-nuit'])
p('t-serum-exception', 'Sérum Régénérant Exception (test)', 89, 'Exception (test)', 'Sérum', 'Rides', 'Perte de fermeté, Perte d\'élasticité', ALL, stage='Activer', premium='Oui', extra_collections=['diag-rides-visibles'], extra_tags=['anti age intégral'])
p('t-creme-exception', 'Crème Régénérante Exception (test)', 95, 'Exception (test)', 'Crème', 'Rides', 'Perte de fermeté, Sécheresse', DRY, 'Riche', premium='Oui', extra_collections=['diag-rides-visibles'], extra_tags=['anti age intégral'])
# F — Taches (Lumière)
p('t-serum-lumiere', 'Sérum Anti-taches Lumière (test)', 46, 'Lumière (test)', 'Sérum', 'Taches', 'Teint irrégulier, Teint terne', ALL, 'Légère', stage='Activer', contains='Niacinamide')
p('t-creme-lumiere', 'Crème Unifiante Lumière (test)', 42, 'Lumière (test)', 'Crème', 'Teint irrégulier', 'Taches, Déshydratation', NORMAL, time='Matin')
p('t-spf-lumiere', 'Fluide SPF 50 Lumière (test)', 29, 'Lumière (test)', 'SPF', 'Taches', 'Teint irrégulier', ALL, 'Légère', time='Matin', weeks=8, stage='Optimiser')
p('t-lotion-lumiere', 'Lotion Éclat Lumière (test)', 26, 'Lumière (test)', 'Lotion', 'Teint irrégulier', 'Teint terne', ALL, 'Légère', stage='Préparer', contains='AHA')
# G — Routine de base (Essentiel)
p('t-lait-essentiel', 'Lait Nettoyant Essentiel (test)', 16, 'Essentiel (test)', 'Nettoyant', 'Déshydratation', '', ALL, stage='Préparer')
p('t-creme-essentiel', 'Crème Essentielle (test)', 22, 'Essentiel (test)', 'Crème', 'Déshydratation', '', ALL)
p('t-cc-creme', 'CC Crème Bonne Mine Essentiel (test)', 28, 'Essentiel (test)', 'Crème', 'Teint terne', 'Teint irrégulier', ALL, 'Légère', time='Matin', extra_tags=['bonne mine'])
# Eyes module
p('t-contour-defatigant', 'Contour des Yeux Défatigant (test)', 32, 'Énergie (test)', 'Yeux', 'Cernes', 'Poches', ALL, 'Légère', area='Yeux', time='Matin', weeks=12, extra_collections=['anti-fatigue'])
p('t-contour-lissant', 'Contour des Yeux Lissant Temps (test)', 44, 'Temps (test)', 'Yeux', 'Rides du contour des yeux', 'Cernes', ALL, area='Yeux', weeks=12)
# Men (Homme)
p('t-gel-homme', 'Gel Nettoyant Homme (test)', 19, 'Homme (test)', 'Nettoyant', 'Excès de sébum', 'Déshydratation', ALL, 'Légère', men='Oui', stage='Préparer')
p('t-creme-homme', 'Crème Hydratante Homme (test)', 34, 'Homme (test)', 'Crème', 'Déshydratation', 'Sécheresse', ALL, men='Oui')
p('t-baume-homme-riche', 'Baume Hydratant Homme Riche (test)', 36, 'Homme (test)', 'Crème', 'Sécheresse', 'Déshydratation, Inconfort', DRY, 'Riche', men='Oui')
p('t-fluide-homme-anti-age', 'Fluide Anti-âge Homme (test)', 42, 'Homme (test)', 'Crème', 'Rides', 'Perte de fermeté', ALL, 'Légère', men='Oui')
# Treats and gifts (§ 3.4)
p('t-patchs-yeux', 'Patchs Yeux Défatigants (test)', 15, 'Énergie (test)', 'Masque', 'Cernes', 'Poches', ALL, area='Yeux', freq='Occasionnel', weeks=1, stage='Régénérer', treat='Oui')
p('t-kit-masques', 'Kit 4 Masques Wrap (test)', 24, 'Aqua (test)', 'Coffret / kit', 'Déshydratation', 'Teint terne', ALL, freq='Occasionnel', weeks=4, stage='Régénérer', treat='Oui', gift='Oui', kit='t-masque-aqua, t-masque-energie')
p('t-coffret-hydratation', 'Coffret Rituel Hydratation (test)', 89, 'Aqua (test)', 'Coffret / kit', 'Déshydratation', 'Sécheresse', DRY, 'Riche', gift='Oui', kit='t-lait-aqua, t-serum-aqua, t-creme-aqua-riche')
p('t-coffret-temps', 'Coffret Anti-âge Temps (test)', 99, 'Temps (test)', 'Coffret / kit', 'Rides', 'Perte de fermeté', ALL, premium='Oui', gift='Oui', kit='t-serum-temps, t-creme-temps')
p('t-coffret-spa', 'Coffret Soirée Spa (test)', 39, 'Aqua (test)', 'Coffret / kit', 'Déshydratation', 'Signes de fatigue', ALL, freq='Occasionnel', treat='Oui', gift='Oui', kit='t-masque-aqua, t-patchs-yeux, t-gommage-aqua')
# Never recommended
p('t-creme-retiree', 'Crème Ancienne Formule (test)', 30, 'Aqua (test)', 'Crème', 'Sécheresse', 'Déshydratation', DRY, 'Riche', status='Ne pas conseiller')

CARE_TYPE = {'Nettoyant': None, 'Lotion': 'lotion', 'Exfoliant': None, 'Sérum': 'serum', 'Crème': 'creme', 'Yeux': None, 'Masque': 'masque', 'SPF': None}
catalogue, rows = [], []
for n, x in enumerate(P, start=1):
    concerns = [x['primary']] + [c.strip() for c in x['others'].split(',') if c.strip()]
    collections = [*SLOT[x['functional_type']], *[c for k in concerns for c in SIGNAL.get(k, [])], *x['extra_collections']]
    if x['range'] in RANGE_COLLECTION: collections.append(RANGE_COLLECTION[x['range']])
    if x['functional_type'] == 'Masque': collections.append('masques-patch')
    tags = ['test', 'yeux' if x['area'] == 'Yeux' else 'visage', *[t for k in concerns for t in TAG.get(k, [])], *x['extra_tags']]
    skin = x['skin']
    if all(s in ('Adapté', 'Idéal') for s in skin): tags.append('tous les types de peaux')
    else: tags += [SKIN_TAGS[k] for k, s in zip(('dry', 'normal', 'combination', 'oily'), skin) if s == 'Idéal']
    if x['sensitive'] == 'Adapté' and x['range'] == 'Calme (test)': tags.append('peaux sensibles')
    if x['texture'] == 'Riche': tags.append('crème riche')
    if x['men'] == 'Oui': tags.append('homme')
    pid = f"00000000-0000-4000-b000-{n:012d}"
    catalogue.append({
        'id': pid, 'shopifyId': f'gid://shopify/Product/{700000 + n}', 'handle': x['handle'], 'name': x['name'],
        'type': x['functional_type'], 'tags': sorted(set(tags)), 'short': f"Produit inventé pour les tests : {x['name']}.",
        'description': f"Produit inventé, aucune donnée réelle. Cible : {', '.join(concerns)}.", 'keyIngredients': x['contains'],
        'usage': f"Mode d'emploi inventé ({x['time'].lower()}).", 'faqs': [],
        'variants': [{'id': f'gid://shopify/ProductVariant/{600000 + n}', 'title': None, 'price': x['price'], 'sku': f'T-{n:03d}', 'compareAt': None, 'inStock': x['in_stock']}],
        'skus': [f'T-{n:03d}'], 'priceFrom': x['price'], 'inStock': x['in_stock'], 'collections': sorted(set(collections)),
    })
    rows.append({
        'handle': x['handle'], 'title': x['name'], 'price': x['price'], 'stock': 100 if x['in_stock'] else 0, 'range': x['range'],
        'status': x['status'], 'functional_type': x['functional_type'], 'ritual_stage': x['stage'], 'frequency': x['frequency'], 'usage_weeks': x['weeks'],
        'measured_repurchase_weeks': None, 'measured_repurchase_detail': '', 'time_of_day': x['time'], 'area': x['area'],
        'primary_concern': x['primary'], 'other_concerns': x['others'],
        'skin_dry': skin[0], 'skin_normal': skin[1], 'skin_combination': skin[2], 'skin_oily': skin[3],
        'texture': x['texture'], 'sensitive': x['sensitive'], 'contains': x['contains'],
        'precautions': 'Éviter le contour des yeux' if x['area'] == 'Visage' else 'Ne pas appliquer sur les paupières mobiles',
        'compatibility': 'Ne pas associer à un exfoliant le même soir' if x['contains'] in ('Rétinol', 'AHA', 'Acide salicylique') else 'Compatible avec toute la gamme',
        'men': x['men'], 'premium': x['premium'], 'treat': x['treat'], 'gift': x['gift'], 'kit_contents': x['kit'],
        'usage': f"Mode d'emploi inventé ({x['time'].lower()}).", 'actives': x['contains'], 'faq_count': 0, 'note': 'Produit inventé pour les tests',
    })

concerns = [('dehydration', 'Déshydratation'), ('dryness', 'Sécheresse'), ('fine_lines', 'Ridules'), ('wrinkles', 'Rides'), ('loss_of_firmness', 'Perte de fermeté'), ('loss_of_elasticity', "Perte d'élasticité"), ('dullness', 'Teint terne'), ('signs_of_fatigue', 'Signes de fatigue'), ('blemishes', 'Imperfections'), ('enlarged_pores', 'Pores dilatés'), ('excess_sebum', 'Excès de sébum'), ('uneven_texture', 'Grain de peau irrégulier'), ('redness', 'Rougeurs'), ('discomfort', 'Inconfort'), ('reactivity', 'Réactivité'), ('dark_spots', 'Taches'), ('uneven_tone', 'Teint irrégulier'), ('dark_circles', 'Cernes'), ('puffiness', 'Poches'), ('eye_wrinkles', 'Rides du contour des yeux')]
about = 'INVENTED: no real product, price or customer. The routines of docs/storefront-advisor-plan.md § 3.1–3.4 and a catalogue that fills them, to measure and optimise the routine builder (npm run advisor:score).'
dump = lambda name, obj: open(f'{OUT}/{name}', 'w', encoding='utf-8', newline='\n').write(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
dump('catalogue.json', {'_about': about, 'products': catalogue, 'collections': []})
dump('knowledge.json', {'_about': about, 'concerns': [{'key': k, 'label_fr': l} for k, l in concerns], 'rows': rows})
print(len(catalogue), 'products')
