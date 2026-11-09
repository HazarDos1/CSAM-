'use strict';
/**
 * Moteur de scan : se connecte au réseau Steam, lance CS2 "à vide", interroge le
 * Game Coordinator, ressort les données, se déconnecte.
 *
 * Deux contraintes dictent toute l'architecture :
 *
 * 1. Le GC n'est joignable qu'en étant réellement connecté au réseau Steam avec
 *    l'app 730 lancée. Pas d'API web possible.
 * 2. BeginAuthSessionViaCredentials (le login par mot de passe) est agressivement
 *    rate-limité par Valve : enchaîner les comptes trop vite donne EResult 84.
 *    => le premier login récupère un refresh token JWT, qu'on garde ; tous les
 *       scans suivants l'utilisent, ce qui ne touche plus ce point d'API du tout.
 *
 * Les scans sont donc sérialisés dans une file, avec un délai minimum entre deux
 * logins (plus long pour les logins par mot de passe) et une mise en pause globale
 * si Steam nous rate-limite quand même.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const SteamTotp = require('steam-totp');
// Internes de globaloffensive : la lib n'expose pas d'API pour envoyer le hello
// matchmaking, on passe donc par sa table de messages et ses protobufs générés.
const GCLanguage = require('globaloffensive/language.js');
const GCProtos = require('globaloffensive/protobufs/generated/_load.js');
const { decodeProto } = require('globaloffensive/lib/proto-decode.js');
const { redact } = require('./redact');
const launcher = require('./launcher');
const {
	CS2_APPID, PRIME_APPID, normalizeAccountData,
	penaltyReasonLabel, PERMANENT_PENALTY_REASONS
} = require('./cs2data');

const MM_HELLO_RETRY_MS = 5000;
const LIB_DEFAULT_GC_VERSION = 2000244; // ce que globaloffensive 3.3.0 annonce en dur
const GC_LOG_MAX_LINES = 120;

/** Nom lisible d'un message GC à partir de son identifiant numérique. */
function gcMessageName(type) {
	for (const name of Object.keys(GCLanguage)) {
		if (GCLanguage[name] === type) return name;
	}
	return String(type);
}

const EResult = SteamUser.EResult;
const RATE_LIMIT_PAUSE_MS = 31 * 60 * 1000; // la fenêtre de Valve tourne autour de 30 min
const BADTOTP_PAUSE_MS = 3 * 60 * 1000;     // après un code 2FA refusé, le temps que le throttle retombe
const MAX_RATE_LIMIT_HITS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomLogonId = () => crypto.randomBytes(4).readUInt32BE(0);

class ScanError extends Error {
	constructor(kind, message, { authFailed = false, eresult = null } = {}) {
		super(message);
		this.kind = kind;
		this.authFailed = authFailed;
		this.eresult = eresult;
	}
}

/** Classe une erreur Steam en quelque chose d'actionnable pour l'utilisateur. */
function classify(err) {
	if (err instanceof ScanError) return err;
	const eresult = err && err.eresult;
	const name = eresult != null ? EResult[eresult] : null;
	const tag = eresult != null ? ` (EResult ${eresult} ${name || '?'})` : '';

	switch (eresult) {
		case EResult.RateLimitExceeded:
		case EResult.AccountLoginDeniedThrottle:
			return new ScanError('ratelimit', 'Rate limit Steam atteint', { eresult });
		case EResult.InvalidPassword:
			return new ScanError('badpassword', 'Identifiants refusés par Steam', { authFailed: true, eresult });
		case EResult.TwoFactorCodeMismatch:
			// Pas authFailed : Steam renvoie aussi 88 quand on enchaîne les logins par
			// mot de passe (throttle 2FA). Basculer le compte en "expiré" et jeter son
			// refresh token sur ce seul signal serait faux une fois sur deux.
			return new ScanError('badtotp', 'Code Steam Guard refusé — shared_secret faux, horloge décalée, ou throttle 2FA après plusieurs logins rapprochés', { authFailed: false, eresult });
		case EResult.Expired:
		case EResult.AccessDenied:
		case EResult.AccountLogonDenied:
			return new ScanError('tokenexpired', 'Session expirée, reconnexion requise', { authFailed: true, eresult });
		case EResult.AccountNotFound:
			return new ScanError('notfound', 'Compte inexistant', { authFailed: true, eresult });
		case EResult.AccountDisabled:
		case EResult.AccountLockedDown:
			return new ScanError('disabled', 'Compte désactivé ou verrouillé par Steam', { authFailed: true, eresult });
		case EResult.LoggedInElsewhere:
		case EResult.AlreadyLoggedInElsewhere:
			return new ScanError('inuse', 'Compte déjà connecté ailleurs', { eresult });
		case EResult.ServiceUnavailable:
		case EResult.TryAnotherCM:
			return new ScanError('steamdown', 'Serveurs Steam indisponibles', { eresult });
		default:
			return new ScanError('unknown', `${err.message || 'Erreur inconnue'}${tag}`, { eresult: eresult == null ? null : eresult });
	}
}

/**
 * Capte un événement même s'il est émis avant qu'on l'attende.
 * Indispensable ici : `ownershipCached` ou `accountData` peuvent arriver pendant
 * qu'on est encore en train d'attendre autre chose.
 */
function latch(emitter, event) {
	let fired = false;
	let value;
	let waiters = [];
	emitter.on(event, (...args) => {
		fired = true;
		value = args.length > 1 ? args : args[0];
		const pending = waiters;
		waiters = [];
		pending.forEach((w) => w.resolve(value));
	});
	return {
		get fired() { return fired; },
		get value() { return value; },
		wait(timeoutMs, label) {
			if (fired) return Promise.resolve(value);
			return new Promise((resolve, reject) => {
				const waiter = { resolve: null };
				const timer = setTimeout(() => {
					waiters = waiters.filter((w) => w !== waiter);
					reject(new ScanError('timeout', `Pas de réponse : ${label || event}`));
				}, timeoutMs);
				waiter.resolve = (v) => { clearTimeout(timer); resolve(v); };
				waiters.push(waiter);
			});
		}
	};
}

function decodeJwtExpiry(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
		return payload.exp ? payload.exp * 1000 : 0;
	} catch (err) {
		return 0;
	}
}

function avatarUrl(persona) {
	const hash = persona && persona.avatar_hash;
	if (!hash) return null;
	const hex = Buffer.from(hash).toString('hex');
	if (/^0+$/.test(hex)) return null; // avatar par défaut
	return `https://avatars.steamstatic.com/${hex}_full.jpg`;
}

// ---------------------------------------------------------------------------
// Une session = un compte, du login au logoff.
// ---------------------------------------------------------------------------

class ScanSession {
	constructor(account, opts) {
		this.account = account;
		this.opts = opts;
		this.client = null;
		this.cs = null;
		this.usedCredentials = false;
		this.newRefreshToken = null;
		this.gcLog = [];
		this.mmHelloTimer = null;
		this.gcClientVersion = opts.gcClientVersion || null; // null = valeur de la lib
		this.welcomeVersion = 0; // version annoncée par le GC dans ClientWelcome
		this.pushedPenalty = null; // sanction annoncée spontanément par le GC (9118/9112)
		this.welcomeHello = null;  // hello matchmaking extrait de ClientWelcome.game_data2
	}

	/**
	 * Point de sortie unique des journaux de scan. Le masquage est appliqué ICI,
	 * et non chez chaque appelant : steam-user relaie des réponses brutes de
	 * steam-session contenant refreshToken et accessToken en entier, et ces lignes
	 * finissent à l'écran, dans la console et dans des copier-coller.
	 */
	log(message) {
		if (this.opts.onLog) this.opts.onLog(redact(message));
	}

	/** Trace horodatée de tout ce qui transite avec le Game Coordinator. */
	gcTrace(message) {
		const stamp = new Date().toISOString().slice(11, 23);
		const line = redact(`${stamp} ${message}`);
		this.gcLog.push(line);
		if (this.gcLog.length > GC_LOG_MAX_LINES) this.gcLog.shift();
		this.log(`[GC] ${message}`);
	}

	/**
	 * Demande explicitement les données de compte au GC. globaloffensive 3.3.0
	 * n'envoie que ClientHello (4006) ; le GC CS:GO répondait spontanément par
	 * MatchmakingGC2ClientHello (9110), le GC CS2 attend qu'on le lui demande
	 * via MatchmakingClient2GCHello (9109). Sans cet envoi, `accountData` ne
	 * part jamais.
	 */
	sendMatchmakingHello() {
		if (!this.cs || !this.client || !this.client.steamID) return false;
		const sent = this.cs._send(
			GCLanguage.MatchmakingClient2GCHello,
			GCProtos.CMsgGCCStrike15_v2_MatchmakingClient2GCHello,
			{}
		);
		this.gcTrace(`→ MatchmakingClient2GCHello (9109)${sent ? '' : ' — NON ENVOYÉ (pas de steamID)'}`);
		return sent;
	}

	/**
	 * Demande notre propre profil joueur (ClientRequestPlayersProfile, 9127).
	 * La réponse PlayersProfile (9128) contient account_profiles[], dont chaque
	 * entrée est exactement un CMsgGCCStrike15_v2_MatchmakingGC2ClientHello :
	 * penalty_seconds, penalty_reason, vac_banned, rankings, player_level… C'est
	 * la voie par laquelle le GC CS2 livre ces données quand il ignore 9109.
	 */
	requestOwnProfile() {
		if (!this.cs || !this.client || !this.client.steamID) return false;
		const result = this.cs.requestPlayersProfile(this.client.steamID);
		this.gcTrace(`→ ClientRequestPlayersProfile (9127) account_id=${this.client.steamID.accountid} request_level=32${result === false ? ' — REFUSÉ par la lib (SteamID invalide)' : ''}`);
		return result !== false;
	}

	stopMatchmakingHello() {
		if (this.mmHelloTimer) {
			clearInterval(this.mmHelloTimer);
			this.mmHelloTimer = null;
		}
	}

	async run({ forceCredentials = false } = {}) {
		const account = this.account;
		const client = new SteamUser({
			dataDirectory: this.opts.dataDirectory,
			autoRelogin: false,          // pas de reconnexion sauvage pendant un scan
			enablePicsCache: true,       // requis par ownsApp() pour la détection Prime
			picsCacheAll: false,
			changelistUpdateInterval: 0,
			renewRefreshTokens: true,    // Steam renouvelle le token avant expiration, on le récupère
			saveAppTickets: false
		});
		this.client = client;
		this.cs = new GlobalOffensive(client);

		// La lib annonce une version de client CS2 codée en dur (2000244, fin 2023).
		// Le GC accepte la session mais ignore ensuite les messages matchmaking d'un
		// client "périmé". On réécrit le champ au passage, sans modifier la lib.
		const originalSend = this.cs._send.bind(this.cs);
		this.cs._send = (type, protobuf, body) => {
			if (type === GCLanguage.ClientHello && body && typeof body === 'object') {
				const version = this.gcClientVersion || body.version;
				body = { ...body, version };
				this.gcTrace(`→ ClientHello (4006) version=${version}${this.gcClientVersion ? '' : ' (défaut de la lib)'}`);
			}
			return originalSend(type, protobuf, body);
		};

		// Canal d'erreur fatale : toute attente court contre lui.
		let fail;
		const fatal = new Promise((_, reject) => { fail = reject; });
		fatal.catch(() => {}); // pas d'unhandled rejection si personne ne l'attend

		client.on('error', (err) => {
			this.log(`Erreur Steam : ${err.message} (EResult ${err.eresult == null ? '?' : `${err.eresult} ${EResult[err.eresult] || ''}`})`);
			fail(err);
		});
		client.on('disconnected', (eresult, msg) => {
			fail(new ScanError('disconnected', `Déconnecté par Steam : ${msg || EResult[eresult] || eresult}`, { eresult }));
		});
		client.on('refreshToken', (token) => { this.newRefreshToken = token; });
		client.on('playingState', (blocked, appid) => {
			this.gcTrace(`◆ session de jeu : ${blocked ? 'BLOQUÉE' : 'libre'}${appid ? ` (app ${appid})` : ''}`);
		});

		// Journal brut du GC : ce que globaloffensive envoie, reçoit (traité ou
		// non), et l'état de session. C'est la seule façon de voir ce que le GC
		// CS2 renvoie vraiment quand quelque chose ne colle pas.
		this.cs.on('debug', (message) => this.gcTrace(message));
		this.cs.on('connectedToGC', () => this.gcTrace('◆ connectedToGC (ClientWelcome 4004 reçu)'));
		this.cs.on('connectionStatus', (status) => this.gcTrace(`◆ connectionStatus = ${status}`));
		this.cs.on('disconnectedFromGC', (reason) => this.gcTrace(`◆ disconnectedFromGC (${reason})`));
		this.cs.on('accountData', (proto) => {
			this.stopMatchmakingHello();
			this.gcTrace(`← MatchmakingGC2ClientHello (9110) : penalty_seconds=${proto.penalty_seconds} penalty_reason=${proto.penalty_reason} vac_banned=${proto.vac_banned} rankings=${(proto.rankings || []).length}`);
		});
		this.cs.on('playersProfile', (profile) => {
			this.stopMatchmakingHello();
			this.gcTrace(`← PlayersProfile (9128) account_id=${profile.account_id} : penalty_seconds=${profile.penalty_seconds} penalty_reason=${profile.penalty_reason} vac_banned=${profile.vac_banned} player_level=${profile.player_level} rankings=${(profile.rankings || []).length}`);
		});
		// Côté steam-user, seules les lignes qui concernent le GC ou l'app lancée.
		client.on('debug', (message) => {
			const text = String(message);
			if (/\bGC\b|FromGC|ToGC|gamesPlayed|ClientGamesPlayed|PlayingSession/i.test(text)) {
				this.gcTrace(`steam-user: ${text}`);
			} else if (/steam-session|logon response|Handle logon|LogOn/i.test(text)) {
				// Diagnostic de login : steam-user y met l'erreur brute de steam-session,
				// que son EResult synthétisé (TwoFactorCodeMismatch) peut masquer.
				this.log(`steam-user: ${text}`);
			}
		});
		// Sonde la plus brute possible : chaque message GC vu par steam-user, avant
		// même que globaloffensive décide s'il le traite. Si 9110 n'apparaît jamais
		// ici, le GC ne l'a pas envoyé ; s'il apparaît sans accountData derrière,
		// c'est la bibliothèque qui le perd.
		client.on('receivedFromGC', (appid, msgType, payload) => {
			if (appid !== CS2_APPID) return;
			this.gcTrace(`← ${gcMessageName(msgType)} (${msgType}) ${payload ? payload.length : 0} octets`);
			// Le welcome porte la version du GC : c'est la référence pour ClientHello.
			if (msgType === GCLanguage.ClientWelcome) {
				try {
					const welcome = decodeProto(GCProtos.CMsgClientWelcome, payload);
					// LA source des sanctions sous CS2. Le GC n'envoie plus
					// MatchmakingGC2ClientHello (9110) comme message autonome : il le
					// glisse, sérialisé, dans le champ `game_data2` du ClientWelcome.
					// C'est de là que le vrai client tire penalty_seconds / vac_banned,
					// et c'est le seul endroit où on les trouve (PlayersProfile ne les
					// porte pas, 9110 n'arrive jamais).
					if (welcome.game_data2 && welcome.game_data2.length) {
						try {
							const hello = decodeProto(GCProtos.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, welcome.game_data2);
							const mine = this.client.steamID && Number(hello.account_id) === this.client.steamID.accountid;
							if (mine) {
								this.welcomeHello = hello;
								this.gcTrace(`◆ game_data2 = MatchmakingGC2ClientHello (${welcome.game_data2.length} o) : penalty_seconds=${hello.penalty_seconds} penalty_reason=${hello.penalty_reason} vac_banned=${hello.vac_banned}`);
							} else {
								this.gcTrace(`◆ game_data2 décodé mais account_id=${hello.account_id} ne correspond pas — ignoré`);
							}
						} catch (err) {
							this.gcTrace(`◆ game_data2 non décodable en hello : ${err.message}`);
						}
					}
					this.welcomeVersion = Number(welcome.version || 0);
					const announced = this.gcClientVersion || LIB_DEFAULT_GC_VERSION;
					this.gcTrace(this.welcomeVersion
						? `◆ ClientWelcome.version = ${this.welcomeVersion} (nous avons annoncé ${announced})`
						: `◆ ClientWelcome sans champ version — le GC ne contredit pas la version annoncée (${announced})`);
				} catch (err) {
					this.gcTrace(`◆ ClientWelcome indéchiffrable : ${err.message}`);
				}
			}
			// Une réponse 9128 vide n'émet rien côté lib : on veut la voir quand même.
			if (msgType === GCLanguage.PlayersProfile) {
				try {
					const pp = decodeProto(GCProtos.CMsgGCCStrike15_v2_PlayersProfile, payload);
					const n = (pp.account_profiles || []).length;
					this.gcTrace(`◆ PlayersProfile : ${n} profil(s)${n ? '' : " — réponse VIDE, la lib n'émettra pas playersProfile"}`);
				} catch (err) {
					this.gcTrace(`◆ PlayersProfile indéchiffrable : ${err.message}`);
				}
			}
			// Messages de sanction que globaloffensive ne gère pas : sans ces deux
			// décodages, le GC peut nous annoncer un cooldown et la bibliothèque le
			// jette en silence ("Got unhandled GC message").
			if (msgType === GCLanguage.ServerNotificationForUserPenalty) {
				try {
					const n = decodeProto(GCProtos.CMsgGCCStrike15_v2_ServerNotificationForUserPenalty, payload);
					this.pushedPenalty = {
						seconds: Number(n.seconds || 0),
						reason: n.reason == null ? null : Number(n.reason),
						communicationCooldown: !!n.communication_cooldown,
						source: 'ServerNotificationForUserPenalty (9118)'
					};
					this.gcTrace(`◆ SANCTION POUSSÉE (9118) : seconds=${n.seconds} reason=${n.reason} communication=${!!n.communication_cooldown}`);
				} catch (err) {
					this.gcTrace(`◆ 9118 indéchiffrable : ${err.message}`);
				}
			}
			if (msgType === GCLanguage.MatchmakingGC2ClientAbandon) {
				try {
					const a = decodeProto(GCProtos.CMsgGCCStrike15_v2_MatchmakingGC2ClientAbandon, payload);
					this.pushedPenalty = {
						seconds: Number(a.penalty_seconds || 0),
						reason: a.penalty_reason == null ? null : Number(a.penalty_reason),
						communicationCooldown: false,
						source: 'MatchmakingGC2ClientAbandon (9112)'
					};
					this.gcTrace(`◆ SANCTION POUSSÉE (9112) : penalty_seconds=${a.penalty_seconds} penalty_reason=${a.penalty_reason}`);
				} catch (err) {
					this.gcTrace(`◆ 9112 indéchiffrable : ${err.message}`);
				}
			}
			// Tout message que la bibliothèque ne traite pas est tracé en hexadécimal :
			// c'est la seule façon de découvrir où le GC CS2 a déplacé une information.
			if (this.cs && !this.cs._handlers[msgType] && payload && payload.length && payload.length <= 512) {
				this.gcTrace(`  hex ${gcMessageName(msgType)}: ${Buffer.from(payload).toString('hex')}`);
			}
		});

		// Si Steam redemande un code malgré celui fourni, on en renvoie un frais une
		// seule fois ; sinon on abandonne au lieu de boucler et de brûler des essais.
		let guardRetried = false;
		client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
			this.log(`Steam demande un code Steam Guard (domain=${domain || 'aucun → TOTP'}, lastCodeWrong=${!!lastCodeWrong}, décalage=${this.opts.timeOffset == null ? '?' : this.opts.timeOffset + ' s'})`);
			// Trois situations très différentes arrivaient toutes ici sous le même
			// code d'erreur, avec des conséquences contradictoires (bandeau
			// « passager » et état « identifiants à revoir » en même temps).
			if (domain) {
				// `domain` renseigné = Steam réclame un code par E-MAIL. Donc ce compte
				// n'a pas d'authenticator mobile côté Steam, quel que soit le
				// shared_secret qu'on a en base : celui-ci est périmé ou étranger au
				// compte. Attendre n'y changera rien, c'est une impasse jusqu'à action.
				return fail(new ScanError('emailguard',
					`Ce compte est en Steam Guard e-mail (code envoyé à ${domain}), pas en authenticator mobile. `
					+ (account.sharedSecret
						? 'Le shared_secret enregistré ne correspond donc à rien côté Steam : retire-le et crée un authenticator depuis l\'app.'
						: 'Crée un authenticator depuis l\'app pour pouvoir le scanner.'),
					{ authFailed: true }));
			}
			if (!account.sharedSecret) {
				return fail(new ScanError('nosecret',
					'Aucun shared_secret enregistré pour ce compte : impossible de produire un code Steam Guard.',
					{ authFailed: true }));
			}
			if (lastCodeWrong || guardRetried) {
				// Code TOTP refusé : shared_secret faux, horloge décalée, ou throttle
				// 2FA de Steam. Passager, donc on ne déclasse pas le compte.
				return fail(new ScanError('badtotp',
					'Code Steam Guard refusé — shared_secret faux, horloge décalée, ou throttle 2FA',
					{ authFailed: false }));
			}
			guardRetried = true;
			const code = await this.opts.nextAuthCode(account);
			this.log('Steam redemande un code, nouvel essai avec un code frais');
			callback(code);
		});

		const loggedOn = latch(client, 'loggedOn');
		const playingState = latch(client, 'playingState');
		const accountInfo = latch(client, 'accountInfo');
		const ownership = latch(client, 'ownershipCached');
		const gcHello = latch(this.cs, 'accountData');
		const ownProfile = latch(this.cs, 'playersProfile');
		const gcConnected = latch(this.cs, 'connectedToGC');
		const matchList = latch(this.cs, 'matchList');

		const scannedAt = Date.now();
		try {
			const usingToken = !forceCredentials && this.isTokenUsable();
			if (usingToken) {
				this.log('Connexion via refresh token mis en cache');
				client.logOn({ refreshToken: account.refreshToken, logonID: randomLogonId() });
			} else {
				if (!account.password) {
					throw new ScanError('nocreds', 'Mot de passe Steam manquant pour ce compte', { authFailed: true });
				}
				if (!account.sharedSecret) {
					throw new ScanError('nocreds', 'shared_secret manquant (importe le .maFile)', { authFailed: true });
				}
				const code = await this.opts.nextAuthCode(account);
				this.log('Connexion par mot de passe (code Steam Guard généré depuis le shared_secret)');
				client.logOn({
					accountName: account.username,
					password: account.password,
					twoFactorCode: code,
					logonID: randomLogonId()
				});
				this.usedCredentials = true;
			}

			await Promise.race([loggedOn.wait(this.opts.loginTimeoutMs, 'login Steam'), fatal]);

			const steamId = client.steamID.getSteamID64();
			this.log(`Connecté (${steamId})`);

			if (this.opts.offlinePersona) {
				client.setPersona(SteamUser.EPersonaState.Offline);
			}

			// Steam n'accorde qu'UNE session de jeu par compte. Si le vrai client
			// joue déjà, notre gamesPlayed est refusé, globaloffensive voit un
			// appQuit immédiat et n'envoie jamais son hello : le scan finit en
			// timeout incompréhensible. Le serveur nous l'annonce dans
			// ClientPlayingSessionState, reçu juste après le login — on s'arrête
			// donc ici, avant d'avoir touché à la partie en cours.
			await Promise.race([sleep(1200), playingState.wait(1200, 'état de session').catch(() => null)]);
			const playing = client.playingState;
			if (playing && playing.blocked) {
				const where = playing.appid ? ` (app ${playing.appid})` : '';
				throw new ScanError('playing',
					`Ce compte joue en ce moment${where} — Steam n'autorise qu'une session de jeu à la fois. Quitte la partie puis relance le scan.`);
			}

			this.log('Lancement de CS2 et attente du Game Coordinator…');
			this.gcTrace(`→ gamesPlayed([${CS2_APPID}])`);
			client.gamesPlayed([CS2_APPID]);

			await Promise.race([gcConnected.wait(this.opts.gcTimeoutMs, 'connexion au GC CS2'), fatal]);

			// Si le GC s'annonce dans une autre version que celle envoyée, on se
			// réaligne tout de suite : nouveau ClientHello avec SA version, envoyé en
			// direct (la lib refuse d'en renvoyer un tant qu'elle a une session).
			const announced = this.gcClientVersion || LIB_DEFAULT_GC_VERSION;
			if (this.welcomeVersion && this.welcomeVersion !== announced) {
				this.gcTrace(`◆ version GC ${this.welcomeVersion} ≠ annoncée ${announced} — réalignement`);
				this.gcClientVersion = this.welcomeVersion;
				this.cs._send(GCLanguage.ClientHello, GCProtos.CMsgClientHello, {
					version: this.welcomeVersion,
					client_session_need: 0,
					client_launcher: 0,
					steam_launcher: 0
				});
				await sleep(1500);
			}

			// Session GC ouverte. Deux demandes en parallèle, relancées toutes les 5 s :
			//  - MatchmakingClient2GCHello (9109) → MatchmakingGC2ClientHello (9110),
			//    la voie CS:GO, que le GC CS2 ignore en pratique ;
			//  - ClientRequestPlayersProfile (9127) sur notre propre compte →
			//    PlayersProfile (9128), dont account_profiles[0] a exactement la forme
			//    d'un MatchmakingGC2ClientHello.
			// La première réponse qui arrive gagne, et les deux alimentent le même
			// normalizeAccountData.
			const requestAccountData = () => {
				this.sendMatchmakingHello();
				this.requestOwnProfile();
			};
			requestAccountData();
			this.mmHelloTimer = setInterval(() => {
				if (gcHello.fired || ownProfile.fired) return this.stopMatchmakingHello();
				requestAccountData();
			}, MM_HELLO_RETRY_MS);

			let gc;
			let gcSource = null;
			try {
				// Plancher à 40 s quel que soit le réglage : le premier hello CS2 est lent.
				const waitMs = Math.max(40000, this.opts.gcTimeoutMs);
				gc = await Promise.race([
					gcHello.wait(waitMs, 'données du GC CS2').then((p) => { gcSource = 'MatchmakingGC2ClientHello (9110)'; return p; }),
					ownProfile.wait(waitMs, 'profil joueur du GC CS2').then((p) => { gcSource = 'PlayersProfile (9128)'; return p; }),
					fatal
				]);
			} finally {
				this.stopMatchmakingHello();
			}
			this.log(`Données GC reçues via ${gcSource}`);

			const data = normalizeAccountData(gc, scannedAt);
			data.gcSource = gcSource;

			// PlayersProfile ne porte pas les sanctions ; le hello encapsulé dans
			// ClientWelcome.game_data2, si. Il est autoritaire : un champ absent y
			// signifie bien zéro. Il écrase donc l'« inconnu » venu de 9128.
			if (this.welcomeHello) {
				const auth = normalizeAccountData(this.welcomeHello, scannedAt, { authoritative: true });
				data.penaltyKnown = true;
				data.penaltySeconds = auth.penaltySeconds;
				data.penaltyReason = auth.penaltyReason;
				data.penaltyReasonLabel = auth.penaltyReasonLabel;
				data.penaltyPermanent = auth.penaltyPermanent;
				data.penaltyEndsAt = auth.penaltyEndsAt;
				data.vacKnown = true;
				data.vacBanned = auth.vacBanned;
				data.penaltySource = 'ClientWelcome.game_data2';
				// Le hello peut aussi porter niveau et classements : on ne prend que
				// ce que PlayersProfile n'a pas fourni.
				if (!data.rankings.length && auth.rankings.length) {
					data.rankings = auth.rankings;
					data.premierRating = auth.premierRating;
					data.premierWins = auth.premierWins;
					data.premierLabel = auth.premierLabel;
				}
				if (data.playerLevel == null && auth.playerLevel != null) data.playerLevel = auth.playerLevel;
				this.log(auth.penaltySeconds > 0
					? `Sanction lue dans game_data2 : ${auth.penaltySeconds}s (raison ${auth.penaltyReason})`
					: `Aucune sanction (confirmé par game_data2)`);
			}

			// Filet de sécurité : si le GC a poussé une sanction de lui-même (9118/9112)
			// et qu'on n'a rien d'autre, elle fait foi.
			if (!data.penaltyKnown && this.pushedPenalty) {
				const p = this.pushedPenalty;
				data.penaltyKnown = true;
				data.penaltySeconds = p.seconds;
				data.penaltyReason = p.reason;
				data.penaltyReasonLabel = penaltyReasonLabel(p.reason);
				data.penaltyPermanent = p.reason !== null && PERMANENT_PENALTY_REASONS.has(p.reason);
				data.penaltyEndsAt = p.seconds > 0 ? scannedAt + p.seconds * 1000 : 0;
				data.penaltySource = p.source;
				data.communicationCooldown = p.communicationCooldown;
				this.log(`Sanction récupérée via ${p.source} : ${p.seconds}s, raison ${p.reason}`);
			}
			data.scannedAt = scannedAt;
			data.steamId = steamId;
			data.usedRefreshToken = usingToken;
			data.authFailed = false;
			data.gcLog = this.gcLog.slice();
			data.gcClientVersion = this.gcClientVersion || LIB_DEFAULT_GC_VERSION;
			data.gcWelcomeVersion = this.welcomeVersion;

			// Prime = possession de l'app "Prime Status Upgrade". Déduit de la liste
			// réelle des licences, pas d'une liste de packages codée en dur.
			try {
				await Promise.race([ownership.wait(25000, 'cache des licences'), fatal]);
				data.prime = client.ownsApp(PRIME_APPID);
				data.ownsCs2 = client.ownsApp(CS2_APPID);
				data.ownedAppCount = client.getOwnedApps().length;
			} catch (err) {
				this.log(`Licences indisponibles (${err.message}) — statut Prime inconnu`);
				data.prime = null;
				data.ownsCs2 = null;
			}

			// Pseudo + avatar + dernière connexion
			data.personaName = accountInfo.fired ? accountInfo.value[0] : null;
			try {
				const res = await client.getPersonas([client.steamID]);
				const persona = res && res.personas ? res.personas[steamId] : null;
				if (persona) {
					data.personaName = persona.player_name || data.personaName;
					data.avatar = avatarUrl(persona);
					data.lastLogoff = persona.last_logoff ? Number(persona.last_logoff) * 1000 : 0;
					data.lastLogon = persona.last_logon ? Number(persona.last_logon) * 1000 : 0;
				}
			} catch (err) {
				this.log(`Profil indisponible : ${err.message}`);
			}

			// Dernière partie CS2. Valve a changé l'historique des matchs sous CS2, donc
			// ce point peut légitimement ne rien renvoyer : on n'en fait pas une erreur.
			if (this.opts.fetchRecentGames) {
				try {
					this.cs.requestRecentGames(client.steamID);
					const matches = await matchList.wait(12000, 'historique des parties');
					const list = Array.isArray(matches) ? matches[0] : matches;
					const times = (list || []).map((m) => Number(m.matchtime || 0)).filter(Boolean);
					data.lastMatchAt = times.length ? Math.max.apply(null, times) * 1000 : 0;
					data.recentMatchCount = (list || []).length;
				} catch (err) {
					data.lastMatchAt = 0;
					data.recentMatchCount = 0;
				}
			}

			return { ok: true, data, refreshToken: this.newRefreshToken, usedCredentials: this.usedCredentials };
		} finally {
			await this.teardown();
		}
	}

	isTokenUsable() {
		const { refreshToken, refreshTokenExpiresAt } = this.account;
		if (!refreshToken) return false;
		// Marge d'une heure : inutile de partir avec un token qui va expirer en route.
		if (refreshTokenExpiresAt && refreshTokenExpiresAt < Date.now() + 3600000) return false;
		return true;
	}

	async teardown() {
		this.stopMatchmakingHello();
		const client = this.client;
		if (!client) return;
		try { client.gamesPlayed([]); } catch (err) { /* déjà déconnecté */ }
		try { client.logOff(); } catch (err) { /* idem */ }
		// On laisse une seconde au logoff pour partir proprement, puis on coupe.
		await sleep(1000);
		try {
			client.removeAllListeners();
			if (this.cs) this.cs.removeAllListeners();
		} catch (err) { /* rien à faire */ }
		this.client = null;
		this.cs = null;
	}
}

// ---------------------------------------------------------------------------
// File d'attente + anti rate-limit
// ---------------------------------------------------------------------------

class Scanner extends EventEmitter {
	constructor({ dataDirectory, vault }) {
		super();
		this.dataDirectory = dataDirectory;
		this.vault = vault;
		this.timeOffset = 0;
		this.timeSyncedAt = 0;
		this.queue = [];
		this.currentId = null;
		this.pumping = false;
		this.stopRequested = false;
		this.pausedUntil = 0;
		this.pauseReason = null;
		this.rateLimitHits = 0;
		this.lastLoginAt = 0;
		this.usedCodes = new Map();
		this.localGcVersion = undefined; // undefined = steam.inf pas encore cherché
		this.learnedGcVersion = 0;       // version lue dans un ClientWelcome du GC
	}

	/**
	 * Version de client CS2 à annoncer au GC. Priorité : réglage explicite,
	 * puis steam.inf de l'installation locale, puis version apprise du GC lors
	 * d'un scan précédent. null => la lib garde sa valeur par défaut.
	 */
	async resolveGcClientVersion() {
		if (this.settings.gcClientVersion) return Number(this.settings.gcClientVersion);
		if (this.localGcVersion === undefined) {
			this.localGcVersion = null;
			try {
				const steamExe = await launcher.findSteam(this.settings.steamPath);
				const found = launcher.findCs2ClientVersion(steamExe);
				if (found) {
					this.localGcVersion = found.version;
					this.emit('log', { message: `Version CS2 locale : ${found.version} (${found.file})` });
				} else {
					this.emit('log', { message: 'CS2 non installé localement : version GC apprise au premier welcome' });
				}
			} catch (err) {
				this.emit('log', { message: `Version CS2 locale indisponible : ${err.message}` });
			}
		}
		return this.localGcVersion || this.learnedGcVersion || null;
	}

	/** Mémorise la version annoncée par le GC pour que les scans suivants partent juste. */
	rememberGcVersion(version) {
		const v = Number(version || 0);
		if (!v || v === this.learnedGcVersion) return;
		this.learnedGcVersion = v;
		if (Number(this.settings.gcClientVersion) !== v && typeof this.vault.updateSettings === 'function') {
			this.vault.updateSettings({ gcClientVersion: v });
			this.emit('log', { message: `Version GC mémorisée : ${v}` });
		}
	}

	get settings() {
		return this.vault.settings;
	}

	status() {
		return {
			queued: this.queue.map((j) => j.account.id),
			current: this.currentId,
			pausedUntil: this.pausedUntil,
			pauseReason: this.pauseReason,
			busy: this.pumping
		};
	}

	/**
	 * L'horloge locale décalée est la première cause de TwoFactorCodeMismatch.
	 * On aligne une fois par heure sur l'horloge de Steam.
	 */
	async syncTime() {
		if (this.timeSyncedAt && Date.now() - this.timeSyncedAt < 3600000) return this.timeOffset;
		const offset = await new Promise((resolve) => {
			SteamTotp.getTimeOffset((err, off) => resolve(err ? 0 : off));
		});
		this.timeOffset = offset || 0;
		this.timeSyncedAt = Date.now();
		this.emit('log', { message: `Décalage d'horloge Steam : ${this.timeOffset} s` });
		return this.timeOffset;
	}

	msUntilNextTotpWindow() {
		const t = Math.floor(Date.now() / 1000) + this.timeOffset;
		return (30 - (t % 30)) * 1000;
	}

	/** Un code TOTP ne vaut qu'une fois : si on vient de l'utiliser, on attend la fenêtre suivante. */
	async nextAuthCode(account) {
		await this.syncTime();
		let code = SteamTotp.generateAuthCode(account.sharedSecret, this.timeOffset);
		if (this.usedCodes.get(account.username) === code) {
			const waitMs = this.msUntilNextTotpWindow() + 1500;
			this.emit('progress', {
				accountId: account.id,
				phase: 'waiting',
				message: `Code Steam Guard déjà consommé, attente de ${Math.ceil(waitMs / 1000)} s`
			});
			await sleep(waitMs);
			code = SteamTotp.generateAuthCode(account.sharedSecret, this.timeOffset);
		}
		this.usedCodes.set(account.username, code);
		return code;
	}

	enqueue(accountIds, { forceCredentials = false } = {}) {
		const added = [];
		for (const id of accountIds) {
			const account = this.vault.find(id);
			if (!account) continue;
			if (this.currentId === id || this.queue.some((j) => j.account.id === id)) continue;
			this.queue.push({ account, forceCredentials, rateLimitRetries: 0, authRetried: false });
			added.push(id);
		}
		this.emit('queue', this.status());
		this.pump();
		return added;
	}

	dequeue(accountId) {
		this.queue = this.queue.filter((j) => j.account.id !== accountId);
		this.emit('queue', this.status());
	}

	stop() {
		this.stopRequested = true;
		this.queue = [];
		this.pausedUntil = 0;
		this.pauseReason = null;
		this.emit('queue', this.status());
	}

	/** Respecte le délai minimum entre deux logins et la pause anti rate-limit. */
	async waitForSlot(job) {
		while (!this.stopRequested) {
			const now = Date.now();
			if (this.pausedUntil > now) {
				const left = Math.ceil((this.pausedUntil - now) / 1000);
				this.emit('progress', {
					accountId: job.account.id,
					phase: 'paused',
					message: `${this.pauseReason} — reprise dans ${left} s`
				});
				await sleep(Math.min(5000, this.pausedUntil - now));
				continue;
			}
			this.pauseReason = null;

			const tokenOk = job.account.refreshToken
				&& (!job.account.refreshTokenExpiresAt || job.account.refreshTokenExpiresAt > now + 3600000);
			const willUseCredentials = job.forceCredentials || !tokenOk;
			const needed = willUseCredentials ? this.settings.credentialDelayMs : this.settings.tokenDelayMs;
			const elapsed = now - this.lastLoginAt;
			if (this.lastLoginAt && elapsed < needed) {
				const left = Math.ceil((needed - elapsed) / 1000);
				this.emit('progress', {
					accountId: job.account.id,
					phase: 'waiting',
					message: `Temporisation anti rate-limit : ${left} s`
				});
				await sleep(Math.min(2000, needed - elapsed));
				continue;
			}
			return;
		}
	}

	async pump() {
		if (this.pumping) return;
		this.pumping = true;
		this.stopRequested = false;
		try {
			while (this.queue.length && !this.stopRequested) {
				const job = this.queue.shift();
				this.currentId = job.account.id;
				this.emit('queue', this.status());
				await this.waitForSlot(job);
				if (this.stopRequested) break;
				await this.runJob(job);
				this.currentId = null;
				this.emit('queue', this.status());
			}
		} finally {
			this.currentId = null;
			this.pumping = false;
			this.emit('queue', this.status());
			this.emit('idle');
		}
	}

	async runJob(job) {
		const account = job.account;
		const onLog = (message) => this.emit('progress', { accountId: account.id, phase: 'scanning', message });
		this.emit('progress', { accountId: account.id, phase: 'start', message: 'Démarrage du scan' });

		const gcClientVersion = await this.resolveGcClientVersion();
		const session = new ScanSession(account, {
			gcClientVersion,
			timeOffset: this.timeOffset,
			dataDirectory: this.dataDirectory,
			loginTimeoutMs: this.settings.loginTimeoutMs,
			gcTimeoutMs: this.settings.gcTimeoutMs,
			offlinePersona: this.settings.offlinePersona,
			fetchRecentGames: this.settings.fetchRecentGames,
			nextAuthCode: (acc) => this.nextAuthCode(acc),
			onLog
		});

		const usedToken = !job.forceCredentials && session.isTokenUsable();
		this.lastLoginAt = Date.now();
		let result;
		try {
			result = await session.run({ forceCredentials: job.forceCredentials });
		} catch (rawErr) {
			const err = classify(rawErr);
			this.rememberGcVersion(session.welcomeVersion); // le welcome a pu arriver même si 9110 non

			// Un refresh token peut avoir été révoqué (changement de mot de passe,
			// déconnexion de tous les appareils). On retente alors une fois avec les
			// identifiants complets avant de déclarer le compte expiré.
			if (err.authFailed && usedToken && !job.authRetried) {
				onLog('Refresh token refusé, nouvelle tentative avec le mot de passe');
				this.vault.patch(account.id, { refreshToken: null, refreshTokenExpiresAt: 0 });
				job.authRetried = true;
				job.forceCredentials = true;
				this.queue.unshift(job);
				return;
			}

			if (err.kind === 'badtotp') {
				// Le throttle 2FA de Steam se lève en quelques minutes ; on laisse
				// respirer avant le compte suivant plutôt que d'aggraver la pénalité.
				this.pausedUntil = Date.now() + BADTOTP_PAUSE_MS;
				this.pauseReason = 'Code Steam Guard refusé — pause anti-throttle 2FA';
			}

			if (err.kind === 'ratelimit') {
				this.rateLimitHits += 1;
				this.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
				this.pauseReason = 'Rate limit Steam';
				this.emit('rateLimit', { until: this.pausedUntil, hits: this.rateLimitHits });
				if (this.rateLimitHits <= MAX_RATE_LIMIT_HITS && job.rateLimitRetries < 1) {
					job.rateLimitRetries += 1;
					this.queue.unshift(job); // on réessaiera après la pause
					return;
				}
				this.stop();
			}

			// Steam a réclamé un code e-mail : il n'y a pas d'authenticator mobile sur
			// ce compte, donc le shared_secret qu'on garde ne vaut rien. On le marque,
			// sinon l'interface continue d'afficher un code Steam Guard inutilisable.
			if (err.kind === 'emailguard') {
				this.vault.patch(account.id, { secretRejected: true });
			}

			this.vault.patch(account.id, {
				lastScanAt: Date.now(),
				lastScanOk: false,
				// Le journal GC est joint à l'erreur : sans lui, un timeout GC est indéchiffrable.
				lastError: { kind: err.kind, message: err.message, eresult: err.eresult, at: Date.now(), gcLog: session.gcLog.slice() },
				// scannedAt n'est PAS rafraîchi : les données datent du dernier scan réussi,
				// les faire passer pour fraîches masquerait leur ancienneté.
				cache: Object.assign({}, account.cache || {}, { authFailed: err.authFailed, gcLog: session.gcLog.slice() })
			});
			this.emit('result', { accountId: account.id, ok: false, error: { kind: err.kind, message: err.message, gcLog: session.gcLog.slice() } });
			return;
		}

		const patch = {
			lastScanAt: Date.now(),
			lastScanOk: true,
			lastError: null,
			secretRejected: false,
			cache: result.data
		};
		if (result.data.steamId) patch.steamId = result.data.steamId;
		if (result.refreshToken) {
			patch.refreshToken = result.refreshToken;
			patch.refreshTokenExpiresAt = decodeJwtExpiry(result.refreshToken);
		}
		this.vault.patch(account.id, patch);
		this.rememberGcVersion(session.welcomeVersion);
		this.rateLimitHits = 0;
		this.emit('result', { accountId: account.id, ok: true });
	}
}

module.exports = { Scanner, ScanSession, ScanError, classify, decodeJwtExpiry, gcMessageName };
