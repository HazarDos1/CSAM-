'use strict';
/**
 * Sonde le Game Coordinator CS2 sur un compte donné, et journalise TOUT.
 *
 *   npm run probe:gc -- <nom_de_compte>
 *   npm run probe:gc -- --json node-cs2/accounts.json [<nom_de_compte>]
 *
 * À lancer sur un compte qui a une sanction visible en jeu (cooldown, pénalité
 * globale, ban). Le but est de trouver par quel message le GC CS2 la communique :
 * `PlayersProfile` (9128) ne la porte pas, et `MatchmakingGC2ClientHello` (9110)
 * n'arrive jamais. Si le GC la pousse spontanément — via
 * `ServerNotificationForUserPenalty` (9118) ou `MatchmakingGC2ClientAbandon`
 * (9112) — la sonde le verra et le dira.
 *
 * Utilise le refresh token du coffre quand il existe : pas de code Steam Guard
 * consommé, donc pas de risque de throttle 2FA.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const SteamTotp = require('steam-totp');
const GCLanguage = require('globaloffensive/language.js');
const GCProtos = require('globaloffensive/protobufs/generated/_load.js');
const { decodeProto } = require('globaloffensive/lib/proto-decode.js');

const { Vault } = require('../src/main/vault');
const sda = require('../src/main/sda');
const launcher = require('../src/main/launcher');
const { ask } = require('./prompt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgName = (t) => Object.keys(GCLanguage).find((k) => GCLanguage[k] === t) || String(t);

function vaultPath() {
	const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	return path.join(appData, require('../package.json').name, 'vault.json');
}

async function loadAccounts(args) {
	if (args[0] === '--json') {
		if (!args[1]) throw new Error('Usage : node tools/probe-gc.js --json <fichier.json> [<compte>]');
		const raw = sda.parseJson(fs.readFileSync(args[1], 'utf8'));
		const list = Array.isArray(raw) ? raw : raw.accounts || [];
		return {
			wanted: args[2],
			accounts: list.map((e) => ({
				username: e.username || e.account_name,
				password: e.password || '',
				sharedSecret: e.shared_secret || e.sharedSecret || '',
				refreshToken: null
			}))
		};
	}
	const file = vaultPath();
	if (!fs.existsSync(file)) throw new Error(`Aucun coffre à ${file}. Utilise --json.`);
	const vault = new Vault(file);
	vault.unlock(await ask('Mot de passe maître : ', { hidden: true }));
	return { wanted: args[0], accounts: vault.list() };
}

async function main() {
	const { wanted, accounts } = await loadAccounts(process.argv.slice(2));
	const target = wanted
		? accounts.find((a) => a.username.toLowerCase() === String(wanted).toLowerCase())
		: accounts[0];
	if (!target) {
		console.error(`Compte "${wanted}" introuvable. Disponibles : ${accounts.map((a) => a.username).join(', ')}`);
		process.exit(1);
	}

	let version = null;
	try {
		version = launcher.findCs2ClientVersion(await launcher.findSteam(null)).version;
	} catch (err) { /* CS2 pas installé : on laisse la valeur de la bibliothèque */ }
	console.log(`Compte : ${target.username}`);
	console.log(`Version CS2 annoncée : ${version || '(défaut de la bibliothèque)'}`);

	const client = new SteamUser({
		autoRelogin: false, enablePicsCache: false, renewRefreshTokens: false, saveAppTickets: false
	});
	const cs = new GlobalOffensive(client);

	if (version) {
		const origSend = cs._send.bind(cs);
		cs._send = (type, proto, body) => origSend(type, proto, type === GCLanguage.ClientHello && body ? { ...body, version } : body);
	}

	// Inventaire de ce que le GC nous envoie réellement.
	const seen = new Map();
	let penaltyFound = null;

	client.on('error', (err) => {
		console.error(`\nErreur Steam : ${err.message} (EResult ${err.eresult})`);
		process.exit(1);
	});

	client.on('receivedFromGC', (appid, type, payload) => {
		if (appid !== 730) return;
		const len = payload ? payload.length : 0;
		seen.set(type, (seen.get(type) || 0) + 1);
		console.log(`  <<< ${msgName(type)} (${type}) — ${len} o`);
		if (len && len <= 512) console.log(`      hex ${Buffer.from(payload).toString('hex')}`);

		try {
			if (type === GCLanguage.ClientWelcome) {
				const w = decodeProto(GCProtos.CMsgClientWelcome, payload);
				if (w.game_data2 && w.game_data2.length) {
					const h = decodeProto(GCProtos.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, w.game_data2);
					console.log(`      game_data2 (${w.game_data2.length} o) = MatchmakingGC2ClientHello`);
					console.log(`      *** SANCTIONS *** account_id=${h.account_id} penalty_seconds=${h.penalty_seconds} penalty_reason=${h.penalty_reason} vac_banned=${h.vac_banned}`);
					penaltyFound = { via: 'ClientWelcome.game_data2', seconds: h.penalty_seconds, reason: h.penalty_reason, vac: h.vac_banned };
				} else {
					console.log('      game_data2 absent');
				}
			}
			if (type === GCLanguage.PlayersProfile) {
				const pp = decodeProto(GCProtos.CMsgGCCStrike15_v2_PlayersProfile, payload);
				const p = (pp.account_profiles || [])[0];
				if (p) {
					const present = Object.keys(p).filter((k) => p[k] != null && !(Array.isArray(p[k]) && !p[k].length));
					console.log(`      champs présents : ${present.join(', ')}`);
					console.log(`      penalty_seconds=${p.penalty_seconds} penalty_reason=${p.penalty_reason} vac_banned=${p.vac_banned}`);
					if (p.penalty_seconds != null || p.vac_banned != null) {
						penaltyFound = { via: 'PlayersProfile (9128)', seconds: p.penalty_seconds, reason: p.penalty_reason, vac: p.vac_banned };
					}
				}
			}
			if (type === GCLanguage.MatchmakingGC2ClientHello) {
				const h = decodeProto(GCProtos.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, payload);
				console.log(`      *** 9110 REÇU *** penalty_seconds=${h.penalty_seconds} penalty_reason=${h.penalty_reason} vac_banned=${h.vac_banned}`);
				penaltyFound = { via: 'MatchmakingGC2ClientHello (9110)', seconds: h.penalty_seconds, reason: h.penalty_reason, vac: h.vac_banned };
			}
			if (type === GCLanguage.ServerNotificationForUserPenalty) {
				const n = decodeProto(GCProtos.CMsgGCCStrike15_v2_ServerNotificationForUserPenalty, payload);
				console.log(`      *** 9118 REÇU *** seconds=${n.seconds} reason=${n.reason} communication=${!!n.communication_cooldown}`);
				penaltyFound = { via: 'ServerNotificationForUserPenalty (9118)', seconds: n.seconds, reason: n.reason };
			}
			if (type === GCLanguage.MatchmakingGC2ClientAbandon) {
				const a = decodeProto(GCProtos.CMsgGCCStrike15_v2_MatchmakingGC2ClientAbandon, payload);
				console.log(`      *** 9112 REÇU *** penalty_seconds=${a.penalty_seconds} penalty_reason=${a.penalty_reason}`);
				penaltyFound = { via: 'MatchmakingGC2ClientAbandon (9112)', seconds: a.penalty_seconds, reason: a.penalty_reason };
			}
		} catch (err) {
			console.log(`      (décodage impossible : ${err.message})`);
		}
	});

	// Token d'abord : aucun code Steam Guard consommé.
	if (target.refreshToken) {
		console.log('Connexion via refresh token…');
		client.logOn({ refreshToken: target.refreshToken });
	} else {
		if (!target.password || !target.sharedSecret) {
			console.error('Mot de passe ou shared_secret manquant, et aucun refresh token en cache.');
			process.exit(1);
		}
		const offset = await new Promise((r) => SteamTotp.getTimeOffset((e, o) => r(e ? 0 : o)));
		console.log('Connexion par mot de passe…');
		client.logOn({
			accountName: target.username,
			password: target.password,
			twoFactorCode: SteamTotp.generateAuthCode(target.sharedSecret, offset)
		});
	}

	await new Promise((r) => client.once('loggedOn', r));
	console.log(`Connecté : ${client.steamID.getSteamID64()}\n`);
	client.setPersona(SteamUser.EPersonaState.Offline);
	client.gamesPlayed([730]);
	await new Promise((r) => cs.once('connectedToGC', r));
	console.log('Session GC ouverte. On écoute 10 s ce que le GC pousse spontanément…\n');
	await sleep(10000);

	const accountId = client.steamID.accountid;
	for (const level of [1, 32, 255]) {
		console.log(`\n--- ClientRequestPlayersProfile request_level=${level} ---`);
		cs._send(GCLanguage.ClientRequestPlayersProfile, GCProtos.CMsgGCCStrike15_v2_ClientRequestPlayersProfile,
			{ account_id: accountId, request_level: level });
		await sleep(3000);
	}

	for (const variant of [
		{ label: 'client_session_need=1', body: { client_session_need: 1, client_launcher: 0, steam_launcher: 0 } },
		{ label: 'client_session_need=2', body: { client_session_need: 2, client_launcher: 0, steam_launcher: 0 } }
	]) {
		console.log(`\n--- ClientHello ${variant.label} puis MatchmakingClient2GCHello ---`);
		cs._send(GCLanguage.ClientHello, GCProtos.CMsgClientHello, variant.body);
		await sleep(2500);
		cs._send(GCLanguage.MatchmakingClient2GCHello, GCProtos.CMsgGCCStrike15_v2_MatchmakingClient2GCHello, {});
		await sleep(4000);
	}

	console.log('\n================ RÉSUMÉ ================');
	console.log('Messages reçus du GC :');
	for (const [type, count] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  ${msgName(type)} (${type}) × ${count}`);
	}
	if (penaltyFound) {
		console.log(`\nSANCTION TROUVÉE via ${penaltyFound.via}`);
		console.log(`  penalty_seconds=${penaltyFound.seconds} penalty_reason=${penaltyFound.reason} vac_banned=${penaltyFound.vac}`);
		console.log('\n=> Ce message est exploitable : le scanner peut lire la sanction ici.');
	} else {
		console.log('\nAUCUNE sanction dans aucun message reçu.');
		console.log('Si le compte a bien une sanction visible en jeu, le GC CS2 ne l\'expose');
		console.log('à aucun des messages ci-dessus — copie ce résumé pour qu\'on cherche ailleurs.');
	}

	client.logOff();
	await sleep(1200);
	process.exit(0);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
