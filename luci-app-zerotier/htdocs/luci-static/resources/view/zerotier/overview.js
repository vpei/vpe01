'use strict';
'require view';
'require fs';
'require dom';
'require ui';
'require poll';
'require rpc';

/*
 * ZeroTier control panel (Russian UI).
 *
 * Состояние:
 *   - procd/ubus "service" — запущена ли служба и включена ли в автозапуск;
 *   - `zerotier-cli -j ...` — живое состояние узла (info, listnetworks, listpeers);
 *   - `uci show zerotier` — конфиг на диске.
 *
 * Почему не JS-модуль uci: в этой сборке LuCI правки через rpcd складываются
 * в сессионную «дельту» и применяются только через uci.apply(), а apply()
 * дергает procd-триггер и перезапускает ZeroTier (с обрывом туннелей).
 * Поэтому читаем и пишем напрямую через /sbin/uci: конфиг на диске сразу
 * совпадает с тем, что видит панель, и демон не перезапускается.
 */

const CLI = '/usr/bin/zerotier-cli';
const INIT = '/etc/init.d/zerotier';
const UCI = '/sbin/uci';
const CONF = 'zerotier';

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

const NET_STATUS = {
	OK: 'good',
	REQUESTING_CONFIGURATION: 'warn',
	ACCESS_DENIED: 'bad',
	AUTHENTICATION_REQUIRED: 'bad',
	NOT_FOUND: 'bad',
	PORT_ERROR: 'bad',
	CLIENT_TOO_OLD: 'bad'
};

const FLAGS = [
	[ 'allow_managed', 'allowManaged', 'IP управляемой сети' ],
	[ 'allow_global', 'allowGlobal', 'Глобальные IP' ],
	[ 'allow_default', 'allowDefault', 'Маршрут по умолчанию' ],
	[ 'allow_dns', 'allowDNS', 'DNS' ]
];

const ACTION_NAMES = { start: 'запуск', stop: 'остановка', restart: 'перезапуск' };

/* ---------- запуск команд ---------- */

/* Любой зависший RPC не должен оставлять страницу на «Загрузка…». */
function withTimeout(promise, ms, fallback) {
	return Promise.race([
		Promise.resolve(promise).catch(function () { return fallback; }),
		new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, ms); })
	]);
}

function execOpts(cmd, args) {
	return fs.exec(cmd, args || []).catch(function (err) {
		return { code: -1, stdout: '', stderr: String((err && err.message) || err) };
	});
}

function cliJson(cmd, args) {
	return execOpts(CLI, [ '-j', cmd ].concat(args || [])).then(function (res) {
		var out = (res.stdout || '').trim();

		if (!out)
			return { ok: false, code: res.code, error: (res.stderr || '').trim(), data: null };

		try {
			return { ok: res.code === 0, code: res.code, error: '', data: JSON.parse(out) };
		}
		catch (e) {
			return { ok: false, code: res.code, error: out, data: null };
		}
	});
}

function cliRun(cmd, args) {
	return execOpts(CLI, [ cmd ].concat(args || [])).then(function (res) {
		res.message = ((res.stdout || '') + (res.stderr || '')).trim();
		res.ok = res.code === 0;
		return res;
	});
}

function uciRun(args) {
	return execOpts(UCI, args.map(String)).then(function (res) {
		if (res.code !== 0)
			throw new Error(((res.stderr || res.stdout) || 'uci завершился с ошибкой.').trim());

		return (res.stdout || '').trim();
	});
}

function uciSet(path, value) {
	return uciRun([ 'set', path + '=' + value ]);
}

function uciCommit() {
	return uciRun([ 'commit', CONF ]);
}

/* ---------- чтение конфига ---------- */

function unquote(value) {
	var v = String(value == null ? '' : value);

	if (v.length >= 2 && v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")
		v = v.substring(1, v.length - 1);

	return v;
}

function parseUciShow(text, conf) {
	var config = conf || CONF;
	var map = {};

	String(text || '').split('\n').forEach(function (line) {
		line = line.trim();

		if (!line || line.charAt(0) === '#')
			return;

		var eq = line.indexOf('=');

		if (eq < 0)
			return;

		var path = line.substring(0, eq);
		var value = line.substring(eq + 1);
		var parts = path.split('.');

		if (parts.length < 2 || parts[0] !== config)
			return;

		var section = parts[1];
		var option = parts.length > 2 ? parts.slice(2).join('.') : null;

		if (!map[section])
			map[section] = { name: section, type: '', opts: {} };

		if (option == null)
			map[section].type = value;
		else
			map[section].opts[option] = unquote(value);
	});

	return Object.keys(map).map(function (name) { return map[name]; });
}

/* Правило фаервола, которое открывает LuCI через ZeroTier. */
const FW_RULE = 'luci_zerotier';
const FW_RULE_NAME = 'Allow-LuCI-ZeroTier';
const FW_PORTS = '80 443';
/* В nftables шаблон интерфейса — это '*', а не iptables-ный '+'.
 * fw4 передаёт device в nft как есть, поэтому 'zt+' не совпадал никогда. */
const FW_DEVICE = 'zt*';

function isTrue(value) {
	return value == 1 || value === true || value === '1' || value === 'true';
}

/* ---------- вспомогательное ---------- */

function notify(msg, type) {
	ui.addNotification(null, E('p', {}, msg), type || 'info');
}

function badge(text, kind) {
	return E('span', { class: 'zt-badge zt-' + (kind || 'muted') }, text);
}

function shortId(nwid) {
	return nwid ? String(nwid).substr(0, 10) : '—';
}

function nodePort(node) {
	var p = node && (node.port
		|| (node.config && node.config.settings && node.config.settings.primaryPort)
		|| (node.settings && node.settings.primaryPort));

	return p ? String(p) : '—';
}

function peerVersion(version) {
	var v = String(version || '');

	return (!v || v.charAt(0) === '-') ? '—' : v;
}

function serviceStatus() {
	/* ubus "service list" в этой сборке не отдаёт флаг автозапуска,
	 * поэтому его берём у самого init-скрипта: /etc/init.d/zerotier enabled. */
	return Promise.all([
		withTimeout(L.resolveDefault(callServiceList('zerotier'), {}), 8000, {}),
		withTimeout(execOpts(INIT, [ 'enabled' ]), 5000, { code: 1 })
	]).then(function (res) {
		var svc = (res[0] && res[0].zerotier) || {};
		var inst = svc.instances || {};
		var running = false;

		for (var name in inst)
			if (inst[name] && inst[name].running)
				running = true;

		return {
			running: running,
			enabled: (svc.enabled === true) || res[1].code === 0
		};
	});
}

/* ---------- страница ---------- */

return view.extend({
	load: function () {
		var self = this;

		return serviceStatus().then(function (status) {
			self.status = status;
			return self.loadConfig();
		}).then(function () {
			return self.status;
		});
	},

	loadConfig: function () {
		var self = this;

		return Promise.all([
			withTimeout(execOpts(UCI, [ '-q', 'show', CONF ]), 8000, { code: -1, stdout: '' }),
			withTimeout(execOpts(UCI, [ '-q', 'show', 'firewall' ]), 8000, { code: -1, stdout: '' })
		]).then(function (res) {
			self.sections = parseUciShow(res[0].code === 0 ? res[0].stdout : '', CONF);
			self.fwSections = parseUciShow(res[1].code === 0 ? res[1].stdout : '', 'firewall');
			return self.sections;
		});
	},

	firewallState: function () {
		var rule = this.firewallRule();

		if (!rule)
			return 'off';

		return (String(rule.opts.device || '') === FW_DEVICE) ? 'on' : 'stale';
	},

	firewallRule: function () {
		var list = this.fwSections || [];

		for (var i = 0; i < list.length; i++) {
			if (list[i].name === FW_RULE)
				return list[i];

			if (list[i].type === 'rule' && list[i].opts.name === FW_RULE_NAME)
				return list[i];
		}

		return null;
	},

	globalSection: function () {
		var list = this.sections || [];

		for (var i = 0; i < list.length; i++)
			if (list[i].name === 'global')
				return list[i];

		return null;
	},

	networkSections: function () {
		return (this.sections || []).filter(function (s) {
			return s.type === 'network' && s.opts.id;
		});
	},

	findNetwork: function (nwid) {
		var list = this.networkSections();

		for (var i = 0; i < list.length; i++)
			if (String(list[i].opts.id).toLowerCase() === String(nwid).toLowerCase())
				return list[i];

		return null;
	},

	render: function (status) {
		var self = this;

		this.state = {
			running: !!status.running,
			enabled: !!status.enabled,
			node: null,
			networks: [],
			error: '',
			busy: false
		};

		this.statusBox = E('div', { class: 'zt-status' }, E('em', {}, 'Читаю состояние ZeroTier…'));
		this.networksBox = E('div', { class: 'zt-networks' }, E('em', {}, '…'));
		this.peersBox = E('div', { class: 'zt-peers' }, E('em', {}, '…'));
		this.firewallBox = E('div', { class: 'zt-firewall' }, E('em', {}, '…'));
		this.nodeIdBox = E('div', { class: 'zt-nodeid' }, '');

		var joinInput = E('input', {
			class: 'cbi-input-text',
			type: 'text',
			placeholder: '8056c2e21c000001',
			spellcheck: 'false',
			maxlength: 16
		});

		var global = this.globalSection();

		var page = E('div', { class: 'cbi-map zt-page' }, [
			E('h2', { name: 'content' }, 'ZeroTier'),
			E('div', { class: 'cbi-map-descr' },
				'ZeroTier объединяет устройства в плоскую виртуальную сеть. Здесь — состояние узла, его сети и пиры.'),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Узел'),
					E('div', { class: 'zt-actions' }, [
						this.button('Запустить', 'cbi-button-apply', function () { return self.serviceAction('start'); }),
						this.button('Остановить', 'cbi-button-reset', function () { return self.serviceAction('stop'); }),
						this.button('Перезапустить', 'cbi-button-action', function () { return self.serviceAction('restart'); }),
						this.button('Автозапуск', 'cbi-button-neutral', function () { return self.toggleBoot(); })
					])
				]),
				this.statusBox,
				this.nodeIdBox
			]),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Подключить сеть'),
					E('span', { class: 'zt-hint' }, '16 hex-символов из my.zerotier.com')
				]),
				E('div', { class: 'zt-joinrow' }, [
					joinInput,
					this.button('Подключить', 'cbi-button-apply', function () {
						return self.joinNetwork(joinInput);
					})
				])
			]),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Сети'),
					this.button('Обновить', 'cbi-button-neutral', function () { return self.refresh(true); })
				]),
				this.networksBox
			]),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Настройки'),
					this.button('Применить', 'cbi-button-apply', function () { return self.applySettings(); })
				]),
				E('div', { class: 'zt-field' }, [
					E('label', { for: 'zt-port' }, 'Основной порт'),
					E('input', {
						class: 'cbi-input-text',
						type: 'number',
						min: '1024',
						max: '65535',
						id: 'zt-port',
						value: (global && global.opts.port) || '9993'
					}),
					E('span', { class: 'zt-hint' }, 'UDP-порт туннеля, по умолчанию 9993.')
				])
			]),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Доступ к веб-интерфейсу через ZeroTier'),
					E('span', { class: 'zt-hint' }, 'TCP 80 и 443 на интерфейсе zt*')
				]),
				this.firewallBox
			]),

			E('div', { class: 'zt-card' }, [
				E('div', { class: 'zt-card-head' }, [
					E('h3', {}, 'Пиры'),
					this.button('Обновить', 'cbi-button-neutral', function () { return self.loadPeers(); })
				]),
				this.peersBox
			]),

			E('style', {}, [
				'.zt-card{background:var(--fs-panel,inherit);border:1px solid var(--fs-border,#d6e0ee);',
				'border-radius:12px;padding:14px 16px;margin-bottom:14px}',
				'.zt-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}',
				'.zt-card-head h3{margin:0;font-size:1.05rem}',
				'.zt-actions{display:flex;gap:8px;flex-wrap:wrap}',
				'.zt-status{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;align-items:center}',
				'.zt-status dt{color:var(--fs-dim,#64748b);font-size:.92em}',
				'.zt-status dd{margin:0;font-weight:600}',
				'.zt-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.82em;font-weight:600;line-height:1.6}',
				'.zt-good{background:color-mix(in srgb,var(--fs-good,#15803d) 18%,transparent);color:var(--fs-good,#15803d)}',
				'.zt-warn{background:color-mix(in srgb,var(--fs-warn,#b45309) 18%,transparent);color:var(--fs-warn,#b45309)}',
				'.zt-bad{background:color-mix(in srgb,var(--fs-danger,#dc2626) 18%,transparent);color:var(--fs-danger,#dc2626)}',
				'.zt-muted{background:color-mix(in srgb,var(--fs-dim,#64748b) 16%,transparent);color:var(--fs-dim,#64748b)}',
				'.zt-nodeid{margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95em;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
				'.zt-joinrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
				'.zt-joinrow input{flex:1 1 240px;min-width:200px;font-family:ui-monospace,monospace}',
				'.zt-hint{color:var(--fs-faint,#94a3b8);font-size:.85em}',
				'.zt-table{width:100%;border-collapse:collapse}',
				'.zt-table th,.zt-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--fs-border,#e2e8f0);vertical-align:middle}',
				'.zt-table th{font-size:.82em;text-transform:uppercase;letter-spacing:.03em;color:var(--fs-dim,#64748b)}',
				'.zt-table tr:last-child td{border-bottom:0}',
				'.zt-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}',
				'.zt-flags{display:flex;gap:10px;flex-wrap:wrap}',
				'.zt-flags label{display:inline-flex;gap:5px;align-items:center;font-size:.9em;cursor:pointer}',
				'.zt-field{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
				'.zt-field input{max-width:140px}',
				'.zt-empty{color:var(--fs-faint,#94a3b8);font-style:italic}'
			].join(''))
		]);

		this.renderStatus();
		this.renderNetworks();
		this.renderFirewall();

		poll.add(L.bind(function () {
			if (this.state.busy)
				return Promise.resolve();

			return this.refresh(false);
		}, this), 5);

		return this.refresh(false).then(function () {
			return self.loadPeers();
		}).then(function () {
			return page;
		});
	},

	/* ---------- отрисовка ---------- */

	button(label, cls, handler) {
		var btn = E('button', { class: 'cbi-button ' + cls, type: 'button' }, label);

		btn.addEventListener('click', function (ev) {
			ev.preventDefault();

			if (btn.disabled)
				return;

			btn.disabled = true;
			Promise.resolve(handler()).catch(function (err) {
				notify(String((err && err.message) || err), 'error');
			}).then(function () {
				btn.disabled = false;
			});
		});

		return btn;
	},

	renderStatus() {
		var st = this.state;
		var rows = [
			E('dt', {}, 'Служба'),
			E('dd', {}, [
				st.running ? badge('работает', 'good') : badge('остановлена', 'muted'),
				' ',
				st.enabled ? badge('автозапуск вкл', 'good') : badge('автозапуск выкл', 'muted')
			])
		];

		if (st.node) {
			rows.push(E('dt', {}, 'Версия'), E('dd', {}, st.node.version || '—'));
			rows.push(E('dt', {}, 'Онлайн'), E('dd', {},
				st.node.online ? badge('да', 'good') : badge('нет', 'warn')));
			rows.push(E('dt', {}, 'UDP-порт'), E('dd', {}, nodePort(st.node)));
		}
		else if (st.error) {
			rows.push(E('dt', {}, 'Узел'), E('dd', { class: 'zt-hint' }, st.error));
		}

		dom.content(this.statusBox, E('dl', { class: 'zt-status' }, rows));

		if (st.node && st.node.address) {
			var idText = st.node.address;

			dom.content(this.nodeIdBox, [
				E('span', { class: 'zt-hint' }, 'ID узла:'),
				E('span', { class: 'zt-mono' }, idText),
				E('button', {
					class: 'cbi-button cbi-button-neutral',
					type: 'button',
					click: function (ev) {
						ev.preventDefault();

						try {
							navigator.clipboard.writeText(idText);
							notify('ID узла скопирован.', 'info');
						}
						catch (e) {
							notify(idText, 'info');
						}
					}
				}, 'Копировать')
			]);
		}
		else {
			dom.content(this.nodeIdBox, '');
		}
	},

	renderNetworks() {
		var self = this;
		var nets = this.state.networks || [];

		if (!this.state.running) {
			dom.content(this.networksBox, E('p', { class: 'zt-empty' },
				'ZeroTier остановлен — запусти службу, чтобы увидеть подключённые сети.'));
			return;
		}

		if (!nets.length) {
			dom.content(this.networksBox, E('p', { class: 'zt-empty' },
				'Подключённых сетей нет. Добавь сеть выше или впиши её в /etc/config/zerotier.'));
			return;
		}

		var rows = nets.map(function (net) {
			var cfg = self.findNetwork(net.nwid) || { opts: {} };
			var status = String(net.status || '').toUpperCase();
			var addrs = (net.assignedAddresses || []).join(', ') || '—';

			var flags = FLAGS.map(function (f) {
				var box = E('input', {
					type: 'checkbox',
					'data-flag': f[0],
					'data-net': net.nwid
				});

				box.checked = isTrue(cfg.opts[f[0]]);

				box.addEventListener('change', function () {
					return self.setFlag(net.nwid, f[0], f[1], box.checked, box);
				});

				return E('label', { title: f[1] }, [ box, ' ', f[2] ]);
			});

			return E('tr', {}, [
				E('td', {}, [
					E('div', {}, E('strong', {}, net.name || '(без имени)')),
					E('div', { class: 'zt-hint zt-mono' }, shortId(net.nwid))
				]),
				E('td', {}, badge(status || '?', NET_STATUS[status] || 'muted')),
				E('td', { class: 'zt-mono' }, addrs),
				E('td', {}, E('div', { class: 'zt-flags' }, flags)),
				E('td', {}, E('button', {
					class: 'cbi-button cbi-button-remove',
					type: 'button',
					click: function (ev) {
						ev.preventDefault();
						return self.leaveNetwork(net.nwid, net.name);
					}
				}, 'Выйти'))
			]);
		});

		dom.content(this.networksBox, E('table', { class: 'zt-table' }, [
			E('thead', {}, E('tr', {}, [
				E('th', {}, 'Сеть'),
				E('th', {}, 'Статус'),
				E('th', {}, 'Адреса'),
				E('th', {}, 'Разрешить'),
				E('th', {}, '')
			])),
			E('tbody', {}, rows)
		]));
	},

	renderPeers(peers) {
		var list = (peers || []).slice().sort(function (a, b) {
			var rank = function (p) { return p.role === 'PLANET' ? 0 : (p.role === 'MOON' ? 1 : 2); };
			return rank(a) - rank(b) || String(a.address).localeCompare(String(b.address));
		});

		if (!list.length) {
			dom.content(this.peersBox, E('p', { class: 'zt-empty' }, 'Пиров нет.'));
			return;
		}

		dom.content(this.peersBox, E('table', { class: 'zt-table' }, [
			E('thead', {}, E('tr', {}, [
				E('th', {}, 'Адрес'),
				E('th', {}, 'Роль'),
				E('th', {}, 'Версия'),
				E('th', {}, 'Задержка'),
				E('th', {}, 'Путь')
			])),
			E('tbody', {}, list.map(function (p) {
				var path = '—';

				if (p.paths && p.paths.length && p.paths[0].address)
					path = p.paths[0].address + (p.paths[0].active ? '' : ' (пассивный)');

				return E('tr', {}, [
					E('td', { class: 'zt-mono' }, shortId(p.address)),
					E('td', {}, badge(p.role || '?', p.role === 'LEAF' ? 'muted' : 'good')),
					E('td', {}, peerVersion(p.version)),
					E('td', {}, (typeof p.latency === 'number' && p.latency >= 0) ? p.latency + ' мс' : '—'),
					E('td', { class: 'zt-mono zt-hint' }, path)
				]);
			}))
		]));
	},

	renderFirewall() {
		var self = this;
		var state = this.firewallState();
		var addrs = this.zerotierAddresses();
		var ifaces = this.zerotierInterfaces();

		var status = state === 'on' ? badge('разрешено', 'good')
			: (state === 'stale' ? badge('настроено неверно — нажми «Исправить»', 'warn')
				: badge('запрещено', 'muted'));

		var label = state === 'on' ? 'Запретить'
			: (state === 'stale' ? 'Исправить' : 'Разрешить');

		var cls = state === 'on' ? 'cbi-button-reset' : 'cbi-button-apply';

		var lines = [];

		if (addrs.length)
			lines.push(E('div', { class: 'zt-hint' }, 'Адрес для входа: ' +
				addrs.map(function (a) { return 'http://' + a + '/'; }).join(', ')));
		else
			lines.push(E('div', { class: 'zt-hint' }, 'Адрес появится, когда ZeroTier запущен и сеть выдала IP.'));

		if (ifaces.length)
			lines.push(E('div', { class: 'zt-hint' }, 'Интерфейс: ' + ifaces.join(', ') + ' (правило: ' + FW_DEVICE + ')'));

		dom.content(this.firewallBox, E('div', {}, [
			E('div', { class: 'zt-field' }, [
				status,
				this.button(label, cls, function () { return self.toggleFirewall(); })
			])
		].concat(lines)));
	},

	zerotierInterfaces: function () {
		var out = [];

		(this.state.networks || []).forEach(function (net) {
			var dev = net.portDeviceName;

			if (dev && out.indexOf(dev) < 0)
				out.push(dev);
		});

		return out;
	},

	zerotierAddresses() {
		var out = [];

		(this.state.networks || []).forEach(function (net) {
			(net.assignedAddresses || []).forEach(function (a) {
				var ip = String(a).split('/')[0];

				if (ip && out.indexOf(ip) < 0)
					out.push(ip);
			});
		});

		return out;
	},

	/* ---------- данные ---------- */

	refresh(withPeers) {
		var self = this;
		var st = this.state;

		st.busy = true;

		return serviceStatus().then(function (status) {
			st.running = status.running;
			st.enabled = status.enabled;

			return self.loadConfig();
		}).then(function () {
			if (!st.running) {
				st.node = null;
				st.networks = [];
				st.error = '';
				self.renderStatus();
				self.renderNetworks();
				self.renderFirewall();
				return;
			}

			return cliJson('info').then(function (info) {
				st.node = info.data || null;
				st.error = info.ok ? '' : (info.error || 'zerotier-cli не отвечает.');

				return cliJson('listnetworks');
			}).then(function (nets) {
				st.networks = (nets && nets.data) || [];
				self.renderStatus();
				self.renderNetworks();
				self.renderFirewall();

				if (withPeers)
					return self.loadPeers();
			});
		}).catch(function (err) {
			st.error = String((err && err.message) || err);
			self.renderStatus();
		}).then(function () {
			st.busy = false;
		});
	},

	loadPeers() {
		var self = this;

		if (!this.state.running) {
			dom.content(this.peersBox, E('p', { class: 'zt-empty' }, 'ZeroTier остановлен.'));
			return Promise.resolve();
		}

		return cliJson('listpeers').then(function (res) {
			self.renderPeers((res && res.data) || []);
		});
	},

	/* ---------- действия ---------- */

	serviceAction(action) {
		var self = this;

		/* Этот init-скрипт не стартует, пока в /etc/config/zerotier не стоит
		 * enabled=1, поэтому «Запустить» и «Перезапустить» выставляют флаг. */
		var prepare = (action === 'start' || action === 'restart')
			? this.setGlobal('enabled', 1)
			: Promise.resolve();

		return prepare.then(function () {
			return execOpts(INIT, [ action ]);
		}).then(function (res) {
			if (res.code !== 0)
				throw new Error(((res.stderr || res.stdout) || 'Init-скрипт завершился с ошибкой.').trim());

			return new Promise(function (resolve) { setTimeout(resolve, 1500); });
		}).then(function () {
			notify('ZeroTier: ' + ACTION_NAMES[action] + '.', 'info');
			return self.refresh(true);
		});
	},

	toggleBoot() {
		var self = this;
		var enable = !this.state.enabled;

		return this.setGlobal('enabled', enable ? 1 : 0).then(function () {
			return execOpts(INIT, [ enable ? 'enable' : 'disable' ]);
		}).then(function (res) {
			if (res.code !== 0)
				throw new Error(((res.stderr || res.stdout) || 'Init-скрипт завершился с ошибкой.').trim());

			notify(enable
				? 'ZeroTier будет запускаться при загрузке.'
				: 'ZeroTier больше не будет запускаться при загрузке.', 'info');

			return self.refresh(false);
		});
	},

	setGlobal(opt, value) {
		var self = this;
		var global = this.globalSection();

		var create = global
			? Promise.resolve()
			: uciSet(CONF + '.global', 'zerotier');

		return create
			.then(function () { return uciSet(CONF + '.global.' + opt, value); })
			.then(uciCommit)
			.then(function () { return self.loadConfig(); });
	},

	joinNetwork(input) {
		var self = this;
		var nwid = String(input.value || '').trim().toLowerCase();

		if (!/^[0-9a-f]{16}$/.test(nwid)) {
			notify('ID сети — 16 hex-символов, например 8056c2e21c000001.', 'error');
			input.focus();
			return Promise.resolve();
		}

		if (this.findNetwork(nwid)) {
			notify('Эта сеть уже есть в списке.', 'warning');
			return Promise.resolve();
		}

		return uciRun([ 'add', CONF, 'network' ]).then(function (section) {
			var base = CONF + '.' + section;

			return uciSet(base + '.id', nwid)
				.then(function () { return uciSet(base + '.allow_managed', '1'); })
				.then(function () { return uciSet(base + '.allow_global', '0'); })
				.then(function () { return uciSet(base + '.allow_default', '0'); })
				.then(function () { return uciSet(base + '.allow_dns', '0'); })
				.then(uciCommit);
		}).then(function () {
			return self.loadConfig();
		}).then(function () {
			if (!self.state.running) {
				notify('Сохранено. Подключение к ' + shortId(nwid) + ' произойдёт при запуске ZeroTier.', 'info');
				return self.refresh(true);
			}

			return cliRun('join', [ nwid ]).then(function (res) {
				if (!res.ok && !/already/i.test(res.message))
					throw new Error(res.message || 'Не удалось подключиться к сети.');

				input.value = '';
				notify('Подключено к ' + shortId(nwid) + '.', 'info');
				return new Promise(function (resolve) { setTimeout(resolve, 1200); });
			}).then(function () {
				return self.refresh(true);
			});
		});
	},

	leaveNetwork(nwid, name) {
		var self = this;

		ui.showModal('Выйти из сети', [
			E('div', {}, [
				E('p', {}, 'Выйти из сети ' + (name || '(без имени)') + ' (' + nwid + ')?'),
				E('p', { class: 'zt-hint' }, 'Запись также удаляется из /etc/config/zerotier.')
			]),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, 'Отмена'),
				' ',
				E('button', {
					class: 'cbi-button cbi-button-negative',
					click: function (ev) {
						ev.preventDefault();
						ui.hideModal();

						var section = self.findNetwork(nwid);

						Promise.resolve(self.state.running ? cliRun('leave', [ nwid ]) : null)
							.then(function () {
								if (!section)
									return null;

								return uciRun([ 'delete', CONF + '.' + section.name ]);
							})
							.then(uciCommit)
							.then(function () { return self.loadConfig(); })
							.then(function () {
								notify('Вышли из ' + shortId(nwid) + '.', 'info');
								return new Promise(function (resolve) { setTimeout(resolve, 900); });
							})
							.then(function () {
								return self.refresh(true);
							})
							.catch(function (err) {
								notify(String((err && err.message) || err), 'error');
							});
					}
				}, 'Выйти')
			])
		]);
	},

	setFlag(nwid, uciKey, cliKey, value, box) {
		var self = this;
		var section = this.findNetwork(nwid);

		if (!section) {
			notify('Сети ' + shortId(nwid) + ' нет в /etc/config/zerotier — сначала добавь её туда.', 'warning');
			box.checked = !value;
			return Promise.resolve();
		}

		return uciSet(CONF + '.' + section.name + '.' + uciKey, value ? '1' : '0')
			.then(uciCommit)
			.then(function () { return self.loadConfig(); })
			.then(function () {
				if (!self.state.running)
					return null;

				return cliRun('set', [ nwid, cliKey + '=' + (value ? '1' : '0') ]);
			})
			.then(function (res) {
				if (res && !res.ok)
					throw new Error(res.message || 'Настройка не применилась.');

				notify(cliKey + ': ' + (value ? 'включено' : 'выключено'), 'info');
			})
			.catch(function (err) {
				notify(String((err && err.message) || err), 'error');
				box.checked = !value;
			});
	},

	applySettings() {
		var port = parseInt((document.getElementById('zt-port') || {}).value, 10);

		if (!(port >= 1024 && port <= 65535)) {
			notify('Порт должен быть от 1024 до 65535.', 'error');
			return Promise.resolve();
		}

		return this.setGlobal('port', port).then(function () {
			notify('Сохранено. Перезапусти ZeroTier, чтобы использовать порт ' + port + '.', 'info');
		});
	},

	toggleFirewall() {
		var self = this;
		var rule = this.firewallRule();
		var state = this.firewallState();
		var addrs = this.zerotierAddresses();
		var target = (state === 'stale' && rule) ? rule.name : FW_RULE;
		var task;

		if (state === 'on') {
			task = uciRun([ 'delete', 'firewall.' + rule.name ]);
		}
		else {
			task = uciRun([ 'set', 'firewall.' + target + '=rule' ])
				.then(function () { return uciSet('firewall.' + target + '.name', FW_RULE_NAME); })
				.then(function () { return uciSet('firewall.' + target + '.src', '*'); })
				.then(function () { return uciSet('firewall.' + target + '.device', FW_DEVICE); })
				.then(function () { return uciSet('firewall.' + target + '.proto', 'tcp'); })
				.then(function () { return uciSet('firewall.' + target + '.dest_port', FW_PORTS); })
				.then(function () { return uciSet('firewall.' + target + '.target', 'ACCEPT'); });
		}

		return task
			.then(function () { return uciRun([ 'commit', 'firewall' ]); })
			.then(function () { return self.reloadFirewall(); })
			.then(function () { return self.loadConfig(); })
			.then(function () {
				notify(state === 'on'
					? 'Доступ к веб-интерфейсу через ZeroTier закрыт.'
					: 'Доступ открыт: TCP 80/443 на ' + FW_DEVICE +
						(addrs.length ? ' — ' + addrs.map(function (a) { return 'http://' + a + '/'; }).join(', ') : ''),
					'info');

				return self.refresh(false);
			});
	},

	reloadFirewall() {
		return execOpts('/etc/init.d/firewall', [ 'reload' ]).then(function (res) {
			if (res.code !== 0)
				throw new Error(((res.stderr || res.stdout) || 'Не удалось применить правила фаервола.').trim());

			return res;
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
