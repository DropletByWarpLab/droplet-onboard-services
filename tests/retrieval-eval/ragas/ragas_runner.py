#!/usr/bin/env python3
"""WARP-436 RAGAS evaluation runner.

Reads tests/retrieval-eval/queries.yaml + tests/retrieval-eval/ragas/goldens.yaml,
hits the orchestrator's /api/admin/retrieval-eval/search endpoint for each
query, builds a HuggingFace Dataset, runs ragas.evaluate(), and writes JSON
plus Markdown summaries.

Requires:
  - The Compose stack up (orchestrator on $API_URL, db, ai-gateway, file-indexer).
  - Fixtures seeded (the existing tests/retrieval-eval/run.integration.test.ts
    beforeAll handles this; otherwise the runner reports degraded results).
  - AUTH_ENABLED=false in the orchestrator's env (test-lane convention).
  - For RAGAS_JUDGE=local (default): Ollama on http://localhost:11434 with
    the model named in RAGAS_LOCAL_JUDGE_MODEL (default `mistral`).
  - For RAGAS_JUDGE=cloud: OPENAI_API_KEY in env.

Typical usage (from repo root, with the stack up):

    python tests/retrieval-eval/ragas/ragas_runner.py \\
        --variant hybrid --limit 10 \\
        --out tests/retrieval-eval/ragas/results.json

CLI flags override env vars; env vars override defaults.

WARP-436 — Phase 2 batch B of ADR-003.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import ssl
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import yaml
from datasets import Dataset

# ─── config ─────────────────────────────────────────────────────────────
DEFAULT_API_URL = os.environ.get("API_URL", "http://localhost:3000")
DEFAULT_OLLAMA_URL = os.environ.get(
    "RAGAS_OLLAMA_URL", "http://localhost:11434/v1"
)
# Fall back to LLM_MODEL — the model the box actually pulls (single-box
# writes it to .env, which the rag-eval container loads via env_file) —
# before the historic `mistral` name production Ollama does not host.
# Without this every scheduled RAGAS run failed its judge calls on a
# stock appliance. Same fallback chain as the orchestrator's
# DEFAULT_MODEL (WARP-844).
DEFAULT_LOCAL_JUDGE_MODEL = os.environ.get(
    "RAGAS_LOCAL_JUDGE_MODEL"
) or os.environ.get("LLM_MODEL") or "mistral"
DEFAULT_CLOUD_JUDGE_MODEL = os.environ.get(
    "RAGAS_CLOUD_JUDGE_MODEL", "gpt-4o-mini"
)
SEARCH_TIMEOUT_SEC = float(os.environ.get("RAGAS_SEARCH_TIMEOUT_SEC", "30"))

# Synthesis prompt is fixed so the `response` column is reproducible across
# baseline runs. Tuned to the retrieval-eval use case: short, no chain-of-
# thought, "I don't know" when contexts are empty.
SYNTHESIS_PROMPT = (
    "Answer the question using ONLY the provided contexts. Be concise "
    "(1-2 sentences). If the contexts do not contain the answer, reply "
    'with "I do not have enough information to answer."'
    "\n\nQuestion: {question}\n\nContexts:\n{contexts}\n\nAnswer:"
)


# ─── data types ─────────────────────────────────────────────────────────
@dataclass
class SearchHit:
    source: str
    path: str
    chunk_idx: int
    score: float
    snippet: str


# ─── I/O ────────────────────────────────────────────────────────────────
def load_queries_and_goldens(repo_root: Path) -> list[dict[str, Any]]:
    queries_path = repo_root / "tests" / "retrieval-eval" / "queries.yaml"
    goldens_path = (
        repo_root / "tests" / "retrieval-eval" / "ragas" / "goldens.yaml"
    )

    with queries_path.open() as f:
        queries_yaml = yaml.safe_load(f)
    with goldens_path.open() as f:
        goldens_yaml = yaml.safe_load(f)

    by_id = {q["id"]: q for q in queries_yaml["queries"]}
    merged: list[dict[str, Any]] = []
    for g in goldens_yaml["goldens"]:
        q = by_id.get(g["id"])
        if q is None:
            print(
                f"WARNING: golden {g['id']} has no matching query; skipping",
                file=sys.stderr,
            )
            continue
        merged.append(
            {
                "id": g["id"],
                "user_input": q["query"],
                "reference": g["expected_answer"],
                "reference_contexts": g.get("reference_contexts", []) or [],
                # WARP-437: optional class label propagated to the row so the
                # summary writer can slice metrics by query class. Pre-WARP-437
                # YAML rows omit `class`; those land in the "unlabeled" bucket.
                "class": q.get("class") or "unlabeled",
            }
        )
    return merged


def _internal_tls_context() -> ssl.SSLContext | None:
    """WARP-1061 — internal-mTLS client context for the orchestrator call.

    This script runs as a SUBPROCESS of the rag-eval service (runner.py),
    where the `_shared.internal_tls` package is not importable (sys.path[0]
    is this script's dir), so it reads the same env contract directly:
    DROPLET_INTERNAL_TLS=1 → present the /data/service-tls bundle and pin
    trust to the internal CA; unset/0 → None (plain HTTP, unchanged).
    """
    if os.environ.get("DROPLET_INTERNAL_TLS", "0") != "1":
        return None
    ctx = ssl.create_default_context(
        cafile=os.environ.get("DROPLET_TLS_CA", "/data/service-tls/ca.pem")
    )
    ctx.load_cert_chain(
        certfile=os.environ.get("DROPLET_TLS_CERT", "/data/service-tls/cert.pem"),
        keyfile=os.environ.get("DROPLET_TLS_KEY", "/data/service-tls/key.pem"),
    )
    return ctx


def call_search(
    api_url: str, variant: str, query: str, limit: int
) -> list[SearchHit]:
    qs = urllib.parse.urlencode(
        {"variant": variant, "q": query, "limit": str(limit)}
    )
    url = f"{api_url}/api/admin/retrieval-eval/search?{qs}"
    try:
        with urllib.request.urlopen(
            url, timeout=SEARCH_TIMEOUT_SEC, context=_internal_tls_context()
        ) as resp:
            body = json.loads(resp.read())
    except Exception as e:
        raise RuntimeError(
            f"retrieval-eval call failed for {query!r}: {e}"
        ) from e
    hits: list[SearchHit] = []
    for h in body.get("results", []):
        hits.append(
            SearchHit(
                source=h["source"],
                path=h["path"],
                chunk_idx=h["chunkIdx"],
                score=float(h["score"]),
                # snippet is added by the WARP-436 endpoint extension.
                # Fall back gracefully if running against an older
                # orchestrator that hasn't shipped that extension.
                snippet=h.get("snippet") or "",
            )
        )
    return hits


# ─── LLM setup ──────────────────────────────────────────────────────────
def make_chat_llm(judge: str):
    """Return a langchain_openai.ChatOpenAI configured for the chosen judge.

    "local" → OpenAI-compat client pointed at Ollama (no API key needed;
                Ollama ignores the value, but the SDK requires a non-empty
                string so we pass a sentinel).
    "cloud" → real OpenAI client; requires OPENAI_API_KEY in env.
    """
    from langchain_openai import ChatOpenAI

    if judge == "local":
        return ChatOpenAI(
            model=DEFAULT_LOCAL_JUDGE_MODEL,
            base_url=DEFAULT_OLLAMA_URL,
            # Sentinel only — Ollama's OpenAI-compat endpoint ignores
            # api_key entirely, but the SDK requires a non-empty value.
            # Deliberately NOT shaped like a real key (`sk-…`) so secret
            # scanners don't false-positive.
            api_key="ollama-local-no-auth",
            temperature=0,
        )
    if judge == "cloud":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "RAGAS_JUDGE=cloud requires OPENAI_API_KEY in env"
            )
        return ChatOpenAI(
            model=DEFAULT_CLOUD_JUDGE_MODEL,
            api_key=api_key,
            temperature=0,
        )
    raise ValueError(f"unknown judge mode: {judge!r}")


def make_judge_llm(judge: str):
    """Wrap the chat LLM in RAGAS's adapter."""
    from ragas.llms import LangchainLLMWrapper

    return LangchainLLMWrapper(make_chat_llm(judge))


# ─── synthesis ─────────────────────────────────────────────────────────
def synthesize_answer(
    chat_llm, query: str, contexts: list[str]
) -> str:
    """Generate the `response` field for a (query, contexts) pair.

    RAGAS Faithfulness + AnswerRelevancy require a model answer to score.
    We could fetch this from the orchestrator's chat endpoint, but that
    would entangle eval results with the orchestrator's prompt template
    and tool-calling loop. A direct synthesis off the retrieved contexts
    isolates "retrieval quality + judge LLM quality" from "agent loop
    quality", which is the question Phase 2 is actually trying to answer.
    """
    if not contexts:
        return "I do not have enough information to answer."

    prompt = SYNTHESIS_PROMPT.format(
        question=query,
        contexts="\n---\n".join(contexts[:10]),
    )
    try:
        resp = chat_llm.invoke(prompt)
        return str(resp.content).strip()
    except Exception as e:
        # Fail soft — the runner still produces a row, marked with an
        # error sentinel so baselines.json doesn't silently swallow it.
        return f"[synthesis_error: {type(e).__name__}: {e}]"


# ─── runner ─────────────────────────────────────────────────────────────
def run(
    api_url: str,
    variant: str,
    limit: int,
    judge: str,
    out_json: Path,
    out_md: Path,
    repo_root: Path,
) -> int:
    print("== RAGAS runner ==")
    print(f"   api_url   = {api_url}")
    print(f"   variant   = {variant}")
    print(f"   limit     = {limit}")
    print(f"   judge     = {judge}")

    merged = load_queries_and_goldens(repo_root)
    print(f"   loaded    = {len(merged)} (query, golden) pairs")

    chat_llm = make_chat_llm(judge)

    rows: list[dict[str, Any]] = []
    # Error counters surface as `error_counts` in the JSON summary so
    # silent degradation (search 5xx, synthesis timeouts, judge LLM
    # blips) is visible during triage instead of just dragging metrics
    # down with no breadcrumb.
    n_search_errors = 0
    n_synthesis_errors = 0
    for i, row in enumerate(merged, 1):
        print(
            f"   [{i:>2}/{len(merged)}] {row['id']}: {row['user_input'][:60]}"
        )
        try:
            hits = call_search(api_url, variant, row["user_input"], limit)
        except RuntimeError as e:
            print(f"      ! {e}", file=sys.stderr)
            hits = []
            n_search_errors += 1
        # RAGAS context fields: retrieved_contexts (what the retriever
        # actually returned). When snippets are empty (older orchestrator
        # build, or chunk text was filtered), fall back to a path tag so
        # context-precision/recall still have something measurable.
        ctxs = [h.snippet for h in hits if h.snippet] or [
            f"<chunk source={h.source} path={h.path} idx={h.chunk_idx}>"
            for h in hits
        ]
        response = synthesize_answer(chat_llm, row["user_input"], ctxs)
        if response.startswith("[synthesis_error:"):
            n_synthesis_errors += 1
        rows.append(
            {
                "user_input": row["user_input"],
                "retrieved_contexts": ctxs,
                "reference": row["reference"],
                "reference_contexts": row["reference_contexts"],
                "response": response,
            }
        )

    # WARP-437: keep the per-row class labels in a parallel list so the
    # post-evaluate summary can slice metrics by class without polluting
    # the RAGAS Dataset with an extra column it doesn't recognise.
    row_classes: list[str] = [r["class"] for r in merged]

    ds = Dataset.from_pandas(pd.DataFrame(rows))
    print(f"   dataset   = {len(ds)} rows")

    # Import RAGAS lazily because it's the heaviest dep — surfaces import
    # errors after argument parsing rather than during module load.
    # NOTE: `--help` itself still requires pandas + datasets + pyyaml at
    # the top of the module; only ragas is deferred. Truly-fast `--help`
    # would need those moved inside `run()` too.
    from ragas import evaluate
    from ragas.metrics import (
        AnswerRelevancy,
        Faithfulness,
        FactualCorrectness,
        LLMContextPrecision,
        LLMContextRecall,
    )

    judge_llm = make_judge_llm(judge)

    print("   evaluating...")
    result = evaluate(
        dataset=ds,
        metrics=[
            Faithfulness(),
            LLMContextRecall(),
            LLMContextPrecision(),
            AnswerRelevancy(),
            FactualCorrectness(),
        ],
        llm=judge_llm,
    )

    df = result.to_pandas()
    metric_cols = [
        c
        for c in df.columns
        if c
        not in (
            "user_input",
            "retrieved_contexts",
            "reference",
            "reference_contexts",
            "response",
        )
    ]
    # WARP-437: per-class slicing of the metric columns. The integration
    # test consumer only reads top-level `metrics` today; `metrics_by_class`
    # is additive and ignored until the per-class context-recall gate
    # consumes it. Gate fires once `tests/retrieval-eval/ragas/baselines.json`
    # carries populated per-class envelopes (`envelopes_by_class.<class>.<metric>.floor`).
    df_with_class = df.copy()
    # `row_classes` is captured pre-evaluate from the source-of-truth list
    # so it stays aligned with `merged`/`rows` ordering regardless of how
    # ragas reorders its output dataframe internally.
    if len(row_classes) == len(df_with_class):
        df_with_class["_class"] = row_classes
    else:
        # Defensive: if RAGAS dropped/reshaped rows, skip per-class slicing
        # rather than emit misaligned numbers.
        df_with_class["_class"] = ["unlabeled"] * len(df_with_class)
    metrics_by_class: dict[str, dict[str, dict[str, float]]] = {}
    for cls_name, sub in df_with_class.groupby("_class"):
        metrics_by_class[str(cls_name)] = {
            col: {
                "p50": float(sub[col].quantile(0.5)),
                "p95": float(sub[col].quantile(0.95)),
                "mean": float(sub[col].mean()),
                "n": int(sub[col].count()),
            }
            for col in metric_cols
        }

    summary = {
        "variant": variant,
        "limit": limit,
        "judge": judge,
        "n_queries": len(ds),
        "error_counts": {
            "search": n_search_errors,
            "synthesis": n_synthesis_errors,
        },
        "metrics": {
            col: {
                "p50": float(df[col].quantile(0.5)),
                "p95": float(df[col].quantile(0.95)),
                "mean": float(df[col].mean()),
            }
            for col in metric_cols
        },
        # WARP-437: additive per-class slices. Consumers that don't know
        # about this field ignore it; the per-class gate (once enabled)
        # reads `metrics_by_class[<class>][context_recall|...].mean`.
        "metrics_by_class": metrics_by_class,
    }
    out_json.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"\n   wrote {out_json}")

    md_lines = [
        f"# RAGAS results — variant={variant} limit={limit} judge={judge}",
        "",
        f"Queries: {len(ds)}",
        "",
        "| Metric | p50 | p95 | mean |",
        "|---|---|---|---|",
    ]
    for metric, stats in summary["metrics"].items():
        md_lines.append(
            f"| {metric} | {stats['p50']:.3f} | "
            f"{stats['p95']:.3f} | {stats['mean']:.3f} |"
        )
    out_md.write_text("\n".join(md_lines) + "\n")
    print(f"   wrote {out_md}")
    return 0


def aggregate_runs(
    results_dir: Path,
    out_path: Path,
    judge: str,
) -> int:
    """Aggregate N per-run results-*.json files into a baselines.json.

    Schema matches tests/retrieval-eval/ragas/baselines.json:
      envelopes.<metric> = { floor, p50, p95, iqr }
      envelopes_by_class.<class>.<metric> = { floor, p50, p95, iqr }

    `floor = p50 − 1.5 × IQR` per the schema's documented formula. Each
    per-run sample is that run's `metrics.<m>.mean` — each run counts as
    one data point of the metric's central tendency, percentiles across
    runs.

    N=1 collapses to iqr=0, floor=p50. Cron-driven single runs still call
    this so artifacts always carry a baselines.candidate.json for diff
    against the canonical one; gate-enforcing baselines.json should only
    be promoted from an N>=5 dispatch.

    Used by services/rag-eval/ on the appliance for the WARP-436 batch D
    bootstrap path (manual `bootstrap --runs=5` from inside the container).
    """
    run_files = sorted(results_dir.glob("results-*.json"))
    if not run_files:
        print(
            f"::error::aggregate: no results-*.json in {results_dir}",
            file=sys.stderr,
        )
        return 1

    runs: list[dict[str, Any]] = []
    for f in run_files:
        try:
            runs.append(json.loads(f.read_text()))
        except (OSError, json.JSONDecodeError) as e:
            print(f"::warning::aggregate: skipped {f}: {e}", file=sys.stderr)

    if not runs:
        print("::error::aggregate: no valid runs after parse", file=sys.stderr)
        return 1

    n_runs = len(runs)
    n_queries = runs[0].get("n_queries", 0)

    metric_keys: set[str] = set()
    for r in runs:
        metric_keys.update(r.get("metrics", {}).keys())

    def envelope(samples: list[float]) -> dict[str, float]:
        s = pd.Series(samples)
        p50 = float(s.quantile(0.5))
        p95 = float(s.quantile(0.95))
        # IQR = Q3 - Q1; well-defined for n>=2, zero for n=1.
        iqr = float(s.quantile(0.75) - s.quantile(0.25)) if len(s) > 1 else 0.0
        floor = p50 - 1.5 * iqr
        return {"floor": floor, "p50": p50, "p95": p95, "iqr": iqr}

    envelopes: dict[str, dict[str, float]] = {}
    for m in sorted(metric_keys):
        samples = [
            float(r["metrics"][m]["mean"])
            for r in runs
            if m in r.get("metrics", {})
        ]
        if samples:
            envelopes[m] = envelope(samples)

    # Per-class envelopes (WARP-437 `metrics_by_class`). Classes missing
    # from a given run just don't contribute samples for that run.
    class_keys: set[str] = set()
    for r in runs:
        class_keys.update(r.get("metrics_by_class", {}).keys())

    envelopes_by_class: dict[str, dict[str, dict[str, float]]] = {}
    for cls in sorted(class_keys):
        per_metric: dict[str, dict[str, float]] = {}
        for m in sorted(metric_keys):
            samples = [
                float(r["metrics_by_class"][cls][m]["mean"])
                for r in runs
                if cls in r.get("metrics_by_class", {})
                and m in r["metrics_by_class"][cls]
            ]
            if samples:
                per_metric[m] = envelope(samples)
        if per_metric:
            envelopes_by_class[cls] = per_metric

    summary = {
        "_comment": (
            "WARP-436 — RAGAS metric baselines, aggregated by ragas_runner.py "
            "aggregate. Per-run mean is the unit sample; floor = p50 − 1.5 × IQR."
        ),
        "recorded_at": pd.Timestamp.now("UTC").isoformat(),
        "judge": judge,
        "n_queries": n_queries,
        "n_runs": n_runs,
        "runs": [str(f.name) for f in run_files],
        "envelopes": envelopes,
        "envelopes_by_class": envelopes_by_class,
        "_threshold_formula": "floor = p50 − 1.5 × IQR, computed over N runs",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"   aggregated {n_runs} runs × {len(envelopes)} metrics "
        f"× {len(envelopes_by_class)} classes → {out_path}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])

    # Subcommand surface — additive to the default "run" mode (no
    # subcommand needed for backwards-compat with the existing vitest
    # invocation `python ragas_runner.py --variant hybrid --limit 10 ...`).
    subparsers = parser.add_subparsers(dest="command")
    agg = subparsers.add_parser(
        "aggregate",
        help="Aggregate N per-run results-*.json files into a baselines.json.",
    )
    agg.add_argument(
        "--results-dir",
        required=True,
        type=Path,
        help="Directory containing results-*.json files (one per RAGAS run).",
    )
    # Deliberately named --out-baselines (not --out) so it doesn't
    # collide with the top-level parser's --out flag for the default
    # run-mode. argparse silently lets you redefine the same dest at
    # both levels but the resolution order is fragile — explicit
    # names rule it out.
    agg.add_argument(
        "--out-baselines",
        required=True,
        type=Path,
        dest="out_baselines",
        help="Output baselines.json path.",
    )
    # Same anti-collision reasoning for the judge label.
    agg.add_argument(
        "--judge",
        choices=["local", "cloud"],
        default=os.environ.get("RAGAS_JUDGE", "local"),
        dest="aggregate_judge",
        help="Judge LLM mode label to record in the baselines (default: local).",
    )

    parser.add_argument(
        "--variant",
        choices=["vector", "rrf", "hybrid", "hybrid-enhanced"],
        default="hybrid",
        help="Retrieval pipeline variant (default: hybrid).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Top-K results per query (default: 10).",
    )
    parser.add_argument(
        "--judge",
        choices=["local", "cloud"],
        default=os.environ.get("RAGAS_JUDGE", "local"),
        help="Judge LLM mode (default: local Ollama).",
    )
    parser.add_argument(
        "--api-url",
        default=DEFAULT_API_URL,
        help=f"Orchestrator base URL (default: {DEFAULT_API_URL}).",
    )
    parser.add_argument(
        "--out",
        default="tests/retrieval-eval/ragas/results.json",
        help="Output JSON path.",
    )
    parser.add_argument(
        "--out-md",
        default="tests/retrieval-eval/ragas/results.md",
        help="Output Markdown path.",
    )

    args = parser.parse_args()

    # WARP-436 batch D bootstrap path: aggregate subcommand short-circuits
    # before the run-mode arg resolution so it can be invoked without
    # --variant / --api-url / etc. Subparser uses distinct `dest`s
    # (out_baselines, aggregate_judge) to avoid colliding with the
    # top-level run-mode flags.
    if args.command == "aggregate":
        results_dir = (
            args.results_dir
            if args.results_dir.is_absolute()
            else Path.cwd() / args.results_dir
        )
        out_path = (
            args.out_baselines
            if args.out_baselines.is_absolute()
            else Path.cwd() / args.out_baselines
        )
        return aggregate_runs(
            results_dir=results_dir,
            out_path=out_path,
            judge=args.aggregate_judge,
        )

    # Repo root = three parents up from this file
    # (tests/retrieval-eval/ragas/ragas_runner.py).
    repo_root = Path(__file__).resolve().parents[3]
    out_json = (
        Path(args.out)
        if Path(args.out).is_absolute()
        else repo_root / args.out
    )
    out_md = (
        Path(args.out_md)
        if Path(args.out_md).is_absolute()
        else repo_root / args.out_md
    )

    return run(
        api_url=args.api_url,
        variant=args.variant,
        limit=args.limit,
        judge=args.judge,
        out_json=out_json,
        out_md=out_md,
        repo_root=repo_root,
    )


if __name__ == "__main__":
    sys.exit(main())
