'use strict';
/**
 * Vérifie un dossier maFiles sans lancer l'interface.
 *
 *   node tools/check-mafile.js "C:\chemin\vers\maFiles"
 *
 * Déchiffre les .maFile, liste les comptes trouvés et génère le code Steam Guard
 * courant pour chacun : si le code correspond à celui de ton téléphone / de SDA,
 * le shared_secret est bon et l'horloge est alignée.
 *
 * Aucun secret n'est affiché, seulement le code à 5 caractères (qui expire en 30 s).
 */
const SteamTotp = require('steam-totp');
const sda = require('../src/main/sda');
const { ask } = require('./prompt');

async function main() {
	const dir = process.argv[2];
	if (!dir) {
		console.error('Usage : node tools/check-mafile.js "<dossier maFiles>"');
		process.exit(1);
	}

	let info;
	try {
		info = sda.inspectDirectory(dir);
	} catch (err) {
		console.error('Dossier illisible :', err.message);
		process.exit(1);
	}
	console.log(`${info.count} entrée(s), ${info.encrypted ? 'chiffrées' : 'en clair'}`);

	const password = info.encrypted ? await ask('Mot de passe SDA : ', { hidden: true }) : null;

	let result;
	try {
		result = sda.importDirectory(dir, password);
	} catch (err) {
		console.error('Échec :', err.message);
		process.exit(1);
	}

	// L'horloge locale décalée est la première cause de code refusé par Steam.
	const offset = await new Promise((resolve) => {
		SteamTotp.getTimeOffset((err, off) => resolve(err ? 0 : off));
	});
	console.log(`Décalage d'horloge Steam : ${offset} s\n`);

	for (const account of result.accounts) {
		const code = SteamTotp.generateAuthCode(account.sharedSecret, offset);
		console.log(
			`  ${account.username.padEnd(20)} ${(account.steamId || '—').padEnd(18)} code ${code}` +
			`${account.identitySecret ? '' : '   (pas d\'identity_secret)'}`
		);
	}

	for (const failure of result.failures) {
		console.log(`  ÉCHEC ${failure.file} : ${failure.error}`);
	}

	const left = 30 - (Math.floor(Date.now() / 1000) + offset) % 30;
	console.log(`\nCes codes expirent dans ${left} s.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
