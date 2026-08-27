# Networking Match

Petite app pour faire se rencontrer les participants d'un événement via QR code. Conçue pour
tourner sur **Vercel** (fonctions serverless), avec une base **Neon Postgres** et un **Vercel
Blob store** pour les photos — Vercel ne fournit pas de disque persistant, donc tout l'état vit
dans ces deux services plutôt que dans des fichiers locaux.

## Comment ça marche

Chaque appareil (téléphone) a sa propre identité, retenue via un cookie posé à l'inscription —
scanner le QR de quelqu'un d'autre ne vous connecte jamais "en tant que" cette personne, ça vous
ajoute simplement un contact.

1. Chaque participant remplit un formulaire (`/register`) : nom, occupation, catégorie
   (Entrepreneur / Investisseur / Associé / Autre), une photo (recommandée, pour être reconnu·e),
   email et téléphone optionnels.
2. Il arrive sur **Mon profil** (`/profile`) avec son propre QR code personnel.
3. Trois sections accessibles à tout moment via la barre de navigation :
   - **Mon profil** — mes infos + mon QR à faire scanner.
   - **Scanner** (`/scan`) — ouvre la caméra pour scanner le QR de quelqu'un d'autre. Le
     scan connecte immédiatement les deux personnes et affiche la carte (photo, nom, occupation,
     contact) de la personne scannée.
   - **Mes matchs** (`/matches`) — liste de toutes les personnes rencontrées jusque-là.
4. Si quelqu'un scanne un QR sans être encore inscrit, il est renvoyé vers le formulaire
   d'inscription puis automatiquement reconnecté à la bonne personne une fois inscrit.
5. `/admin?key=VOTRE_CLE` : tableau de bord organisateur (liste des inscrits avec vignette photo,
   compteurs par catégorie, export CSV).

## Déployer sur Vercel

1. Poussez ce dossier sur GitHub (déjà fait si vous suivez ce projet depuis le début), puis sur
   [vercel.com](https://vercel.com) : **Add New > Project**, importez le repo.
2. Une fois le projet créé, allez dans l'onglet **Storage** du projet Vercel :
   - **Create Database > Postgres** (propulsé par Neon) → connectez-le au projet. Vercel ajoute
     automatiquement la variable d'environnement `DATABASE_URL`.
   - **Create > Blob** → connectez-le au projet. Vercel ajoute automatiquement
     `BLOB_READ_WRITE_TOKEN`.
3. Dans **Settings > Environment Variables**, ajoutez en plus :
   - `ADMIN_KEY` : un mot de passe pour la page `/admin`.
   - `BASE_URL` : l'URL de votre déploiement, ex. `https://networking-match.vercel.app` (visible
     dans l'onglet Deployments une fois le premier déploiement fait).
4. Redéployez (Deployments > ⋯ > Redeploy) pour que les nouvelles variables soient prises en
   compte.
5. Partagez le lien `.../register` (ou son QR code) aux participants.

Les tables Postgres sont créées automatiquement au premier appel (`CREATE TABLE IF NOT EXISTS`),
rien à faire manuellement côté base de données.

### Pourquoi pas Render ou du local ?

Sur Vercel, chaque requête peut être traitée par une instance différente et sans disque
persistant — un fichier SQLite ou un dossier d'uploads local serait perdu ou invisible d'une
requête à l'autre. D'où Neon (Postgres) pour les données et Vercel Blob pour les photos : les
deux sont accessibles depuis n'importe quelle instance de la fonction, de façon fiable pendant
toute la durée de l'événement (pas de mise en veille à gérer, contrairement à un plan gratuit
classique).

## Tester en local

Il faut d'abord récupérer les variables d'environnement de votre projet Vercel (base + blob) :

```bash
npm install -g vercel   # si pas déjà installé
vercel link             # relie ce dossier a votre projet Vercel
vercel env pull .env    # telecharge DATABASE_URL, BLOB_READ_WRITE_TOKEN, etc. dans .env
npm install
npm start
```

Puis ouvrez `http://localhost:3000`.

## Admin

- Tableau de bord : `https://votre-app.vercel.app/admin?key=VOTRE_CLE`
- Export CSV des participants : `https://votre-app.vercel.app/admin/export.csv?key=VOTRE_CLE`
