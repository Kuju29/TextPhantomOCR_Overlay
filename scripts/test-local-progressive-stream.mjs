import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { readProviderResponse } from '../src/shared/ai/providers/local-transport-runtime.js';
import { createOllamaAdapter } from '../src/shared/ai/providers/local-ollama.js';
import { createOpenAiCompatibleAdapter } from '../src/shared/ai/providers/local-openai-compatible.js';

for (const protocol of ['ollama', 'sse']) {
  test(`${protocol}: real HTTP content arrives before terminal, UTF8 intact, final usage retained`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const text = '<<I1_P0:สวัสดี>>\n';
    const frame = protocol === 'ollama'
      ? JSON.stringify({message:{content:text}})+'\n'
      : 'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';
    const server = createServer(async (_, res) => {
      res.writeHead(200, {'content-type': protocol === 'ollama' ? 'application/x-ndjson' : 'text/event-stream'});
      const bytes = Buffer.from(frame); const cut = bytes.indexOf(Buffer.from('ส'))+1;
      res.write(bytes.subarray(0,cut));
      setImmediate(() => res.write(bytes.subarray(cut)));
      await gate;
      res.end(protocol === 'ollama'
        ? JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:9,eval_count:4})+'\n'
        : 'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:9,completion_tokens:4,total_tokens:13}})+'\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    try {
      const adapter = protocol === 'ollama' ? createOllamaAdapter({baseUrl:'http://localhost:11434'}) : createOpenAiCompatibleAdapter({baseUrl:'http://localhost:1234'});
      let deltaResolve; const delta = new Promise(resolve => { deltaResolve=resolve; });
      let completed=false;
      const response = await fetch(`http://127.0.0.1:${server.address().port}`);
      const result = readProviderResponse(response,adapter,{expectedIds:['I1_P0'],emitTranslationDeltas:true,
        onProgress:event => { if(event.state==='translation_delta') deltaResolve(event.text); }}).then(value=>{completed=true;return value;});
      assert.equal(await delta,text);
      assert.equal(completed,false,'page content must be available before request completion');
      // Exceed legacy Ollama marker-completion grace: progressive delivery must not truncate usage.
      if(protocol==='ollama') await new Promise(resolve=>setTimeout(resolve,2100));
      assert.equal(completed,false);
      release();
      const final=await result;
      assert.equal(final.terminalCompleted,true);
      assert.equal(final.streamTiming.contentChunks,1);
      assert.ok(final.streamTiming.framesObserved>0);
      assert.ok(final.streamTiming.protocolTerminalMs>=final.streamTiming.lastContentMs);
      if(protocol==='ollama'){
        assert.ok(final.streamTiming.tailAfterContentMs>=1900,'terminal gap observed, not hidden');
        assert.ok(final.streamTiming.maxReadWaitMs>=1900,'reader wait distinguished from callback');
      }

      assert.equal(adapter.usage(final.data).totalTokens,13);
    } finally { release(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  });
}

test('Independent defaults do not emit translation data events',async()=>{
  const adapter=createOllamaAdapter({baseUrl:'http://localhost:11434'});
  const events=[];
  const response=new Response('{"message":{"content":"{\\"P0\\":\\"ไทย\\"}"},"done":true}\n', {headers:{'content-type':'application/x-ndjson'}});
  await readProviderResponse(response,adapter,{onProgress:event=>events.push(event)});
  assert.equal(events.some(event=>event.state==='translation_delta'),false);
});
