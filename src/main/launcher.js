'use strict';
/**
 * Lancement d'un compte dans le client Steam (Windows).
 *
 * Deux modes, parce qu'aucun des deux n'est bon dans tous les cas :
 *
 * - 'autologin' : on écrit AutoLoginUser dans le registre et on marque le compte
 *   comme "MostRecent" dans loginusers.vdf, puis on redémarre Steam. C'est la
 *   méthode des switchers classiques. Propre (aucun secret ne transite), mais
 *   elle ne marche que si le compte a déjà une session mémorisée par Steam.
 *
 * - 'password' : `steam.exe -login <user> <pass>`. Marche toujours, mais le mot
 *   de passe passe par la ligne de commande, donc il est visible dans la liste
 *   des processus le temps du lancement. À réserver au premier login d'un compte.
 *
 * Le mode 'auto' choisit : autologin si une session mémorisée existe, sinon password.
 *
 * Dans les deux cas le code Steam Guard est copié dans le presse-papier, parce que
 * le client Steam n'accepte pas de code 2FA en ligne de commande.
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

/** Marque le compte comme le plus récent pour que Steam le présélectionne. */
function markMostRecent(steamExe, username) {
	const file = loginUsersPath(steamExe);
	if (!fs.existsSync(file)) return false;
	const vdf = parseVdf(fs.readFileSync(file, 'utf8'));
	if (!vdf.users) return false;
	const needle = String(username).toLowerCase();
	let found = false;
	for (const entry of Object.values(vdf.users)) {
		const isTarget = String(entry.AccountName || '').toLowerCase() === needle;
		entry.MostRecent = isTarget ? '1' : '0';
		if (isTarget) found = true;
	}
	if (!found) return false;
	fs.copyFileSync(file, `${file}.bak`);
	fs.writeFileSync(file, stringifyVdf(vdf), 'utf8');
	return true;
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
	if (mode === 'autologin') {
		await regSetString(regKey, 'AutoLoginUser', account.username);
		await regSetDword(regKey, 'RememberPassword', 1);
		if (!markMostRecent(steamExe, account.username)) {
			notes.push("loginusers.vdf n'a pas pu être mis à jour (compte absent) — Steam peut demander le mot de passe.");
		}
		startDetached(steamExe, []);
	} else {
		// On pose quand même AutoLoginUser : si Steam mémorise la session, le prochain
		// lancement pourra se faire en mode 'autologin' sans le mot de passe.
		await regSetString(regKey, 'AutoLoginUser', account.username);
		startDetached(steamExe, ['-login', account.username, account.password]);
		notes.push('Le mot de passe est passé en ligne de commande pour ce lancement.');
	}

	return { mode, code, steamExe, notes };
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
	markMostRecent, parseVdf, stringifyVdf, findCs2ClientVersion
};
