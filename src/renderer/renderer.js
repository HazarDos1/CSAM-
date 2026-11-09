'use strict';
/**
 * Logique de l'interface. Pas de framework : un état en mémoire, des fonctions
 * render*() qui régénèrent chaque zone à partir de cet état, et des écouteurs
 * délégués. Tout ce qui touche aux secrets ou au disque passe par window.api.
 */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
	categories: [],
	skillGroups: [],   // libellés des groupes de skill, fournis par le main
	penaltyReasons: {},// libellés des raisons de sanction, fournis par le main
	maxPenaltySeconds: 0, // borne de plausibilité d'un cooldown, fournie par le main
	TRANSIENT: new Set(),
	accounts: [],
	settings: null,
	selectedId: null,
	category: 'all',
	search: '',
	sort: 'name',
	progress: {},       // accountId -> dernier message de scan
	queue: { queued: [], current: null, pausedUntil: 0, pauseReason: null, busy: false },
	totp: null          // { id, code, expiresAt }
};

// ───────────────────────── utilitaires d'affichage ─────────────────────────

function displayName(a) {
	return a.label || (a.cache && a.cache.personaName) || a.username;
}

function fmtDate(ms) {
	if (!ms) return '—';
	return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtAgo(ms) {
	if (!ms) return 'jamais';
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return 'à l\'instant';
	if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
	if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
	return `il y a ${Math.floor(s / 86400)} j`;
}

function fmtDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const d = Math.floor(total / 86400);
	const h = Math.floor((total % 86400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, '0');
	if (d > 0) return `${d} j ${pad(h)}:${pad(m)}:${pad(s)}`;
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Libellé d'une raison de sanction, recalculé depuis le code brut plutôt que lu
 * dans le cache : un compte scanné avant l'ajout d'un code garderait sinon
 * « Raison inconnue » jusqu'au prochain scan.
 */
function penaltyLabel(c) {
	if (!c || c.penaltyReason == null) return '';
	return state.penaltyReasons[c.penaltyReason]
		|| c.penaltyReasonLabel
		|| `Raison inconnue (code ${c.penaltyReason})`;
}

/**
 * Temps de cooldown restant, sentinelle écartée.
 *
 * `penalty_seconds` est un uint32 : un − 1 du GC arrive en 4 294 967 295, soit
 * 49 710 jours. Un cache écrit avant le garde-fou porte encore une fin en l'an
 * 2162 ; on applique donc la même borne qu'à la normalisation, pour que
 * l'affichage se corrige sans imposer un rescan.
 */
function cooldownLeft(a) {
	const cache = a.cache;
	const end = cache && cache.penaltyEndsAt;
	if (!end) return 0;
	const base = cache.scannedAt || Date.now();
	const max = (state.maxPenaltySeconds || 30 * 24 * 3600) * 1000;
	if (end - base > max) return 0;
	return end > Date.now() ? end - Date.now() : 0;
}

/**
 * Un compte en cooldown est exclu des scans groupés : la fin de sanction est une
 * date absolue, décomptée en local, donc un rescan ne révélerait rien de neuf et
 * dépenserait un login plus du budget anti rate-limit. Le bouton « Scanner » du
 * panneau de détail reste disponible pour forcer au cas par cas.
 */
function scannable(a) {
	return !cooldownLeft(a);
}

/** La catégorie vient du main, mais un cooldown peut expirer entre deux scans : on recalcule localement. */
function liveCategory(a) {
	if (a.category === 'cooldown' && !cooldownLeft(a)) {
		return a.cache && a.cache.prime === true ? 'prime' : a.cache && a.cache.prime === false ? 'nonprime' : 'unknown';
	}
	return a.category;
}

function badge(cls, text, title) {
	return `<span class="badge badge-${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

let toastTimer = null;
function toast(message, kind = '') {
	let el = $('.toast');
	if (!el) {
		el = document.createElement('div');
		document.body.appendChild(el);
	}
	el.className = `toast ${kind}`;
	el.textContent = message;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

/** Déballe {ok, data}|{ok:false, error} ; jette en cas d'erreur pour que l'appelant gère. */
async function call(promise) {
	const res = await promise;
	if (!res.ok) throw new Error(res.error);
	return res.data;
}

/** Comptes visibles après recherche, triés selon le sélecteur. */
function visibleAccounts() {
	const q = state.search.trim().toLowerCase();
	const list = state.accounts.filter((a) => {
		if (!q) return true;
		const hay = [a.username, a.label, a.steamId, a.note, a.cache && a.cache.personaName]
			.filter(Boolean).join(' ').toLowerCase();
		return hay.includes(q);
	});
	const name = (a) => displayName(a).toLowerCase();
	switch (state.sort) {
		case 'scan': list.sort((x, y) => (y.lastScanAt || 0) - (x.lastScanAt || 0)); break;
		// Les comptes sans cooldown passent après, d'où l'Infinity.
		case 'cooldown': list.sort((x, y) => (cooldownLeft(x) || Infinity) - (cooldownLeft(y) || Infinity)); break;
		case 'rating': list.sort((x, y) => ((y.cache && y.cache.premierRating) || 0) - ((x.cache && x.cache.premierRating) || 0)); break;
		default: list.sort((x, y) => name(x).localeCompare(name(y), 'fr'));
	}
	return list;
}

function categoryBadge(a) {
	const cat = liveCategory(a);
	switch (cat) {
		case 'prime': return badge('prime', 'Prime');
		case 'nonprime': return badge('nonprime', 'Non-prime');
		case 'cooldown': return badge('cooldown', `Cooldown ${fmtDuration(cooldownLeft(a))}`);
		case 'banned': return badge('banned', a.cache && a.cache.vacBanned ? 'VAC' : 'Banni');
		case 'expired': return badge('expired', 'Expiré', a.lastError && a.lastError.message);
		case 'error': return badge('error', 'Erreur', a.lastError && a.lastError.message);
		default: return badge('unknown', 'Non scanné');
	}
}

/** Libellé court de l'état, affiché sous le pseudo dans le cadre Information. */
const STATE_LABELS = {
	prime: 'Prime', nonprime: 'Non prime', cooldown: 'Cooldown',
	banned: 'Banni', expired: 'Identifiants à revoir', error: 'Erreur de scan', unknown: 'Jamais scanné'
};

function avatarHtml(a, big) {
	const url = a.cache && a.cache.avatar;
	if (big) {
		return url
			? `<img class="info-avatar" src="${esc(url)}" alt="" />`
			: `<div class="info-avatar-fallback">${esc(displayName(a).slice(0, 1).toUpperCase())}</div>`;
	}
	return '';
}

// ───────────────────────── arborescence ─────────────────────────

/**
 * Groupes de l'arbre. « Premier ready » rassemble les comptes jouables ;
 * les autres groupes sont des états qui empêchent de jouer.
 */
const TREE_GROUPS = [
	{ key: 'premier-ready', label: 'Premier ready', children: ['prime', 'nonprime'] },
	{ key: 'cooldown', label: 'Cooldown' },
	{ key: 'banned', label: 'Banned' },
	{ key: 'expired', label: 'Expired' },
	{ key: 'error', label: 'Erreur' },
	{ key: 'unknown', label: 'Non scanné' }
];
const CHILD_LABELS = { prime: 'Prime', nonprime: 'Non prime' };

function isCollapsed(key) {
	if (!state.collapsed) state.collapsed = new Set();
	return state.collapsed.has(key);
}

function renderCategories() {
	$('#stat-total').textContent = state.accounts.length;
	$('#stat-tokens').textContent = state.accounts.filter((a) => a.hasRefreshToken).length;
}

function treeItemHtml(a) {
	const cat = liveCategory(a);
	const scanning = state.queue.current === a.id;
	const queued = state.queue.queued.includes(a.id);
	let meta = '';
	if (scanning) meta = '<span class="spinner"></span>';
	else if (queued) meta = '<span class="tree-meta">file</span>';
	else if (cat === 'cooldown') meta = `<span class="tree-meta" data-cooldown="${a.id}">${fmtDuration(cooldownLeft(a))}</span>`;
	else if (a.cache && a.cache.premierRating) meta = `<span class="tree-meta">${esc(a.cache.premierLabel)}</span>`;
	return `<div class="tree-item ${a.id === state.selectedId ? 'selected' : ''} ${scanning ? 'scanning' : ''}"
		data-id="${a.id}" title="${esc(a.username)}">
		<span class="dot dot-${cat}"></span>
		<span class="tree-name">${esc(displayName(a))}</span>
		${meta}
	</div>`;
}

function groupHtml(key, label, accounts, isSub) {
	if (!accounts.length) return '';
	const collapsed = isCollapsed(key);
	return `<div class="tree-group ${isSub ? 'tree-sub' : ''}">
		<div class="tree-head" data-group="${key}">
			<span class="tree-caret ${collapsed ? '' : 'open'}"></span>
			<span>${esc(label)}</span>
			<span class="tree-count">${accounts.length}</span>
		</div>
		${collapsed ? '' : accounts.map(treeItemHtml).join('')}
	</div>`;
}

function renderList() {
	const list = visibleAccounts();
	const byCat = {};
	for (const a of list) (byCat[liveCategory(a)] = byCat[liveCategory(a)] || []).push(a);

	if (!list.length) {
		$('#account-list').innerHTML = `<div class="tree-empty">${
			state.accounts.length ? 'Aucun compte ne correspond.' : 'Aucun compte. Importe tes .maFile ou ajoute un compte.'
		}</div>`;
		return;
	}

	let html = '';
	for (const g of TREE_GROUPS) {
		if (g.children) {
			const total = g.children.reduce((n, c) => n + (byCat[c] || []).length, 0);
			if (!total) continue;
			const collapsed = isCollapsed(g.key);
			html += `<div class="tree-group">
				<div class="tree-head" data-group="${g.key}">
					<span class="tree-caret ${collapsed ? '' : 'open'}"></span>
					<span>${esc(g.label)}</span>
					<span class="tree-count">${total}</span>
				</div>
				${collapsed ? '' : g.children.map((c) => groupHtml(c, CHILD_LABELS[c], byCat[c] || [], true)).join('')}
			</div>`;
		} else {
			html += groupHtml(g.key, g.label, byCat[g.key] || [], false);
		}
	}
	$('#account-list').innerHTML = html;
}

// ───────────────────────── panneau Information ─────────────────────────

/**
 * Niveau de profil CS2. Le GC renvoie un XP absolu décalé d'une constante
 * (327 680 000) et il faut 5 000 XP par niveau — deux valeurs connues de la
 * communauté, pas documentées par Valve. Si le calcul sort des clous, on
 * n'affiche pas de barre plutôt que d'en afficher une fausse.
 */
const XP_BASE = 327680000;
const XP_PER_LEVEL = 5000;

function levelProgress(c) {
	if (!c || c.playerCurXp == null) return null;
	const xp = c.playerCurXp - XP_BASE;
	if (xp < 0 || xp > XP_PER_LEVEL * 100) return null;
	return { xp: xp % XP_PER_LEVEL, pct: Math.min(100, ((xp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100) };
}

/*
 * Insignes de rang CS2, redessinés en SVG.
 *
 * Les PNG de Valve ne sont pas distribués sur une CDN publique stable, et la CSP
 * de l'app n'autorise les images que depuis `data:` et le CDN d'avatars Steam.
 * On redessine donc d'après les conventions du jeu : écusson, étoiles de
 * sous-palier, et surtout les mêmes paliers et les mêmes couleurs.
 *
 * Les paliers sont vérifiables : rank 27 doit tomber sur « Captain », ce que
 * montre la capture de référence.
 */

/** [niveau min, niveau max, nom, couleur sombre, couleur claire] */
const RANK_TIERS = [
	[1, 1, 'Recruit', '#4a5361', '#7d8a9c'],
	[2, 4, 'Private', '#4a6180', '#7e9cc4'],
	[5, 8, 'Corporal', '#2f6fa8', '#63b2e0'],
	[9, 12, 'Sergeant', '#28559e', '#4f8fe0'],
	[13, 16, 'Master Sergeant', '#2a3f9c', '#5068e0'],
	[17, 20, 'Sergeant Major', '#4432a4', '#7a62e8'],
	[21, 24, 'Lieutenant', '#6128ab', '#a268f0'],
	[25, 28, 'Captain', '#8c22b4', '#c75ff0'],
	[29, 32, 'Major', '#b02090', '#e85fc8'],
	[33, 36, 'Colonel', '#b02a3a', '#e8606f'],
	[37, 40, 'General', '#b07a16', '#f0c040']
];

function rankTier(level) {
	const n = Number(level) || 0;
	for (const t of RANK_TIERS) if (n >= t[0] && n <= t[1]) return t;
	return RANK_TIERS[0];
}

/** « Captain » pour 27, « General » pour 40. */
function rankName(level) {
	return rankTier(level)[2];
}

/** Rang dans le palier : 1 à 4, matérialisé par le nombre d'étoiles. */
function rankStep(level) {
	const t = rankTier(level);
	return Math.max(1, (Number(level) || 1) - t[0] + 1);
}

function star(cx, cy, r, fill) {
	let d = '';
	for (let i = 0; i < 10; i++) {
		const rad = i % 2 ? r * 0.45 : r;
		const ang = (Math.PI / 5) * i - Math.PI / 2;
		d += `${i ? 'L' : 'M'}${(cx + Math.cos(ang) * rad).toFixed(2)} ${(cy + Math.sin(ang) * rad).toFixed(2)} `;
	}
	return `<path d="${d}Z" fill="${fill}"/>`;
}

/*
 * Écussons authentiques, extraits de l'installation locale de CS2 par
 * `node tools/extract-ranks.js` (médailles de niveau en PNG 128×128, groupes de
 * skill en SVG vectoriel). Si le dossier `ranks/` est absent — CS2 pas installé,
 * extraction jamais lancée — l'image échoue et le dessin de repli prend le
 * relais : voir `installRankFallback()`.
 */
function rankBadgeImg(level) {
	const n = Math.max(1, Math.min(40, Number(level) || 1));
	return `<img class="rank-badge" src="ranks/level${n}.png" alt="Rank ${n}"
		data-fallback="level" data-level="${n}" />`;
}

/** Écusson de groupe de skill compétitif, ressource du jeu. */
function skillGroupImg(rankId) {
	const n = Number(rankId) || 0;
	const file = n >= 1 && n <= 18 ? `skillgroup${n}` : 'skillgroup_none';
	return `<img class="comp-chevron" src="ranks/${file}.svg" alt=""
		data-fallback="skillgroup" data-rank="${n}" />`;
}

/**
 * Remplace une image de rang manquante par le dessin de repli.
 *
 * `error` ne remonte pas la hiérarchie : il faut l'écouter en phase de capture.
 * Un seul écouteur sur le document suffit pour toutes les images, présentes et
 * à venir — et la CSP interdit un `onerror=` en ligne.
 */
function installRankFallback() {
	document.addEventListener('error', (e) => {
		const img = e.target;
		if (!img || img.tagName !== 'IMG' || !img.dataset.fallback) return;
		const html = img.dataset.fallback === 'level'
			? rankBadgeDrawn(Number(img.dataset.level))
			: skillGroupDrawn(Number(img.dataset.rank));
		const holder = document.createElement('div');
		holder.innerHTML = html;
		const svg = holder.firstElementChild;
		if (svg) img.replaceWith(svg);
	}, true);
}

function rankBadgeDrawn(level) {
	const t = rankTier(level);
	const [, , , dark, light] = t;
	const steps = rankStep(level);
	const id = `rk${String(level).replace(/\W/g, '')}`;

	// étoiles alignées en bas de l'écusson, une par sous-palier
	const stars = [];
	const spread = 7.5;
	const x0 = 23 - ((steps - 1) * spread) / 2;
	for (let i = 0; i < steps; i++) stars.push(star(x0 + i * spread, 34, 3.6, '#fff'));

	return `<svg class="rank-badge" viewBox="0 0 46 50" aria-hidden="true">
		<defs>
			<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/>
			</linearGradient>
		</defs>
		<path d="M23 2 43 8.5v17.8C43 37 34.6 44.6 23 48 11.4 44.6 3 37 3 26.3V8.5L23 2z"
			fill="url(#${id})" stroke="#15161a" stroke-width="2"/>
		<path d="M23 5.2 40 10.8v15.5c0 9.1-7.1 15.7-17 18.7-9.9-3-17-9.6-17-18.7V10.8L23 5.2z"
			fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2"/>
		<path d="M23 13l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8L23 13z"
			fill="rgba(255,255,255,.9)"/>
		${stars.join('')}
	</svg>`;
}

/**
 * Bandes de couleur du CS Rating Premier, telles que le jeu les affiche :
 * gris, bleu clair, bleu, violet, rose, rouge, or — par tranches de 5 000.
 */
const PREMIER_BANDS = [
	[0, '#a9c0d6', '#7d93a8'],
	[5000, '#5b9bd5', '#3572a8'],
	[10000, '#4a6ef0', '#2742b8'],
	[15000, '#7b4ae8', '#4a21ab'],
	[20000, '#b33fc4', '#7d1c8c'],
	[25000, '#ef4a4a', '#b01f1f'],
	[30000, '#f0b429', '#b07a16']
];

function premierBand(rating) {
	const n = Number(rating) || 0;
	let band = PREMIER_BANDS[0];
	for (const b of PREMIER_BANDS) if (n >= b[0]) band = b;
	return band;
}

/**
 * Icône de groupe de skill compétitif. Les familles suivent celles du jeu :
 * chevrons argentés pour Silver, chevrons dorés pour Gold Nova, barres pour
 * Master Guardian, ailes pour Eagle et au-dessus.
 */
function skillGroupDrawn(rankId) {
	const n = Number(rankId) || 0;
	if (!n) {
		return `<svg class="comp-chevron" viewBox="0 0 44 19" aria-hidden="true">
			<path d="M3 14 L13 5 L23 14 L33 5 L41 12" fill="none" stroke="#9aa0a8" stroke-width="2.4"
				stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	}
	let color = '#c8ccd2', count = Math.min(4, n);         // Silver 1-6
	if (n >= 7 && n <= 10) { color = '#e8c13d'; count = n - 6; }   // Gold Nova
	else if (n >= 11 && n <= 14) { color = '#7fd8f0'; count = n - 10; } // Master Guardian
	else if (n >= 15) { color = '#f0a030'; count = Math.min(4, n - 14); } // Eagle / Supreme / Global

	const parts = [];
	for (let i = 0; i < count; i++) {
		const x = 4 + i * 10;
		parts.push(`<path d="M${x} 14 L${x + 5} 5 L${x + 10} 14" fill="none" stroke="${color}"
			stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
	}
	if (n >= 15) parts.push(star(38, 9, 4.5, color));
	return `<svg class="comp-chevron" viewBox="0 0 44 19" aria-hidden="true">${parts.join('')}</svg>`;
}

/** Statut compétitif : non classé tant que les 10 matchs de placement ne sont pas faits. */
function compStatus(c) {
	if (!c || !c.rankings || !c.rankings.length) return 'Aucun classement renvoyé par le GC';
	const main = c.rankings.find((r) => r.rankTypeId === 11) || c.rankings[0];
	if (main.rankId) {
		return main.rankTypeId === 11
			? `Premier · ${main.rankId.toLocaleString('fr-FR')}`
			: `${main.rankTypeLabel} · ${state.skillGroups[main.rankId] || 'groupe ' + main.rankId}`;
	}
	// Au-delà de 10 victoires, « X/10 » n'a plus de sens : les placements sont
	// faits et Steam renvoie quand même rank_id = 0. Ça arrive après une
	// réinitialisation de saison ou l'expiration d'un classement. On montre donc
	// le fait brut plutôt qu'une progression qui n'en est plus une.
	return main.wins >= 10
		? `Non classé — ${main.wins} victoires, aucun rang renvoyé par Steam`
		: `Non classé (${main.wins}/10 placements)`;
}

function rankingsHtml(c) {
	if (!c || !c.rankings || !c.rankings.length) return '<div class="row"><span class="row-label">Aucun classement renvoyé par le GC</span></div>';
	return c.rankings.map((r) => {
		const value = r.rankTypeId === 11
			? `${r.rankId ? r.rankId.toLocaleString('fr-FR') : 'non classé'} · ${r.wins} v.`
			: `${r.rankId ? state.skillGroups[r.rankId] || `groupe ${r.rankId}` : 'non classé'} · ${r.wins} v.`;
		const maps = r.perMapRank && r.perMapRank.length
			? `<div class="row-value mono" style="text-align:left;color:var(--text-faint)">${r.perMapRank.map((m) => `carte #${m.mapId} : ${esc(m.rankLabel)} (${m.wins} v.)`).join('<br>')}</div>`
			: '';
		return `<div class="row"><span class="row-label">${esc(r.rankTypeLabel)}</span><span class="row-value">${esc(value)}</span></div>${maps}`;
	}).join('');
}

function renderDetail() {
	const a = state.accounts.find((x) => x.id === state.selectedId);
	const pane = $('#detail-pane');
	if (!a) {
		pane.innerHTML = '<fieldset class="frame" style="flex:1"><legend>Information</legend><div class="empty-detail">Sélectionne un compte.</div></fieldset>';
		return;
	}
	const c = a.cache;
	const cat = liveCategory(a);
	const scanning = state.queue.current === a.id;
	const left = cooldownLeft(a);
	const steamId = a.steamId || (c && c.steamId) || '';
	const accountId = steamId ? (BigInt(steamId) & 0xFFFFFFFFn).toString() : '';
	const lvl = levelProgress(c);

	// ── alertes ──
	let alert = '';
	if (a.lastScanOk === false && a.lastError) {
		// Un scan raté parce que le compte joue (ou que Steam était occupé) n'est pas
		// une panne : les données affichées restent celles du dernier scan réussi.
		const transient = state.TRANSIENT.has(a.lastError.kind);
		alert += `<div class="alert ${transient ? '' : 'danger'}">
			<div style="font-weight:700;color:${transient ? 'var(--warn)' : 'var(--danger)'}">${
				transient ? 'Scan reporté' : 'Dernier scan en échec'}</div>
			<div class="alert-sub">${esc(a.lastError.message)}${
				transient && c && c.scannedAt ? ` — les infos ci-dessus datent du ${fmtDate(c.scannedAt)}.` : ''
			}</div>${
				a.lastError.gcLog && a.lastError.gcLog.length
					? `<details><summary>Journal Game Coordinator (${a.lastError.gcLog.length} lignes)</summary><pre class="raw-dump">${esc(a.lastError.gcLog.join('\n'))}</pre></details>`
					: ''
			}</div>`;
	}
	if (c && (c.vacBanned === true || c.penaltyPermanent)) {
		alert += `<div class="alert danger"><div class="alert-timer">${c.vacBanned === true ? 'Banni VAC' : 'Sanction définitive'}</div>
			<div class="alert-sub">${esc(penaltyLabel(c))}${c.penaltyReason != null ? ` · code ${c.penaltyReason}` : ''}</div></div>`;
	} else if (left) {
		alert += `<div class="alert"><div class="alert-timer" id="cooldown-timer">${fmtDuration(left)}</div>
			<div class="alert-sub">${esc(penaltyLabel(c))} (code ${c.penaltyReason}) · fin ${fmtDate(c.penaltyEndsAt)}</div></div>`;
	}

	pane.innerHTML = `
	<fieldset class="frame">
		<legend>Information</legend>
		<div class="info-top">
			${avatarHtml(a, true)}
			<div class="info-id">
				<p class="info-name">${esc(displayName(a))}</p>
				<div class="info-state s-${cat}">${c && c.inMatch ? 'En partie' : esc(STATE_LABELS[cat] || cat)}</div>
				<div class="info-line copyable" data-copy="${esc(a.username)}">${esc(a.username)}</div>
				<div class="info-line copyable" data-copy="${esc(steamId)}">${esc(steamId || '—')}</div>
				<div class="info-line">${accountId ? `[U:1:${accountId}]` : ''}</div>
				<div class="info-line">Last played: ${c && c.lastMatchAt ? fmtAgo(c.lastMatchAt) : '—'}</div>
			</div>
		</div>

		${lvl ? `<div class="rank-row">
			${rankBadgeImg(c.playerLevel)}
			<div class="rank-meta">
				<div class="rank-title">${esc(rankName(c.playerLevel))} <span style="color:#c6c9ce">Rank ${c.playerLevel}</span></div>
				<div class="rank-bar"><div style="width:${lvl.pct.toFixed(1)}%"></div></div>
				<div class="rank-xp">${lvl.xp.toLocaleString('fr-FR')} / ${XP_PER_LEVEL.toLocaleString('fr-FR')} XP</div>
			</div>
		</div>` : ''}

		<div class="premier-row">
			<div class="premier-chip ${c && c.premierRating ? '' : 'unranked'}"${
				c && c.premierRating ? ` style="background:linear-gradient(180deg,${premierBand(c.premierRating)[1]},${premierBand(c.premierRating)[2]})"` : ''
			}>${c && c.premierRating ? esc(c.premierLabel) : '—'}</div>
			<div class="premier-label">Premier Rating</div>
		</div>
		<div class="comp-row">${skillGroupImg(c && c.rankings && (c.rankings.find((r) => r.rankTypeId !== 11) || {}).rankId)}<span class="comp-text">${esc(compStatus(c))}</span></div>

		${alert}

		<div class="rows">
			<div class="row"><span class="row-label">Prime</span><span class="row-value">${
				!c || c.prime == null ? 'inconnu' : c.prime ? '<span style="color:var(--prime)">oui</span>' : 'non'}</span></div>
			<div class="row"><span class="row-label">VAC</span><span class="row-value">${
				!c || !c.scannedAt ? '—'
					: c.vacKnown !== true ? '<span style="color:var(--text-faint)">non communiqué</span>'
					: c.vacBanned ? '<span style="color:var(--danger)">banni</span>' : 'aucun ban'}</span></div>
			<div class="row"><span class="row-label">Statut compétitif</span><span class="row-value">${
				!c || !c.scannedAt ? '—'
					: c.penaltyKnown !== true ? '<span style="color:var(--warn)">non communiqué par le GC</span>'
					: c.penaltyPermanent ? `<span style="color:var(--danger)">${esc(penaltyLabel(c))}</span>`
					: left ? `<span style="color:var(--warn)">cooldown ${fmtDuration(left)}</span>`
					: c.penaltySentinel
						? `aucune sanction <span style="color:var(--text-faint)">(penalty_seconds=${c.penaltyRawSeconds}, valeur sentinelle)</span>`
						: 'aucune sanction'}</span></div>
			<div class="row"><span class="row-label">Dernier scan</span><span class="row-value">${
				a.lastScanAt ? `${fmtDate(a.lastScanAt)} (${fmtAgo(a.lastScanAt)})` : 'jamais'}</span></div>
		</div>
	</fieldset>

	<fieldset class="frame">
		<legend>Actions</legend>
		<div class="act-grid">
			<button class="btn btn-primary" data-act="launch" ${!a.hasPassword && !a.hasRefreshToken ? 'disabled' : ''}>▶ Lancer dans Steam</button>
			<button class="btn" data-act="scan" ${scanning ? 'disabled' : ''}>${scanning ? 'Scan en cours…' : 'Scanner'}</button>
			<button class="btn" data-act="confirmations" ${a.hasIdentitySecret ? '' : 'disabled'}
				title="Échanges et mises en vente en attente">Confirmations</button>
			<button class="btn" data-act="edit">Modifier</button>
			<button class="btn btn-danger-ghost" data-act="remove">Supprimer</button>
		</div>

		${scanning ? `<div class="alert" style="border-left-color:var(--accent);background:#20262f;border-color:#2d4660">
			<div class="log-line"><span class="spinner"></span> ${esc(state.progress[a.id] || 'démarrage…')}</div></div>` : ''}

		${a.secretRejected ? `<div class="guard-row">
			<span class="row-label">Steam Guard</span>
			<span style="color:var(--danger);font-weight:700">secret refusé par Steam</span>
		</div>
		<p class="field hint" style="margin:6px 0 0">Steam ne reconnaît aucun authenticator mobile sur ce compte :
		le <code>shared_secret</code> enregistré est périmé ou vient d'un autre compte. Il ne produira jamais
		de code valide — remplace-le en créant un authenticator.</p>` : `<div class="guard-row">
			<span class="row-label">Steam Guard</span>
			<span class="guard-code" id="guard-code">${a.hasSharedSecret ? '·····' : '—'}</span>
			<span class="guard-bar"><div id="guard-bar" style="width:0%"></div></span>
			<button class="btn btn-sm" data-act="copy-code" ${a.hasSharedSecret ? '' : 'disabled'}>Copier</button>
		</div>`}

		${a.authenticatorPending ? `<p class="modal-error" style="margin:9px 0 0">
			Authenticator créé mais jamais finalisé : le secret et le code de révocation sont
			enregistrés, mais Steam Guard n'est pas encore actif. Le bouton ci-dessous reprend
			directement à la saisie du code SMS.</p>` : ''}

		<div class="act-grid" style="margin-top:10px">
			${a.authenticatorPending
				? `<button class="btn btn-sm btn-primary" data-act="authenticator" ${a.hasPassword ? '' : 'disabled'}>Terminer l'activation</button>`
				: a.hasSharedSecret && !a.secretRejected
					? `<button class="btn btn-sm btn-danger-ghost" data-act="authenticator">Retirer l'authenticator</button>`
					: `<button class="btn btn-sm" data-act="authenticator" ${a.hasPassword ? '' : 'disabled'}>Créer un authenticator</button>`}
			${a.secretRejected ? `<button class="btn btn-sm btn-danger-ghost" data-act="drop-secret">Effacer le secret invalide</button>` : ''}
			${a.hasRevocationCode ? '<button class="btn btn-sm" data-act="reveal-revocation">Code de révocation</button>' : ''}
		</div>
		${!a.hasPassword && !a.hasSharedSecret
			? '<p class="field hint" style="margin-top:6px">Enregistre d\'abord le mot de passe Steam (bouton « Modifier »).</p>' : ''}
	</fieldset>

	<fieldset class="frame">
		<legend>Classements</legend>
		${rankingsHtml(c)}
	</fieldset>

	<fieldset class="frame">
		<legend>Notes</legend>
		<textarea class="note-input" id="note-input" placeholder="Note libre (ex. origine du compte, email associé…)">${esc(a.note)}</textarea>
		${c ? `<details><summary>Données brutes du dernier scan</summary><pre class="raw-dump">${esc(JSON.stringify(c, null, 2))}</pre></details>` : ''}
	</fieldset>
	`;

	refreshTotp(true);
}

function renderStatus() {
	const q = state.queue;
	$('#btn-scan-stop').hidden = !q.busy;
	$('#btn-scan-all').disabled = q.busy;
	$('#btn-scan-stale').disabled = q.busy;
	const parts = [];
	if (q.current) parts.push('1 en cours');
	if (q.queued.length) parts.push(`${q.queued.length} en attente`);
	if (q.pausedUntil > Date.now()) parts.push(`pause (${q.pauseReason}) ${fmtDuration(q.pausedUntil - Date.now())}`);
	$('#status-queue').textContent = parts.join(' · ');
	if (!q.busy && !parts.length) $('#status-text').textContent = 'Prêt.';
}

function renderAll() {
	renderCategories();
	renderList();
	renderDetail();
	renderStatus();
}

// Horloge : décompte des cooldowns, barre TOTP, pastilles de la liste.
setInterval(() => {
	if ($('#app').hidden) return;
	const timer = $('#cooldown-timer');
	const a = state.accounts.find((x) => x.id === state.selectedId);
	if (timer && a) {
		const left = cooldownLeft(a);
		timer.textContent = fmtDuration(left);
		if (!left) renderAll(); // cooldown terminé : le compte change de catégorie
	}
	refreshTotp(false);
	// rafraîchit les décomptes de la liste sans tout re-rendre si rien n'est en cours
	if (state.accounts.some((x) => cooldownLeft(x))) renderList();
	renderStatus();
}, 1000);

async function refreshTotp(force) {
	const a = state.accounts.find((x) => x.id === state.selectedId);
	const codeEl = $('#guard-code');
	const barEl = $('#guard-bar');
	if (!a || !a.hasSharedSecret || !codeEl) return;
	const now = Date.now();
	if (force || !state.totp || state.totp.id !== a.id || state.totp.expiresAt <= now) {
		try {
			const { code, secondsLeft } = await call(window.api.totp.code(a.id));
			state.totp = { id: a.id, code, expiresAt: now + secondsLeft * 1000 };
		} catch (err) {
			codeEl.textContent = '—';
			return;
		}
	}
	codeEl.textContent = state.totp.code;
	const pct = Math.max(0, Math.min(100, ((state.totp.expiresAt - Date.now()) / 30000) * 100));
	if (barEl) barEl.style.width = `${pct}%`;
}

// ───────────────────────── données ─────────────────────────

async function reloadAccounts() {
	state.accounts = await call(window.api.accounts.list());
	if (state.selectedId && !state.accounts.some((a) => a.id === state.selectedId)) state.selectedId = null;
	renderAll();
}

function replaceAccount(updated) {
	const i = state.accounts.findIndex((a) => a.id === updated.id);
	if (i === -1) state.accounts.push(updated); else state.accounts[i] = updated;
}

async function startScan(ids, forceCredentials = false) {
	try {
		const added = await call(window.api.scan.start(ids, forceCredentials));
		if (!added.length) toast('Rien à scanner (déjà en file ?)');
		else $('#status-text').textContent = `${added.length} compte(s) ajouté(s) à la file.`;
	} catch (err) {
		toast(err.message, 'error');
	}
}

async function launchAccount(id, mode) {
	const a = state.accounts.find((x) => x.id === id);
	$('#status-text').textContent = `Lancement de ${displayName(a)}…`;
	try {
		const res = await call(window.api.launch.account(id, mode));
		const msg = [`Steam lancé (${res.mode === 'autologin' ? 'session mémorisée' : 'mot de passe'})`];
		if (res.code) msg.push(`code Steam Guard ${res.code} copié`);
		toast(msg.join(' · '), 'ok');
		$('#status-text').textContent = res.notes.join(' ');
	} catch (err) {
		toast(err.message, 'error');
		$('#status-text').textContent = 'Lancement échoué.';
	}
}

// ───────────────────────── modales ─────────────────────────

function openModal(html) {
	const root = $('#modal-root');
	root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
	const first = root.querySelector('input, select, textarea, button');
	if (first) first.focus();
	root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
		if (e.target === e.currentTarget) closeModal();
	});
	return root.querySelector('.modal');
}

// Une création d'authenticator garde une session Steam ouverte côté main : toute
// fermeture de la modale (bouton, Échap, clic hors cadre) doit la libérer.
let authFlowActive = false;

/*
 * Journal technique du flux authenticator.
 *
 * Les lignes émises par le moteur (`auth2fa:progress`) n'étaient affichées
 * nulle part : un refus de Steam ne laissait qu'un message d'erreur reformulé,
 * sans le code brut ni l'étape où ça a lâché. On les montre désormais telles
 * quelles, et on les rend copiables — c'est ce qui permet de diagnostiquer.
 */
let authLogLines = [];

function authLogHtml() {
	return `<details class="authlog" open>
		<summary>Journal technique · <span id="a-log-count">${authLogLines.length}</span> ligne(s)</summary>
		<pre class="raw-dump" id="a-log">${esc(authLogLines.join('\n')) || 'En attente…'}</pre>
		<button class="btn btn-sm" id="a-log-copy">Copier le journal</button>
	</details>`;
}

function appendAuthLog(message) {
	authLogLines.push(message);
	const count = document.getElementById('a-log-count');
	if (count) count.textContent = String(authLogLines.length);
	const pre = document.getElementById('a-log');
	if (pre) {
		pre.textContent = authLogLines.join('\n');
		pre.scrollTop = pre.scrollHeight;
	}
}

function closeModal() {
	$('#modal-root').innerHTML = '';
	if (authFlowActive) {
		authFlowActive = false;
		window.api.auth2fa.cancel();
	}
	if (confFlowActive) {
		confFlowActive = false;
		window.api.conf.close();
	}
}

function modalError(modal, message) {
	let el = modal.querySelector('.modal-error');
	if (!el) {
		el = document.createElement('p');
		el.className = 'modal-error';
		modal.querySelector('.modal-actions').before(el);
	}
	el.textContent = message;
}

/**
 * Création (ou retrait) d'un authenticator Steam, en remplacement de SDA.
 *
 * Le déroulé enchaîne plusieurs écrans dans la même modale, parce que la session
 * Steam ouverte côté main doit survivre entre les étapes. L'écran du code de
 * révocation est volontairement bloquant : c'est l'unique porte de secours du
 * compte, et Steam ne le réaffiche jamais.
 */
function authenticatorModal(account) {
	authFlowActive = true;
	authLogLines = [];
	const modal = openModal('<h2>Authenticator Steam</h2><p class="modal-sub">Connexion…</p>');
	const sub = esc(account.label ? `${account.label} · ${account.username}` : account.username);

	// Le journal est réinjecté à chaque écran : la modale se réécrit entièrement
	// entre les étapes, et perdre l'historique au moment précis où ça échoue
	// reviendrait à n'avoir aucun journal.
	const render = (html) => {
		modal.innerHTML = html + authLogHtml();
		const copy = modal.querySelector('#a-log-copy');
		if (copy) {
			copy.addEventListener('click', async () => {
				await window.api.clipboard.write(authLogLines.join('\n'));
				toast('Journal copié');
			});
		}
	};
	render('<h2>Authenticator Steam</h2><p class="modal-sub">Connexion…</p>');
	const busy = (btn, on, label) => {
		if (!btn) return;
		btn.disabled = on;
		if (label && on) { btn.dataset.idle = btn.textContent; btn.textContent = label; }
		if (!on && btn.dataset.idle) btn.textContent = btn.dataset.idle;
	};

	// ── écran final ──
	const done = (message) => {
		authFlowActive = false;
		render(`<h2>Terminé</h2><p class="modal-sub">${sub}</p>
			<p class="modal-ok">${esc(message)}</p>
			<div class="modal-actions"><button class="btn btn-primary" data-close>Fermer</button></div>`);
		reloadAccounts();
	};

	// ── étape 5 : code SMS → finalisation ──
	const stepSms = (phoneHint) => {
		render(`<h2>Code de confirmation</h2><p class="modal-sub">${sub}</p>
			<p class="field hint">Steam a envoyé un SMS${phoneHint ? ` au numéro se terminant par <strong>${esc(phoneHint)}</strong>` : ''}.</p>
			<div class="field"><label>Code reçu par SMS</label><input id="a-sms" autocomplete="off" spellcheck="false" /></div>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="a-go">Activer</button></div>`);
		const go = modal.querySelector('#a-go');
		go.addEventListener('click', async () => {
			const code = modal.querySelector('#a-sms').value.trim();
			if (!code) return modalError(modal, 'Saisis le code reçu par SMS.');
			busy(go, true, 'Activation…');
			try {
				await call(window.api.auth2fa.finalize(code));
				done('Authenticator actif. L\'app génère maintenant les codes Steam Guard de ce compte.');
			} catch (err) {
				busy(go, false);
				modalError(modal, err.message);
			}
		});
		modal.querySelector('#a-sms').focus();
	};

	// ── étape 4 : code de révocation, à noter impérativement ──
	const stepRevocation = (info) => {
		render(`<h2>Note ce code</h2><p class="modal-sub">${sub}</p>
			<div class="cooldown-box permanent" style="text-align:center">
				<div class="cooldown-timer" style="font-size:26px;letter-spacing:3px;color:var(--text)">${esc(info.revocationCode)}</div>
				<div class="cooldown-reason">code de révocation</div>
			</div>
			<p class="field hint">C'est la <strong>seule</strong> façon de reprendre le compte si tu perds le secret.
			Steam ne le réaffichera jamais. Il est déjà enregistré chiffré dans le coffre,
			mais note-le aussi ailleurs : si tu perds le mot de passe maître, tout part avec.</p>
			<label class="checkbox"><input type="checkbox" id="a-ack" /> J'ai noté le code de révocation</label>
			<div class="modal-actions">
				<button class="btn" id="a-copy">Copier</button>
				<button class="btn btn-primary" id="a-next" disabled>Continuer</button>
			</div>`);
		const next = modal.querySelector('#a-next');
		modal.querySelector('#a-ack').addEventListener('change', (e) => { next.disabled = !e.target.checked; });
		modal.querySelector('#a-copy').addEventListener('click', async () => {
			await window.api.clipboard.write(info.revocationCode);
			toast('Code de révocation copié');
		});
		next.addEventListener('click', () => stepSms(info.phoneHint));
	};

	// ── étape 3b : retrait de l'authenticator existant ──
	const stepRemove = () => {
		const attempts = null;
		render(`<h2>Retirer l'authenticator</h2><p class="modal-sub">${sub}</p>
			<div class="cooldown-box permanent">
				<div style="font-weight:600;color:var(--danger)">15 jours de restriction</div>
				<div class="cooldown-reason">Retirer un authenticator repasse le compte en Steam Guard e-mail.
				Steam bloque alors les échanges et la vente sur le marché pendant 15 jours.</div>
			</div>
			<p class="field hint">Il faut le code de révocation de l'authenticator <em>actuel</em>
			(il commence par R).${attempts != null ? ` Steam annonce <strong>${attempts}</strong> tentative(s) restante(s) — au-delà, le compte n'est plus récupérable sans passer par le support.` : ''}</p>
			<div class="field"><label>Code de révocation actuel</label><input id="a-rev" autocomplete="off" spellcheck="false" placeholder="RXXXXX" /></div>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-danger-ghost" id="a-go">Retirer</button></div>`);
		const go = modal.querySelector('#a-go');
		go.addEventListener('click', async () => {
			const code = modal.querySelector('#a-rev').value.trim();
			if (!code) return modalError(modal, 'Saisis le code de révocation.');
			busy(go, true, 'Retrait…');
			try {
				const res = await call(window.api.auth2fa.remove(code));
				done(`Authenticator retiré. Le compte est repassé en Steam Guard e-mail${
					res.attemptsLeft != null ? ` (${res.attemptsLeft} tentative(s) de révocation restantes)` : ''
				}. Les échanges sont bloqués 15 jours.`);
			} catch (err) {
				busy(go, false);
				modalError(modal, err.message);
			}
		});
	};

	// ── étape 3b : Steam dit qu'un authenticator existe déjà ──
	const stepAlreadyHas = (message) => {
		render(`<h2>Authenticator déjà présent</h2><p class="modal-sub">${sub}</p>
			<p class="field hint">${esc(message || "Steam refuse d'en créer un second.")}</p>
			<div class="alert danger">
				<div style="font-weight:700;color:var(--danger)">Le retrait coûte 15 jours d'échanges</div>
				<div class="alert-sub">Le compte repasse en Steam Guard e-mail, et Steam bloque
				échanges et marché pendant 15 jours. Si tu as encore accès aux codes actuels
				(appli mobile ou SDA), importer le .maFile existant est préférable.</div>
			</div>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-danger-ghost" id="a-rm">Retirer quand même</button></div>`);
		modal.querySelector('#a-rm').addEventListener('click', () => stepRemove());
	};

	// ── étape 3bis : un authenticator attend déjà sa finalisation ──
	// Le secret est au coffre depuis AddAuthenticator ; relancer une création
	// ferait répondre DuplicateRequest à Steam. On reprend donc au code SMS.
	const stepResume = () => {
		render(`<h2>Activation à terminer</h2><p class="modal-sub">${sub}</p>
			<p class="field hint">Un authenticator a déjà été créé pour ce compte mais n'a jamais
			été activé. Son secret et son code de révocation sont enregistrés dans le coffre.
			Il reste à saisir le code SMS pour l'activer.</p>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="a-go">Saisir le code SMS</button></div>`);
		modal.querySelector('#a-go').addEventListener('click', () => stepSms(null));
	};

	// ── étape 3 : demande de création ──
	const stepCreate = () => {
		render(`<h2>Créer l'authenticator</h2><p class="modal-sub">${sub}</p>
			<p class="field hint">Steam va générer le secret et envoyer un SMS de confirmation.
			Le compte doit avoir un <strong>numéro de téléphone rattaché et vérifié</strong>, sinon Steam refuse.
			S'il a déjà un authenticator, l'app préviendra avant toute action.</p>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="a-go">Créer</button></div>`);
		const go = modal.querySelector('#a-go');
		go.addEventListener('click', async () => {
			busy(go, true, 'Demande en cours…');
			try {
				const res = await call(window.api.auth2fa.add());
				// Steam signale un authenticator existant par un statut, pas par une
				// erreur : on bascule sur l'écran de retrait plutôt que d'alarmer.
				if (res.duplicate) return stepAlreadyHas(res.message);
				stepRevocation(res);
			} catch (err) {
				busy(go, false);
				modalError(modal, err.message);
				// Le seul correctif possible passe par le site Steam : l'ajout d'un
				// numéro demande une confirmation par e-mail, qu'aucune app ne peut
				// court-circuiter. On met donc le lien à portée de clic.
				if (/numéro de téléphone/i.test(err.message) && !modal.querySelector('#a-phone')) {
					const actions = modal.querySelector('.modal-actions');
					const link = document.createElement('button');
					link.className = 'btn';
					link.id = 'a-phone';
					link.textContent = 'Ouvrir la page téléphone Steam';
					link.addEventListener('click', () => window.api.openExternal('https://store.steampowered.com/phone/add'));
					actions.insertBefore(link, actions.firstChild);
				}
			}
		});
	};

	// ── étape 2 : Steam réclame un code de connexion ──
	const stepGuard = (outcome) => {
		const viaEmail = outcome.via === 'email';
		render(`<h2>Code de connexion</h2><p class="modal-sub">${sub}</p>
			<p class="field hint">${viaEmail
				? `Steam a envoyé un code par e-mail${outcome.domain ? ` (<strong>${esc(outcome.domain)}</strong>)` : ''}.`
				: 'Steam demande le code de l\'authenticator actuel de ce compte.'}</p>
			${outcome.lastCodeWrong ? '<p class="modal-error">Code refusé, réessaie.</p>' : ''}
			<div class="field"><label>Code</label><input id="a-guard" autocomplete="off" spellcheck="false" /></div>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="a-go">Valider</button></div>`);
		const go = modal.querySelector('#a-go');
		go.addEventListener('click', async () => {
			const code = modal.querySelector('#a-guard').value.trim();
			if (!code) return modalError(modal, 'Saisis le code.');
			busy(go, true, 'Vérification…');
			try {
				const res = await call(window.api.auth2fa.guardCode(code));
				if (res.state === 'needGuardCode') return stepGuard(res);
				if (account.authenticatorPending) return stepResume();
				stepCreate();
			} catch (err) {
				busy(go, false);
				modalError(modal, err.message);
			}
		});
		modal.querySelector('#a-guard').focus();
	};

	// ── étape 1 : connexion ──
	(async () => {
		try {
			const res = await call(window.api.auth2fa.begin(account.id));
			if (res.state === 'needGuardCode') return stepGuard(res);
			if (account.authenticatorPending) return stepResume();
			stepCreate();
		} catch (err) {
			authFlowActive = false;
			render(`<h2>Connexion impossible</h2><p class="modal-sub">${sub}</p>
				<p class="modal-error">${esc(err.message)}</p>
				<div class="modal-actions"><button class="btn" data-close>Fermer</button></div>`);
		}
	})();
}

/**
 * Sauvegarde et restauration du coffre.
 *
 * Le fichier produit est le coffre lui-même, recopié sans déchiffrement : même
 * blob AES-256-GCM, même sel scrypt. Il n'est donc pas plus sensible que le
 * coffre d'origine — mais il n'est pas moins sensible non plus, et l'interface
 * le dit plutôt que de laisser croire à un export anodin.
 */
function backupModal() {
	const modal = openModal(`<h2>Sauvegarde du coffre</h2>
		<p class="field hint">La sauvegarde est une copie du coffre <strong>déjà chiffré</strong> :
		rien n'est déchiffré au passage, et le fichier reste inutilisable sans le mot de passe
		maître (scrypt N=2¹⁷, AES-256-GCM). Garde-la hors de cette machine : c'est l'unique
		copie de tes codes de révocation.</p>
		<div class="modal-actions">
			<button class="btn" data-close>Fermer</button>
			<button class="btn" id="b-restore">Restaurer…</button>
			<button class="btn btn-primary" id="b-save">Sauvegarder…</button>
		</div>`);

	modal.querySelector('#b-save').addEventListener('click', async () => {
		const btn = modal.querySelector('#b-save');
		btn.disabled = true;
		try {
			const res = await call(window.api.vault.backup());
			if (res.canceled) { btn.disabled = false; return; }
			modal.innerHTML = `<h2>Sauvegarde écrite</h2>
				<p class="field hint">${esc(res.path)}</p>
				<div class="rows">
					<div class="row"><span class="row-label">Taille</span><span class="row-value">${res.bytes.toLocaleString('fr-FR')} octets</span></div>
					<div class="row"><span class="row-label">SHA-256</span><span class="row-value mono">${esc(res.sha256.slice(0, 32))}…</span></div>
				</div>
				<p class="field hint">Empreinte vérifiée après écriture : la copie est identique à l'original.</p>
				<div class="modal-actions"><button class="btn btn-primary" data-close>Fermer</button></div>`;
		} catch (err) {
			btn.disabled = false;
			modalError(modal, err.message);
		}
	});

	modal.querySelector('#b-restore').addEventListener('click', async () => {
		const file = await window.api.vault.pickBackup();
		if (!file) return;
		modal.innerHTML = `<h2>Restaurer le coffre</h2>
			<p class="field hint">${esc(file)}</p>
			<div class="alert danger">
				<div style="font-weight:700;color:var(--danger)">Le coffre actuel sera remplacé</div>
				<div class="alert-sub">Il est d'abord copié à côté sous <code>.bak</code>, donc l'opération
				reste réversible. Le mot de passe est vérifié avant tout remplacement.</div>
			</div>
			<div class="field"><label>Mot de passe maître de la sauvegarde</label>
				<input type="password" id="b-pw" autocomplete="off" /></div>
			<div class="modal-actions"><button class="btn" data-close>Annuler</button>
			<button class="btn btn-danger-ghost" id="b-go">Restaurer</button></div>`;
		const go = modal.querySelector('#b-go');
		go.addEventListener('click', async () => {
			const pw = modal.querySelector('#b-pw').value;
			if (!pw) return modalError(modal, 'Saisis le mot de passe de la sauvegarde.');
			go.disabled = true;
			try {
				const res = await call(window.api.vault.restore(file, pw));
				modal.innerHTML = `<h2>Coffre restauré</h2>
					<p class="modal-ok">${res.accounts} compte(s) retrouvé(s).</p>
					${res.previous ? `<p class="field hint">Ancien coffre conservé : ${esc(res.previous)}</p>` : ''}
					<div class="modal-actions"><button class="btn btn-primary" data-close>Fermer</button></div>`;
				reloadAccounts();
			} catch (err) {
				go.disabled = false;
				modalError(modal, err.message);
			}
		});
		modal.querySelector('#b-pw').focus();
	});
}

/**
 * Confirmations mobiles : échanges et mises en vente en attente.
 *
 * La session Steam (client connecté + cookies web) reste ouverte côté main entre
 * la liste et la réponse, donc toute fermeture de la modale doit la libérer —
 * même règle que pour la création d'authenticator.
 */
let confFlowActive = false;

function confirmationsModal(account) {
	confFlowActive = true;
	const modal = openModal('<h2>Confirmations</h2><p class="modal-sub">Connexion…</p>');
	const sub = esc(account.label ? `${account.label} · ${account.username}` : account.username);
	let items = [];

	const render = (html) => { modal.innerHTML = html; };

	const fail = (message) => {
		confFlowActive = false;
		render(`<h2>Confirmations</h2><p class="modal-sub">${sub}</p>
			<p class="modal-error">${esc(message)}</p>
			<div class="modal-actions"><button class="btn" data-close>Fermer</button></div>`);
	};

	const picked = () => [...modal.querySelectorAll('.c-pick')]
		.filter((b) => b.checked)
		.map((b) => items[Number(b.dataset.i)]);

	const respond = async (accept) => {
		const sel = picked();
		if (!sel.length) return modalError(modal, 'Sélectionne au moins une confirmation.');
		modal.querySelectorAll('button').forEach((b) => { b.disabled = true; });
		try {
			const res = await call(window.api.conf.respond(sel, accept));
			items = res.confirmations;
			toast(`${res.done} confirmation(s) ${accept ? 'acceptée(s)' : 'refusée(s)'}`, 'ok');
			draw();
		} catch (err) {
			modal.querySelectorAll('button').forEach((b) => { b.disabled = false; });
			modalError(modal, err.message);
		}
	};

	function wire() {
		const refresh = modal.querySelector('#c-refresh');
		if (refresh) {
			refresh.addEventListener('click', async () => {
				refresh.disabled = true;
				try {
					items = await call(window.api.conf.list());
					draw();
				} catch (err) {
					modalError(modal, err.message);
					refresh.disabled = false;
				}
			});
		}
		const accept = modal.querySelector('#c-accept');
		if (accept) accept.addEventListener('click', () => respond(true));
		const deny = modal.querySelector('#c-deny');
		if (deny) deny.addEventListener('click', () => respond(false));
	}

	function draw() {
		if (!items.length) {
			render(`<h2>Confirmations</h2><p class="modal-sub">${sub}</p>
				<p class="field hint">Aucune confirmation en attente.</p>
				<div class="modal-actions">
					<button class="btn" id="c-refresh">Rafraîchir</button>
					<button class="btn btn-primary" data-close>Fermer</button>
				</div>`);
			return wire();
		}
		render(`<h2>Confirmations</h2><p class="modal-sub">${sub} — ${items.length} en attente</p>
			<div class="conf-list">${items.map((c, i) => `
				<div class="conf-item">
					<label class="checkbox" style="margin:0;align-items:flex-start">
						<input type="checkbox" class="c-pick" data-i="${i}" checked />
						<span>
							<strong>${esc(c.headline || c.typeLabel)}</strong>
							<span class="badge badge-unknown" style="margin-left:6px">${esc(c.typeLabel)}</span>
							<div class="conf-sum">${c.summary.map((x) => esc(x)).join('<br>')}</div>
							${c.warn ? `<div class="modal-error" style="margin:3px 0 0">${esc(c.warn)}</div>` : ''}
							<div class="conf-time">${c.createdAt ? fmtDate(c.createdAt) : ''}</div>
						</span>
					</label>
				</div>`).join('')}</div>
			<p class="field hint">Refuser <strong>annule définitivement</strong> l'échange ou la mise en vente côté Steam.</p>
			<div class="modal-actions">
				<button class="btn" id="c-refresh">Rafraîchir</button>
				<button class="btn btn-danger-ghost" id="c-deny">Refuser</button>
				<button class="btn btn-primary" id="c-accept">Confirmer</button>
				<button class="btn" data-close>Fermer</button>
			</div>`);
		wire();
	}

	(async () => {
		try {
			const res = await call(window.api.conf.open(account.id));
			items = res.confirmations;
			draw();
		} catch (err) {
			fail(err.message);
		}
	})();
}

/** Export de tous les comptes au format SDA (manifest.json + .maFile). */
function exportModal() {
	const modal = openModal(`
		<h2>Exporter au format SDA</h2>
		<p class="modal-sub">Écrit un dossier relisible par Steam Desktop Authenticator.</p>
		<div class="field">
			<label>Dossier de destination</label>
			<div style="display:flex;gap:6px">
				<input id="e-dir" readonly style="flex:1" placeholder="…" />
				<button class="btn" id="e-pick" type="button">Parcourir</button>
			</div>
		</div>
		<div class="field">
			<label>Mot de passe SDA (vide = fichiers en clair)</label>
			<input id="e-pwd" type="password" autocomplete="off" />
			<span class="hint">Même chiffrement que SDA : PBKDF2-SHA1 50 000 itérations + AES-256-CBC.
			Sans mot de passe, les <code>shared_secret</code> sont lisibles tels quels dans les fichiers.</span>
		</div>
		<div class="modal-actions">
			<button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="e-go" disabled>Exporter</button>
		</div>`);
	const dir = modal.querySelector('#e-dir');
	const go = modal.querySelector('#e-go');

	modal.querySelector('#e-pick').addEventListener('click', async () => {
		const chosen = await call(window.api.sda.pickExportFolder());
		if (chosen) { dir.value = chosen; go.disabled = false; }
	});

	go.addEventListener('click', async () => {
		go.disabled = true;
		try {
			const r = await call(window.api.sda.export(dir.value, modal.querySelector('#e-pwd').value));
			const skipped = r.skipped.length
				? `<p class="field hint">Écartés : ${r.skipped.map((x) => `${esc(x.username)} (${esc(x.reason)})`).join(', ')}</p>`
				: '';
			modal.innerHTML = `<h2>Export terminé</h2>
				<p class="modal-ok">${r.written.length} compte(s) écrit(s)${r.encrypted ? ', chiffrés' : ' EN CLAIR'}.</p>
				<p class="field hint" style="word-break:break-all"><code>${esc(r.dir)}</code></p>
				${skipped}
				<div class="modal-actions"><button class="btn btn-primary" data-close>Fermer</button></div>`;
		} catch (err) {
			go.disabled = false;
			modalError(modal, err.message);
		}
	});
}

/**
 * Ajout d'un compte, avec option d'enchaîner la création de l'authenticator.
 *
 * Deux usages distincts :
 *  - compte qui a déjà un .maFile → on colle le shared_secret (ou on importe le
 *    dossier SDA), rien d'autre ne se passe ;
 *  - compte tout neuf → on coche la case et le déroulé complet s'enchaîne sans
 *    repasser par le panneau de détail.
 */
function addAccountModal() {
	const modal = openModal(`
		<h2>Ajouter un compte</h2>
		<p class="modal-sub">Le shared_secret vient de ton .maFile ; sinon coche la case pour que l'app crée l'authenticator.</p>
		<div class="field"><label>Nom de compte Steam (login)</label><input id="f-username" autocomplete="off" /></div>
		<div class="field"><label>Mot de passe Steam</label><input id="f-password" type="password" autocomplete="off" /></div>

		<label class="checkbox"><input type="checkbox" id="f-auto" />
			Créer l'authenticator Steam dans la foulée</label>
		<p class="field hint" id="f-auto-hint" hidden>
			Enchaîne connexion → <code>AddAuthenticator</code> → code de révocation → code SMS →
			<code>FinalizeAddAuthenticator</code>. Le compte doit avoir un <strong>numéro de téléphone
			rattaché et vérifié</strong> côté Steam, sinon Steam refuse. S'il a déjà un authenticator,
			l'app préviendra avant toute action.
		</p>

		<div class="field" id="f-secret-field">
			<label>shared_secret (base64)</label>
			<input id="f-secret" autocomplete="off" spellcheck="false" />
		</div>
		<div class="field"><label>Libellé (optionnel)</label><input id="f-label" autocomplete="off" /></div>
		<div class="modal-actions">
			<button class="btn" data-close>Annuler</button>
			<button class="btn btn-primary" id="f-submit">Ajouter</button>
		</div>
	`);

	const auto = modal.querySelector('#f-auto');
	const secretField = modal.querySelector('#f-secret-field');
	const hint = modal.querySelector('#f-auto-hint');
	const submit = modal.querySelector('#f-submit');

	// Les deux chemins s'excluent : soit on fournit un secret existant, soit
	// Steam en génère un. Afficher les deux inviterait à les remplir en double.
	auto.addEventListener('change', () => {
		secretField.hidden = auto.checked;
		hint.hidden = !auto.checked;
		submit.textContent = auto.checked ? 'Ajouter et créer l\'authenticator' : 'Ajouter';
		if (auto.checked) modal.querySelector('#f-secret').value = '';
	});

	submit.addEventListener('click', async () => {
		const username = modal.querySelector('#f-username').value.trim();
		const password = modal.querySelector('#f-password').value;
		if (!username) return modalError(modal, 'Le nom de compte est obligatoire.');
		if (auto.checked && !password) {
			return modalError(modal, 'Le mot de passe est nécessaire pour créer l\'authenticator.');
		}
		submit.disabled = true;
		try {
			const acc = await call(window.api.accounts.upsert({
				username,
				password,
				sharedSecret: auto.checked ? '' : modal.querySelector('#f-secret').value.trim(),
				label: modal.querySelector('#f-label').value.trim()
			}));
			replaceAccount(acc);
			state.selectedId = acc.id;
			renderAll();

			if (auto.checked) {
				// Le compte est déjà dans le coffre : même si la création échoue
				// ensuite, rien n'est perdu et on peut relancer depuis le détail.
				toast('Compte ajouté — création de l\'authenticator…');
				return authenticatorModal(acc);
			}
			closeModal();
			toast('Compte ajouté', 'ok');
		} catch (err) {
			submit.disabled = false;
			modalError(modal, err.message);
		}
	});
}

function editAccountModal(a) {
	const modal = openModal(`
		<h2>Modifier ${esc(displayName(a))}</h2>
		<p class="modal-sub">Laisse un champ vide pour ne pas le changer.</p>
		<div class="field"><label>Libellé</label><input id="f-label" value="${esc(a.label)}" autocomplete="off" /></div>
		<div class="field"><label>Mot de passe Steam ${a.hasPassword ? '(déjà renseigné)' : '(manquant)'}</label>
			<div style="display:flex;gap:6px"><input id="f-password" type="password" autocomplete="off" style="flex:1" /><button class="btn btn-sm" id="f-reveal-pw" type="button">Voir l'actuel</button></div></div>
		<div class="field"><label>shared_secret ${a.hasSharedSecret ? '(déjà renseigné)' : '(manquant)'}</label>
			<div style="display:flex;gap:6px"><input id="f-secret" autocomplete="off" spellcheck="false" style="flex:1" /><button class="btn btn-sm" id="f-reveal-secret" type="button">Voir l'actuel</button></div></div>
		<div class="field"><label>SteamID64</label><input id="f-steamid" value="${esc(a.steamId)}" autocomplete="off" /></div>
		<div class="checkbox"><input type="checkbox" id="f-forget" ${a.hasRefreshToken ? '' : 'disabled'} /><label for="f-forget">Oublier le refresh token (forcer un login par mot de passe au prochain scan)</label></div>
		<div class="modal-actions"><button class="btn" data-close>Annuler</button><button class="btn btn-primary" id="f-submit">Enregistrer</button></div>
	`);
	modal.querySelector('#f-reveal-pw').addEventListener('click', async () => {
		const pw = modal.querySelector('#f-password');
		pw.type = 'text';
		pw.value = await call(window.api.accounts.reveal(a.id, 'password'));
	});
	modal.querySelector('#f-reveal-secret').addEventListener('click', async () => {
		modal.querySelector('#f-secret').value = await call(window.api.accounts.reveal(a.id, 'sharedSecret'));
	});
	modal.querySelector('#f-submit').addEventListener('click', async () => {
		try {
			const patch = { label: modal.querySelector('#f-label').value.trim(), steamId: modal.querySelector('#f-steamid').value.trim() };
			const pw = modal.querySelector('#f-password').value;
			const secret = modal.querySelector('#f-secret').value.trim();
			if (pw) patch.password = pw;
			if (secret) patch.sharedSecret = secret;
			let acc = await call(window.api.accounts.patch(a.id, patch));
			if (modal.querySelector('#f-forget').checked) {
				await call(window.api.accounts.forgetToken(a.id));
				acc = (await call(window.api.accounts.list())).find((x) => x.id === a.id) || acc;
			}
			replaceAccount(acc);
			closeModal();
			renderAll();
			toast('Compte mis à jour', 'ok');
		} catch (err) {
			modalError(modal, err.message);
		}
	});
}

function confirmRemoveModal(a) {
	const modal = openModal(`
		<h2>Supprimer ${esc(displayName(a))} ?</h2>
		<p class="modal-sub">Le compte, son mot de passe, son shared_secret et son refresh token sont retirés du coffre. Le .maFile d'origine n'est pas touché.</p>
		<div class="modal-actions"><button class="btn" data-close>Annuler</button><button class="btn btn-danger-ghost" id="f-submit">Supprimer</button></div>
	`);
	modal.querySelector('#f-submit').addEventListener('click', async () => {
		await call(window.api.accounts.remove(a.id));
		state.selectedId = null;
		closeModal();
		await reloadAccounts();
	});
}

/**
 * Suppression de tous les comptes. Irréversible et sans valeur de secours : on
 * exige de taper le nombre de comptes, pas juste un clic sur « OK ».
 */
function confirmRemoveAllModal() {
	const n = state.accounts.length;
	const modal = openModal(`
		<h2>Supprimer les ${n} comptes ?</h2>
		<p class="modal-sub">Mots de passe, shared_secret, codes de révocation et refresh tokens partent avec. Rien n'est récupérable ensuite.</p>
		<div class="alert danger" style="margin-top:0">
			<div class="alert-sub">Si un compte n'a son <code>shared_secret</code> que dans ce coffre, tu perds l'accès à son Steam Guard.
			Les <code>.maFile</code> d'origine, eux, ne sont pas touchés.</div>
		</div>
		<div class="field" style="margin-top:12px">
			<label>Tape <strong>${n}</strong> pour confirmer</label>
			<input id="f-count" autocomplete="off" inputmode="numeric" />
		</div>
		<div class="modal-actions"><button class="btn" data-close>Annuler</button>
		<button class="btn btn-danger-ghost" id="f-submit" disabled>Tout supprimer</button></div>
	`);
	const submit = modal.querySelector('#f-submit');
	modal.querySelector('#f-count').addEventListener('input', (e) => {
		submit.disabled = e.target.value.trim() !== String(n);
	});
	submit.addEventListener('click', async () => {
		submit.disabled = true;
		for (const a of [...state.accounts]) await call(window.api.accounts.remove(a.id));
		state.selectedId = null;
		closeModal();
		await reloadAccounts();
		toast(`${n} compte(s) supprimé(s)`);
	});
}

function importModal() {
	const modal = openModal(`
		<h2>Importer depuis SDA</h2>
		<p class="modal-sub">Choisis le dossier <code>maFiles</code> (celui qui contient manifest.json). Les comptes déjà présents sont fusionnés, pas dupliqués.</p>
		<div class="field"><label>Dossier maFiles</label>
			<div style="display:flex;gap:6px"><input id="f-dir" readonly style="flex:1" placeholder="…" /><button class="btn" id="f-pick" type="button">Parcourir</button></div>
			<div class="hint" id="f-info"></div></div>
		<div class="field" id="f-pw-field" hidden><label>Mot de passe SDA</label><input id="f-sda-password" type="password" autocomplete="off" /><div class="hint">Utilisé uniquement pour déchiffrer les .maFile en mémoire ; il n'est pas conservé.</div></div>
		<div class="modal-actions">
			<button class="btn" id="f-json" type="button" title="Reprendre un accounts.json de test">Importer un JSON…</button>
			<span style="flex:1"></span>
			<button class="btn" data-close>Annuler</button><button class="btn btn-primary" id="f-submit" disabled>Importer</button></div>
	`);
	let dir = null;
	let encrypted = false;
	modal.querySelector('#f-pick').addEventListener('click', async () => {
		dir = await call(window.api.sda.pickFolder());
		if (!dir) return;
		modal.querySelector('#f-dir').value = dir;
		try {
			const info = await call(window.api.sda.inspect(dir));
			encrypted = info.encrypted;
			modal.querySelector('#f-info').textContent = `${info.count} fichier(s) · ${encrypted ? 'chiffrés (mot de passe SDA requis)' : 'non chiffrés'}`;
			modal.querySelector('#f-pw-field').hidden = !encrypted;
			modal.querySelector('#f-submit').disabled = false;
			if (encrypted) modal.querySelector('#f-sda-password').focus();
		} catch (err) {
			modalError(modal, err.message);
		}
	});
	modal.querySelector('#f-submit').addEventListener('click', async () => {
		try {
			const pw = encrypted ? modal.querySelector('#f-sda-password').value : null;
			const { imported, failures } = await call(window.api.sda.import(dir, pw));
			closeModal();
			await reloadAccounts();
			const missing = imported.filter((a) => !a.hasPassword).length;
			toast(`${imported.length} compte(s) importé(s)${failures.length ? `, ${failures.length} échec(s)` : ''}${missing ? ` — ${missing} sans mot de passe Steam (à saisir via Modifier)` : ''}`, failures.length ? 'error' : 'ok');
		} catch (err) {
			modalError(modal, err.message);
		}
	});
	modal.querySelector('#f-json').addEventListener('click', async () => {
		const file = await call(window.api.json.pick());
		if (!file) return;
		try {
			const { imported } = await call(window.api.json.import(file));
			await reloadAccounts();
			// Le fichier source contient mots de passe et shared_secret en clair.
			// Maintenant qu'ils sont dans le coffre chiffré, il n'a plus de raison
			// d'exister : on propose de l'effacer plutôt que de le laisser traîner.
			shredOfferModal(file, imported.length);
		} catch (err) {
			modalError(modal, err.message);
		}
	});
}

/** Proposition d'effacement du JSON source après import. */
function shredOfferModal(file, count) {
	const modal = openModal(`
		<h2>Import terminé</h2>
		<p class="modal-sub">${count} compte(s) ajouté(s) au coffre chiffré.</p>
		<div class="cooldown-box permanent">
			<div style="font-weight:600;color:var(--danger)">Le fichier source est en clair</div>
			<div class="cooldown-reason">Mots de passe Steam et <code>shared_secret</code> y sont lisibles
			par n'importe quel programme ou sauvegarde. Le coffre chiffré les remplace désormais.</div>
		</div>
		<p class="field hint" style="word-break:break-all"><code>${esc(file)}</code></p>
		<div class="modal-actions">
			<button class="btn" data-close>Garder le fichier</button>
			<button class="btn btn-danger-ghost" id="f-shred">Écraser et supprimer</button>
		</div>`);
	modal.querySelector('#f-shred').addEventListener('click', async () => {
		try {
			await call(window.api.json.shred(file));
			closeModal();
			toast('Fichier écrasé puis supprimé', 'ok');
		} catch (err) {
			modalError(modal, err.message);
		}
	});
}

function settingsModal() {
	const s = state.settings;
	const modal = openModal(`
		<h2>Réglages</h2>
		<p class="modal-sub">Les délais protègent du rate limit Steam. Le login par mot de passe est le plus sensible ; le login par refresh token quasi pas.</p>
		<div class="field-row">
			<div class="field"><label>Délai entre logins par mot de passe (s)</label><input id="s-cred" type="number" min="5" value="${Math.round(s.credentialDelayMs / 1000)}" /></div>
			<div class="field"><label>Délai entre logins par token (s)</label><input id="s-tok" type="number" min="1" value="${Math.round(s.tokenDelayMs / 1000)}" /></div>
		</div>
		<div class="field-row">
			<div class="field"><label>Timeout login (s)</label><input id="s-login" type="number" min="10" value="${Math.round(s.loginTimeoutMs / 1000)}" /></div>
			<div class="field"><label>Timeout Game Coordinator (s)</label><input id="s-gc" type="number" min="10" value="${Math.round(s.gcTimeoutMs / 1000)}" /></div>
		</div>
		<div class="field"><label>Scan considéré périmé après (h)</label><input id="s-stale" type="number" min="1" value="${Math.round(s.staleAfterMs / 3600000)}" /></div>
		<div class="checkbox"><input type="checkbox" id="s-offline" ${s.offlinePersona ? 'checked' : ''} /><label for="s-offline">Se connecter en invisible pendant le scan</label></div>
		<div class="checkbox"><input type="checkbox" id="s-recent" ${s.fetchRecentGames ? 'checked' : ''} /><label for="s-recent">Demander l'historique des parties au GC (dernière partie)</label></div>
		<div class="field"><label>Mode de lancement Steam</label>
			<select id="s-launch">
				<option value="auto" ${s.launchMode === 'auto' ? 'selected' : ''}>Auto : session mémorisée si possible, sinon mot de passe</option>
				<option value="autologin" ${s.launchMode === 'autologin' ? 'selected' : ''}>Toujours session mémorisée (registre + loginusers.vdf)</option>
				<option value="password" ${s.launchMode === 'password' ? 'selected' : ''}>Toujours mot de passe (steam.exe -login)</option>
			</select></div>
		<div class="field"><label>Chemin de steam.exe (vide = détection via le registre)</label><input id="s-steam" value="${esc(s.steamPath || '')}" placeholder="e:\\steam\\steam.exe" /></div>
		<hr style="border:0;border-top:1px solid var(--line);margin:16px 0" />
		<h2 style="font-size:14px">Mot de passe maître</h2>
		<div class="field-row">
			<div class="field"><label>Actuel</label><input id="s-old" type="password" autocomplete="off" /></div>
			<div class="field"><label>Nouveau (8+ caractères)</label><input id="s-new" type="password" autocomplete="off" /></div>
		</div>
		<div class="modal-actions"><button class="btn" data-close>Fermer</button><button class="btn btn-primary" id="f-submit">Enregistrer</button></div>
	`);
	modal.querySelector('#f-submit').addEventListener('click', async () => {
		try {
			const num = (id, mult) => Math.max(0, Number(modal.querySelector(id).value) || 0) * mult;
			state.settings = await call(window.api.settings.set({
				credentialDelayMs: num('#s-cred', 1000),
				tokenDelayMs: num('#s-tok', 1000),
				loginTimeoutMs: num('#s-login', 1000),
				gcTimeoutMs: num('#s-gc', 1000),
				staleAfterMs: num('#s-stale', 3600000),
				offlinePersona: modal.querySelector('#s-offline').checked,
				fetchRecentGames: modal.querySelector('#s-recent').checked,
				launchMode: modal.querySelector('#s-launch').value,
				steamPath: modal.querySelector('#s-steam').value.trim() || null
			}));
			const oldPw = modal.querySelector('#s-old').value;
			const newPw = modal.querySelector('#s-new').value;
			if (oldPw || newPw) {
				await call(window.api.vault.changePassword(oldPw, newPw));
				toast('Réglages et mot de passe maître enregistrés', 'ok');
			} else {
				toast('Réglages enregistrés', 'ok');
			}
			closeModal();
		} catch (err) {
			modalError(modal, err.message);
		}
	});
}

// ───────────────────────── événements ─────────────────────────

function bindEvents() {
	$('#categories').addEventListener('click', (e) => {
		const cat = e.target.closest('.cat');
		if (!cat) return;
		state.category = cat.dataset.cat;
		renderCategories();
		renderList();
	});

	$('#account-list').addEventListener('click', (e) => {
		// Repli / dépli d'un groupe de l'arborescence
		const head = e.target.closest('[data-group]');
		if (head) {
			if (!state.collapsed) state.collapsed = new Set();
			const key = head.dataset.group;
			if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
			renderList();
			return;
		}
		const row = e.target.closest('.tree-item');
		if (!row) return;
		state.selectedId = row.dataset.id;
		state.totp = null;
		renderList();
		renderDetail();
	});

	$('#account-list').addEventListener('dblclick', (e) => {
		const row = e.target.closest('.tree-item');
		if (row) launchAccount(row.dataset.id);
	});

	$('#btn-remove-all').addEventListener('click', () => {
		if (!state.accounts.length) return toast('Aucun compte');
		confirmRemoveAllModal();
	});

	$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
	$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

	$('#detail-pane').addEventListener('click', async (e) => {
		const a = state.accounts.find((x) => x.id === state.selectedId);
		if (!a) return;
		const ext = e.target.closest('[data-ext]');
		if (ext) { e.preventDefault(); window.api.openExternal(ext.dataset.ext); return; }
		const copy = e.target.closest('[data-copy]');
		if (copy && copy.dataset.copy) { await window.api.clipboard.write(copy.dataset.copy); toast('Copié'); return; }
		const btn = e.target.closest('[data-act]');
		if (!btn) return;
		switch (btn.dataset.act) {
			case 'launch': launchAccount(a.id); break;
			case 'scan': startScan([a.id]); break;
			case 'edit': editAccountModal(a); break;
			case 'remove': confirmRemoveModal(a); break;
			case 'copy-code':
				if (state.totp && state.totp.id === a.id) { await window.api.clipboard.write(state.totp.code); toast(`Code ${state.totp.code} copié`, 'ok'); }
				break;
			case 'confirmations': confirmationsModal(a); break;
			case 'authenticator': authenticatorModal(a); break;
			case 'drop-secret':
				await call(window.api.accounts.patch(a.id, { sharedSecret: '', identitySecret: '' }));
				await reloadAccounts();
				toast('Secret invalide effacé');
				break;
			case 'reveal-revocation': {
				const code = await call(window.api.accounts.reveal(a.id, 'revocationCode'));
				openModal(`<h2>Code de révocation</h2><p class="modal-sub">${esc(a.username)}</p>
					<div class="cooldown-box permanent" style="text-align:center">
						<div class="cooldown-timer" style="font-size:26px;letter-spacing:3px;color:var(--text)">${esc(code)}</div>
					</div>
					<p class="field hint">Seule porte de secours si tu perds le secret. Steam ne le réaffiche jamais.</p>
					<div class="modal-actions"><button class="btn btn-primary" data-close>Fermer</button></div>`);
				break;
			}
		}
	});

	// La note s'enregistre toute seule quand on quitte le champ.
	$('#detail-pane').addEventListener('focusout', async (e) => {
		if (e.target.id !== 'note-input') return;
		const a = state.accounts.find((x) => x.id === state.selectedId);
		if (!a || e.target.value === a.note) return;
		replaceAccount(await call(window.api.accounts.patch(a.id, { note: e.target.value })));
		renderList();
	});

	// Attention : une liste vide signifie « tous » côté main. Il faut donc
	// court-circuiter quand le filtrage ne laisse plus rien, sinon on relancerait
	// justement les comptes qu'on vient d'exclure.
	$('#btn-scan-all').addEventListener('click', () => {
		const ids = state.accounts.filter(scannable).map((a) => a.id);
		const skipped = state.accounts.length - ids.length;
		if (!ids.length) {
			return toast(skipped ? `${skipped} compte(s) en cooldown, rien d'autre à scanner` : 'Aucun compte');
		}
		startScan(ids);
		if (skipped) toast(`${skipped} compte(s) en cooldown ignoré(s)`);
	});
	$('#btn-scan-stale').addEventListener('click', () => {
		const limit = Date.now() - (state.settings.staleAfterMs || 0);
		const stale = state.accounts.filter((a) => !a.lastScanAt || a.lastScanAt < limit);
		const ids = stale.filter(scannable).map((a) => a.id);
		const skipped = stale.length - ids.length;
		if (!ids.length) {
			return toast(skipped ? `${skipped} compte(s) périmé(s) mais en cooldown` : 'Aucun compte périmé');
		}
		startScan(ids);
		if (skipped) toast(`${skipped} compte(s) en cooldown ignoré(s)`);
	});
	$('#btn-scan-stop').addEventListener('click', async () => { await window.api.scan.stop(); toast('File de scan arrêtée'); });
	$('#btn-export').addEventListener('click', exportModal);
	$('#btn-backup').addEventListener('click', backupModal);
	$('#btn-add').addEventListener('click', addAccountModal);
	$('#btn-import').addEventListener('click', importModal);
	$('#btn-settings').addEventListener('click', settingsModal);
	$('#btn-lock').addEventListener('click', async () => {
		await window.api.vault.lock();
		state.accounts = [];
		state.selectedId = null;
		$('#app').hidden = true;
		$('#lockscreen').hidden = false;
		$('#master-password').value = '';
		$('#master-password').focus();
	});

	$('#modal-root').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

	// Événements du moteur
	window.api.on('progress', (p) => {
		state.progress[p.accountId] = p.message;
		const a = state.accounts.find((x) => x.id === p.accountId);
		$('#status-text').textContent = `${a ? displayName(a) : '?'} : ${p.message}`;
		if (p.accountId === state.selectedId) renderDetail();
		renderList();
	});
	window.api.on('queue', (q) => { state.queue = q; renderList(); renderStatus(); });
	window.api.on('result', (r) => {
		delete state.progress[r.accountId];
		if (r.account) replaceAccount(r.account);
		renderAll();
		const name = r.account ? displayName(r.account) : '';
		if (!r.ok) toast(`${name} : ${r.error.message}`, 'error');
		else $('#status-text').textContent = `${name} scanné.`;
	});
	window.api.on('ratelimit', (r) => {
		toast(`Rate limit Steam — pause jusqu'à ${fmtDate(r.until)}. N'insiste pas, ça empire.`, 'error');
	});
	window.api.on('log', (l) => { $('#status-text').textContent = l.message; });
	window.api.on('auth2fa', (p) => { if (authFlowActive) appendAuthLog(p.message); });
	installRankFallback();
	window.api.on('idle', () => { $('#status-text').textContent = 'File de scan terminée.'; });
}

// ───────────────────────── démarrage / coffre ─────────────────────────

async function enterApp() {
	state.settings = await call(window.api.settings.get());
	$('#lockscreen').hidden = true;
	$('#app').hidden = false;
	await reloadAccounts();
	state.queue = await call(window.api.scan.status());
	renderStatus();
}

async function boot() {
	const status = await call(window.api.vault.status());
	state.categories = status.categories;
	state.skillGroups = status.skillGroups || [];
	state.maxPenaltySeconds = status.maxPenaltySeconds || 0;
	state.penaltyReasons = status.penaltyReasons || {};
	state.TRANSIENT = new Set(status.transientErrorKinds || []);
	const creating = !status.exists;
	$('#lock-sub').textContent = creating
		? 'Premier lancement : choisis un mot de passe maître. Il chiffre tous les secrets.'
		: 'Déverrouille le coffre pour continuer.';
	$('#master-password-confirm').hidden = !creating;
	$('#lock-submit').textContent = creating ? 'Créer le coffre' : 'Déverrouiller';

	$('#lock-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const pw = $('#master-password').value;
		const errEl = $('#lock-error');
		errEl.hidden = true;
		try {
			if (creating) {
				if (pw !== $('#master-password-confirm').value) throw new Error('Les deux mots de passe diffèrent');
				await call(window.api.vault.create(pw));
			} else {
				await call(window.api.vault.unlock(pw));
			}
			$('#master-password').value = '';
			$('#master-password-confirm').value = '';
			await enterApp();
		} catch (err) {
			errEl.textContent = err.message;
			errEl.hidden = false;
			$('#master-password').select();
		}
	});

	bindEvents();
	$('#master-password').focus();
}

boot().catch((err) => {
	document.body.innerHTML = `<pre style="padding:20px;color:#ef5f5f">Erreur au démarrage : ${esc(err.message)}</pre>`;
});
