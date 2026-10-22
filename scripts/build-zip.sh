#!/bin/sh
# Build deploy.zip: index.js only, fixed timestamp and mode, so the same index.js always gives the
# same bytes (on macOS and Linux). Prints the SHA-256 as hex and as base64; the base64 form is what
# Lambda reports as CodeSha256, so it shows whether a deployed version is this exact code.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp index.js "$tmp/index.js"
chmod 644 "$tmp/index.js"
TZ=UTC touch -t 202001010000 "$tmp/index.js"
rm -f deploy.zip
(cd "$tmp" && TZ=UTC zip -X -q -9 deploy.zip index.js)
mv "$tmp/deploy.zip" deploy.zip
echo "deploy.zip  sha256 $(openssl dgst -sha256 -r deploy.zip | cut -d' ' -f1)"
echo "CodeSha256  $(openssl dgst -sha256 -binary deploy.zip | base64)"
