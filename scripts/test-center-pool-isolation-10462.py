"""Shared sockets never share account headers or cookies."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai import center_http
class PoolIsolation(unittest.TestCase):
 def test_socket_transport_shared_with_private_facades(self):
  seen=[]
  def handle(req):
   seen.append((req.headers.get('authorization'),req.headers.get('cookie')))
   return httpx.Response(200,headers={'Set-Cookie':'private=owner-A; Path=/'},json={'ok':True})
  original=center_http._transport;center_http._transport=httpx.MockTransport(handle)
  try:
   with center_http.center_client(2) as a:
    a.get('https://fiction.test',headers={'Authorization':'Bearer owner-A'})
   with center_http.center_client(2) as b:
    b.get('https://fiction.test',headers={'Authorization':'Bearer owner-B'})
   self.assertEqual(seen,[('Bearer owner-A',None),('Bearer owner-B',None)])
  finally:center_http._transport=original
if __name__=='__main__':unittest.main()
