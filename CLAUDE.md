# metar-service

A METAR proxy/processor that `tedder-metar-map` devices talk to instead of hitting
`aviationweather.gov` directly. Fetches raw METAR, computes flight categories and LED colors,
returns a minimal response the device can apply directly to NeoPixels.

---

## Why

The device currently:
- Makes HTTPS requests to `aviationweather.gov` (requires NTP sync, SSL context, memory)
- Parses raw METAR JSON (visibility strings, cloud layers, regex) on a microcontroller
- Batches airports 10 at a time due to URL length / memory limits
- Does all flight category logic itself (~100 lines of CircuitPython)

Moving this to a service means:
- Device uses plain **HTTP only** — no NTP required for METAR, no SSL, no TLS clock issues
- Much less code and memory pressure on the ESP32
- Upstream METAR cached at the CDN — multiple devices share one fetch
- Upstream failures handled gracefully (serve stale data with age flag)
- All the fiddly parsing lives in real JavaScript with proper test coverage

---

## Architecture: Behavior on Existing CloudFront Distribution

Add a **cache behavior** for path `/metar*` to existing distribution **`E191F8VQXITFIN`**.
No new distribution needed.

```
device
  │
  │  GET http://<existing-domain>/metar?ids=KPDX,KHIO,KTTD&boardid=0740d12f6fce
  │
  ▼
CloudFront E191F8VQXITFIN — /metar* behavior
  │  cache key: ids + boardid query params
  │  TTL: 300s
  │  viewer protocol: HTTP and HTTPS
  │
  ├─ cache HIT → return immediately, Lambda not invoked
  │
  └─ cache MISS → Lambda@Edge (origin request)
                       │
                       │  HTTPS fetch to aviationweather.gov
                       ▼
               parse visibility + clouds
               compute flight category
               map to LED color
                       │
                       ▼
               synthetic response + Cache-Control: max-age=300
```

Lambda@Edge is an **origin request** function — only fires on cache miss.
With 5-min TTL and a device checking every ~9 min, Lambda fires roughly once per window.

---

## API

### `GET /metar?ids=KPDX,KHIO,KTTD,K7S3&boardid=0740d12f6fce`

- **`ids`** — comma-separated ICAO airport codes
- **`boardid`** — device board UID, used as given (not truncated: an allowlist needs exact
  matches, and the cache key is built from the raw value before the function runs). No auth yet;
  logged for future gating. Clients send 12 hex characters.

Plain HTTP. Response ordered to match `ids` order (simplifies device-side indexing).

```json
[
  {"icao": "KPDX", "cat": "VFR",  "color": [0, 127, 0],   "age_mins": 8,  "stale": false},
  {"icao": "KHIO", "cat": "MVFR", "color": [0, 0, 127],   "age_mins": 8,  "stale": false},
  {"icao": "KTTD", "cat": "IFR",  "color": [127, 0, 0],   "age_mins": 62, "stale": true},
  {"icao": "K7S3", "cat": null,   "color": [75, 75, 50],  "age_mins": null, "stale": true}
]
```

- Missing airports still appear with `cat: null` and color `[75, 75, 50]` (dim)
- `stale: true` when METAR age > 90 minutes
- Response includes `Cache-Control: max-age=300`

---

## Cache Key

CloudFront cache policy for the `/metar*` behavior:

| Parameter | In cache key | Notes |
|-----------|-------------|-------|
| `ids` | ✅ yes | Different airport lists = different cached responses |
| `boardid` | ✅ yes | Future gating may return different responses per board |

`boardid` is in the cache key because once gating is added, an unknown board will get a 403
(which would also be cached — intentional). A known board gets 200. Different responses, so
different cache entries.

Airport list ordering in `ids` matters for the cache key. The device always sends airports in
LED order, which is fixed — so cache hit rate will be ~100% after the first miss per window.
If multi-device support is added later, Lambda should sort `ids` before fetching upstream and
return results in original request order.

---

## Lambda@Edge: Key Details

- **Runtime:** Node.js 24.x (`nodejs24.x`; created on 20.x)
- **Trigger:** Origin request on `/metar*` behavior of `E191F8VQXITFIN`
- **Deploy region:** `us-east-1` (Lambda@Edge requirement — replicates automatically)
- **Timeout:** 30s max (upstream fetch is well under 1s)
- **Memory:** 128MB

**Reading params from origin request event:**
```javascript
const request = event.Records[0].cf.request;
const params = new URLSearchParams(request.querystring);
const ids = params.get('ids') || '';
const boardid = params.get('boardid') || '';
```

**Returning synthetic response (no real origin):**
```javascript
return {
  status: '200',
  statusDescription: 'OK',
  headers: {
    'content-type':  [{ key: 'Content-Type',  value: 'application/json' }],
    'cache-control': [{ key: 'Cache-Control', value: 'max-age=300' }],
  },
  body: JSON.stringify(results),
};
```

---

## Logic That Moves to Lambda

### `visibMiles(v)`
Handles: `null`, int, float, `"10+"`, fractional strings like `"1 1/2"`.

### `isActualCloudLayer(layer)` + `getLowestCeiling(clouds)`
BKN/OVC/OVX = ceiling layer; SKC/FEW/SCT/CLR/CAVOK = ignored.
Returns lowest ceiling base in feet, or null if clear.

### `flightCategory(vizMiles, clouds)`
```
LIFR: ceiling < 500ft  OR viz < 1mi
IFR:  ceiling < 1000ft OR viz < 3mi
MVFR: ceiling < 3000ft OR viz < 5mi
VFR:  everything else
```

### `ledColor(cat)`
```
VFR  → [0, 127, 0]    green
MVFR → [0, 0, 127]    blue
IFR  → [127, 0, 0]    red
LIFR → [255, 22, 199] pink
null → [75, 75, 50]   dim (no report)
```

### Upstream batching
Lambda splits `ids` into groups of 10 for the aviationweather.gov API, merges results.
Device never batches.

---

## CloudFront Behavior Config (to add to E191F8VQXITFIN)

| Setting | Value |
|---------|-------|
| Path pattern | `/metar*` |
| Viewer protocol policy | **HTTP and HTTPS** (not redirect) |
| Allowed HTTP methods | GET, HEAD |
| Cache policy | Custom: include `ids` + `boardid` query params; TTL min/default/max = 0/300/300 |
| Origin request policy | Include `ids` + `boardid` in origin request |
| Lambda@Edge | Origin request: `<function ARN>` |
| Origin | Dummy (Lambda returns synthetic response before origin is contacted) |

Note: CloudFront requires an origin even when Lambda always returns a synthetic response.
Use a simple dummy (e.g. an S3 bucket or the existing distribution's default origin).

---

## What Stays on the Device

- `airports.txt` — local LED-order config
- `write_leds()` — NeoPixel timing, blink logic, `pix.show()`
- `oled_write()` — display updates
- `try_wifi()` / NTP retry / watchdog / debug flags

`try_wx()` actual implementation:

```python
def try_wx():
    airport_ids = [x for x in airportlist if is_valid_airport(x)]
    url = f"{METAR_SERVICE_URL}?ids={','.join(airport_ids)}&boardid={BOARD_UID}&output=csv&debug=0x{debug_flags:x}"
    ret = requests.get(url)
    for line in ret.text.strip().split('\n'):
        parts = line.split(',')
        # icao, cat, r-g-b, age_mins, stale
        icao = parts[0]
        r, g, b = [int(x) for x in parts[2].split('-')]
        ledstate[airportlist.index(icao)]["base_color"] = (r, g, b)
    ret.close()
```

No SSL, no batching, no METAR parsing. NTP-before-METAR dependency gone.
phone_home removed entirely.

---

## Cost

~4,800 device requests/month. Cache TTL 5 min → ~8,640 Lambda invocations/month.

- CloudFront free tier: 10M requests/month → **$0**
- Lambda@Edge free tier: 1M requests/month → **$0**

---

## Phase 1 — COMPLETE (2026-02-19)

### AWS Resources Created

| Resource | ID / ARN |
|----------|----------|
| IAM Role | `arn:aws:iam::257269553028:role/metar-service-lambda-edge` |
| Lambda function | `arn:aws:lambda:us-east-1:257269553028:function:metar-service` |
| Lambda version | `:9` (version ARN required for Lambda@Edge — not $LATEST) |
| Cache policy | `bfb74b40-bea7-4727-a283-ac972b63138f` (ids+boardid+output, TTL 300s) |
| CloudFront distribution | `E191F8VQXITFIN` — domain `d2roi1at1iwlh9.cloudfront.net` |

### Endpoint

```
GET http://fly.tedder.me/metar?ids=KPDX,KHIO&boardid=0740d12f6fce&output=csv&debug=0x0
```

### Response format (CSV, default)

```
KPDX,VFR,0-127-0,8,0
KHIO,MVFR,0-0-127,12,0
KTTD,IFR,127-0-0,62,1
K7S3,,75-75-50,,1
```

Columns: `icao, cat, r-g-b, age_mins, stale`

- `cat` empty = no METAR data (bad ICAO or non-reporting station)
- color `75-75-50` = no data (matches device pre-fetch init color)
- `output=json` returns JSON array for debugging
- `debug=0x{flags}` logged server-side, not in cache key

### Deploy Command (update Lambda code)

```bash
cd ~/git/claude/metar-service
zip -j /tmp/metar-service.zip index.js
AWS_PROFILE=pjnet aws lambda update-function-code \
  --region us-east-1 --function-name metar-service \
  --zip-file fileb:///tmp/metar-service.zip
# Then publish a new version and update the CF behavior's Lambda ARN
AWS_PROFILE=pjnet aws lambda publish-version \
  --region us-east-1 --function-name metar-service
```

### Logging

**CloudFront standard logging is DISABLED** — no S3 access logs exist for this distribution. Do not `s3 ls` looking for them.

**Source of truth: CloudWatch Logs**, region `us-west-2`, log group `/aws/lambda/us-east-1.metar-service`.

Success log line (JSON): the forwarded GET params spread in (`ids`, `boardid`, `output`, `help`, `debug`: the origin request policy forwards only these), plus `ids` (parsed array), `count`, `elapsed_ms`. Client telemetry (`crash`, `fetches`, `fw`, `t`, `localip`) never reaches the function; it is only in the CloudFront access logs.

Query with:
```bash
AWS_PROFILE=pjnet aws logs filter-log-events --region us-west-2 \
  --log-group-name '/aws/lambda/us-east-1.metar-service' \
  --start-time $(($(date +%s) * 1000 - 86400000))
```

### Error Logging

`fetchMetars` logs structured JSON on:
- Upstream non-200: `event: upstream_error` with status + body (first 2000 chars)
- JSON parse failure: `event: upstream_parse_error` with raw body (first 4000 chars)
- Per-METAR processing failure: `event: metar_process_error` with `raw_metar` object
- Handler-level failure: `event: handler_error` with stack trace + elapsed_ms

All errors logged via `console.error` → CloudWatch Logs `/aws/lambda/metar-service`

### Steps completed
1. Lambda function written + 48 unit tests passing
2. Unit tests (`node --test index.test.js`)
3. IAM role with `lambda.amazonaws.com` + `edgelambda.amazonaws.com` principals
4. Lambda function created in `us-east-1` (Node.js 20.x, 128MB, 30s timeout)
5. Version 1 published
6. CloudFront cache policy created (TTL 0/300/300; key whitelist now `ids`, `boardid`, `output`, `help`), origin request policy forwards those plus `debug`
7. `/metar*` behavior added to `E191F8VQXITFIN` (viewer protocol: allow-all, Lambda@Edge origin-request)

## Phase 2

- Gate on `boardid` (allowlist of known board UIDs)
- `/airports/{boardid}` — server-managed airport list per device
- Structured CloudWatch logging (ids, boardid, cache miss reason, upstream latency)

---

## Flight categories — source

Categories and colors follow **FAA AC 00-45H (Change 2), Table 3-14 "Station Plot Weather
Categories"**: https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_00-45H_Chg_2.pdf

| Category | Color | Ceiling (ft AGL) | | Visibility (SM) |
|---|---|---|---|---|
| LIFR | magenta | below 500 | and/or | less than 1 |
| IFR | red | 500 to below 1,000 | and/or | 1 to less than 3 |
| MVFR | blue | 1,000 to 3,000 (inclusive) | and/or | 3 to 5 (inclusive) |
| VFR | green | greater than 3,000 | and | greater than 5 |

Ceiling = lowest BKN/OVC/OVX (VV) layer. `processMetar()` uses AWC's `fltCat` when present
(AWC applies the same table) and falls back to `flightCategory()`.

**History:** through v14 the MVFR upper bounds were exclusive (3,000 ft or 5 SM showed VFR).
Fixed in Lambda version 15 (2026-10-16); edge cases in `index.test.js`. Verified against AWC
`fltCat` on 798 live METARs (0 mismatches; 14 before).

**Deploy:** `./scripts/build-zip.sh` (or the CI `deploy-zip-<sha>` artifact; same bytes, check `CodeSha256`) → `aws lambda update-function-code --function-name metar-service
--region us-east-1 --zip-file fileb://deploy.zip --publish` → invoke the new version directly
with a CloudFront event → point distribution `E191F8VQXITFIN` `/metar*` origin-request
association at the new version. Rollback = point it back. (`AWS_PROFILE=pjnet`)
