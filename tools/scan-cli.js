'use strict';
/**
 * Lance un vrai scan Game Coordinator depuis le terminal, sans interface.
 *
 *   node tools/scan-cli.js <nom_de_compte>            (lit le coffre de l'app)
 *   node tools/scan-cli.js --json node-cs2/accounts.json [<nom_de_compte>]
 *
 * Utile pour deux choses :
 *  - diagnostiquer un login qui échoue, avec le message d'erreur Steam complet ;
 *  - voir les données BRUTES du GC, notamment les codes penalty_reason réels,
 *    dont les libellés dans src/main/cs2data.js ne sont qu'une interprétation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Scanner } = require('../src/main/scanner');
const { Vault, DEFAULT_SETTINGS } = require('../src/main/vault');
const sda = require('../src/main/sda');
const { ask } = require('./prompt');

// Electron range son userData sous %APPDATA%\<name de package.json>.
function vaultPath() {
	const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	return path.join(appData, require('../package.json').name, 'vault.json');
}

/** Coffre minimal en mémoire, pour scanner depuis un accounts.json en clair. */
function vaultFromJson(file) {
	const raw = sda.parseJson(fs.readFileSync(file, 'utf8'));
	const list = Array.isArray(raw) ? raw : raw.accounts || [];
	const accounts = list.map((entry, index) => ({
		id: String(index),
		username: entry.username || entry.account_name,
		password: entry.password || '',
		sharedSecret: entry.shared_secret || entry.sharedSecret || '',
		steamId: String(entry.steamid || entry.steamId || ''),
		refreshToken: null,
		refreshTokenExpiresAt: 0,
		cache: null
	}));
	const settings = { ...DEFAULT_SETTINGS };
	return {
		settings,
		list: () => accounts,
		find: (id) => accounts.find((a) => a.id === id) || null,
		patch: (id, patch) => Object.assign(accounts.find((a) => a.id === id) || {}, patch),
		updateSettings: (patch) => Object.assign(settings, patch)
	};
}

async function openVault() {
	const file = vaultPath();
	if (!fs.existsSync(file)) {
		console.error(`Aucun coffre à ${file}. Lance l'application une fois, ou utilise --json.`);
		process.exit(1);
	}
	const vault = new Vault(file);
	vault.unlock(await ask('Mot de passe maître : ', { hidden: true }));
	return vault;
}

async function main() {
	const args = process.argv.slice(2);
	let vault;
	let wanted;

	if (args[0] === '--json') {
		if (!args[1]) {
			console.error('Usage : node tools/scan-cli.js --json <fichier.json> [<nom_de_compte>]');
			process.exit(1);
		}
		vault = vaultFromJson(args[1]);
		wanted = args[2];
	} else {
		wanted = args[0];
		vault = await openVault();
	}

	const accounts = vault.list();
	if (accounts.length === 0) {
		console.error('Aucun compte.');
		process.exit(1);
	}

	const target = wanted
		? accounts.find((a) => a.username.toLowerCase() === String(wanted).toLowerCase())
		: accounts[0];
	if (!target) {
		console.error(`Compte "${wanted}" introuvable. Disponibles : ${accounts.map((a) => a.username).join(', ')}`);
		process.exit(1);
	}

	const scanner = new Scanner({
		dataDirectory: path.join(os.tmpdir(), 'cs2mgr-cli'),
		vault
	});
	scanner.on('progress', (p) => console.log(`  · ${p.message}`));
	scanner.on('log', (l) => console.log(`  · ${l.message}`));
	scanner.on('rateLimit', (r) => console.log(`  ! rate limit jusqu'à ${new Date(r.until).toLocaleTimeString('fr-FR')}`));

	console.log(`Scan de ${target.username}…`);
	await new Promise((resolve) => {
		scanner.on('result', (res) => {
			if (!res.ok) {
				console.log(`\nÉCHEC : ${res.error.message} (${res.error.kind})`);
				const last = (vault.find(res.accountId) || {}).lastError;
				if (last && last.eresult != null) console.log(`EResult Steam : ${last.eresult}`);
				if (res.error.gcLog && res.error.gcLog.length) {
					console.log('\n=== JOURNAL GAME COORDINATOR ===');
					res.error.gcLog.forEach((line) => console.log('  ' + line));
				}
				return resolve();
			}
			const data = vault.find(res.accountId).cache;
			console.log('\n=== RÉSUMÉ ===');
			console.log(`  pseudo        : ${data.personaName || '—'}`);
			console.log(`  steamid       : ${data.steamId}`);
			console.log(`  prime         : ${data.prime === null ? 'inconnu' : data.prime}`);
			console.log(`  vac           : ${data.vacBanned}`);
			console.log(`  penalty       : ${data.penaltySeconds}s · code ${data.penaltyReason} · ${data.penaltyReasonLabel}`);
			console.log(`  premier       : ${data.premierLabel || 'non classé'} (${data.premierWins} v.)`);
			console.log(`  niveau / xp   : ${data.playerLevel} / ${data.playerCurXp}`);
			console.log('\n=== DONNÉES BRUTES ===');
			console.log(JSON.stringify(data, null, 2));
			resolve();
		});
		scanner.enqueue([target.id]);
	});

	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
