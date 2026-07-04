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

echo "Installing codex-token-refresh script to /usr/local/bin/"
install -m 0755 "${SRC_DIR}/codex-token-refresh" /usr/local/bin/codex-token-refresh

echo "Installing hylo-post-deploy-gate script to /usr/local/bin/"
install -m 0755 "${SRC_DIR}/hylo-post-deploy-gate.sh" /usr/local/bin/hylo-post-deploy-gate

echo "Installing systemd units to /etc/systemd/system/"
install -m 0644 "${SRC_DIR}/nanoclaw-healthcheck.service" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/nanoclaw-healthcheck.timer" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/codex-token-refresh.service" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/codex-token-refresh.timer" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/hylo-post-deploy-gate.service" /etc/systemd/system/
install -m 0644 "${SRC_DIR}/hylo-post-deploy-gate.timer" /etc/systemd/system/

echo "Reloading systemd"
systemctl daemon-reload

echo "Enabling and starting timers"
systemctl enable --now nanoclaw-healthcheck.timer
systemctl enable --now codex-token-refresh.timer
systemctl enable --now hylo-post-deploy-gate.timer

echo
echo "Done. Verify with:"
echo "  systemctl list-timers nanoclaw-healthcheck.timer codex-token-refresh.timer"
echo "  journalctl -u nanoclaw-healthcheck.service --since '1 hour ago'"
echo "  journalctl -u codex-token-refresh.service --since '1 day ago'"
