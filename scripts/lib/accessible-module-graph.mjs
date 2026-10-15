import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// A content-script dynamic import needs every transitive module to be exposed
// to the same page origins, even when all files exist in the package.
export async function assertAccessibleModuleGraph(root, manifest, entry) {
  const patterns=(manifest.web_accessible_resources||[]).flatMap(rule =>
    typeof rule==='string' ? [rule] : rule.matches?.includes('<all_urls>') ? rule.resources||[] : []);
  const expressions=patterns.map(pattern=>new RegExp('^'+pattern.split('*').map(part=>
    part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$'));
  const seen=new Set();
  async function visit(relative) {
    if(seen.has(relative))return;
    assert(!relative.startsWith('../')&&!path.isAbsolute(relative),`Renderer import escaped package: ${relative}`);
    assert(expressions.some(pattern=>pattern.test(relative)),`Renderer dependency not web-accessible: ${relative}`);
    seen.add(relative);
    const file=path.join(root,relative);
    const source=await readFile(file,'utf8');
    for(const match of source.matchAll(/(?:import\s+(?:[^"']+\s+from\s+)?|export\s+[^"']+\s+from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      await visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1])));
    }
  }
  await visit(entry);
  return [...seen];
}
