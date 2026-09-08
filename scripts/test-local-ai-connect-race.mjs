import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const popup = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
const localConnection = await readFile(
  new URL("../src/popup/controllers/local-connection-controller.js", import.meta.url),
  "utf8",
);
const providerMeta = await readFile(
  new URL("../src/popup/controllers/provider-meta-controller.js", import.meta.url),
  "utf8",
);

assert.match(popup, /localConnectSeq:\s*0/);
assert.match(popup, /localConnectInFlight:\s*null/);
assert.match(providerMeta, /if \(state\.localConnectInFlight\) return;/,
  "automatic discovery must wait while explicit Connect owns the UI");
assert.match(providerMeta, /explicitAtStart !== state\.localConnectSeq/,
  "an auto result started before Connect must not overwrite it");

assert.match(localConnection, /clearResolveTimer\(\)/,
  "Connect must cancel a pending blur refresh");
assert.match(localConnection, /const sequence = \+\+state\.localConnectSeq/);
assert.doesNotMatch(localConnection, /sequence !== state\.aiMetaSeq/,
  "generic metadata refresh must not invalidate Connect");
assert.match(localConnection, /finally[\s\S]*setBusy\(false\)/,
  "the button must be restored on every terminal outcome");
assert.match(localConnection, /provider or URL changed/,
  "identity changes must have a visible terminal status");
assert.match(localConnection, /selectedModelVerification/,
  "Connect must consume selected-model generation verification");
assert.match(localConnection, /markModelChanged/,
  "changing a Local model must invalidate the previous verification");
assert.match(popup, /localConnectSeq:\s*0/);

class ConnectArbiter {
  constructor() { this.generation = 0; this.inFlight = null; }
  startAuto() { return { explicitAtStart: this.generation }; }
  acceptAuto(ticket) { return !this.inFlight && ticket.explicitAtStart === this.generation; }
  startExplicit(identity) {
    const generation = ++this.generation;
    return (this.inFlight = { generation, identity });
  }
  acceptExplicit(ticket, identity) {
    return ticket.generation === this.generation && ticket.identity === identity;
  }
  invalidateIdentity() { this.generation += 1; this.inFlight = null; }
  finish(ticket) {
    if (this.inFlight?.generation === ticket.generation) this.inFlight = null;
  }
}

// A blur/health refresh starts first; later explicit offline/online result owns the UI.
{
  const a = new ConnectArbiter();
  const blurRefresh = a.startAuto();
  const connect = a.startExplicit("ollama|http://localhost:11434");
  assert.equal(a.acceptAuto(blurRefresh), false);
  assert.equal(a.acceptExplicit(connect, connect.identity), true);
  a.finish(connect);
  assert.equal(a.inFlight, null);
}

// Offline first click, runtime starts, second click: latest explicit request wins.
{
  const a = new ConnectArbiter();
  const offline = a.startExplicit("ollama|http://localhost:11434");
  const online = a.startExplicit("ollama|http://localhost:11434");
  assert.equal(a.acceptExplicit(offline, offline.identity), false);
  assert.equal(a.acceptExplicit(online, online.identity), true);
  a.finish(offline);
  assert.equal(a.inFlight?.generation, online.generation,
    "an older finally must not clear the newer request");
  a.finish(online);
  assert.equal(a.inFlight, null);
}

// Provider/endpoint edits intentionally invalidate the old explicit request.
{
  const a = new ConnectArbiter();
  const request = a.startExplicit("ollama|http://localhost:11434");
  a.invalidateIdentity();
  assert.equal(a.acceptExplicit(request, "ollama|http://localhost:1234"), false);
}

console.log("Local AI Connect race test passed: explicit results survive generic refresh; latest identity wins.");
