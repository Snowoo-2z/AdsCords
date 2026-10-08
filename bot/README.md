# AdsCords

Bot Discord de diffusion de campagnes avec suivi direct des clics, budget quotidien, revenus des serveurs et crédits bonus.

> Les fichiers applicatifs restent volontairement **à plat dans `bot/`**. Seul `bot/supabase/` contient un sous-dossier, pour les migrations et l’Edge Function.

## Installation

### Prérequis Discord

1. Créez une application dans le [Discord Developer Portal](https://discord.com/developers/applications), ajoutez un bot et invitez-le avec les permissions :
   - Voir les salons / envoyer des messages ;
   - Intégrer des liens ;
   - Joindre des fichiers ;
   - Lire l’historique des messages ;
   - Gérer les messages (facultatif mais recommandé pour nettoyer les visuels source).
2. Dans **Bot > Privileged Gateway Intents**, activez **MESSAGE CONTENT INTENT**. Sans cela, les commandes `.config`, `.mesgains`, etc. ne pourront pas être lues.

### Fichier `.env`

Créez `.env` à la racine du dossier uploadé (`bot/`) à partir de `.env.example` :

```env
DISCORD_TOKEN=token_du_bot
SUPABASE_URL=https://VOTRE_PROJET.supabase.co
SUPABASE_SERVICE_ROLE_KEY=cle_service_role_supabase

# Facultatif : l’URL de la fonction visit est calculée automatiquement sinon.
AD_TRACKING_URL=
BOT_OWNER_ID=1554498783172235345
MAPUB_GUILD_ID=1556728584285196408
COMMAND_PREFIX=.
CLICK_COST_CENTS=10
AUTO_CHANNEL_NAME=ads-cords
```

`SUPABASE_SERVICE_ROLE_KEY` est une clé serveur : ne la publiez jamais dans Discord, un navigateur ou Git.

## Supabase

Dans **Supabase > SQL Editor**, exécutez les migrations dans cet ordre :

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_dynamic_click_guard.sql`
3. `supabase/migrations/003_campaign_media.sql`
4. `supabase/migrations/004_campaign_duration_and_earnings.sql`
5. `supabase/migrations/005_bonus_wallets.sql`
6. `supabase/migrations/006_spend_bonus_campaigns.sql`
7. `supabase/migrations/007_campaign_24h_periods.sql`
8. `supabase/migrations/008_campaign_delivery_cleanup.sql`
9. `supabase/migrations/009_unlimited_campaigns.sql`
10. `supabase/migrations/010_fix_click_rpc_column_ambiguity.sql`

Les migrations `004` à `010` sont obligatoires pour les campagnes à durée limitée ou illimitée, `.mesgains`, les crédits bonus et `.profile`. La migration `010` corrige l'enregistrement des clics : elle est impérative même si `009` a déjà été exécutée.

| Élément | Rôle |
| --- | --- |
| `ads` | Campagnes, budget, type euros/bonus, date de début/fin et durée |
| `ad_deliveries` | Messages de diffusion et liens de suivi valides |
| `ad_clicks` | Clics, montant débité et motif de tarification |
| `guild_settings` | Salon configuré et propriétaire Discord du serveur bénéficiaire |
| `click_guard_settings` / `click_profiles` | Règles de valeur et protection anti-abus pseudonymisée |
| `server_earnings` | Journal durable des parts attribuées aux propriétaires de serveurs |
| `bonus_wallets` / `bonus_wallet_transactions` | Solde bonus utilisable et historique des crédits manuels ou issus des serveurs |

Les gains sont conservés au **milli-cent en base** pour respecter exactement 30 % / 70 % sur les clics de 2 à 4 CT, puis sont arrondis à l’affichage en euros ou crédits bonus.

### Edge Function de redirection

Le bouton publicitaire ouvre directement l’Edge Function `visit`, qui valide la diffusion, enregistre le clic via `register_ad_click`, puis répond en HTTP `302` vers le lien publicitaire.

Déployez-la une première fois :

```bash
cd bot
npx supabase login
npx supabase link --project-ref VOTRE_PROJECT_REF
npx supabase functions deploy visit --no-verify-jwt
```

Après l’installation de `004` à `010` et cette mise à jour du bot, redéployez aussi `visit` avec la même commande : elle affiche une page neutre lorsque le budget journalier est atteint, sans révéler de montant au membre.

Si le navigateur affiche « Erreur temporaire » après un bouton publicitaire, ouvrez **Supabase > Edge Functions > visit > Logs**, recherchez l’événement `register_ad_click_failed` et relevez son `diagnostic_id`. Les détails SQL restent uniquement dans les logs, jamais dans la page publique.

Discord ne transmet pas l’identité du membre à un bouton-lien. Le suivi direct emploie donc un cookie pseudonymisé par navigateur, sans enregistrer d’adresse IP. Une déduplication exacte par compte Discord nécessiterait un parcours OAuth supplémentaire.

## Valeur des clics et protection

Par défaut, heure de Paris :

- le premier **nouveau clic valorisé de chaque visiteur** vaut **10 CT**, une fois tous les **3 jours** ;
- pendant ces trois jours, les nouveaux clics de ce même visiteur sur d’autres campagnes valent aléatoirement **2 à 4 CT** ;
- un clic déjà enregistré sur la même campagne est redirigé mais ne coûte rien une seconde fois ;
- à partir de 6 campagnes différentes dans une journée, une journée est signalée ; après 3 jours signalés dans les 7 derniers, le navigateur est suspendu 2 jours : ses clics restent historisés, mais leur valeur est **0 CT**.

La règle n’est jamais globale : chaque identifiant de visiteur possède sa propre période de 3 jours. Avec le bouton-lien direct Discord, cet identifiant est un cookie pseudonymisé par navigateur ; Discord ne transmet pas l’ID du membre au lien. Un comptage strict par compte Discord demanderait OAuth Discord.

Le propriétaire AdsCords peut consulter et régler ces valeurs :

```text
.click_guard     → règles et bouton de modification
.click_logs 20   → jusqu’à 20 derniers clics pseudonymisés
```

Dans le panneau `.click_guard`, le premier champ est au format `centimes/jours`, par exemple `10/3`.

## Création et budget quotidien

`.new_pub` reste réservée au propriétaire AdsCords. Le premier formulaire demande :

1. le lien de destination ;
2. le texte principal ;
3. l’ID Discord du propriétaire/annonceur ;
4. la durée, de 1 à 365 jours, ou `illimité` ;
5. le budget total.

Le bot répartit automatiquement le budget total sur chaque créneau de **24 heures** à partir de la création de la campagne quand une durée est renseignée. Une campagne de `1` jour reste donc active pendant 24 heures complètes, même si elle est créée à 23 h 59. La répartition est exacte : par exemple, 10 CT sur 3 jours donne un plafond de **4 CT, 3 CT, 3 CT**. Un clic qui dépasserait le plafond du créneau en cours n’est pas facturé ni redirigé ; le budget des autres jours reste intact.

Avec `illimité`, il n’y a aucun plafond de 24 heures : la campagne reste diffusée et consomme son budget total jusqu’à l’épuisement, puis ses messages et liens de suivi sont retirés.

Tant que le plafond journalier n’est pas consommé, AdsCords remonte la publicité dans chaque salon configuré toutes les **30 minutes**. Le nouveau message remplace le précédent afin de remettre la campagne en avant sans accumuler les doublons dans le salon. La republication s’arrête automatiquement lorsque le budget du jour est consommé ou que la durée de campagne est terminée. À l’expiration ou à l’épuisement complet, le bot retire les messages restants et invalide les anciennes URLs de suivi. Lorsqu’un nouveau serveur termine `.config`, les campagnes encore diffusables y sont publiées immédiatement : il n’attend pas le prochain intervalle de 30 minutes.

Après le formulaire, choisissez l’une des quatre options :

- **€ • Avec embed** / **€ • Message simple** : campagne normale ;
- **Bonus • Avec embed** / **Bonus • Message simple** : campagne à crédits bonus. Son budget est retiré immédiatement et atomiquement du portefeuille bonus de l’ID Discord renseigné ; la création est refusée si le solde est insuffisant.

Envoyez ensuite une image/GIF directement dans le même salon sous 10 minutes, ou utilisez **Publier sans visuel**. Le bot télécharge puis réattache le fichier à chaque message publicitaire : le visuel ne disparaît pas quand le message source est supprimé.

Le CTA reste un clic direct : **Rejoindre le serveur** pour une invitation Discord, sinon **Voir le site**.

## Rémunération des serveurs

Lorsqu’un clic est valorisé dans le salon configuré d’un serveur :

- une campagne en **euros** attribue **30 %** du clic au propriétaire Discord du serveur ; les **70 %** restants vont à AdsCords ;
- une campagne **bonus** attribue **70 %** en crédits bonus au propriétaire du serveur ; les **30 %** restants sont brûlés. Aucun euro réel n’est généré par ce type de campagne.

Le propriétaire est enregistré lors de `.config` et le bot le resynchronise à son démarrage et avant les nouvelles publications. Les gains sont attribués au propriétaire du serveur au moment précis du clic, afin de conserver un historique cohérent lors d’un transfert de serveur.

```text
.mesgains
```

Cette commande renvoie une image propre avec le total cumulé réel, les crédits bonus, les clics valorisés et le détail de **tous les serveurs** dont l’utilisateur est propriétaire et où AdsCords a attribué un gain.

### Portefeuille bonus

Les récompenses de campagnes bonus sont ajoutées automatiquement au portefeuille bonus du propriétaire du serveur. Le propriétaire AdsCords peut également créditer un utilisateur, avec une mention ou son ID Discord :

```text
.add_bonus @utilisateur 10,50
.add_bonus 1554498783172235345 10,50
```

Le montant est un nombre de crédits bonus à deux décimales. Tout utilisateur peut consulter son solde avec `.bonus`; le propriétaire AdsCords peut consulter le solde d’un autre utilisateur avec `.bonus @utilisateur` ou `.bonus ID`.

## Profil et campagnes

```text
.profile
```

Retourne une image de profil avec les campagnes terminées, leurs clics et budget consommé, les gains de serveurs et le solde de crédits bonus. Les publicités actuellement en cours sont volontairement absentes de ce récapitulatif. Les revenus d’AdsCords n’apparaissent jamais dans ce profil.

```text
.owner
```

Réservée au propriétaire AdsCords, cette commande est la seule vue qui affiche combien AdsCords a généré en euros, la part reversée aux serveurs et les crédits bonus attribués.

```text
.mapub
```

Disponible seulement sur le serveur défini par `MAPUB_GUILD_ID`. L’annonceur voit ses campagnes, le propriétaire AdsCords voit toutes les campagnes. Le tableau est une image PNG uniquement, avec statut, clics, budget restant, durée, jour courant et budget quotidien.

## Commandes

| Commande | Utilisateur | Résultat |
| --- | --- | --- |
| `.help` | Tous | Aide générale |
| `.config` | Gestionnaires de serveur | Choisit un salon ou crée `#ads-cords` ; enregistre le propriétaire bénéficiaire |
| `.mapub` | Membres du serveur autorisé | Dashboard PNG des campagnes accessibles |
| `.mesgains` | Tous les propriétaires de serveurs | Dashboard PNG des gains cumulés de leurs serveurs |
| `.profile` | Tous | Dashboard PNG de compte sans les campagnes en cours ni revenus AdsCords |
| `.bonus [@utilisateur/ID]` | Tous / propriétaire pour autrui | Consulte un solde de crédits bonus |
| `.add_bonus <@utilisateur/ID> <montant>` | Propriétaire AdsCords | Ajoute des crédits bonus à un portefeuille utilisateur |
| `.owner` | Propriétaire AdsCords | Dashboard PNG des revenus globaux AdsCords |
| `.new_pub` | Propriétaire AdsCords | Création d’une campagne avec durée, type et visuel facultatif |
| `.click_guard` | Propriétaire AdsCords | Affiche/modifie les montants et seuils de protection |
| `.click_logs [1-20]` | Propriétaire AdsCords | Consulte les derniers clics pseudonymisés |
| `.clear_pubs` / `.delete_pubs` | Propriétaire AdsCords | Confirme puis supprime messages, campagnes et statistiques de campagne |

`.clear_pubs` efface bien les campagnes et les clics qui leur sont liés. Le journal `server_earnings` n’est volontairement pas supprimé : une rémunération déjà attribuée reste visible dans `.mesgains` et `.profile`.

## KataBump

KataBump utilise des fichiers / SFTP, pas une intégration Git avec répertoire de travail.

1. Créez un ZIP avec le **contenu** de `bot/` : `package.json`, `index.js`, `bot.ts`, les fichiers `.ts` et `supabase/` doivent être à la racine de l’archive, sans dossier `bot` parent.
2. Dans **Files**, envoyez le ZIP puis choisissez **Unarchive**.
3. Créez/conservez `.env` à cette même racine. Ne l’écrasez pas durant une mise à jour.
4. Dans **Startup** :
   - **JS FILE** : `index.js` ;
   - **Node.js** : `20.x` ou supérieur ;
   - **Additional Node Packages** : vide.
5. Redémarrez depuis **Console**. KataBump installe les dépendances décrites par `package.json`.

## Vérifications locales

```bash
npm ci
npm run check
npm test
npm run build
```
