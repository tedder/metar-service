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
