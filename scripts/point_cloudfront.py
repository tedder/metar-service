#!/usr/bin/env python3
"""Point the CloudFront /metar* behavior's origin-request association at a Lambda version.

  point_cloudfront.py DISTRIBUTION_ID FUNCTION_VERSION_ARN [--dry-run]

Reads the distribution config, changes exactly one thing (the origin-request LambdaFunctionARN of
the /metar* cache behavior), checks that nothing else differs, and writes it back with the ETag it
read (so a concurrent change fails instead of being overwritten). --dry-run prints what would
change and writes nothing. Uses the aws CLI with whatever credentials are in the environment."""
import copy
import json
import subprocess
import sys
import tempfile

PATH_PATTERN = "/metar*"
EVENT = "origin-request"


def aws(*args):
    out = subprocess.run(["aws", *args, "--output", "json"], check=True, capture_output=True, text=True)
    return json.loads(out.stdout) if out.stdout.strip() else {}


def main():
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry = "--dry-run" in sys.argv[1:]
    if len(args) != 2:
        sys.exit(__doc__)
    dist, new_arn = args
    base = new_arn.rsplit(":", 1)[0]
    if not new_arn.rsplit(":", 1)[1].isdigit():
        sys.exit(f"{new_arn}: needs a numbered version (Lambda@Edge can't use $LATEST or an alias)")

    got = aws("cloudfront", "get-distribution-config", "--id", dist)
    etag, cfg = got["ETag"], got["DistributionConfig"]
    new = copy.deepcopy(cfg)

    behaviors = [b for b in new.get("CacheBehaviors", {}).get("Items", []) if b["PathPattern"] == PATH_PATTERN]
    if len(behaviors) != 1:
        sys.exit(f"expected one {PATH_PATTERN} behavior, found {len(behaviors)}")
    assocs = [a for a in behaviors[0].get("LambdaFunctionAssociations", {}).get("Items", [])
              if a["EventType"] == EVENT and a["LambdaFunctionARN"].rsplit(":", 1)[0] == base]
    if len(assocs) != 1:
        sys.exit(f"expected one {EVENT} association for {base}, found {len(assocs)}")
    old_arn = assocs[0]["LambdaFunctionARN"]
    assocs[0]["LambdaFunctionARN"] = new_arn

    # The only allowed difference: put the old ARN back and the configs must be identical.
    check = copy.deepcopy(new)
    for b in check["CacheBehaviors"]["Items"]:
        if b["PathPattern"] == PATH_PATTERN:
            for a in b["LambdaFunctionAssociations"]["Items"]:
                if a["LambdaFunctionARN"] == new_arn and a["EventType"] == EVENT:
                    a["LambdaFunctionARN"] = old_arn
    if check != cfg:
        sys.exit("refusing: the edited config differs from the original in more than the one ARN")

    print(f"{PATH_PATTERN} {EVENT}: {old_arn.rsplit(':', 1)[1]} -> {new_arn.rsplit(':', 1)[1]}"
          f"{' (no change)' if old_arn == new_arn else ''}")
    if dry or old_arn == new_arn:
        print("dry run: nothing written" if dry else "already there: nothing written")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(new, f)
    res = aws("cloudfront", "update-distribution", "--id", dist, "--if-match", etag,
              "--distribution-config", f"file://{f.name}")
    print(f"updated; distribution status {res['Distribution']['Status']}")


if __name__ == "__main__":
    main()
