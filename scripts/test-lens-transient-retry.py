"""Exercise the actual Lens client recovery with a fake upstream and no network."""
from pathlib import Path
from tempfile import NamedTemporaryFile
from types import ModuleType,SimpleNamespace
from unittest.mock import patch
import importlib,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
httpx=ModuleType('httpx');httpx.Client=type('Client',(),{})
httpx.Limits=lambda **kwargs:kwargs
sys.modules['httpx']=httpx
cookie=ModuleType('backend.lens.cookie')
cookie.state=lambda _:SimpleNamespace(data={'fixture':'cookie'},generation=1)
sys.modules['backend.lens.cookie']=cookie
trace=ModuleType('backend.trace');trace.note=lambda *a,**kw:None
sys.modules['backend.trace']=trace
client=importlib.import_module('backend.lens.client')
with NamedTemporaryFile() as image:
    image.write(b'fixture-image');image.flush()
    for status,expected in [(502,2),(503,2),(504,2),(401,1)]:
        calls=[]
        def fetch(*args):
            calls.append(args)
            if len(calls)==1:raise RuntimeError(f'Lens HTTP {status} (operation=upload)')
            return {'originalTextFull':'recognized text'}
        client._lens_cache.clear();client._flights.clear()
        with patch.object(client,'_fetch_lens_once',fetch),patch.object(client.time,'sleep'):
            if status==401:
                try:client.fetch_lens_data(image.name,'th')
                except RuntimeError as error:assert '401' in str(error)
                else:raise AssertionError('Auth failures must not retry')
            else:assert client.fetch_lens_data(image.name,'th')['originalTextFull']=='recognized text'
        assert len(calls)==expected,(status,len(calls))
    client._lens_cache.clear();client._flights.clear()
    calls=[]
    def fails(*args):
        calls.append(args);raise RuntimeError('Lens HTTP 502 (operation=result)')
    with patch.object(client,'_fetch_lens_once',fails),patch.object(client.time,'sleep'):
        try:client.fetch_lens_data(image.name,'th')
        except RuntimeError:pass
        else:raise AssertionError('Repeated gateway failure must be terminal')
    assert len(calls)==2,'No unbounded retries or AI replay'
print('PASS Lens 502/503/504 retry once, auth never retries, persistent error stops')

# The publisher bridge can produce PNG, while ordinary pages may be WebP.
# The upload declaration must describe a PNG instead of always claiming JPEG.
class FakeResponse:
    status_code=302
    headers={'location':'https://lens.google.com/search?vsrid=one&gsessionid=two'}

class FakeSession:
    def __init__(self):self.files=None
    def post(self, url, files):self.files=files;return FakeResponse()
    def get(self, url):return SimpleNamespace(is_success=True,text='{}')

fake=FakeSession()
with patch.object(client,'_session',return_value=fake):
    client._fetch_lens_once(b'\x89PNG\r\n\x1a\nfixture','th',{})
    assert fake.files['encoded_image'][::2] == ('file.png','image/png')
    client._fetch_lens_once(b'RIFF0000WEBPfixture','th',{})
    assert fake.files['encoded_image'][::2] == ('file.jpg','image/jpeg')
print('PASS publisher PNG upload declares image/png; ordinary image route is unchanged')
