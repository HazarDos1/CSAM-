'use strict';
/**
 * Masquage des secrets dans tout ce qui peut être affiché, imprimé ou collé.
 *
 * Raison d'être concrète : steam-user émet ses traces de debug avec le corps
 * brut des réponses de steam-session, qui contient `refreshToken`, `accessToken`
 * et `weakToken` en entier. Un refresh token Steam est un identifiant porteur —
 * il ouvre le compte sans mot de passe ni 2FA jusqu'à son expiration. Relayer
 * ces lignes telles quelles dans l'interface ou dans la sortie console revient à
 * publier les identifiants.
 *
 * On masque donc à la sortie, systématiquement, plutôt que de compter sur chaque
 * appelant pour y penser.
 */

const MASK = '«masqué»';

// Clés dont la valeur est un secret, quel que soit le style d'écriture.
const SECRET_KEYS = [
	'refreshToken', 'refresh_token',
	'accessToken', 'access_token',
	'weakToken', 'weak_token',
	'machineAuthToken', 'machine_auth_token',
	'steamGuardMachineToken',
	'password', 'encrypted_password',
	'shared_secret', 'sharedSecret',
	'identity_secret', 'identitySecret',
	'revocation_code', 'revocationCode',
	'twoFactorCode', 'two_factor_code',
	'steamGuardCode', 'authenticator_code',
	'secret_1', 'uri'
];

const RULES = [
	// Jetons JWT (refresh / access / weak) : reconnaissables sans connaître la clé.
	[/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, MASK],
	// "cle": "valeur" ou cle=valeur, en JSON comme en objet JS.
	[new RegExp(`(["']?(?:${SECRET_KEYS.join('|')})["']?\\s*[:=]\\s*)(["'])[^"']*\\2`, 'gi'), `$1$2${MASK}$2`]
];

/**
 * @param {*} value texte (ou n'importe quoi, converti en texte)
 * @returns {string} le même texte, secrets remplacés par un marqueur
 */
function redact(value) {
	let text = typeof value === 'string' ? value : String(value);
	for (const [pattern, replacement] of RULES) {
		text = text.replace(pattern, replacement);
	}
	return text;
}

module.exports = { redact, MASK, SECRET_KEYS };
