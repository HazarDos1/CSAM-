'use strict';
/** Saisie en console, avec masquage pour les mots de passe. Aucune dépendance. */
const readline = require('readline');

function ask(question, { hidden = false } = {}) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (hidden) {
			// On neutralise l'écho : readline écrit la question une fois, puis plus rien.
			let shown = false;
			rl._writeToOutput = (chunk) => {
				if (!shown) {
					rl.output.write(question);
					shown = true;
				}
			};
		}
		rl.question(question, (answer) => {
			rl.close();
			if (hidden) process.stdout.write('\n');
			resolve(answer);
		});
	});
}

module.exports = { ask };
