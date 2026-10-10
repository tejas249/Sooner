#!/usr/bin/env bash
# Post-deploy smoke test for the live Sooner site.
#
#   EXPECTED_SHA=<commit> bash scripts/smoke-test.sh <host>        for example: sooner.vercel.app
#
# With EXPECTED_SHA set, /api/health must report that exact commit. That proves the public address serves the build that was
# just pushed rather than a stale one. Exits non-zero and says what failed.
#
# Tunables (env): SMOKE_RETRIES (default 18) and SMOKE_DELAY seconds (default 5). A domain's alias can trail the
# "deployment ready" event by a few seconds, so the health check retries before giving up. SMOKE_SCHEME (default https) is
# there so the script can be tested against a local server.
set -uo pipefail

HOST="${1:?usage: scripts/smoke-test.sh <host>}"
EXPECTED="${EXPECTED_SHA:-}"
EXPECTED="${EXPECTED:0:7}"
RETRIES="${SMOKE_RETRIES:-18}"
DELAY="${SMOKE_DELAY:-5}"
SCHEME="${SMOKE_SCHEME:-https}"
BASE="$SCHEME://$HOST"

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

STATUS=000
BODY=""
# fetch URL -> sets STATUS (HTTP code, 000 if the request itself failed) and BODY
fetch() {
  local out
  if out=$(curl -sS -m 15 -w $'\n%{http_code}' "$1" 2>&1); then
    STATUS=${out##*$'\n'}
    BODY=${out%$'\n'*}
  else
    STATUS=000
    BODY=$out
  fi
}

json_field() { python3 -c 'import sys, json; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null; }

check_health() {
  local attempt commit env
  for attempt in $(seq 1 "$RETRIES"); do
    fetch "$BASE/api/health"
    if [[ $STATUS == 200 ]]; then
      commit=$(printf '%s' "$BODY" | json_field commit)
      env=$(printf '%s' "$BODY" | json_field env)
      if [[ $env == production && ( -z $EXPECTED || $commit == "$EXPECTED" ) ]]; then
        pass "/api/health -> commit $commit ($env)"
        return
      fi
    fi
    sleep "$DELAY"
  done
  fail "/api/health did not report commit ${EXPECTED:-<any>} in production (last: HTTP $STATUS ${BODY:0:120})"
}

check_page() { # path, text the page must contain, label
  fetch "$BASE$1"
  if [[ $STATUS == 200 && $BODY == *"$2"* ]]; then
    pass "$3"
  else
    fail "$3 (HTTP $STATUS, expected the page to contain \"$2\")"
  fi
}

check_status() { # path, expected HTTP status, label
  local code
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BASE$1" 2>/dev/null)
  if [[ $code == "$2" ]]; then pass "$3"; else fail "$3 (got HTTP $code, expected $2)"; fi
}

check_header() { # path, header name, text its value must contain, label
  local value
  value=$(curl -sS -m 15 -D - -o /dev/null "$BASE$1" 2>/dev/null | tr -d '\r' | awk -v h="$(printf '%s' "$2" | tr 'A-Z' 'a-z'):" 'tolower($1)==h { $1=""; print; exit }')
  if [[ $value == *"$3"* ]]; then pass "$4"; else fail "$4 (header $2 was \"${value:-missing}\", expected it to contain \"$3\")"; fi
}

echo "Smoke test: $HOST (expected commit: ${EXPECTED:-any})"

check_health
check_page "/" "Know when a role opens" "home page renders"
check_page "/" "Companies it watches" "home page lists the companies"
check_page "/robots.txt" "Disallow: /api/" "robots.txt keeps crawlers off the API"
check_status "/this-page-does-not-exist" 404 "an unknown page returns 404"

check_header "/" "Content-Security-Policy" "frame-ancestors 'none'" "sends a Content-Security-Policy that forbids framing"
check_header "/" "Strict-Transport-Security" "max-age=" "sends HSTS"
check_header "/" "X-Content-Type-Options" "nosniff" "sends nosniff"

if ((failures > 0)); then
  printf '\n%d check(s) failed.\n' "$failures"
  exit 1
fi
printf '\nAll checks passed.\n'
