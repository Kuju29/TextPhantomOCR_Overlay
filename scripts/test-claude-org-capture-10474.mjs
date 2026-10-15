// .74 Claude Login: /api/bootstrap no longer returns account.lastActiveOrgId
// (real account, 2026-10-12: keys tagged_id, uuid, email_address, ..., memberships,
// no lastActiveOrgId). The capture must still pick the organization the website
// uses, without guessing between several.
// Run: node --experimental-vm-modules scripts/test-claude-org-capture-10474.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readProviderLogin} from '../src/background/login/endpoint/login_endpoint_capture.js';

const account = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const orgA = '11111111-2222-4333-8444-555555555555', orgB = '66666666-7777-4888-8999-000000000000';
const member = (uuid, capabilities = ['chat']) => ({role: 'admin', organization: {uuid, capabilities}});
const hash = async text => Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

async function capture(accountBody, cookie = '') {
  const window = {}; window.top = window;
  const context = vm.createContext({window, URL, AbortSignal, TextEncoder, crypto: webcrypto, JSON, String, Array,
    location: {origin: 'https://claude.ai', pathname: '/new'}, document: {cookie},
    fetch: async path => { assert.equal(path, '/api/bootstrap'); return {ok: true, status: 200, json: async () => ({account: accountBody})}; }});
  const run = new vm.Script('(' + readProviderLogin.toString() + ')').runInContext(context);
  return run('login_claude', 'https://claude.ai');
}

let checks = 0;
// Real 2026-10-12 shape: no lastActiveOrgId, one chat membership.
let r = await capture({uuid: account, memberships: [member(orgA)]});
assert.equal(r.ok, true); assert.equal(r.credentials.organization, orgA);
assert.equal(r.expected_identity, await hash(account + '\0' + orgA)); checks++;

// lastActiveOrgId (older shape) still wins.
r = await capture({uuid: account, lastActiveOrgId: orgB, memberships: [member(orgA), member(orgB)]});
assert.equal(r.credentials.organization, orgB); checks++;

// Several chat organizations: the website's lastActiveOrg cookie decides; no cookie -> ask.
r = await capture({uuid: account, memberships: [member(orgA), member(orgB)]}, 'x=1; lastActiveOrg=' + orgB + '; y=2');
assert.equal(r.credentials.organization, orgB); checks++;
r = await capture({uuid: account, memberships: [member(orgA), member(orgB)]});
assert.deepEqual({...r}, {ok: false, code: 'login_organization_required'}); checks++;

// A cookie naming an organization the account is not a chat member of is ignored.
r = await capture({uuid: account, memberships: [member(orgA), member(orgB, ['api'])]}, 'lastActiveOrg=' + orgB);
assert.equal(r.credentials.organization, orgA); checks++;

// Only non-chat organizations, or no account id -> typed failure, no guess.
r = await capture({uuid: account, memberships: [member(orgA, ['api'])]});
assert.equal(r.code, 'login_organization_required'); checks++;
r = await capture({memberships: [member(orgA)]});
assert.equal(r.code, 'login_required'); checks++;

console.log(`PASS ${checks} Claude organization capture checks (bootstrap without lastActiveOrgId)`);
