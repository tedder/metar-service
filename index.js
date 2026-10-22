'use strict';

const UPSTREAM_URL = 'https://aviationweather.gov/api/data/metar?format=json&ids=';
const BATCH_SIZE = 10;
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
  { name: 'boardid', desc: 'Optional device identifier; logged for future gating. Truncated to 12 chars.' },
  { name: 'output',  desc: '"csv" (default) or "json"' },
  { name: 'help',    desc: 'Set to 1 to return documentation. Same if ids is omitted or empty; no upstream fetch.' },
  { name: 'debug',   desc: 'Optional debug flag (string), logged but not used in cache key.' },
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

async function fetchMetars(ids) {
  const results = {};
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const url = UPSTREAM_URL + batch.join(',');
    const resp = await fetch(url, { headers: { 'User-Agent': 'metar-map-fetcher ted@tedder.me v1.0' } });
    const rawText = await resp.text();
    if (!resp.ok) {
      console.error(JSON.stringify({
        event: 'upstream_error',
        url,
        status: resp.status,
        statusText: resp.statusText,
        body: rawText.slice(0, 2000),
      }));
      throw new Error(`Upstream HTTP ${resp.status}`);
    }
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
  const debug = params.get('debug') || '';
  const crash = params.get('crash') || '';
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
  }
};

// Exported for unit tests
exports._test = { visibMiles, isActualCloudLayer, getLowestCeiling, flightCategory, ledColor, parseIds, processMetar, toDecColor, toCSV, HELP_COLUMNS, HELP_PARAMS, HELP_NOTES, HELP_HEADER_ROW, helpCsv, helpJson };
