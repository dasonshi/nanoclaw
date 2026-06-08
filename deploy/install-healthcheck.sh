#!/usr/bin/env bash
# Install the NanoClaw Telegram polling health check on a VPS.
# Run as root. Idempotent.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root (try: sudo $0)" >&2
  exit 1
fi

SRC_DIR=$(cd "$(dirname "$0")" && pwd)

echo "Installing nanoclaw-healthcheck script to /usr/local/bin/"
install -m 0755 "${SRC_DIR}/nanoclaw-healthcheck.sh" /usr/local/bin/nanoclaw-healthcheck

echo "Installing systemd units to /etc/systemd/system/"
install -m 0644 "${SRC_DIR}/nanoclaw-healthcheck.service" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/nanoclaw-healthcheck.timer" /etc/systemd/system/

echo "Reloading systemd"
systemctl daemon-reload

echo "Enabling and starting timer"
systemctl enable --now nanoclaw-healthcheck.timer

echo
echo "Done. Verify with:"
echo "  systemctl list-timers nanoclaw-healthcheck.timer"
echo "  journalctl -u nanoclaw-healthcheck.service --since '1 hour ago'"
