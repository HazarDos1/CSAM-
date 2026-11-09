'use strict';
/**
 * Pont entre le renderer et le processus principal. Surface volontairement
 * étroite : une fonction par opération, rien de générique, aucun accès à `require`.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
	vault: {
		backup: () => invoke('vault:backup'),
		pickBackup: () => invoke('vault:pickBackup'),
		restore: (file, password) => invoke('vault:restore', { file, password }),
		status: () => invoke('vault:status'),
		create: (password) => invoke('vault:create', password),
		unlock: (password) => invoke('vault:unlock', password),
		lock: () => invoke('vault:lock'),
		changePassword: (oldPassword, newPassword) => invoke('vault:changePassword', { oldPassword, newPassword })
	},
	accounts: {
		list: () => invoke('accounts:list'),
		upsert: (input) => invoke('accounts:upsert', input),
		patch: (id, patch) => invoke('accounts:patch', { id, patch }),
		remove: (id) => invoke('accounts:remove', id),
		reveal: (id, field) => invoke('accounts:reveal', { id, field }),
		forgetToken: (id) => invoke('accounts:forgetToken', id)
	},
	totp: {
		code: (id) => invoke('totp:code', id)
	},
	/** Création / retrait d'un authenticator Steam. Déroulé interactif en étapes. */
	auth2fa: {
		begin: (accountId) => invoke('auth2fa:begin', accountId),
		guardCode: (code) => invoke('auth2fa:guardCode', code),
		add: () => invoke('auth2fa:add'),
		finalize: (smsCode) => invoke('auth2fa:finalize', smsCode),
		remove: (revocationCode) => invoke('auth2fa:remove', revocationCode),
		cancel: () => invoke('auth2fa:cancel')
	},
	sda: {
		pickFolder: (title) => invoke('dialog:pickFolder', title),
		inspect: (dir) => invoke('sda:inspect', dir),
		import: (dir, password) => invoke('sda:import', { dir, password }),
		pickExportFolder: () => invoke('dialog:pickExportFolder'),
		export: (dir, password) => invoke('sda:export', { dir, password })
	},
	/** Confirmations mobiles : échanges et mises en vente. */
	conf: {
		open: (accountId) => invoke('conf:open', accountId),
		list: () => invoke('conf:list'),
		respond: (items, accept) => invoke('conf:respond', { items, accept }),
		close: () => invoke('conf:close')
	},
	json: {
		pick: () => invoke('dialog:pickJson'),
		import: (file) => invoke('import:json', file),
		shred: (file) => invoke('import:shred', file)
	},
	scan: {
		start: (ids, forceCredentials) => invoke('scan:start', { ids, forceCredentials }),
		stop: () => invoke('scan:stop'),
		status: () => invoke('scan:status')
	},
	launch: {
		account: (id, mode) => invoke('launch:account', { id, mode }),
		probe: () => invoke('launch:probe')
	},
	settings: {
		get: () => invoke('settings:get'),
		set: (patch) => invoke('settings:set', patch)
	},
	clipboard: {
		write: (text) => invoke('clipboard:write', text)
	},
	openExternal: (url) => invoke('shell:openExternal', url),

	/** Abonnement aux événements poussés par le moteur de scan. */
	on: (event, handler) => {
		const channels = {
			progress: 'scan:progress',
			result: 'scan:result',
			queue: 'scan:queue',
			ratelimit: 'scan:ratelimit',
			log: 'scan:log',
			idle: 'scan:idle',
			auth2fa: 'auth2fa:progress',
			conf: 'conf:progress'
		};
		const channel = channels[event];
		if (!channel) return () => {};
		const listener = (_e, payload) => handler(payload);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	}
});
