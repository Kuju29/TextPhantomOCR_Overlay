/** Last successful scoped presentation. Never authorization or payment state.
 * Explicit field lists prevent provider credentials, OTPs, bank details and
 * payment links from being copied into another storage record. */
export const PAID_VIEW_CACHE_KEY = 'paidAccountViewCacheV1';
export const PAID_VIEW_CACHE_TTL_MS = 60000;
const MAX_PAID_VIEW_MODELS = 5000;
const PERMANENT_QUOTE_FAILURES=new Set(['PAID_ROUTE_UNAVAILABLE','PAID_MODEL_PARAMETER_UNSUPPORTED',
  'PAID_THINKING_UNSUPPORTED','PAID_IMAGE_UNSUPPORTED','PAID_OUTPUT_UNSUPPORTED']);
// This single allowlist governs both retry suppression and cached display hints.
// Missing capability evidence and temporary refresh failures must be retried.
export const isPermanentPaidQuoteFailure=code=>PERMANENT_QUOTE_FAILURES.has(code);
const queues = new Map();
const string = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : '';
const amount = value => /^\d{1,40}$/.test(String(value ?? '')) ? String(value) : '0';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const list = value => Array.isArray(value) ? value.slice(0, 100) : [];
function modelInventory(value) {
  if (!value || !['selected','all'].includes(value.mode) || !['current','unavailable'].includes(value.status) ||
    !['saved','key'].includes(value.scope) || !Number.isSafeInteger(value.key_revision) || value.key_revision < 0 ||
    value.checked_at != null && (!Number.isSafeInteger(value.checked_at) || value.checked_at < 0) ||
    value.live_availability_verified !== false) return null;
  return {mode:value.mode,status:value.status,scope:value.scope,key_revision:value.key_revision,
    checked_at:value.checked_at??null,live_availability_verified:false};
}
export const paidModelInventoryReady = value => value?.model_inventory?.status !== 'unavailable';
export const paidInventoryFailureMessage = value => paidModelInventoryReady(value) ? ''
  : value.models?.length ? 'Could not refresh the model catalogue. Previous models are shown; translation is paused. Refresh balance to try again.'
    : 'Could not refresh the model catalogue. Translation is paused. Refresh balance to try again.';
export function paidInventoryDisplay(value, previous) {
  if (paidModelInventoryReady(value)) return value;
  const inventory = modelInventory(value.model_inventory), prior = modelInventory(previous?.model_inventory);
  const same = inventory && prior && ['mode','scope','key_revision'].every(key=>inventory[key]===prior[key]);
  const models = same ? summary(previous)?.models || [] : [];
  return {...value,models:models.map(row=>({...row,
    ...(row.price_sync?.automatic===true?{price_sync:{...row.price_sync,status:'stale'}}:{}),
    route_price_sync:{status:'unavailable',account_policy_verified:false}}))};
}
// Validate live presentation before it can replace a successful snapshot.
// Account and spending authority remain separate server-owned decisions.
export function validPaidAccountView(value, {requireModels=false}={}) {
  const object = row => row && typeof row === 'object' && !Array.isArray(row);
  const tp = row => typeof row === 'string' ? /^\d{1,40}$/.test(row)
    : Number.isSafeInteger(row) && row >= 0;
  if (!object(value) || !object(value.credits) || !tp(value.credits.available) ||
    'held' in value.credits && !tp(value.credits.held)) return false;
  if (['consumed','purchased','trial','granted','expired','revoked'].some(key=>key in value.credits && !tp(value.credits[key]))) return false;
  if (value.email !== undefined && typeof value.email !== 'string') return false;
  if (value.model_inventory !== undefined && !modelInventory(value.model_inventory)) return false;
  if (requireModels || 'models' in value) {
    if (!Array.isArray(value.models) || value.models.length > MAX_PAID_VIEW_MODELS ||
      value.models.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 ||
        row.name !== undefined && typeof row.name !== 'string' || row.eligible_tp !== undefined && !tp(row.eligible_tp)) ||
      new Set(value.models.map(row=>row.id)).size !== value.models.length) return false;
  }
  if (value.addons !== undefined && (!object(value.addons) ||
    ['entitlements','products','orders'].some(key=>key in value.addons &&
      (!Array.isArray(value.addons[key]) || value.addons[key].some(row=>!object(row)))))) return false;
  return true;
}
const pickText = (value, names, max = 256) => Object.fromEntries(names
  .filter(name => typeof value?.[name] === 'string').map(name => [name, string(value[name], max)]));
function price(value) {
  const rate=x=>typeof x==='string'&&/^\d{1,40}(?:\.\d{1,40})?$/.test(x)&&Number.isFinite(Number(x));
  if(value?.status!=='estimated'||value.unit!=='TP_PER_1000_TOKENS'||!rate(value.input_tp)||!rate(value.output_tp))return null;
  return {status:'estimated',unit:'TP_PER_1000_TOKENS',...pickText(value,['input_tp','output_tp'],81),
    ...pickText(value,['basis'],48),...(['base','conditional_ceiling'].includes(value.tariff_basis)?{tariff_basis:value.tariff_basis}:{}),
    ...Object.fromEntries(['model_revision','policy_revision'].filter(key=>Number.isSafeInteger(value[key])&&value[key]>=0).map(key=>[key,value[key]]))};
}
export async function accountViewScope(base, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base + '\n' + token));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function summary(value) {
  if (!validPaidAccountView(value, {requireModels:true})) return null;
  return {
    email: string(value.email, 254),
    ...(modelInventory(value.model_inventory)?{model_inventory:modelInventory(value.model_inventory)}:{}),
    credits: Object.fromEntries(['available', 'held', 'consumed', 'purchased', 'trial', 'granted', 'expired', 'revoked']
      .map(name => [name, amount(value.credits[name])])),
    models: value.models.map(model => ({
      ...pickText(model, ['id', 'name']), eligible_tp: amount(model.eligible_tp),
      trial_allowed: model.trial_allowed === true,
      wallet_processing:model.wallet_processing===true,
      availability:{available:model.availability?.available!==false,
        reason:model.availability?.reason==='PAID_MODEL_PAUSED'?'PAID_MODEL_PAUSED':null},
      max_output: integer(model.max_output ?? model.max_tokens),
      ...(model.price_sync?.automatic===true&&['current','stale','unavailable'].includes(model.price_sync?.status)?{
        price_sync:{automatic:true,status:model.price_sync.status,checked_at:Number.isSafeInteger(model.price_sync.checked_at)&&model.price_sync.checked_at>=0?model.price_sync.checked_at:null},
      }:{}),
      ...(price(model.pricing)?{pricing:price(model.pricing)}:{}),
      ...(price(model.catalogue_pricing)?{catalogue_pricing:price(model.catalogue_pricing)}:{}),
      ...(model.route_quote_failure&&isPermanentPaidQuoteFailure(model.route_quote_failure.code)&&/^[a-f0-9]{64}$/.test(model.route_quote_failure.context)?{
        route_quote_failure:{code:model.route_quote_failure.code,context:model.route_quote_failure.context,
          ...(string(model.route_quote_failure.message,300)?{message:string(model.route_quote_failure.message,300)}:{})},
      }:{}),
    })),
    paid_paused: value.paid_paused === true,
    ...(value.paid_restriction?{paid_restriction:{blocked:value.paid_restriction.blocked===true,
      ...pickText(value.paid_restriction,['code','reason'],100)}}:{}),
    addons:{entitlements:list(value.addons?.entitlements).map(item=>pickText(item,['code','status','name']))},
  };
}
function catalog(value) {
  const data = summary(value);
  if (!data || !Array.isArray(value.packages)) return null;
  return {
    ...data, expiring_tp: amount(value.expiring_tp),
    packages: value.packages.slice(0, 100).map(pack => ({
      ...pickText(pack, ['id', 'name']), version: integer(pack?.version),
      credits: amount(pack?.credits), price_satang: integer(pack?.price_satang), months: integer(pack?.months),
      enabled: pack?.enabled !== false, visible: pack?.visible !== false,
    })),
    purchase: { ready: value.purchase?.ready === true },
    addons: {
      products: list(value.addons?.products).map(pack => ({
        ...pickText(pack, ['code', 'name', 'refund_policy']),
        ...pickText(pack, ['terms', 'refund_terms'], 8000),
        version: integer(pack?.version), price_satang: integer(pack?.price_satang),
        ready: pack?.ready === true, enabled: pack?.enabled !== false, visible: pack?.visible !== false,
      })),
      // Displaying owned access never verifies access for the Login controller.
      entitlements: list(value.addons?.entitlements).map(item => pickText(item, ['code', 'status', 'name'])),
      orders: [],
    },
    history: Object.fromEntries(['orders', 'payments', 'usage', 'lots', 'refunds', 'ledger']
      .map(name => [name, { items: [], total: 0, offset: 0, limit: 25 }])),
  };
}
const sanitize = (kind, value) => kind === 'me' ? summary(value) : kind === 'account' ? catalog(value) : null;
const validScope = scope => typeof scope === 'string' && /^[a-f0-9]{64}$/.test(scope);
function current(record, scope, kind, now, allowStale=false) {
  const updatedAt = record?.[kind + 'UpdatedAt'] ?? record?.updatedAt;
  return record?.version === 1 && record.scope === scope && validScope(scope) &&
    Number.isFinite(updatedAt) && now >= updatedAt && (allowStale || now - updatedAt < PAID_VIEW_CACHE_TTL_MS);
}
function queue(write, operation) {
  const previous = queues.get(write) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(write, next);
  void next.finally(() => { if (queues.get(write) === next) queues.delete(write); }).catch(() => {});
  return next;
}
export function createPaidViewCache({ read, write, now = Date.now }) {
  return {
    async restore(scope, kind, {allowStale=true}={}) {
      try {
        const record = (await read([PAID_VIEW_CACHE_KEY]))?.[PAID_VIEW_CACHE_KEY];
        return current(record, scope, kind, now(), allowStale) ? sanitize(kind, record[kind]) : null;
      } catch { return null; }
    },
    remember(scope, kind, value) {
      const data = sanitize(kind, value), updatedAt = now();
      if (!validScope(scope) || !data) return Promise.resolve();
      return queue(write, async () => {
        const previous = (await read([PAID_VIEW_CACHE_KEY]))?.[PAID_VIEW_CACHE_KEY];
        const record = { version: 1, scope, updatedAt, [kind + 'UpdatedAt']: updatedAt, [kind]: data };
        const other = kind === 'me' ? 'account' : 'me';
        if (current(previous, scope, other, now(), true)) {
          record[other] = sanitize(other, previous[other]);
          record[other + 'UpdatedAt'] = previous[other + 'UpdatedAt'] ?? previous.updatedAt;
        }
        await write({ [PAID_VIEW_CACHE_KEY]: record });
      }).catch(() => {});
    },
    clear(scope = '') {
      return queue(write, async () => {
        const previous = (await read([PAID_VIEW_CACHE_KEY]))?.[PAID_VIEW_CACHE_KEY];
        if (!scope || previous?.scope === scope) await write({ [PAID_VIEW_CACHE_KEY]: null });
      }).catch(() => {});
    },
  };
}
