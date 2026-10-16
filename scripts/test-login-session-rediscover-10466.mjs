/** .66: a stored Login handle that outlived its API session is replaced by the
 * owner's current session from the API, without opening the popup.
 * All HTTP is fictional; no account or network use.
 */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});

const memory = {local:{tpDataConsentV1:{version:1, granted:true, at:1}}, session:{}}; // 10494: account data allowed
const area = data => ({get(keys, done){const list=Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||data);
  done(Object.fromEntries(list.map(key=>[key,structuredClone(data[key])])));}, set(patch, done){Object.assign(data, structuredClone(patch));done?.();},
  remove(keys, done){for(const key of [].concat(keys))delete data[key];done?.();}});
globalThis.chrome = {runtime:{id:'qa', getURL:x=>'chrome-extension://qa/'+x, lastError:undefined},
  storage:{local:area(memory.local), session:area(memory.session), onChanged:{addListener(){}}}};

const {resolveJobAiProfile} = await import('../src/background/ai-profile-resolver.js');
const {loginAuthScope} = await import('../src/shared/login-auth.js');

const base = 'http://localhost:7860', token = 'fiction-owner-token', provider = 'login_deepseek';
const stale = 'lgs_' + 'a'.repeat(48), fresh = 'lgs_' + 'b'.repeat(48), account = 'c'.repeat(32);
const scope = await loginAuthScope(base, token);
const requests = [];
const json = (status, body) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});

async function run({liveSession}) {
  requests.length = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    requests.push(path);
    if (path === '/meta') return json(200, {paid:{available:true}});
    if (path === '/paid/me') return json(200, {email:'qa@example.invalid', models:[],
      addons:{entitlements:[{code:'ai_login', status:'active'}]}});
    if (path === '/login/providers') return json(200, {providers:[{id:provider,
      session: liveSession ? {id:fresh, provider, account_id:account} : null}]});
    if (path.startsWith('/login/providers/' + provider + '/models')) {
      const id = new URL(url).searchParams.get('session_id');
      if (id !== fresh) return json(401, {error:{code:'login_session_expired', message:'Sign in to your AI account again.'}});
      return json(200, {session:{id:fresh, provider, account_id:account, transport:'web_endpoint'},
        models:[{id:'deepseek-web', model_capabilities:{}}]});
    }
    throw new Error('Unexpected request ' + path);
  };
  const settings = {aiServiceMode:'paid', paidTranslationSource:'login', paidSessionToken:token, paidApiBase:base,
    customApiUrl:base, apiUrlDefault:base, loginProvider:provider, loginModel:'deepseek-web', lang:'th',
    loginConnectionsV2:{[scope + ':' + provider]:{session:{id:stale, provider, account_id:account, transport:'web_endpoint'},
      model:'deepseek-web', verifiedAt:1}}};
  memory.local.customApiUrl = base; memory.local.apiUrlDefault = base; memory.local.apiDefaultsFetchedAt = Date.now(); memory.local.paidSessionToken = token; memory.local.paidApiBase = base; // 10495: the session is read through the account gate
  return resolveJobAiProfile(settings, {language:'th'});
}

const ok = await run({liveSession:true});
assert.equal(ok.settings.aiProvider, 'login');
assert.equal(ok.settings.aiModel, fresh + '/deepseek-web');
assert.deepEqual(requests.filter(x => x.startsWith('/login')), [
  '/login/providers/' + provider + '/models?session_id=' + stale,
  '/login/providers',
  '/login/providers/' + provider + '/models?session_id=' + fresh]);

await assert.rejects(run({liveSession:false}), error => error.code === 'LOGIN_SESSION_EXPIRED' && /press Login once/.test(error.message));
console.log(JSON.stringify({passed:2, scope:'stored stale Login handle -> owner rediscovery, no popup'}));
