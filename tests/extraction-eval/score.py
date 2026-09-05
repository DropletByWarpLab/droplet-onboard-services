"""WARP-2732 (ADR-048) — scoring an extraction run, and the floors that gate auto mode.

🔴 WHY THIS EXISTS AT ALL

No GitHub Actions lane can run a language model. `rag-tests.yml` is
`workflow_dispatch`-only and its own e2e test states the inference host "is
unreachable on a CI runner / a developer laptop". So extraction QUALITY — did
it pull the right customer, the right amount, and did it refuse the patient
record — cannot be gated pre-merge by anything that exists in this repo.

Without a measurement, `auto` mode would ship on an unmeasured model. So the
measurement is a database invariant rather than a promise: `AutoFilingSetting`
carries a CHECK that refuses `mode = 'auto'` until `canaryPassedAt` and
`canaryModel` are both set, and the only thing that sets them is a run of this
scorer clearing the floors below on the box's own model.

PR #2005 set itself the same unrun condition (a DMR grammar canary) and it has
never been run. This module is the thing that stops that repeating: the
arithmetic is pure, unit-tested offline in CI, and the verdict is a single
boolean a script can act on.

🔴 THE FLOORS ARE ABSOLUTE, NOT AN ENVELOPE

The RAGAS suite next door derives its floors as `p50 − 1.5·IQR` over recorded
runs, and `tests/retrieval-eval/ragas/baselines.json` records the consequence:

    "factual_correctness": { "floor": 0.0, "p50": 0.0, "iqr": 0.0, "n": 8 }

Eight runs, every one scoring zero, and the envelope pronounced a floor of zero
that every future zero clears. A relative band cannot tell "stable and good"
from "stable and broken". So these floors are written down as numbers, and the
envelope — when there is one — may only ever RAISE them.

🔴 AND ONE OF THEM IS NOT A NUMBER

A PHI false negative fails the run outright, at any envelope, at any sample
size. There is no rate at which letting a patient record through is acceptable,
so it is not expressed as a rate.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Sequence

# ── Floors ──────────────────────────────────────────────────────────────────

#: Absolute floors, per the ticket's table. A run clears the gate only if every
#: one of these holds AND no breaker fired.
FLOORS: Mapping[str, float] = {
    "company_name_exact": 0.90,
    "domain_exact": 0.90,
    "money_total_exact": 0.90,
    "json_parse_rate": 0.90,
}

#: Not a floor — a rule. Any RECORD-verdict fixture that produces a proposal
#: fails the run regardless of every number above.
PHI_FALSE_NEGATIVES_ALLOWED = 0

#: The two near-duplicate customers must resolve to exactly one create between
#: them: one create is a match working, two is the duplicate the matcher exists
#: to prevent, zero is the matcher refusing a real new customer.
DUPLICATE_PAIR_EXPECTED_CREATES = 1


# ── Normalisation ───────────────────────────────────────────────────────────


def normalize_name(value: str | None) -> str:
    """Case, punctuation and legal-suffix insensitive.

    Mirrors `normalizeCompanyName` in `services/filing/match.ts`. A scorer that
    normalised differently from the matcher would measure the scorer.
    """
    if not value:
        return ""
    out = value.lower()
    out = re.sub(r"[.,]", " ", out)
    out = re.sub(
        r"\b(?:ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|plc|gmbh|pty|co)\b",
        " ",
        out,
    )
    return re.sub(r"\s+", " ", out).strip()


def normalize_domain(value: str | None) -> str:
    """Scheme, path and case stripped — the `normalizeDomain` contract."""
    if not value:
        return ""
    out = value.strip().lower()
    out = re.sub(r"^[a-z]+://", "", out)
    out = out.split("/")[0].split("?")[0]
    return out[4:] if out.startswith("www.") else out


def normalize_money(value: str | None) -> str:
    """A decimal STRING compared in minor units.

    🔴 Never a float. `Decimal` because `4250.00` and `4250.0` are the same
    amount and `0.1 + 0.2` is not `0.3` — and because the column this feeds is
    `NUMERIC(20,6)`, where a float comparison would start disagreeing with the
    database somewhere past 2^53.
    """
    if value is None:
        return ""
    text = str(value).strip().replace(",", "").replace("$", "")
    if not text:
        return ""
    try:
        return str(Decimal(text).quantize(Decimal("0.01")))
    except (InvalidOperation, ValueError):
        # Unparseable is its own answer, and it must not equal another
        # unparseable value: returning "" for both would score two different
        # kinds of garbage as a match.
        return f"!unparseable:{text}"


# ── Per-field scoring ───────────────────────────────────────────────────────


@dataclass
class FieldScore:
    """Precision, recall and F1 for one field across the corpus."""

    matched: int = 0
    predicted: int = 0
    expected: int = 0

    @property
    def precision(self) -> float:
        return self.matched / self.predicted if self.predicted else 0.0

    @property
    def recall(self) -> float:
        return self.matched / self.expected if self.expected else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0

    @property
    def exact(self) -> float:
        """The headline the floors are stated against.

        Recall, not F1, and deliberately: the failure that matters for filing
        is a field the model did NOT produce (a customer that never gets
        matched), and F1 lets a high-precision run with terrible recall look
        respectable. When nothing was expected the score is 1.0 — a corpus with
        no domains is not a domain failure.
        """
        return self.recall if self.expected else 1.0

    def as_dict(self) -> dict[str, float | int]:
        return {
            "matched": self.matched,
            "predicted": self.predicted,
            "expected": self.expected,
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "exact": round(self.exact, 4),
        }


@dataclass
class RunScore:
    fields: dict[str, FieldScore] = field(default_factory=dict)
    #: RECORD-verdict fixtures that nevertheless produced a proposal. Any one
    #: of these fails the run.
    phi_false_negatives: list[str] = field(default_factory=list)
    #: Fixtures whose model reply could not be parsed as the contract.
    json_failures: list[str] = field(default_factory=list)
    n_fixtures: int = 0
    n_business_fixtures: int = 0
    total_proposals: int = 0
    duplicate_pair_creates: int | None = None

    def field_score(self, name: str) -> FieldScore:
        return self.fields.setdefault(name, FieldScore())


def score_run(fixtures: Sequence[Mapping[str, Any]]) -> RunScore:
    """Score one run.

    Each entry is `{id, kind, golden, actual, parsed}` where `kind` is
    "business" | "phi" | "duplicate", `parsed` says whether the model's reply
    satisfied the contract, and `golden`/`actual` carry the fields.
    """
    score = RunScore(n_fixtures=len(fixtures))

    duplicate_creates = 0
    saw_duplicate = False

    for fx in fixtures:
        fid = str(fx.get("id", "?"))
        kind = fx.get("kind")
        actual = fx.get("actual") or {}
        golden = fx.get("golden") or {}

        if not fx.get("parsed", True):
            score.json_failures.append(fid)

        proposals = int(actual.get("proposals", 0) or 0)
        score.total_proposals += proposals

        if kind == "phi":
            # 🔴 The rule, not a metric. A patient record that produced ANY
            # proposal is a false negative of the whole four-layer screen.
            if proposals > 0:
                score.phi_false_negatives.append(fid)
            # PHI fixtures contribute nothing to the field scores: there is no
            # correct company name to extract from a document we should never
            # have read.
            continue

        if kind == "duplicate":
            saw_duplicate = True
            duplicate_creates += int(actual.get("creates", 0) or 0)

        score.n_business_fixtures += 1
        _score_fields(score, golden, actual)

    if saw_duplicate:
        score.duplicate_pair_creates = duplicate_creates
    return score


def _score_fields(
    score: RunScore, golden: Mapping[str, Any], actual: Mapping[str, Any]
) -> None:
    for name, norm in (
        ("company_name", normalize_name),
        ("domain", normalize_domain),
        ("money_total", normalize_money),
    ):
        fs = score.field_score(f"{name}_exact")
        want = norm(golden.get(name))
        got = norm(actual.get(name))
        if want:
            fs.expected += 1
        if got:
            fs.predicted += 1
        if want and got and want == got:
            fs.matched += 1


# ── The verdict ─────────────────────────────────────────────────────────────


@dataclass
class Verdict:
    passed: bool
    failures: list[str]
    metrics: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "failures": self.failures, "metrics": self.metrics}


def json_parse_rate(score: RunScore) -> float:
    if score.n_fixtures == 0:
        return 0.0
    return (score.n_fixtures - len(score.json_failures)) / score.n_fixtures


def evaluate(score: RunScore, floors: Mapping[str, float] = FLOORS) -> Verdict:
    """Turn a scored run into a pass/fail with named reasons.

    Every failure is a SENTENCE naming the metric, what it was and what it
    needed. A canary that reports `False` and nothing else is a canary somebody
    re-runs until it goes green.
    """
    failures: list[str] = []
    metrics: dict[str, Any] = {name: fs.as_dict() for name, fs in sorted(score.fields.items())}
    metrics["json_parse_rate"] = round(json_parse_rate(score), 4)
    metrics["n_fixtures"] = score.n_fixtures
    metrics["n_business_fixtures"] = score.n_business_fixtures
    metrics["total_proposals"] = score.total_proposals
    metrics["phi_false_negatives"] = list(score.phi_false_negatives)
    metrics["duplicate_pair_creates"] = score.duplicate_pair_creates

    # ── Breakers first ──────────────────────────────────────────────────────
    #
    # 🔴 These come BEFORE the floors because they are the states in which the
    # floors are meaningless. WARP-1860 (a blanked service token) produced
    # fifteen consecutive all-zero nightly runs, and WARP-1870 (one wrong DMR
    # port) made every score meaningless while every run reported success. An
    # all-zero run must never read green.
    if score.n_fixtures == 0:
        failures.append("no fixtures were scored — the corpus is empty or was not seeded")
    elif score.n_business_fixtures > 0 and score.total_proposals == 0:
        failures.append(
            f"zero proposals over {score.n_business_fixtures} business fixtures — "
            "the extractor produced nothing at all, so every score below is vacuous"
        )

    # ── The rule ────────────────────────────────────────────────────────────
    if len(score.phi_false_negatives) > PHI_FALSE_NEGATIVES_ALLOWED:
        failures.append(
            "PHI FALSE NEGATIVE: "
            + ", ".join(score.phi_false_negatives)
            + " produced a proposal. Zero tolerance — this fails the run at any envelope."
        )

    # ── The floors ──────────────────────────────────────────────────────────
    for name, floor in floors.items():
        value = (
            metrics["json_parse_rate"]
            if name == "json_parse_rate"
            else score.fields.get(name, FieldScore()).exact
        )
        if value < floor:
            failures.append(f"{name} = {value:.4f}, below the floor of {floor:.2f}")

    if score.duplicate_pair_creates is not None:
        if score.duplicate_pair_creates != DUPLICATE_PAIR_EXPECTED_CREATES:
            failures.append(
                f"the near-duplicate pair produced {score.duplicate_pair_creates} creates, "
                f"expected exactly {DUPLICATE_PAIR_EXPECTED_CREATES} — "
                "two means the matcher missed, zero means it refused a real customer"
            )

    return Verdict(passed=not failures, failures=failures, metrics=metrics)


def render_markdown(verdict: Verdict, model: str) -> str:
    """The block a human pastes into the ticket.

    The ticket asks for the RAW METRICS, not a verdict, because "it passed" is
    not evidence — the numbers are, and they are what a later floor change gets
    argued against.
    """
    lines = [
        f"### Extraction canary — {'PASS' if verdict.passed else 'FAIL'}",
        "",
        f"- model: `{model}`",
        f"- fixtures: {verdict.metrics.get('n_fixtures')} "
        f"({verdict.metrics.get('n_business_fixtures')} business)",
        f"- proposals produced: {verdict.metrics.get('total_proposals')}",
        f"- JSON parse rate: {verdict.metrics.get('json_parse_rate')}",
        f"- PHI false negatives: {len(verdict.metrics.get('phi_false_negatives') or [])}",
        f"- duplicate-pair creates: {verdict.metrics.get('duplicate_pair_creates')}",
        "",
        "| field | expected | predicted | matched | exact |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name in ("company_name_exact", "domain_exact", "money_total_exact"):
        m = verdict.metrics.get(name)
        if isinstance(m, dict):
            lines.append(
                f"| {name} | {m['expected']} | {m['predicted']} | {m['matched']} | {m['exact']} |"
            )
    if verdict.failures:
        lines += ["", "**Failures**", ""] + [f"- {f}" for f in verdict.failures]
    return "\n".join(lines)


def load_fixtures(path: str) -> list[dict[str, Any]]:
    """Read a results file written by the runner."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return list(data.get("fixtures") or [])


def main(argv: Iterable[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Score an ADR-048 extraction run")
    parser.add_argument("results", help="path to the runner's results JSON")
    parser.add_argument("--model", default="unknown", help="model tag, for the report")
    parser.add_argument("--json", action="store_true", help="emit the verdict as JSON")
    args = parser.parse_args(list(argv) if argv is not None else None)

    verdict = evaluate(score_run(load_fixtures(args.results)))
    print(json.dumps(verdict.as_dict(), indent=2) if args.json
          else render_markdown(verdict, args.model))
    # 🔴 The exit code IS the gate. A script that has to parse prose to find
    # out whether the canary passed is a script that gets it wrong once.
    return 0 if verdict.passed else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
