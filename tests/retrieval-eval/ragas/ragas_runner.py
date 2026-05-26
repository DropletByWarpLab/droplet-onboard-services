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
DEFAULT_LOCAL_JUDGE_MODEL = os.environ.get(
    "RAGAS_LOCAL_JUDGE_MODEL", "mistral"
)
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
            }
        )
    return merged


def call_search(
    api_url: str, variant: str, query: str, limit: int
) -> list[SearchHit]:
    qs = urllib.parse.urlencode(
        {"variant": variant, "q": query, "limit": str(limit)}
    )
    url = f"{api_url}/api/admin/retrieval-eval/search?{qs}"
    try:
        with urllib.request.urlopen(url, timeout=SEARCH_TIMEOUT_SEC) as resp:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--variant",
        choices=["vector", "rrf", "hybrid"],
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
