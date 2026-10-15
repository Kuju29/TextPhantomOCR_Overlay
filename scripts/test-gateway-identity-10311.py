"""Real local HTTP peer trust and configured gateway file; no external providers."""
from dataclasses import replace
import sys,time,threading,tempfile,socket,asyncio,os
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx,uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from backend import paid_center
from backend.config import settings,Settings
from backend import diagnostic_core,logfile
async def peer(request):return JSONResponse({'peer':request.client.host})
checks=[]
def check(name,value):
    assert value,name
    checks.append(name);print('PASS '+name,flush=True)
for trusted,expected in [([], '127.0.0.1'),(['127.0.0.1'],'198.51.100.22'),(['127.0.0.0/8'],'198.51.100.22')]:
    app=Starlette(routes=[Route('/',peer)])
    app.add_middleware(ProxyHeadersMiddleware,trusted_hosts=trusted)
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen();port=sock.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(app,proxy_headers=False,log_level='error',access_log=False))
    thread=threading.Thread(target=lambda:server.run(sockets=[sock]),daemon=True);thread.start()
    for _ in range(100):
        if server.started:break
        time.sleep(.02)
    try:
        r=httpx.get(f'http://127.0.0.1:{port}/',headers={'X-Forwarded-For':'198.51.100.22'},trust_env=False)
        check('actual HTTP explicit proxy trust '+str(trusted),r.json()['peer']==expected)
    finally:
        server.should_exit=True;thread.join(5);sock.close()
for invalid in ['*','0.0.0.0/0','::/0','arbitrary-host']:
    paid_center.settings=replace(settings,trusted_proxy_ips=invalid)
    try:paid_center.trusted_proxy_hosts()
    except RuntimeError:check('reject unsafe proxy setting '+invalid,True)
    else:raise AssertionError(invalid)
paid_center.settings=settings
with tempfile.TemporaryDirectory() as tmp:
    path=Path(tmp)/'gateway.key';paid_center.settings=replace(settings,center_gateway_key_file=str(path))
    for value in [None,'bad']:
        if value is not None:path.write_text(value)
        try:paid_center.gateway_key()
        except RuntimeError:check('configured gateway file fails clearly '+str(value),True)
        else:raise AssertionError('Missing/invalid key silently accepted')
    path.write_text('a'*64)
    check('private file key read',paid_center.gateway_key()=='a'*64)
    paid_center.settings=replace(settings,center_gateway_key_file=str(path),center_gateway_key='a'*64)
    check('matching file and runtime Secret accepted',paid_center.gateway_key()=='a'*64)
    paid_center.settings=replace(settings,center_gateway_key_file=str(path),center_gateway_key='b'*64)
    try:paid_center.gateway_key()
    except RuntimeError as exc:check('conflicting key sources fail without leaking either key','a'*64 not in str(exc) and 'b'*64 not in str(exc))
    else:raise AssertionError('Conflicting keys silently accepted')
    path.unlink()
    paid_center.settings=replace(settings,center_gateway_key_file=str(path),center_gateway_key='b'*64)
    try:paid_center.gateway_key()
    except RuntimeError:check('configured missing file never falls back to runtime Secret',True)
    else:raise AssertionError('Missing file silently fell back')
    path.write_bytes(b'\xff')
    try:paid_center.gateway_key()
    except RuntimeError as exc:check('invalid UTF-8 key file fails with static configuration error','codec' not in str(exc))
    else:raise AssertionError('Invalid key file accepted')
with patch.dict(os.environ,{'TP_CENTER_GATEWAY_KEY':'  '+'c'*64+'\n','TP_CENTER_GATEWAY_KEY_FILE':''}):
    configured=Settings()
    paid_center.settings=configured
    check('HF runtime Secret loads from environment',paid_center.gateway_key()=='c'*64)
    check('Settings repr excludes runtime Secret','c'*64 not in repr(configured))
    for name in ['TP_CENTER_GATEWAY_KEY','center_gateway_key','gatewayKey','gateway-key']:
        check('structured diagnostics redact '+name,'c'*64 not in str(diagnostic_core.safe({name:'c'*64})))
        check('legacy log treats gateway Secret as private '+name,logfile._secret_key(name))
for value in ['bad','a'*63,'a'*65,'A'*64,'g'*64]:
    paid_center.settings=replace(settings,center_gateway_key_file='',center_gateway_key=value)
    try:paid_center.gateway_key()
    except RuntimeError as exc:check('invalid runtime Secret fails with static error '+str(len(value)),value not in str(exc))
    else:raise AssertionError('Invalid runtime Secret accepted')
paid_center.settings=settings
check('unset gateway retains explicit compatibility',paid_center.gateway_key()=='')
print(str(len(checks))+' checks passed; real localhost HTTP, no provider calls')
