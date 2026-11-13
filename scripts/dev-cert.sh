#!/usr/bin/env bash
# Development-only HTTPS for testing GPS on a phone on the same Wi-Fi. Never used for deployment.
# Creates a local CA + a server certificate for localhost and this machine's LAN IPv4 addresses in ./certs (git-ignored).
# Install certs/urban-pulse-dev-ca.crt on the phone as a trusted CA (manual step), then run: pnpm dev:https
# Usage: bash scripts/dev-cert.sh [extra-ip ...]
set -euo pipefail
export MSYS_NO_PATHCONV=1  # Git Bash on Windows would otherwise rewrite "/CN=..." into a file path
cd "$(dirname "$0")/.."
mkdir -p certs && cd certs

ips=$(ipconfig 2>/dev/null | grep -E 'IPv4' | sed -E 's/.*: *([0-9.]+).*/\1/' || true)
[ -z "$ips" ] && ips=$(hostname -I 2>/dev/null || true)
ips="127.0.0.1 $ips $*"
san="DNS:localhost"; for ip in $ips; do san="$san,IP:$ip"; done

if [ ! -f urban-pulse-dev-ca.key ]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 30 \
    -subj "/CN=Urban Pulse local dev CA (do not trust elsewhere)" \
    -keyout urban-pulse-dev-ca.key -out urban-pulse-dev-ca.crt
fi
openssl req -new -nodes -newkey rsa:2048 -subj "/CN=urban-pulse.local" -keyout dev.key -out dev.csr
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$san" > dev.ext
openssl x509 -req -in dev.csr -CA urban-pulse-dev-ca.crt -CAkey urban-pulse-dev-ca.key -CAcreateserial \
  -days 30 -sha256 -extfile dev.ext -out dev.crt
rm -f dev.csr dev.ext
echo "certs/dev.crt covers: $san"
echo "Trust on the phone: certs/urban-pulse-dev-ca.crt (valid 30 days). Then open https://<laptop-ip>:5173"
