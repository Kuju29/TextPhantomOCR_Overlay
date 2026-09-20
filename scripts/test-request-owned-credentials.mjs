import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {autoAiSettingsIssue} from '../src/shared/ai-settings-contract.js';
for(const hasServerKey of [true,false,null,undefined]) {
  assert.equal(autoAiSettingsIssue({aiProvider:'huggingface',aiKey:''},{hasServerKey})?.code,'missing_api_key');
  assert.equal(autoAiSettingsIssue({aiProvider:'huggingface',aiKey:'USER_KEY'},{hasServerKey}),null);
  assert.equal(autoAiSettingsIssue({aiProvider:'ollama',aiBaseUrl:'http://localhost:11434',aiKey:''},{hasServerKey}),null);
}
for(const path of ['src/background/context-menu.js','src/popup/controllers/settings-persistence-controller.js','src/popup/controllers/popup-ui-controller.js']) {
  const s=await readFile(new URL('../'+path,import.meta.url),'utf8');
  assert.doesNotMatch(s,/has_env_ai_key|serverHasAiKey|needsServerKeyFact/,'no server-key network lookup or stale metadata authorization');
}
console.log('PASS request-owned Cloud key; Local keyless; no server-key metadata preflight');
