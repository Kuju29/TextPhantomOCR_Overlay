#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
node scripts/test-compat.mjs
node scripts/build.mjs
node scripts/validate.mjs
