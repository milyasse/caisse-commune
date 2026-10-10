# Tests — scénarios et résultats attendus

Trois niveaux, tous exécutés et **au vert** pour cette version :

| Niveau | Commande | Contenu |
|---|---|---|
| Moteur métier | `npm test` (`node --test tests/*.test.ts`) | 15 tests : les 10 scénarios ci-dessous + montants, doublons, droits, démo, exports |
| Base de données | `sh db/test/run_tests.sh` (PostgreSQL local) | Vues SQL = moteur TS sur 10 mois ; 19 contrôles d'intégrité et de sécurité |
| Interface | `npm run e2e` (Chromium, écran 390×844) | 12 vérifications de bout en bout : saisie, doublon, solde, annulation, export, import, persistance |

Données du jeu de test « moteur » : solde initial 1 000,00 MAD au 01/01/2026 ; Ahmed 400 MAD/mois ; Bouazza 600 MAD/mois ; date du jour simulée 20/03/2026.

| # | Scénario | Résultat attendu (vérifié) |
|---|---|---|
| 1 | Ahmed paie 400 MAD le 31/01 pour janvier | Statut **Payé**, reste 0, pas de retard |
| 2 | Bouazza paie 250 MAD sur 600 | Statut **Partiel**, reste 350,00 MAD, **retard** (échéance 31/01 dépassée) |
| 3 | Bouazza paie février en deux fois (300 le 10/02 + 300 le 27/02) | Versé 600, **Payé** ; encaissé de février 600 (pas 1 200) ; un 3e versement de 1 centime est **refusé** |
| 4 | En janvier, seul Ahmed paie | Attendu 1 000, encaissé 400, **reste 600**, clôture = 1 000 + 400 = **1 400** (l'impayé n'entre pas en caisse) |
| 5 | Ahmed paie janvier le 03/02 | Janvier : encaissé **0**, mais Ahmed **Payé** pour janvier ; février : encaissé **400**, imputé à février 0 |
| 6 | Dépense de 1 200 le 14/02 | Solde au 13/02 = 1 000 ; au 14/02 = −200 ; clôture de février = 1 000 + 400 − 1 200 = **200** |
| 7 | Clôture de janvier | Clôture janvier 1 400 = **ouverture février** ; clôture de mars avant février refusée ; saisie datée de janvier refusée ; versement tardif daté de février accepté sans casser la clôture ; réouverture tracée avec motif |
| 8 | Correction 300 → 400 puis annulation | Motif obligatoire ; journal avec avant (300) / après (400) ; l'annulation garde la ligne (statut annulé) et l'encaissé du mois revient à 0 |
| 9 | Import d'une grille Excel (relu depuis un vrai .xlsx) avec une ligne déjà saisie, une ligne dupliquée, une date future, un mois illisible, une ligne « Total » | 2 doublons détectés, 2 erreurs signalées, ligne Total ignorée ; **5** opérations importées ; réimporter le même fichier n'ajoute **rien** |
| 10 | Deux appareils : A saisit un versement, B une dépense, hors ligne ; les deux génèrent avril ; A renvoie deux fois | Chaque appareil finit avec 1 versement, 1 dépense, 2 cotisations d'avril (pas 4) ; 8 cotisations sur le serveur ; synthèses identiques ; une annulation faite sur B est reçue par A et n'est pas « ressuscitée » |

Tests base de données (extrait) : suppression refusée · audit immuable · versement > reste refusé · date future refusée · membre incohérent refusé · montant négatif refusé · annulation sans motif refusée · annulation définitive · audit serveur automatique · clôture du mois courant / au mauvais solde / hors ordre refusées · modification d'un mois clôturé refusée · report du solde · RLS (non-admin ne peut créer de membre, lecture autorisée, anonyme ne voit rien) · premier inscrit = admin.

Non couvert automatiquement : synchronisation contre un vrai projet Supabase ; impression PDF (vérifiée visuellement via le HTML du rapport) ; installation PWA sur iPhone/Android réels.
