'use strict';
/**
 * Processus principal Electron : il détient le coffre, le moteur de scan et le
 * lanceur. Le renderer n'a jamais accès ni au système de fichiers ni aux secrets :
 * il passe par les canaux IPC déclarés ici, et les mots de passe / shared_secret
 * ne quittent le processus principal que sur demande explicite (accounts:reveal).
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const SteamTotp = require('steam-totp');

const { Vault } = require('./vault');
const { Scanner } = require('./scanner');
const sda = require('./sda');
const launcher = require('./launcher');
const autofill = require('./autofill');
const { AuthenticatorSession } = require('./authenticator');
const { ConfirmationSession } = require('./confirmations');
const { decodeJwtExpiry } = require('./scanner');
const { categorize, CATEGORIES, SKILL_GROUPS, PENALTY_REASONS, TRANSIENT_ERROR_KINDS,
	MAX_PLAUSIBLE_PENALTY_SECONDS } = require('./cs2data');

let win = null;
let vault = null;
let scanner = null;
let authSession = null; // création d'authenticator en cours, le cas échéant
let confSession = null; // session de confirmations mobiles en cours

// EResult renvoyé par AddAuthenticator quand le compte en a déjà un.
const DUPLICATE_REQUEST = 29;

function userFile(name) {
	return path.join(app.getPath('userData'), name);
}

function send(channel, payload) {
	if (win && !win.isDestroyed()) {
		win.webContents.send(channel, payload);
	}
}

/**
 * Vue d'un compte transmise au renderer : jamais les secrets, seulement de quoi
 * savoir s'ils sont présents.
 */
function publicAccount(account) {
	return {
		id: account.id,
		username: account.username,
		label: account.label || '',
		note: account.note || '',
		steamId: account.steamId || (account.cache && account.cache.steamId) || '',
		hasPassword: !!account.password,
		hasSharedSecret: !!account.sharedSecret,
		hasRevocationCode: !!account.revocationCode,
		// Sans identity_secret, pas de confirmations mobiles possibles.
		hasIdentitySecret: !!account.identitySecret,
		// Steam a confirmé qu'aucun authenticator mobile n'est attaché : le secret
		// enregistré est périmé ou étranger au compte.
		secretRejected: !!account.secretRejected,
		// Authenticator ajouté mais jamais finalisé : le compte est dans un état
		// bancal qu'il faut signaler (secrets reçus, Steam Guard pas encore actif).
		authenticatorPending: !!account.authenticatorPending,
		hasRefreshToken: !!account.refreshToken,
		refreshTokenExpiresAt: account.refreshTokenExpiresAt || 0,
		lastScanAt: account.lastScanAt || 0,
		lastScanOk: account.lastScanOk,
		lastError: account.lastError || null,
		category: categorize(account),
		cache: account.cache || null
	};
}

function requireUnlocked() {
	if (!vault || vault.locked) {
		throw new Error('Coffre verrouillé');
	}
}

/** Enveloppe chaque handler pour renvoyer {ok, data} | {ok:false, error} au lieu de jeter. */
function handle(channel, fn) {
	ipcMain.handle(channel, async (_event, ...args) => {
		try {
			return { ok: true, data: await fn(...args) };
		} catch (err) {
			// `kind` accompagne le message : le renderer doit pouvoir reconnaître
			// certains échecs sans lire la prose, qui est traduisible.
			return { ok: false, error: err.message || String(err), kind: err.kind || null };
		}
	});
}

function createScanner() {
	scanner = new Scanner({ dataDirectory: userFile('steam-data'), vault });
	scanner.on('progress', (p) => send('scan:progress', p));
	scanner.on('queue', (s) => send('scan:queue', s));
	scanner.on('rateLimit', (r) => send('scan:ratelimit', r));
	scanner.on('log', (l) => send('scan:log', l));
	scanner.on('idle', () => send('scan:idle', {}));
	scanner.on('result', (r) => {
		const account = vault.find(r.accountId);
		send('scan:result', { ...r, account: account ? publicAccount(account) : null });
	});
}

function registerIpc() {
	// ---- coffre ----
	handle('vault:status', () => ({
		exists: vault.exists(),
		locked: vault.locked,
		path: vault.file,
		categories: CATEGORIES,
		// Table des groupes de skill : le renderer en a besoin pour nommer les rangs
		// non-Premier (Wingman, compétitif par carte), dont le GC ne renvoie qu'un entier.
		skillGroups: SKILL_GROUPS,
		// Les libellés de sanction sont recalculés à l'affichage à partir du code
		// brut : la table s'enrichit avec le temps, et un cache déjà enregistré ne
		// doit pas rester figé sur « Raison inconnue ».
		penaltyReasons: PENALTY_REASONS,
		maxPenaltySeconds: MAX_PLAUSIBLE_PENALTY_SECONDS,
		// Types d'échec qui ne disent rien sur le compte : l'interface les présente
		// comme un report, pas comme une panne.
		transientErrorKinds: [...TRANSIENT_ERROR_KINDS]
	}));

	handle('vault:create', (password) => {
		if (!password || password.length < 8) {
			throw new Error('Le mot de passe maître doit faire au moins 8 caractères');
		}
		vault.create(password);
		createScanner();
		return { locked: false };
	});

	handle('vault:unlock', (password) => {
		vault.unlock(password);
		createScanner();
		return { locked: false };
	});

	handle('vault:lock', () => {
		if (scanner) scanner.stop();
		// Les sessions Steam ouvertes doivent partir avec le coffre : elles
		// détiennent des cookies web et un client connecté.
		if (authSession) { authSession.dispose(); authSession = null; }
		if (confSession) { confSession.dispose(); confSession = null; }
		vault.lock();
		return { locked: true };
	});

	handle('vault:changePassword', ({ oldPassword, newPassword }) => {
		requireUnlocked();
		if (!newPassword || newPassword.length < 8) {
			throw new Error('Le nouveau mot de passe doit faire au moins 8 caractères');
		}
		vault.changePassword(oldPassword, newPassword);
		return true;
	});

	// ---- comptes ----
	handle('accounts:list', () => {
		requireUnlocked();
		return vault.list().map(publicAccount);
	});

	handle('accounts:upsert', (input) => {
		requireUnlocked();
		if (!input.username) throw new Error('Nom de compte Steam requis');
		return publicAccount(vault.upsert(input));
	});

	handle('accounts:patch', ({ id, patch }) => {
		requireUnlocked();
		const allowed = ['label', 'note', 'password', 'sharedSecret', 'identitySecret', 'steamId'];
		const clean = {};
		for (const key of allowed) {
			if (key in patch) clean[key] = patch[key];
		}
		// `secretRejected` est une conséquence, pas un champ que le renderer pilote :
		// changer ou effacer le shared_secret rend le verdict de Steam caduc.
		if ('sharedSecret' in clean) clean.secretRejected = false;
		const account = vault.patch(id, clean);
		if (!account) throw new Error('Compte introuvable');
		return publicAccount(account);
	});

	handle('accounts:remove', (id) => {
		requireUnlocked();
		if (scanner) scanner.dequeue(id);
		return vault.remove(id);
	});

	// Les secrets ne sortent qu'ici, sur action délibérée de l'utilisateur.
	handle('accounts:reveal', ({ id, field }) => {
		requireUnlocked();
		const account = vault.find(id);
		if (!account) throw new Error('Compte introuvable');
		if (!['password', 'sharedSecret', 'identitySecret', 'revocationCode'].includes(field)) {
			throw new Error('Champ non autorisé');
		}
		return account[field] || '';
	});

	handle('accounts:forgetToken', (id) => {
		requireUnlocked();
		vault.patch(id, { refreshToken: null, refreshTokenExpiresAt: 0 });
		return true;
	});

	// ---- code Steam Guard ----
	handle('totp:code', (id) => {
		requireUnlocked();
		const account = vault.find(id);
		if (!account) throw new Error('Compte introuvable');
		if (!account.sharedSecret) throw new Error('shared_secret absent pour ce compte');
		const offset = scanner ? scanner.timeOffset : 0;
		const code = SteamTotp.generateAuthCode(account.sharedSecret, offset);
		const seconds = Math.floor(Date.now() / 1000) + offset;
		return { code, secondsLeft: 30 - (seconds % 30) };
	});

	handle('clipboard:write', (text) => {
		clipboard.writeText(String(text));
		return true;
	});

	// ---- import SDA ----
	handle('dialog:pickFolder', async (title) => {
		const res = await dialog.showOpenDialog(win, {
			title: title || 'Choisir le dossier maFiles',
			properties: ['openDirectory']
		});
		return res.canceled ? null : res.filePaths[0];
	});

	handle('sda:inspect', (dir) => sda.inspectDirectory(dir));

	handle('sda:import', ({ dir, password }) => {
		requireUnlocked();
		const { accounts, failures } = sda.importDirectory(dir, password || null);
		const imported = accounts.map((a) =>
			publicAccount(
				vault.upsert({
					username: a.username,
					sharedSecret: a.sharedSecret,
					identitySecret: a.identitySecret,
					revocationCode: a.revocationCode,
					steamId: a.steamId
				})
			)
		);
		return { imported, failures };
	});

	// Reprise des anciens fichiers de test : accounts.json / steam_accounts.json.
	handle('import:json', (file) => {
		requireUnlocked();
		// parseJson : un steamid écrit comme nombre nu perdrait sa précision avec JSON.parse
		const raw = sda.parseJson(fs.readFileSync(file, 'utf8'));
		const list = Array.isArray(raw) ? raw : raw.accounts || [];
		const imported = [];
		for (const entry of list) {
			const username = entry.username || entry.account_name;
			if (!username) continue;
			imported.push(
				publicAccount(
					vault.upsert({
						username,
						password: entry.password || '',
						sharedSecret: entry.shared_secret || entry.sharedSecret || '',
						identitySecret: entry.identity_secret || entry.identitySecret || '',
						steamId: String(entry.steamid || entry.steamId || '')
					})
				)
			);
		}
		return { imported };
	});

	/**
	 * Efface un fichier d'import contenant des secrets en clair. On écrase le
	 * contenu avant de supprimer, pour que l'entrée restée dans la corbeille ou un
	 * secteur non réalloué ne soit pas directement lisible. Sur SSD (wear
	 * levelling, TRIM), ça ne garantit rien de plus : la vraie protection est que
	 * le fichier cesse d'exister et que le coffre chiffré le remplace.
	 */
	handle('import:shred', (file) => {
		requireUnlocked();
		if (!fs.existsSync(file)) throw new Error('Fichier introuvable');
		const size = fs.statSync(file).size;
		fs.writeFileSync(file, require('crypto').randomBytes(Math.max(size, 1)));
		fs.unlinkSync(file);
		return { shredded: file };
	});

	// ---- sauvegarde du coffre ----
	// Le coffre est l'unique dépositaire des codes de révocation : le perdre
	// signifie perdre définitivement la main sur les authenticators créés ici.
	handle('vault:backup', async () => {
		const stamp = new Date().toISOString().slice(0, 10);
		const res = await dialog.showSaveDialog(win, {
			title: 'Sauvegarder le coffre chiffré',
			defaultPath: `cs2-vault-${stamp}.json`,
			filters: [{ name: 'Coffre chiffré', extensions: ['json'] }]
		});
		if (res.canceled || !res.filePath) return { canceled: true };
		// Pas de requireUnlocked : on recopie des octets chiffrés, la clé maître
		// n'intervient pas. Exiger le déverrouillage empêcherait justement de
		// sauvegarder avant de tenter de retrouver son mot de passe.
		const info = vault.backupTo(res.filePath);
		return { canceled: false, path: res.filePath, ...info };
	});

	handle('vault:pickBackup', async () => {
		const res = await dialog.showOpenDialog(win, {
			title: 'Choisir la sauvegarde à restaurer',
			filters: [{ name: 'Coffre chiffré', extensions: ['json'] }],
			properties: ['openFile']
		});
		return res.canceled ? null : res.filePaths[0];
	});

	handle('vault:restore', ({ file, password }) => {
		if (!file) throw new Error('Fichier de sauvegarde requis');
		const info = vault.restoreFrom(file, password);
		createScanner();
		return info;
	});

	handle('dialog:pickJson', async () => {
		const res = await dialog.showOpenDialog(win, {
			title: 'Importer un accounts.json',
			filters: [{ name: 'JSON', extensions: ['json'] }],
			properties: ['openFile']
		});
		return res.canceled ? null : res.filePaths[0];
	});

	// ---- scan ----
	handle('scan:start', ({ ids, forceCredentials }) => {
		requireUnlocked();
		const targets = ids && ids.length ? ids : vault.list().map((a) => a.id);
		return scanner.enqueue(targets, { forceCredentials: !!forceCredentials });
	});

	handle('scan:stop', () => {
		if (scanner) scanner.stop();
		return true;
	});

	handle('scan:status', () => (scanner ? scanner.status() : { queued: [], current: null }));

	// ---- lancement ----
	handle('launch:account', async ({ id, mode }) => {
		requireUnlocked();
		const account = vault.find(id);
		if (!account) throw new Error('Compte introuvable');
		const result = await launcher.launch(account, {
			mode: mode || vault.settings.launchMode,
			steamPath: vault.settings.steamPath,
			timeOffset: scanner ? scanner.timeOffset : 0
		});
		if (result.code) {
			clipboard.writeText(result.code);
		}

		// Seul le chemin 'password' fait apparaître l'écran Steam Guard : en
		// 'autologin', Steam se connecte avec sa session mémorisée et ne demande
		// rien. Taper un code là n'aurait aucune cible.
		if (result.code && result.mode === 'password' && vault.settings.guardAutofill) {
			const typed = await autofill.typeGuardCode(result.code);
			result.autofill = typed;
			result.notes.push(typed.sent
				? `Code Steam Guard ${typed.reason}.`
				: `Code Steam Guard non saisi (${typed.reason}) — il est dans le presse-papier.`);
		}
		return result;
	});

	handle('launch:probe', async () => {
		const steamExe = await launcher.findSteam(vault.locked ? null : vault.settings.steamPath);
		return { steamExe, remembered: Object.values(launcher.readRememberedUsers(steamExe)).map((u) => u.AccountName) };
	});

	// ---- réglages ----
	handle('settings:get', () => {
		requireUnlocked();
		return vault.settings;
	});

	handle('settings:set', (patch) => {
		requireUnlocked();
		return vault.updateSettings(patch);
	});

	handle('shell:openExternal', (url) => {
		if (!/^https:\/\//.test(url)) throw new Error('URL non autorisée');
		return shell.openExternal(url);
	});

	// ---- authenticator Steam (remplace SDA) ----
	// Une seule session à la fois : le déroulé est interactif et garde une
	// connexion Steam ouverte entre les étapes.
	const requireAuthSession = () => {
		if (!authSession) throw new Error('Aucune création d\'authenticator en cours');
		return authSession;
	};

	handle('auth2fa:begin', async (accountId) => {
		requireUnlocked();
		const account = vault.find(accountId);
		if (!account) throw new Error('Compte introuvable');
		if (authSession) authSession.dispose();
		authSession = new AuthenticatorSession(account, {
			onLog: (message) => send('auth2fa:progress', { accountId, message })
		});
		authSession.accountId = accountId;
		try {
			return await authSession.login();
		} catch (err) {
			authSession.dispose();
			authSession = null;
			throw err;
		}
	});

	handle('auth2fa:guardCode', async (code) => {
		const session = requireAuthSession();
		return session.submitGuardCode(code);
	});

	handle('auth2fa:add', async () => {
		requireUnlocked();
		const session = requireAuthSession();
		let pending;
		try {
			pending = await session.add();
		} catch (err) {
			// Steam répond DuplicateRequest quand un authenticator est déjà en place.
			// Ce n'est pas une panne : l'interface doit proposer le retrait, pas une
			// erreur rouge. On le remonte donc comme un état, pas comme un échec.
			if (err.status === DUPLICATE_REQUEST) return { duplicate: true, message: err.message };
			throw err;
		}
		// Enregistrement AVANT la finalisation : le code de révocation ne sera
		// jamais redonné par Steam, et un plantage ici laisserait le compte avec
		// un authenticator en attente dont on aurait perdu la clé.
		vault.patch(session.accountId, {
			sharedSecret: pending.sharedSecret,
			identitySecret: pending.identitySecret,
			revocationCode: pending.revocationCode,
			authenticatorPending: true
		});
		return {
			revocationCode: pending.revocationCode,
			phoneHint: pending.phoneHint,
			accountName: pending.accountName,
			saved: true
		};
	});

	handle('auth2fa:finalize', async (smsCode) => {
		requireUnlocked();
		const session = requireAuthSession();
		await session.finalize(smsCode);
		// Ajouter un authenticator invalide les sessions existantes : on jette le
		// refresh token pour que le prochain scan reparte proprement avec le TOTP.
		vault.patch(session.accountId, {
			authenticatorPending: false,
			refreshToken: null,
			refreshTokenExpiresAt: 0
		});
		const account = vault.find(session.accountId);
		session.dispose();
		authSession = null;
		return { account: account ? publicAccount(account) : null };
	});

	handle('auth2fa:remove', async (revocationCode) => {
		requireUnlocked();
		const session = requireAuthSession();
		const result = await session.remove(revocationCode);
		vault.patch(session.accountId, {
			sharedSecret: '', identitySecret: '', revocationCode: '',
			authenticatorPending: false, refreshToken: null, refreshTokenExpiresAt: 0
		});
		return result;
	});

	// ---- confirmations mobiles (échanges, marché) ----
	// Une seule session à la fois : elle garde une connexion Steam + des cookies
	// web ouverts entre la liste et la réponse.
	handle('conf:open', async (accountId) => {
		requireUnlocked();
		const account = vault.find(accountId);
		if (!account) throw new Error('Compte introuvable');
		if (confSession) confSession.dispose();
		confSession = new ConfirmationSession(account, {
			timeOffset: scanner ? scanner.timeOffset : 0,
			onLog: (message) => send('conf:progress', { accountId, message })
		});
		confSession.accountId = accountId;
		try {
			const opened = await confSession.open();
			// webLogOn consomme le refresh token et Steam peut en renvoyer un neuf.
			if (opened.refreshToken) {
				vault.patch(accountId, {
					refreshToken: opened.refreshToken,
					refreshTokenExpiresAt: decodeJwtExpiry(opened.refreshToken)
				});
			}
			return { steamId: opened.steamId, confirmations: await confSession.list() };
		} catch (err) {
			confSession.dispose();
			confSession = null;
			throw err;
		}
	});

	handle('conf:list', async () => {
		if (!confSession) throw new Error('Aucune session de confirmation ouverte');
		return confSession.list();
	});

	handle('conf:respond', async ({ items, accept }) => {
		if (!confSession) throw new Error('Aucune session de confirmation ouverte');
		const result = await confSession.respond(items, !!accept);
		return { ...result, confirmations: await confSession.list() };
	});

	handle('conf:close', () => {
		if (confSession) confSession.dispose();
		confSession = null;
		return true;
	});

	// ---- export au format SDA ----
	handle('dialog:pickExportFolder', async () => {
		const res = await dialog.showOpenDialog(win, {
			title: 'Choisir le dossier où écrire les .maFile',
			properties: ['openDirectory', 'createDirectory']
		});
		return res.canceled ? null : res.filePaths[0];
	});

	handle('sda:export', ({ dir, password }) => {
		requireUnlocked();
		if (!dir) throw new Error('Dossier de destination requis');
		return sda.exportDirectory(dir, vault.list(), password || null);
	});

	handle('auth2fa:cancel', () => {
		if (authSession) authSession.dispose();
		authSession = null;
		return true;
	});
}

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 940,
		minHeight: 600,
		backgroundColor: '#12151c',
		title: 'CS2 Account Manager',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
	win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
	vault = new Vault(userFile('vault.json'));
	registerIpc();
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (scanner) scanner.stop();
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
	if (scanner) scanner.stop();
});
