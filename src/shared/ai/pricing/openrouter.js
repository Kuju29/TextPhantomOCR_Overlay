import {money,multiplyMoney} from './money.js';

const axes={prompt:'input',completion:'output',input_cache_read:'cached',input_cache_write:'cacheWrite',input_cache_write_1h:'cacheWrite1h'};
const ancillary=['request','image','image_token','image_output','audio','audio_output','input_audio_cache','web_search','internal_reasoning'];
const conditions=['min_prompt_tokens','utc_start','utc_end','utc_days'];
const weekdays=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clock=value=>Number.isInteger(value)&&value>=0&&value<=2359&&value%100<60;
const perMillion=value=>{
 const result=multiplyMoney(value,'1000000');
 return result!==null&&Number(result)<=10000?result:null;
};
// OpenRouter documents token prices in USD/token. Do not round these small
// values before conversion, or assume a missing cache price means free cache.
export function normalizeOpenRouterPrice(value){
 if(!record(value))return null;
 const rates={};
 for(const [key,axis]of Object.entries(axes)){
  if(!(key in value))continue;
  rates[axis]=perMillion(value[key]);if(rates[axis]===null)return null;
 }
 if(rates.input==null||rates.output==null)return null;
 rates.extraFees=ancillary.some(key=>Number(money(value[key])||0)>0);
 if(ancillary.some(key=>key in value&&money(value[key])===null))return null;
 if(value.discount!=null&&multiplyMoney(value.discount,'1')!=='0')return null;
 if(value.overrides!=null){
  if(!Array.isArray(value.overrides)||value.overrides.length>64)return null;
  rates.pricingOverrides=[];
  for(const entry of value.overrides){
   if(!record(entry))return null;
   if(ancillary.some(key=>key in entry&&money(entry[key])===null))return null;
   if(Object.keys(entry).some(key=>!conditions.includes(key)&&!Object.hasOwn(axes,key)&&!ancillary.includes(key))){rates.unsupportedPricingConditions=true;continue;}
   const next={};
   if('min_prompt_tokens'in entry){if(!Number.isSafeInteger(entry.min_prompt_tokens)||entry.min_prompt_tokens<0)return null;next.min_prompt_tokens=entry.min_prompt_tokens;}
   if('utc_start'in entry||'utc_end'in entry){if(!clock(entry.utc_start)||!clock(entry.utc_end))return null;next.utc_start=entry.utc_start;next.utc_end=entry.utc_end;}
   if('utc_days'in entry){if(!Array.isArray(entry.utc_days)||!entry.utc_days.length||entry.utc_days.length>7||entry.utc_days.some(day=>!weekdays.includes(day)))return null;next.utc_days=[...new Set(entry.utc_days)];}
   for(const [key,axis]of Object.entries(axes))if(key in entry){next[axis]=perMillion(entry[key]);if(next[axis]===null)return null;}
   if(ancillary.some(key=>Number(money(entry[key])||0)>0))rates.extraFees=true;
   rates.pricingOverrides.push(next);
  }
 }
 return rates;
}

// Later matching entries override each price axis; absent axes inherit. UTC
// windows are half-open and may wrap midnight, as documented by OpenRouter.
export function resolveOpenRouterPrice(rate,event){
 if(rate.unsupportedPricingConditions)return {error:'unsupported_price_conditions',rate};
 const overrides=rate.pricingOverrides||[];
 if((event.requests||1)>1&&overrides.some(row=>row.min_prompt_tokens!=null||row.utc_start!=null||row.utc_days))return {error:'unknown_per_request_tier',rate};
 const timed=overrides.some(row=>row.utc_start!=null||row.utc_days);
 // Receipt completion and shared operation start clocks do not prove when an
 // individual provider request began. Only transport-owned dispatch evidence
 // may select a time-dependent tariff; current normal receipts carry none.
 const requestTime=event.providerRequestStartedAt;
 if(timed&&(event.providerRequestTimeSource!=='provider_transport'||!Number.isSafeInteger(requestTime)||requestTime<=0))return {error:'missing_price_request_time',rate};
 const date=timed?new Date(requestTime):null;
 if(timed&&!Number.isFinite(date.getTime()))return {error:'missing_price_request_time',rate};
 const hhmm=timed?date.getUTCHours()*100+date.getUTCMinutes():0;
 const result={...rate};
 for(const row of overrides){
  if(row.min_prompt_tokens!=null&&!(Number.isSafeInteger(event.inputTokens)&&event.inputTokens>row.min_prompt_tokens))continue;
  if(row.utc_days&&!row.utc_days.includes(weekdays[date.getUTCDay()]))continue;
  if(row.utc_start!=null&&!(row.utc_start<row.utc_end?hhmm>=row.utc_start&&hhmm<row.utc_end:hhmm>=row.utc_start||hhmm<row.utc_end))continue;
  for(const axis of Object.values(axes))if(axis in row)result[axis]=row[axis];
 }
 return {rate:result};
}
