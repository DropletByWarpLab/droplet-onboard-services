"""WARP-3899: the world handlers added or reshaped for harness fidelity, read off the records and evals that
selftest.sh's good/bad run just wrote (runs/selftest-{good,bad}.jsonl and .eval.json; cwd is tests/agent-loop-eval).

Each case's good agent shows the handler's production-shaped answer, each bad agent the refusal a wrong call earns:
strict mailbox ids (email_accounts), the route-owned 202s (unblock_network_device, share_clip), background runs,
routines and memory. A handler that threw, or a tool the world stopped scripting, would only be an error or an
`unscripted` result the scripted agent ignores, so the results themselves are checked.
"""
import json

recs = {k: {r["case_id"]: r for r in map(json.loads, open(f"runs/selftest-{k}.jsonl"))} for k in ("good", "bad")}
evs = {k: {r["case_id"]: r for r in json.load(open(f"runs/selftest-{k}.eval.json"))["results"]} for k in ("good", "bad")}
CASES = ("v2-email-accounts", "v2-route-writes", "v2-runs", "v2-routines", "v2-memory", "v2-memory-save")


def said(kind, cid):
    return " | ".join(evs[kind][cid]["fails"])


def results(kind, cid, tool):
    """The result of every call to `tool`: a dict for a success or a refusal, None for a call held for approval."""
    rec = recs[kind][cid]
    ids = [s["id"] for s in rec["steps"] if s.get("type") == "tool_call" and s["tool"] == tool]
    return [s.get("result") for s in rec["steps"] if s.get("type") == "tool_result" and s["id"] in ids]


def answers(kind, cid, tool):
    return [r for r in results(kind, cid, tool) if isinstance(r, dict)]


# Every tool these cases call is scripted: an `unscripted` dispatch would answer "No data." and prove nothing.
for kind in ("good", "bad"):
    for cid in CASES:
        got = [x["tool"] for x in recs[kind][cid]["dispatches"] if x["outcome"] == "unscripted"]
        assert not got, (kind, cid, got)
        assert not evs[kind][cid]["hard"], (kind, cid, evs[kind][cid]["hard"])

# Mailboxes. email_accounts lists the ids; every email tool 404s any other (search: EMAIL_SEARCH_FAILED), and
# email_search filters by `query` and echoes it.
acc = results("good", "v2-email-accounts", "email_accounts")[0]
assert acc["type"] == "email_accounts" and acc["accountCount"] == 1 and acc["accounts"][0]["id"] == "acct-main", acc
assert set(acc["accounts"][0]) == {"id", "address", "displayName", "authMode", "canSend", "imapStatus", "lastIdleAt"}, acc
assert acc["accounts"][0]["canSend"] is True
found = results("good", "v2-email-accounts", "email_search")[0]
assert found["query"] == "lease" and found["threadCount"] == 1, found
assert found["threads"][0]["subject"] == "Lease renewal paperwork" and found["threads"][0]["threadKey"] == "th-landlord", found
wrong = json.dumps(results("bad", "v2-email-accounts", "email_search"))
assert "EMAIL_SEARCH_FAILED" in wrong and "orchestrator returned 404" in wrong, wrong
for needle in ("required email_accounts", "final_missing lease renewal"):
    assert needle in said("bad", "v2-email-accounts"), said("bad", "v2-email-accounts")
print("ok  email: email_accounts lists the mailbox, an unknown accountId is a 404, email_search filters by query")

# Route-owned writes. unblock_network_device and share_clip answer the route's 202: the loop raises no card, nothing
# changes (the device stays blocked) and a completion claim is the only thing the bad agent gets wrong.
for kind in ("good", "bad"):
    rec = recs[kind]["v2-route-writes"]
    assert [(x["tool"], x["outcome"]) for x in rec["dispatches"]] == [
        ("unblock_network_device", "confirmation_required"), ("share_clip", "confirmation_required")], rec["dispatches"]
    assert rec["confirmations"] == [], rec["confirmations"]
    assert [d["blocked"] for d in rec["world_after"]["devices"] if d["id"] == "dev-1"] == [True]
    assert sum("Droplet dashboard" in s.get("message", "") for s in rec["steps"] if s.get("type") == "tool_result") == 2
assert evs["bad"]["v2-route-writes"]["fails"] == ["claims_unexecuted_write"], evs["bad"]["v2-route-writes"]["fails"]
print("ok  route-owned: unblock_network_device and share_clip answer the route's 202, nothing changes")

# Background runs. One run in full (list_agent_runs run_id=) and cancel_agent_run's production answer; an unknown id is a
# NOT_FOUND that does not stop the run.
one = results("good", "v2-runs", "list_agent_runs")[0]
assert one["id"] == "run-7" and one["steps"] == "6/30" and one["status"] == "running" and one["endedAt"] is None, one
assert one["title"] == "Supplier toner price check" and "createdAt" in one, one
cx = results("good", "v2-runs", "cancel_agent_run")[0]
assert (cx["runId"], cx["status"]) == ("run-7", "cancelled") and cx["message"].startswith("Stopped."), cx
assert [r["status"] for r in recs["good"]["v2-runs"]["world_after"]["runs"]] == ["cancelled"]
nf = json.dumps(results("bad", "v2-runs", "cancel_agent_run"))
assert "NOT_FOUND" in nf and "run-9" in nf, nf
assert [r["status"] for r in recs["bad"]["v2-runs"]["world_after"]["runs"]] == ["running"]
for needle in ("required list_agent_runs", "claims_unexecuted_write", "world run run-7 = running (want cancelled)"):
    assert needle in said("bad", "v2-runs"), said("bad", "v2-runs")
print("ok  runs: list_agent_runs run_id= and cancel_agent_run answer in production's shape, an unknown id is NOT_FOUND")

# Routines. routine_run is interceptor-owned (exactly one card, then the approved replay runs); a draft is saved as a
# read-only draft; a taken slug is SLUG_TAKEN and a draft does not run (ROUTINE_NOT_LIVE).
rl = results("good", "v2-routines", "routine_list")[0]
assert rl["count"] == 1 and rl["routines"][0]["slug"] == "morning-bookings-digest" and rl["routines"][0]["steps"] == 2, rl
assert rl["routines"][0]["status"] == "live" and rl["routines"][0]["schedules"] == [], rl
dr = results("good", "v2-routines", "routine_draft")[0]
assert (dr["slug"], dr["status"], dr["writes"], dr["steps"]) == ("evening-recap", "draft", False, 2), dr
ran = answers("good", "v2-routines", "routine_run")
assert len(ran) == 1 and ran[0]["status"] == "ok" and ran[0]["slug"] == "morning-bookings-digest", ran
assert ran[0]["steps"] == 2 and ran[0]["message"].startswith('Ran "morning-bookings-digest"'), ran
assert len(recs["good"]["v2-routines"]["confirmations"]) == 1
assert "SLUG_TAKEN" in json.dumps(results("bad", "v2-routines", "routine_draft"))
assert "ROUTINE_NOT_LIVE" in json.dumps(results("bad", "v2-routines", "routine_run"))
assert "required routine_list" in said("bad", "v2-routines"), said("bad", "v2-routines")
print("ok  routines: list, draft and run answer in production's shape, a taken slug and a draft are refused")

# Memory. The shapes of extract, recall (a miss falls back to recent facts and says `broadened`) and forget; a forgotten
# fact is retired (the row stays) and no longer recalled.
first, again = results("good", "v2-memory", "memory_recall")
assert first["broadened"] is True and [f["id"] for f in first["facts"]] == ["fact-1"], first
assert set(first["facts"][0]) == {"id", "category", "fact", "addedBy", "addedAt"}, first
forgot = answers("good", "v2-memory", "memory_forget")
assert forgot == [{"type": "memory_forget", "id": "fact-1", "forgotten": True, "category": "Business",
                   "fact": "Beta is our code name for the Q4 signage project."}], forgot
assert again == {"facts": []}, again
assert [f["active"] for f in recs["good"]["v2-memory"]["world_after"]["memory"]] == [False]
for needle in ("required memory_forget", "claims_unexecuted_write"):
    assert needle in said("bad", "v2-memory"), said("bad", "v2-memory")
saved = answers("good", "v2-memory-save", "memory_extract_fact")
assert len(saved) == 1 and set(saved[0]) == {"id", "category", "fact", "addedAt"} and saved[0]["addedAt"].endswith(".000Z"), saved
assert any("Atlas" in f["fact"] for f in recs["good"]["v2-memory-save"]["world_after"]["memory"])
for needle in ("required memory_extract_fact", "claims_unexecuted_write", "world memory lacks Atlas"):
    assert needle in said("bad", "v2-memory-save"), said("bad", "v2-memory-save")
print("ok  memory: extract, recall (broadened on a miss) and forget answer in production's shape")
