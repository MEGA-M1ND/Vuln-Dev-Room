#!/usr/bin/env bash
# One-time provisioning for the Dev Room agent-runtime on a fresh Ubuntu VM.
# Run as root (or with sudo). Idempotent-ish: safe to re-run most steps.
#
# Usage: sudo bash setup-vm.sh <git-clone-url-with-token> <domain-or-nip.io-host>
set -euo pipefail

CLONE_URL="${1:?usage: setup-vm.sh <clone-url> <domain>}"
DOMAIN="${2:?usage: setup-vm.sh <clone-url> <domain>}"

echo "== apt packages =="
apt-get update
apt-get install -y --no-install-recommends \
  docker.io python3.11 python3.11-venv git curl ufw debian-keyring debian-archive-keyring apt-transport-https

echo "== Caddy (TLS termination) =="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "== service user =="
id -u devroom &>/dev/null || useradd --system --create-home --shell /bin/bash devroom
usermod -aG docker devroom
systemctl enable --now docker

echo "== firewall =="
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== clone repo =="
mkdir -p /opt/devroom
if [ ! -d /opt/devroom/app/.git ]; then
  sudo -u devroom git clone "$CLONE_URL" /opt/devroom/app
fi
cd /opt/devroom/app/services/agent-runtime

echo "== python venv =="
sudo -u devroom python3.11 -m venv .venv
sudo -u devroom .venv/bin/pip install --upgrade pip
sudo -u devroom .venv/bin/pip install -e ".[anthropic]"

echo "== sandbox image =="
docker build -f docker/sandbox.Dockerfile -t devroom-sandbox:prod .

echo "== demo repo fixture =="
mkdir -p /opt/devroom/repos
sudo -u devroom .venv/bin/python -c "from app.tests.fixtures.build_repo import build_demo_repo; print(build_demo_repo('/opt/devroom/repos'))"

echo "== Caddy reverse proxy =="
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
  reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "== systemd unit =="
cp deploy/agent-runtime.service /etc/systemd/system/agent-runtime.service
systemctl daemon-reload

echo
echo "Next: write /opt/devroom/app/services/agent-runtime/.env (see deploy/env.production.example),"
echo "then: systemctl enable --now agent-runtime && systemctl status agent-runtime"
echo "Public URL will be: https://${DOMAIN}"
