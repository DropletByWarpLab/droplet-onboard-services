"""WARP-2732 (ADR-048) — the scorer's arithmetic, on the required CI lane.

No model, no Postgres, no network: pure pandas-free Python over canned run
results, so the thing that gates auto mode is itself gated pre-merge. That
split is the whole design — CI can prove the SCORER is right, and only a box
with a model can prove the EXTRACTOR is.

The tests that matter most are the ones about a run that should NOT pass:

  * an all-zero run, which is what a blanked service token (WARP-1860) and a
    wrong DMR port (WARP-1870) both produce, and which the RAGAS envelope
    happily called a floor;
  * a PHI false negative, which fails at any envelope and any sample size;
  * a duplicate pair that created twice, or not at all.

MUTATIONS THESE CATCH:
  - delete the zero-proposal breaker
  - make the PHI rule a rate instead of a rule
  - score money through a float
  - use F1 instead of recall for the `exact` headline
  - let an empty corpus report a pass
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from score import (  # noqa: E402
    DUPLICATE_PAIR_EXPECTED_CREATES,
    FLOORS,
    PHI_FALSE_NEGATIVES_ALLOWED,
    FieldScore,
    evaluate,
    json_parse_rate,
    normalize_domain,
    normalize_money,
    normalize_name,
    render_markdown,
    score_run,
)


def business(fid, name, domain=None, total=None, proposals=1, parsed=True, actual=None):
    """A fixture the model got right, unless `actual` overrides it."""
    golden = {"company_name": name, "domain": domain, "money_total": total}
    return {
        "id": fid,
        "kind": "business",
        "parsed": parsed,
        "golden": golden,
        "actual": {**golden, "proposals": proposals, **(actual or {})},
    }


def phi(fid, proposals=0):
    return {"id": fid, "kind": "phi", "parsed": True, "golden": {}, "actual": {"proposals": proposals}}


# ── The corpus and its answer key ───────────────────────────────────────────


class TestGoldensMatchTheCorpus:
    """🔴 The answer key must be readable off the documents themselves.

    This is the direct guard against the failure the RAGAS goldens document in
    their own header: half of those were [INFERRED] from filenames and notes
    rather than read off a fixture, and an inferred golden measures the
    annotator. Worse, it measures them flatteringly — a golden written from
    what you expect the model to say cannot catch the model saying it wrongly.

    So every value this suite scores against is asserted to appear IN the
    fixture. A goldens edit that drifts from the corpus fails here, in CI,
    without a model.
    """

    ROOT = Path(__file__).parent

    def _goldens(self):
        import yaml

        return yaml.safe_load((self.ROOT / "goldens.yaml").read_text(encoding="utf-8"))["goldens"]

    def test_the_corpus_is_the_size_the_gate_assumes(self):
        goldens = self._goldens()
        kinds = [g["kind"] for g in goldens]
        assert len(goldens) == 12
        assert kinds.count("business") == 7
        assert kinds.count("phi") == 3
        assert kinds.count("duplicate") == 2

    def test_every_golden_has_a_fixture(self):
        stems = {p.stem for p in (self.ROOT / "fixtures").iterdir()}
        for g in self._goldens():
            assert g["id"] in stems, f"{g['id']} has no fixture"

    def test_every_fixture_has_a_golden(self):
        # The other direction: a fixture with no golden is a document the run
        # reads and scores nothing for, which quietly shrinks the corpus.
        ids = {g["id"] for g in self._goldens()}
        for p in (self.ROOT / "fixtures").iterdir():
            assert p.stem in ids, f"{p.stem} has no golden"

    def test_MUTATION_write_a_golden_the_fixture_does_not_say(self):
        for g in self._goldens():
            matches = [p for p in (self.ROOT / "fixtures").iterdir() if p.stem == g["id"]]
            body = matches[0].read_text(encoding="utf-8").lower()
            for key in ("company_name", "domain"):
                value = g.get(key)
                if value:
                    assert value.lower() in body, f"{g['id']}: {key}={value!r} is not in the fixture"
            money = g.get("money_total")
            if money:
                whole = money.split(".")[0]
                assert whole in body or f"{int(whole):,}" in body, (
                    f"{g['id']}: money_total={money!r} is not in the fixture"
                )

    def test_no_fixture_names_a_real_hostname(self):
        # `egress-gate` reads a value-shaped hostname anywhere in the repo as
        # an unregistered outbound destination. A corpus of realistic-looking
        # domains would deny the PR, and registering twelve of them in a
        # reviewed security allowlist to describe fictional companies would be
        # worse. RFC 2606 `.example` throughout.
        pattern = re.compile(r"[a-z0-9-]+\.(com|net|org|io|ai|co|dev|uk|de)", re.I)
        for p in (self.ROOT / "fixtures").iterdir():
            hits = pattern.findall(p.read_text(encoding="utf-8"))
            assert not hits, f"{p.name} names a non-.example hostname: {hits}"


# ── The landed-table map, against the real datamodel ────────────────────────


class TestLandedTables:
    """The canary counts rows in the tables a filed proposal can reach.

    🔴 This asserts the map against `schema.prisma` rather than against a list
    someone typed. The first cut of the runner looped over five table names and
    fell back to `WHERE false` for the three that have no `proposalId` — three
    of five tables checked not at all, while every run reported clean. A canary
    with a dead branch is worse than no canary, because it is evidence.
    """

    SCHEMA = Path(__file__).resolve().parents[2] / "apps/orchestrator/prisma/schema.prisma"

    def _model(self, name: str) -> str:
        """The datamodel block for one model, read off schema.prisma."""
        src = self.SCHEMA.read_text(encoding="utf-8")
        header = "model " + name + " {"
        start = src.index(header)
        return src[start : src.index(chr(10) + "}", start)]

    def test_the_map_covers_exactly_the_reachable_tables(self):
        from extraction_runner import LANDED_QUERIES

        assert set(LANDED_QUERIES) == {"CrmCompany", "Contact", "CrmActivity", "EntityLink"}

    def test_the_two_proposalId_tables_really_have_the_column(self):
        for model in ("CrmCompany", "Contact"):
            assert "proposalId" in self._model(model), f"{model} lost its proposalId back-pointer"

    def test_MUTATION_add_a_deal_creating_proposal_kind_without_a_query(self):
        # `CrmDeal` is deliberately absent from the map because nothing can
        # reach it. If that stops being true — a `CREATE_DEAL` kind, or a
        # `proposalId` on the model — the canary would silently stop covering
        # a path that now exists.
        from extraction_runner import DEAL_HAS_NO_PROPOSAL_BACKPOINTER

        assert DEAL_HAS_NO_PROPOSAL_BACKPOINTER
        assert "proposalId" not in self._model("CrmDeal")
        kinds = self.SCHEMA.read_text(encoding="utf-8")
        block = kinds[kinds.index("enum IngestProposalKind") :]
        block = block[: block.index("}")]
        assert "CREATE_DEAL" not in block

    def test_no_query_degrades_to_a_constant(self):
        # The specific shape that made three tables invisible.
        from extraction_runner import LANDED_QUERIES

        for name, sql in LANDED_QUERIES.items():
            assert "where false" not in sql.lower(), f"{name} counts nothing by construction"
            assert "%s" in sql, f"{name} ignores the proposal ids it was given"


# ── The runner's refusals ───────────────────────────────────────────────────


class TestRunnerRefusals:
    """The three states in which the canary must decline to measure anything.

    🔴 Exit codes 1 and 2 stay distinct on purpose. A measured FAIL is a
    SUCCESSFUL measurement that answered no; "could not run" is a broken
    harness. Collapsing them is the reading that gets a gate retried until it
    goes green rather than investigated.
    """

    def test_the_exit_codes_are_three_distinct_answers(self):
        import extraction_runner as r

        assert (r.EXIT_PASS, r.EXIT_FAIL, r.EXIT_CANNOT_RUN) == (0, 1, 2)

    def test_MUTATION_run_with_no_database_url(self, capsys):
        # A canary that quietly ran against no database is WARP-1860's fifteen
        # green all-zero nightly runs.
        import extraction_runner as r

        assert r.run("", "gpt-oss:20b") == r.EXIT_CANNOT_RUN

    def test_MUTATION_run_with_no_model_tag(self):
        # The pass is recorded AGAINST a model; guessing which one would unlock
        # auto mode for the wrong name.
        import extraction_runner as r

        assert r.run("postgres://x", "") == r.EXIT_CANNOT_RUN

    def test_it_is_a_function_not_a_subprocess(self):
        # semgrep's dangerous-subprocess-use-tainted-env-args flagged the first
        # cut, which shelled out with an argv list built from env vars. A list
        # without `shell=True` is not injectable, but the rule was pointing at
        # something real: there was no reason for a child process here, and
        # removing it removed an argv round-trip too.
        # Asserted on the CALL, not on the word: the header explains at length
        # why there is no child process here, and a test that banned the word
        # would ban its own explanation.
        src = (Path(__file__).parent / "extraction_runner.py").read_text(encoding="utf-8")
        assert "import subprocess" not in src
        assert "subprocess.run(" not in src
        assert "def run(" in src


# ── Normalisation ───────────────────────────────────────────────────────────


class TestNormalisation:
    def test_company_name_matches_the_matcher(self):
        # The scorer must normalise the way `match.ts` does, or it measures
        # itself rather than the model.
        assert normalize_name("ACME Dental Supply Ltd.") == normalize_name("acme dental supply")
        assert normalize_name("Northgate Dental, Inc") == "northgate dental"
        assert normalize_name(None) == ""

    def test_domain_ignores_scheme_path_and_www(self):
        assert normalize_domain("https://WWW.Acme-Dental.example/pricing") == "acme-dental.example"
        assert normalize_domain("acme-dental.example") == "acme-dental.example"

    def test_money_compares_in_minor_units_not_floats(self):
        # 🔴 MUTATION: score money through a float. `4250.00` and `4250.0` are
        # the same amount; `0.1 + 0.2` is not `0.3`; and the column this feeds
        # is NUMERIC(20,6), where a float starts disagreeing with the database
        # past 2^53.
        assert normalize_money("4250.00") == normalize_money("4250.0")
        assert normalize_money("$4,250.00") == normalize_money("4250")
        assert normalize_money("12345678901234.99") == "12345678901234.99"
        assert normalize_money("4250.00") != normalize_money("4250.01")

    def test_two_unparseable_values_are_not_a_match(self):
        # Returning "" for both would score two different kinds of garbage as
        # a match, and a garbage-vs-garbage match inflates recall.
        a = normalize_money("about four thousand")
        b = normalize_money("see attached")
        assert a != b
        assert a.startswith("!unparseable")


# ── Field scoring ───────────────────────────────────────────────────────────


class TestFieldScore:
    def test_exact_is_recall_not_f1(self):
        # 🔴 MUTATION: use F1. The failure that matters for filing is a field
        # the model did NOT produce — a customer that never gets matched — and
        # F1 lets a high-precision run with terrible recall look respectable.
        fs = FieldScore(matched=1, predicted=1, expected=10)
        assert fs.precision == 1.0
        assert fs.recall == pytest.approx(0.1)
        assert fs.f1 > fs.recall  # F1 flatters this run
        assert fs.exact == pytest.approx(0.1)

    def test_a_corpus_with_no_domains_is_not_a_domain_failure(self):
        assert FieldScore().exact == 1.0

    def test_a_perfect_run_clears_every_floor(self):
        verdict = evaluate(
            score_run(
                [
                    business("b1", "ACME Dental Supply Ltd", "acme-dental.example", "4250.00"),
                    business("b2", "Northgate Dental", "northgate.example", "980.00"),
                    phi("p1"),
                ]
            )
        )
        assert verdict.passed, verdict.failures
        assert verdict.metrics["company_name_exact"]["exact"] == 1.0


# ── The breakers ────────────────────────────────────────────────────────────


class TestBreakers:
    def test_MUTATION_delete_the_zero_proposal_breaker(self):
        # WARP-1860: a blanked service token produced fifteen consecutive
        # all-zero nightly runs. WARP-1870: one wrong DMR port made every score
        # meaningless while every run reported success. An all-zero run must
        # never read green — and note it would otherwise pass the floors here,
        # because a run that extracted NOTHING has no wrong answers.
        fixtures = [
            {
                "id": "b1",
                "kind": "business",
                "parsed": True,
                "golden": {"company_name": "ACME"},
                "actual": {"proposals": 0},
            }
        ]
        verdict = evaluate(score_run(fixtures))
        assert not verdict.passed
        assert any("zero proposals" in f for f in verdict.failures)

    def test_an_empty_corpus_never_passes(self):
        verdict = evaluate(score_run([]))
        assert not verdict.passed
        assert any("no fixtures" in f for f in verdict.failures)

    def test_the_breaker_names_what_is_vacuous(self):
        verdict = evaluate(score_run([business("b1", "ACME", proposals=0, actual={"proposals": 0})]))
        assert any("vacuous" in f for f in verdict.failures)


# ── The PHI rule ────────────────────────────────────────────────────────────


class TestPhiRule:
    def test_MUTATION_make_the_PHI_rule_a_rate(self):
        # 🔴 One patient record through, in a corpus of a hundred, is still a
        # patient record in the CRM. There is no rate at which this is
        # acceptable, so it is not expressed as one.
        assert PHI_FALSE_NEGATIVES_ALLOWED == 0
        fixtures = [business(f"b{i}", f"Co {i}", total="10.00") for i in range(20)]
        fixtures.append(phi("p1", proposals=1))
        verdict = evaluate(score_run(fixtures))
        assert not verdict.passed
        assert any("PHI FALSE NEGATIVE" in f for f in verdict.failures)
        # And it says WHICH one, because a canary that fails without naming the
        # fixture is one somebody re-runs rather than reads.
        assert any("p1" in f for f in verdict.failures)

    def test_a_PHI_fixture_contributes_nothing_to_the_field_scores(self):
        # There is no correct company name to extract from a document we should
        # never have read; counting it as a miss would let a good PHI screen
        # depress the very numbers that gate the feature.
        with_phi = score_run([business("b1", "ACME", "acme.example", "10.00"), phi("p1")])
        without = score_run([business("b1", "ACME", "acme.example", "10.00")])
        assert with_phi.fields["company_name_exact"].as_dict() == (
            without.fields["company_name_exact"].as_dict()
        )

    def test_a_refused_PHI_fixture_is_not_a_failure(self):
        verdict = evaluate(score_run([business("b1", "ACME", "a.example", "10.00"), phi("p1")]))
        assert verdict.passed, verdict.failures


# ── The floors ──────────────────────────────────────────────────────────────


class TestFloors:
    def test_the_floors_are_absolute_numbers_not_an_envelope(self):
        # The RAGAS suite next door records `factual_correctness` floor 0.0
        # from eight runs that all scored zero. A relative band cannot tell
        # "stable and good" from "stable and broken".
        assert FLOORS["company_name_exact"] == 0.90
        assert FLOORS["money_total_exact"] == 0.90
        assert FLOORS["json_parse_rate"] == 0.90
        assert all(v > 0 for v in FLOORS.values())

    def test_a_run_below_a_floor_fails_and_says_which(self):
        # Nine of ten right on the name, but the money is wrong five times.
        fixtures = [
            business(f"b{i}", f"Co {i}", total="10.00", actual={"money_total": "99.00"})
            for i in range(5)
        ] + [business(f"c{i}", f"Co {i}", total="10.00") for i in range(5)]
        verdict = evaluate(score_run(fixtures))
        assert not verdict.passed
        assert any("money_total_exact" in f and "0.90" in f for f in verdict.failures)
        assert not any("company_name_exact" in f for f in verdict.failures)

    def test_json_parse_rate_counts_every_fixture(self):
        fixtures = [business(f"b{i}", f"Co {i}", total="10.00") for i in range(9)]
        fixtures.append(business("bad", "Co", total="10.00", parsed=False))
        score = score_run(fixtures)
        assert json_parse_rate(score) == pytest.approx(0.9)
        assert evaluate(score).passed


# ── The duplicate pair ──────────────────────────────────────────────────────


class TestDuplicatePair:
    def _pair(self, creates_each):
        return [
            {
                "id": "d1",
                "kind": "duplicate",
                "parsed": True,
                "golden": {"company_name": "Northgate Dental"},
                "actual": {
                    "company_name": "Northgate Dental",
                    "proposals": 1,
                    "creates": creates_each[0],
                },
            },
            {
                "id": "d2",
                "kind": "duplicate",
                "parsed": True,
                "golden": {"company_name": "Northgate Dental"},
                "actual": {
                    "company_name": "Northgate Dental",
                    "proposals": 1,
                    "creates": creates_each[1],
                },
            },
        ]

    def test_exactly_one_create_passes(self):
        assert DUPLICATE_PAIR_EXPECTED_CREATES == 1
        assert evaluate(score_run(self._pair((1, 0)))).passed

    def test_two_creates_is_the_duplicate_the_matcher_exists_to_prevent(self):
        verdict = evaluate(score_run(self._pair((1, 1))))
        assert not verdict.passed
        assert any("2 creates" in f for f in verdict.failures)

    def test_zero_creates_means_it_refused_a_real_customer(self):
        # The opposite failure, and it must not read as success. A matcher that
        # never creates looks perfect on a duplicate-detection metric.
        verdict = evaluate(score_run(self._pair((0, 0))))
        assert not verdict.passed
        assert any("0 creates" in f for f in verdict.failures)


# ── The report ──────────────────────────────────────────────────────────────


class TestReport:
    def test_the_report_carries_raw_numbers_not_a_verdict(self):
        # The ticket asks for the raw metrics pasted in, because "it passed" is
        # not evidence — the numbers are, and they are what a later floor
        # change gets argued against.
        verdict = evaluate(score_run([business("b1", "ACME", "a.example", "10.00"), phi("p1")]))
        md = render_markdown(verdict, "gpt-oss:20b")
        assert "gpt-oss:20b" in md
        assert "company_name_exact" in md
        assert "PASS" in md

    def test_a_failing_report_lists_every_reason(self):
        verdict = evaluate(score_run([phi("p1", proposals=1)]))
        md = render_markdown(verdict, "gpt-oss:20b")
        assert "FAIL" in md
        assert "Failures" in md
        assert "PHI FALSE NEGATIVE" in md
