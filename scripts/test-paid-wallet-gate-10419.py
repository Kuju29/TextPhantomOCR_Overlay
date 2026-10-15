"""Current reservation QA supersedes the retired .19 account-wide wallet queue."""
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location("paid_reservation_execution_QA", Path(__file__).with_name("test-paid-operation-execution-10459.py"))
_qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qa)
test_same_paid_account_can_progress_independently = _qa.test_same_paid_account_can_progress_independently
test_cancel_before_shared_admission_never_dispatches = _qa.test_cancel_before_shared_admission_never_dispatches
if __name__ == "__main__":
    test_same_paid_account_can_progress_independently()
    test_cancel_before_shared_admission_never_dispatches()
    print("PASS: Paid request reservations / independent API admission / cancellation")
