'use strict';
/**
 * Confirmations mobiles Steam (échanges, mises en vente sur le marché, etc.) —
 * la fonction quotidienne de SDA, celle qui manquait encore ici.
 *
 * Comment ça marche côté Steam : chaque requête à /mobileconf/ est signée par une
 * clé HMAC dérivée de l'`identity_secret` du compte, de l'heure, et d'un **tag**
 * propre à l'opération (`list`, `accept`, `reject`, `detail`). Une clé calculée
 * pour un tag ne vaut pas pour un autre, d'où le recalcul systématique.
 *
 * Il faut en plus une session web steamcommunity.com (cookies), que steam-user
 * négocie à partir du refresh token via webLogOn().
 *
 * Tout passe par le processus principal : le renderer n'a pas le droit de sortir
 * sur le réseau (CSP `connect-src 'none'`) et ne voit jamais l'identity_secret.
 */
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const { redact } = require('./redact');

const BASE = 'https://steamcommunity.com/mobileconf';

/** Types renvoyés par Steam dans le champ `type`. */
const CONF_TYPES = {
	1: 'Générique',
	2: 'Échange',
	3: 'Mise en vente',
	4: 'Désinscription',
	5: 'Changement de numéro',
	6: 'Récupération de compte',
	9: 'Confirmation de connexion'
};

function confTypeLabel(type) {
	return CONF_TYPES[Number(type)] || `Type ${type}`;
}

class ConfirmationSession {
	/**
	 * @param {object} account compte du coffre (identitySecret requis)
	 * @param {{onLog?: function, timeOffset?: number}} opts
	 */
	constructor(account, opts = {}) {
		this.account = account;
		this.onLog = opts.onLog || (() => {});
		this.timeOffset = opts.timeOffset || 0;
		this.client = null;
		this.cookies = null;
		this.steamId = null;
		this.disposed = false;
	}

	log(message) {
		this.onLog(redact(message));
	}

	/** Connexion Steam puis négociation d'une session web. */
	async open() {
		if (!this.account.identitySecret) {
			throw new Error(
				"Aucun identity_secret pour ce compte : les confirmations sont impossibles. "
				+ "Il vient du .maFile ou de la création d'authenticator depuis l'app."
			);
		}
		const client = new SteamUser({
			autoRelogin: false, enablePicsCache: false, renewRefreshTokens: true, saveAppTickets: false
		});
		this.client = client;

		let fail;
		const fatal = new Promise((_, reject) => { fail = reject; });
		fatal.catch(() => {});
		client.on('error', (err) => fail(err));
		client.on('refreshToken', (token) => { this.newRefreshToken = token; });

		const usingToken = !!(this.account.refreshToken
			&& (!this.account.refreshTokenExpiresAt || this.account.refreshTokenExpiresAt > Date.now() + 3600000));
		if (usingToken) {
			this.log('Connexion via refresh token…');
			client.logOn({ refreshToken: this.account.refreshToken });
		} else {
			if (!this.account.password || !this.account.sharedSecret) {
				throw new Error('Mot de passe ou shared_secret manquant, et aucun refresh token en cache');
			}
			this.log('Connexion par mot de passe…');
			client.logOn({
				accountName: this.account.username,
				password: this.account.password,
				twoFactorCode: SteamTotp.generateAuthCode(this.account.sharedSecret, this.timeOffset)
			});
		}

		await Promise.race([
			new Promise((resolve) => client.once('loggedOn', resolve)),
			fatal,
			new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout de connexion Steam')), 45000))
		]);
		this.steamId = client.steamID.getSteamID64();
		this.log(`Connecté (${this.steamId}), ouverture de la session web…`);

		// webLogOn échange le refresh token contre des cookies steamcommunity.com.
		client.webLogOn();
		const cookies = await Promise.race([
			new Promise((resolve) => client.once('webSession', (_sid, c) => resolve(c))),
			fatal,
			new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout de session web')), 30000))
		]);
		this.cookies = cookies;
		this.log('Session web ouverte');
		return { steamId: this.steamId, refreshToken: this.newRefreshToken || null };
	}

	/**
	 * Paramètres communs à toute requête mobileconf. `tag` entre dans le calcul
	 * HMAC : une clé obtenue pour « list » est refusée pour « accept ».
	 */
	_params(tag) {
		const time = SteamTotp.time(this.timeOffset);
		return {
			p: SteamTotp.getDeviceID(this.steamId),
			a: this.steamId,
			k: SteamTotp.getConfirmationKey(this.account.identitySecret, time, tag),
			t: String(time),
			m: 'react',
			tag
		};
	}

	_headers() {
		return {
			Cookie: this.cookies.join('; '),
			// Steam sert la version mobile des confirmations à ce User-Agent ;
			// un UA de navigateur classique renvoie une page de connexion.
			'User-Agent': 'Mozilla/5.0 (Linux; U; Android 9; en-us; Valve Steam App Version/3)',
			'X-Requested-With': 'com.valvesoftware.android.steam.community'
		};
	}

	/** Liste des confirmations en attente. */
	async list() {
		const url = `${BASE}/getlist?${new URLSearchParams(this._params('list'))}`;
		const res = await fetch(url, { headers: this._headers() });
		if (!res.ok) throw new Error(`Steam a répondu ${res.status} à la liste des confirmations`);
		const body = await res.json();

		if (body.success === false) {
			// Steam renvoie un message explicite quand la signature est refusée :
			// presque toujours un identity_secret qui n'est pas celui du compte.
			throw new Error(body.message || body.detail
				|| "Steam a refusé la demande — l'identity_secret ne correspond pas à ce compte ?");
		}
		const list = (body.conf || []).map((c) => ({
			id: String(c.id),
			nonce: String(c.nonce),
			type: Number(c.type),
			typeLabel: confTypeLabel(c.type),
			creatorId: c.creator_id ? String(c.creator_id) : '',
			createdAt: c.creation_time ? Number(c.creation_time) * 1000 : 0,
			headline: c.headline || '',
			summary: Array.isArray(c.summary) ? c.summary : (c.summary ? [c.summary] : []),
			icon: c.icon || '',
			warn: c.warn || null,
			acceptLabel: c.accept || 'Confirmer',
			cancelLabel: c.cancel || 'Annuler'
		}));
		this.log(`${list.length} confirmation(s) en attente`);
		return list;
	}

	/**
	 * Accepte ou refuse. `accept=false` ANNULE définitivement l'échange ou la
	 * mise en vente côté Steam — ce n'est pas un simple « plus tard ».
	 */
	async respond(items, accept) {
		const list = Array.isArray(items) ? items : [items];
		if (!list.length) return { done: 0 };
		const tag = accept ? 'accept' : 'reject';
		const op = accept ? 'allow' : 'cancel';

		// Steam a deux points d'entrée : un pour une confirmation, un pour un lot.
		if (list.length === 1) {
			const params = new URLSearchParams({ ...this._params(tag), op, cid: list[0].id, ck: list[0].nonce });
			const res = await fetch(`${BASE}/ajaxop?${params}`, { headers: this._headers() });
			const body = await res.json().catch(() => ({}));
			if (!body.success) throw new Error(body.message || 'Steam a refusé la confirmation');
			this.log(`Confirmation ${list[0].id} ${accept ? 'acceptée' : 'refusée'}`);
			return { done: 1 };
		}

		const form = new URLSearchParams({ ...this._params(tag), op });
		for (const c of list) {
			form.append('cid[]', c.id);
			form.append('ck[]', c.nonce);
		}
		const res = await fetch(`${BASE}/multiajaxop`, {
			method: 'POST',
			headers: { ...this._headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString()
		});
		const body = await res.json().catch(() => ({}));
		if (!body.success) throw new Error(body.message || 'Steam a refusé le lot de confirmations');
		this.log(`${list.length} confirmation(s) ${accept ? 'acceptées' : 'refusées'}`);
		return { done: list.length };
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.cookies = null;
		if (!this.client) return;
		try { this.client.logOff(); } catch (err) { /* déjà parti */ }
		try { this.client.removeAllListeners(); } catch (err) { /* idem */ }
		this.client = null;
	}
}

module.exports = { ConfirmationSession, confTypeLabel, CONF_TYPES };
