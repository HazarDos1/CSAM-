'use strict';
/**
 * Lecture des fichiers Steam Desktop Authenticator (.maFile + manifest.json).
 *
 * Format SDA chiffré : PBKDF2-HMAC-SHA1, 50 000 itérations, clé de 32 octets,
 * AES-256-CBC, padding PKCS#7. Le sel et l'IV sont en base64 dans manifest.json,
 * un par entrée ; le .maFile lui-même est le ciphertext en base64.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SDA_ITERATIONS = 50000;

/**
 * JSON.parse qui préserve les SteamID64. SDA écrit `"SteamID": 76561198123456789`
 * comme un nombre nu ; au-dessus de 2^53 JavaScript l'arrondit silencieusement
 * (…241 devient …240). On met ces littéraux entre guillemets avant de parser.
 */
function parseJson(text) {
	return JSON.parse(String(text).replace(/("(?:SteamID|steamid|steam_id)"\s*:\s*)(\d{15,})/gi, '$1"$2"'));
}

function deriveSdaKey(password, saltB64) {
	return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), SDA_ITERATIONS, 32, 'sha1');
}

function decryptMaFile(password, entry, cipherTextB64) {
	if (!entry.encryption_salt || !entry.encryption_iv) {
		throw new Error(`Entrée ${entry.filename} marquée chiffrée mais sans sel/IV dans le manifest`);
	}
	const key = deriveSdaKey(password, entry.encryption_salt);
	const iv = Buffer.from(entry.encryption_iv, 'base64');
	const input = Buffer.from(cipherTextB64, 'base64');

	// Chemin normal : Node valide le padding PKCS#7, ce qui détecte un mauvais mot de passe.
	try {
		const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
		return Buffer.concat([d.update(input), d.final()]).toString('utf8');
	} catch (err) {
		// Certaines versions/forks de SDA écrivent un padding que Node refuse. On retente
		// sans validation et on tranche à la main ; si le JSON ne parse pas, c'est bien
		// que le mot de passe est faux.
		const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
		d.setAutoPadding(false);
		const raw = Buffer.concat([d.update(input), d.final()]);
		const pad = raw[raw.length - 1];
		const sliced = pad > 0 && pad <= 16 ? raw.subarray(0, raw.length - pad) : raw;
		const text = sliced.toString('utf8');
		parseJson(text); // lève si mauvais mot de passe
		return text;
	}
}

function normalizeMaFile(data, entry) {
	const steamId =
		String((data.Session && data.Session.SteamID) || (entry && entry.steamid) || '') ||
		String((data.session && data.session.steamid) || '');
	return {
		username: data.account_name,
		sharedSecret: data.shared_secret,
		identitySecret: data.identity_secret || '',
		revocationCode: data.revocation_code || '',
		steamId: steamId && steamId !== '0' ? steamId : ''
	};
}

/** Le manifest dit-il que les .maFile sont chiffrés ? */
function inspectDirectory(dir) {
	const manifestPath = path.join(dir, 'manifest.json');
	if (fs.existsSync(manifestPath)) {
		const manifest = parseJson(fs.readFileSync(manifestPath, 'utf8'));
		const entries = (manifest.entries || []).filter((e) => e.filename);
		return {
			kind: 'manifest',
			encrypted: !!manifest.encrypted,
			count: entries.length,
			usernames: null // inconnus tant que c'est chiffré
		};
	}
	const loose = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mafile'));
	if (loose.length === 0) {
		throw new Error('Aucun manifest.json ni .maFile trouvé dans ce dossier');
	}
	return { kind: 'loose', encrypted: false, count: loose.length, usernames: null };
}

/**
 * @param {string} dir dossier maFiles
 * @param {string|null} password mot de passe SDA (null si non chiffré)
 * @returns {{accounts: Array, failures: Array}}
 */
function importDirectory(dir, password) {
	const manifestPath = path.join(dir, 'manifest.json');
	const accounts = [];
	const failures = [];

	if (fs.existsSync(manifestPath)) {
		const manifest = parseJson(fs.readFileSync(manifestPath, 'utf8'));
		const encrypted = !!manifest.encrypted;
		if (encrypted && !password) {
			throw new Error('Ces .maFile sont chiffrés : mot de passe SDA requis');
		}
		for (const entry of manifest.entries || []) {
			if (!entry.filename) continue;
			const file = path.join(dir, entry.filename);
			try {
				let text = fs.readFileSync(file, 'utf8').trim();
				if (encrypted) {
					text = decryptMaFile(password, entry, text);
				}
				const parsed = normalizeMaFile(parseJson(text), entry);
				if (!parsed.username || !parsed.sharedSecret) {
					throw new Error('account_name ou shared_secret manquant');
				}
				accounts.push(parsed);
			} catch (err) {
				failures.push({ file: entry.filename, error: err.message });
			}
		}
		if (accounts.length === 0 && failures.length > 0) {
			// Tout a échoué sur un dossier chiffré => presque toujours le mot de passe.
			throw new Error(
				encrypted
					? 'Déchiffrement impossible : mot de passe SDA incorrect ?'
					: `Lecture impossible : ${failures[0].error}`
			);
		}
		return { accounts, failures };
	}

	for (const name of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mafile'))) {
		try {
			const parsed = normalizeMaFile(parseJson(fs.readFileSync(path.join(dir, name), 'utf8')), null);
			if (!parsed.username || !parsed.sharedSecret) {
				throw new Error('account_name ou shared_secret manquant');
			}
			accounts.push(parsed);
		} catch (err) {
			failures.push({ file: name, error: err.message });
		}
	}
	if (accounts.length === 0) {
		throw new Error('Aucun .maFile lisible (chiffrés ? il faut alors un manifest.json)');
	}
	return { accounts, failures };
}

/** Chiffre un .maFile au format SDA : PBKDF2-SHA1 50k, AES-256-CBC, PKCS#7. */
function encryptMaFile(password, saltB64, ivB64, plaintext) {
	const key = deriveSdaKey(password, saltB64);
	const iv = Buffer.from(ivB64, 'base64');
	const c = crypto.createCipheriv('aes-256-cbc', key, iv);
	return Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]).toString('base64');
}

/**
 * Écrit un dossier `maFiles` relisible par Steam Desktop Authenticator, pour
 * que les secrets ne soient pas prisonniers de cette app.
 *
 * @param {string} dir dossier de destination
 * @param {Array} accounts comptes du coffre (avec leurs secrets en clair)
 * @param {string|null} password mot de passe SDA ; null = écrit en clair
 */
function exportDirectory(dir, accounts, password) {
	fs.mkdirSync(dir, { recursive: true });
	const entries = [];
	const written = [];
	const skipped = [];

	for (const a of accounts) {
		if (!a.sharedSecret) {
			skipped.push({ username: a.username, reason: 'aucun shared_secret' });
			continue;
		}
		const steamId = String(a.steamId || '');
		if (!steamId) {
			skipped.push({ username: a.username, reason: 'SteamID inconnu — scanne le compte une fois' });
			continue;
		}
		const maFile = {
			shared_secret: a.sharedSecret,
			serial_number: a.serialNumber || '',
			revocation_code: a.revocationCode || '',
			uri: '',
			server_time: Math.floor(Date.now() / 1000),
			account_name: a.username,
			token_gid: a.tokenGid || '',
			identity_secret: a.identitySecret || '',
			secret_1: '',
			status: 1,
			device_id: a.deviceId || '',
			fully_enrolled: true,
			// SDA lit le SteamID ici ; il doit rester un NOMBRE pour qu'il le relise.
			Session: { SteamID: Number(steamId) }
		};
		// On sérialise le SteamID sans passer par Number() pour ne pas perdre les
		// unités au-delà de 2^53 : on remplace le marqueur après coup.
		let text = JSON.stringify({ ...maFile, Session: { SteamID: 0 } }, null, 2)
			.replace('"SteamID": 0', `"SteamID": ${steamId}`);

		const filename = `${steamId}.maFile`;
		const entry = { filename, steamid: steamId };
		if (password) {
			entry.encryption_salt = crypto.randomBytes(8).toString('base64');
			entry.encryption_iv = crypto.randomBytes(16).toString('base64');
			text = encryptMaFile(password, entry.encryption_salt, entry.encryption_iv, text);
		}
		fs.writeFileSync(path.join(dir, filename), text, { mode: 0o600 });
		entries.push(entry);
		written.push(a.username);
	}

	const manifest = {
		encrypted: !!password,
		first_run: false,
		entries,
		periodic_checking: false,
		periodic_checking_interval: 5,
		periodic_checking_checkall: false,
		auto_confirm_market_transactions: false,
		auto_confirm_trades: false
	};
	// Même précaution : les steamid du manifest doivent rester des nombres exacts.
	let manifestText = JSON.stringify(manifest, null, 2);
	for (const e of entries) {
		manifestText = manifestText.replace(`"steamid": "${e.steamid}"`, `"steamid": ${e.steamid}`);
	}
	fs.writeFileSync(path.join(dir, 'manifest.json'), manifestText, { mode: 0o600 });
	return { written, skipped, encrypted: !!password, dir };
}

module.exports = {
	inspectDirectory, importDirectory, exportDirectory,
	decryptMaFile, encryptMaFile, deriveSdaKey, parseJson
};
