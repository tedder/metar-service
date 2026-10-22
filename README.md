# metar-service

A small METAR proxy for LED weather maps. A device asks for a list of airports; the service fetches
the current METARs from the National Weather Service's Aviation Weather Center (AWC, the data API at
`https://aviationweather.gov/api/data/metar`), works out each airport's flight category
(VFR, MVFR, IFR, LIFR), and answers with one short line per airport: category, an LED color, the
report's age, a stale flag and the wind. The device sets its LEDs straight from that answer.

It runs as an AWS Lambda@Edge function behind a CloudFront cache behavior, so most requests are
answered from the cache and the function runs only on a cache miss. There is no other server and
no database. This repository is the code; it does not point at a running instance.

## Why

A microcontroller that talks to AWC directly has to:

- make HTTPS requests (which needs a TLS stack, enough memory and a correct clock, so NTP first);
- parse AWC's JSON, including visibility strings like `1 1/4` and `10+` and cloud layer lists;
- split long airport lists into batches to keep URLs and memory small;
- carry the flight category rules itself.

With this service the device sends one plain HTTP GET and reads back a few bytes of CSV. The parsing
and the category rules live here, in tested JavaScript, and devices that ask for the same airports
share one cached answer.

## How it works

```
device
  |  GET /metar?ids=KPDX,KHIO,KTTD&boardid=...&output=csv
  v
CloudFront cache behavior (/metar*)
  |  cache key: ids, boardid, output, help (other query parameters are passed on but not keyed)
  |  TTL: 300 s
  |
  +-- cache hit  -> answered from the edge; the function does not run
  |
  +-- cache miss -> Lambda@Edge, origin-request trigger (index.handler)
                      |  HTTPS to aviationweather.gov, up to 10 airports per request
                      |  per airport: category, LED color, age, stale, wind
                      v
                    synthetic 200 response, Cache-Control: max-age=300
```

The function never forwards to a real origin: it builds the response itself and returns it from
the origin-request event, which CloudFront then caches.

## API

### Request

`GET /metar?ids=<ICAO,ICAO,...>[&boardid=<id>][&output=csv|json][&help=1]`

| Parameter | Meaning |
|---|---|
| `ids` | Comma-separated ICAO codes, any number. Trimmed and uppercased. Entries longer than 4 characters, `NULL`, and anything starting with `OFF` are dropped (LED maps use those as placeholders for unlit positions). Without any valid code, the service returns the help text. |
| `boardid` | Optional device identifier, used as given (not shortened; current clients send 12 hex characters). Logged; part of the cache key, so per-device answers stay separate once gating exists. |
| `output` | `csv` (default) or `json`. |
| `help` | `1` returns documentation instead of data (no upstream request). |

Clients may add their own parameters (the ESP32 weather glass sends `debug` flags, `fw`, `t`
telemetry and `localip`). CloudFront forwards only `ids`, `boardid`, `output` and `help` to the
function, so it never sees the others: they appear only in CloudFront's access logs, for every
request including cache hits, which is the place to watch a fleet from.

### Response (CSV, default)

One line per requested airport, **in the order requested**, with no header row:

```
KPDX,VFR,0-127-0,8,0,280,9,
KHIO,MVFR,0-0-127,8,0,0,0,
KTTD,IFR,127-0-0,62,0,VRB,4,
K7S3,,75-75-50,,1,,,
```

| Column | Meaning |
|---|---|
| `icao` | Airport code as requested. |
| `cat` | `VFR`, `MVFR`, `IFR`, `LIFR`; empty if AWC had no report. |
| `r-g-b` | LED color as decimal `R-G-B`, 0-255 each. |
| `age_mins` | Minutes since the observation; empty if unknown. |
| `stale` | `1` if the report is older than 90 minutes or its age is unknown, else `0`. |
| `wdir` | Wind direction in degrees true, `VRB` for variable, `0` with `wspd` 0 for calm. |
| `wspd` | Wind speed, knots. |
| `wgst` | Gust, knots; empty if none. |

An airport AWC doesn't return still gets a line: empty category, color `75-75-50` (dim), `stale` 1.

### Response (JSON)

`output=json` returns an array in the same order:

```json
[
  {"icao": "KPDX", "cat": "VFR", "color": [0, 127, 0], "age_mins": 8, "stale": false,
   "wdir": 280, "wspd": 9, "wgst": null}
]
```

### Help

`help=1`, or no valid `ids`, returns the parameter and column descriptions: as `#` comment lines
followed by the CSV header row for `output=csv`, or as an object for `output=json`. Help responses
never call AWC.

### Errors

If AWC answers with an error status or unparseable JSON, the whole request returns
`502 Bad Gateway` with `{"error": "upstream fetch failed"}`, and the details go to the log. An empty
AWC answer (no reports for a batch) is not an error: those airports come back as missing. A report
that fails to process is logged and that airport comes back as missing; the rest of the batch is
unaffected.

## Flight categories

Categories and colors follow FAA Advisory Circular AC 00-45H (Change 2), Table 3-14, "Station Plot
Weather Categories":

| Category | LED color (R-G-B) | Ceiling (ft AGL) | | Visibility (statute miles) |
|---|---|---|---|---|
| LIFR | magenta `255-22-199` | below 500 | and/or | less than 1 |
| IFR | red `127-0-0` | 500 to below 1,000 | and/or | 1 to less than 3 |
| MVFR | blue `0-0-127` | 1,000 to 3,000 inclusive | and/or | 3 to 5 inclusive |
| VFR | green `0-127-0` | above 3,000 | and | above 5 |

- **AWC's category first.** AWC computes the same table and returns it as `fltCat`. When that is one
  of the four categories the service uses it; otherwise it computes its own (`flightCategory()`).
- **Ceiling** is the lowest `BKN`, `OVC` or `OVX` (vertical visibility) layer. `FEW`, `SCT`, `SKC`,
  `CLR` and `CAVOK` are not ceilings.
- **Visibility** accepts numbers, `10+` (10), whole numbers with trailing text, and fractions such as
  `1/2` and `1 1/4`.
- **The worse of ceiling and visibility wins.** A missing value doesn't count against the airport.
- Through Lambda version 14 the MVFR upper bounds were exclusive, so 3,000 ft or 5 SM showed as VFR.
  That was fixed in version 15 and is covered by edge-case tests.

## Caching

- The function sets `Cache-Control: max-age=300` on data and help responses. The 502 error response
  carries no cache header.
- The CloudFront cache policy should key on `ids`, `boardid`, `output` and `help` only. Keying on
  anything else (telemetry, debug) would make every request a miss.
- The order of `ids` is part of the key. A map always sends its airports in LED order, so after the
  first miss in each 5-minute window its requests are cache hits.
- `boardid` is keyed so that per-device answers (for example refusing unknown boards) stay correct
  once gating exists.

## Logging

Everything goes to CloudWatch Logs as one JSON object per line. Lambda@Edge writes its logs in the
region of the edge location that ran it, so look in the region nearest the devices.

| Event | When |
|---|---|
| (request line) | every data request: the forwarded query parameters, the parsed `ids`, count, `elapsed_ms` |
| `upstream_error` | AWC answered with a non-2xx status (URL, status, first 2,000 bytes of the body) |
| `upstream_parse_error` | AWC's body was not JSON |
| `metar_process_error` | one report failed to process (the raw report is included) |
| `handler_error` | the request failed and returned 502 (message, stack, parameters) |

Cache hits never reach the function, so they appear only in CloudFront's own access logs, along
with any query parameters the origin request policy doesn't forward.

## Packaging

The deployment package is a zip containing `index.js` alone, about 10 KB. Nothing else belongs in it:

- **No dependencies.** The code has no `require()` calls; `fetch` and `URLSearchParams` are built into
  Node 18 and later, so there is no `node_modules` and no `package.json`.
- **No minifying.** Lambda@Edge allows 50 MB for origin-request functions and a 10 KB file loads in
  no measurable time, while minified code would make the stack traces in the error log unreadable.
- Tests, docs and the workflow stay out of the zip.

`scripts/build-zip.sh` builds it with a fixed timestamp and file mode, so the same `index.js` always
gives the same bytes, on macOS and Linux alike. It prints the SHA-256 in hex and in base64; the
base64 form is what Lambda reports as `CodeSha256`, which shows whether a deployed version is
exactly this code. `node scripts/check-zip.js` checks that the zip holds only `index.js`, that it
matches the repo, and that the zipped handler loads and answers a help request.

## Running your own

1. **Function.** Create a Node.js Lambda in `us-east-1` (a Lambda@Edge requirement) with handler
   `index.handler`, 128 MB, and a timeout of a few seconds (AWC normally answers in well under one).
   The deployed function uses the `nodejs24.x` runtime. Give it an execution role that
   `edgelambda.amazonaws.com` and `lambda.amazonaws.com` can both assume, with basic logging
   permissions. Deploy the zip that CI built for the commit (the `deploy-zip-<sha>` artifact of
   that commit's run), or build the same bytes locally:

   ```sh
   gh run download <run-id> -n deploy-zip-<sha>     # or: ./scripts/build-zip.sh
   aws lambda update-function-code --region us-east-1 --function-name metar-service \
     --zip-file fileb://deploy.zip --publish --query '[Version,CodeSha256]'
   ```

   `--publish` creates a numbered version. Lambda@Edge needs a version, not `$LATEST`. The
   `CodeSha256` it prints should equal the one `build-zip.sh` printed.

2. **CloudFront.** Add a cache behavior for `/metar*` to a distribution, with an origin-request
   association to the function version from step 1. Allow HTTP as well as HTTPS for the viewer
   protocol, since the point is to serve devices without TLS. Use a cache policy whose query-string
   whitelist is `ids`, `boardid`, `output`, `help` (TTL min 0, default and max 300 s), and an origin
   request policy that forwards the same four. Turn on CloudFront access logs if you want the
   client telemetry parameters, since the function doesn't receive them.

3. **Test the version before switching to it.** Invoke the new version with a sample CloudFront
   origin-request event, check the response, then point the behavior's association at it. To roll
   back, point the association at the previous version.

Replication to the edge takes a few minutes after an association changes.

## Deploying with GitHub Actions

`.github/workflows/deploy.yml` deploys from this repository. It is manual only (run it from the
Actions tab or `gh workflow run deploy.yml -f mode=dry-run`) and has three modes:

| Mode | What it does |
|---|---|
| `dry-run` (default) | Assumes the AWS role, runs the tests, builds and checks the zip, validates the code update with Lambda's `--dry-run` (nothing changes) and checks that its `CodeSha256` matches the build, smoke-tests the version CloudFront serves now, and prints what the CloudFront change would be. |
| `deploy` | Publishes the zip as a new Lambda version, checks its `CodeSha256` against the build, smoke-tests the new version, points the `/metar*` behavior at it and waits for CloudFront to finish. |
| `rollback` | Smoke-tests an existing version (the `version` input) and points `/metar*` back at it. |

The smoke test (`deploy/smoke-test.sh`) invokes the version directly with two sample CloudFront
events from `deploy/events/`: a help request, which must return the CSV header row, and a request
for two airports, which must return a category for each (so the version can reach AWC). The
CloudFront step (`scripts/point_cloudfront.py`) changes only the origin-request ARN of the
`/metar*` behavior, refuses if anything else in the config would differ, and writes with the
config's ETag so a concurrent change fails instead of being overwritten.

**Who can run it.** On a public repository only people with write access can start a manual
workflow, and pull requests from forks never receive secrets. The job also runs in the
`production` environment, which allows only the `main` branch and needs a required reviewer to
approve each run. AWS access uses GitHub's OIDC token: the role trusts only
`repo:<owner>/<repo>:environment:production` (`deploy/iam/trust.json`), so no other repository,
branch or workflow can assume it, and no AWS keys are stored. Its permissions
(`deploy/iam/permissions.json`) cover publishing, reading and invoking this one function and
reading and updating this one distribution. Account and distribution IDs are environment secrets
and are masked in the logs. Third-party actions are pinned to commit SHAs.

**One-time setup.**

1. AWS: `CF_DISTRIBUTION_ID=E... ./deploy/setup-aws.sh` with credentials that can manage IAM. It
   creates the GitHub OIDC provider if the account has none, and the role
   `metar-service-github-deploy` with the two policies, and prints the role ARN.
2. GitHub: create the environment `production`, add yourself as a required reviewer, and limit
   deployment branches to `main`. Add two environment secrets: `AWS_ROLE_ARN` (from step 1) and
   `CF_DISTRIBUTION_ID`.
3. Run the workflow in `dry-run` mode and approve it; every step should pass before the first
   `deploy`.

**Deploying a change.**

1. Merge the change to `main` and check that [CI](https://github.com/tedder/metar-service/actions/workflows/ci.yml)
   passes on that commit.
2. Open the [deploy workflow](https://github.com/tedder/metar-service/actions/workflows/deploy.yml),
   choose **Run workflow**, leave the branch on `main` and the mode on `dry-run`, and run it. From
   a shell: `gh workflow run deploy.yml -R tedder/metar-service -f mode=dry-run`.
3. The run waits for approval. Open it, choose **Review deployments**, tick `production` and
   approve. Every step should pass; the run summary shows the live version, the build's
   `CodeSha256` and the CloudFront change it would make (for example `/metar* origin-request: 15 -> 16`).
4. Run the workflow again with mode `deploy` (`gh workflow run deploy.yml -R tedder/metar-service -f mode=deploy`)
   and approve it. The summary shows the new version number, and the run ends after CloudFront
   reports the distribution deployed (usually a few minutes).
5. Check a request through CloudFront, for example `?ids=KPDX` on your service URL, and check that the response has a row for KPDX.

**Rolling back.** Run the workflow with mode `rollback` and `version` set to the Lambda version
to return to (the previous one is in the deploy run's summary as "was N"):
`gh workflow run deploy.yml -R tedder/metar-service -f mode=rollback -f version=N`, then approve
it. Rollback publishes nothing; it smoke-tests that version and points `/metar*` back at it.
Old versions are never deleted by the workflow, so any earlier version can be used.

If a run fails before the CloudFront step, nothing user-facing has changed: a failed `deploy`
may leave a new published version, which is harmless and unused. If the CloudFront step fails
after the update was accepted (for example while waiting), the new version still goes live; the
next run's "Current state" step shows which version CloudFront serves.

## Development

There are no dependencies and no build step: `index.js` is the function, and `index.test.js` uses
Node's built-in test runner.

```sh
node --test
```

Without a local Node install:

```sh
docker run --rm -v "$PWD":/app:ro -w /app node:24-alpine node --test
```

The handler's helpers (`visibMiles`, `getLowestCeiling`, `flightCategory`, `ledColor`, `parseIds`,
`processMetar`, `toCSV` and the help builders) are exported on `exports._test` for the tests.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **test**: `node --check index.js` and `node --test` on Node 24 (the Lambda runtime);
- **package** (after test): `scripts/build-zip.sh`, then `scripts/check-zip.js`, then uploads the
  zip as the `deploy-zip-<sha>` artifact; the run summary shows its `CodeSha256`;
- **secrets**: a gitleaks scan of the full history.

GitHub's own secret scanning and push protection are enabled on the repository as well.

## Clients

Any device that can make an HTTP GET and split a line on commas can use it. It was written for a
CircuitPython LED METAR map (retired); today's client is an ESP-IDF weather glass that sets its
LEDs from the `r-g-b` column and uses `stale` and the wind columns for its own effects.

## License

MIT; see `LICENSE`.
