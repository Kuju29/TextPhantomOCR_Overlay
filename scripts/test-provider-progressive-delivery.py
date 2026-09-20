"""Real loopback HTTP streams: content precedes delayed terminal usage."""
import json
import os
from unittest.mock import patch
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai import content_stream
from backend.ai.providers import local_ollama
from backend.ai.transports.openai_compat.core import execute_openai_compatible_request

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['content-length']))
        self.send_response(200)
        self.send_header('Content-Type','application/x-ndjson' if self.path=='/api/chat' else 'text/event-stream')
        self.send_header('Connection','close')
        self.end_headers()
        if self.path=='/api/chat':
            self.wfile.write((json.dumps({'message':{'content':'<<TP_P0:แปลแล้ว>>'},'done':False})+'\n').encode())
        else:
            self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':'<<TP_P0:แปลแล้ว>>'}}]})+'\n\n').encode())
        self.wfile.flush()
        self.server.received.wait(1)
        # Longer than the native Ollama 2-second semantic completion drain.
        time.sleep(2.15)
        if self.path=='/api/chat':
            self.wfile.write((json.dumps({'message':{'content':''},'done':True,'done_reason':'stop','prompt_eval_count':31,'eval_count':9})+'\n').encode())
        else:
            self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':31,'completion_tokens':9,'total_tokens':40}})+'\n\ndata: [DONE]\n\n').encode())
        self.wfile.flush()

class ProviderTests(unittest.TestCase):
    def test_provider_families_keep_final_usage_after_early_content(self):
        for provider in ('openai','ollama'):
            with self.subTest(provider=provider):
                server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
                server.received=threading.Event()
                thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
                base=f'http://127.0.0.1:{server.server_port}'
                seen=[]
                def on_text(text):
                    seen.append((text,time.monotonic()))
                    server.received.set()
                try:
                    with patch.dict(os.environ,{key:"" for key in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy")}), content_stream.scope(on_text):
                        if provider=='ollama':
                            result=local_ollama.generate(base,'test','translate',['source'],expected_ids=['P0'],thinking='off')
                        else:
                            result=execute_openai_compatible_request(url=base+'/chat',headers={},payload={'messages':[]},model='test',provider_id='openai',timeout=10,timeout_policy='test',expected_ids=['P0'])
                    self.assertEqual(len(seen),1)
                    self.assertGreater(time.monotonic()-seen[0][1],2)
                    self.assertEqual(result.input_tokens,31)
                    self.assertEqual(result.output_tokens,9)
                    self.assertIn('แปลแล้ว',result.text)
                finally:
                    server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
