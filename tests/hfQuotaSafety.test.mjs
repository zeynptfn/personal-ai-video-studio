import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFreeQuota, inspectHfFreeQuota, QUOTA_ENDPOINT } from '../lib/server/hfQuotaSafety.mjs';

const now = Date.now();
const quota = { base: 300, current: 200, resetsAt: new Date(now+3600000).toISOString(), overquotaUsed: 0 };

test('even sufficient quota never enables authenticated generation', () => {
  assert.equal(assessFreeQuota(quota,{now}).reason,'ATOMIC_FREE_ONLY_ENFORCEMENT_UNVERIFIED');
  assert.equal(assessFreeQuota(quota,{now}).allowed,false);
  assert.equal(assessFreeQuota(quota,{now}).authenticatedGenerationEnabled,false);
});
test('insufficient and negative quota fail closed; xlarge duration is accounted for', () => {
  for (const current of [-60,0,119]) assert.equal(assessFreeQuota({...quota,current},{now}).reason,'INSUFFICIENT_FREE_QUOTA');
  assert.equal(assessFreeQuota({...quota,current:140},{now,duration:8}).reason,'INSUFFICIENT_FREE_QUOTA');
  assert.equal(assessFreeQuota({...quota,current:120},{now}).allowed,false);
});
test('missing, malformed, expired or partial quota information is never trusted', () => {
  for (const input of [null,{}, {...quota,current:'200'}, {...quota,current:Infinity}, {...quota,base:NaN},
    {...quota,current:301}, {...quota,resetsAt:'invalid'}, {...quota,resetsAt:0},
    {...quota,resetsAt:new Date(now-1000).toISOString()}, {...quota,overquotaUsed:null},
    {base:300,current:200,overquotaUsed:0}]) {
    assert.equal(assessFreeQuota(input,{now}).reason,'QUOTA_UNVERIFIED');
  }
  assert.equal(assessFreeQuota({...quota,resetsAt:null},{now}).allowed,false);
});
test('any paid overquota is rejected and no duration setting can enable a job', () => {
  assert.equal(assessFreeQuota({...quota,overquotaUsed:1},{now}).reason,'PAID_OVERQUOTA_DETECTED');
  for (const duration of [NaN,Infinity,0,-1,9]) assert.equal(assessFreeQuota(quota,{now,duration}).reason,'INVALID_DURATION');
});
test('missing token makes zero network calls',async()=>{
  const result=await inspectHfFreeQuota({fetchImpl:()=>assert.fail('Unexpected network call')});
  assert.equal(result.reason,'HF_TOKEN_NOT_CONFIGURED');assert.equal(result.allowed,false);
});
test('only the fixed read-only endpoint receives a token; output has no credential or identity',async()=>{
  const token='synthetic-unit-test-only';const calls=[];
  const result=await inspectHfFreeQuota({token,now,fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({...quota,arbitraryPrivateField:'must not escape'});
  }});
  assert.equal(calls.length,1);assert.equal(calls[0].url,QUOTA_ENDPOINT);assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${token}`);
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.cache,'no-store');
  assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes('must not escape'));assert.equal(result.allowed,false);
});
test('upstream failures, forbidden billing scope and errors cannot leak secrets or fall back',async()=>{
  for (const status of [401,403,429,500]) {
    let calls=0;const result=await inspectHfFreeQuota({token:'synthetic-only',fetchImpl:async()=>{calls++;return new Response('private upstream response',{status});}});
    assert.equal(calls,1);assert.equal(result.allowed,false);assert.ok(!JSON.stringify(result).includes('private upstream'));
  }
  for (const fetchImpl of [async()=>{throw new Error('secret network details');},async()=>new Response('not JSON')]) {
    const result=await inspectHfFreeQuota({token:'synthetic-only',fetchImpl});assert.equal(result.reason,'QUOTA_UNAVAILABLE');
  }
});
