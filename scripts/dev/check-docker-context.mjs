// DEV TOOL — run this in the tree you actually push to GitHub, from the repo
// root: `node scripts/dev/check-docker-context.mjs`
//
// Every `COPY` in api/Dockerfile is resolved against the build context (api/).
// A missing source is a hard Docker build failure, so this optional dev tool
// checks only the COPY sources that the current Dockerfile actually uses.
//
// Not part of `npm run build`: it has no release/version responsibilities.
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contextRoot = path.join(projectRoot, "api");
const dockerfile = await readFile(path.join(contextRoot, "Dockerfile"), "utf8");

// COPY [--flags] src... dest   (line continuations already rare here)
const sources = [];
for (const line of dockerfile.split(/\r?\n/)) {
  const match = /^\s*COPY\s+(.*)$/i.exec(line);
  if (!match) continue;
  const parts = match[1].split(/\s+/).filter((p) => p && !p.startsWith("--"));
  if (parts.length < 2) continue;
  sources.push(...parts.slice(0, -1));   // everything but the destination
}

const missing = [];
for (const src of sources) {
  if (src.includes("*")) continue;       // globs: check by hand
  try {
    await access(path.join(contextRoot, src));
  } catch {
    missing.push(src);
  }
}

console.log(`api/Dockerfile copies ${sources.length} source(s) from api/`);
for (const src of sources) {
  console.log(`  ${missing.includes(src) ? "MISSING" : "ok     "}  ${src}`);
}

if (missing.length) {
  console.error(
    `\n${missing.length} file(s) the image build needs are not in api/:\n` +
    missing.map((m) => `  - ${m}`).join("\n") +
    "\n\nThe build will stop at that COPY. Fonts are baked in on purpose: " +
    "downloading them at runtime fails on a hosted Space (the app directory is " +
    "not writable by uid 1000) and Thai then renders as tofu.",
  );
  process.exitCode = 1;
} else {
  console.log("\nEvery COPY source is present — this context can build.");
}
