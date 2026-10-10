# Caisse commune

Application mobile (PWA installable, hors ligne) pour gérer les **cotisations mensuelles** d'un groupe et les **dépenses communes** (paiement du personnel, charges), en **MAD**. Remplace le tableau Excel : soldes calculés automatiquement, historique tracé, exports Excel/PDF/CSV, import de l'ancien fichier.

- Analyse, règles de calcul, architecture, éléments restants : [`docs/ANALYSE.md`](docs/ANALYSE.md)
- Scénarios de test et résultats attendus : [`docs/TESTS.md`](docs/TESTS.md)

## Structure

```
src/domain/    types, montants (centimes), dates, calculs, commandes, synchro, données de démo
src/io/        import (xlsx/csv), exports (xlsx avec formules, csv, rapports HTML→PDF), lecteur/écrivain XLSX
src/store/     état hors ligne (IndexedDB), file d'attente, adaptateur Supabase
src/ui/        App, écrans (Accueil, Cotisations, Dépenses, Historique, Paramètres), formulaires, composants
web/           index.html, styles, manifeste PWA, service worker, icônes
db/            001_schema · 002_views · 003_security (RLS) · 004_storage · seed_demo · test/
tests/         scenarios.test.ts (moteur), e2e.mjs (navigateur)
scripts/       build, génération du seed SQL, icônes
```

## 1. Installer

Prérequis : Node.js ≥ 22.18.

```bash
npm install
npm test            # moteur métier : 15 tests
npm run build       # → dist/
npm run dev         # sert dist/ sur http://localhost:8765
```

Au premier lancement l'app s'ouvre sur les **données de démonstration** (bandeau orange). Pour passer aux vraies données : Paramètres › Sauvegarde et données › *Commencer avec mes données* (nom, solde initial et sa date), puis ajoutez les membres ou importez l'Excel.

## 2. Tester sur smartphone

- **Même Wi-Fi** : `npm run dev`, puis sur le téléphone ouvrez `http://<IP-de-l'ordinateur>:8765`. (Le mode hors ligne/installation exige HTTPS, donc l'étape 3.)
- **En ligne (recommandé)** : déployez `dist/` (étape 3) et ouvrez l'URL https sur le téléphone.
  - Android/Chrome : menu ⋮ › *Installer l'application*.
  - iPhone/Safari : bouton Partager › *Sur l'écran d'accueil*.

## 3. Déployer la PWA (gratuit)

N'importe quel hébergeur statique HTTPS : commande de build `npm run build`, dossier publié `dist`.
- Netlify : *Add new site › Import* (ou glisser-déposer `dist/` sur app.netlify.com/drop).
- Vercel : `npx vercel deploy dist --prod`.
- Cloudflare Pages : build `npm run build`, output `dist`.

## 4. Base de données et synchronisation (optionnel, multi-appareils)

Sans cette étape, les données restent **sur le téléphone** : faites des sauvegardes régulières (Paramètres › Sauvegarde).

1. Créez un projet sur supabase.com (région Europe).
2. *SQL Editor* : exécutez dans l'ordre `db/001_schema.sql`, `db/002_views.sql`, `db/003_security.sql`, `db/004_storage.sql`.
3. (Facultatif, base de test uniquement) `db/seed_demo.sql` — **données fictives** ; régénérez-le à la date du jour : `npm run db:seed`.
4. *Authentication › Users* : créez le compte de l'administrateur (le **premier** compte devient admin et actif). Les comptes suivants sont créés inactifs : activez-les dans la table `app_users` (`active = true`, `role = 'user'` ou `'admin'`).
5. *Project Settings › API* : copiez l'URL et la clé `anon`.
6. Dans l'app : Paramètres › Synchronisation › URL, clé, e-mail, mot de passe › *Se connecter*.

> ⚠️ La synchronisation est implémentée et sa logique est testée (serveur simulé, deux appareils, renvois, annulations), mais elle **n'a pas encore été exécutée contre un vrai projet Supabase**. Premier essai conseillé sur les données de démo.

Tests de la base sur un PostgreSQL local : `PGHOST=… PGPORT=… npm run db:test` (crée une base `caisse`, simule le schéma `auth` de Supabase).

## 5. Sauvegarde et restauration

- Paramètres › Sauvegarde › *Télécharger une sauvegarde* : fichier JSON complet (membres, opérations, justificatifs, journal).
- *Restaurer…* remplace les données de l'appareil (confirmation demandée).
- Avec Supabase : sauvegardes automatiques quotidiennes du projet (offre payante) ou `pg_dump` régulier.

## 6. Installer sur iPhone / iPad

Prérequis : l'app publiée sur une adresse **https** (étape 3) et iOS 16.4 ou plus récent.

1. Ouvrir l'adresse dans **Safari** (depuis iOS 16.4, Chrome et Edge sur iPhone le permettent aussi).
2. Bouton **Partager** (carré avec une flèche) › **Sur l'écran d'accueil** › **Ajouter**.
3. L'icône « Caisse » apparaît ; l'app s'ouvre en plein écran et fonctionne hors ligne.

L'application affiche elle-même ces instructions sur l'iPhone tant qu'elle n'est pas installée. Elle demande au système de conserver ses données ; sans synchronisation, faites quand même une sauvegarde régulière (un rappel s'affiche après 30 jours sans sauvegarde).

Pour une diffusion par l'App Store : PWABuilder (pwabuilder.com › iOS) génère un projet Xcode à partir de l'adresse publiée ; il faut un Mac et un compte Apple Developer (99 USD/an). Android : installation directe depuis Chrome, ou APK via PWABuilder › Android.

## Scripts

| Commande | Rôle |
|---|---|
| `npm test` | Tests du moteur (10 scénarios du cahier des charges + règles) |
| `npm run e2e` | Test de bout en bout dans Chromium (dist servi sur :8765) |
| `npm run db:test` | Tests SQL : vues = moteur TS, intégrité, RLS |
| `npm run typecheck` | Vérification TypeScript stricte |
| `npm run db:seed` | Régénère `db/seed_demo.sql` depuis les données de démo TS |
