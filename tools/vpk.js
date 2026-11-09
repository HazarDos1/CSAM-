'use strict';
/**
 * Lecture des archives VPK de Source 2, sans dépendance.
 *
 * Un `pak01_dir.vpk` contient l'index ; les octets vivent soit dans des archives
 * numérotées à côté (`pak01_042.vpk`), soit dans le fichier d'index lui-même
 * quand `archiveIndex` vaut 0x7fff.
 *
 * L'index est un arbre de chaînes terminées par zéro, imbriquées sur trois
 * niveaux : extension, puis répertoire, puis nom de fichier. Le répertoire d'un
 * fichier à la racine vaut littéralement un espace.
 */
const fs = require('fs');

const SIGNATURE = 0x55aa1234;
const IN_DIR_FILE = 0x7fff;

function cstring(buf, pos) {
	let end = pos;
	while (end < buf.length && buf[end] !== 0) end++;
	return { value: buf.toString('utf8', pos, end), next: end + 1 };
}

/**
 * @param {string} dirPath chemin d'un `*_dir.vpk`
 * @returns {{entries: Map<string, object>, headerSize: number, treeSize: number, version: number, dirPath: string}}
 */
function readDir(dirPath) {
	const buf = fs.readFileSync(dirPath);
	if (buf.length < 12 || buf.readUInt32LE(0) !== SIGNATURE) {
		throw new Error(`Signature VPK invalide : ${dirPath}`);
	}
	const version = buf.readUInt32LE(4);
	const treeSize = buf.readUInt32LE(8);
	const headerSize = version === 2 ? 28 : 12;

	const entries = new Map();
	let pos = headerSize;
	for (;;) {
		const ext = cstring(buf, pos); pos = ext.next;
		if (!ext.value) break;
		for (;;) {
			const dir = cstring(buf, pos); pos = dir.next;
			if (!dir.value) break;
			for (;;) {
				const name = cstring(buf, pos); pos = name.next;
				if (!name.value) break;
				pos += 4; // CRC
				const preloadBytes = buf.readUInt16LE(pos); pos += 2;
				const archiveIndex = buf.readUInt16LE(pos); pos += 2;
				const entryOffset = buf.readUInt32LE(pos); pos += 4;
				const entryLength = buf.readUInt32LE(pos); pos += 4;
				pos += 2; // terminateur 0xffff
				const preload = buf.subarray(pos, pos + preloadBytes); pos += preloadBytes;
				const full = (dir.value === ' ' ? '' : dir.value + '/') + name.value + '.' + ext.value;
				entries.set(full, { preload, archiveIndex, entryOffset, entryLength });
			}
		}
	}
	return { entries, headerSize, treeSize, version, dirPath };
}

/** Octets complets d'une entrée : préchargement éventuel suivi des données d'archive. */
function readFile(vpk, name) {
	const e = vpk.entries.get(name);
	if (!e) throw new Error(`Absent du VPK : ${name}`);
	if (!e.entryLength) return Buffer.from(e.preload);

	let source;
	let offset;
	if (e.archiveIndex === IN_DIR_FILE) {
		source = vpk.dirPath;
		offset = vpk.headerSize + vpk.treeSize + e.entryOffset;
	} else {
		const base = vpk.dirPath.replace(/_dir\.vpk$/i, '');
		source = `${base}_${String(e.archiveIndex).padStart(3, '0')}.vpk`;
		offset = e.entryOffset;
	}

	const fd = fs.openSync(source, 'r');
	try {
		const out = Buffer.alloc(e.entryLength);
		fs.readSync(fd, out, 0, e.entryLength, offset);
		return e.preload.length ? Buffer.concat([e.preload, out]) : out;
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = { readDir, readFile };
