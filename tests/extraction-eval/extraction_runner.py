"""WARP-2732 (ADR-048) — the extraction canary's box-side runner.

🔴 THIS FILE CANNOT RUN IN CI, AND THAT IS THE WHOLE REASON IT EXISTS.

It needs a box: a model on DMR, a seeded Nextcloud corpus, an indexed
`FileContentChunk` table and a filing worker that has processed it. No GitHub
Actions lane has any of those — `rag-tests.yml` is `workflow_dispatch`-only and
its own e2e test states the inference host "is unreachable on a CI runner / a
developer laptop".

So the work is split, deliberately:

  score.py          pure arithmetic, unit-tested pre-merge on every PR
  extraction_runner reads the box's own database, produces the numbers

CI can prove the SCORER is right. Only a box with a model can prove the
EXTRACTOR is. Pretending otherwise — a mocked "canary" that runs green in
Actions — would be worse than having none, because it would look like the gate
had been satisfied.

── The verdict is SQL, not the pipeline's own opinion ──────────────────────

Every number here is read back out of Postgres AFTER the worker has finished,
not collected from the worker as it goes. That matters for the PHI check in
particular: asking the pipeline "did you refuse it?" trusts the thing under
test. Counting rows in `CrmCompany`, `Contact`, `CrmDeal`, `CrmActivity` and
`EntityLink` for a PHI fixture's proposals asks the database what actually
happened.

── Usage ───────────────────────────────────────────────────────────────────

    docker exec droplet-rag-eval-1 \\
      python /opt/rag-eval/tests/extraction-eval/extraction_runner.py \\
        --database-url "$DATABASE_URL" --model gpt-oss:20b \\
        --out /data/rag-eval/runs/extraction-<stamp>.json

Exit code 0 only if every floor cleared and no breaker fired.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from score import evaluate, render_markdown, score_run  # noqa: E402

try:  # pragma: no cover - the box has it; a dev laptop may not
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]

import yaml


def load_goldens(root: Path) -> list[dict[str, Any]]:
    data = yaml.safe_load((root / "goldens.yaml").read_text(encoding="utf-8"))
    return list(data["goldens"])


def collect(conn, goldens: list[dict[str, Any]], corpus_prefix: str) -> list[dict[str, Any]]:
    """Read what the pipeline actually did, per fixture."""
    out: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        for g in goldens:
            fid = g["id"]
            # `sourceRef` is `file:<ncFileId>`; the seeded path carries the
            # fixture id, so join back through FileIndexStatus rather than
            # trusting a filename convention on the proposal.
            cur.execute(
                """
                SELECT p.id, p.kind::text, p.payload
                FROM "IngestProposal" p
                JOIN "FileIndexStatus" f ON f."ncFileId" = p."ncFileId"
                WHERE f."path" LIKE %s
                """,
                (f"%{corpus_prefix}%{fid}%",),
            )
            rows = cur.fetchall()

            cur.execute(
                """
                SELECT "extractStatus"::text, "extractReason"::text
                FROM "FileIndexStatus" WHERE "path" LIKE %s LIMIT 1
                """,
                (f"%{corpus_prefix}%{fid}%",),
            )
            status = cur.fetchone()

            payloads = [r[2] or {} for r in rows]
            company = next(
                (p.get("name") or p.get("companyName") for p in payloads if p), None
            )
            domain = next((p.get("domain") for p in payloads if p and p.get("domain")), None)
            total = next((p.get("total") for p in payloads if p and p.get("total")), None)
            creates = sum(1 for r in rows if r[1] == "CREATE_CUSTOMER")

            out.append(
                {
                    "id": fid,
                    "kind": g["kind"],
                    # 🔴 A source the worker never finished is NOT a parse
                    # success. Treating "no row yet" as parsed would let a run
                    # that timed out on half the corpus score a perfect JSON
                    # rate over the half it managed.
                    "parsed": bool(status) and status[0] in ("done", "skipped", "not_needed"),
                    "golden": {
                        "company_name": g.get("company_name"),
                        "domain": g.get("domain"),
                        "money_total": g.get("money_total"),
                    },
                    "actual": {
                        "company_name": company,
                        "domain": domain,
                        "money_total": total,
                        "proposals": len(rows),
                        "creates": creates,
                        "extract_status": status[0] if status else None,
                        "extract_reason": status[1] if status else None,
                    },
                }
            )
    return out


#: How each landed table is reached from a proposal.
#:
#: 🔴 Written out per table rather than looped over a name list. Only
#: `CrmCompany` and `Contact` carry a `proposalId` back-pointer; the others are
#: reached through the proposal's own `created*Id` columns. A generic loop that
#: assumed `proposalId` everywhere would have to fall back to something for the
#: rest — and the first cut of this function fell back to `WHERE false`, which
#: silently checked three of the five tables not at all while reporting a clean
#: run. A canary with a dead branch is worse than no canary.
#:
#: `CrmDeal` is here even though NO proposal kind creates one. That is the
#: point: it is a path that should not exist, and a canary that only checks the
#: paths we know about cannot tell us we were wrong about which paths exist.
LANDED_QUERIES: dict[str, str] = {
    "CrmCompany": 'SELECT count(*) FROM "CrmCompany" c WHERE c."proposalId" = ANY(%s)',
    "Contact": 'SELECT count(*) FROM "Contact" c WHERE c."proposalId" = ANY(%s)',
    "CrmActivity": (
        'SELECT count(*) FROM "CrmActivity" a '
        'WHERE a.id IN (SELECT "createdActivityId" FROM "IngestProposal" '
        "           WHERE id = ANY(%s) AND \"createdActivityId\" IS NOT NULL)"
    ),
    "EntityLink": (
        'SELECT count(*) FROM "EntityLink" e '
        'WHERE e.id IN (SELECT "createdEntityLinkId" FROM "IngestProposal" '
        "           WHERE id = ANY(%s) AND \"createdEntityLinkId\" IS NOT NULL)"
    ),
}

#: 🔴 `CrmDeal` IS NOT IN THE MAP ABOVE, and the absence is deliberate rather
#: than an omission.
#:
#: The ticket asks the canary to count rows across `CrmCompany`, `Contact`,
#: `CrmDeal`, `CrmActivity` and `EntityLink`. Four of those are reachable from
#: a proposal. `CrmDeal` has NO `proposalId` column and no `created*Id` pointing
#: at it — slice 1 added the back-pointer to companies and contacts only,
#: because no `IngestProposalKind` creates a deal.
#:
#: So there is no query to write. Writing one anyway would either error on a
#: missing column, or — worse, and this is what the first cut did — degrade to
#: something like `WHERE false`, which counts zero forever and reads as a clean
#: bill of health for a table nobody checked. The structural fact IS the
#: guarantee, and it is asserted in `test_score.py` against the datamodel so
#: that adding a deal-creating proposal kind without extending this map turns a
#: test red.
DEAL_HAS_NO_PROPOSAL_BACKPOINTER = True


def phi_proposal_ids(conn, corpus_prefix: str, fixture_id: str) -> list[str]:
    """Every proposal that came from one PHI fixture. Should always be empty."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id FROM "IngestProposal" p
            JOIN "FileIndexStatus" f ON f."ncFileId" = p."ncFileId"
            WHERE f."path" LIKE %s
            """,
            (f"%{corpus_prefix}%{fixture_id}%",),
        )
        return [r[0] for r in cur.fetchall()]


def assert_nothing_landed_from_phi(
    conn, fixtures: list[dict[str, Any]], corpus_prefix: str
) -> list[str]:
    """The database's own answer to "did any patient record reach the CRM?".

    Asked of the LANDED tables, not of the pipeline, and not only of the
    proposal table: a proposal created and then applied by a stray auto rule
    would be invisible to a check that counted proposals alone.
    """
    phi_ids = [f["id"] for f in fixtures if f["kind"] == "phi"]
    if not phi_ids:
        # 🔴 A vacuity guard. Every assertion below is "count == 0", which is
        # trivially true over an empty id list — so a corpus that lost its
        # decoys would report the strongest possible clean bill of health.
        return ["no PHI fixtures were collected — the decoys are missing from the corpus"]

    problems: list[str] = []
    with conn.cursor() as cur:
        for fid in phi_ids:
            proposals = phi_proposal_ids(conn, corpus_prefix, fid)
            if not proposals:
                continue  # the expected case: nothing was ever proposed
            problems.append(f"{fid}: {len(proposals)} proposal(s) exist at all")
            for table, sql in LANDED_QUERIES.items():
                cur.execute(sql, (proposals,))
                n = cur.fetchone()[0]
                if n:
                    problems.append(f"{fid}: {n} row(s) LANDED in {table}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ADR-048 extraction canary")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--model", required=True, help="the model tag under test")
    parser.add_argument("--out", help="write the results JSON here")
    parser.add_argument(
        "--corpus-prefix",
        default="extraction-eval",
        help="path fragment identifying the seeded corpus",
    )
    args = parser.parse_args(argv)

    if psycopg is None:  # pragma: no cover
        print("psycopg is not installed — this runner only works on a box", file=sys.stderr)
        return 2

    root = Path(__file__).parent
    goldens = load_goldens(root)

    with psycopg.connect(args.database_url) as conn:
        fixtures = collect(conn, goldens, args.corpus_prefix)
        landed = assert_nothing_landed_from_phi(conn, fixtures, args.corpus_prefix)

    verdict = evaluate(score_run(fixtures))
    if landed:
        # 🔴 Appended AFTER scoring, and it can only ever make the verdict
        # worse. A PHI row in the CRM is a fail whatever the metrics said.
        verdict.failures.extend(landed)
        verdict.passed = False

    report = {
        "model": args.model,
        "n_fixtures": len(fixtures),
        "fixtures": fixtures,
        "verdict": verdict.as_dict(),
    }
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        Path(args.out).with_suffix(".md").write_text(
            render_markdown(verdict, args.model), encoding="utf-8"
        )
    print(render_markdown(verdict, args.model))
    return 0 if verdict.passed else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
