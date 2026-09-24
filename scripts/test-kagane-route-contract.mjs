import assert from 'node:assert/strict';
import { dispatchPreparedJob } from '../src/background/pipeline/engine-routing.js';
import { API_PATHS, engineApiPath } from '../src/shared/constants.js';

const canonical = { syncTranslate: true, engineRoutesV2: true };
const legacy = { syncTranslate: false, engineRoutesV2: false };
const image = { engine: 'extension', mode: 'lens_images', reader: { adapter: 'kagane' } };
const seen = [];
const dispatchSync = async (_base, payload, _context, options) => {
  seen.push({ adapter: payload.reader?.adapter, mode: payload.mode, route: engineApiPath(
    options.capabilities, API_PATHS.ENGINE_API_TRANSLATE, API_PATHS.TRANSLATE_V1,
  ) });
};
const dispatchLegacy = async () => { seen.push({ route: API_PATHS.TRANSLATE }); };

for (let index = 0; index < 51; index += 1) {
  const result = await dispatchPreparedJob({
    base: 'http://localhost:7860', payload: { ...image, metadata: { image_id: `image-${index}` } },
    makeContext: () => ({}), capabilities: canonical, dispatchOptions: {},
  }, { dispatchSync, dispatchLegacy });
  assert.equal(result, 'sync');
}
assert.equal(seen.length, 51);
assert(seen.every(request => request.route === API_PATHS.ENGINE_API_TRANSLATE),
  'Kagane Lens image requests must preserve the runs:API canonical route');
seen.length = 0;
assert.equal(await dispatchPreparedJob({ base: '', payload: image, makeContext: () => ({}),
  capabilities: legacy, dispatchOptions: {} }, { dispatchSync, dispatchLegacy }), 'legacy');
assert.deepEqual(seen, [{ route: API_PATHS.TRANSLATE }],
  'The old queue remains only a compatibility fallback when syncTranslate is unavailable');
console.log('PASS Kagane 51-image dispatch preserves the canonical runs:API route; legacy fallback stays capability-gated');
