#!/bin/sh
# One-shot verification job (runs inside the same image as the API):
#   1. wait for the API to report healthy
#   2. code checks: syntax build + unit/integration test suite
#   3. end-to-end smoke: plaintext NDJSON and gzip NDJSON
# Exits non-zero (failing the compose service) if anything fails.
set -eu

API_BASE="${API_BASE:-http://api:8080}"

echo "== verify: waiting for API health at ${API_BASE}"
node scripts/wait-health.js "${API_BASE}" "${HEALTH_TIMEOUT_MS:-60000}"

echo "== verify: syntax build check"
for f in src/*.js scripts/*.js; do
  node --check "$f"
done

echo "== verify: code tests"
npm test

echo "== verify: end-to-end smoke (plaintext + gzip)"
node scripts/smoke.js "${API_BASE}"

echo "== verify: ALL CHECKS PASSED"
