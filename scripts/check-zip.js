'use strict';
// Validate deploy.zip: it holds exactly index.js, that index.js is the repo's, and the zipped copy
// loads and answers a CloudFront origin-request event for help (no network). Run after build-zip.sh:
//   node scripts/check-zip.js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const zip = path.join(root, 'deploy.zip');

const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
assert.deepEqual(listing, ['index.js'], `deploy.zip should hold only index.js, has: ${listing.join(', ')}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metar-zip-'));
execFileSync('unzip', ['-q', zip, '-d', dir]);
const zipped = fs.readFileSync(path.join(dir, 'index.js'));
assert.ok(zipped.equals(fs.readFileSync(path.join(root, 'index.js'))), 'zipped index.js differs from the repo');

const { handler } = require(path.join(dir, 'index.js'));
assert.equal(typeof handler, 'function', 'index.handler is not a function');

const event = { Records: [{ cf: { request: { querystring: 'help=1', uri: '/metar' } } }] };
handler(event).then((resp) => {
  assert.equal(resp.status, '200');
  assert.match(resp.body, /^icao,cat,r-g-b,age_mins,stale,wdir,wspd,wgst$/m, 'help has no CSV header row');
  assert.equal(resp.headers['cache-control'][0].value, 'max-age=300');
  console.log(`deploy.zip OK: index.js only (${zipped.length} bytes), handler answers help`);
}).catch((e) => { console.error(e); process.exit(1); });
