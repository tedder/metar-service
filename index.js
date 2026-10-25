'use strict';

const crypto = require('node:crypto');

const UPSTREAM_URL = 'https://aviationweather.gov/api/data/metar?format=json&ids=';
// 47 airports in one request returned all 47 in 0.2 to 0.7 s (tested 2026-10-24); larger sizes are untested
const BATCH_SIZE = 50;
const UPSTREAM_TIMEOUT_MS = 4000;
const UPSTREAM_RETRIES = 1;

// Poll events: one SQS message per cache miss that has a boardid, so a consumer can tell that a
// device is alive without waiting for the CloudFront logs (5 to 30 minutes late). Lambda@Edge has
// no environment variables and cannot work after it returns, so the send starts before the
// upstream fetch and is awaited at the end for at most SQS_WAIT_MS. Failures are logged and ignored.
const SQS_REGION = 'us-west-2';
const SQS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/257269553028/metar-poll-events';
const SQS_REQUEST_TIMEOUT_MS = 1500;
const SQS_WAIT_MS = 300;
const STALE_MINUTES = 90;

function visibMiles(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (v === '10+') return 10;
  // Handle mixed fractions: "1 1/4", "1/2", "3/4"
  const frac = String(v).match(/^(\d+)?\s*(\d+)\/(\d+)$/);
  if (frac) {
    const whole = frac[1] ? parseInt(frac[1]) : 0;
    return whole + parseInt(frac[2]) / parseInt(frac[3]);
  }
  const num = String(v).match(/^\d+/);
  if (num) return parseInt(num[0]);
  return null;
}

function isActualCloudLayer(layer) {
  const cov = layer && layer.cover;
  if (!cov) return false;
  if (['SKC', 'FEW', 'SCT', 'CLR', 'CAVOK'].includes(cov)) return false;
  if (['OVC', 'BKN', 'OVX'].includes(cov)) return true;
  return false;
}

function getLowestCeiling(clouds) {
  if (!clouds || !clouds.length) return null;
  const layers = clouds.filter(isActualCloudLayer);
  const bases = layers.map(l => l.base).filter(b => typeof b === 'number');
  return bases.length ? Math.min(...bases) : null;
}

// Flight categories and colors per FAA AC 00-45H (Change 2), Table 3-14
// "Station Plot Weather Categories":
//   https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_00-45H_Chg_2.pdf
//   LIFR (magenta): ceiling below 500 ft AGL           and/or vis less than 1 SM
//   IFR  (red):     ceiling 500 to below 1,000 ft AGL  and/or vis 1 to less than 3 SM
//   MVFR (blue):    ceiling 1,000 to 3,000 ft AGL      and/or vis 3 to 5 SM   (inclusive)
//   VFR  (green):   ceiling greater than 3,000 ft AGL  and    vis greater than 5 SM
// Ceiling = lowest BKN, OVC or OVX (vertical visibility, VV) layer. AWC computes the same
// categories and returns them as `fltCat`; processMetar() prefers that and uses this as fallback.
function flightCategory(vizMiles, clouds) {
  const ceiling = getLowestCeiling(clouds);
  if ((vizMiles !== null && vizMiles < 1)    || (ceiling !== null && ceiling < 500))  return 'LIFR';
  if ((vizMiles !== null && vizMiles < 3)    || (ceiling !== null && ceiling < 1000)) return 'IFR';
  if ((vizMiles !== null && vizMiles <= 5)   || (ceiling !== null && ceiling <= 3000)) return 'MVFR';
  return 'VFR';
}

function ledColor(cat) {
  switch (cat) {
    case 'VFR':  return [0, 127, 0];
    case 'MVFR': return [0, 0, 127];
    case 'IFR':  return [127, 0, 0];
    case 'LIFR': return [255, 22, 199];
    default:     return [75, 75, 50];
  }
}

function processMetar(metar) {
  const vizMiles = visibMiles(metar.visib);
  const clouds = metar.clouds || [];
  // Prefer AWC's own category; ours is the fallback when fltCat is missing
  const cat = ['VFR', 'MVFR', 'IFR', 'LIFR'].includes(metar.fltCat)
    ? metar.fltCat
    : flightCategory(vizMiles, clouds);
  const ageMins = metar.obsTime
    ? Math.round((Date.now() / 1000 - metar.obsTime) / 60)
    : null;
  return {
    icao: metar.icaoId,
    cat,
    color: ledColor(cat),
    age_mins: ageMins,
    stale: ageMins === null || ageMins > STALE_MINUTES,
    wdir: metar.wdir ?? null,
    wspd: metar.wspd ?? null,
    wgst: metar.wgst ?? null,
  };
}

// Format [r, g, b] as "r-g-b" decimal
function toDecColor(color) {
  return color.join('-');
}

// Column documentation (used by both ?help=1 outputs)
const HELP_COLUMNS = [
  { name: 'icao',     desc: 'ICAO airport code' },
  { name: 'cat',      desc: 'Flight category VFR/MVFR/IFR/LIFR; empty if no METAR' },
  { name: 'r-g-b',    desc: 'LED color, decimal R-G-B 0-255' },
  { name: 'age_mins', desc: 'Minutes since METAR observation; empty if unknown' },
  { name: 'stale',    desc: '1 if METAR > 90min old or unknown, else 0' },
  { name: 'wdir',     desc: 'Wind direction degrees (0-360); 0 = calm or true north; "VRB" if variable' },
  { name: 'wspd',     desc: 'Wind speed in knots' },
  { name: 'wgst',     desc: 'Wind gust in knots; empty if no gusts reported' },
];

// Request parameter documentation
const HELP_PARAMS = [
  { name: 'ids',     desc: 'Comma-separated ICAO codes for METAR data. Omit (or use help=1) for documentation; no upstream fetch.' },
  { name: 'boardid', desc: 'Optional device identifier, used as given; logged and part of the cache key (for future gating).' },
  { name: 'output',  desc: '"csv" (default) or "json"' },
  { name: 'help',    desc: 'Set to 1 to return documentation. Same if ids is omitted or empty; no upstream fetch.' },
];

const HELP_NOTES = [
  'Batching of upstream requests is handled server-side; clients can pass any number of airports in a single call.',
  'Plain HTTP is supported (no NTP/TLS required on the client).',
  'Responses are cached for 5 minutes per (ids, boardid, output, help) combination.',
];

const HELP_HEADER_ROW = HELP_COLUMNS.map(c => c.name).join(',');

function helpCsv() {
  const lines = [
    '# metar-service help',
    '#',
    '# Request parameters:',
    ...HELP_PARAMS.map(p => `#   ${p.name} - ${p.desc}`),
    '#',
    '# Notes:',
    ...HELP_NOTES.map(n => `#   ${n}`),
    '#',
    '# Column descriptions:',
    ...HELP_COLUMNS.map(c => `#   ${c.name} - ${c.desc}`),
    '#',
    '# CSV header row:',
    HELP_HEADER_ROW,
  ];
  return lines.join('\n');
}

function helpJson() {
  return { columns: HELP_COLUMNS, params: HELP_PARAMS, notes: HELP_NOTES };
}

// Serialize results array as CSV: icao,cat,r-g-b,age_mins,stale,wdir,wspd,wgst
function toCSV(results) {
  return results.map(r =>
    `${r.icao},${r.cat ?? ''},${toDecColor(r.color)},${r.age_mins ?? ''},${r.stale ? 1 : 0},${r.wdir ?? ''},${r.wspd ?? ''},${r.wgst ?? ''}`
  ).join('\n');
}

// One upstream request with a short per-attempt timeout and a single retry. AWC normally
// answers in 150 to 700 ms but sometimes stalls for several seconds (4.4 s seen on a 10-airport
// request) or for about 20 s (the p99 in the logs); a fresh attempt usually succeeds quickly.
// Retries on timeout, network error or 5xx; a 4xx is returned as an error right away.
async function fetchBatch(batch) {
  const url = UPSTREAM_URL + batch.join(',');
  let lastErr;
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'metar-map-fetcher ted@tedder.me v1.0' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const rawText = await resp.text();
      if (resp.ok) return { url, resp, rawText };
      console.error(JSON.stringify({
        event: 'upstream_error',
        url,
        attempt,
        status: resp.status,
        statusText: resp.statusText,
        body: rawText.slice(0, 2000),
      }));
      lastErr = new Error(`Upstream HTTP ${resp.status}`);
      if (resp.status < 500) break;
    } catch (err) {
      console.error(JSON.stringify({ event: 'upstream_fetch_error', url, attempt, error: err.message }));
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchMetars(ids) {
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));
  // Batches go out together, so the total is the slowest batch and not the sum
  const responses = await Promise.all(batches.map(fetchBatch));
  const results = {};
  for (const { url, resp, rawText } of responses) {
    if (rawText.trim() === '') continue;  // 204 No Content or empty body = no data for this batch
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(JSON.stringify({
        event: 'upstream_parse_error',
        url,
        status: resp.status,
        error: parseErr.message,
        body: rawText.slice(0, 4000),
      }));
      throw new Error(`Upstream JSON parse failed: ${parseErr.message}`);
    }
    for (const metar of parsed) {
      try {
        results[metar.icaoId] = processMetar(metar);
      } catch (procErr) {
        console.error(JSON.stringify({
          event: 'metar_process_error',
          icao: metar.icaoId,
          error: procErr.message,
          raw_metar: metar,
        }));
      }
    }
  }
  return results;
}

// AWS Signature Version 4 for a POST. Written out so the function stays one file with no SDK to
// load (the SDK costs cold-start time and memory). `creds` is { accessKeyId, secretAccessKey, sessionToken }.
function sigV4Headers({ host, path, body, region, service, creds, amzDate }) {
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  const dateStamp = amzDate.slice(0, 8);
  const hdrs = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host,
    'x-amz-date': amzDate,
  };
  if (creds.sessionToken) hdrs['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map(n => `${n}:${hdrs[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, sha(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + creds.secretAccessKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  hdrs.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete hdrs.host;  // fetch sets Host itself
  return hdrs;
}

// Never rejects. Resolves to true when SQS accepted the message.
async function sendPollEvent(message, now = new Date()) {
  const creds = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  if (!creds.accessKeyId || !creds.secretAccessKey) return false;  // not running in Lambda
  try {
    const url = new URL(SQS_QUEUE_URL);
    const body = 'Action=SendMessage&Version=2012-11-05&MessageBody=' + encodeURIComponent(JSON.stringify(message));
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const headers = sigV4Headers({ host: url.host, path: url.pathname, body, region: SQS_REGION, service: 'sqs', creds, amzDate });
    const resp = await fetch(SQS_QUEUE_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(SQS_REQUEST_TIMEOUT_MS) });
    if (!resp.ok) {
      console.error(JSON.stringify({ event: 'sqs_error', status: resp.status, body: (await resp.text()).slice(0, 500) }));
      return false;
    }
    await resp.text();
    return true;
  } catch (err) {
    console.error(JSON.stringify({ event: 'sqs_error', error: err.message }));
    return false;
  }
}

// Wait for `promise`, but no longer than `ms`
function waitUpTo(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}

function parseIds(idsParam) {
  return (idsParam || '').split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0 && s.length <= 4 && s !== 'NULL' && !s.startsWith('OFF'));
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const params = new URLSearchParams(request.querystring);
  const ids = parseIds(params.get('ids'));
  const boardid = params.get('boardid') || '';
  const output = params.get('output') === 'json' ? 'json' : 'csv';
  const help = params.get('help');
  const allParams = Object.fromEntries(params.entries());

  if (help || !ids.length) {
    const isCsv = output === 'csv';
    return {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'content-type':  [{ key: 'Content-Type',  value: isCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }],
        'cache-control': [{ key: 'Cache-Control', value: 'max-age=300' }],
      },
      body: isCsv ? helpCsv() : JSON.stringify(helpJson()),
    };
  }

  const t0 = Date.now();
  // Started now so it overlaps the upstream fetch; awaited in the finally below
  const polled = boardid
    ? sendPollEvent({ boardid, ids, ts: new Date().toISOString(), ip: request.clientIp || '' })
    : Promise.resolve(false);
  try {
    const metarMap = await fetchMetars(ids);
    const results = ids.map(icao => metarMap[icao] || {
      icao,
      cat: null,
      color: [75, 75, 50],
      age_mins: null,
      stale: true,
      wdir: null,
      wspd: null,
      wgst: null,
    });

    const elapsed = Date.now() - t0;
    console.log(JSON.stringify({ ...allParams, ids, count: results.length, elapsed_ms: elapsed }));

    const isCsv = output === 'csv';
    return {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'content-type':  [{ key: 'Content-Type',  value: isCsv ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }],
        'cache-control': [{ key: 'Cache-Control', value: 'max-age=300' }],
      },
      body: isCsv ? toCSV(results) : JSON.stringify(results),
    };
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error(JSON.stringify({
      event: 'handler_error',
      ...allParams,
      ids,
      error: err.message,
      stack: err.stack,
      elapsed_ms: elapsed,
    }));
    return {
      status: '502',
      statusDescription: 'Bad Gateway',
      headers: { 'content-type': [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }] },
      body: JSON.stringify({ error: 'upstream fetch failed' }),
    };
  } finally {
    await waitUpTo(polled, SQS_WAIT_MS);
  }
};

// Exported for unit tests
exports._test = { visibMiles, isActualCloudLayer, getLowestCeiling, flightCategory, ledColor, parseIds, processMetar, fetchMetars, sigV4Headers, sendPollEvent, waitUpTo, toDecColor, toCSV, HELP_COLUMNS, HELP_PARAMS, HELP_NOTES, HELP_HEADER_ROW, helpCsv, helpJson };
