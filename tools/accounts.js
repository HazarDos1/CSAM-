'use strict';
/**
 * Retrouver un compte du coffre à partir de ce que l'utilisateur a sous les yeux.
 *
 * L'interface n'affiche que le pseudo Steam — « Ernesto "Fuser" Guevara » — alors
 * que le coffre est indexé par le nom de connexion, ici `internalbee9048`.
 * N'accepter que le login obligeait à faire la traduction de tête avant chaque
 * commande. On accepte donc aussi le pseudo, l'étiquette et le SteamID, en
 * correspondance partielle et insensible à la casse.
 *
 * Partagé par scan-cli.js et probe-gc.js, qui avaient la même résolution
 * dupliquée mot pour mot.
 */

/** Ce sous quoi un compte peut être désigné. */
function aliases(a) {
	return [a.username, a.label, a.cache && a.cache.personaName, a.steamId]
		.filter(Boolean).map((v) => String(v));
}

/** « login (pseudo) », pour qu'une liste d'erreur serve à quelque chose. */
function describe(a) {
	const persona = a.cache && a.cache.personaName;
	return persona && persona !== a.username ? `${a.username} (${persona})` : a.username;
}

/**
 * @param {object[]} accounts comptes du coffre
 * @param {string} wanted ce que l'utilisateur a tapé
 * @param {Console} [out] sortie, injectable pour les tests
 * @returns {object|null} le compte, ou null après avoir expliqué pourquoi
 */
function resolveAccount(accounts, wanted, out = console) {
	const q = String(wanted).trim().toLowerCase();

	// Une correspondance exacte l'emporte : un compte nommé « bee » ne doit pas
	// être noyé par un « internalbee9048 » qui le contient.
	const exact = accounts.filter((a) => aliases(a).some((v) => v.toLowerCase() === q));
	if (exact.length === 1) return exact[0];

	const partial = exact.length ? exact
		: accounts.filter((a) => aliases(a).some((v) => v.toLowerCase().includes(q)));

	if (partial.length === 1) {
		const found = partial[0];
		// On annonce la traduction : taper « ernesto » et voir défiler un scan de
		// « internalbee9048 » sans explication serait déroutant.
		if (found.username.toLowerCase() !== q) {
			out.log(`« ${wanted} » → ${describe(found)}`);
		}
		return found;
	}
	if (partial.length > 1) {
		out.error(`« ${wanted} » correspond à ${partial.length} comptes :`);
		for (const a of partial) out.error(`  ${describe(a)}`);
		out.error('Précise le nom de connexion.');
		return null;
	}
	out.error(`Compte « ${wanted} » introuvable. Disponibles :`);
	for (const a of accounts) out.error(`  ${describe(a)}`);
	return null;
}

module.exports = { aliases, describe, resolveAccount };
