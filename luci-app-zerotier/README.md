# luci-app-zerotier

Веб-панель ZeroTier для LuCI: состояние ноды, сети, пиры, join/leave и флаги
сетей — без консоли.

- **Нода** — статус сервиса, автозапуск, версия, online, UDP-порт, Node ID
  с кнопкой «Copy», кнопки Start / Stop / Restart / Enabled at boot.
- **Join a network** — ввод 16-символьного ID, проверка формата, запись в
  `/etc/config/zerotier` и мгновенный `zerotier-cli join`.
- **Networks** — имя, ID, статус (OK / REQUESTING_CONFIGURATION /
  ACCESS_DENIED …), выданные адреса и переключатели `allowManaged`,
  `allowGlobal`, `allowDefault`, `allowDNS`. Флаги применяются сразу
  (`zerotier-cli set`) и сохраняются в UCI, поэтому переживают рестарт.
  Кнопка Leave удаляет сеть и из демона, и из конфига.
- **Settings** — UDP-порт (по умолчанию 9993).
- **Peers** — адрес, роль (PLANET / MOON / LEAF), версия, задержка, путь.
- **Доступ к веб-интерфейсу через ZeroTier** — одна кнопка: создаёт правило
  фаервола `Allow-LuCI-ZeroTier` (TCP 80 и 443 на интерфейсе `zt*`), применяет
  его через `/etc/init.d/firewall reload` и показывает адрес вида
  `http://10.x.x.x/`, по которому LuCI открывается из ZeroTier-сети.
  Повторное нажатие правило удаляет. uhttpd в OpenWrt и так слушает
  `0.0.0.0:80/443`, поэтому больше ничего настраивать не нужно.
- Автообновление статуса и сетей каждые 5 секунд, без перезагрузки страницы.

## Установка (OpenWrt 25.12 / apk)

```sh
cp luci-app-zerotier.rsa.pub /etc/apk/keys/
apk add --allow-untrusted luci-app-zerotier-2026.11.28-r4.apk
```

## Установка (OpenWrt 24.10 и старше / opkg)

```sh
opkg install luci-app-zerotier_2026.11.28-r4_all.ipk
```

После установки: **VPN → ZeroTier**. Пакет `zerotier` ставится как зависимость
(если его нет — `opkg update && opkg install zerotier`).

## Как это работает

Источник правды — `/etc/config/zerotier`:

```
config zerotier 'global'
	option enabled '1'
	option port '9993'

config network 'home'
	option id '8056c2e21c000001'
	option allow_managed '1'
	option allow_global '0'
	option allow_default '0'
	option allow_dns '0'
```

Init-скрипт собирает `/var/lib/zerotier-one` из этого конфига при каждом
старте, поэтому панель пишет UCI (persist) и дублирует действие через
`zerotier-cli` (instant). Панель требует `luci-base` и `zerotier`, rpcd-ACL
разрешает только `zerotier-cli`, `/etc/init.d/zerotier`, uci `zerotier` и
`service list`.

## Сборка пакетов без SDK

```sh
python3 scripts/build-packages.py --version 2026.11.28-r4
```

Результат в `dist/`: `.ipk`, `.apk` и `luci-app-zerotier.rsa.pub`.
Ключ подписи создаётся при первой сборке в `keys/`; `dist/` и `keys/`
в `.gitignore`. Без `cryptography` (или с `--no-sign`) собирается
неподписанный apk для `apk add --allow-untrusted`.

Сборка через OpenWrt SDK/buildroot — обычный `Makefile` с `luci.mk`.

## Лицензия

Apache-2.0.
