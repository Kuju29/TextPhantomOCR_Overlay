// 10490 E2E finding: translating a 27 MB page image (above the API's 24 MiB
// cap) showed "ส่วนขยายอ่านไฟล์ภาพไม่ได้ · IMG_READ_FAILED". The browser did
// refuse it before upload (no 413), but the Lens-direct reader reported every
// byte-read failure as IMG_READ_FAILED, and "Image too large" was classified
// as retryable. The user must get IMG_TOO_LARGE ("ภาพมีขนาดใหญ่เกินไป
// (API รับภาพได้ไม่เกิน 24 MiB)") and no retry pass.
import assert from 'node:assert/strict';

const {classifyJobError} = await import('../src/background/images.js');
const {createLensDirectPath} = await import('../src/background/pipeline/lens-direct.js');
const {userMessageForCode} = await import('../src/shared/error-contract.js');

assert.equal(classifyJobError(new Error('Image too large')).permanent, true, 'a too-large image is not retried');
assert.equal(classifyJobError('Image too large').permanent, true);
assert.equal(classifyJobError(new Error('socket hang up')).permanent, false, 'transport errors stay transient');
console.log('PASS "Image too large" is a permanent image failure');

const lensCalls = [];
const run = createLensDirectPath({
  fetchFromUrl: async () => { throw new Error('Image too large'); },
  fetchFromTab: async () => { throw new Error('tab fetch must not be used'); },
  fetchLensRaw: async (...args) => { lensCalls.push(args); return {}; },
  groupParagraphs: async () => ({}),
  runStage: async (_lane, work) => work(),
  markPhase() {}, trace() {}, traceLayout() {}, getTrace: () => '', log: {info() {}, warn() {}, debug() {}},
});
const payload = {mode:'lens_text', render:{lensDocument:true}, src:'https://example.test/big.png', lang:'th',
  context:{page_url:'https://example.test/big.html'}, metadata:{image_id:'img-1', batch_id:'b-1'}};
const decline = {};
let thrown = null;
try { await run('https://api.test', payload, {tabId:1, frameId:0, jobId:'j-1', decline}); }
catch (error) { thrown = error; }
const error = thrown || decline.error;
assert(error, 'the path stops with an error');
assert.equal(error.tpError?.code, 'IMG_TOO_LARGE', `code was ${error.tpError?.code}`);
assert.equal(error.tpError?.retryable, false);
assert.equal(lensCalls.length, 0, 'nothing is uploaded to Lens');
assert.match(userMessageForCode('IMG_TOO_LARGE'), /24 MiB/);
console.log('PASS Lens-direct reader reports IMG_TOO_LARGE (24 MiB message) before any upload');

// Other byte-read failures keep their codes.
const other = createLensDirectPath({
  fetchFromUrl: async () => { throw new Error('Failed to fetch'); },
  fetchFromTab: async () => null, fetchLensRaw: async () => ({}), groupParagraphs: async () => ({}),
  runStage: async (_lane, work) => work(), markPhase() {}, trace() {}, traceLayout() {}, getTrace: () => '',
  log: {info() {}, warn() {}, debug() {}},
});
const decline2 = {};
let thrown2 = null;
try { await other('https://api.test', payload, {tabId:1, frameId:0, jobId:'j-2', decline:decline2}); }
catch (e) { thrown2 = e; }
assert.equal((thrown2 || decline2.error)?.tpError?.code, 'IMG_READ_FAILED');
console.log('PASS other read failures stay IMG_READ_FAILED');
