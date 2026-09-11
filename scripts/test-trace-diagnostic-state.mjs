import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/background/index.js", import.meta.url), "utf8");
const branch = source.split('case "TP_GET_TRACE_DIAGNOSTIC_STATE":')[1]
  ?.split('case "TP_FLUSH_LOGS":')[0] || "";

assert.match(branch, /if \(sender\?\.tab\)/,
  "page/content-script callers must be rejected");
assert.match(branch, /trusted_ui_only/);
assert.match(branch, /getTraceShippingState\(\)/);
assert.match(branch, /getTraceHandshakeState\(\)/);
assert.doesNotMatch(branch, /apiBase|baseUrl|activeBase|url\s*:/i,
  "diagnostic reply must not expose an API URL");

const traceSource = readFileSync(new URL("../src/shared/trace.js", import.meta.url), "utf8");
assert.match(traceSource, /clientBuild/);
assert.match(traceSource, /traceSession:\s*activeSession/);
assert.match(traceSource, /state:\s*enabled === null \? "unnegotiated"/);
assert.match(traceSource, /\? "backoff" : "active"/);
assert.match(traceSource, /queued:\s*buffer\.length/);
assert.match(traceSource, /dropped/);
assert.match(traceSource, /reason:\s*shippingHealth\.lastCode/);

const handshakeSource = readFileSync(new URL("../src/background/trace-handshake.js", import.meta.url), "utf8");
assert.match(handshakeSource, /outcome:\s*"unnegotiated"/);
assert.match(handshakeSource, /reason:\s*"no_api_base"/);
assert.match(handshakeSource, /reason:\s*"capabilities_unavailable"/);
assert.match(handshakeSource, /reason:\s*"stale_capabilities"/);
assert.match(handshakeSource, /endpointClass/);
assert.doesNotMatch(handshakeSource, /lastHandshake\s*=\s*\{[^}]*\b(?:url|baseUrl|rawBase|activeBase)\b/s,
  "handshake snapshot must retain classifications, never endpoints");

console.log("trace diagnostic state tests passed");
