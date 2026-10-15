// Actual example formatter, prompt composer and layout verifier. No providers,
// browser, storage, filesystem output, account or external network are used.
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';

globalThis.crypto ||= webcrypto;
const {
  composeTranslatorIdentitySystem, composeTranslationUserMessage,
  buildStaticUserPrefix, buildStyleExamples,
} = await import('../src/shared/ai/direct-local/prompt.js');
const {formatIndependentStoryExamples, boundedIndependentPairs} =
  await import('../src/shared/ai/independent/examples.js');
const baseline = process.argv.includes('--baseline');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let baselineLayoutCommit;
async function layoutModule() {
  if (!baseline) return import('../src/shared/ai/prompt-layout.js');
  // Only the exact immutable HEAD layout is substituted. Its relative imports
  // remain actual current modules; no copied fixture reimplements the verifier.
  assert(vm.SourceTextModule, 'Run baseline with node --experimental-vm-modules');
  const entry = path.join(root, 'src/shared/ai/prompt-layout.js');
  const code = execFileSync('git', ['show', 'HEAD:TextPhantom/src/shared/ai/prompt-layout.js'],
                            {cwd: root, encoding: 'utf8'});
  baselineLayoutCommit = execFileSync('git', ['rev-parse', 'HEAD'],
                                     {cwd: root, encoding: 'utf8'}).trim();
  const context = vm.createContext({crypto: webcrypto, TextEncoder, TextDecoder, URL,
    structuredClone, console});
  const modules = new Map();
  async function moduleFor(file) {
    if (modules.has(file)) return modules.get(file);
    const pending = (async () => {
      const content = file === entry ? code : await readFile(file, 'utf8');
      return new vm.SourceTextModule(content, {context, identifier: file,
        initializeImportMeta(meta) { meta.url = pathToFileURL(file).href; }});
    })();
    modules.set(file, pending);
    return pending;
  }
  const module = await moduleFor(entry);
  await module.link((specifier, referrer) => moduleFor(path.resolve(path.dirname(referrer.identifier), specifier)));
  await module.evaluate();
  return module.namespace;
}
const {promptLayout} = await layoutModule();
const {STYLE_EXAMPLES} = await import('../src/generated/localization-content.js');

const cases = [];
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const targetLang = 'th';
const sourceRecords = '<<TP_P0:Current source remains independent>>';
const count = value => Array.from(value).length;

function compose(style, selection, {language = '', enabled = true} = {}) {
  const selected = [language, style].filter(Boolean).join('\n');
  const system = composeTranslatorIdentitySystem(selected, targetLang);
  const user = composeTranslationUserMessage({
    sections: {language, style, useStyleExamples: enabled, runtime: ''},
    requestOutputContract: 'OUTPUT: Return only the current P0 record.',
    sourceRecords, targetLang, sourceLang: 'en', independentExamples: selection,
  });
  const prefix = buildStaticUserPrefix(targetLang, 'en', false, enabled,
                                      selected, false, selection);
  return {system, user, prefix, selected, selection, enabled};
}

async function layout(value, system = value.system) {
  return promptLayout(system, value.user, {targetLang, sourceLang: 'en',
    selectedStyle: value.selected, examples: value.enabled,
    independentExamples: value.selection});
}

function assertFullPrefixEvidence(value, evidence) {
  assert(value.user.startsWith(value.prefix + '\n\n'));
  assert.equal(evidence.systemStyleCopies, 1);
  assert.equal(evidence.userStyleCopies, 0,
    'an incidental style string in example data is not a User instruction');
  assert.equal(evidence.userStaticChars, count(value.prefix),
    'actual transmitted example text remains in the measured prefix');
  assert.equal(evidence.userStaticSha256, digest(value.prefix));
  assert.equal(evidence.staticPrefixSha256, digest(value.system + '\0' + value.prefix));
  assert.equal(evidence.systemSha256, digest(value.system));
  assert.equal(evidence.dynamicChars, count(value.user) - count(value.prefix));
}

async function check(name, run) {
  try { await run(); cases.push({name, status: 'pass'}); }
  catch (error) { cases.push({name, status: 'fail', error: error.message}); }
}

await check('accepted source equals the selected editable style without becoming an instruction', async () => {
  const style = 'Use natural Thai.';
  const selection = {source: 'story', pairs: [{src: style, tgt: 'ใช้ภาษาไทยที่เป็นธรรมชาติ'}]};
  assert.deepEqual(boundedIndependentPairs(selection.pairs), selection.pairs);
  const formatted = formatIndependentStoryExamples(selection, targetLang);
  assert(formatted.includes(style));
  const value = compose(style, selection);
  assert(value.prefix.includes(formatted));
  const evidence = await layout(value);
  assertFullPrefixEvidence(value, evidence);
  assert.equal(evidence.independentExamples.source, 'story');
  assert.equal(evidence.independentExamples.includedPairs, 1);
  assert.equal(evidence.independentExamples.exampleChars, count(formatted));
});

await check('the full canonical target-header style may occur across accepted data rows', async () => {
  const language = 'ภาษาปลายทาง: ภาษาไทย';
  const style = '2. ต้นฉบับ: anything';
  const selection = {source: 'story', pairs: [
    {src: 'First', tgt: language},
    {src: 'anything', tgt: 'อย่างไรก็ได้'},
  ]};
  assert.deepEqual(boundedIndependentPairs(selection.pairs), selection.pairs);
  const formatted = formatIndependentStoryExamples(selection, targetLang);
  const value = compose(style, selection, {language});
  assert(formatted.includes(value.selected),
    'the fixture must collide with the same full target-header style used in production');
  assertFullPrefixEvidence(value, await layout(value));
});

await check('human corpus data matching the selected style is measured without false duplication', async () => {
  const style = STYLE_EXAMPLES[0].en;
  assert(style.length > 0);
  const selection = {source: 'human', pairs: [], humanExampleCount: 4};
  const formatted = buildStyleExamples(targetLang, [], false, 'en', 4);
  assert(formatted.includes(style));
  const value = compose(style, selection);
  assert(value.prefix.includes(formatted));
  const evidence = await layout(value);
  assertFullPrefixEvidence(value, evidence);
  assert.equal(evidence.independentExamples.source, 'human');
  assert.equal(evidence.independentExamples.includedPairs, 4);
});

await check('duplicated style in the actual System still fails', async () => {
  const value = compose('Use natural Thai.', {source: 'none', pairs: []});
  await assert.rejects(layout(value, value.system + '\n\n' + value.selected),
                       /prompt_style_delivery_mismatch/);
});

await check('tampering with the actual static User prefix still fails', async () => {
  const value = compose('Use natural Thai.', {source: 'story',
    pairs: [{src: 'A valid earlier source', tgt: 'คำแปลก่อนหน้า'}]});
  value.user = 'Unexpected prefix before task\n' + value.user;
  await assert.rejects(layout(value), /prompt_static_prefix_mismatch/);
});

await check('OFF removes colliding example data and preserves the complete remaining prompt evidence', async () => {
  const style = 'Use natural Thai.';
  const value = compose(style, {source: 'story',
    pairs: [{src: style, tgt: 'ใช้ภาษาไทยที่เป็นธรรมชาติ'}]}, {enabled: false});
  assert(!value.prefix.includes(style));
  const evidence = await layout(value);
  assertFullPrefixEvidence(value, evidence);
  assert.equal(evidence.examplesIncluded, false);
  assert.equal(evidence.independentExamples.exampleChars, 0);
});

const failures = cases.filter(row => row.status === 'fail');
console.log(JSON.stringify({suite: 'example-style-collision-10454',
  ...(baseline ? {baselineLayoutCommit} : {}),
  passed: cases.length - failures.length, total: cases.length, failures, cases}, null, 2));
if (failures.length) process.exitCode = 1;
