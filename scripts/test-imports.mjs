// Every relative import and export-from in src/ must resolve to a real file.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");

const SPECIFIER_RE =
  /(?:^|[\s;{(])(?:import\s+(?:[^"'();]*?\s+from\s+)?|export\s+[^"';]*?\s+from\s+|import\s*\()\s*["'](\.[^"']+)["']/g;

async function walk(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(absolute);
  }
  return out;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const problems = [];
const files = await walk(sourceRoot);
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    const resolved = path.resolve(path.dirname(file), specifier);
    if (!(await isFile(resolved))) {
      problems.push(`${path.relative(projectRoot, file)} imports missing ${specifier}`);
    }
  }
}

assert.deepEqual(problems, [], `unresolved imports:\n- ${problems.join("\n- ")}`);
console.log(`Import test passed: ${files.length} files, every relative specifier resolves.`);
