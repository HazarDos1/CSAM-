'use strict';
/**
 * Extrait les écussons de rang depuis l'installation locale de CS2.
 *
 *   node tools/extract-ranks.js [chemin/vers/pak01_dir.vpk]
 *
 * Deux familles, deux formats :
 *
 * - Groupes de skill compétitifs : `skillgroup0..18.vsvg_c`, des SVG compilés
 *   Source 2. Le SVG y est en texte clair derrière un court préfixe binaire :
 *   on le découpe, et on obtient un vecteur net à toute taille.
 *
 * - Médailles de niveau 1 à 40 : `levelN_png.vtex_c`. Leur format interne est
 *   `PNG_RGBA8888` (16), c'est-à-dire un PNG littéral encapsulé — aucun
 *   décodeur de texture compressée n'est nécessaire, il suffit de retrouver la
 *   signature PNG et de couper après le bloc IEND.
 *
 * Les fichiers produits restent sur cette machine : ce sont les ressources du
 * jeu déjà installé, relues, pas une copie redistribuée.
 */
const fs = require('fs');
const path = require('path');
const { readDir, readFile } = require('./vpk.js');

const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'ranks');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from('IEND');

/** Bloc DATA d'une ressource compilée Source 2 (en-tête version 12). */
function dataBlock(buf) {
	const headerVersion = buf.readUInt16LE(4);
	if (headerVersion !== 12) throw new Error(`En-tête de ressource inattendu : ${headerVersion}`);
	const blockOffset = buf.readUInt32LE(8);
	const blockCount = buf.readUInt32LE(12);
	let pos = 8 + blockOffset;
	for (let i = 0; i < blockCount; i++) {
		const type = buf.toString('ascii', pos, pos + 4);
		const offset = buf.readUInt32LE(pos + 4);
		const size = buf.readUInt32LE(pos + 8);
		if (type === 'DATA') return buf.subarray(pos + 4 + offset, pos + 4 + offset + size);
		pos += 12;
	}
	throw new Error('Pas de bloc DATA dans la ressource');
}

function svgFrom(buf) {
	const data = dataBlock(buf);
	const start = data.indexOf('<?xml') >= 0 ? data.indexOf('<?xml') : data.indexOf('<svg');
	if (start < 0) throw new Error('Aucun SVG dans le bloc DATA');
	// Le bloc peut être complété par des zéros : on s'arrête à la fin du SVG.
	const close = data.lastIndexOf('</svg>');
	if (close < 0) throw new Error('SVG tronqué');
	return data.subarray(start, close + 6).toString('utf8');
}

function pngFrom(buf) {
	// Le bloc DATA ne porte que l'en-tête de texture (taille, format, et une
	// vignette de repli de 1 Ko). Les octets de l'image sont APPENDUS après la
	// structure de ressource, à partir de l'offset annoncé par `fileSize`.
	const start = buf.indexOf(PNG_MAGIC, buf.readUInt32LE(0));
	if (start < 0) throw new Error('Aucun PNG après la structure (texture compressée ?)');
	const iend = buf.indexOf(IEND, start);
	if (iend < 0) throw new Error('PNG tronqué');
	return buf.subarray(start, iend + 8); // IEND et son CRC
}

/** Localise `pak01_dir.vpk` via le registre Steam puis les bibliothèques déclarées. */
function findPak() {
	const roots = new Set();
	try {
		const out = require('child_process').execFileSync('reg',
			['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' });
		const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
		if (m) roots.add(m[1].trim().replace(/\//g, path.sep));
	} catch (err) { /* pas de registre lisible : on tente les emplacements usuels */ }
	roots.add('C:\\Program Files (x86)\\Steam');

	const libs = new Set();
	for (const root of roots) {
		libs.add(root);
		const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
		if (!fs.existsSync(vdf)) continue;
		const text = fs.readFileSync(vdf, 'utf8');
		for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
	}

	for (const lib of libs) {
		const pak = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive',
			'game', 'csgo', 'pak01_dir.vpk');
		if (fs.existsSync(pak)) return pak;
	}
	return null;
}

function main() {
	const pak = process.argv[2] || findPak();
	if (!pak) {
		console.error('pak01_dir.vpk introuvable. Donne son chemin en argument :');
		console.error('  node tools/extract-ranks.js "C:\\\\...\\\\game\\\\csgo\\\\pak01_dir.vpk"');
		process.exit(1);
	}
	console.log(`VPK : ${pak}`);
	const vpk = readDir(pak);
	fs.mkdirSync(OUT_DIR, { recursive: true });

	let written = 0;
	const missing = [];
	const grab = (source, target, convert) => {
		if (!vpk.entries.has(source)) { missing.push(source); return; }
		try {
			fs.writeFileSync(path.join(OUT_DIR, target), convert(readFile(vpk, source)));
			written++;
		} catch (err) {
			missing.push(`${source} (${err.message})`);
		}
	};

	// Groupes de skill : 0 = non classé, 1 à 18 = Silver I à Global Elite.
	for (let i = 0; i <= 18; i++) {
		grab(`panorama/images/icons/skillgroups/skillgroup${i}.vsvg_c`, `skillgroup${i}.svg`, svgFrom);
	}
	for (const name of ['none', 'expired', 'need_wins']) {
		grab(`panorama/images/icons/skillgroups/skillgroup_${name}.vsvg_c`, `skillgroup_${name}.svg`, svgFrom);
	}
	// Médailles de profil, niveaux 1 à 40.
	for (let i = 1; i <= 40; i++) {
		grab(`panorama/images/icons/xp/level${i}_png.vtex_c`, `level${i}.png`, pngFrom);
	}

	console.log(`${written} fichier(s) écrits dans ${path.relative(process.cwd(), OUT_DIR)}`);
	if (missing.length) {
		console.log(`${missing.length} absent(s) du VPK :`);
		for (const m of missing.slice(0, 10)) console.log(`  ${m}`);
	}
}

if (require.main === module) main();
module.exports = { dataBlock, svgFrom, pngFrom, findPak };
