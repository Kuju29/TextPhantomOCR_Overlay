import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isPrivateRuntimeArtifact,isForbiddenProjectArchiveEntry} from './source-package-policy.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const variables=['TP_MASTER_KEY_FILE','TP_CENTER_GATEWAY_KEY_FILE'];
const old=Object.fromEntries(variables.map(name=>[name,process.env[name]]));
for(const name of variables)delete process.env[name];
try{
  for(const file of ['api/operator-secret.key','api/DEPLOY/OPERATOR-SECRET.KEY'])
    assert.equal(isPrivateRuntimeArtifact(file),true,'Arbitrary private-key files cannot enter the source archive.');
  for(const name of variables){
    process.env[name]=path.join(root,'api','deployment','operator-material.json');
    assert.equal(isPrivateRuntimeArtifact('api/deployment/operator-material.json'),true,'Configured private paths are excluded regardless of basename.');
    assert.equal(isForbiddenProjectArchiveEntry('api/deployment/operator-material.json'),true);
    assert.equal(isPrivateRuntimeArtifact('api/deployment/public-config.json'),false);
    delete process.env[name];
  }
  for(const file of ['api/.env','api/.env.production','api/master.key','api/gateway.key','api/session.key','api/data.sqlite3-wal'])
    assert.equal(isPrivateRuntimeArtifact(file),true);
  for(const file of ['api/.env.example','api/.env.sample','api/backend/ai/login/endpoint/deepseek-pow-MIT.txt',
    'api/third_party/LICENSE.txt','docs/public-key.json','api/deploy/id_ed25519.pub'])
    assert.equal(isPrivateRuntimeArtifact(file),false,'Public source/licensing documents stay distributable.');
  console.log(JSON.stringify({passed:true,checks:6,syntheticOnly:true,privateFileContentsRead:false}));
}finally{
  for(const [name,value] of Object.entries(old))if(value===undefined)delete process.env[name];else process.env[name]=value;
}
