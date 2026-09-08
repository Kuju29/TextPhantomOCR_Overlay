// Parse the small npm &&/|| command graph used by this project; never execute it.
export function reachableScripts(scripts, roots=['test']) {
  const aliases=new Set(), files=new Set();
  function visit(alias) {
    if(aliases.has(alias)) return;
    if(!Object.hasOwn(scripts,alias)) throw new Error(`Missing npm script: ${alias}`);
    aliases.add(alias);
    for(const hook of [`pre${alias}`,`post${alias}`]) if(Object.hasOwn(scripts,hook))visit(hook);
    const command=String(scripts[alias]);
    for(const [,file] of command.matchAll(/\b(?:node|python3?|\$PYTHON)\s+["']?(scripts\/[\w./-]+\.(?:mjs|py))\b/g)) files.add(file);
    for(const [,dep] of command.matchAll(/\bnpm\s+run\s+(?:--[\w-]+\s+)*([\w:.-]+)/g)) visit(dep);
  }
  roots.forEach(visit);return {aliases,files};
}
