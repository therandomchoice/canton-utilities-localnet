#!/usr/bin/env bash
# Check the host before starting the localnet: tools, Docker daemon, Compose, memory, disk, free
# ports, *.localhost resolution. Prints a hint for every problem; exits 1 if anything would stop
# `make up` from working.
#
# Usage: <docker compose ... config --format json> | tools/doctor.sh <compose-project>
# (stdin is optional; without it the memory and port checks are skipped)
set -uo pipefail

project="${1:?usage: $0 <compose-project>}"
config=""
[ -t 0 ] || config=$(cat)

if [ -t 1 ]; then
  ok_tag=$'\e[32mok\e[0m  '; warn_tag=$'\e[33mwarn\e[0m'; fail_tag=$'\e[31mFAIL\e[0m'
else
  ok_tag="ok  "; warn_tag="warn"; fail_tag="FAIL"
fi
failures=0
warnings=0

ok()   { echo "  $ok_tag  $1"; }
warn() { echo "  $warn_tag  $1"; shift; for h in "$@"; do echo "        -> $h"; done; warnings=$((warnings + 1)); }
fail() { echo "  $fail_tag  $1"; shift; for h in "$@"; do echo "        -> $h"; done; failures=$((failures + 1)); }

gib() { LC_ALL=C awk -v b="$1" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }

# version_ge 22.18.0 22.18 -> true
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

echo "Checking host for the localnet"

# --- tools ---------------------------------------------------------------------------------------
for tool in bash curl make; do
  if command -v "$tool" >/dev/null; then ok "$tool found"; else fail "$tool not found" "install $tool"; fi
done

# --- docker --------------------------------------------------------------------------------------
docker_ok=false
if ! command -v docker >/dev/null; then
  fail "docker not found" "install Docker Engine or Docker Desktop: https://docs.docker.com/get-docker/"
elif ! docker info >/dev/null 2>&1; then
  err=$(docker info 2>&1 | grep -iE 'permission denied|cannot connect|error' | head -1)
  if [[ "$err" == *"permission denied"* ]]; then
    fail "no permission to use the Docker daemon" \
      "add your user to the docker group: sudo usermod -aG docker \$USER, then log in again"
  else
    fail "Docker daemon is not reachable${err:+ ($err)}" "start Docker (Docker Desktop, or: sudo systemctl start docker)"
  fi
else
  docker_ok=true
  ok "Docker daemon $(docker version --format '{{.Server.Version}}' 2>/dev/null) reachable"
fi

compose_version=""
if command -v docker >/dev/null; then
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//')
fi
if [ -z "$compose_version" ]; then
  fail "Docker Compose v2 plugin not found (docker compose)" \
    "install the compose plugin: https://docs.docker.com/compose/install/"
elif ! version_ge "$compose_version" 2.24.0; then
  fail "Docker Compose $compose_version is too old" "update to Compose 2.24 or newer"
else
  ok "Docker Compose $compose_version"
fi

running=""
if $docker_ok; then
  running=$(docker ps -q --filter "label=com.docker.compose.project=${project}")
fi

# --- memory --------------------------------------------------------------------------------------
if $docker_ok; then
  mem_total=$(docker info --format '{{.MemTotal}}' 2>/dev/null)
  limits=$(grep -oE '"mem_limit": "?[0-9]+' <<<"$config" | grep -oE '[0-9]+$' | awk '{ s += $1 } END { print s + 0 }')
  min_mem=$((8 * 1024 * 1024 * 1024))
  if ! [[ "$mem_total" =~ ^[0-9]+$ ]]; then
    warn "could not determine Docker's memory (docker info reported '${mem_total}')" \
      "make sure Docker has at least 8 GiB, 16 GiB recommended"
  elif [ "$mem_total" -lt "$min_mem" ]; then
    fail "Docker has $(gib "$mem_total") of memory, at least 8 GiB is needed" \
      "Docker Desktop: Settings -> Resources -> Memory; below this canton/splice get OOM-killed and never become healthy"
  elif [ "$limits" -gt 0 ] && [ "$mem_total" -lt "$limits" ]; then
    warn "Docker has $(gib "$mem_total") of memory, container limits add up to $(gib "$limits") (plus PQS and hosted-backend)" \
      "it usually starts, but give Docker 16 GiB if containers get OOM-killed"
  else
    ok "Docker has $(gib "$mem_total") of memory"
  fi
fi

# --- disk ----------------------------------------------------------------------------------------
if $docker_ok; then
  root_dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  free_kb=$(df -Pk "$root_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
  if [ -n "$free_kb" ]; then
    free=$((free_kb * 1024))
    if [ "$free" -lt $((20 * 1024 * 1024 * 1024)) ]; then
      warn "$(gib "$free") free in $root_dir, images and ledger data need about 20 GiB" \
        "free space, e.g. docker system prune (removes unused images and stopped containers)"
    else
      ok "$(gib "$free") free in $root_dir"
    fi
  fi
fi

# --- ports ---------------------------------------------------------------------------------------
ports=$(grep -oE '"published": "[0-9]+"' <<<"$config" | grep -oE '[0-9]+' | sort -un)
if [ -n "$running" ]; then
  ok "ports: the localnet is already running, port check skipped"
elif [ -n "$ports" ]; then
  busy=()
  for port in $ports; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then busy+=("$port"); fi
  done
  if [ ${#busy[@]} -eq 0 ]; then
    ok "ports free: $(echo $ports)"
  else
    owners=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E ":($(IFS='|'; echo "${busy[*]}"))->" \
      | awk '{ print $1 }' | sort -u | tr '\n' ' ')
    fail "ports in use: ${busy[*]}" \
      ${owners:+"held by containers: ${owners}(another localnet? stop it first)"} \
      "find the process: ss -ltnp | grep -E ':($(IFS='|'; echo "${busy[*]}"))\\b'  (macOS: lsof -iTCP -sTCP:LISTEN -P)"
  fi
fi

# --- *.localhost ---------------------------------------------------------------------------------
hosts=(utility.localhost wallet.localhost scan.localhost sv.localhost canton.localhost)
resolve() {
  if command -v getent >/dev/null; then
    getent ahostsv4 "$1" 2>/dev/null | awk 'NR == 1 { print $1 }'
  elif command -v dscacheutil >/dev/null; then
    dscacheutil -q host -a name "$1" 2>/dev/null | awk '/ip_address/ { print $2; exit }'
  fi
}
if command -v getent >/dev/null || command -v dscacheutil >/dev/null; then
  unresolved=()
  for h in "${hosts[@]}"; do
    ip=$(resolve "$h")
    [[ "$ip" == 127.* ]] || unresolved+=("$h")
  done
  if [ ${#unresolved[@]} -eq 0 ]; then
    ok "*.localhost resolves to 127.0.0.1"
  else
    warn "not resolved to 127.0.0.1: ${unresolved[*]}" \
      "browsers handle *.localhost themselves, but the examples (Node) need it: add to /etc/hosts:" \
      "127.0.0.1 ${unresolved[*]}"
  fi
fi

# --- node (examples only) ------------------------------------------------------------------------
if command -v node >/dev/null; then
  node_version=$(node --version | sed 's/^v//')
  if version_ge "$node_version" 22.18.0; then
    ok "Node.js $node_version (examples)"
  else
    warn "Node.js $node_version is too old for the examples" "install Node.js 22.18+ (runs TypeScript directly)"
  fi
else
  warn "Node.js not found, needed only for the examples" "install Node.js 22.18+"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures problem(s) must be fixed before make up, $warnings warning(s)"
  exit 1
fi
if [ "$warnings" -gt 0 ]; then echo "Ready to start ($warnings warning(s))"; else echo "Ready to start"; fi
