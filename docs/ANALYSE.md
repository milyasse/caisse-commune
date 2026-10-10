# Caisse commune — analyse, conception et architecture (V1)

## 1. Besoin en une phrase

Remplacer le tableau Excel des cotisations par une application mobile qui dit, à tout moment et sans calcul manuel : **combien il y a en caisse**, **qui doit encore payer quoi**, et **où est passé l'argent** — avec une trace de chaque correction.

## 2. Fonctionnalités livrées (V1)

| Module | Livré | Remarques |
|---|---|---|
| A — Tableau de bord | ✅ | Solde actuel, attendu / encaissé / dépenses / reste du mois, payés-partiels-impayés, cumuls annuels, ouverture/clôture, 2 graphiques, alertes retards et grosses dépenses, dernières opérations, filtre mois/année |
| B — Membres | ✅ | Ajout, modification, désactivation, historique des montants par période, total cotisé, reste sur l'année |
| C — Cotisations | ✅ | Génération automatique (idempotente), vue cartes + vue tableau type Excel, versements multiples, partiels, montant exceptionnel d'un mois, date prévue ≠ date réelle, retards en rouge |
| D — Dépenses | ✅ | Saisie rapide, catégories, bénéficiaire (auto-complétion), mode, référence, commentaire, photo du justificatif (compressée), correction et annulation tracées |
| E — Calculs | ✅ | Moteur pur et testé (§3), clôture mensuelle avec report |
| F — Historique | ✅ | Chronologique, recherche, filtres (période, membre, type, catégorie, statut de cotisation, valides/annulées), fiche détaillée + journal des modifications |
| G — Rapports | ✅ | Excel (5 feuilles, formules), PDF mensuel/annuel (via impression), CSV |
| H — Import Excel | ✅ | .xlsx/.csv, aperçu, correspondance des colonnes, contrôles, doublons, validation, ajout seul |
| Sauvegarde | ✅ | Export/restauration JSON complet |
| Synchronisation | ⚠️ | Logique testée ; adaptateur Supabase écrit mais **pas testé sur une vraie instance** (§9) |

## 3. Règles de calcul (source unique : `src/domain/finance.ts`, répliquées en SQL dans `db/002_views.sql`)

Montants stockés en **centimes entiers** dans l'app et en `numeric(12,2)` en base — aucun flottant.

| Indicateur | Définition |
|---|---|
| Attendu du mois | Σ montants attendus des cotisations du mois (membres actifs ayant adhéré) |
| **Encaissé du mois** | Σ versements valides dont la **date réelle** est dans le mois → c'est ce qui entre en caisse |
| Versé / imputé au mois | Σ versements valides **rattachés** aux cotisations du mois, quelle que soit leur date |
| Reste à encaisser | Σ max(0, attendu − versé) par cotisation. **Jamais compté en caisse** |
| Dépenses du mois | Σ dépenses valides datées dans le mois |
| Ouverture du mois | Solde initial + encaissements − dépenses de toutes les dates antérieures |
| Clôture du mois | Ouverture + encaissé − dépenses (= ouverture du mois suivant) |
| Solde disponible | Solde initial + tous les encaissements − toutes les dépenses jusqu'à aujourd'hui |

Conséquences :
- **Paiement en retard** : Moussa paie le 03/10 sa cotisation de septembre → septembre passe « payé » (versé = 400) mais l'argent est compté dans la trésorerie d'**octobre**.
- **Pas de double comptage** : chaque versement est rattaché à **une** cotisation ; le statut se calcule sur la somme des versements valides ; un versement qui dépasserait le reste est refusé (en app et en base).
- **Annulation** : une opération annulée reste visible (barrée) mais sort de tous les calculs.
- **Clôture** : un mois terminé se clôture dans l'ordre ; son solde est figé ; les opérations datées dans ce mois sont verrouillées. Une réouverture (admin, motif obligatoire) rouvre aussi les mois suivants. Si un écart apparaît entre solde figé et recalcul, une alerte rouge s'affiche.

## 4. Écrans et parcours

Navigation basse : **Accueil · Cotisations · Dépenses · Historique · Paramètres** + bouton flottant « **+ Ajouter une opération** ».

Parcours clés (nombre d'appuis) :
1. *Encaisser une cotisation* : Cotisations → « + Encaisser » sur la carte du membre (montant pré-rempli au reste) → Enregistrer. **3 appuis.**
2. *Paiement partiel / en deux fois* : même parcours, on corrige le montant (boutons « Solde » et « Moitié »).
3. *Dépense du gardien* : « + Ajouter » → Dépense → montant → catégorie → description → Enregistrer.
4. *Corriger une erreur* : Historique → opération → Corriger (motif exigé) ou Annuler (motif exigé).
5. *Fin de mois* : Paramètres → Clôture mensuelle → Clôturer {mois}.
6. *Reprendre l'Excel* : Paramètres → Importer → fichier → contrôle → Importer.

Le mois courant est généré automatiquement à l'ouverture de l'app ; les autres mois se génèrent d'un bouton.

## 5. Ambiguïtés identifiées et choix retenus

| Ambiguïté | Choix V1 (modifiable) |
|---|---|
| Versement supérieur à l'attendu (avance, rattrapage) | Refusé. Pour une avance : enregistrer le versement sur le mois suivant (la date réelle reste celle du jour). L'import ajuste l'attendu si le fichier montre plus que prévu. |
| Date limite | Paramétrable : fin de mois (défaut) ou jour N. |
| Retard | Cotisation non soldée après sa date limite. |
| Membre qui adhère en cours de mois | Doit sa cotisation du mois d'adhésion entier. |
| Changement de montant | S'applique à partir d'un mois choisi ; mois passés inchangés ; mois futurs déjà générés et sans versement alignés. |
| Plusieurs caisses (espèces / banque) | Une seule caisse en V1 ; la table `cash_accounts` existe pour l'étape suivante. |
| Format de votre Excel | Inconnu : deux dispositions gérées + correspondance manuelle des colonnes. À valider avec le vrai fichier. |

## 6. Architecture retenue

```
src/domain   moteur métier pur (types, calculs, commandes, synchro)  ← testé, réutilisable tel quel en React Native
src/io       import/export (XLSX sans dépendance, CSV, rapports HTML→PDF)
src/store    état hors ligne (IndexedDB), file d'attente de synchro, adaptateur Supabase
src/ui       interface React (écrans, formulaires, composants, graphiques SVG)
db           schéma PostgreSQL/Supabase, vues de calcul, sécurité RLS, stockage, seed, tests
```

**Choix de plateforme : PWA d'abord, Expo ensuite.**
L'environnement de développement de cette V1 n'avait pas accès au registre npm : impossible d'installer et donc de tester Expo/React Native. Plutôt que de livrer du code natif jamais exécuté, la V1 est une **application web progressive** React + TypeScript, construite, testée en navigateur mobile, et installable sur l'écran d'accueil.

| | PWA (V1) | App native Expo (V2 possible) |
|---|---|---|
| Installation | Lien → « Ajouter à l'écran d'accueil ». Aucune boutique. | APK (Android) ; App Store / TestFlight (iOS, compte Apple 99 $/an) |
| Mises à jour | Instantanées pour tous | Nouvelle version à distribuer (ou OTA Expo) |
| Hors ligne | Oui (service worker + IndexedDB) | Oui (SQLite) |
| Appareil photo (justificatif) | Oui (sélecteur de fichier / caméra) | Oui, plus intégré |
| Limites | iOS peut purger les données d'une PWA inutilisée plusieurs semaines → **activer la synchro ou faire des sauvegardes** ; notifications push limitées sur iOS | Développement et publication plus lourds |

Le moteur `src/domain` n'a aucune dépendance au navigateur : un portage Expo ne réécrit que `src/ui` (en composants React Native) et la persistance.

## 7. Modèle de données

Tables (cf. `db/001_schema.sql`) : `app_users`, `app_settings`, `cash_accounts`, `opening_balances`, `members`, `contribution_rules`, `monthly_contributions`, `contribution_payments`, `expense_categories`, `expenses`, `month_closures`, `audit_logs`.

```
members 1─n contribution_rules            (montant par période, unique membre+mois de début)
members 1─n monthly_contributions          (unique membre+mois)
monthly_contributions 1─n contribution_payments
expense_categories 1─n expenses
cash_accounts 1─n payments / expenses / opening_balances
```

Garde-fous en base (testés, `db/test/`) : suppression interdite sur toutes les tables financières, audit immuable, versement ≤ reste, cohérence membre/cotisation, date future refusée, annulation avec motif et définitive, mois clôturé verrouillé, clôture dans l'ordre et au solde recalculé, audit serveur automatique de toute modification, RLS (lecture : utilisateurs actifs ; saisie : utilisateurs autorisés ; paramétrage : admins ; aucune suppression via l'API ; premier inscrit = admin, les suivants à activer).

Identifiants : UUID générés par l'appareil (rejouer un envoi ne crée pas de doublon). Les cotisations ont un identifiant **déterministe** (membre + mois) : deux téléphones hors ligne qui génèrent le même mois produisent la même ligne.

## 8. Sécurité et fiabilité

- Aucun solde stocké : tout est recalculé depuis les opérations (le solde figé d'une clôture sert de contrôle).
- Confirmation avant : annulation, correction (motif), dépense au-dessus du seuil, clôture, réouverture, import, restauration, réinitialisation.
- Doublons : même membre + date + montant (versement) ou même date + montant + bénéficiaire (dépense) → confirmation explicite.
- Justificatifs : stockés dans l'appareil (V1) ; bucket Supabase **privé** prévu (`db/004_storage.sql`).
- Rôles : en mode local, le rôle est un garde-fou d'interface (un seul appareil, pas de vraie authentification). En mode synchronisé, l'authentification Supabase et la RLS font foi.

## 9. Ce qui reste à configurer ou à tester

| Élément | État | Action |
|---|---|---|
| Synchronisation Supabase réelle | Code écrit, logique testée avec un serveur simulé, **jamais exécutée contre Supabase** | Créer un projet, appliquer `db/*.sql`, tester avec 2 téléphones sur les données de démo |
| Envoi des photos de justificatifs vers Supabase Storage | Non implémenté (photos locales + incluses dans la sauvegarde JSON) | Étape suivante |
| Votre vrai fichier Excel | Import testé sur des fichiers de forme supposée | M'envoyer le fichier (ou une copie anonymisée) pour caler l'import |
| Interface en arabe | Textes en français dans le code | Extraire les textes dans un fichier de traduction + mise en page RTL |
| Gestion des utilisateurs depuis l'app (activer un compte) | Via le tableau de bord Supabase | Écran admin à ajouter |
| App native Expo | Non commencée | Porter `src/ui` ; `src/domain` est réutilisable |
| Hébergement de la PWA | Non fait | Netlify / Vercel / Cloudflare Pages (gratuit), voir README |
| Typage strict de l'UI | Le domaine, l'import/export et les tests passent `tsc --strict` ; l'UI est validée par compilation + tests navigateur (types React non disponibles hors npm ici) | Lancer `npm run typecheck` après `npm install` |
