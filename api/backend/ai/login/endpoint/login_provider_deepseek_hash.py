# Vendored from shaohuahuawww/deepseek-pow, dsk/hash_impl.py (MIT).
# See deepseek-pow-MIT.txt in this directory.
"""
DeepSeekHashV1: SHA3-256 with Keccak-f[1600] rounds 1..23 (round 0 skipped).
"""

import struct

RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
M = 0xFFFFFFFFFFFFFFFF
PI  = [0, 6,12,18,24, 3, 9,10,16,22, 1, 7,13,19,20, 4, 5,11,17,23, 2, 8,14,15,21]
RHO = [0,44,43,21,14,28,20, 3,45,61, 1, 6,25, 8,18,27,36,10,15,56,62,55,39,41, 2]


def _rotl(v: int, k: int) -> int:
    return ((v << k) | (v >> (64 - k))) & M


def _keccak_f23(s: list[int]):
    a = list(s)
    for r in range(1, 24):
        c = [(a[i] ^ a[i+5] ^ a[i+10] ^ a[i+15] ^ a[i+20]) & M for i in range(5)]
        d = [(c[(i+4) % 5] ^ _rotl(c[(i+1) % 5], 1)) & M for i in range(5)]
        for i in range(5):
            for j in range(0, 25, 5):
                a[i+j] = (a[i+j] ^ d[i]) & M
        b = [_rotl(a[PI[i]], RHO[i]) for i in range(25)]
        for j in range(5):
            for i in range(5):
                a[j*5+i] = (b[j*5+i] ^ ((~b[j*5+(i+1) % 5] & M) & b[j*5+(i+2) % 5])) & M
        a[0] = (a[0] ^ RC[r]) & M
    for i in range(25):
        s[i] = a[i]


def deepseek_hash_v1(data: bytes) -> bytes:
    rate = 136
    s = [0] * 25
    off = 0
    while off + rate <= len(data):
        for i in range(rate // 8):
            s[i] ^= struct.unpack_from('<Q', data, off + i * 8)[0]
        _keccak_f23(s)
        off += rate
    buf = bytearray(rate)
    rem = len(data) - off
    buf[:rem] = data[off:]
    buf[rem] = 0x06
    buf[rate - 1] |= 0x80
    for i in range(rate // 8):
        s[i] ^= struct.unpack_from('<Q', buf, i * 8)[0]
    _keccak_f23(s)
    out = bytearray(32)
    for i in range(4):
        struct.pack_into('<Q', out, i * 8, s[i])
    return bytes(out)


class DeepSeekNonceSearch:
    """The same hash in bounded NumPy uint64 batches, with no new runtime.

    NumPy already supplies the image runtime's native arithmetic. This computes
    only the ordinary challenge issued by the provider; accepted candidates
    remain verified by the independent scalar reference in the caller.
    """
    BATCH_SIZE = 512

    def __init__(self, prefix: bytes, target: bytes):
        import numpy as np
        self.np = np
        state = [0] * 25
        cursor = 0
        while cursor + 136 <= len(prefix):
            for i in range(17):
                state[i] ^= struct.unpack_from('<Q', prefix, cursor + i * 8)[0]
            _keccak_f23(state)
            cursor += 136
        self.base = np.asarray(state, dtype=np.uint64)
        self.tail = prefix[cursor:]
        self.target = np.frombuffer(target, dtype='<u8')
        self.shifts = np.asarray(RHO, dtype=np.uint64)[:, None]

    def _permute(self, state):
        np = self.np
        for constant in RC[1:]:
            c = state[:5] ^ state[5:10] ^ state[10:15] ^ state[15:20] ^ state[20:25]
            following = np.roll(c, -1, axis=0)
            d = np.roll(c, 1, axis=0) ^ ((following << 1) | (following >> 63))
            state ^= np.tile(d, (5, 1))
            rotated = state[PI]
            b = (rotated << self.shifts) | (rotated >> (np.uint64(64) - self.shifts))
            grid = b.reshape(5, 5, -1)
            state[:] = (grid ^ ((~np.roll(grid, -1, axis=1)) & np.roll(grid, -2, axis=1))).reshape(25, -1)
            state[0] ^= np.uint64(constant)

    def find(self, start: int, stop: int):
        if type(start) is not int or type(stop) is not int or not 0 <= start < stop <= 200000 or stop - start > self.BATCH_SIZE:
            raise ValueError('Invalid bounded computation range')
        np = self.np
        groups = {}
        for nonce in range(start, stop):
            payload = self.tail + str(nonce).encode()
            padded = bytearray((len(payload) // 136 + 1) * 136)
            padded[:len(payload)] = payload
            padded[len(payload)] = 0x06
            padded[-1] |= 0x80
            groups.setdefault(len(padded), []).append((nonce, padded))
        found = []
        for size, rows in groups.items():
            lanes = np.frombuffer(b''.join(data for _, data in rows), dtype='<u8').reshape(len(rows), -1)
            state = np.repeat(self.base[:, None], len(rows), axis=1)
            for block in range(size // 136):
                state[:17] ^= lanes[:, block * 17:(block + 1) * 17].T
                self._permute(state)
            matches = np.flatnonzero(np.all(state[:4] == self.target[:, None], axis=0))
            found.extend(rows[int(index)][0] for index in matches)
        return min(found) if found else None
