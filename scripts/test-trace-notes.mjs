// Every traceNote() call must pass a trace id that is in scope AT THAT CALL.
// A name that is only declared elsewhere in the file throws a ReferenceError
// which the surrounding try/catch swallows: the note silently never appears and
// the catch logs a misleading reason instead. That is how `engineRoute` was
// lost twice - the first version of this test only searched the whole file for
// the name, so a `let traceId` in another function made the check pass.
//
// No parser dependency: this repo has zero runtime and zero build dependencies
// and `npm run build` must work on a clean checkout with no `npm install`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");

async function walk(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(absolute);
  }
  return out;
}

// Replaces the CONTENT of strings, template literals and comments with spaces,
// keeping every index. Brace counting and declaration searches then cannot be
// fooled by a `}` or the word `const` inside a string.
function maskLiterals(source) {
  const out = source.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === "\\") { k += 2; continue; }
        if (source[k] === ch) break;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

// This codebase writes every top-level declaration at column 0, so a function's
// span runs from its own column-0 line to the next one. Deliberately generous:
// a nested closure's locals count as visible in the whole span, so the test only
// ever reports a name visible in NO enclosing scope - always a ReferenceError.
const TOP_LEVEL_START =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|(?:const|let|var)\s+\w+|class\s+\w+)/gm;

function topLevelSpans(masked) {
  const starts = [];
  let match;
  TOP_LEVEL_START.lastIndex = 0;
  while ((match = TOP_LEVEL_START.exec(masked))) starts.push(match.index);
  return starts.map((start, n) => ({ start, end: n + 1 < starts.length ? starts[n + 1] : masked.length }));
}

// The declaration forms this codebase actually uses, searched inside one span.
const declaredIn = (text, name) =>
  new RegExp(
    `(?:\\b(?:const|let|var|function|class)\\s+${name}\\b)` +
    `|(?:\\bimport\\b[^;]*\\b${name}\\b[^;]*from)` +
    `|(?:\\bcatch\\s*\\(\\s*${name}\\b)` +
    `|(?:\\(([^()]*\\b${name}\\b[^()]*)\\)\\s*(?:=>|\\{))` +
    `|(?:\\b${name}\\s*=>)` +
    `|(?:\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=[^=])`,
  ).test(text);

// Module-level names are visible everywhere in the file.
function moduleScopeNames(masked) {
  const names = new Set();
  for (const m of masked.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+))/gm,
  )) {
    names.add(m[1] || m[2] || m[3]);
  }
  for (const m of masked.matchAll(/^import\s+([\s\S]*?)\s+from\s/gm)) {
    for (const raw of m[1].replace(/[{}]/g, " ").split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// Splits a call's arguments at top level, ignoring commas inside nested brackets.
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  args.push(text.slice(start));
  return args.map((a) => a.trim());
}

// Every traceNote(...) call, read off the masked source so literals cannot lie.
function traceNoteCalls(masked) {
  const calls = [];
  const re = /(?:TP\.)?traceNote\??\.?\(/g;
  let match;
  while ((match = re.exec(masked))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < masked.length && depth > 0; i++) {
      const ch = masked[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    calls.push({ index: match.index, args: splitArgs(masked.slice(start, i - 1)) });
  }
  return calls;
}

const problems = [];
for (const file of await walk(sourceRoot)) {
  const source = await readFile(file, "utf8");
  const masked = maskLiterals(source);
  const rel = path.relative(projectRoot, file);
  const moduleNames = moduleScopeNames(masked);
  const spans = topLevelSpans(masked);

  for (const call of traceNoteCalls(masked)) {
    // traceNote(file, fn, data, traceId) - the id is the 4th argument.
    if (call.args.length < 4) continue;
    const id = call.args[3];
    if (!/^[A-Za-z_$][\w$]*$/.test(id)) continue; // a literal or an expression
    if (moduleNames.has(id)) continue;

    const span = spans.find((s) => call.index >= s.start && call.index < s.end);
    const scopeText = span ? masked.slice(span.start, span.end) : masked;
    if (!declaredIn(scopeText, id)) {
      const line = source.slice(0, call.index).split("\n").length;
      problems.push(`${rel}:${line} traceNote passes "${id}", which is not in scope at that call`);
    }
  }
}

assert.deepEqual(
  problems,
  [],
  `traceNote calls with an out-of-scope trace id:\n- ${problems.join("\n- ")}`,
);

// The route labels must say what happened. "old" claimed the previous overlay
// was kept while the code replaced it with the server's markup.
{
  // `shared/route-record.js` used to be checked here too, for an "old" outcome
  // that no longer described anything. The whole module had no importers and
  // was deleted on 2026-08-15, so the only place the label can come back is
  // overlay.js itself.
  const overlay = await readFile(path.join(sourceRoot, "content/overlay.js"), "utf8");
  assert.ok(
    !/reportRoute\("old"/.test(overlay),
    'overlay.js must not report "old" for a route that draws the server markup',
  );
  assert.ok(
    /reportRoute\(\s*"server"/.test(overlay),
    "the server-markup route must be named for what it draws",
  );
}

// TP_TRACE must explain the AI page without exporting its dialogue.
{
  const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");
  const pageTranslation = await readFile(
    path.join(projectRoot, "src/background/pipeline/page-translation.js"), "utf8",
  );
  const repair = await readFile(path.join(projectRoot, "src/shared/ai-content-repair.js"), "utf8");
  const aiLocal = await readFile(path.join(projectRoot, "src/background/ai/transports/direct-local.js"), "utf8");
  const adapter = await readFile(path.join(projectRoot, "src/shared/ai/direct-local/generation.js"), "utf8");
  const background = await readFile(path.join(projectRoot, "src/background/index.js"), "utf8");
  const popupMeta = await readFile(path.join(projectRoot, "src/popup/controllers/provider-meta-controller.js"), "utf8");
  const popupLocal = await readFile(path.join(projectRoot, "src/popup/controllers/local-connection-controller.js"), "utf8");
  for (const required of ["aiPageContract", "aiUnitFingerprints", "aiUnitStageFingerprints",
    "provider_parsed", "document_applied", "contentFingerprint", "sourceFingerprint", "aiContentAttempt",
    "wrongLanguageIds", "repairAccepted", "generationStarted", "jobCancellation"]) {
    assert.ok(`${jobs}\n${pageTranslation}\n${repair}`.includes(required),
      `missing AI trace field/event ${required}`);
  }
  for (const required of ["missingIds", "emptyIds", "duplicateIds", "extraIds"]) {
    assert.ok(adapter.includes(required), `missing unit-contract diagnostic ${required}`);
  }
  assert.ok(aiLocal.includes('"direct Local AI failed"'));
  for (const event of ['event: "start"', 'event: "result"', 'event: "error"', 'event: "stale_discard"']) {
    assert.ok(background.includes(event), `missing Local AI discovery ${event}`);
  }
  assert.ok(popupMeta.includes("TP_LOCAL_AI_DISCOVERY_STALE"));
  assert.match(popupLocal, /TP_LOCAL_AI_DISCOVER[\s\S]{0,180}apiBase:\s*normalizeUrl\(els\.apiUrl\.value\)/,
    "explicit Connect must send the API base used for the trace handshake");
  const handshake = await readFile(path.join(projectRoot, "src/background/trace-handshake.js"), "utf8");
  assert.match(handshake, /epoch !== handshakeEpoch \|\| base !== activeBase/,
    "late capability results from an old API base must be ignored");
  assert.match(
    pageTranslation,
    /crypto\.getRandomValues\(\s*new Uint8Array\(32\),?\s*\)/,
  );
  assert.match(
    pageTranslation,
    /crypto\.subtle\.digest\(\s*"SHA-256",\s*keyed,?\s*\)/,
  );
  assert.ok(pageTranslation.includes("Never fall back to an unsalted hash"));
  assert.doesNotMatch(pageTranslation, /aiUnitFingerprints[\s\S]{0,500}\btext\s*:/);
  assert.doesNotMatch(pageTranslation, /aiUnitStageFingerprints[\s\S]{0,500}\btext\s*:/);
}

console.log("Trace note test passed: every trace id is in scope, route labels describe the route.");
