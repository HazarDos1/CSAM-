'use strict';
/**
 * Saisie automatique du code Steam Guard dans la fenêtre de connexion Steam.
 *
 * Pourquoi c'est nécessaire : `steam.exe` n'accepte pas de code 2FA en ligne de
 * commande. Il n'existe aucune option officielle. La seule façon de ne pas avoir
 * à le taper soi-même est de le frapper dans la fenêtre, au clavier.
 *
 * Quand c'est nécessaire : uniquement au **premier** login d'un compte sur la
 * machine. Ensuite Steam mémorise la session et ne redemande plus rien — c'est
 * le chemin 'autologin' du lanceur, qui ne passe pas par ici.
 *
 * Ce que ça ne fait pas : deviner l'instant exact où le champ apparaît. L'UI de
 * connexion est une page web (steamwebhelper) dont le titre ne change pas entre
 * l'écran mot de passe et l'écran Steam Guard, donc il n'y a rien à observer.
 * On attend un délai, puis on frappe. C'est au mieux une commodité, et le code
 * reste dans le presse-papier dans tous les cas.
 *
 * Garde-fou : on ne frappe **que** si la fenêtre au premier plan appartient à
 * steamwebhelper, vérifié juste avant l'envoi. Sans ça, un changement de fenêtre
 * mal tombé taperait le code dans une conversation ou une barre d'adresse.
 */
const { execFile } = require('child_process');

/**
 * Attend la fenêtre de connexion, la met au premier plan, vérifie qu'elle est
 * bien à Steam, puis frappe le code caractère par caractère.
 *
 * `$pid` est une variable automatique PowerShell et n'est pas assignable : d'où
 * `$procId`. Le code arrive par l'environnement et non par la ligne de commande,
 * pour qu'il n'apparaisse pas dans la liste des processus.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int procId);
}
"@
Start-Sleep -Milliseconds ([int]$env:CSAM_DELAY)
$deadline = (Get-Date).AddMilliseconds([int]$env:CSAM_TIMEOUT)
$win = $null
while ((Get-Date) -lt $deadline) {
  $win = Get-Process -Name $env:CSAM_PROC -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } |
         Select-Object -First 1
  if ($win) { break }
  Start-Sleep -Milliseconds 400
}
if (-not $win) { Write-Output 'NOWINDOW'; exit 0 }
[void][Fg]::SetForegroundWindow($win.MainWindowHandle)
Start-Sleep -Milliseconds 700
$fg = [Fg]::GetForegroundWindow()
$procId = 0
[void][Fg]::GetWindowThreadProcessId($fg, [ref]$procId)
$owner = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
if ($owner -ne $env:CSAM_PROC) { Write-Output "NOTFOCUSED:$owner"; exit 0 }
foreach ($ch in $env:CSAM_CODE.ToCharArray()) {
  [System.Windows.Forms.SendKeys]::SendWait($ch)
  Start-Sleep -Milliseconds 90
}
Write-Output 'SENT'
`;

/** Les codes Steam Guard n'utilisent que cet alphabet — rien que SendKeys interprète. */
const CODE_SHAPE = /^[0-9A-Z]{5}$/;

/**
 * @param {string} code code Steam Guard à 5 caractères
 * @param {object} opts {delayMs, timeoutMs}
 * @returns {Promise<{sent: boolean, reason: string}>} ne rejette jamais : un
 *   échec de frappe ne doit pas faire échouer le lancement, le code est dans le
 *   presse-papier.
 */
function typeGuardCode(code, opts = {}) {
	if (!CODE_SHAPE.test(String(code || ''))) {
		return Promise.resolve({ sent: false, reason: 'code inattendu' });
	}
	// `processName` n'existe que pour les tests : sans lui, verifier le chemin
	// d'echec exigerait qu'aucune fenetre Steam ne soit ouverte, et le test
	// taperait pour de vrai dans le Steam de la machine quand il y en a une.
	const processName = opts.processName || 'steamwebhelper';
	const delayMs = opts.delayMs == null ? 5000 : opts.delayMs;
	const timeoutMs = opts.timeoutMs == null ? 25000 : opts.timeoutMs;

	return new Promise((resolve) => {
		const child = execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
			{
				windowsHide: true,
				timeout: delayMs + timeoutMs + 15000,
				env: {
					...process.env,
					CSAM_CODE: code,
					CSAM_PROC: processName,
					CSAM_DELAY: String(delayMs),
					CSAM_TIMEOUT: String(timeoutMs)
				}
			},
			(err, stdout) => {
				const out = String(stdout || '').trim();
				if (out.endsWith('SENT')) return resolve({ sent: true, reason: 'saisi dans la fenêtre Steam' });
				if (out.includes('NOWINDOW')) {
					return resolve({ sent: false, reason: 'fenêtre de connexion Steam introuvable' });
				}
				const notFocused = out.match(/NOTFOCUSED:(\S*)/);
				if (notFocused) {
					return resolve({
						sent: false,
						reason: `une autre fenêtre avait le focus (${notFocused[1] || 'inconnue'}) — rien n'a été tapé`
					});
				}
				resolve({ sent: false, reason: err ? `échec de la saisie : ${err.message}` : 'échec de la saisie' });
			}
		);
		child.on('error', () => resolve({ sent: false, reason: 'PowerShell indisponible' }));
	});
}

module.exports = { typeGuardCode, CODE_SHAPE };
