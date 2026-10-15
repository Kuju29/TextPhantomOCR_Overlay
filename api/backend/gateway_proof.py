"""A gateway peer is trusted only with a short, body-bound server signature."""
import hashlib
import hmac
import ipaddress
import json
import time

AUTH_PATHS = {'/api/customer/auth/request', '/api/customer/auth/verify', '/api/customer/auth/status'}
PEER, STAMP, PROOF = 'x-tp-gateway-peer', 'x-tp-gateway-time', 'x-tp-gateway-proof'


def signature(secret, peer, stamp, method, path, body):
    address = str(ipaddress.ip_address(peer))
    payload = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    message = '\n'.join(['tp.gateway/1', address, str(stamp), method.upper(), path,
                         hashlib.sha256(payload).hexdigest()]).encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def headers(secret, peer, method, path, body):
    stamp = str(int(time.time()))
    peer = str(ipaddress.ip_address(peer))
    return {PEER: peer, STAMP: stamp, PROOF: signature(secret, peer, stamp, method, path, body)}


def verify(secret, received, method, path, body):
    stamp, peer, proof = received.get(STAMP, ''), received.get(PEER, ''), received.get(PROOF, '')
    if not stamp.isdigit() or len(stamp) > 12 or abs(time.time()-int(stamp)) > 90:
        raise ValueError('Gateway proof expired')
    if len(peer) > 45 or len(proof) != 64 or not hmac.compare_digest(
            signature(secret, peer, stamp, method, path, body), proof):
        raise ValueError('Gateway proof invalid')
    return str(ipaddress.ip_address(peer))
