// The offscreen document is gone, and the manifest must not ask for the
// permission that ran it.
//
// It was a real feature once: a hidden page where Chrome's built-in Translator
// / Prompt API, or the user's own key, could answer without the API server.
// Prompt composition then moved into `/v1/ai/translate` and `planLocalAi` began
// returning a hard-coded `route = "server"`, so `callOffscreen` became
// unreachable and `chooseAiRoute` lost its last caller. Nothing in any trace log
// ever mentioned it again. Shipping it meant asking the Chrome Web Store for the
// `offscreen` permission for code that could not run.
//
// If the built-in-AI route is ever wanted back, bring it back deliberately:
// delete this test in the same commit that adds a caller.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(absolute)));
    else out.push(absolute);
  }
  return out;
}

// --- the permission is not requested ----------------------------------------
{
  const chromium = JSON.parse(
    await readFile(path.join(projectRoot, "platform/chromium.json"), "utf8"),
  );
  assert.ok(
    !(chromium.permissions || []).includes("offscreen"),
    "chromium.json must not request `offscreen`: nothing in this build creates an offscreen document",
  );
}

// --- no file left behind ------------------------------------------------------
{
  const files = await walk(path.join(projectRoot, "src"));
  const leftovers = files
    .map((f) => path.relative(projectRoot, f).split(path.sep).join("/"))
    .filter((f) => /offscreen/i.test(f));
  assert.deepEqual(leftovers, [], `these offscreen files came back:\n- ${leftovers.join("\n- ")}`);
}

// --- no code path reaches it --------------------------------------------------
{
  const files = (await walk(path.join(projectRoot, "src"))).filter((f) => f.endsWith(".js"));
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/\bcallOffscreen\b|\bprobeOffscreen\b|\bchooseAiRoute\b|chrome\.offscreen/.test(source)) {
      offenders.push(path.relative(projectRoot, file).split(path.sep).join("/"));
    }
  }
  assert.deepEqual(offenders, [], `these files still reference the offscreen route:\n- ${offenders.join("\n- ")}`);
}

// --- and the one route that exists is stated, not assumed ---------------------
{
  const aiLocal = await readFile(path.join(projectRoot, "src/background/ai-local.js"), "utf8");
  assert.match(
    aiLocal,
    /unknown AI route \$\{JSON\.stringify\(route\)\}/,
    "an unknown route must throw by name, not fall off the end of translateUnits",
  );
  const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");
  assert.match(
    jobs,
    /const route = "server";/,
    "planLocalAi still pins the route; if that changes, the throw above needs a second look",
  );
}

console.log("Dead-offscreen test passed: no files, no callers, no permission, unknown routes throw.");
