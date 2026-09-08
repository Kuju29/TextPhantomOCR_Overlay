import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {reachableScripts} from './script-reachability.mjs';
const root=new URL('../',import.meta.url),pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
const gate=JSON.parse(await readFile(new URL('scripts/release-gates.json',root),'utf8'));
const graph=reachableScripts(pkg.scripts);
// Nested source-owned Python entrypoints must be referenced by a reachable test.
for(const [file,owner] of Object.entries(gate.nested)) {
 assert.ok(graph.files.has(owner),`${owner} must be reachable before it owns ${file}`);
 assert.ok((await readFile(new URL(owner,root),'utf8')).includes(file.split('/').at(-1)),`missing nested invocation ${file}`);
 graph.files.add(file);
}
const deferred=new Set(Object.values(gate.separate).flatMap(g=>g.files));
for(const name of await readdir(new URL('scripts/',root))) if(/^test-.*\.(mjs|py)$/.test(name)) {
 const f=`scripts/${name}`;assert.ok(graph.files.has(f)||deferred.has(f),`Unreachable test ${f}: connect to npm test or declare a separate gate`);
}
for(const f of gate.critical)assert.ok(graph.files.has(f),`Critical test is not reachable: ${f}`);
for(const [name,g] of Object.entries(gate.separate)){assert.ok(g.reason&&g.command,`gate ${name} needs reason/command`);for(const f of g.files)assert.ok((await readFile(new URL(f,root),'utf8')).length>0);}
const removed={...pkg.scripts,test:pkg.scripts.test.replace('npm run test:progress && ','')};
assert.equal(reachableScripts(removed).files.has('scripts/test-background-job-ownership.mjs'),false);
assert.throws(()=>reachableScripts({test:'npm run absent'}),/Missing npm script/);
const cycle=reachableScripts({pretest:'node scripts/pre.mjs',test:'npm run a',a:'npm run a && python scripts/case.py',posttest:'node scripts/post.mjs'});
assert.deepEqual([...cycle.files].sort(),['scripts/case.py','scripts/post.mjs','scripts/pre.mjs']);
console.log(`Test reachability: ${graph.files.size} reachable files, ${deferred.size} explicit separate-gate files; removal/negative controls passed.`);
