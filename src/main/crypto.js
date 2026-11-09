'use strict';
/**
 * Chiffrement du coffre (vault).
 *
 * Mot de passe maître -> scrypt -> clé AES-256, puis AES-256-GCM (chiffre + authentifie,
 * donc un mauvais mot de passe échoue proprement au lieu de produire du charabia).
 *
 * Ne pas confondre avec sda.js : les .maFile de Steam Desktop Authenticator utilisent
 * PBKDF2-SHA1/AES-CBC parce que c'est ce que SDA impose. Ici on choisit, donc on prend mieux.
 */
const crypto = require('crypto');

const KDF_DEFAULTS = {
	algo: 'scrypt',
	// N = 2^17. Le coût mémoire de scrypt est 128 * N * r = 128 Mio par essai :
	// c'est ce chiffre, pas le temps CPU, qui rend une attaque par dictionnaire
	// coûteuse à paralléliser sur GPU ou ASIC. Compter ~250 ms par déverrouillage.
	N: 1 << 17,
	r: 8,
	p: 1,
	keyLen: 32,
	// Doit dépasser 128*N*r (134 217 728) plus l'allocation de travail de Node,
	// sinon scryptSync refuse avec « Invalid scrypt params ».
	maxmem: 320 * 1024 * 1024
};

/** Sel de 16 octets tiré du CSPRNG du système. Unique par coffre. */
function newSalt() {
	return crypto.randomBytes(16);
}

/**
 * Les paramètres enregistrés dans un coffre sont-ils en deçà du standard courant ?
 * Sert à remonter en silence un vieux coffre au déverrouillage, quand on a le mot
 * de passe sous la main — sans quoi un coffre créé avec d'anciens réglages
 * garderait sa KDF faible pour toujours.
 */
function kdfIsOutdated(params) {
	if (!params || params.algo !== KDF_DEFAULTS.algo) return true;
	return Number(params.N) < KDF_DEFAULTS.N
		|| Number(params.r) < KDF_DEFAULTS.r
		|| Number(params.keyLen || 32) < KDF_DEFAULTS.keyLen;
}

function deriveKey(password, salt, params = KDF_DEFAULTS) {
	if (typeof password !== 'string' || password.length === 0) {
		throw new Error('Mot de passe maître vide');
	}
	const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
	return crypto.scryptSync(Buffer.from(password, 'utf8'), saltBuf, params.keyLen || 32, {
		N: params.N,
		r: params.r,
		p: params.p,
		maxmem: params.maxmem || KDF_DEFAULTS.maxmem
	});
}

function encryptJson(obj, key) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
	return {
		cipher: 'aes-256-gcm',
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		data: data.toString('base64')
	};
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

function decryptJson(blob, key) {
	if (!blob || typeof blob !== 'object') {
		throw new Error('Blob chiffré absent');
	}
	// Le format est imposé, pas déduit du fichier : sans ces trois contrôles, un
	// fichier modifié pourrait choisir ses propres paramètres.
	if (blob.cipher && blob.cipher !== 'aes-256-gcm') {
		throw new Error(`Algorithme inattendu : ${blob.cipher}`);
	}
	const iv = Buffer.from(blob.iv || '', 'base64');
	const tag = Buffer.from(blob.tag || '', 'base64');
	if (iv.length !== IV_BYTES) {
		throw new Error('IV de taille invalide');
	}
	// Node accepte les tags GCM tronqués (4 à 16 octets). Un tag de 4 octets
	// ramènerait la résistance à la forgerie de 2^128 à 2^32 : on exige la
	// longueur pleine, sinon un fichier trafiqué choisirait lui-même sa solidité.
	if (tag.length !== TAG_BYTES) {
		throw new Error('Tag d\'authentification de taille invalide');
	}

	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
	decipher.setAuthTag(tag);
	const out = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
	return JSON.parse(out.toString('utf8'));
}

module.exports = { KDF_DEFAULTS, newSalt, deriveKey, encryptJson, decryptJson, kdfIsOutdated };
