#!/bin/sh
# Invoke a published Lambda version directly with sample CloudFront events and check the answers.
#   ./deploy/smoke-test.sh FUNCTION_NAME VERSION
# help.json must return the CSV header row (no network); kpdx.json must return a line per airport
# with a flight category (calls AWC, so it also proves the version can reach upstream).
set -eu
fn=$1; ver=$2
cd "$(dirname "$0")/events"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
for ev in help kpdx; do
  aws lambda invoke --region us-east-1 --function-name "$fn" --qualifier "$ver" \
    --cli-binary-format raw-in-base64-out --payload "file://$ev.json" "$out/$ev.json" \
    --query FunctionError --output text > "$out/$ev.err"
  if [ "$(cat "$out/$ev.err")" != "None" ]; then echo "$ev: function error: $(cat "$out/$ev.json")" >&2; exit 1; fi
done
python3 - "$out" <<'PY'
import json, re, sys
d = sys.argv[1]
h = json.load(open(f"{d}/help.json"))
assert h["status"] == "200", h
assert re.search(r"^icao,cat,r-g-b,age_mins,stale,wdir,wspd,wgst$", h["body"], re.M), "help: no header row"
k = json.load(open(f"{d}/kpdx.json"))
assert k["status"] == "200", f"kpdx: status {k['status']}: {k.get('body')}"
lines = k["body"].splitlines()
assert [l.split(",")[0] for l in lines] == ["KPDX", "KSEA"], f"kpdx: {lines}"
assert all(l.split(",")[1] in ("VFR", "MVFR", "IFR", "LIFR") for l in lines), f"kpdx: no category: {lines}"
print("smoke test OK: help header row; " + "; ".join(lines))
PY
