'use strict';
/**
 * Génère l'icône de l'application : build/icon.ico.
 *
 *   node tools/make-icon.js
 *
 * Pourquoi la dessiner plutôt que d'embarquer une image : aucune dépendance
 * graphique n'est installée, et un .ico valide se compose à la main. Depuis
 * Vista, un ICO peut contenir directement un PNG — on encode donc un PNG RGBA
 * 256×256 (zlib suffit) et on l'enveloppe dans un conteneur ICO de 22 octets.
 *
 * Le motif reprend l'identité de l'interface : fond anthracite, liseré dégradé
 * arc-en-ciel en haut, écusson clair au centre.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // suréchantillonnage par axe, pour des bords lisses

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** @param {Buffer} rgba SIZE*SIZE*4 octets */
function encodePng(rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(SIZE, 0);
	ihdr.writeUInt32BE(SIZE, 4);
	ihdr[8] = 8;  // 8 bits par canal
	ihdr[9] = 6;  // RGBA
	// Chaque ligne est précédée de son octet de filtre (0 = aucun).
	const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
	for (let y = 0; y < SIZE; y++) {
		raw[y * (SIZE * 4 + 1)] = 0;
		rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// ---------------------------------------------------------------- dessin

/** Écusson, en coordonnées 0..1. Le bas est arrondi par une suite de points. */
const SHIELD = (() => {
	const pts = [[0.5, 0.17], [0.86, 0.30], [0.86, 0.55]];
	for (let i = 0; i <= 12; i++) {
		const t = i / 12;
		// Descente symétrique vers la pointe basse.
		pts.push([0.5 + (0.36 - 0.36 * t) * Math.cos(t * Math.PI / 2), 0.55 + 0.33 * Math.sin(t * Math.PI / 2)]);
	}
	for (let i = 12; i >= 0; i--) {
		const t = i / 12;
		pts.push([0.5 - (0.36 - 0.36 * t) * Math.cos(t * Math.PI / 2), 0.55 + 0.33 * Math.sin(t * Math.PI / 2)]);
	}
	pts.push([0.14, 0.55], [0.14, 0.30]);
	return pts;
})();

function inPolygon(x, y, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Dégradé arc-en-ciel du liseré, identique à celui de l'interface. */
const RAINBOW = [
	[0.00, [0x15, 0xd4, 0xe8]], [0.18, [0x2b, 0x7c, 0xf0]], [0.40, [0x8b, 0x35, 0xe8]],
	[0.58, [0xe0, 0x31, 0x9c]], [0.78, [0xff, 0x5a, 0x2b]], [1.00, [0xff, 0xd4, 0x00]]
];

function rainbowAt(t) {
	for (let i = 1; i < RAINBOW.length; i++) {
		if (t <= RAINBOW[i][0]) {
			const [t0, c0] = RAINBOW[i - 1];
			const [t1, c1] = RAINBOW[i];
			const k = (t - t0) / (t1 - t0);
			return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k));
		}
	}
	return RAINBOW[RAINBOW.length - 1][1];
}

/** Couleur d'un point, en coordonnées 0..1. @returns {[r,g,b,a]} */
function sample(x, y) {
	// Coins arrondis : hors du rayon, totalement transparent.
	const r = 0.12;
	const cx = Math.min(Math.max(x, r), 1 - r);
	const cy = Math.min(Math.max(y, r), 1 - r);
	if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];

	// Liseré dégradé en haut.
	if (y < 0.055) return [...rainbowAt(x), 255];

	// Fond anthracite, légèrement plus clair vers le haut.
	const base = Math.round(0x19 + (1 - y) * 18);
	let col = [base, base + 1, base + 4];

	// Écusson clair, avec un liseré plus vif.
	if (inPolygon(x, y, SHIELD)) {
		const inner = SHIELD.map(([px, py]) => [0.5 + (px - 0.5) * 0.86, 0.5 + (py - 0.5) * 0.86]);
		col = inPolygon(x, y, inner) ? [0x2a, 0x2c, 0x31] : [0xc9, 0xcc, 0xd2];
		// Disque central, comme le logo du rail.
		const d = (x - 0.5) ** 2 + (y - 0.47) ** 2;
		if (d < 0.015 && d > 0.008) col = [0xc9, 0xcc, 0xd2];
	}
	return [...col, 255];
}

function render() {
	const rgba = Buffer.alloc(SIZE * SIZE * 4);
	for (let py = 0; py < SIZE; py++) {
		for (let px = 0; px < SIZE; px++) {
			let acc = [0, 0, 0, 0];
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const c = sample((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE);
					for (let i = 0; i < 4; i++) acc[i] += c[i];
				}
			}
			const n = SS * SS;
			const o = (py * SIZE + px) * 4;
			for (let i = 0; i < 4; i++) rgba[o + i] = Math.round(acc[i] / n);
		}
	}
	return rgba;
}

// ---------------------------------------------------------------- ICO

function wrapIco(png) {
	const header = Buffer.alloc(22);
	header.writeUInt16LE(0, 0);      // réservé
	header.writeUInt16LE(1, 2);      // type 1 = icône
	header.writeUInt16LE(1, 4);      // une seule image
	header[6] = 0;                   // largeur 0 = 256
	header[7] = 0;                   // hauteur 0 = 256
	header[8] = 0;                   // palette : aucune
	header[9] = 0;                   // réservé
	header.writeUInt16LE(1, 10);     // plans
	header.writeUInt16LE(32, 12);    // bits par pixel
	header.writeUInt32LE(png.length, 14);
	header.writeUInt32LE(22, 18);    // décalage des données
	return Buffer.concat([header, png]);
}

function main() {
	const dir = path.join(__dirname, '..', 'build');
	fs.mkdirSync(dir, { recursive: true });
	const png = encodePng(render());
	fs.writeFileSync(path.join(dir, 'icon.png'), png);
	fs.writeFileSync(path.join(dir, 'icon.ico'), wrapIco(png));
	console.log(`icon.png ${png.length} octets · icon.ico ${png.length + 22} octets`);
}

if (require.main === module) main();
module.exports = { encodePng, wrapIco, render };
