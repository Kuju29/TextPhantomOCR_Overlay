"""Same legitimate server computation: scalar parity, bounds and measured proof latency."""
import base64
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.login import login_provider_deepseek as provider
from backend.ai.login.endpoint.login_provider_deepseek_hash import deepseek_hash_v1
from backend.ai.login.login_provider_contract import LoginError


def challenge(nonce=8191,difficulty=None,salt='fiction-only'):
    expires=int(time.time()*1000)+120000
    prefix=(salt+'_'+str(expires)+'_').encode()
    return {'algorithm':'DeepSeekHashV1','challenge':deepseek_hash_v1(prefix+str(nonce).encode()).hex(),
            'salt':salt,'signature':'fiction-only-signature',
            'difficulty':difficulty if difficulty is not None else nonce+1,'expire_at':expires}


def decode(value): return json.loads(base64.b64decode(value))


class DeepSeekProof(unittest.TestCase):
    def test_actual_proof_8192_candidates_beats_original_scalar_on_same_challenge(self):
        # Run the retained original scalar implementation, then the actual
        # provider path on the identical challenge. Include first NumPy import
        # in the latter; a fixed wall-clock target is not portable to busy CPUs.
        c=challenge();prefix=(c['salt']+'_'+str(c['expire_at'])+'_').encode()
        target=bytes.fromhex(c['challenge']);scalar_nonce=None
        start=time.perf_counter()
        for nonce in range(c['difficulty']):
            if deepseek_hash_v1(prefix+str(nonce).encode())==target:
                scalar_nonce=nonce;break
        scalar_elapsed=time.perf_counter()-start
        cold_import='numpy' not in sys.modules
        start=time.perf_counter();answer=decode(provider.proof(c,lambda:None))
        elapsed=time.perf_counter()-start
        print(json.dumps({'fixtureCandidates':8192,'nativeProofMs':round(elapsed*1000,2),
            'scalarProofMs':round(scalar_elapsed*1000,2),'includesColdImport':cold_import}),flush=True)
        self.assertEqual(scalar_nonce,8191)
        self.assertEqual(answer['answer'],scalar_nonce)
        self.assertLess(elapsed,scalar_elapsed,'Native computation regressed against the original scalar path')

    def test_scalar_hash_parity_at_padding_and_unicode_boundaries(self):
        for size in (1,119,120,132,135,136,137,271,272,513):
            for nonce in (0,9,10,31):
                with self.subTest(size=size,nonce=nonce):
                    c=challenge(nonce,difficulty=32,salt=('A'*size) if size<=512 else 'ญ'*128)
                    result=decode(provider.proof(c,lambda:None))
                    self.assertEqual(result['answer'],nonce)
                    prefix=(c['salt']+'_'+str(c['expire_at'])+'_').encode()
                    self.assertEqual(deepseek_hash_v1(prefix+str(result['answer']).encode()).hex(),c['challenge'])
                    self.assertEqual(result['target_path'],'/api/v0/chat/completion')

    def test_difficulty_boundary_never_searches_or_accepts_outside_allowed_range(self):
        c=challenge(nonce=34,difficulty=34)
        with self.assertRaises(LoginError) as caught: provider.proof(c,lambda:None)
        self.assertEqual(caught.exception.code,'login_pow_unsolved')

    def test_original_cancellation_stops_before_computation(self):
        calls=[]
        def cancel(): calls.append(True);raise LoginError('login_cancelled','Cancelled',409)
        with self.assertRaises(LoginError) as caught: provider.proof(challenge(nonce=0),cancel)
        self.assertEqual(caught.exception.code,'login_cancelled');self.assertEqual(len(calls),1)

    def test_expired_challenge_is_rejected_before_returning_even_nonce_zero(self):
        c=challenge(nonce=0);c['expire_at']=int(time.time()*1000)-1000
        c['challenge']=deepseek_hash_v1((c['salt']+'_'+str(c['expire_at'])+'_0').encode()).hex()
        with self.assertRaises(LoginError) as caught: provider.proof(c,lambda:None)
        self.assertEqual(caught.exception.code,'login_pow_expired')

    def test_invalid_algorithm_or_excessive_difficulty_remains_closed(self):
        for override in ({'algorithm':'unknown'},{'difficulty':True},{'difficulty':200001},
                         {'challenge':'not-a-hash'},{'expire_at':float('inf')}):
            with self.subTest(override=list(override)):
                with self.assertRaises(LoginError) as caught: provider.proof(challenge(nonce=0)|override,lambda:None)
                self.assertEqual(caught.exception.code,'login_pow_unsupported')

    def test_vector_result_is_independently_verified_before_acceptance(self):
        for result in (True, -1, 1000, 1):
            with self.subTest(candidate_type=type(result).__name__):
                with patch.object(provider.DeepSeekNonceSearch,'find',return_value=result):
                    with self.assertRaises(LoginError) as caught:
                        provider.proof(challenge(nonce=0,difficulty=32),lambda:None)
                self.assertEqual(caught.exception.code,'login_pow_unsolved')

    def test_cancellation_after_native_batch_still_prevents_proof_submission(self):
        calls=[]
        def cancel():
            calls.append(True)
            if len(calls)==3: raise LoginError('login_cancelled','Cancelled',409)
        with self.assertRaises(LoginError) as caught: provider.proof(challenge(nonce=0),cancel)
        self.assertEqual(caught.exception.code,'login_cancelled');self.assertEqual(len(calls),3)

    def test_expiry_during_native_batch_prevents_returning_found_nonce(self):
        c=challenge(nonce=0)
        with patch.object(provider.time,'monotonic',side_effect=[0,0,0,0,100]):
            with self.assertRaises(LoginError) as caught: provider.proof(c,lambda:None)
        self.assertEqual(caught.exception.code,'login_pow_expired')

    def test_high_nonce_has_identical_protocol_result(self):
        c=challenge(nonce=131071);start=time.perf_counter()
        result=decode(provider.proof(c,lambda:None));elapsed=time.perf_counter()-start
        self.assertEqual(result['answer'],131071)
        self.assertEqual(result['signature'],c['signature'])
        print(json.dumps({'fixtureCandidates':131072,'proofMs':round(elapsed*1000,2)}),flush=True)


if __name__=='__main__': unittest.main()
