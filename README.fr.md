# CS2 Account Manager

*[English](README.md)*

Gestionnaire de bureau pour **tes propres** comptes Steam/CS2 : état Prime,
cooldown compétitif, ban VAC, rang Premier, et lancement d'un compte directement
dans le client Steam.

Electron pour tout : l'interface est du HTML/CSS/JS, le moteur utilise
`steam-user` + `globaloffensive` dans le processus principal. Une seule techno,
une seule commande.

## Installer

**[⬇ Télécharger la dernière version](https://github.com/HazarDos1/CSAM-/releases/latest)**
— un installateur Windows autonome.

Rien d'autre à installer : Node.js, Electron et les bibliothèques Steam sont
déjà dans l'exécutable. L'installation se fait pour ton compte Windows, donc
sans droits administrateur.

> L'exécutable n'est pas signé (un certificat coûte quelques centaines d'euros
> par an). Windows SmartScreen affichera donc un avertissement au premier
> lancement : *Informations complémentaires* → *Exécuter quand même*.

### Ou depuis les sources

```
npm install
npm start
```

Au premier lancement, l'app demande un **mot de passe maître**. Il chiffre le
coffre (`%APPDATA%\cs2-account-manager\vault.json`) où sont rangés mots de passe
Steam, `shared_secret` et refresh tokens. Il n'est stocké nulle part : si tu le
perds, le coffre est irrécupérable.

## Mettre ses comptes dedans

1. **Importer SDA** → choisis ton dossier `maFiles`, saisis le mot de passe SDA.
   Ça récupère `account_name`, `shared_secret` et `identity_secret`.
2. Les `.maFile` ne contiennent **pas** les mots de passe Steam. Il faut les
   saisir ensuite par compte (bouton *Modifier*), ou importer un `accounts.json`
   existant via *Importer SDA → Importer un accounts.json*.

Le format reconnu pour le JSON :

```json
[{ "username": "...", "password": "...", "shared_secret": "...", "steamid": "..." }]
```

Après import, supprime le JSON en clair : le coffre chiffré le remplace.

### Ajouter un compte + créer son authenticator d'un coup

Bouton **Add** → coche **« Créer l'authenticator Steam dans la foulée »**. Le
compte est d'abord enregistré dans le coffre, puis le déroulé s'enchaîne sans
repasser par le panneau de détail : connexion → `AddAuthenticator` → code de
révocation (case « j'ai noté » obligatoire) → code SMS →
`FinalizeAddAuthenticator`. À la fin, le compte produit ses codes Steam Guard
directement dans l'app.

Le champ `shared_secret` disparaît quand la case est cochée : les deux chemins
s'excluent, soit tu colles un secret existant, soit Steam en génère un.

Si le compte a **déjà** un authenticator, l'app s'arrête et prévient avant toute
action — retirer l'ancien coûte 15 jours de blocage des échanges.

Le compte est enregistré **avant** la tentative de création : si celle-ci échoue,
rien n'est perdu et le bouton *Créer un authenticator* du panneau de détail
reprend là où on en était.

### Créer un authenticator sans SDA

Pour un compte qui n'en a pas encore, l'app sait le créer elle-même : panneau de
détail → **Créer un authenticator**. Elle appelle `ITwoFactorService`
(`AddAuthenticator` → SMS → `FinalizeAddAuthenticator`) et range `shared_secret`,
`identity_secret` et `revocation_code` chiffrés dans le coffre.

**Les écritures passent par l'API web, pas par le Game Coordinator.** Ce n'est
pas un choix de style : le CM sert volontiers les *lectures* `ITwoFactorService`
(`QueryStatus` répond `eresult 1 OK`) mais refuse les *écritures* —
`AddAuthenticator` et `FinalizeAddAuthenticator` renvoient tous deux
`eresult 2 Fail`, alors même que toutes les préconditions exposées par Steam
sont remplies. Les mêmes requêtes en HTTPS passent. Le moteur envoie donc les
écritures à `https://api.steampowered.com/ITwoFactorService/...` avec le jeton
d'accès extrait du cookie `steamLoginSecure`, et ne garde le CM qu'en repli.

Le compte doit avoir un **numéro de téléphone rattaché et vérifié**. Quand Steam
refuse, l'app ne devine pas le motif : elle interroge `TwoFactor.QueryStatus` et
`IPhoneService/AccountPhoneStatus` et rapporte ce qu'ils disent réellement —
`authenticator_allowed`, `email_validated`, `verified_phone`, et surtout
`can_add_two_factor_phone`, qui est ce qui empêche un numéro pourtant vérifié de
porter un second authenticator.

Le **code de révocation** est affiché en grand avant la finalisation, et il faut
cocher « j'ai noté » pour continuer. Ce n'est pas une politesse : c'est l'unique
porte de secours du compte, Steam ne le réaffiche jamais, et si tu perds à la
fois le mot de passe maître et ce code, le compte n'est plus récupérable sans le
support. Il est enregistré dans le coffre **dès la réponse de Steam**, avant même
la saisie du code SMS — pour qu'un échec à la finalisation ne l'emporte pas avec
lui. Un authenticator obtenu mais non finalisé est signalé comme tel dans le
panneau de détail, et le bouton devient *Terminer l'activation*, qui reprend
directement à l'étape du code SMS plutôt que de relancer une création que Steam
refuserait comme doublon.

Retirer un authenticator (`RemoveAuthenticator`, code de révocation exigé)
repasse le compte en Steam Guard e-mail et déclenche **15 jours de blocage des
échanges et du marché**. Si tu as encore accès aux codes actuels, importer le
`.maFile` existant coûte beaucoup moins cher.

## Scanner

*Scanner tout* ou *Scanner les périmés* met les comptes à jour. Pour chaque
compte le moteur se connecte à Steam, lance CS2 à vide, attend le Game
Coordinator, récupère les données, puis se déconnecte.

Ce que ça remonte : statut Prime, cooldown compétitif (`penalty_seconds` /
`penalty_reason`), ban VAC, rang Premier (CS Rating), niveau et XP, pseudo,
avatar, SteamID, dernière partie CS2.

Les comptes **en cooldown sont exclus des scans groupés** : la fin de sanction
est une date absolue, décomptée en local, donc un rescan ne révélerait rien de
neuf et dépenserait un login plus du budget anti rate-limit. Le bouton *Scanner*
du panneau de détail reste disponible pour forcer au cas par cas.

### Ce que globaloffensive ne fait pas tout seul sous CS2

Trois choses que le moteur ajoute par-dessus la bibliothèque, parce que le GC de
CS2 ne se comporte plus comme celui de CS:GO :

- **Il passe par le profil joueur, pas par le hello matchmaking.** C'est le point
  décisif. globaloffensive expose `accountData`, alimenté par
  `MatchmakingGC2ClientHello` (9110) — la voie CS:GO. **Le GC CS2 ne l'envoie
  plus**, même sollicité : le moteur réclame `MatchmakingClient2GCHello` (9109)
  toutes les 5 s, le GC n'y répond jamais, et l'attente finit en timeout.
  La voie qui répond est `ClientRequestPlayersProfile` (9127) sur son propre
  compte → `PlayersProfile` (9128), dont `account_profiles[0]` a le *type*
  `MatchmakingGC2ClientHello`. Le moteur envoie les deux en parallèle et garde
  la première réponse ; en pratique c'est 9128, en ~500 ms. Le champ `gcSource`
  des données brutes dit laquelle a servi.

  **9128 ne porte pas les sanctions.** C'est une vue *publique*, demandable sur
  n'importe quel joueur, donc le GC en retire les champs privés
  `penalty_seconds`, `penalty_reason` et `vac_banned` — la réponse fait 37 à 53
  octets et ne contient que `account_id`, `player_level`, `player_cur_xp` et
  `rankings`. Vérifié sur `request_level` 0 à 255 : réponses identiques octet
  pour octet, sur un compte sain comme sur un compte sanctionné.

- **Il lit les sanctions dans `ClientWelcome.game_data2`.** C'est là qu'elles
  sont, et nulle part ailleurs. Le GC CS2 n'envoie plus
  `MatchmakingGC2ClientHello` (9110) comme message autonome — il le **sérialise
  dans le champ `game_data2` du `ClientWelcome` (4004)**, que personne ne décode :
  globaloffensive le traite comme un blob opaque. ~282 octets qui contiennent
  `penalty_seconds`, `penalty_reason`, `vac_banned`, `global_stats`. Le moteur le
  décode, vérifie que l'`account_id` est bien le nôtre, et s'en sert comme source
  de référence.

  Ce point est **autoritaire**, contrairement à 9128 : un protobuf n'encode pas
  les zéros, donc sur ce message-là l'absence de `penalty_seconds` veut vraiment
  dire « aucune sanction ». Sur 9128 elle ne veut rien dire, et l'app affiche
  alors « non communiqué par le GC » plutôt que de conclure (le faux négatif
  d'origine venait de là : `Number(null || 0)` vaut `0`).

  En filet, le moteur décode aussi `ServerNotificationForUserPenalty` (9118) et
  `MatchmakingGC2ClientAbandon` (9112), que globaloffensive jette en silence.

  `npm run probe:gc -- <compte>` rejoue tout ce diagnostic sur un compte donné et
  liste chaque message reçu du GC.

- **Il annonce la vraie version du client.** La bibliothèque code en dur
  `version: 2000244` (build CS2 de fin 2023). Le moteur lit `ClientVersion` dans
  le `steam.inf` de ton installation CS2 (toutes les bibliothèques Steam sont
  parcourues) et l'envoie à la place. À noter : le `ClientWelcome` du GC ne
  contient aucun champ `version`, donc le recalage automatique sur la version
  annoncée par le GC ne se déclenche jamais en pratique — c'est `steam.inf` qui
  fait foi (ou `gcClientVersion` dans les réglages, `null` = automatique).

Ces ajouts sont indépendants : le GC accepte la session (`ClientWelcome` 4004)
quelle que soit la version annoncée, et ignore 9109 dans tous les cas.

Chaque scan garde un **journal Game Coordinator** horodaté (messages envoyés,
reçus, traités ou non). Il est visible dans le panneau de détail — sous « Dernier
scan en échec » ou dans « Données brutes » — et imprimé par `scan:cli`.

### Une valeur sentinelle à connaître

`penalty_seconds` est déclaré `optional uint32`. Quand le GC y met −1, la valeur
revient en 4 294 967 295, soit 49 710 jours. Ce n'est pas une durée, c'est une
sentinelle — la prendre au mot plaçait la fin du cooldown en l'an 2162 et rangeait
un compte sain dans « Cooldown ». Au-delà de 30 jours (CS2 plafonne les cooldowns
compétitifs à 7), rien n'est donc décompté, la valeur brute reste visible dans le
panneau de détail, et une sanction définitive continue d'être décidée par
`penalty_reason`, jamais par la durée.

## Rate limit

C'est la contrainte principale, et l'app est construite autour.

- Le **premier** login d'un compte passe par le mot de passe + un code Steam Guard
  généré depuis le `shared_secret`. Ce point d'API (`BeginAuthSessionViaCredentials`)
  est agressivement limité par Valve : au-delà d'un certain rythme, EResult 84.
- Steam renvoie alors un **refresh token JWT**, que l'app garde dans le coffre.
  Les scans suivants l'utilisent et ne touchent plus du tout ce point d'API.
- Les scans sont sérialisés, avec un délai minimum entre deux logins — 25 s par
  défaut pour un login par mot de passe, 6 s pour un login par token (réglable).
- Si Steam limite quand même, l'app se met en pause ~31 min, l'annonce dans
  l'interface, et reprend la file toute seule.

Conséquence pratique : **le premier scan complet est lent**, les suivants sont
rapides. La colonne « Tokens en cache » dans la barre latérale indique combien
de comptes sont déjà passés en mode token.

L'horloge locale est alignée sur celle de Steam avant chaque génération de code,
et un code déjà consommé n'est jamais rejoué — ce sont les deux causes habituelles
de `TwoFactorCodeMismatch`.

La troisième cause est plus sournoise : **Steam renvoie aussi EResult 88 quand
plusieurs logins par mot de passe s'enchaînent sur un compte** (throttle 2FA,
distinct du rate limit 84). Un « code refusé » juste après un login réussi avec
le même `shared_secret` est presque toujours ça. L'app ne bascule donc pas le
compte en « Expiré » sur ce seul signal : elle le marque en erreur, garde son
refresh token, et attend 3 min avant le compte suivant. La parade de fond reste
la même — scanner par token, pas par mot de passe.

## Lancer un compte

Deux modes, parce qu'aucun n'est bon partout :

- **Session mémorisée** — écrit `AutoLoginUser` dans le registre, marque le compte
  comme le plus récent dans `loginusers.vdf`, redémarre Steam. Aucun secret ne
  circule. Ne marche que si Steam a déjà mémorisé ce compte.
- **Mot de passe** — `steam.exe -login <user> <pass>`. Marche toujours, mais le
  mot de passe est visible dans la liste des processus le temps du lancement.
  À réserver au premier login d'un compte.

Le mode *Auto* (par défaut) choisit le premier si une session mémorisée existe.
Dans les deux cas le code Steam Guard est copié dans le presse-papier : le client
Steam n'accepte pas de code 2FA en ligne de commande.

## Sauvegarder le coffre

Bouton *Sauvegarde* dans le cadre Options. Le fichier produit est une copie du
coffre **déjà chiffré** : rien n'est déchiffré au passage, le mot de passe maître
n'est jamais demandé, et le résultat n'est pas plus lisible que l'original. Le
SHA-256 de la copie est vérifié contre la source après écriture.

La restauration demande le mot de passe maître de la sauvegarde et **vérifie
qu'il déchiffre avant de remplacer quoi que ce soit** — restaurer une sauvegarde
dont on a perdu le mot de passe écraserait sinon un coffre qui marche par un
fichier inutilisable. Le coffre remplacé est conservé à côté en `.bak` horodaté.

## Outils en ligne de commande

```
npm run check:mafile -- "C:\chemin\vers\maFiles"
```
Déchiffre les `.maFile` et affiche le code Steam Guard de chaque compte. Si le
code correspond à celui de ton téléphone, le `shared_secret` est bon.

```
npm run scan:cli -- <nom_de_compte>
npm run probe:gc -- <nom_de_compte>
```
`scan:cli` lance un vrai scan depuis le terminal et affiche les **données brutes**
du Game Coordinator — l'outil pour diagnostiquer un login qui échoue et pour lire
les vrais codes `penalty_reason`. `probe:gc` liste chaque message reçu du GC.

```
npm run ranks     extrait les écussons de rang de ton installation CS2
npm run icon      régénère build/icon.ico
npm run dist      construit l'installateur Windows
```

## Ce qui est exact, et ce qui ne l'est pas

Le protobuf du GC garantit : `penalty_seconds`, `penalty_reason`, `vac_banned`,
`player_level`, `player_cur_xp`, `rankings[].{rank_id, wins, rank_type_id}`.
Le décompte de cooldown est donc exact — il est converti en date de fin absolue
au moment du scan, puis décompté en direct.

En revanche, Valve ne publie pas les **énumérations** derrière `penalty_reason`
et `rank_type_id`. Les libellés dans `src/main/cs2data.js` sont du décodage
communautaire, donnés au mieux. Le code brut est toujours affiché à côté, et un
code inconnu s'affiche tel quel plutôt que d'être deviné. Une exception est de
première main : le code 22 a été relevé sur un compte où CS2 affichait
« Pénalité globale — VAC a détecté une activité suspecte dans votre style de
jeu », avec `penalty_seconds=544203`. Si tu observes un code qui ne colle pas,
corrige la table `PENALTY_REASONS` : c'est prévu pour.

L'historique des parties (« dernière partie CS2 ») passe par `requestRecentGames`,
que Valve a changé avec CS2 : il peut légitimement ne rien renvoyer. Ce n'est pas
traité comme une erreur. « Dernière connexion » vient du profil Steam et est
fiable.

## Sécurité

- Coffre chiffré en AES-256-GCM, clé dérivée du mot de passe maître par scrypt
  (N=2¹⁷, 128 Mio par tentative). GCM authentifie : un mauvais mot de passe
  échoue proprement au lieu de rendre du charabia. La longueur de tag de 16
  octets est imposée — Node accepte sinon des tags GCM tronqués jusqu'à 4 octets.
- La clé maître n'est jamais écrite sur disque. Seuls les paramètres scrypt et le
  sel sont stockés en clair, à côté du chiffré.
- Le renderer n'a ni accès au système de fichiers ni aux secrets.
  `contextIsolation` activé, `nodeIntegration` désactivé, pont IPC à surface
  étroite dans `preload.js`. Les mots de passe et `shared_secret` ne sortent du
  processus principal que sur action explicite (bouton *Voir le mot de passe*).
- Chaque ligne de journal passe par `redact.js`, qui masque les JWT et une
  vingtaine de noms de champs secrets. Ça existe pour une raison concrète :
  steam-user relaie la sortie de debug de steam-session, qui contient les
  `refreshToken` et `accessToken` en entier — un refresh token est un identifiant
  porteur, il ouvre le compte sans mot de passe ni 2FA.
- Pendant un scan, la connexion se fait en **invisible** par défaut, pour ne pas
  afficher « joue à CS2 » à tes contacts.

## Structure

```
src/main/
  main.js            processus principal Electron, canaux IPC
  preload.js         pont contextBridge
  vault.js           coffre chiffré (comptes, secrets, tokens, cache de scan)
  crypto.js          scrypt + AES-256-GCM
  sda.js             lecture des .maFile SDA (PBKDF2-SHA1 50k + AES-256-CBC)
  scanner.js         moteur : file d'attente, anti rate-limit, session Steam + GC
  cs2data.js         normalisation des données GC, catégories, libellés
  authenticator.js   création et retrait d'un authenticator Steam
  confirmations.js   confirmations mobiles (échanges, marché)
  launcher.js        lancement d'un compte dans le client Steam
  redact.js          masque les secrets au point de sortie unique des journaux
src/renderer/        interface (HTML/CSS/JS, sans framework)
tools/
  scan-cli.js        un scan depuis le terminal, données GC brutes
  probe-gc.js        liste chaque message reçu du GC
  check-mafile.js    déchiffre les .maFile et affiche les codes
  extract-ranks.js   extrait les écussons de l'installation CS2 locale
  vpk.js             lecture des archives VPK de Source 2, sans dépendance
  make-icon.js       dessine build/icon.ico (PNG + ICO encodés à la main)
  prompt.js          saisie en terminal
```

## Note sur les SteamID

SDA écrit les SteamID comme des nombres nus (`"steamid":76561198123456789`).
`JSON.parse` les arrondit silencieusement au-dessus de 2^53 — `…789` devient
`…780`. `sda.parseJson()` les passe en chaînes avant de parser. Toute nouvelle
lecture d'un JSON venant de SDA ou de Steam doit passer par cette fonction.

## Écussons de rang

Si tu as pris l'installateur, ils sont déjà dedans : rien à faire.

Ils ne sont en revanche **pas livrés dans ce dépôt** : ce sont des ressources
du jeu appartenant à Valve, et les redistribuer n'est pas la même chose que les
lire depuis sa propre copie. Depuis les sources, extrais-les donc de ton
installation de CS2 :

```
npm run ranks
```

L'outil lit `pak01_dir.vpk` et écrit 62 fichiers dans `src/renderer/ranks/` :
les 19 écussons de groupe de skill (SVG vectoriels) et les 40 médailles de
niveau (PNG 128×128). Sans eux, l'app dessine ses propres écussons : rien ne
casse, c'est juste moins joli.

## Construire l'exécutable soi-même

```
npm run dist
```

Produit `dist/CS2-Account-Manager-Setup-<version>.exe` — exactement ce qui est
publié dans les [releases](https://github.com/HazarDos1/CSAM-/releases).

Le coffre vit dans `%APPDATA%\cs2-account-manager\`, **hors** du dossier
d'installation : désinstaller ou mettre à jour ne l'efface pas.

## Licence

MIT — voir [LICENSE](LICENSE).

Projet sans aucun lien avec Valve. Il s'adresse à quelqu'un qui gère **ses
propres** comptes : il lit des états que Steam expose déjà à leur propriétaire,
et ne contourne aucune protection.
