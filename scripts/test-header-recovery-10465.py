"""Exact delimiter recovery; ambiguous records stay rejected."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.markers.decode import decode_translation_response as decode

def test_exact_expected_standalone_header_preserves_value():
    result=decode('<<I3_P6>: ภาษาไทย  >>\n<<I3_P7:ปกติ>>',['I3_P6','I3_P7'])
    assert not result.missing_ids
    assert result.record_header_recovery_count==1
    assert result.malformed_line_count==0
    assert ' ภาษาไทย  ' in result.ai_text_full

def test_duplicate_recovered_header_is_not_accepted():
    result=decode('<<I3_P6>:first>>\n<<I3_P6:second>>',['I3_P6'])
    assert result.missing_ids==('I3_P6',)
    assert result.duplicate_ids==('I3_P6',)

def test_ambiguous_or_nested_headers_are_not_recovered():
    for value in ['prefix <<I3_P6>:value>>', '<<I3_P6>:value>> suffix',
                  '<<I3_P6>>:value>>','<<I3_P6>:a<<I3_P7:b>>>>', '<<I3_P6>:a\nb>>']:
        result=decode(value,['I3_P6','I3_P7'])
        assert result.record_header_recovery_count==0, value
        assert 'I3_P6' in result.missing_ids, value

def test_unknown_headers_do_not_gain_owned_translation():
    result=decode('<<I3_P99>:value>>\n<<I3_P6:owned>>',['I3_P6'])
    assert result.record_header_recovery_count==0
    assert result.discarded_ids==('I3_P99',)
