#!/usr/bin/env bash
# Install or update the GAD-7 and PHQ-9 bot on Ubuntu 24.04 LTS or Debian 12.
# Idempotent: safe to re-run to update the code.
#
#   sudo bash telegram-bot/deploy/install.sh
#
# What it does: checks the machine can reach Telegram, installs Node 22 LTS if
# the system Node is older than 18, creates an unprivileged service user, copies
# the repository to /opt/gad7-phq9-bot, creates /etc/gad7-phq9-bot.env for the
# token if it does not exist, then installs and starts the service and the
# backup timer. It never prints the token.
set -euo pipefail

APP_DIR=/opt/gad7-phq9-bot
ENV_FILE=/etc/gad7-phq9-bot.env
SERVICE_USER=gad7bot
NODE_MAJOR=22

say() { printf '\n== %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
command -v apt-get >/dev/null || die "this script expects Ubuntu or Debian"
command -v systemctl >/dev/null || die "systemd is required; systemctl not found"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$SOURCE_DIR/telegram-bot/bot.mjs" ] || die "run this from inside the cloned repository"

say "Checking that this machine can reach Telegram"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://api.telegram.org || echo 000)"
case "$code" in
  404|200|302) echo "api.telegram.org answered $code, reachable" ;;
  000) die "cannot reach api.telegram.org at all. This host cannot run the bot." ;;
  *) echo "warning: api.telegram.org answered $code, unexpected but continuing" ;;
esac

say "Checking the virtualization and init environment"
virt="$(systemd-detect-virt || echo unknown)"
echo "virtualization: $virt"
[ "$virt" = "openvz" ] && echo "warning: OpenVZ containers often restrict systemd, watch the service start closely"

say "Installing Node.js"
current_major=0
if command -v node >/dev/null; then
  current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  echo "found Node $(node --version)"
fi
if [ "$current_major" -lt 18 ]; then
  echo "installing Node $NODE_MAJOR LTS from NodeSource"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  echo "installed Node $(node --version)"
fi

say "Creating the service user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "user $SERVICE_USER already exists"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "created $SERVICE_USER"
fi

say "Copying the code to $APP_DIR"
mkdir -p "$APP_DIR"
# Only the bot and its tests are needed at runtime. The .env of the repository
# checkout is deliberately excluded: the token belongs to $ENV_FILE.
tar -C "$SOURCE_DIR" -cf - \
  --exclude='.git' --exclude='node_modules' --exclude='telegram-bot/.env' --exclude='telegram-bot/.data' \
  . | tar -C "$APP_DIR" -xf -
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
echo "code in place"

say "Preparing $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists, left untouched"
else
  cat > "$ENV_FILE" <<'ENVEOF'
# Token from @BotFather. Required.
BOT_TOKEN=

# Results snapshot. StateDirectory in the unit creates this directory.
DATA_FILE=/var/lib/gad7-phq9-bot/results.json

# Kyiv: +3 in summer, +2 from late October to late March.
REMINDER_TIME=10:00
REMINDER_UTC_OFFSET=+3

# https address of the Mini App once it is deployed. Leave empty for chat only.
WEBAPP_URL=

# One-time full access price in Telegram Stars, and the free trial length.
PRICE_STARS=100
TRIAL_DAYS=14

# Your Telegram username for the help offer shown above the cutoff, no at sign.
CONTACT_USERNAME=
CONTACT_NAME=
CONTACT_ROLE=

# Off-machine backup target for scp, for example user@host:/backups/gad7
BACKUP_REMOTE=
ENVEOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo "created $ENV_FILE, fill in BOT_TOKEN before starting"
fi

say "Running the test suite"
( cd "$APP_DIR" && node telegram-bot/tests/run-tests.mjs | tail -2 )

say "Installing the service and the backup timer"
install -m 0644 "$APP_DIR/telegram-bot/deploy/gad7-phq9-bot.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/telegram-bot/deploy/gad7-phq9-backup.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/telegram-bot/deploy/gad7-phq9-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gad7-phq9-backup.timer

if grep -q '^BOT_TOKEN=.\+' "$ENV_FILE"; then
  systemctl enable gad7-phq9-bot.service
  systemctl restart gad7-phq9-bot.service
  sleep 3
  systemctl --no-pager --lines=15 status gad7-phq9-bot.service || true
  say "Done. Follow the log with: journalctl -u gad7-phq9-bot -f"
else
  say "Almost done"
  cat <<'NEXTEOF'
BOT_TOKEN is still empty. Finish with:

  sudo nano /etc/gad7-phq9-bot.env      paste the token from @BotFather
  sudo systemctl enable --now gad7-phq9-bot
  journalctl -u gad7-phq9-bot -f        expect "authorized as @your_bot"
NEXTEOF
fi
