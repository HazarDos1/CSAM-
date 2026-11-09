'use strict';
/**
 * Lancement d'un compte dans le client Steam (Windows).
 *
 * Deux modes, parce qu'aucun des deux n'est bon dans tous les cas :
 *
 * - 'autologin' : on écrit AutoLoginUser dans le registre et on pose
 *   AutoLogin=1 sur le compte dans loginusers.vdf, puis on redémarre Steam.
 *   Steam se connecte alors seul, **sans mot de passe et sans code Steam Guard**
 *   — le jeton de session qu'il a mémorisé fait office de second facteur.
 *   Propre (aucun secret ne transite), mais réservé aux comptes déjà connus de
 *   Steam sur cette machine.
 *
 * - 'password' : `steam.exe -login <user> <pass>`. Marche toujours, mais le mot
 *   de passe passe par la ligne de commande, donc il est visible dans la liste
 *   des processus le temps du lancement. À réserver au premier login d'un compte.
 *   Steam demandera le code Steam Guard : il est copié dans le presse-papier, et
 *   peut être saisi automatiquement si le réglage est activé (voir autofill.js).
 *
 * Le mode 'auto' tente l'autologin, puis **vérifie** que Steam s'est connecté
 * en lisant `ActiveUser` dans le registre. S'il est resté sur l'écran de
 * connexion, il reprend tout seul avec le mot de passe.
 *
 * Cette vérification n'est pas du zèle : `RememberPassword=1` dans
 * loginusers.vdf n'indique que l'intention de mémoriser la session, jamais
 * qu'un jeton utilisable existe encore. Les deux divergent dès que le jeton
 * expire, et sans ce contrôle l'utilisateur se retrouvait devant l'écran de
 * connexion avec un code dans le presse-papier et aucune explication.
 *
 * Après un login par mot de passe, Steam mémorise la session, et les lancements
 * suivants se font en 'autologin' : plus rien à taper.
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const SteamTotp = require('steam-totp');

const DEFAULT_STEAM_PATHS = [
	'C:\\Program Files (x86)\\Steam\\steam.exe',
	'C:\\Program Files\\Steam\\steam.exe'
];

function run(file, args, opts = {}) {
	return new Promise((resolve) => {
		execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
			resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
		});
	});
}

async function regQuery(key, value) {
	const { err, stdout } = await run('reg', ['query', key, '/v', value]);
	if (err) return null;
	const match = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`, 'i'));
	return match ? match[1].trim() : null;
}

async function regSetString(key, value, data) {
	const { err, stderr } = await run('reg', ['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f']);
	if (err) throw new Error(`Écriture registre échouée (${value}) : ${stderr.trim() || err.message}`);
}

async function regSetDword(key, value, data) {
	const { err, stderr } = await run('reg', ['add', key, '/v', value, '/t', 'REG_DWORD', '/d', String(data), '/f']);
	if (err) throw new Error(`Écriture registre échouée (${value}) : ${stderr.trim() || err.message}`);
}

/** Localise steam.exe : registre d'abord, chemins par défaut ensuite. */
async function findSteam(configuredPath) {
	if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

	const candidates = [];
	const hkcu = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamExe');
	if (hkcu) candidates.push(hkcu.replace(/\//g, '\\'));
	const hkcuDir = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
	if (hkcuDir) candidates.push(path.join(hkcuDir.replace(/\//g, '\\'), 'steam.exe'));
	const hklm = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath');
	if (hklm) candidates.push(path.join(hklm, 'steam.exe'));
	candidates.push(...DEFAULT_STEAM_PATHS);

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	throw new Error("Impossible de localiser steam.exe — renseigne le chemin dans les réglages");
}

// --- VDF minimal (suffisant pour loginusers.vdf, qui n'a que des objets et des chaînes) ---

function parseVdf(text) {
	const root = {};
	const stack = [root];
	const lines = text.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('//')) continue;
		if (line === '{') continue;
		if (line === '}') {
			if (stack.length > 1) stack.pop();
			continue;
		}
		const pair = line.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/);
		if (pair) {
			stack[stack.length - 1][pair[1]] = pair[2];
			continue;
		}
		const keyOnly = line.match(/^"((?:[^"\\]|\\.)*)"$/);
		if (keyOnly) {
			const child = {};
			stack[stack.length - 1][keyOnly[1]] = child;
			stack.push(child);
		}
	}
	return root;
}

function stringifyVdf(obj, depth = 0) {
	const pad = '\t'.repeat(depth);
	let out = '';
	for (const [key, value] of Object.entries(obj)) {
		if (value && typeof value === 'object') {
			out += `${pad}"${key}"\n${pad}{\n${stringifyVdf(value, depth + 1)}${pad}}\n`;
		} else {
			out += `${pad}"${key}"\t\t"${value}"\n`;
		}
	}
	return out;
}

function loginUsersPath(steamExe) {
	return path.join(path.dirname(steamExe), 'config', 'loginusers.vdf');
}

/** Le compte a-t-il une session mémorisée par Steam ? */
function readRememberedUsers(steamExe) {
	const file = loginUsersPath(steamExe);
	if (!fs.existsSync(file)) return {};
	try {
		const vdf = parseVdf(fs.readFileSync(file, 'utf8'));
		return vdf.users || {};
	} catch (err) {
		return {};
	}
}

function hasRememberedSession(steamExe, username) {
	const users = readRememberedUsers(steamExe);
	const needle = String(username).toLowerCase();
	return Object.values(users).some(
		(u) => String(u.AccountName || '').toLowerCase() === needle && String(u.RememberPassword) === '1'
	);
}

/**
 * Désigne le compte que Steam doit utiliser au prochain démarrage.
 *
 * Deux champs, et les confondre est précisément ce qui faisait réapparaître
 * l'écran de connexion :
 *
 * - `MostRecent` ne fait que **présélectionner** le compte dans la liste.
 * - `AutoLogin` est celui qui décide si Steam **se connecte tout seul**.
 *
 * Écrire le premier sans le second laisse Steam sur l'écran de connexion, et
 * `AutoLoginUser` dans le registre n'y change rien : un autre compte garde
 * `AutoLogin=1` et c'est le vdf qui tranche. Les deux doivent donc être posés
 * sur la cible, et retirés partout ailleurs.
 */
function selectAccount(steamExe, username) {
	const file = loginUsersPath(steamExe);
	if (!fs.existsSync(file)) return false;
	const vdf = parseVdf(fs.readFileSync(file, 'utf8'));
	if (!vdf.users) return false;
	const needle = String(username).toLowerCase();

	// On ne réécrit rien si le compte est absent : mieux vaut laisser Steam dans
	// un état cohérent que de retirer AutoLogin à tout le monde pour rien.
	const entries = Object.values(vdf.users);
	if (!entries.some((e) => String(e.AccountName || '').toLowerCase() === needle)) return false;

	for (const entry of entries) {
		const isTarget = String(entry.AccountName || '').toLowerCase() === needle;
		entry.MostRecent = isTarget ? '1' : '0';
		entry.AutoLogin = isTarget ? '1' : '0';
	}
	fs.copyFileSync(file, `${file}.bak`);
	fs.writeFileSync(file, stringifyVdf(vdf), 'utf8');
	return true;
}

/**
 * Compte actuellement connecté dans le client Steam, ou 0 si l'écran de
 * connexion est affiché.
 *
 * C'est le seul signal fiable trouvé : `RememberPassword=1` dans loginusers.vdf
 * ne dit que l'intention de mémoriser la session, pas qu'un jeton utilisable
 * existe encore. Un compte peut donc être « mémorisé » et malgré tout renvoyer
 * Steam sur l'écran de connexion — c'est exactement ce qui se passait ici.
 *
 * `ActiveUser` est un entier maintenu par Steam, indépendant de la langue de
 * l'interface (contrairement au titre de la fenêtre, « Se connecter à Steam »).
 */
async function activeUser() {
	const raw = await regQuery('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser');
	if (!raw) return 0;
	const n = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
	return Number.isFinite(n) ? n : 0;
}

/** SteamID64 -> accountid 32 bits, l'unité dans laquelle Steam écrit ActiveUser. */
function accountIdOf(steamId) {
	if (!steamId) return 0;
	try {
		const id = BigInt(String(steamId).trim()) - 76561197960265728n;
		return id > 0n && id < 4294967296n ? Number(id) : 0;
	} catch (err) {
		return 0;
	}
}

/**
 * Désactive le sélecteur de comptes de Steam (« Qui joue ? »).
 *
 * Tant que `AlwaysShowUserChooser` vaut 1, Steam impose cet écran au démarrage
 * **et réécrit `loginusers.vdf` derrière nous**, en remettant `AutoLogin=0` sur
 * le compte qu'on venait de désigner. Poser AutoLogin sans toucher à ce réglage
 * ne sert donc à rien : Steam annule le travail au lancement suivant.
 *
 * Le fichier porte aussi les jetons de session de Steam. On ne le ré-sérialise
 * surtout pas : on remplace la seule valeur visée et on réécrit les octets tels
 * quels (`latin1` fait l'aller-retour sans réinterpréter l'encodage), pour ne
 * pas risquer d'abîmer la configuration de l'utilisateur.
 *
 * @returns {{found: boolean, changed: boolean}}
 */
function setUserChooser(steamExe, show) {
	const file = path.join(path.dirname(steamExe), 'config', 'config.vdf');
	if (!fs.existsSync(file)) return { found: false, changed: false };

	const texte = fs.readFileSync(file, 'latin1');
	const ligne = /^([ \t]*"AlwaysShowUserChooser"[ \t]+")([01])(")$/m;
	const trouve = texte.match(ligne);
	// Clé absente : Steam n'affiche pas le sélecteur par défaut, rien à faire.
	if (!trouve) return { found: false, changed: false };

	const voulu = show ? '1' : '0';
	if (trouve[2] === voulu) return { found: true, changed: false };

	fs.copyFileSync(file, `${file}.bak`);
	fs.writeFileSync(file, texte.replace(ligne, `$1${voulu}$3`), 'latin1');
	return { found: true, changed: true };
}

/** Horodatage du dernier login réussi que Steam note pour ce compte. */
function loginTimestamp(steamExe, username) {
	const needle = String(username).toLowerCase();
	const entry = Object.values(readRememberedUsers(steamExe))
		.find((u) => String(u.AccountName || '').toLowerCase() === needle);
	return entry ? Number(entry.timestamp) || 0 : 0;
}

/**
 * Attend que Steam se connecte. Renvoie l'accountid obtenu, un nombre positif
 * si la connexion est constatée sans que l'accountid soit connu, ou 0 au bout
 * du délai — ce qui veut dire que Steam s'est arrêté sur l'écran de connexion.
 *
 * Deux signaux indépendants, parce que se tromper coûte cher dans les deux
 * sens : un faux négatif renverrait le mot de passe en ligne de commande à
 * chaque lancement, un faux positif laisserait l'utilisateur devant l'écran de
 * connexion sans explication.
 *
 *  - `ActiveUser` dans le registre, mis à 0 tant que personne n'est connecté.
 *  - le champ `timestamp` du compte dans loginusers.vdf, que Steam avance à
 *    chaque login réussi.
 */
async function waitForLogin(timeoutMs = 30000, opts = {}) {
	// `readUser` n'existe que pour pouvoir tester les deux signaux séparément :
	// sinon l'issue dépend de l'état réel du Steam de la machine, et le test
	// passe ou échoue selon qu'on est connecté ou non au moment où on le lance.
	const { steamExe, username, readUser = activeUser } = opts;
	const before = steamExe && username ? loginTimestamp(steamExe, username) : 0;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const user = await readUser();
		if (user !== 0) return user;
		if (before && loginTimestamp(steamExe, username) > before) return -1;
		if (Date.now() >= deadline) return 0;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

async function isSteamRunning() {
	const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']);
	return /steam\.exe/i.test(stdout);
}

/** Demande à Steam de se fermer et attend la fin du processus (sans le tuer de force). */
async function shutdownSteam(steamExe, timeoutMs = 20000) {
	if (!(await isSteamRunning())) return { wasRunning: false };
	await run(steamExe, ['-shutdown']);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 700));
		if (!(await isSteamRunning())) return { wasRunning: true, closed: true };
	}
	return { wasRunning: true, closed: false };
}

function startDetached(exe, args) {
	const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
	child.unref();
}

/**
 * @param {object} account compte du coffre
 * @param {object} opts {mode, steamPath, timeOffset}
 * @returns {Promise<{mode: string, code: string|null, steamExe: string, notes: string[]}>}
 */
async function launch(account, opts = {}) {
	const notes = [];
	const steamExe = await findSteam(opts.steamPath);
	const requested = opts.mode || 'auto';

	let mode = requested;
	if (requested === 'auto') {
		mode = hasRememberedSession(steamExe, account.username) ? 'autologin' : 'password';
		notes.push(
			mode === 'autologin'
				? 'Session mémorisée trouvée : connexion automatique.'
				: "Pas de session mémorisée : premier login via la ligne de commande."
		);
	}
	if (mode === 'password' && !account.password) {
		throw new Error('Mot de passe Steam manquant pour ce compte');
	}

	const shutdown = await shutdownSteam(steamExe);
	if (shutdown.wasRunning && !shutdown.closed) {
		throw new Error("Steam ne s'est pas fermé à temps — ferme-le manuellement puis réessaie");
	}
	if (shutdown.wasRunning) notes.push('Steam a été fermé avant le changement de compte.');

	// Le code 2FA ne peut pas être passé à steam.exe : on le met dans le presse-papier.
	const code = account.sharedSecret
		? SteamTotp.generateAuthCode(account.sharedSecret, opts.timeOffset || 0)
		: null;

	const regKey = 'HKCU\\Software\\Valve\\Steam';
	// `RememberPassword` dit à Steam de conserver la session. C'est ce qui permet
	// au lancement suivant de se passer du mot de passe ET du code Steam Guard :
	// le jeton mémorisé fait office de second facteur.
	await regSetString(regKey, 'AutoLoginUser', account.username);
	await regSetDword(regKey, 'RememberPassword', 1);

	// Le vdf a le dernier mot sur le registre : sans AutoLogin=1 ici, Steam
	// s'arrête sur l'écran de connexion même avec AutoLoginUser posé.
	const selected = selectAccount(steamExe, account.username);

	// ...et le sélecteur de comptes a le dernier mot sur le vdf : tant qu'il est
	// actif, Steam affiche « Qui joue ? » et remet AutoLogin à 0 derrière nous.
	const chooser = setUserChooser(steamExe, false);
	if (chooser.changed) {
		notes.push('Sélecteur de comptes Steam (« Qui joue ? ») désactivé : il forçait l\'écran de connexion.');
	}

	if (mode === 'autologin') {
		if (!selected) {
			notes.push("loginusers.vdf n'a pas pu être mis à jour (compte absent) — Steam peut demander le mot de passe.");
		}
		startDetached(steamExe, []);

		// On ne se contente pas d'avoir lancé Steam : on vérifie qu'il s'est
		// vraiment connecté. Sinon l'utilisateur se retrouve devant l'écran de
		// connexion avec un code dans le presse-papier et aucune explication.
		const expected = accountIdOf(account.steamId || (account.cache && account.cache.steamId));
		const logged = await waitForLogin(
			opts.loginWaitMs == null ? 30000 : opts.loginWaitMs,
			{ steamExe, username: account.username }
		);

		if (logged !== 0) {
			// -1 : connexion constatée par l'horodatage, sans accountid à comparer.
			if (expected && logged > 0 && logged !== expected) {
				notes.push(`Steam s'est connecté à un autre compte (accountid ${logged}) — vérifie le compte actif.`);
			} else {
				notes.push('Connecté automatiquement, sans mot de passe ni code Steam Guard.');
			}
			return { mode, code, steamExe, notes, loggedIn: true };
		}

		// Session mémorisée mais inutilisable : le jeton de Steam a expiré ou a
		// été révoqué. Seul le mot de passe peut encore passer.
		notes.push("Steam n'a pas pu réutiliser la session mémorisée (jeton expiré).");
		if (requested === 'autologin' || !account.password) {
			notes.push(account.password
				? 'Mode « session mémorisée » imposé : connexion à terminer à la main.'
				: 'Aucun mot de passe enregistré pour ce compte : connexion à terminer à la main.');
			return { mode, code, steamExe, notes, loggedIn: false };
		}
		notes.push('Reprise avec le mot de passe.');
		mode = 'password';
		const again = await shutdownSteam(steamExe);
		if (again.wasRunning && !again.closed) {
			throw new Error("Steam ne s'est pas fermé à temps — ferme-le manuellement puis réessaie");
		}
	}

	startDetached(steamExe, ['-login', account.username, account.password]);
	notes.push('Le mot de passe est passé en ligne de commande pour ce lancement.');
	notes.push('Une fois connecté, Steam mémorise la session : les lancements suivants se feront sans mot de passe ni code.');

	return { mode, code, steamExe, notes, loggedIn: false };
}

/**
 * Version du client CS2 installé localement (ClientVersion de steam.inf), en
 * parcourant toutes les bibliothèques Steam déclarées. Le Game Coordinator
 * ignore les messages matchmaking d'un client qui annonce une version trop
 * ancienne, et globaloffensive en annonce une codée en dur (2000244).
 * @returns {{version:number, file:string}|null}
 */
function findCs2ClientVersion(steamExe) {
	const steamDir = path.dirname(steamExe);
	const libraries = [steamDir];
	const vdfPath = path.join(steamDir, 'steamapps', 'libraryfolders.vdf');
	if (fs.existsSync(vdfPath)) {
		try {
			const vdf = parseVdf(fs.readFileSync(vdfPath, 'utf8'));
			const root = vdf.libraryfolders || vdf.LibraryFolders || {};
			for (const entry of Object.values(root)) {
				const p = entry && typeof entry === 'object' ? entry.path : null;
				if (p) libraries.push(p.replace(/\\\\/g, '\\'));
			}
		} catch (err) { /* on se rabat sur le dossier de steam.exe */ }
	}
	for (const lib of libraries) {
		const file = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'steam.inf');
		if (!fs.existsSync(file)) continue;
		const match = fs.readFileSync(file, 'utf8').match(/^ClientVersion=(\d+)/m);
		if (match) return { version: Number(match[1]), file };
	}
	return null;
}

module.exports = {
	launch, findSteam, hasRememberedSession, readRememberedUsers,
	selectAccount, parseVdf, stringifyVdf, findCs2ClientVersion,
	activeUser, accountIdOf, waitForLogin, setUserChooser
};
