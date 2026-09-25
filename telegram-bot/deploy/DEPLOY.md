# Розгортання на VPS з Ubuntu 24.04 LTS

Перевірено для Ubuntu 24.04 LTS і Debian 12. Потрібні: VPS з root-доступом, токен від [@BotFather](https://t.me/BotFather), близько десяти хвилин.

Бот працює як `systemd`-сервіс під окремим непривілейованим користувачем. Результати лежать у `/var/lib/gad7-phq9-bot/`, окремо від коду, тому оновлення коду ніколи не торкається даних. Токен лежить у `/etc/gad7-phq9-bot.env` з правами `0600` і не потрапляє ні в репозиторій, ні в лог.

## Крок 1. Перевірте сервер до оплати

Якщо хостинг дає безкоштовний тест, це найважливіші чотири команди. Без доступу до Telegram бот там не запрацює, і краще дізнатися це до оплати року.

```text
curl -sS -o /dev/null -w "%{http_code}\n" https://api.telegram.org   # чекаємо 302
systemd-detect-virt                                                  # чекаємо kvm
systemctl --version                                                  # systemd має бути
node --version                                                       # будь-яка або відсутня
curl -sS -o /dev/null -w "%{http_code}\n" https://github.com         # 200 означає, що IPv4 є
```

`302` від Telegram це нормальна відповідь кореня API: переадресація на документацію, яка доводить, що зв'язок є. Таймаут або помилка з'єднання означають, що цей хостинг не підходить. Виняток `Could not resolve host` на сервері лише з IPv6: зазвичай це зламаний маршрут, він лікується, дивіться розділ про IPv6 нижче. `openvz` замість `kvm` не вирок, але systemd там буває урізаний, тому дивіться уважно на запуск сервісу.

Остання команда перевіряє IPv4: у GitHub немає адрес IPv6 взагалі, тому помилка зʼєднання там означає, що сервер лише на IPv6. Це не перешкода, дивіться розділ нижче.

Node може бути відсутнім: установник поставить Node 22 LTS сам, бо в apt Ubuntu 24.04 лежить Node 18, у якого підтримка вже завершилася.

## Крок 2. Закрийте свіжий сервер

Провайдер видає сервер з root-паролем, який ходив листом. Дві хвилини роботи, перш ніж на ньому з'являться дані про здоров'я:

```text
passwd                                    # свій пароль замість виданого
apt update && apt install -y ufw unattended-upgrades
ufw allow 22/tcp                          # спочатку дозволити SSH
ufw --force enable                        # і лише потім увімкнути
```

Порядок важливий: `ufw enable` без дозволеного 22 порту відрізає вас від сервера. Боту вхідні порти не потрібні взагалі, він сам ходить до Telegram, тому відкритим лишається тільки SSH.

## Крок 3. Встановіть

```text
apt install -y git curl
git clone https://github.com/justcallmejesi/unlazy.git
cd unlazy
git checkout claude/telegram-gad7-phq9-bot-imgb30
bash telegram-bot/deploy/install.sh
```

Якщо репозиторій приватний, `git clone` попросить логін. Пароль GitHub там не працює, потрібен personal access token: GitHub → Settings → Developer settings → Personal access tokens → створіть token з доступом до репозиторію і вставте його замість пароля. Альтернатива: зробити репозиторій публічним. Секретів у коді немає, токен бота живе лише в `.env`, який у `.gitignore`.

Установник перевіряє зв'язок з Telegram, ставить Node за потреби, створює користувача `gad7bot`, копіює код у `/opt/gad7-phq9-bot`, готує файл з налаштуваннями, проганяє тести і вмикає сервіс разом із щоденним бекапом. Запускати повторно безпечно: так само робиться оновлення.

### Якщо на сервері немає IPv4

Дешеві тарифи іноді дають лише IPv6, а окрема адреса IPv4 коштує грошей. Боту вона не потрібна: він сам ходить до Telegram і не приймає вхідних зʼєднань. Усе, що потрібно установнику, доступне по IPv6:

| Що | IPv6 |
| --- | --- |
| `api.telegram.org` | є |
| `archive.ubuntu.com`, `security.ubuntu.com` | є |
| регіональні дзеркала, наприклад `de.archive.ubuntu.com` | **немає** |
| `deb.nodesource.com` | є |
| `github.com`, `codeload.github.com` | **немає** |

Шаблони таких серверів можуть прийти з двома поломками, які треба прибрати до всього іншого.

**Кілька шлюзів.** Симптоми: `curl` то пише `Could not resolve host`, то працює, `apt update` падає з `Temporary failure resolving` або тягне десятки кілобайт за секунду, `ping` губить усі пакети. DNS тут ні до чого, подивіться маршрут:

```text
ip -6 route
```

Якщо під `default` кілька рядків `nexthop`, сервер підхопив з мережі провайдера оголошення ще кількох маршрутизаторів і розкидає трафік між ними, а частина з них пакети не пропускає. Шлюз з налаштувань (рядок `via` у `/etc/netplan/*.yaml`) при цьому робочий. Вимкніть прийом оголошень, і лишиться тільки він:

```text
echo 'network: {version: 2, ethernets: {eth0: {accept-ra: false}}}' > /etc/netplan/99-no-ra.yaml
chmod 600 /etc/netplan/99-no-ra.yaml
netplan apply
ip -6 route                               # один рядок default via ..., без nexthop
```

`eth0` замініть на назву інтерфейсу з `ip -6 route`, якщо вона інша. Якщо рядки `nexthop` лишилися, перезавантажте сервер. Здорова мережа виглядає так: `ping -6 -c 5 2001:4860:4860::8888` без втрат, `apt update` качає мегабайти за секунду.

**Дзеркало apt.** Якщо `apt update` пише `Failed to fetch http://de.archive.ubuntu.com`, шаблон дивиться в регіональне дзеркало без IPv6. Перемкніть на головне:

```text
sed -i 's/de.archive/archive/' /etc/apt/sources.list /etc/apt/sources.list.d/*
apt update
```

Повідомлення `can't read /etc/apt/sources.list` тут нешкідливе: у Ubuntu 24.04 джерела лежать в іншому файлі. Для іншої країни замініть `de` на її код.

Після цього ламається саме `git clone`, і тільки він. Скопіюйте код зі свого компʼютера, де IPv4 є:

```text
git clone https://github.com/justcallmejesi/unlazy.git
cd unlazy && git checkout claude/telegram-gad7-phq9-bot-imgb30
cd ..
scp -r unlazy root@[ВАША:IPv6:АДРЕСА]:/root/
```

Квадратні дужки навколо адреси обовʼязкові. Далі на сервері все як у кроці 3, git там не потрібен:

```text
cd /root/unlazy
bash telegram-bot/deploy/install.sh
```

Оновлення так само: копіюєте свіжу папку і запускаєте установник повторно.

### Якщо IPv6 немає і у вас

Провайдери домашнього інтернету досі часто дають лише IPv4, і тоді до сервера на IPv6 не дістатися ні `ssh`, ні `scp`. Перевірити свій канал:

```text
curl -6 -sS https://ifconfig.co       # адреса означає, що IPv6 є
```

Вхід у сервер це вирішує панель хостингу: у Virtualizor (HostPro, ho.ua і більшість інших) поряд з назвою сервера є три іконки, стоп, живлення і монітор. Монітор відкриває VNC-консоль у браузері, вона йде через панель, тому IPv6 у вас не потрібен. Логін `root`, пароль з листа, і одразу `passwd`.

Консоль не приймає файли, тому код туди не завантажити. Лишається одне з двох: окрема адреса IPv4 на сервер, після чого працює звичайний `git clone` з кроку 3, або публічний резолвер DNS64 з шлюзом NAT64 (такі сервіси є безкоштовні, адреси беріть на сторінці сервісу), прописаний у `/etc/resolv.conf` на час клонування. Друге це костиль: весь трафік до вузлів без IPv6 піде через чужий шлюз, тому прибирайте його одразу після `git clone`. Боту він не потрібен: у `api.telegram.org` адреси IPv6 є, і бот ходить туди напряму.

## Крок 4. Впишіть токен і запустіть

```text
sudo nano /etc/gad7-phq9-bot.env      # BOT_TOKEN=123456789:...
sudo systemctl enable --now gad7-phq9-bot
journalctl -u gad7-phq9-bot -f
```

У логі має з'явитися `authorized as @ваш_бот`, далі `polling for updates`. Напишіть боту `/start` в особистому чаті.

## Крок 5. Застосунок у вікні

Вікно це статична сторінка, їй потрібен лише хостинг по https. На Cloudflare Pages це безкоштовно:

1. Cloudflare → Workers and Pages → Create → Pages → підключіть цей репозиторій.
2. Branch: `claude/telegram-gad7-phq9-bot-imgb30`. Build command: **порожня**. Build output directory: `telegram-bot/webapp`.
3. Отриману адресу виду `https://назва.pages.dev/` впишіть у `WEBAPP_URL` і перезапустіть бота:

```text
sudo nano /etc/gad7-phq9-bot.env      # WEBAPP_URL=https://назва.pages.dev/
sudo systemctl restart gad7-phq9-bot
journalctl -u gad7-phq9-bot -n 20     # чекаємо "Mini App enabled: ..."
```

Після цього під полем введення з'явиться кнопка «Відкрити застосунок». Без `WEBAPP_URL` бот працює тільки в чаті, і це теж робочий режим.

## Бекапи

`gad7-phq9-backup.timer` щодня копіює знімок у `/var/lib/gad7-phq9-bot/backups/`, тримає останні 14 копій і перед збереженням перевіряє, що файл розбирається як JSON. Копії лежать на тій самій машині, тому втрата диска це втрата всього. Задайте `BACKUP_REMOTE` у `/etc/gad7-phq9-bot.env`, щоб остання копія йшла ще й на інший хост:

```text
BACKUP_REMOTE=user@host:/backups/gad7-phq9
```

Для цього потрібен ключ SSH без пароля. Домашньої теки в `gad7bot` немає, а сервіс бекапу не бачить `/home` (`ProtectHome=yes`), тому ключ і `known_hosts` лежать у теці стану:

```text
sudo -u gad7bot mkdir -p -m 700 /var/lib/gad7-phq9-bot/.ssh
sudo -u gad7bot ssh-keygen -t ed25519 -N "" -f /var/lib/gad7-phq9-bot/.ssh/id_ed25519
sudo cat /var/lib/gad7-phq9-bot/.ssh/id_ed25519.pub      # додайте в authorized_keys на цільовому хості
```

Перевірити таймер і зробити копію просто зараз:

```text
systemctl list-timers gad7-phq9-backup
sudo systemctl start gad7-phq9-backup.service
journalctl -u gad7-phq9-backup -n 20
```

## Обслуговування

| Задача | Команда |
| --- | --- |
| подивитися лог | `journalctl -u gad7-phq9-bot -f` |
| перезапустити | `sudo systemctl restart gad7-phq9-bot` |
| оновити код | `cd ~/unlazy && git pull && sudo bash telegram-bot/deploy/install.sh` |
| змінити налаштування | `sudo nano /etc/gad7-phq9-bot.env`, потім `restart` |
| змінити ціну або пробний період | `PRICE_STARS` і `TRIAL_DAYS` там само |
| повернути оплату | `curl -sS "https://api.telegram.org/bot$BOT_TOKEN/refundStarPayment" -d user_id=<id> -d telegram_payment_charge_id=<chargeId>` |
| подивитися дані | `sudo ls -la /var/lib/gad7-phq9-bot/` |

Нагадування приходить щопонеділка о 19:00 за київським часом. Переходи на літній і зимовий час бот враховує сам, через базу часових поясів системи, тому двічі на рік нічого правити не потрібно. Змінити день або час: `REMINDER_WEEKDAY` і `REMINDER_TIME` у `/etc/gad7-phq9-bot.env`.

Базу часових поясів системи варто тримати свіжою, це те саме `unattended-upgrades` з кроку 2:

```text
apt list --installed 2>/dev/null | grep tzdata
```

## Якщо щось не працює

| Симптом у логі | Причина |
| --- | --- |
| `BOT_TOKEN is not set` | порожній `BOT_TOKEN` у `/etc/gad7-phq9-bot.env` |
| `failed with 401` | токен невірний або відкликаний, візьміть новий у BotFather |
| `failed with 409` | бот уже запущений десь ще, один токен обслуговує один процес |
| `getUpdates transport error` | сервер не бачить `api.telegram.org`, перевірте крок 1 |
| `snapshot write failed` | немає прав на `/var/lib/gad7-phq9-bot`, перевірте `StateDirectory` |
| сервіс не стартує на OpenVZ | урізаний systemd, спробуйте `systemctl status` і перейдіть на KVM |

Стан сервісу одним рядком:

```text
systemctl is-active gad7-phq9-bot && journalctl -u gad7-phq9-bot -n 5 --no-pager
```
