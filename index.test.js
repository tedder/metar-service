'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { visibMiles, getLowestCeiling, flightCategory, ledColor, parseIds, toDecColor, toCSV } = require('./index')._test;

// Helper: build a cloud layer object
const cld = (cover, base) => ({ cover, base });

// A high ceiling that doesn't affect category — lets us test viz alone
const HIGH = [cld('OVC', 9999)];

// ── flightCategory: ceiling-driven ──────────────────────────────────────────

describe('flightCategory - ceiling', () => {
  // Ported from test_metar4.py test_clouds
  test('3005ft = VFR',  () => assert.equal(flightCategory(99, [cld('OVC', 3005)]), 'VFR'));
  test('3001ft = VFR',  () => assert.equal(flightCategory(99, [cld('OVC', 3001)]), 'VFR'));
  test('3000ft = MVFR (FAA: 1,000-3,000 inclusive)', () => assert.equal(flightCategory(99, [cld('OVC', 3000)]), 'MVFR'));
  test('2999ft = MVFR', () => assert.equal(flightCategory(99, [cld('OVC', 2999)]), 'MVFR'));
  test('1005ft = MVFR', () => assert.equal(flightCategory(99, [cld('OVC', 1005)]), 'MVFR'));
  test('1000ft = MVFR', () => assert.equal(flightCategory(99, [cld('OVC', 1000)]), 'MVFR'));
  test('999ft = IFR',   () => assert.equal(flightCategory(99, [cld('OVC', 999)]),  'IFR'));
  test('505ft = IFR',   () => assert.equal(flightCategory(99, [cld('OVC', 505)]),  'IFR'));
  test('500ft = IFR',   () => assert.equal(flightCategory(99, [cld('OVC', 500)]),  'IFR'));
  test('499ft = LIFR',  () => assert.equal(flightCategory(99, [cld('OVC', 499)]),  'LIFR'));
  test('0ft = LIFR',    () => assert.equal(flightCategory(99, [cld('OVC', 0)]),    'LIFR'));

  test('null clouds = VFR (CAVU)',  () => assert.equal(flightCategory(99, null), 'VFR'));
  test('empty clouds = VFR (CAVU)', () => assert.equal(flightCategory(99, []),   'VFR'));

  test('BKN counts as ceiling', () => assert.equal(flightCategory(99, [cld('BKN', 800)]), 'IFR'));
  test('OVX counts as ceiling', () => assert.equal(flightCategory(99, [cld('OVX', 0)]),   'LIFR'));
  test('SCT ignored',           () => assert.equal(flightCategory(99, [cld('SCT', 200)]), 'VFR'));
  test('FEW ignored',           () => assert.equal(flightCategory(99, [cld('FEW', 200)]), 'VFR'));
  test('lowest BKN/OVC wins',   () => assert.equal(flightCategory(99, [cld('SCT', 200), cld('OVC', 800)]), 'IFR'));
});

// ── flightCategory: visibility-driven ───────────────────────────────────────

describe('flightCategory - visibility', () => {
  // Ported from test_metar4.py test_visibility
  test('10mi = VFR',   () => assert.equal(flightCategory(10,   HIGH), 'VFR'));
  test('6mi = VFR',    () => assert.equal(flightCategory(6,    HIGH), 'VFR'));
  test('5mi = MVFR (FAA: 3-5 SM inclusive)', () => assert.equal(flightCategory(5, HIGH), 'MVFR'));
  test('4.99mi = MVFR',() => assert.equal(flightCategory(4.99, HIGH), 'MVFR'));
  test('3mi = MVFR',   () => assert.equal(flightCategory(3,    HIGH), 'MVFR'));
  test('2.99mi = IFR', () => assert.equal(flightCategory(2.99, HIGH), 'IFR'));
  test('1mi = IFR',    () => assert.equal(flightCategory(1,    HIGH), 'IFR'));
  test('0.99mi = LIFR',() => assert.equal(flightCategory(0.99, HIGH), 'LIFR'));

  test('null viz = no contribution', () => assert.equal(flightCategory(null, HIGH), 'VFR'));
});

// ── visibMiles ───────────────────────────────────────────────────────────────

describe('visibMiles', () => {
  test('null',          () => assert.equal(visibMiles(null),      null));
  test('undefined',     () => assert.equal(visibMiles(undefined), null));
  test('integer',       () => assert.equal(visibMiles(10),        10));
  test('float',         () => assert.equal(visibMiles(3.5),       3.5));
  test('"10+"',         () => assert.equal(visibMiles('10+'),     10));
  test('"1/2"',         () => assert.equal(visibMiles('1/2'),     0.5));
  test('"3/4"',         () => assert.equal(visibMiles('3/4'),     0.75));
  test('"1 1/4"',       () => assert.equal(visibMiles('1 1/4'),   1.25));
  test('"1 1/2"',       () => assert.equal(visibMiles('1 1/2'),   1.5));
  test('integer string',() => assert.equal(visibMiles('7'),       7));
});

// ── ledColor ─────────────────────────────────────────────────────────────────

describe('ledColor', () => {
  test('VFR  = green', () => assert.deepEqual(ledColor('VFR'),  [0, 127, 0]));
  test('MVFR = blue',  () => assert.deepEqual(ledColor('MVFR'), [0, 0, 127]));
  test('IFR  = red',   () => assert.deepEqual(ledColor('IFR'),  [127, 0, 0]));
  test('LIFR = pink',  () => assert.deepEqual(ledColor('LIFR'), [255, 22, 199]));
  test('null = dim blue',() => assert.deepEqual(ledColor(null), [75, 75, 50]));
});

// ── parseIds ─────────────────────────────────────────────────────────────────

describe('parseIds', () => {
  test('basic',          () => assert.deepEqual(parseIds('KPDX,KHIO'), ['KPDX', 'KHIO']));
  test('lowercase',      () => assert.deepEqual(parseIds('kpdx'),      ['KPDX']));
  test('trims spaces',   () => assert.deepEqual(parseIds('KPDX, KHIO'),['KPDX', 'KHIO']));
  test('filters NULL',   () => assert.deepEqual(parseIds('KPDX,NULL,KHIO'), ['KPDX', 'KHIO']));
  test('filters OFF*',   () => assert.deepEqual(parseIds('KPDX,OFF,KHIO'),  ['KPDX', 'KHIO']));
  test('filters >4 char',() => assert.deepEqual(parseIds('KPDX,TOOLONG'),   ['KPDX']));
  test('empty string',   () => assert.deepEqual(parseIds(''),               []));
  test('null param',     () => assert.deepEqual(parseIds(null),             []));
});

// ── toDecColor ───────────────────────────────────────────────────────────────

describe('toDecColor', () => {
  test('green',  () => assert.equal(toDecColor([0, 127, 0]),     '0-127-0'));
  test('blue',   () => assert.equal(toDecColor([0, 0, 127]),     '0-0-127'));
  test('red',    () => assert.equal(toDecColor([127, 0, 0]),     '127-0-0'));
  test('pink',   () => assert.equal(toDecColor([255, 22, 199]),  '255-22-199'));
  test('dim blue', () => assert.equal(toDecColor([75, 75, 50]),    '75-75-50'));
});

// ── toCSV ─────────────────────────────────────────────────────────────────────

describe('toCSV', () => {
  const vfr  = { icao: 'KPDX', cat: 'VFR',  color: [0, 127, 0],   age_mins: 8,    stale: false };
  const mvfr = { icao: 'KHIO', cat: 'MVFR', color: [0, 0, 127],   age_mins: 12,   stale: false };
  const null_ = { icao: 'K7S3', cat: null,  color: [75, 75, 50],   age_mins: null, stale: true  };

  test('VFR row',  () => assert.equal(toCSV([vfr]),   'KPDX,VFR,0-127-0,8,0,,,'));
  test('MVFR row', () => assert.equal(toCSV([mvfr]),  'KHIO,MVFR,0-0-127,12,0,,,'));
  test('null airport row', () => assert.equal(toCSV([null_]), 'K7S3,,75-75-50,,1,,,'));
  test('multiple rows', () => assert.equal(
    toCSV([vfr, mvfr]),
    'KPDX,VFR,0-127-0,8,0,,,\nKHIO,MVFR,0-0-127,12,0,,,'
  ));
});

// ── FAA boundaries + AWC fltCat preference ───────────────────────────────────

describe('processMetar category source', () => {
  const { processMetar } = require('./index.js')._test;
  const base = { icaoId: 'KTST', obsTime: Math.floor(Date.now() / 1000) };
  test('uses AWC fltCat when present', () =>
    assert.equal(processMetar({ ...base, fltCat: 'IFR', visib: '10+', clouds: [] }).cat, 'IFR'));
  test('falls back to own calc without fltCat', () =>
    assert.equal(processMetar({ ...base, visib: 5, clouds: [] }).cat, 'MVFR'));
  test('ignores junk fltCat', () =>
    assert.equal(processMetar({ ...base, fltCat: 'XYZ', visib: '10+', clouds: [cld('OVC', 400)] }).cat, 'LIFR'));
  test('VV (OVX) counts as ceiling', () =>
    assert.equal(processMetar({ ...base, visib: 3, clouds: [cld('OVX', 200)] }).cat, 'LIFR'));
  test('lowest ceiling layer wins regardless of order', () =>
    assert.equal(processMetar({ ...base, visib: '10+', clouds: [cld('OVC', 4000), cld('BKN', 900)] }).cat, 'IFR'));
});

// ── Edge cases: every FAA AC 00-45H Table 3-14 boundary, both sides ─────────

describe('FAA Table 3-14 boundaries (ceiling, vis 10)', () => {
  const c = (base) => flightCategory(10, [cld('OVC', base)]);
  test('0 ft = LIFR',     () => assert.equal(c(0), 'LIFR'));
  test('499 ft = LIFR',   () => assert.equal(c(499), 'LIFR'));
  test('500 ft = IFR',    () => assert.equal(c(500), 'IFR'));
  test('999 ft = IFR',    () => assert.equal(c(999), 'IFR'));
  test('1000 ft = MVFR',  () => assert.equal(c(1000), 'MVFR'));
  test('3000 ft = MVFR',  () => assert.equal(c(3000), 'MVFR'));
  test('3001 ft = VFR',   () => assert.equal(c(3001), 'VFR'));
});

describe('FAA Table 3-14 boundaries (visibility, no ceiling)', () => {
  const v = (vis) => flightCategory(vis, []);
  test('0 SM = LIFR',     () => assert.equal(v(0), 'LIFR'));
  test('0.75 SM = LIFR',  () => assert.equal(v(0.75), 'LIFR'));
  test('1 SM = IFR',      () => assert.equal(v(1), 'IFR'));
  test('2.75 SM = IFR',   () => assert.equal(v(2.75), 'IFR'));
  test('3 SM = MVFR',     () => assert.equal(v(3), 'MVFR'));
  test('5 SM = MVFR',     () => assert.equal(v(5), 'MVFR'));
  test('5.01 SM = VFR',   () => assert.equal(v(5.01), 'VFR'));
  test('6 SM = VFR',      () => assert.equal(v(6), 'VFR'));
});

describe('and/or: the worse of ceiling and visibility wins', () => {
  test('VFR vis + IFR ceiling = IFR',   () => assert.equal(flightCategory(10, [cld('BKN', 800)]), 'IFR'));
  test('IFR vis + VFR ceiling = IFR',   () => assert.equal(flightCategory(2, [cld('BKN', 5000)]), 'IFR'));
  test('MVFR vis + LIFR ceiling = LIFR',() => assert.equal(flightCategory(4, [cld('OVC', 300)]), 'LIFR'));
  test('VFR needs both: vis 6 + ceiling 3000 = MVFR', () => assert.equal(flightCategory(6, [cld('OVC', 3000)]), 'MVFR'));
});

describe('ceiling layer rules', () => {
  test('FEW/SCT are not ceilings', () => assert.equal(flightCategory(10, [cld('FEW', 200), cld('SCT', 400)]), 'VFR'));
  test('BKN is a ceiling',         () => assert.equal(flightCategory(10, [cld('BKN', 400)]), 'LIFR'));
  test('OVX (VV) is a ceiling',    () => assert.equal(flightCategory(10, [cld('OVX', 100)]), 'LIFR'));
  test('CLR/SKC/CAVOK = no ceiling', () => assert.equal(flightCategory(10, [cld('CLR', null), cld('SKC', null), cld('CAVOK', null)]), 'VFR'));
  test('FEW below, BKN above: BKN counts', () => assert.equal(flightCategory(10, [cld('FEW', 500), cld('BKN', 2500)]), 'MVFR'));
  test('ceiling layer with no base is ignored', () => assert.equal(flightCategory(10, [cld('OVC', null)]), 'VFR'));
  test('unsorted layers: lowest ceiling wins', () => assert.equal(flightCategory(10, [cld('OVC', 4000), cld('BKN', 900)]), 'IFR'));
  test('no clouds and no visibility = VFR (nothing reported)', () => assert.equal(flightCategory(null, []), 'VFR'));
});

describe('visibility parsing', () => {
  test('"10+" = 10',   () => assert.equal(visibMiles('10+'), 10));
  test('"6+" = 6',     () => assert.equal(visibMiles('6+'), 6));
  test('number passes through', () => assert.equal(visibMiles(0.25), 0.25));
  test('"1/2" = 0.5',  () => assert.equal(visibMiles('1/2'), 0.5));
  test('"1 1/2" = 1.5',() => assert.equal(visibMiles('1 1/2'), 1.5));
  test('null = null',  () => assert.equal(visibMiles(null), null));
  test('"6+" vis = VFR, not MVFR', () => assert.equal(flightCategory(visibMiles('6+'), []), 'VFR'));
});

describe('colors match FAA AC 00-45H Table 3-14', () => {
  test('VFR green',    () => assert.deepEqual(ledColor('VFR'), [0, 127, 0]));
  test('MVFR blue',    () => assert.deepEqual(ledColor('MVFR'), [0, 0, 127]));
  test('IFR red',      () => assert.deepEqual(ledColor('IFR'), [127, 0, 0]));
  test('LIFR magenta', () => assert.deepEqual(ledColor('LIFR'), [255, 22, 199]));
});

describe('fetchMetars upstream behavior', () => {
  const { fetchMetars } = require('./index')._test;
  const ok = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
  const row = (id) => ({ icaoId: id, fltCat: 'VFR', visib: '10+', clouds: [], obsTime: Math.floor(Date.now() / 1000) });
  const realFetch = global.fetch;
  const realErr = console.error;
  const restore = () => { global.fetch = realFetch; console.error = realErr; };

  test('splits into batches and sends them all before any resolves', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 'K' + String(i).padStart(3, '0'));
    let inflight = 0, peak = 0;
    global.fetch = async (url) => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 10));
      inflight--;
      return ok(decodeURIComponent(url.split('ids=')[1]).split(',').map(row));
    };
    try {
      const out = await fetchMetars(ids);
      assert.strictEqual(Object.keys(out).length, 120);
      assert.strictEqual(peak, 3);  // 120 ids at 50 per batch
    } finally { restore(); }
  });

  test('retries once after a failure and then succeeds', async () => {
    let calls = 0;
    console.error = () => {};
    global.fetch = async () => {
      if (++calls === 1) throw new Error('timed out');
      return ok([row('KPDX')]);
    };
    try {
      const out = await fetchMetars(['KPDX']);
      assert.strictEqual(calls, 2);
      assert.strictEqual(out.KPDX.cat, 'VFR');
    } finally { restore(); }
  });

  test('gives up after one retry', async () => {
    let calls = 0;
    console.error = () => {};
    global.fetch = async () => { calls++; throw new Error('down'); };
    try {
      await assert.rejects(fetchMetars(['KPDX']), /down/);
      assert.strictEqual(calls, 2);
    } finally { restore(); }
  });

  test('retries a 5xx and then succeeds', async () => {
    let calls = 0;
    console.error = () => {};
    global.fetch = async () => {
      if (++calls === 1) return { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'busy' };
      return ok([row('KPDX')]);
    };
    try {
      const out = await fetchMetars(['KPDX']);
      assert.strictEqual(calls, 2);
      assert.strictEqual(out.KPDX.cat, 'VFR');
    } finally { restore(); }
  });

  test('each attempt carries an abort signal', async () => {
    const signals = [];
    console.error = () => {};
    global.fetch = async (url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) throw new Error('timed out');
      return ok([row('KPDX')]);
    };
    try {
      await fetchMetars(['KPDX']);
      assert.strictEqual(signals.length, 2);
      assert.ok(signals.every(sg => sg instanceof AbortSignal && !sg.aborted));
      assert.notStrictEqual(signals[0], signals[1]);  // a fresh timeout per attempt
    } finally { restore(); }
  });

  test('50 airports are one request, 51 are two', async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => 'K' + String(i).padStart(3, '0'));
    for (const [n, want] of [[50, 1], [51, 2]]) {
      let calls = 0;
      global.fetch = async (url) => { calls++; return ok(decodeURIComponent(url.split('ids=')[1]).split(',').map(row)); };
      try {
        await fetchMetars(mk(n));
        assert.strictEqual(calls, want);
      } finally { restore(); }
    }
  });

  test('an empty body (204) gives no data without failing', async () => {
    global.fetch = async () => ({ ok: true, status: 204, text: async () => '' });
    try {
      assert.deepStrictEqual(await fetchMetars(['KXXX']), {});
    } finally { restore(); }
  });

  test('one failed batch fails the whole request', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => 'K' + String(i).padStart(3, '0'));
    console.error = () => {};
    global.fetch = async (url) => {
      if (url.includes('K055')) throw new Error('down');
      return ok(decodeURIComponent(url.split('ids=')[1]).split(',').map(row));
    };
    try {
      await assert.rejects(fetchMetars(ids), /down/);
    } finally { restore(); }
  });

  test('does not retry a 4xx', async () => {
    let calls = 0;
    console.error = () => {};
    global.fetch = async () => { calls++; return { ok: false, status: 400, statusText: 'Bad', text: async () => 'no' }; };
    try {
      await assert.rejects(fetchMetars(['KPDX']), /HTTP 400/);
      assert.strictEqual(calls, 1);
    } finally { restore(); }
  });
});

describe('poll events to SQS', () => {
  const m = require('./index');
  const { sigV4Headers, sendPollEvent, waitUpTo } = m._test;
  const realFetch = global.fetch;
  const realErr = console.error;
  const realLog = console.log;
  const env = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEiK7MDENGbPxRfiCYEXAMPLEKEY', AWS_SESSION_TOKEN: 'TOKEN123' };
  const saved = {};
  const setEnv = () => { for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; } };
  const clearEnv = () => { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  const restore = () => { global.fetch = realFetch; console.error = realErr; console.log = realLog; clearEnv(); };
  const event = (qs) => ({ Records: [{ cf: { request: { querystring: qs, clientIp: '203.0.113.9' } } }] });
  const awc = (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(decodeURIComponent(url.split('ids=')[1]).split(',').map(id => ({ icaoId: id, fltCat: 'VFR', visib: '10+', clouds: [] }))) });

  test('SigV4 signature matches the one botocore produces for the same request', () => {
    const creds = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
    const body = 'Action=SendMessage&Version=2012-11-05&MessageBody=' + encodeURIComponent('{"a":"b c"}');
    const h = sigV4Headers({ host: 'sqs.us-west-2.amazonaws.com', path: '/257269553028/metar-poll-events', body, region: 'us-west-2', service: 'sqs', creds, amzDate: '20261025T031500Z' });
    assert.ok(h.authorization.endsWith('Signature=a0fe4bf5909bf64e11734dc85200282abd29be66815dd572a45dc64f0a9c6976'));
    assert.ok(h.authorization.includes('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token'));
    assert.strictEqual(h['x-amz-security-token'], 'TOKEN123');
    assert.strictEqual(h.host, undefined);
  });

  test('sends nothing without credentials', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, text: async () => '' }; };
    const saved2 = process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_ACCESS_KEY_ID;
    try {
      assert.strictEqual(await sendPollEvent({ boardid: 'x' }), false);
      assert.strictEqual(calls, 0);
    } finally { if (saved2 !== undefined) process.env.AWS_ACCESS_KEY_ID = saved2; restore(); }
  });

  test('posts a signed SendMessage and reports success', async () => {
    setEnv();
    let seen;
    global.fetch = async (url, init) => { seen = { url, init }; return { ok: true, text: async () => '<ok/>' }; };
    try {
      assert.strictEqual(await sendPollEvent({ boardid: 'abc', ids: ['KPDX'] }, new Date('2026-10-25T03:15:00Z')), true);
      assert.ok(seen.url.endsWith('/metar-poll-events'));
      assert.strictEqual(seen.init.method, 'POST');
      assert.ok(seen.init.body.startsWith('Action=SendMessage&Version=2012-11-05&MessageBody='));
      assert.ok(decodeURIComponent(seen.init.body.split('MessageBody=')[1]).includes('"boardid":"abc"'));
      assert.strictEqual(seen.init.headers['x-amz-date'], '20261025T031500Z');
      assert.ok(seen.init.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261025/us-west-2/sqs/aws4_request'));
    } finally { restore(); }
  });

  test('a non-200 or a thrown error is logged and not raised', async () => {
    setEnv();
    const logged = [];
    console.error = (l) => logged.push(l);
    try {
      global.fetch = async () => ({ ok: false, status: 403, text: async () => 'denied' });
      assert.strictEqual(await sendPollEvent({ boardid: 'x' }), false);
      global.fetch = async () => { throw new Error('boom'); };
      assert.strictEqual(await sendPollEvent({ boardid: 'x' }), false);
      assert.strictEqual(logged.length, 2);
      assert.ok(logged.every(l => l.includes('"event":"sqs_error"')));
    } finally { restore(); }
  });

  test('waitUpTo returns at the limit for a promise that never settles', async () => {
    const t0 = Date.now();
    await waitUpTo(new Promise(() => {}), 40);
    const dt = Date.now() - t0;
    assert.ok(dt >= 30 && dt < 500, `took ${dt} ms`);
  });

  test('handler starts the send before the upstream fetch and still answers if SQS hangs', async () => {
    setEnv();
    const order = [];
    console.log = () => {};
    global.fetch = (url) => {
      if (url.includes('sqs.')) { order.push('sqs'); return new Promise(() => {}); }  // never answers
      order.push('awc');
      return Promise.resolve(awc(url));
    };
    try {
      const t0 = Date.now();
      const r = await m.handler(event('ids=KPDX&boardid=abc123'));
      assert.deepStrictEqual(order, ['sqs', 'awc']);
      assert.strictEqual(r.status, '200');
      assert.ok(Date.now() - t0 < 1000);  // waited about 300 ms for SQS, not forever
    } finally { restore(); }
  });

  test('handler sends no event for help requests or without a boardid', async () => {
    setEnv();
    const urls = [];
    console.log = () => {};
    global.fetch = (url) => { urls.push(url); return Promise.resolve(url.includes('sqs.') ? { ok: true, text: async () => '' } : awc(url)); };
    try {
      await m.handler(event('ids=KPDX'));           // no boardid
      await m.handler(event('help=1&boardid=abc')); // help
      assert.ok(!urls.some(u => u.includes('sqs.')));
    } finally { restore(); }
  });

  test('handler sends the event even when the upstream fails', async () => {
    setEnv();
    const urls = [];
    console.error = () => {}; console.log = () => {};
    global.fetch = (url) => {
      urls.push(url);
      if (url.includes('sqs.')) return Promise.resolve({ ok: true, text: async () => '' });
      return Promise.reject(new Error('down'));
    };
    try {
      const r = await m.handler(event('ids=KPDX&boardid=abc'));
      assert.strictEqual(r.status, '502');
      assert.ok(urls.some(u => u.includes('sqs.')));
    } finally { restore(); }
  });
});
