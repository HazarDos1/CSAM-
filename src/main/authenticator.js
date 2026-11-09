'use strict';
/**
 * Création et retrait d'un authenticator Steam (ITwoFactorService), pour ne plus
 * dépendre de SDA.
 *
 * Le déroulé est interactif et s'étale sur plusieurs allers-retours avec
 * l'interface, donc la session Steam doit rester ouverte entre les étapes :
 *
 *   login  →  [code e-mail si Steam Guard e-mail]  →  status  →  add
 *          →  [SMS envoyé, secrets reçus]          →  finalize
 *
 * Point critique : `AddAuthenticator` renvoie le `revocation_code` AVANT la
 * finalisation. C'est l'unique porte de secours du compte, et Steam ne le
 * redonne jamais. Il est donc enregistré dans le coffre dès cette étape, avant
 * même que l'utilisateur saisisse le code SMS — si quoi que ce soit échoue
 * ensuite, le code est déjà sauvé.
 */
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
// Schéma interne de steam-user : nécessaire pour relire l'en-tête des réponses
// unifiées, que la lib décode mais n'expose pas dans ses méthodes publiques.
const Schema = require('steam-user/protobufs/generated/_load.js');
const { redact } = require('./redact');

const EResult = SteamUser.EResult;
const PROTO_MASK = 0x80000000;
const ADD_METHOD = 'TwoFactor.AddAuthenticator#1';

/** Nom lisible d'un EResult, sans masquer le nombre. */
function eres(code) {
	return `${code} ${EResult[code] || '?'}`;
}

/**
 * Décrit l'en-tête brut d'une réponse de service.
 *
 * Subtilité à ne pas rater : dans steammessages_base.proto, `eresult` porte
 * `[default = 2]`. Un en-tête qui ne contient PAS le champ se décode donc en 2
 * (Fail). Confondre les deux ferait accuser Steam de refuser alors qu'il n'a
 * rien dit. On distingue donc explicitement présent / absent.
 */
function describeRawHeader(raw) {
	if (!raw) return 'en-tête brut non capturé';
	const bits = [`EMsg ${raw.msg}`];
	bits.push(raw.eresultPresent
		? `eresult ${eres(raw.eresult)}`
		: "eresult absent de l'en-tête (le défaut proto vaut 2, donc aucune erreur de service)");
	if (raw.errorMessage) bits.push(`error_message « ${raw.errorMessage} »`);
	return bits.join(' · ');
}

/**
 * Résume le corps d'AddAuthenticator pour le journal.
 * Les champs porteurs de secret ne sont jamais imprimés : seulement leur
 * présence et leur longueur. `uri` en particulier contient le shared_secret.
 */
const BODY_SAFE = [
	'status', 'server_time', 'account_name', 'token_gid', 'serial_number', 'phone_number_hint',
	// réponses de FinalizeAddAuthenticator et RemoveAuthenticator
	'success', 'want_more', 'revocation_attempts_remaining'
];
const BODY_SECRET = ['shared_secret', 'identity_secret', 'secret_1', 'revocation_code', 'uri'];

/**
 * Résumé de TwoFactor.Status. Les champs sont imprimés même absents, parce que
 * « absent » est une information : `authenticator_allowed` non renvoyé ne veut
 * pas dire « autorisé ».
 */
const STATUS_FIELDS = [
	'state', 'inactivation_reason', 'authenticator_type', 'authenticator_allowed',
	'steamguard_scheme', 'email_validated', 'time_created',
	'revocation_attempts_remaining', 'classified_agent', 'allow_external_authenticator',
	'version', 'token_gid'
];

function summarizeStatus(st) {
	return STATUS_FIELDS
		.map((k) => `${k}=${st[k] === undefined ? 'absent' : st[k]}`)
		.join(' \u00b7 ');
}

function summarizeBody(body) {
	if (!body || typeof body !== 'object') return 'réponse non décodée';
	const parts = [];
	for (const k of BODY_SAFE) {
		if (body[k] !== undefined && body[k] !== null) parts.push(`${k}=${body[k]}`);
	}
	for (const k of BODY_SECRET) {
		if (body[k]) parts.push(`${k}=<présent, ${Buffer.isBuffer(body[k]) ? body[k].length + ' octets' : String(body[k]).length + ' car.'}>`);
	}
	const known = BODY_SAFE.concat(BODY_SECRET);
	const extra = Object.keys(body).filter((k) => !known.includes(k) && body[k] !== null);
	if (extra.length) parts.push(`autres champs : ${extra.join(', ')}`);
	return parts.length ? parts.join(' · ') : 'corps VIDE (aucun champ renseigné)';
}

/**
 * État de l'authenticator renvoyé par TwoFactor.Status.
 * 0 = aucun. Les autres valeurs signifient qu'il y en a déjà un (actif, ou
 * ajouté mais jamais finalisé) : dans les deux cas il faut le retirer d'abord.
 */
const TOKEN_STATE_NONE = 0;

/** Traduit le champ `status` d'AddAuthenticator en message actionnable. */
function describeAddStatus(status) {
	switch (status) {
		case EResult.OK:
			return null;
		case EResult.DuplicateRequest:
			return 'Ce compte a déjà un authenticator. Il faut le retirer avant d\'en créer un nouveau.';
		case EResult.RateLimitExceeded:
			return 'Trop de tentatives récentes. Steam impose une pause : réessaie dans quelques heures.';
		case EResult.Fail:
			return 'Steam a refusé. Cause la plus fréquente : aucun numéro de téléphone rattaché au compte.';
		case EResult.InvalidParam:
			return 'Paramètre refusé par Steam — numéro de téléphone absent ou non vérifié ?';
		default:
			return `Steam a refusé (EResult ${status} ${EResult[status] || '?'}).`;
	}
}

class AuthenticatorSession {
	/**
	 * @param {object} account compte du coffre (username + password requis)
	 * @param {{onLog?: function}} opts
	 */
	constructor(account, opts = {}) {
		this.account = account;
		this.onLog = opts.onLog || (() => {});
		this.client = null;
		this.guardCallback = null; // callback steam-user en attente d'un code
		this.pending = null;       // secrets reçus d'AddAuthenticator
		this.disposed = false;
	}

	log(message) {
		this.onLog(redact(message));
	}

	/**
	 * Attend l'issue de la tentative de login : connecté, ou Steam réclame un code.
	 * Les trois écouteurs sont posés ensemble et retirés ensemble — sans quoi un
	 * `steamGuard` tardif viendrait résoudre une étape suivante.
	 */
	_waitForLoginOutcome() {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.client.removeListener('loggedOn', onLoggedOn);
				this.client.removeListener('steamGuard', onGuard);
				this.client.removeListener('error', onError);
			};
			const onLoggedOn = () => {
				cleanup();
				const steamId = this.client.steamID.getSteamID64();
				this.log(`← loggedOn : connecté (SteamID ${steamId})`);
				resolve({ state: 'loggedOn', steamId });
			};
			const onGuard = (domain, callback, lastCodeWrong) => {
				cleanup();
				this.guardCallback = callback;
				this.log(`← steamGuard : Steam réclame un code par ${domain
					? `e-mail (${domain})`
					: 'authenticator (TOTP)'}${lastCodeWrong ? ' — le code précédent a été refusé' : ''}`);
				resolve({
					state: 'needGuardCode',
					// domain renseigné = code reçu par e-mail ; sinon c'est un code TOTP,
					// que seul un authenticator déjà en place peut produire.
					via: domain ? 'email' : 'authenticator',
					domain: domain || null,
					lastCodeWrong: !!lastCodeWrong
				});
			};
			const onError = (err) => {
				cleanup();
				this.log(`← error : ${err.eresult != null ? `EResult ${eres(err.eresult)} — ` : ''}${err.message}`);
				reject(err);
			};
			this.client.on('loggedOn', onLoggedOn);
			this.client.on('steamGuard', onGuard);
			this.client.on('error', onError);
		});
	}

	async login() {
		if (!this.account.password) {
			throw new Error('Mot de passe Steam manquant pour ce compte');
		}
		this.client = new SteamUser({
			autoRelogin: false,
			enablePicsCache: false,
			renewRefreshTokens: false,
			saveAppTickets: false
		});
		this.client.on('refreshToken', (token) => { this.refreshToken = token; });

		const details = { accountName: this.account.username, password: this.account.password };
		// Si le compte a déjà un authenticator connu de nous, on fournit le code
		// tout de suite : ça évite une étape de saisie inutile avant un retrait.
		if (this.account.sharedSecret) {
			details.twoFactorCode = SteamTotp.generateAuthCode(this.account.sharedSecret);
		}
		this.log(`→ logOn : compte ${this.account.username}, ${details.twoFactorCode
			? 'code TOTP joint depuis le coffre'
			: 'aucun secret en coffre — Steam choisira le canal'}`);
		this.client.logOn(details);
		return this._waitForLoginOutcome();
	}

	async submitGuardCode(code) {
		if (!this.guardCallback) {
			throw new Error('Steam n\'attend aucun code pour le moment');
		}
		const callback = this.guardCallback;
		this.guardCallback = null;
		this.log(`→ code de connexion transmis (${String(code).trim().length} caractères)`);
		const outcome = this._waitForLoginOutcome();
		callback(code);
		return outcome;
	}

	_unified(method, data) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Steam n'a pas répondu (${method})`)), 15000);
			try {
				this.client._sendUnified(method, data, (body) => {
					clearTimeout(timer);
					resolve(body);
				});
			} catch (err) {
				clearTimeout(timer);
				reject(err);
			}
		});
	}

	/**
	 * TwoFactor.Status : l'état de l'authenticator vu par Steam.
	 *
	 * steam-user n'enregistre PAS le protobuf de cette méthode : son
	 * `_sendUnified` cherche `protobufs['TwoFactor.QueryStatus#1_Request']`, ne
	 * trouve rien et plante sur « undefined.encode ». On encode et décode donc
	 * nous-mêmes, puis on passe par `_send`, qui laisse intact un corps déjà
	 * sérialisé (EMsg.ServiceMethodCallFromClient n'a pas de proto de corps dans
	 * sa table). Au retour, aucun proto de réponse n'étant enregistré non plus,
	 * steam-user nous rend les octets bruts — exactement ce qu'il nous faut.
	 *
	 * Le champ décisif est `authenticator_allowed` : « Account allowed to have an
	 * authenticator? ». C'est la seule source qui explique un Fail générique.
	 */
	async twoFactorStatus() {
		// Le rpc s'appelle QueryStatus, pas Status : voir `service TwoFactor` dans
		// steammessages_twofactor.steamclient.proto. Avec le mauvais nom, Steam
		// répond eresult 2 Fail et un corps vide — ce qui ressemble à un refus mais
		// n'est qu'une méthode inconnue.
		const method = 'TwoFactor.QueryStatus#1';
		try {
			if (!this.client || !this.client.steamID) throw new Error('session perdue');
			const Req = Schema.CTwoFactor_Status_Request;
			const payload = Buffer.from(
				Req.encode(Req.fromObject({ steamid: this.client.steamID.getSteamID64() })).finish()
			);
			// Même angle mort que pour AddAuthenticator : sans l'en-tête, un corps
			// vide ressemble à « tous les champs absents » alors que Steam a refusé.
			const watch = this._watchRawResponse(method);
			let body;
			try {
				body = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('pas de réponse en 15 s')), 15000);
					try {
						this.client._send(
							{ msg: SteamUser.EMsg.ServiceMethodCallFromClient, proto: { target_job_name: method } },
							payload,
							(res) => { clearTimeout(timer); resolve(res); }
						);
					} catch (err) {
						clearTimeout(timer);
						reject(err);
					}
				});
			} finally {
				watch.stop();
			}
			const raw = watch.header();
			const bytes = Buffer.isBuffer(body)
				? body
				: Buffer.from(body && body.toBuffer ? body.toBuffer() : body || []);
			this.log(`← ${method} : ${describeRawHeader(raw)} · corps ${bytes.length} octet(s)`);
			if (!bytes.length) {
				// Corps vide : il n'y a rien à lire, et prétendre le contraire ferait
				// passer un refus pour un compte sans restriction.
				this.log('TwoFactor.Status : corps vide — Steam n\'a renvoyé aucun état');
				return null;
			}
			const Res = Schema.CTwoFactor_Status_Response;
			// Sans `defaults` : un champ absent reste absent, il ne devient pas false.
			const st = Res.toObject(Res.decode(bytes), { longs: String });
			this.log(`TwoFactor.Status : ${summarizeStatus(st)}`);
			return st;
		} catch (err) {
			this.log(`TwoFactor.Status indisponible : ${err.message}`);
			return null;
		}
	}

	/**
	 * État du téléphone rattaché au compte.
	 *
	 * steam-user n'embarque aucun protobuf `Phone`, donc impossible de passer par
	 * _sendUnified. On interroge l'API web, dont le jeton d'accès est contenu dans
	 * le cookie `steamLoginSecure` négocié par webLogOn() : sa valeur est
	 * `<steamid>||<access_token>`.
	 *
	 * Sert à transformer « cause la plus fréquente : pas de téléphone » — une
	 * supposition — en constat vérifié.
	 *
	 * @returns {Promise<{verified: boolean, awaitingEmail: boolean}|null>}
	 *   null si l'information n'a pas pu être obtenue.
	 */
	/**
	 * Jeton d'accès web de la session en cours.
	 *
	 * webLogOn() négocie un cookie `steamLoginSecure` dont la valeur est
	 * `<steamid>||<access_token>`. Chaque abandon est journalisé : un `return null`
	 * muet a déjà fait disparaître tout un diagnostic d'un journal réel.
	 */
	async _webAccessToken() {
		if (this._webToken) return this._webToken;
		this.client.webLogOn();
		const cookies = await Promise.race([
			new Promise((resolve) => this.client.once('webSession', (_sid, c) => resolve(c))),
			new Promise((_, rej) => setTimeout(() => rej(new Error('timeout webSession')), 20000))
		]);
		const cookie = cookies.find((c) => c.startsWith('steamLoginSecure='));
		if (!cookie) {
			this.log(`Session web : pas de cookie steamLoginSecure (${cookies.length} cookie(s) reçu(s))`);
			return null;
		}
		const token = decodeURIComponent(cookie.split('=')[1]).split('||')[1];
		if (!token) {
			this.log('Session web : cookie steamLoginSecure sans jeton après « || »');
			return null;
		}
		this._webToken = token;
		return token;
	}

	/**
	 * Appel d'une méthode ITwoFactorService par l'API web.
	 *
	 * Constat de terrain : le CM accepte les LECTURES de ce service (QueryStatus
	 * répond eresult 1 OK) mais refuse les ÉCRITURES — AddAuthenticator et
	 * FinalizeAddAuthenticator renvoient eresult 2 Fail alors que toutes les
	 * préconditions sont remplies. Les mêmes requêtes en HTTP passent. C'est donc
	 * le canal qui est en cause, pas le compte.
	 *
	 * @returns {Promise<object|null>} le contenu de `response`, ou null si
	 *   l'API n'a pas pu être jointe (jeton absent, HTTP en erreur).
	 */
	async _twoFactorWebCall(method, fields) {
		const token = await this._webAccessToken();
		if (!token) return null;
		const form = new URLSearchParams(fields);
		this.log(`→ API web ITwoFactorService/${method} : ${form.toString()}`);
		const url = `https://api.steampowered.com/ITwoFactorService/${method}/v1/`
			+ `?access_token=${encodeURIComponent(token)}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString()
		});
		if (!res.ok) {
			this.log(`← API web ${method} : HTTP ${res.status}`);
			return null;
		}
		const body = await res.json();
		const r = (body && body.response) || {};
		this.log(`← API web ${method} : ${summarizeBody(r)}`);
		return r;
	}

	/**
	 * AddAuthenticator par l'API web, en second recours.
	 *
	 * Le CM refuse l'écriture (eresult 2 Fail) alors que toutes les préconditions
	 * exposées par Steam sont remplies : authenticator_allowed, email_validated,
	 * verified_phone et can_add_two_factor_phone sont tous vrais, et state vaut 0.
	 * On teste donc la variable restante, le transport : même méthode, même compte,
	 * mais en HTTP. Si Steam accepte ici, le canal était en cause ; s'il refuse
	 * pareil, le canal est hors de cause et il reste le type de session.
	 */
	async _addViaWebApi() {
		return this._twoFactorWebCall('AddAuthenticator', {
			steamid: this.client.steamID.getSteamID64(),
			authenticator_type: '1',
			device_identifier: SteamTotp.getDeviceID(this.client.steamID),
			sms_phone_id: '1',
			version: '2'
		});
	}

	async phoneStatus() {
		try {
			const token = await this._webAccessToken();
			if (!token) return null;

			// Cet endpoint n'accepte que POST : en GET, Steam répond 405 Method Not
			// Allowed et le diagnostic ne tourne jamais. Le jeton reste dans la query
			// (c'est là que Steam l'attend), le corps est un formulaire vide.
			const url = `https://api.steampowered.com/IPhoneService/AccountPhoneStatus/v1/?access_token=${encodeURIComponent(token)}`;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: ''
			});
			if (!res.ok) {
				this.log(`AccountPhoneStatus : l'API répond HTTP ${res.status}`);
				return null;
			}
			const body = await res.json();
			// Réponse journalisée brute : les noms de champs de cette API ne sont
			// documentés nulle part, et lire `verified` sans l'avoir vérifié revient
			// à affirmer « pas de téléphone » dès que le champ s'appelle autrement.
			this.log(`AccountPhoneStatus (brut) : ${JSON.stringify(body)}`);
			const r = (body && body.response) || {};
			// Noms relevés sur une réponse réelle :
			//   {"response":{"verified_phone":true,"can_add_two_factor_phone":false}}
			// `verified` (que je lisais avant) n'existe pas — d'où un faux « aucun
			// numéro » permanent. On garde `verified` en repli au cas où l'API varie.
			const state = {
				verified: !!(r.verified_phone !== undefined ? r.verified_phone : r.verified),
				// Absent ≠ false : si Steam ne se prononce pas, on ne tranche pas à sa place.
				canAddTwoFactor: r.can_add_two_factor_phone,
				awaitingEmail: !!r.is_awaiting_email_confirmation
			};
			this.log(`AccountPhoneStatus : verified_phone=${state.verified}`
				+ ` · can_add_two_factor_phone=${state.canAddTwoFactor === undefined ? 'absent' : state.canAddTwoFactor}`);
			return state;
		} catch (err) {
			this.log(`État du téléphone indisponible : ${err.message}`);
			return null;
		}
	}

	/**
	 * Capture l'en-tête brut de la réponse à une méthode unifiée.
	 *
	 * steam-user décode cet en-tête et le passe à son callback de job, mais ses
	 * méthodes publiques (dont enableTwoFactor) ne transmettent que le corps. On
	 * écoute donc le trafic entrant et on relit l'en-tête soi-même, SANS l'option
	 * `defaults` : c'est le seul moyen de savoir si `eresult` était réellement sur
	 * le fil, puisque le champ porte `[default = 2]` dans le .proto.
	 */
	_watchRawResponse(methodName) {
		let captured = null;
		const onTraffic = (buffer) => {
			try {
				const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
				if (raw.length < 8) return;
				const rawEMsg = raw.readUInt32LE(0);
				if (!(rawEMsg & PROTO_MASK)) return; // en-tête non protobuf : pas une réponse de service
				const headerLength = raw.readUInt32LE(4);
				if (headerLength <= 0 || 8 + headerLength > raw.length) return;
				const decoded = Schema.CMsgProtoBufHeader.decode(raw.slice(8, 8 + headerLength));
				const header = Schema.CMsgProtoBufHeader.toObject(decoded, { longs: String });
				if (header.target_job_name !== methodName) return;
				captured = {
					msg: rawEMsg & 0x7fffffff,
					eresult: header.eresult,
					eresultPresent: Object.prototype.hasOwnProperty.call(header, 'eresult'),
					errorMessage: header.error_message || null
				};
			} catch (err) {
				/* trame inattendue : un diagnostic ne doit jamais casser le flux */
			}
		};
		this.client.on('debug-traffic-incoming', onTraffic);
		return {
			header: () => captured,
			stop: () => this.client.removeListener('debug-traffic-incoming', onTraffic)
		};
	}

	/**
	 * Envoie AddAuthenticator et renvoie corps + en-tête, sans interprétation.
	 *
	 * On ne passe pas par client.enableTwoFactor() : cette méthode jette l'en-tête
	 * de la réponse, donc elle perd le verdict du service quand Steam refuse avant
	 * d'exécuter la méthode (corps vide, `status` absent — d'où un message
	 * générique). La requête ci-dessous reprend champ pour champ celle de la lib
	 * (node_modules/steam-user/components/twofactor.js:14-21), afin que ce qui est
	 * journalisé soit exactement ce qui part sur le fil.
	 */
	async _addRaw() {
		if (!this.client || !this.client.steamID) {
			// Sans SteamID la session est tombée : _send jetterait le message en
			// silence et on attendrait 20 s pour rien.
			throw new Error('Session Steam perdue avant la demande d\'authenticator — relance le flux');
		}
		const request = {
			steamid: this.client.steamID.getSteamID64(),
			authenticator_type: 1,
			device_identifier: SteamTotp.getDeviceID(this.client.steamID),
			sms_phone_id: '1',
			version: 2
		};
		this.log(`→ ${ADD_METHOD} : ${JSON.stringify(request)}`);
		const watch = this._watchRawResponse(ADD_METHOD);
		try {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					// _send abandonne silencieusement si la session est tombée : sans ce
					// garde-fou l'interface resterait sur « Demande en cours… » sans fin.
					reject(new Error(`Steam n'a pas répondu en 20 s à ${ADD_METHOD} (message perdu ou session tombée ?)`));
				}, 20000);
				try {
					this.client._sendUnified(ADD_METHOD, request, (body, header) => {
						clearTimeout(timer);
						resolve({ body: body || {}, header: header || null, raw: watch.header() });
					});
				} catch (err) {
					clearTimeout(timer);
					reject(err);
				}
			});
		} finally {
			watch.stop();
		}
	}

	/**
	 * AddAuthenticator : Steam génère les secrets et envoie un SMS de confirmation.
	 * Renvoie les secrets ; l'appelant DOIT les enregistrer avant d'aller plus loin.
	 *
	 * Le succès se juge sur la PRÉSENCE des secrets, jamais sur un code : c'est le
	 * seul critère qui ne peut pas se tromper (`eresult` absent se décode en 2, et
	 * `status` absent se décode en 0). Les codes servent à expliquer un échec, pas
	 * à le décider.
	 */
	async add() {
		let { body, raw } = await this._addRaw();
		this.log(`← ${ADD_METHOD} : ${describeRawHeader(raw)}`);
		this.log(`   corps : ${summarizeBody(body)}`);

		const status = body.status == null ? null : Number(body.status);
		const headerEresult = raw && raw.eresultPresent ? raw.eresult : null;

		// Le CM n'a rien donné : on retente par l'API web avant de conclure.
		let webStatus = null;
		if (!(body.shared_secret && body.revocation_code)) {
			let web = null;
			try {
				web = await this._addViaWebApi();
			} catch (err) {
				this.log(`API web indisponible : ${err.message}`);
			}
			if (web) {
				webStatus = web.status == null ? null : Number(web.status);
				if (web.shared_secret && web.revocation_code) {
					this.log('L\'API web a accepté là où le CM refusait.');
					body = web;
				}
			}
		}

		if (body.shared_secret && body.revocation_code) {
			// bytes côté Steam, déjà en base64 côté tests : on accepte les deux.
			const b64 = (v) => (!v ? '' : Buffer.isBuffer(v) ? v.toString('base64') : String(v));
			this.pending = {
				sharedSecret: b64(body.shared_secret),
				identitySecret: b64(body.identity_secret),
				revocationCode: body.revocation_code,
				serialNumber: body.serial_number ? String(body.serial_number) : '',
				tokenGid: body.token_gid || '',
				uri: body.uri || '',
				accountName: body.account_name || this.account.username,
				phoneHint: body.phone_number_hint || null
			};
			this.log(`Secrets reçus. SMS envoyé${this.pending.phoneHint ? ` au numéro se terminant par ${this.pending.phoneHint}` : ''}`);
			return this.pending;
		}

		// ── échec : on rapporte les codes tels que Steam les a donnés ──
		const codes = [];
		if (status != null) codes.push(`status ${eres(status)}`);
		if (headerEresult != null) codes.push(`eresult d'en-tête ${eres(headerEresult)}`);
		if (raw && raw.errorMessage) codes.push(`« ${raw.errorMessage} »`);
		if (webStatus != null) codes.push(`API web ${eres(webStatus)}`);
		const trace = codes.length ? ` [${codes.join(' · ')}]` : ' [Steam n\'a renvoyé aucun code]';

		// `err.status` porte le code effectivement reçu, d'où qu'il vienne : main.js
		// s'en sert pour reconnaître DuplicateRequest (authenticator déjà posé).
		const code = status != null ? status : headerEresult;
		const fallback = 'Steam a répondu sans secret ni code de révocation';
		const err = new Error(((code == null ? null : describeAddStatus(code)) || fallback) + trace);
		err.status = code;
		err.rawStatus = status;
		err.headerEresult = headerEresult;
		err.trace = trace;

		if (code === EResult.Fail || code === EResult.InvalidParam) {
			// Steam refuse sans dire pourquoi : on interroge les deux sources qui
			// savent, en commençant par celle qui tranche.
			const st = await this.twoFactorStatus();
			if (st && st.authenticator_allowed === false) {
				err.message = 'Steam n\'autorise pas d\'authenticator sur ce compte '
					+ '(authenticator_allowed=false) — restriction posée par Steam, pas un problème '
					+ 'de téléphone.' + trace;
				err.twoFactor = st;
				throw err;
			}
			if (st && st.state != null && st.state !== TOKEN_STATE_NONE) {
				err.message = `Un authenticator est encore enregistré côté Steam (state=${st.state}`
					+ `${st.inactivation_reason != null ? `, inactivation_reason=${st.inactivation_reason}` : ''}`
					+ ') — le retrait n\'a pas abouti complètement.' + trace;
				err.twoFactor = st;
				throw err;
			}
			if (st && st.email_validated === false) {
				err.message = 'L\'adresse e-mail du compte n\'est pas vérifiée (email_validated=false). '
					+ 'Steam exige une adresse validée avant de poser un authenticator.' + trace;
				err.twoFactor = st;
				throw err;
			}
			err.twoFactor = st;
			const phone = await this.phoneStatus();
			if (phone && phone.canAddTwoFactor === false) {
				// Steam dit explicitement que CE numéro ne peut pas porter de 2FA.
				// Le champ donne la décision, pas le motif : on ne l'invente pas.
				err.message = 'Le numéro de téléphone est bien vérifié, mais Steam refuse qu\'il porte '
					+ 'un authenticator (can_add_two_factor_phone=false). Les deux causes connues : '
					+ "le numéro sert déjà d'authenticator à trop de comptes, ou il a été vérifié "
					+ 'trop récemment.' + trace;
				err.phone = phone;
				throw err;
			}
			if (phone && !phone.verified) {
				err.message = (phone.awaitingEmail
					? 'Un numéro a été ajouté mais attend encore la confirmation par e-mail. '
						+ 'Valide le lien reçu, puis réessaie.'
					: 'Aucun numéro de téléphone vérifié sur ce compte — Steam exige un numéro '
						+ 'pour créer un authenticator.') + trace;
				err.phone = phone;
			} else if (phone && phone.verified) {
				// Toutes les préconditions que Steam expose sont satisfaites et il
				// refuse quand même : on le dit, plutôt que de proposer des motifs
				// inventés. La piste restante est le type de session (steam-user se
				// connecte en SteamClient ; l'appli mobile officielle, elle, obtient
				// un jeton MobileApp).
				err.message = 'Toutes les conditions vérifiables sont pourtant remplies '
					+ '(authenticator autorisé, e-mail validé, numéro vérifié et utilisable pour la 2FA), '
					+ `et Steam refuse quand même (EResult ${code}). Steam ne dit pas pourquoi.` + trace;
				err.phone = phone;
			}
		}
		throw err;
	}

	/** FinalizeAddAuthenticator : valide avec le code SMS. */
	/**
	 * Secrets à finaliser : ceux de la session, sinon ceux déjà enregistrés.
	 *
	 * AddAuthenticator sauvegarde dans le coffre avant la finalisation. Si celle-ci
	 * échoue et que la modale se ferme, l'authenticator reste « en attente » côté
	 * Steam : il faut pouvoir reprendre avec le secret conservé, sans redemander
	 * un AddAuthenticator que Steam refuserait (DuplicateRequest).
	 */
	_pendingSecrets() {
		if (this.pending) return this.pending;
		if (this.account.authenticatorPending && this.account.sharedSecret) {
			this.log('Reprise d\'un authenticator en attente, avec le secret du coffre.');
			return {
				sharedSecret: this.account.sharedSecret,
				identitySecret: this.account.identitySecret || '',
				revocationCode: this.account.revocationCode || '',
				accountName: this.account.username,
				phoneHint: null
			};
		}
		return null;
	}

	/**
	 * FinalizeAddAuthenticator : valide avec le code SMS.
	 *
	 * Deux subtilités portées par le protocole :
	 * - `want_more` : Steam peut réclamer le code TOTP de la période suivante pour
	 *   caler l'horloge. On rejoue en avançant de 30 s, comme le fait l'appli.
	 * - `status 89` : le code d'activation (SMS) est faux — message dédié, sinon
	 *   l'utilisateur croit que c'est son authenticator qui ne marche pas.
	 */
	async finalize(smsCode) {
		const pending = this._pendingSecrets();
		if (!pending) {
			throw new Error('Aucun authenticator en attente de finalisation');
		}
		const activation = String(smsCode).trim();
		this.log('Finalisation…');

		const offset = await new Promise((resolve) => {
			SteamTotp.getTimeOffset((err, off) => resolve(err ? 0 : off));
		});

		let drift = offset;
		for (let attempt = 1; attempt <= 30; attempt++) {
			const body = await this._twoFactorWebCall('FinalizeAddAuthenticator', {
				steamid: this.client.steamID.getSteamID64(),
				authenticator_code: SteamTotp.generateAuthCode(pending.sharedSecret, drift),
				authenticator_time: String(Math.floor(Date.now() / 1000) + drift),
				activation_code: activation,
				validate_sms_code: '1'
			});
			if (!body) {
				throw new Error('API web injoignable pour la finalisation');
			}
			const status = body.status == null ? null : Number(body.status);
			if (status === 89) {
				throw new Error('Code SMS refusé par Steam (status 89) — vérifie le code reçu.');
			}
			if (body.want_more) {
				// Steam veut le code de la période suivante : on avance d'un cran.
				drift += 30;
				this.log(`Steam demande le code suivant (tentative ${attempt + 1}, décalage ${drift} s)`);
				continue;
			}
			if (!body.success) {
				throw new Error(`Finalisation refusée par Steam${status == null ? '' : ` (status ${eres(status)})`}`);
			}
			this.log('Authenticator actif');
			this.pending = pending;
			return pending;
		}
		throw new Error('Finalisation abandonnée après 30 tentatives de synchronisation');
	}

	/**
	 * RemoveAuthenticator. Attention : Steam repasse le compte en Steam Guard
	 * e-mail, ce qui déclenche 15 jours de restriction sur les échanges et le
	 * marché. Le code de révocation est consommé même en cas d'échec (le nombre
	 * de tentatives restantes est limité).
	 */
	async remove(revocationCode) {
		const code = String(revocationCode || '').trim().toUpperCase();
		if (!code) throw new Error('Code de révocation requis');
		this.log('Retrait de l\'authenticator…');
		// Même service, même refus côté CM : on passe par l'API web, et on ne garde
		// le CM que si le jeton web manque.
		let body = await this._twoFactorWebCall('RemoveAuthenticator', {
			steamid: this.client.steamID.getSteamID64(),
			revocation_code: code,
			revocation_reason: '1',
			steamguard_scheme: '1', // retour au Steam Guard e-mail
			remove_all_steamguard_cookies: 'false'
		});
		if (!body) {
			this.log('API web indisponible : tentative par le CM.');
			body = await this._unified('TwoFactor.RemoveAuthenticator#1', {
				revocation_code: code,
				revocation_reason: 1,
				steamguard_scheme: 1,
				remove_all_steamguard_cookies: false
			});
		}
		const attemptsLeft = body.revocation_attempts_remaining == null
			? null : Number(body.revocation_attempts_remaining);
		if (!body.success) {
			const suffix = attemptsLeft == null ? '' : ` — ${attemptsLeft} tentative(s) restante(s)`;
			throw new Error(`Code de révocation refusé par Steam${suffix}`);
		}
		this.log('Authenticator retiré');
		return { attemptsLeft };
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = null;
		this.guardCallback = null;
		this._webToken = null;
		if (!this.client) return;
		try { this.client.logOff(); } catch (err) { /* déjà parti */ }
		try { this.client.removeAllListeners(); } catch (err) { /* idem */ }
		this.client = null;
	}
}

module.exports = { AuthenticatorSession, describeAddStatus, TOKEN_STATE_NONE };
