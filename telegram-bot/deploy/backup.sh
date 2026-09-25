#!/usr/bin/env bash
# Daily copy of the results snapshot. Keeps a bounded set of dated copies and,
# when BACKUP_REMOTE is set, pushes the newest one off the machine.
#
# The snapshot holds health data, so every file it writes is 0600 and the
# directory 0700. Run by gad7-phq9-backup.timer.
set -euo pipefail
umask 077

DATA_FILE="${DATA_FILE:-/var/lib/gad7-phq9-bot/results.json}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/gad7-phq9-bot/backups}"
KEEP="${BACKUP_KEEP:-14}"

if [ ! -f "$DATA_FILE" ]; then
  echo "backup: no snapshot at $DATA_FILE yet, nothing to do"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="$BACKUP_DIR/results-$stamp.json"

# Copy first, verify it parses, and only then keep it. A snapshot caught
# mid-rename would otherwise be stored as a good backup.
cp "$DATA_FILE" "$target"
if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$target"; then
  rm -f "$target"
  echo "backup: $DATA_FILE did not parse as JSON, copy discarded" >&2
  exit 1
fi
chmod 600 "$target"
echo "backup: wrote $target ($(wc -c < "$target") bytes)"

# Keep the newest $KEEP copies.
ls -1t "$BACKUP_DIR"/results-*.json 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "backup: removed $old"
done

# Off-machine copy. BACKUP_REMOTE is any scp target, for example
# BACKUP_REMOTE=user@host:/backups/gad7-phq9
# gad7bot has no home directory and the unit hides /home anyway
# (ProtectHome=yes), so ~/.ssh is unreachable: the key and known_hosts live in
# the state directory instead.
SSH_DIR="${BACKUP_SSH_DIR:-/var/lib/gad7-phq9-bot/.ssh}"
if [ -n "${BACKUP_REMOTE:-}" ]; then
  if scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$SSH_DIR/known_hosts" -i "$SSH_DIR/id_ed25519" \
    "$target" "$BACKUP_REMOTE/"; then
    echo "backup: copied to $BACKUP_REMOTE"
  else
    echo "backup: scp to $BACKUP_REMOTE failed" >&2
    exit 1
  fi
fi
