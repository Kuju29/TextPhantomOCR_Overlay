"""Deterministic reader-gap vs callback/write timing; no wall-clock sleeps."""
import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.transports.stream_timing import StreamTiming

class Clock:
    value=0.0
    def __call__(self): return self.value
    def advance(self,seconds): self.value += seconds

class TimingTests(unittest.TestCase):
    def test_gap_callback_wire_and_tail_are_separate_observations(self):
        clock=Clock(); timing=StreamTiming(clock=clock)
        clock.advance(1)
        with timing.frame():
            timing.content()
            with timing.measure('deltaCallback'): clock.advance(.250)
            with timing.measure('wireWrite'): clock.advance(.125)
        clock.advance(2)
        with timing.frame():
            timing.content()
            with timing.measure('deltaCallback'):clock.advance(.050)
        clock.advance(.5)
        with timing.frame():timing.terminal('protocol_done')
        timing.finish(); row=timing.snapshot()
        for key,value in {'firstContentMs':1000,'lastContentMs':3375,
            'maxInterContentGapMs':2375,'maxInterFrameGapMs':2375,
            'maxReadWaitMs':2000,'deltaCallbackMs':300,'maxDeltaCallbackMs':250,
            'wireWriteMs':125,'frameProcessingMs':425,'maxFrameProcessingMs':375,
            'tailAfterContentMs':550,'protocolTerminalMs':3925,'streamEndedMs':3925,
            'contentChunks':2,'framesObserved':3}.items():
            self.assertEqual(row[key],value,(key,row))
        self.assertEqual(row['terminalKind'],'protocol_done')
        self.assertNotIn('text',row)
    def test_empty_cancelled_and_failure_paths_keep_null_terminal(self):
        c=Clock(); t=StreamTiming(clock=c); t.finish();r=t.snapshot()
        self.assertIsNone(r['firstContentMs']);self.assertIsNone(r['protocolTerminalMs'])
        with self.assertRaises(RuntimeError):
            with t.frame():
                with t.measure('deltaCallback'):
                    c.advance(.2);raise RuntimeError('injected callback failure')
        t.finish();r=t.snapshot()
        self.assertEqual(r['deltaCallbackMs'],200);self.assertEqual(r['frameProcessingMs'],200)
        self.assertIsNone(r['protocolTerminalMs']);self.assertEqual(r['terminalKind'],'none')

if __name__=='__main__':unittest.main(verbosity=2)
