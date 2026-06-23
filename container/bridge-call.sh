#!/usr/bin/env bash
# Bridge call wrapper — injects auth token without exposing it to the AI agent.
# Usage: bridge-call <method> <path> [json-body]

set -euo pipefail

BRIDGE_URL="http://host.docker.internal:18800"
TOKEN_FILE="/workspace/group/.bridge-token"

METHOD="${1:-GET}"
ENDPOINT="${2:-/health}"
BODY="${3:-}"

if [[ -f "$TOKEN_FILE" ]]; then
  BRIDGE_TOKEN="$(cat "$TOKEN_FILE" | tr -d '[:space:]')"
else
  echo '{"error":"No bridge token found. Contact support."}' >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer ${BRIDGE_TOKEN}"

case "$ENDPOINT" in
  /execute/*|/connections*)
    if [[ -n "$BODY" ]]; then
      exec curl -s -X "$METHOD" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "$BODY" \
        "${BRIDGE_URL}${ENDPOINT}"
    else
      exec curl -s -X "$METHOD" \
        -H "$AUTH_HEADER" \
        "${BRIDGE_URL}${ENDPOINT}"
    fi
    ;;
  *)
    if [[ -n "$BODY" ]]; then
      exec curl -s -X "$METHOD" \
        -H "Content-Type: application/json" \
        -d "$BODY" \
        "${BRIDGE_URL}${ENDPOINT}"
    else
      exec curl -s "${BRIDGE_URL}${ENDPOINT}"
    fi
    ;;
esac
