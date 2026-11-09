'use strict';
/**
 * Traduction des données brutes du Game Coordinator CS2 en quelque chose d'affichable.
 *
 * Ce qui est exact et garanti par le protobuf :
 *   penalty_seconds, penalty_reason (code brut), vac_banned, player_level,
 *   player_cur_xp, rankings[].{rank_id, wins, rank_type_id}
 *
 * Ce qui est du décodage communautaire et donc "au mieux" : les LIBELLÉS des
 * penalty_reason et des rank_type_id. Valve ne publie pas ces énumérations.
 * Le code brut est donc toujours conservé et affiché à côté du libellé, et un
 * code inconnu s'affiche tel quel au lieu d'être deviné.
 */

const CS2_APPID = 730;
const PRIME_APPID = 624820; // "Counter-Strike 2 - Prime Status Upgrade"

// Libellés best-effort. Corrige/complète ici si tu observes un code différent en vrai.
const PENALTY_REASONS = {
	0: 'Aucune',
	1: 'Exclu par le vote des joueurs',
	2: 'Trop de kills alliés',
	3: 'Trop de dégâts alliés',
	4: 'Kills alliés en début de round',
	5: 'Échecs de connexion répétés',
	6: 'Partie abandonnée',
	7: 'Sanction serveur',
	10: 'Banni du matchmaking compétitif',
	11: 'Compte non fiable (Untrusted)',
	14: 'Restriction de communication',
	16: 'Trop de signalements',
	17: 'Griefing',
	// Code 22 : seul libellé de cette table qui soit une observation directe et non
	// du décodage communautaire. Relevé le 08/11/2026 sur un compte dont CS2
	// affichait « Pénalité globale 6 jours — VAC a détecté une activité suspecte
	// dans votre style de jeu », avec penalty_seconds=544203 (6 j 7 h 10 min).
	// Temporaire, donc absent de PERMANENT_PENALTY_REASONS : le décompte s'écoule.
	22: 'Pénalité globale — activité suspecte détectée par VAC'
};

// Codes considérés comme définitifs : ils ne sont pas un simple cooldown qui s'écoule.
const PERMANENT_PENALTY_REASONS = new Set([10, 11]);

/*
 * `penalty_seconds` est déclaré `optional uint32` (cstrike15_gcmessages.proto:617).
 * Un −1 posé par le GC revient donc en 4 294 967 295, soit 49 710 jours : ce
 * n'est pas une durée, c'est une sentinelle. Propager cette valeur donnait une
 * fin de cooldown en l'an 2162 et rangeait un compte sain dans « Cooldown ».
 *
 * La borne est volontairement large : le cooldown compétitif CS2 plafonne à
 * 7 jours, 30 laissent de la marge à une sanction longue tout en écartant la
 * sentinelle sans ambiguïté. Au-delà, on ne décompte rien — et la valeur brute
 * reste visible dans le détail du compte plutôt que d'être avalée en silence.
 */
const MAX_PLAUSIBLE_PENALTY_SECONDS = 30 * 24 * 3600;

const RANK_TYPES = {
	6: 'Wingman',
	7: 'Compétitif (héritage CS:GO)',
	10: 'Danger Zone',
	11: 'Premier',
	12: 'Compétitif (par carte)'
};

const SKILL_GROUPS = [
	'Non classé',
	'Silver I', 'Silver II', 'Silver III', 'Silver IV', 'Silver Elite', 'Silver Elite Master',
	'Gold Nova I', 'Gold Nova II', 'Gold Nova III', 'Gold Nova Master',
	'Master Guardian I', 'Master Guardian II', 'Master Guardian Elite', 'Distinguished Master Guardian',
	'Legendary Eagle', 'Legendary Eagle Master', 'Supreme Master First Class', 'Global Elite'
];

function penaltyReasonLabel(code) {
	if (code === undefined || code === null) return null;
	return PENALTY_REASONS[code] || `Raison inconnue (code ${code})`;
}

function skillGroupLabel(rankId) {
	return SKILL_GROUPS[rankId] || `Groupe ${rankId}`;
}

function rankTypeLabel(typeId) {
	return RANK_TYPES[typeId] || `Type de classement ${typeId}`;
}

/** Premier affiche un "CS Rating" brut (ex. 14 237), pas un groupe de skill. */
function formatPremier(rankId) {
	if (!rankId) return null;
	return rankId.toLocaleString('fr-FR');
}

/**
 * Transforme le protobuf CMsgGCCStrike15_v2_MatchmakingGC2ClientHello en objet plat.
 * `scannedAt` sert à convertir penalty_seconds (durée restante à l'instant du hello)
 * en date de fin absolue, pour pouvoir afficher un décompte vivant ensuite.
 */
/**
 * @param {object} gc message du GC
 * @param {number} scannedAt
 * @param {{authoritative?: boolean}} opts `authoritative: true` quand le message
 *   EST la source officielle des sanctions (le hello matchmaking, qu'il arrive
 *   en 9110 ou encapsulé dans `ClientWelcome.game_data2`). Dans ce cas seulement,
 *   un champ absent veut bien dire zéro — un protobuf n'encode pas les zéros.
 *   Pour une source non autoritaire comme PlayersProfile (9128), l'absence ne
 *   veut rien dire et on reste sur « inconnu ».
 */
function normalizeAccountData(gc, scannedAt, opts = {}) {
	const authoritative = opts.authoritative === true;
	// ATTENTION : absent ≠ zéro.
	// PlayersProfile (9128) est une vue publique, prévue pour être demandée sur
	// n'importe quel joueur : le GC en retire les champs privés que sont
	// penalty_seconds, penalty_reason et vac_banned. Les coercer en 0/false
	// faisait afficher « aucune sanction » à un compte réellement en cooldown.
	// On garde donc null, et `penaltyKnown` dit si la question a une réponse.
	const has = (v) => v !== undefined && v !== null;
	const penaltyKnown = authoritative || has(gc.penalty_seconds) || has(gc.penalty_reason);
	const rawPenaltySeconds = has(gc.penalty_seconds) ? Number(gc.penalty_seconds) : (authoritative ? 0 : null);
	// Hors du domaine plausible : sentinelle, pas un décompte.
	const penaltySentinel = rawPenaltySeconds !== null && rawPenaltySeconds > MAX_PLAUSIBLE_PENALTY_SECONDS;
	const penaltySeconds = penaltySentinel ? 0 : rawPenaltySeconds;
	const penaltyReason = has(gc.penalty_reason) ? Number(gc.penalty_reason) : (authoritative ? 0 : null);
	const rankings = (gc.rankings || []).map((r) => ({
		rankTypeId: Number(r.rank_type_id || 0),
		rankTypeLabel: rankTypeLabel(Number(r.rank_type_id || 0)),
		rankId: Number(r.rank_id || 0),
		wins: Number(r.wins || 0),
		rankChange: r.rank_change ? Number(r.rank_change) : 0,
		leaderboardName: r.leaderboard_name || '',
		perMapRank: (r.per_map_rank || []).map((m) => ({
			mapId: Number(m.map_id || 0),
			rankId: Number(m.rank_id || 0),
			rankLabel: skillGroupLabel(Number(m.rank_id || 0)),
			wins: Number(m.wins || 0)
		}))
	}));

	const premier = rankings.find((r) => r.rankTypeId === 11) || null;

	return {
		accountId: gc.account_id ? Number(gc.account_id) : null,
		vacBanned: has(gc.vac_banned) ? Number(gc.vac_banned) !== 0 : (authoritative ? false : null),
		vacKnown: has(gc.vac_banned) || authoritative,
		penaltyKnown,
		penaltySeconds,
		// Valeur telle que le GC l'a envoyée, pour que rien ne disparaisse.
		penaltyRawSeconds: rawPenaltySeconds,
		penaltySentinel,
		penaltyReason,
		penaltyReasonLabel: penaltyKnown ? penaltyReasonLabel(penaltyReason) : null,
		penaltyPermanent: penaltyReason !== null && PERMANENT_PENALTY_REASONS.has(penaltyReason),
		// Date de fin absolue : survit au redémarrage de l'app, contrairement à une durée.
		penaltyEndsAt: penaltySeconds > 0 ? scannedAt + penaltySeconds * 1000 : 0,
		playerLevel: gc.player_level === undefined ? null : Number(gc.player_level),
		playerCurXp: gc.player_cur_xp === undefined ? null : Number(gc.player_cur_xp),
		premierRating: premier ? premier.rankId : 0,
		premierWins: premier ? premier.wins : 0,
		premierLabel: premier ? formatPremier(premier.rankId) : null,
		rankings,
		inMatch: !!gc.ongoingmatch,
		// `ranking` (singulier) est le classement "principal" renvoyé par le GC
		mainRankId: gc.ranking ? Number(gc.ranking.rank_id || 0) : 0,
		mainRankTypeId: gc.ranking ? Number(gc.ranking.rank_type_id || 0) : 0
	};
}

/**
 * Catégorie unique pour la barre latérale. L'ordre des tests est l'ordre de
 * priorité : un compte banni ET en cooldown est rangé dans "banni".
 */
/**
 * Échecs qui ne disent rien sur le compte lui-même : il joue, Steam est occupé,
 * le GC n'a pas répondu… Dans ces cas l'état connu reste valable, et sortir le
 * compte de sa catégorie pour le ranger en « Erreur » serait une régression
 * d'information — on repart donc du dernier cache utile.
 */
const TRANSIENT_ERROR_KINDS = new Set([
	'playing', 'inuse', 'steamdown', 'ratelimit', 'timeout', 'disconnected', 'badtotp'
]);

/**
 * Fin de sanction retenue pour un cache donné.
 *
 * Les caches écrits avant le garde-fou portent une fin calculée à partir de la
 * sentinelle, soit l'an 2162. On la rejette ici aussi : l'affichage se corrige
 * tout seul, sans imposer un rescan qui coûterait un login et du budget
 * anti-throttle pour une donnée qu'on sait déjà fausse.
 */
function penaltyEndsAt(cache, now = Date.now()) {
	const end = Number(cache && cache.penaltyEndsAt) || 0;
	if (!end) return 0;
	const base = Number(cache.scannedAt) || now;
	return end - base > MAX_PLAUSIBLE_PENALTY_SECONDS * 1000 ? 0 : end;
}

function categorize(account, now = Date.now()) {
	const cache = account.cache;
	if (!cache || !account.lastScanAt) return 'unknown';
	if (account.lastScanOk === false) {
		if (cache.authFailed) return 'expired';
		const kind = account.lastError && account.lastError.kind;
		// Panne passagère + données déjà connues : on garde le classement précédent.
		if (!TRANSIENT_ERROR_KINDS.has(kind) || !cache.scannedAt) return 'error';
	}
	// vacBanned peut valoir null (inconnu) : seul `true` range dans "banni".
	if (cache.vacBanned === true || cache.penaltyPermanent) return 'banned';
	if (penaltyEndsAt(cache, now) > now) return 'cooldown';
	if (cache.prime === true) return 'prime';
	if (cache.prime === false) return 'nonprime';
	return 'unknown';
}

const CATEGORIES = [
	{ key: 'all', label: 'Tous', icon: '◆' },
	{ key: 'prime', label: 'Prime', icon: '★' },
	{ key: 'nonprime', label: 'Non-prime', icon: '☆' },
	{ key: 'cooldown', label: 'Cooldown', icon: '⏱' },
	{ key: 'banned', label: 'Banni', icon: '⛔' },
	{ key: 'expired', label: 'Expiré', icon: '🔑' },
	{ key: 'error', label: 'Erreur', icon: '!' },
	{ key: 'unknown', label: 'Non scanné', icon: '?' }
];

module.exports = {
	CS2_APPID,
	PRIME_APPID,
	CATEGORIES,
	PENALTY_REASONS,
	PERMANENT_PENALTY_REASONS,
	TRANSIENT_ERROR_KINDS,
	SKILL_GROUPS,
	normalizeAccountData,
	categorize,
	penaltyReasonLabel,
	penaltyEndsAt,
	MAX_PLAUSIBLE_PENALTY_SECONDS,
	skillGroupLabel,
	rankTypeLabel
};
