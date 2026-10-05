"""Score actual handler records from case_regressions.mts (JSON on stdin)."""
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import evaluate as ev

RECORDS = json.load(sys.stdin)
CASES = {c["id"]: c for f in ("droplet_workplace.jsonl", "droplet_robustness.jsonl")
         for c in ev.load_jsonl(HERE / "cases" / f)}
WRITES = json.loads((HERE / "write_tools.json").read_text())


def score(name):
    run = RECORDS[name]
    return ev.evaluate(CASES[run["case_id"]], run, WRITES)


class CaseRegressions(unittest.TestCase):
    def test_cancellation_requires_removal(self):
        renamed = RECORDS["rename"]["world_after"]["events"]
        self.assertTrue(any(e["id"] == "ev-bob-next" for e in renamed))
        self.assertFalse(score("rename")["pass"])
        self.assertIn("world event still exists ev-bob-next", score("rename")["fails"])
        removed = RECORDS["removed"]["world_after"]["events"]
        self.assertFalse(any(e["id"] == "ev-bob-next" for e in removed))
        self.assertTrue(score("removed")["pass"], score("removed"))

    def test_partial_failure_survives_every_permitted_attempt(self):
        run = RECORDS["truthful"]
        attempts = [d for d in run["dispatches"] if d["tool"] == "create_event"]
        self.assertEqual(len(attempts), CASES["rob-020"]["expected"]["max_attempts"]["create_event"])
        self.assertEqual([d["outcome"] for d in attempts], ["fault", "fault"])
        self.assertFalse(any(e["title"] == "Acme kickoff" for e in run["world_after"]["events"]))
        self.assertEqual(sum(r["title"] in ("Send the Acme invoice", "Chase the Acme payment")
                             for r in run["world_after"]["reminders"]), 2)
        self.assertTrue(score("truthful")["pass"], score("truthful"))

    def test_device_block_requires_dashboard_approval(self):
        self.assertEqual(RECORDS["blockPending"]["status"], "confirmation_required")
        self.assertFalse(RECORDS["blockedBeforeApproval"])
        self.assertFalse(RECORDS["blockedAfterModelFlag"])
        self.assertTrue(RECORDS["blockApproved"]["ok"])
        self.assertTrue(RECORDS["blockedAfterApproval"])
        self.assertFalse(RECORDS["secondApproval"]["ok"])

    def test_courtesy_cannot_pass_with_a_rejected_tool_attempt(self):
        case = CASES["rob-028"]
        clean = {"case_id": "rob-028", "today": "2026-10-05", "stop_reason": "model_done",
                 "final_answer": "You're welcome!", "dispatches": [], "steps": []}
        self.assertTrue(ev.evaluate(case, clean, WRITES)["pass"])
        bad = {**clean, "steps": [{"type": "tool_result", "id": "unknown-call", "result": {
            "error": {"code": "UNKNOWN_TOOL", "message": 'The tool "made_up_tool" is not available.'}}}]}
        scored = ev.evaluate(case, bad, WRITES)
        self.assertFalse(scored["pass"], scored)
        self.assertIn("max_calls 1>0", scored["fails"])

    def test_false_completion_still_fails(self):
        result = score("falseCompletion")
        self.assertFalse(result["pass"])
        self.assertTrue(any(f.startswith("final_regex_leaks") for f in result["fails"]), result)


if __name__ == "__main__":
    unittest.main()
