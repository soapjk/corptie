#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export CORPTIE_PRODUCTION_SCRIPT_SOURCE_ONLY=true
export CORPTIE_PRODUCTION_SESSION_POLL_SECONDS=1
source "${ROOT}/scripts/rebuild-install-restart-production.sh"

assert_count() {
  local expected="$1" needle="$2" haystack="$3" actual
  actual="$(grep -F -c "${needle}" <<<"${haystack}" || true)"
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'Expected %s occurrences of %q, got %s.\nOutput:\n%s\n' \
      "${expected}" "${needle}" "${actual}" "${haystack}" >&2
    exit 1
  fi
}

run_wait_scenario() {
  local scenario="$1" state_file output
  state_file="$(mktemp)"
  printf '0\n' >"${state_file}"

  production_is_running() { return 0; }
  sleep() { :; }
  unfinished_sessions() {
    local step
    step="$(( $(<"${state_file}") + 1 ))"
    printf '%s\n' "${step}" >"${state_file}"
    case "${scenario}:${step}" in
      availability:1) printf 'session:a\tAlpha\trunning\tbusy\n' ;;
      availability:2) printf 'session:a\tAlpha\tblocked\twaiting\n' ;;
      availability:3|availability:4)
        echo "raw transport error that must stay hidden" >&2
        return 1
        ;;
      availability:5) printf 'session:a\tAlpha\trunning\tbusy\n' ;;
      availability:6) return 0 ;;
      membership:1) printf 'session:a\tAlpha\trunning\tbusy\nsession:b\tBeta\trunning\tbusy\n' ;;
      membership:2) printf 'session:b\tBeta\trunning\tbusy\nsession:a\tAlpha\tblocked\twaiting\n' ;;
      membership:3) printf 'session:a\tAlpha\trunning\tbusy\n' ;;
      membership:4) return 0 ;;
      *) echo "Unexpected scenario step: ${scenario}:${step}" >&2; return 1 ;;
    esac
  }

  output="$(wait_for_production_sessions 2>&1)"
  rm -f "${state_file}"
  printf '%s' "${output}"
}

availability_output="$(run_wait_scenario availability)"
assert_count 1 "installation is waiting" "${availability_output}"
assert_count 1 "installation remains paused" "${availability_output}"
assert_count 1 "inspection is available again" "${availability_output}"
assert_count 1 "All production sessions are finished" "${availability_output}"
assert_count 0 "raw transport error" "${availability_output}"

membership_output="$(run_wait_scenario membership)"
assert_count 2 "installation is waiting" "${membership_output}"
assert_count 1 "session:b" "${membership_output}"
assert_count 1 "All production sessions are finished" "${membership_output}"

echo "production session wait logging tests passed"
