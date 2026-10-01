#!/usr/bin/env bash
# Mac mini self-host helper: Buzz relay (deploy/compose) behind a Cloudflare
# named tunnel. Run each step on the Mac mini, in order. Every step is safe to
# re-run; `env` never overwrites an existing deploy/compose/.env because its
# secrets must stay stable across restarts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_DIR="${REPO_ROOT}/deploy/compose"
ENV_FILE="${COMPOSE_DIR}/.env"
IMAGE="buzz-local:video"
TUNNEL_NAME="buzz"
TUNNEL_AGENT_LABEL="com.buzz.tunnel"
CLOUDFLARED_DIR="${HOME}/.cloudflared"

# Non-secret per-site defaults (committed). Secrets never live here.
BUZZ_HOSTNAME=""
BUZZ_OWNER=""
if [[ -f "${SCRIPT_DIR}/site.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/site.env"
fi

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"
}

# Accept an npub or 64-char hex pubkey and print hex.
pubkey_to_hex() {
  local input="$1"
  if [[ "${input}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "${input}" | tr 'A-F' 'a-f'
    return
  fi
  need python3 "Install Xcode command line tools: xcode-select --install"
  python3 - "${input}" <<'PY'
import sys

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk

s = sys.argv[1].strip().lower()
hrp, _, data = s.rpartition("1")
if hrp != "npub" or not data:
    sys.exit("not an npub or 64-char hex pubkey")
values = [CHARSET.find(c) for c in data]
if -1 in values:
    sys.exit("invalid npub characters")
expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
if polymod(expanded + values) != 1:
    sys.exit("npub checksum mismatch")
acc, bits, out = 0, 0, []
for v in values[:-6]:
    acc = (acc << 5) | v
    bits += 5
    while bits >= 8:
        bits -= 8
        out.append((acc >> bits) & 0xFF)
if len(out) != 32:
    sys.exit("npub does not decode to 32 bytes")
print(bytes(out).hex())
PY
}

set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    # `|` delimiter: values contain `/` (URLs) but never `|`.
    sed -i '' "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

cmd_prereqs() {
  need brew "Install Homebrew first: https://brew.sh"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing OrbStack (Docker runtime)…"
    brew install --cask orbstack
    echo "Open OrbStack once to finish setup, then re-run: $0 prereqs"
    exit 0
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Open OrbStack (or Docker Desktop)."
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required."
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "Installing cloudflared…"
    brew install cloudflared
  fi
  need openssl "It ships with macOS; check your PATH."
  echo "Prerequisites OK: $(docker compose version --short), $(cloudflared --version 2>&1 | head -1)"
}

cmd_env() {
  local domain="${1:-}" owner="${2:-}"
  if [[ "${domain}" == nsec1* || "${owner}" == nsec1* ]]; then
    die "that is a PRIVATE key (nsec). Never paste it anywhere. Use your PUBLIC key (npub1…), and treat this nsec as exposed: clear it from your shell history."
  fi
  # `env <owner>` alone: the hostname comes from site.env.
  if [[ -z "${owner}" && ( "${domain}" == npub1* || "${domain}" =~ ^[0-9a-fA-F]{64}$ ) ]]; then
    owner="${domain}"
    domain=""
  fi
  domain="${domain:-${BUZZ_HOSTNAME}}"
  owner="${owner:-${BUZZ_OWNER}}"
  [[ -n "${domain}" ]] || die "Usage: $0 env [hostname] <owner npub-or-hex> (or set BUZZ_HOSTNAME in site.env)"
  [[ -n "${owner}" ]] || die "Usage: $0 env [hostname] <owner npub-or-hex> (or set BUZZ_OWNER in site.env)"
  [[ "${domain}" != *"://"* ]] || die "pass a bare hostname (buzz.example.com), not a URL"
  if [[ -f "${ENV_FILE}" ]]; then
    die "${ENV_FILE} already exists. Its secrets must stay stable; edit it by hand instead of regenerating."
  fi
  local owner_hex
  owner_hex="$(pubkey_to_hex "${owner}")"

  cp "${COMPOSE_DIR}/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  set_env BUZZ_IMAGE "${IMAGE}"
  set_env BUZZ_DOMAIN "${domain}"
  set_env RELAY_URL "wss://${domain}"
  set_env BUZZ_MEDIA_BASE_URL "https://${domain}/media"
  set_env BUZZ_MEDIA_SERVER_DOMAIN "${domain}"
  set_env BUZZ_CORS_ORIGINS "https://${domain}"
  set_env RELAY_OWNER_PUBKEY "${owner_hex}"
  set_env BUZZ_RELAY_PRIVATE_KEY "$(openssl rand -hex 32)"
  set_env BUZZ_GIT_HOOK_HMAC_SECRET "$(openssl rand -hex 32)"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env REDIS_PASSWORD "$(openssl rand -hex 24)"
  set_env BUZZ_S3_ACCESS_KEY "$(openssl rand -hex 16)"
  set_env BUZZ_S3_SECRET_KEY "$(openssl rand -hex 32)"
  # Publish the relay on loopback only; the tunnel is the sole public ingress.
  set_env BUZZ_HTTP_PORT "127.0.0.1:3000"
  set_env BUZZ_HUDDLE_VIDEO_AVAILABLE "true"

  if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' "${ENV_FILE}"; then
    die "some CHANGE_ME values remain in ${ENV_FILE}"
  fi
  echo "Wrote ${ENV_FILE} (mode 600). Back it up somewhere safe: losing BUZZ_RELAY_PRIVATE_KEY breaks membership history."
}

cmd_build() {
  need docker "Run: $0 prereqs"
  local sha="unknown"
  sha="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "Building ${IMAGE} from ${REPO_ROOT} (first build takes a while)…"
  docker build --target runtime \
    --build-arg BUZZ_SOURCE_SHA="${sha}" \
    --build-arg BUZZ_BUILD_ID="macmini-$(date +%Y%m%d%H%M)" \
    -t "${IMAGE}" "${REPO_ROOT}"
}

cmd_start() {
  [[ -f "${ENV_FILE}" ]] || die "missing ${ENV_FILE}; run: $0 env <hostname> <owner>"
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "image ${IMAGE} not built; run: $0 build"
  "${COMPOSE_DIR}/run.sh" start
  curl -fsS "http://127.0.0.1:3000/_liveness" >/dev/null || die "relay is not answering on 127.0.0.1:3000"
  echo "Relay is up on http://127.0.0.1:3000"
}

cmd_tunnel() {
  local domain="${1:-${BUZZ_HOSTNAME}}"
  [[ -n "${domain}" ]] || die "Usage: $0 tunnel <hostname> (or set BUZZ_HOSTNAME in site.env)"
  need cloudflared "Run: $0 prereqs"
  if [[ ! -f "${CLOUDFLARED_DIR}/cert.pem" ]]; then
    echo "A browser will open: pick the Cloudflare zone that owns ${domain}."
    cloudflared tunnel login
  fi
  if ! cloudflared tunnel info "${TUNNEL_NAME}" >/dev/null 2>&1; then
    cloudflared tunnel create "${TUNNEL_NAME}"
  fi
  local tunnel_id
  tunnel_id="$(cloudflared tunnel list --output json | python3 -c \
    "import json,sys; print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='${TUNNEL_NAME}'))")"
  [[ -n "${tunnel_id}" ]] || die "could not resolve tunnel id for ${TUNNEL_NAME}"

  local config="${CLOUDFLARED_DIR}/config.yml"
  if [[ -f "${config}" ]] && ! grep -q "${tunnel_id}" "${config}"; then
    die "${config} exists for a different tunnel; move it aside and re-run"
  fi
  cat >"${config}" <<YAML
tunnel: ${tunnel_id}
credentials-file: ${CLOUDFLARED_DIR}/${tunnel_id}.json
ingress:
  - hostname: ${domain}
    service: http://127.0.0.1:3000
  - service: http_status:404
YAML
  cloudflared tunnel ingress validate --config "${config}"
  # Creates/updates the proxied CNAME ${domain} -> <tunnel-id>.cfargotunnel.com.
  if ! cloudflared tunnel route dns "${TUNNEL_NAME}" "${domain}"; then
    echo "warning: DNS route was not created. If ${domain} already has a DNS record," >&2
    echo "         delete it in the Cloudflare dashboard and re-run this step." >&2
  fi
  install_tunnel_agent "${config}"
  wait_for_tunnel
  echo "Tunnel ${TUNNEL_NAME} (${tunnel_id}) → https://${domain}"
}

# Run the named tunnel explicitly from our own login agent (with its own log
# file) rather than relying on the stock `cloudflared service install` agent's
# config discovery; remove the stock agent if present so only one runs.
install_tunnel_agent() {
  local config="$1"
  local uid
  uid="$(id -u)"
  if [[ -f "${HOME}/Library/LaunchAgents/com.cloudflare.cloudflared.plist" ]]; then
    cloudflared service uninstall >/dev/null 2>&1 \
      || launchctl bootout "gui/${uid}/com.cloudflare.cloudflared" 2>/dev/null \
      || true
    rm -f "${HOME}/Library/LaunchAgents/com.cloudflare.cloudflared.plist"
  fi

  local cloudflared_bin plist log_dir
  cloudflared_bin="$(command -v cloudflared)"
  plist="${HOME}/Library/LaunchAgents/${TUNNEL_AGENT_LABEL}.plist"
  log_dir="${HOME}/Library/Logs"
  mkdir -p "$(dirname "${plist}")" "${log_dir}"
  cat >"${plist}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${TUNNEL_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cloudflared_bin}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>${config}</string>
    <string>run</string>
    <string>${TUNNEL_NAME}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log_dir}/buzz-tunnel.log</string>
  <key>StandardErrorPath</key><string>${log_dir}/buzz-tunnel.log</string>
</dict>
</plist>
PLIST
  plutil -lint "${plist}" >/dev/null || die "generated ${plist} is not a valid plist"
  launchctl bootout "gui/${uid}/${TUNNEL_AGENT_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "${plist}"
}

wait_for_tunnel() {
  echo "Waiting for the tunnel to connect…"
  for _ in $(seq 1 15); do
    if ! cloudflared tunnel info "${TUNNEL_NAME}" 2>&1 | grep -q "does not have any active connection"; then
      echo "Tunnel connected."
      return
    fi
    sleep 2
  done
  echo "error: tunnel did not connect within 30s. cloudflared needs outbound" >&2
  echo "       TCP+UDP port 7844 to Cloudflare; look for 'precheck' failures below." >&2
  echo "       Last log lines:" >&2
  tail -20 "${HOME}/Library/Logs/buzz-tunnel.log" >&2 || true
  exit 1
}

cmd_check() {
  local domain="${1:-${BUZZ_HOSTNAME}}"
  [[ -n "${domain}" ]] || die "Usage: $0 check <hostname> (or set BUZZ_HOSTNAME in site.env)"
  echo "• Local liveness"
  curl -fsS "http://127.0.0.1:3000/_liveness" && echo || echo "FAILED: relay is not running (./deploy/macmini/setup.sh start)"
  echo "• Tunnel connection"
  cloudflared tunnel info "${TUNNEL_NAME}" 2>&1 | tail -3
  echo "• Public NIP-11 through the tunnel"
  local nip11
  if nip11="$(curl -fsS -H 'Accept: application/nostr+json' "https://${domain}")"; then
    echo "${nip11:0:400}"
  else
    echo "FAILED: 530 means the tunnel is not connected; see ~/Library/Logs/buzz-tunnel.log"
  fi
  echo "• Public WebSocket upgrade (expect HTTP/1.1 101 or 426, not 404/502)"
  curl -sS -o /dev/null -w '%{http_code}\n' --http1.1 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    --max-time 5 "https://${domain}/" || true
}

case "${1:-help}" in
  prereqs) cmd_prereqs ;;
  env) shift; cmd_env "$@" ;;
  build) cmd_build ;;
  start) cmd_start ;;
  tunnel) shift; cmd_tunnel "$@" ;;
  check) shift; cmd_check "$@" ;;
  *)
    cat <<MSG
Usage: $0 <step>

  prereqs                        Install/check OrbStack (Docker) and cloudflared
  env [hostname] <owner>         Generate deploy/compose/.env (owner = your npub or hex pubkey)
  build                          Build the relay image from this checkout (${IMAGE})
  start                          Start Postgres, Redis, MinIO and the relay
  tunnel [hostname]              Create the Cloudflare tunnel + DNS and run it at login
  check [hostname]               Verify the relay locally and through the tunnel

Omitted hostname/owner default to site.env (hostname: ${BUZZ_HOSTNAME:-unset}).

Day-2: ../compose/run.sh logs | status | restart | add-member <npub>
MSG
    ;;
esac
