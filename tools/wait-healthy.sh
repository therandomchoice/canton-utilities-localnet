#!/usr/bin/env bash
# Run a command (normally `docker compose up -d`) and wait until every container of the compose
# project is ready, failing fast with a diagnosis instead of hanging:
#
#   ready    healthcheck reports healthy; without a healthcheck: running, and for services given
#            with --probe the URL answers 200 (darsyncer: has logged that the ledger has all of its
#            packages); one-shot containers: exited with code 0
#   failed   OOM-killed, unhealthy, exited with an error, or crash-looping (restarted 3+ times)
#
# `docker compose up -d` itself blocks until dependencies are healthy, and splice retries its
# healthcheck 1000 times, so a crash loop would otherwise hang it for hours. The containers are
# therefore watched while the command runs, and the command is stopped on the first failure.
#
# --probe is for images without any tool a Docker healthcheck could run (hosted-backend is
# distroless: no shell, curl or wget). The URL is requested from the host, connecting to 127.0.0.1
# whatever the host name (so *.localhost works without /etc/hosts).
#
# Usage: tools/wait-healthy.sh <compose-project> [--exclude <service>]... [--probe <service>=<url>]...
#                              [-- <command...>]
# Env:   WAIT_TIMEOUT  seconds to wait once the first container runs (default 1200)
set -uo pipefail

project="${1:?usage: $0 <compose-project> [--exclude <service>]... [-- <command...>]}"
shift
excluded=" "
probes=" "
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude) excluded+="$2 "; shift 2 ;;
    --probe) probes+="$2 "; shift 2 ;;
    --) shift; break ;;
    *) echo "wait-healthy: unknown argument $1" >&2; exit 2 ;;
  esac
done
timeout="${WAIT_TIMEOUT:-1200}"
darsyncer_ready_msg="the ledger has all of our packages"

# Containers that exited before this point belong to an earlier run (UTC, as docker reports it)
script_start=$(date -u +%Y-%m-%dT%H:%M:%S)

cmd_pid=""
cmd_rc=0
if [ $# -gt 0 ]; then
  env "$@" &
  cmd_pid=$!
fi
cmd_running() { [ -n "$cmd_pid" ] && kill -0 "$cmd_pid" 2>/dev/null; }
stop_cmd() { cmd_running && { kill "$cmd_pid" 2>/dev/null; wait "$cmd_pid" 2>/dev/null; }; }
trap 'stop_cmd; exit 130' INT TERM

# State cached across polls as "id:value" words (bash 3.2 on macOS has no associative arrays)
baseline=" "        # restart count when first seen
ready_logs=" "      # darsyncers that have logged readiness / probed services that answered 200

lookup() { local w; for w in $1; do [ "${w%%:*}" = "$2" ] && { echo "${w#*:}"; return; }; done; }
probe_url() { local w; for w in $probes; do [ "${w%%=*}" = "$1" ] && { echo "${w#*=}"; return; }; done; }

diagnose() {
  local id="$1" name="$2" health_out
  echo
  echo "--- $name: $(docker inspect -f '{{.State.Status}}, exit code {{.State.ExitCode}}, restarts {{.RestartCount}}, OOM-killed {{.State.OOMKilled}}' "$id" 2>/dev/null)"
  health_out=$(docker inspect -f '{{with index .State "Health"}}{{range .Log}}{{.Output}}{{end}}{{end}}' "$id" 2>/dev/null | tail -5)
  [ -n "$health_out" ] && { echo "--- last healthcheck output:"; echo "$health_out"; }
  echo "--- last log lines (docker logs $name):"
  docker logs --tail 20 "$id" 2>&1 | sed 's/^/    /'
}

fail() {
  local id="$1" name="$2" reason="$3"; shift 3
  stop_cmd
  echo
  echo "wait-healthy: $name $reason"
  for hint in "$@"; do echo "  -> $hint"; done
  diagnose "$id" "$name"
  exit 1
}

# Record a container that is not ready yet; started ones are diagnosed on timeout or command failure
pend() {
  pending+=("$2")
  [ "$status" = "created" ] || pending_ids+=("$1")
}

diagnose_pending() {
  local id
  [ ${#pending_ids[@]} -gt 0 ] || return 0
  for id in "${pending_ids[@]}"; do
    diagnose "$id" "$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
  done
}

fmt_time() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

started_at=""
last_report=0
while :; do
  cmd_done=true
  cmd_running && cmd_done=false
  if $cmd_done && [ -n "$cmd_pid" ]; then
    wait "$cmd_pid"; cmd_rc=$?
    cmd_pid=""
  fi

  pending=()
  pending_ids=()
  total=0
  while read -r id name service status health exit_code oom restarts policy started finished; do
    [ -n "$id" ] || continue
    [[ "$excluded" == *" $service "* ]] && continue
    total=$((total + 1))
    base=$(lookup "$baseline" "$id")
    [ -n "$base" ] || { base=$restarts; baseline+="$id:$restarts "; }

    if [ "$oom" = "true" ]; then
      fail "$id" "$name" "was OOM-killed" \
        "the container hit its mem_limit (modules/localnet/resource-constraints.yaml) or Docker ran out of memory" \
        "give Docker more memory (16 GiB recommended), see make doctor"
    fi
    if [ "$health" = "unhealthy" ]; then
      fail "$id" "$name" "is unhealthy"
    fi
    if [ $((restarts - base)) -ge 3 ]; then
      fail "$id" "$name" "keeps restarting ($((restarts - base)) restarts)"
    fi
    if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
      if [ "$exit_code" -eq 0 ]; then continue; fi
      # Exited in an earlier run: the running command (compose up) is about to start it again
      if [ -n "$cmd_pid" ] && [[ "${finished:0:19}" < "$script_start" ]]; then
        pend "$id" "$name (not started yet)"; continue
      fi
      if [ "$policy" = "no" ] || [ -z "$policy" ] || [ "$status" = "dead" ]; then
        fail "$id" "$name" "exited with code $exit_code (at ${finished:0:19} UTC)"
      fi
    fi
    [ "$status" = "running" ] && [ -z "$started_at" ] && started_at=$(date +%s)

    if [ "$health" = "healthy" ]; then continue; fi
    if [ "$health" = "none" ] && [ "$status" = "running" ]; then
      if [ -n "$(lookup "$ready_logs" "$id")" ]; then continue; fi
      url=$(probe_url "$service")
      if [ -n "$url" ]; then
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 --connect-to ::127.0.0.1: "$url" </dev/null)
        if [ "$code" = "200" ]; then ready_logs+="$id:1 "; continue; fi
        pend "$id" "$name (HTTP $code)"
        continue
      fi
      case "$service" in
        darsyncer-*)
          if [ -n "$(docker logs --since "$started" "$id" </dev/null 2>&1 | grep -m1 "$darsyncer_ready_msg")" ]; then
            ready_logs+="$id:1 "; continue
          fi
          pend "$id" "$name (uploading DARs)" ;;
        *) continue ;;
      esac
    else
      if [ "$health" = "none" ]; then pend "$id" "$name ($status)"; else pend "$id" "$name ($health)"; fi
    fi
  done < <(ids=$(docker ps -aq --filter "label=com.docker.compose.project=${project}"); [ -n "$ids" ] && docker inspect -f \
    '{{.Id}} {{.Name}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{with index .State "Health"}}{{.Status}}{{else}}none{{end}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.RestartCount}} {{.HostConfig.RestartPolicy.Name}} {{.State.StartedAt}} {{.State.FinishedAt}}' $ids 2>/dev/null \
    | sed 's# /# #')

  # The command failed, but no container did above: show the ones that are still not ready
  if [ "$cmd_rc" -ne 0 ]; then
    echo
    echo "wait-healthy: command failed with exit code $cmd_rc${pending[*]:+; not ready: ${pending[*]}}" >&2
    diagnose_pending
    exit "$cmd_rc"
  fi

  if $cmd_done && [ "$total" -gt 0 ] && [ ${#pending[@]} -eq 0 ]; then
    echo "wait-healthy: all $total containers ready"
    exit 0
  fi

  now=$(date +%s)
  if [ -n "$started_at" ]; then
    elapsed=$((now - started_at))
    if [ "$elapsed" -ge "$timeout" ]; then
      stop_cmd
      echo
      echo "wait-healthy: not ready after $(fmt_time "$elapsed"): ${pending[*]:-}"
      echo "  -> raise the limit with WAIT_TIMEOUT=<seconds>, or check the containers below"
      diagnose_pending
      exit 1
    fi
    if [ ${#pending[@]} -gt 0 ] && [ $((now - last_report)) -ge 30 ]; then
      last_report=$now
      echo "wait-healthy: $(fmt_time "$elapsed") waiting for ${#pending[@]}: ${pending[*]}"
    fi
  fi
  sleep 3
done
