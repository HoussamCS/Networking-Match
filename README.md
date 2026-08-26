# Networking Match

Petite app pour faire se rencontrer les participants d'un événement via QR code.

## Comment ça marche

1. Chaque participant remplit un formulaire (`/register`) : nom, occupation, catégorie
   (Entrepreneur / Investisseur / Associé / Autre), email et téléphone optionnels.
2. Il arrive sur une page profil (`/profile/:id`) avec **son QR code personnel**.
3. Quand quelqu'un scanne ce QR (ou clique sur "Trouver un match"), il arrive sur `/match/:id`
   et choisit la catégorie qu'il veut rencontrer.
4. L'app tire une personne au hasard dans cette catégorie (en évitant de répéter un match déjà
   fait) et affiche son nom, son occupation et ses coordonnées. Bouton "Nouveau match" pour
   relancer.
5. `/admin?key=VOTRE_CLE` : tableau de bord organisateur (liste des inscrits, compteurs par
   catégorie, export CSV).

## Tester en local

```bash
npm install
npm start
```

Puis ouvrez `http://localhost:3000`.

## Déployer en ligne gratuitement (Render)

1. Créez un dépôt GitHub avec ce dossier :
   ```bash
   git init
   git add .
   git commit -m "Networking match app"
   ```
   puis créez un repo sur GitHub et poussez (`git remote add origin ...` puis `git push`).
2. Sur [render.com](https://render.com), créez un compte gratuit puis **New > Web Service**,
   connectez le repo GitHub. Render détecte `render.yaml` automatiquement (build `npm install`,
   start `npm start`, plan Free).
3. Dans les variables d'environnement du service, ajoutez :
   - `ADMIN_KEY` : un mot de passe pour la page `/admin` (obligatoire, pas de valeur par défaut en prod).
   - `BASE_URL` : une fois le service déployé, copiez l'URL Render (ex. `https://networking-match.onrender.com`)
     et remettez-la ici, puis redéployez. Ça sert à générer le bon lien dans les QR codes.
4. Une fois en ligne, partagez le lien `.../register` (ou son QR code) aux participants.

### ⚠️ Important : éviter la mise en veille pendant l'événement

Le plan gratuit de Render met le service en veille après 15 minutes sans trafic, et **efface le
fichier de la base de données à chaque redémarrage** (disque non persistant sur le plan gratuit).
Concrètement : si personne ne visite le site pendant 15 min entre la phase d'inscription et la
phase de matching, vous risquez de perdre les inscriptions.

Solution simple et gratuite : créez un compte sur [UptimeRobot](https://uptimerobot.com) et
ajoutez un moniteur HTTP qui ping votre URL Render toutes les 5 minutes, du début de l'inscription
jusqu'à la fin de l'événement. Ça garde le service éveillé et le disque intact. Pensez à le faire
au moins 15-20 minutes **avant** d'envoyer le formulaire aux invités.

## Admin

- Tableau de bord : `https://votre-app/admin?key=VOTRE_CLE`
- Export CSV des participants : `https://votre-app/admin/export.csv?key=VOTRE_CLE`
