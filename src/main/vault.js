'use strict';
/**
 * Coffre chiffré : comptes, mots de passe, shared_secret, refresh tokens, cache de scan.
 * Tout tient dans un seul fichier vault.json ; rien n'est écrit en clair sur le disque.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KDF_DEFAULTS, newSalt, deriveKey, encryptJson, decryptJson, kdfIsOutdated } = require('./crypto');

const DEFAULT_SETTINGS = {
	// Délai minimum entre deux logins. Les logins par mot de passe tapent
	// BeginAuthSessionViaCredentials, qui est agressivement rate-limité (EResult 84) ;
	// les logins par refresh token ne le touchent pas, donc ils peuvent aller plus vite.
	credentialDelayMs: 25000,
	tokenDelayMs: 6000,
	loginTimeoutMs: 45000,
	gcTimeoutMs: 45000,
	offlinePersona: true, // se connecter en invisible pendant le scan
	fetchRecentGames: true,
	launchMode: 'auto', // 'auto' | 'autologin' | 'password'
	// Taper le code Steam Guard dans la fenêtre Steam au premier login d'un
	// compte. Ne concerne que ce cas : ensuite Steam mémorise la session et ne
	// demande plus rien. Le code reste copié dans le presse-papier dans tous les cas.
	guardAutofill: true,
	steamPath: null,
	// Durée après laquelle un scan en cache est considéré comme périmé (affichage uniquement)
	staleAfterMs: 6 * 60 * 60 * 1000,
	// Version de client annoncée au Game Coordinator dans ClientHello.
	// null = automatique : steam.inf local, sinon version apprise du GC lui-même.
	gcClientVersion: null
};

function emptyPayload() {
	return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
}

function atomicWrite(file, contents) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, contents, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * Vérifie qu'un objet a bien la forme d'un coffre chiffré.
 *
 * Sert à deux choses : refuser de restaurer un fichier qui n'en est pas un, et
 * garantir qu'une sauvegarde contient bien le blob chiffré (et pas, par
 * exemple, un coffre vidé par une écriture ratée).
 */
function assertVaultShape(raw) {
	if (!raw || typeof raw !== 'object') throw new Error('Fichier illisible : ce n\'est pas du JSON');
	if (!raw.kdf || !raw.kdf.salt) throw new Error('Ce fichier n\'est pas un coffre (paramètres de dérivation absents)');
	if (!raw.blob || !raw.blob.data) throw new Error('Ce fichier n\'est pas un coffre (données chiffrées absentes)');
	if (raw.blob.cipher && raw.blob.cipher !== 'aes-256-gcm') {
		throw new Error(`Algorithme inattendu : ${raw.blob.cipher}`);
	}
	return raw;
}

class Vault {
	constructor(file) {
		this.file = file;
		this.key = null;
		this.header = null;
		this.payload = null;
	}

	exists() {
		return fs.existsSync(this.file);
	}

	get locked() {
		return this.key === null;
	}

	/** Crée un nouveau coffre vide protégé par `password`. */
	create(password) {
		if (this.exists()) {
			throw new Error('Un coffre existe déjà');
		}
		const salt = newSalt();
		this.header = {
			version: 1,
			kdf: { ...KDF_DEFAULTS, salt: salt.toString('base64') }
		};
		this.key = deriveKey(password, salt, this.header.kdf);
		this.payload = emptyPayload();
		this.save();
	}

	/** Ouvre un coffre existant. Lève une erreur si le mot de passe est faux. */
	unlock(password) {
		const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		const key = deriveKey(password, raw.kdf.salt, raw.kdf);
		let payload;
		try {
			payload = decryptJson(raw.blob, key);
		} catch (err) {
			throw new Error('Mot de passe maître incorrect');
		}
		this.header = { version: raw.version, kdf: raw.kdf };
		this.key = key;
		this.payload = {
			accounts: payload.accounts || [],
			settings: { ...DEFAULT_SETTINGS, ...(payload.settings || {}) }
		};

		// Remontée de niveau d'un coffre créé avec des paramètres plus faibles.
		// C'est le seul moment où on détient le mot de passe en clair, donc le seul
		// où on peut re-dériver : on en profite, avec un sel neuf.
		if (kdfIsOutdated(raw.kdf)) {
			const salt = newSalt();
			this.header.kdf = { ...KDF_DEFAULTS, salt: salt.toString('base64') };
			this.key = deriveKey(password, salt, this.header.kdf);
			this.save();
			this.kdfUpgraded = { from: raw.kdf.N, to: KDF_DEFAULTS.N };
		}
	}

	lock() {
		if (this.key) {
			this.key.fill(0);
		}
		this.key = null;
		this.payload = null;
	}

	/**
	 * Copie du coffre vers un fichier, octet pour octet.
	 *
	 * Rien n'est déchiffré : on recopie le fichier tel quel. La clé maître n'est
	 * pas sollicitée, le mot de passe n'est pas demandé, et aucun secret ne
	 * transite en clair — le fichier reste un blob AES-256-GCM dont la clé se
	 * dérive par scrypt. Une sauvegarde exposée n'est donc pas plus lisible que
	 * le coffre d'origine.
	 *
	 * Possible coffre verrouillé : refuser serait du théâtre, le fichier étant
	 * de toute façon lisible depuis l'explorateur.
	 *
	 * @returns {{bytes: number, sha256: string}} empreinte vérifiée après écriture
	 */
	/**
	 * Restaure un coffre depuis une sauvegarde.
	 *
	 * Le mot de passe est exigé et vérifié AVANT tout remplacement : restaurer une
	 * sauvegarde dont on a perdu le mot de passe écraserait un coffre qui marche
	 * par un fichier inutilisable. Et le coffre actuel est mis de côté, pas
	 * supprimé — une restauration est réversible.
	 *
	 * @returns {{accounts: number, previous: string|null}}
	 */
	restoreFrom(source, password) {
		if (!password) throw new Error('Mot de passe de la sauvegarde requis');
		const raw = assertVaultShape(JSON.parse(fs.readFileSync(source, 'utf8')));

		// Épreuve de déchiffrement : si elle échoue, on n'a rien touché.
		const salt = Buffer.from(raw.kdf.salt, 'base64');
		const key = deriveKey(password, salt, raw.kdf);
		let payload;
		try {
			payload = decryptJson(raw.blob, key);
		} catch (err) {
			// Node dit « Unsupported state or unable to authenticate data » quand le
			// tag GCM ne colle pas. C'est le cas banal du mauvais mot de passe, pas
			// une corruption : laisser passer ce message ferait douter d'un fichier
			// parfaitement sain. Même formulation que unlock().
			throw new Error('Mot de passe maître incorrect pour cette sauvegarde');
		}

		let previous = null;
		if (this.exists()) {
			previous = `${this.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
			fs.copyFileSync(this.file, previous);
		}
		atomicWrite(this.file, fs.readFileSync(source));

		this.header = { version: raw.version || 1, kdf: raw.kdf };
		this.key = key;
		this.payload = payload;
		return { accounts: (payload.accounts || []).length, previous };
	}

	backupTo(destination) {
		if (!this.exists()) throw new Error('Aucun coffre à sauvegarder');
		const source = fs.readFileSync(this.file);
		// On relit ce qu'on vient d'écrire : une sauvegarde silencieusement
		// tronquée serait pire que pas de sauvegarde du tout.
		atomicWrite(destination, source);
		const written = fs.readFileSync(destination);
		const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
		const sha256 = digest(written);
		if (sha256 !== digest(source)) {
			throw new Error('La copie ne correspond pas à la source — sauvegarde abandonnée');
		}
		assertVaultShape(JSON.parse(written.toString('utf8')));
		return { bytes: written.length, sha256 };
	}

	save() {
		if (this.locked) {
			throw new Error('Coffre verrouillé');
		}
		const out = {
			version: this.header.version,
			kdf: this.header.kdf,
			blob: encryptJson(this.payload, this.key)
		};
		atomicWrite(this.file, JSON.stringify(out, null, 2));
	}

	changePassword(oldPassword, newPassword) {
		// Vérifie l'ancien en re-dérivant plutôt qu'en comparant la clé en mémoire,
		// comme ça on refuse si le coffre a été déverrouillé puis le fichier remplacé.
		const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		const probe = deriveKey(oldPassword, raw.kdf.salt, raw.kdf);
		try {
			decryptJson(raw.blob, probe);
		} catch (err) {
			throw new Error('Ancien mot de passe incorrect');
		}
		const salt = newSalt();
		this.header.kdf = { ...KDF_DEFAULTS, salt: salt.toString('base64') };
		this.key = deriveKey(newPassword, salt, this.header.kdf);
		this.save();
	}

	// ---- comptes ----

	get settings() {
		return this.payload.settings;
	}

	updateSettings(patch) {
		Object.assign(this.payload.settings, patch);
		this.save();
		return this.payload.settings;
	}

	list() {
		return this.payload.accounts;
	}

	find(id) {
		return this.payload.accounts.find((a) => a.id === id) || null;
	}

	findByUsername(username) {
		const needle = String(username).toLowerCase();
		return this.payload.accounts.find((a) => a.username.toLowerCase() === needle) || null;
	}

	/**
	 * Ajoute ou fusionne un compte. La fusion se fait sur le nom de compte Steam :
	 * importer deux fois les mêmes .maFile ne duplique rien et n'écrase pas un mot
	 * de passe déjà saisi avec une chaîne vide.
	 */
	upsert(input) {
		const existing = input.id ? this.find(input.id) : this.findByUsername(input.username);
		if (existing) {
			for (const [k, v] of Object.entries(input)) {
				if (k === 'id') continue;
				// La correspondance se fait sans tenir compte de la casse : réimporter
				// "COMPTE" ne doit pas réécrire le login enregistré "compte".
				if (k === 'username') continue;
				if (v === undefined || v === null || v === '') continue;
				existing[k] = v;
			}
			this.save();
			return existing;
		}
		const account = {
			id: crypto.randomUUID(),
			username: input.username,
			password: input.password || '',
			sharedSecret: input.sharedSecret || '',
			identitySecret: input.identitySecret || '',
			steamId: input.steamId || '',
			label: input.label || '',
			note: input.note || '',
			revocationCode: input.revocationCode || '',
			// Authenticator obtenu de Steam mais pas encore validé par code SMS.
			authenticatorPending: false,
			refreshToken: null,
			refreshTokenExpiresAt: 0,
			lastScanAt: 0,
			lastScanOk: null,
			lastError: null,
			cache: null
		};
		this.payload.accounts.push(account);
		this.save();
		return account;
	}

	remove(id) {
		const before = this.payload.accounts.length;
		this.payload.accounts = this.payload.accounts.filter((a) => a.id !== id);
		this.save();
		return this.payload.accounts.length !== before;
	}

	patch(id, patch) {
		const account = this.find(id);
		if (!account) return null;
		Object.assign(account, patch);
		this.save();
		return account;
	}
}

module.exports = { Vault, DEFAULT_SETTINGS };
