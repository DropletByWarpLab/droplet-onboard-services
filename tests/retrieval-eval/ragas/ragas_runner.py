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
  - AUTH_ENABLED=false in the orchestrator's env (test-lane convention),
    OR — on auth-enabled appliances — ORCHESTRATOR_SERVICE_TOKEN (service
    bearer presented to the search endpoint) plus RAGAS_EVAL_USER (whose
    corpus to evaluate against) in env. See _build_search_request().
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
import math
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

# WARP-1860 — consecutive retrieval failures that abort the run.
#
# Auth, URL, and network breakage fail EVERY query identically, so once a
# streak forms there is nothing left to measure: continuing spends the
# synthesis LLM — the expensive part — on empty context and scores the lot
# 0.0. A blanked SERVICE_TOKEN_RAG_EVAL did exactly that for 15 consecutive
# nightly runs, each pinning the GPU for ~10 minutes to write an all-zero
# baseline that reads identically to a genuine zero score.
#
# 3 tolerates the odd flaky query while catching systematic failure inside
# the first few seconds. 0 disables the breaker, for lanes that legitimately
# expect most queries to fail.
SEARCH_ABORT_AFTER = int(os.environ.get("RAGAS_SEARCH_ABORT_AFTER", "3"))

# WARP-1407 — baseline-envelope containment margin. aggregate_runs() clamps
# every envelope's floor to min(sample means) − FLOOR_MARGIN (never above),
# so a floor built from correlated back-to-back bootstrap runs (IQR ≈ 0)
# can't degenerate to ≈p50 and reject the next independent run on ordinary
# judge variance. Not env-tunable on purpose: a per-box margin would make
# promoted baselines mean different things on different appliances.
FLOOR_MARGIN = 0.02

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


class SearchUnavailable(Exception):
    """Retrieval is systematically unavailable — abort instead of scoring.

    Raised once SEARCH_ABORT_AFTER consecutive searches have failed. main()
    turns it into a non-zero exit, so the appliance's run_once() raises
    CalledProcessError and the scheduler records a durable FAILED record
    carrying the reason — instead of a "successful" run full of zeros.

    Deliberately NOT a RuntimeError: call_search() raises RuntimeError for a
    single failed query and run()'s loop catches exactly that. Sharing the
    base class would mean any future refactor that raised the breaker one
    line further up got it silently swallowed by the very handler it exists
    to escape.
    """


def _check_search_failure_streak(
    consecutive: int, last_error: str, threshold: int | None = None
) -> None:
    """Trip the breaker once `consecutive` search failures reach the limit.

    `threshold` defaults to SEARCH_ABORT_AFTER, resolved at call time rather
    than as a default argument — Python would freeze the value at import and
    make the constant untunable by tests and by env.
    """
    limit = SEARCH_ABORT_AFTER if threshold is None else threshold
    if limit > 0 and consecutive >= limit:
        raise SearchUnavailable(
            f"{consecutive} consecutive retrieval failures — aborting before "
            f"the synthesis LLM scores an empty corpus. Last error: "
            f"{last_error}"
        )


# Env names carrying the service bearer, in precedence order. Compose hands
# the rag-eval container the SAME secret under both: SERVICE_TOKEN_RAG_EVAL
# arrives straight from `env_file: ../.env`, while ORCHESTRATOR_SERVICE_TOKEN
# is an `environment:` entry resolved by ${...} substitution against
# docker/.env. When that second file lacks the key the substitution yields ""
# and — because `environment:` outranks `env_file:` — shadows a perfectly good
# value sitting right there under the other name. WARP-1860: 15 consecutive
# nightly runs 401'd on exactly that, so we read through to the survivor.
_BEARER_ENV_NAMES = ("ORCHESTRATOR_SERVICE_TOKEN", "SERVICE_TOKEN_RAG_EVAL")


def _resolve_bearer() -> tuple[str, str]:
    """Return (token, source_env_name); ("", "") when no bearer is available.

    Whitespace-only is not a credential — an env var set to spaces is a
    misconfiguration, and sending `Bearer    ` just turns a clear 401
    "missing" into a confusing 401 "invalid".
    """
    for name in _BEARER_ENV_NAMES:
        token = (os.environ.get(name) or "").strip()
        if token:
            return token, name
    return "", ""


def _describe_auth_posture() -> str:
    """One-line summary of how this run will authenticate — never the values.

    An appliance running AUTH_ENABLED=true with no bearer 401s on every
    query. Stating the posture up front means the first log line already
    narrows the cause when a run trips the breaker seconds later, and naming
    the SOURCE distinguishes "no secret anywhere" from "the expected env name
    was blanked and we fell through to the other one".
    """
    _, source = _resolve_bearer()
    eval_user = (os.environ.get("RAGAS_EVAL_USER") or "").strip()
    return (
        f"bearer={source or 'ABSENT'} "
        f"eval_user={eval_user or 'ABSENT'}"
    )


def _build_search_request(
    api_url: str, variant: str, query: str, limit: int
) -> urllib.request.Request:
    """Assemble the retrieval-eval search request (URL + auth header).

    Deployed appliances run AUTH_ENABLED=true, where the historic anonymous
    call 401'd on EVERY query — empty contexts, junk metrics, and nobody
    noticed until the run-results-visibility work surfaced the files. Two
    env contracts fix that (compose wires both on the appliance):

      - ORCHESTRATOR_SERVICE_TOKEN: set and non-empty → sent as
        "Authorization: Bearer <token>" (the rag-eval service principal).
        Falls back to SERVICE_TOKEN_RAG_EVAL, which compose delivers to the
        same container via env_file and which therefore survives the
        substitution blanking described on _BEARER_ENV_NAMES (WARP-1860).
      - RAGAS_EVAL_USER: set and non-empty → `user=<value>` joins the query
        string. The search route scopes retrieval to the CALLER's corpus and
        the service principal owns none, so the orchestrator accepts an
        explicit eval user from this principal (400 eval_user_required
        without it).

    With neither set (the offline AUTH_ENABLED=false test lane) the request
    is byte-for-byte what the pre-fix code sent: same URL, same param
    order, no extra params, no headers.
    """
    params = {"variant": variant, "q": query, "limit": str(limit)}
    eval_user = os.environ.get("RAGAS_EVAL_USER")
    if eval_user:
        params["user"] = eval_user
    qs = urllib.parse.urlencode(params)
    url = f"{api_url}/api/admin/retrieval-eval/search?{qs}"
    headers: dict[str, str] = {}
    token, _source = _resolve_bearer()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def call_search(
    api_url: str, variant: str, query: str, limit: int
) -> list[SearchHit]:
    req = _build_search_request(api_url, variant, query, limit)
    try:
        with urllib.request.urlopen(
            req, timeout=SEARCH_TIMEOUT_SEC, context=_internal_tls_context()
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


# ─── summary serialization ─────────────────────────────────────────────
def _sanitize_nonfinite(obj: Any) -> Any:
    """Recursively replace non-finite floats (NaN/±Inf) with None (→ null).

    Judge failures leave NaN sample scores (ragas runs with
    raise_exceptions=False), pandas mean/quantile propagates them, and
    json.dumps's default allow_nan=True then writes bare `NaN` tokens —
    which are not JSON. Such files crash the rag-eval service's FastAPI
    listing endpoints (strict allow_nan=False on serialize). Every
    results/baselines write goes through this first, with allow_nan=False
    on the dump as a regression belt.
    """
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize_nonfinite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nonfinite(v) for v in obj]
    return obj


def _render_markdown(summary: dict[str, Any]) -> str:
    """Render the run summary's Markdown table.

    Stats can be None after _sanitize_nonfinite (judge failures → NaN →
    null); render those cells as "n/a" instead of crashing on the `:.3f`
    format specifier.
    """
    md_lines = [
        f"# RAGAS results — variant={summary['variant']} "
        f"limit={summary['limit']} judge={summary['judge']}",
        "",
        f"Queries: {summary['n_queries']}",
        "",
        "| Metric | p50 | p95 | mean |",
        "|---|---|---|---|",
    ]
    for metric, stats in summary["metrics"].items():
        p50, p95, mean = (
            "n/a" if stats[k] is None else f"{stats[k]:.3f}"
            for k in ("p50", "p95", "mean")
        )
        md_lines.append(f"| {metric} | {p50} | {p95} | {mean} |")
    return "\n".join(md_lines) + "\n"


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
    print(f"   auth      = {_describe_auth_posture()}")

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
    # WARP-1860: a streak, not the total, is what proves systematic breakage
    # — scattered failures across an otherwise healthy run are ordinary.
    consecutive_search_errors = 0
    for i, row in enumerate(merged, 1):
        print(
            f"   [{i:>2}/{len(merged)}] {row['id']}: {row['user_input'][:60]}"
        )
        try:
            hits = call_search(api_url, variant, row["user_input"], limit)
            consecutive_search_errors = 0
        except RuntimeError as e:
            print(f"      ! {e}", file=sys.stderr)
            hits = []
            n_search_errors += 1
            consecutive_search_errors += 1
            # Raises SearchUnavailable once the streak hits the limit, which
            # propagates out of run() to main()'s non-zero exit. Deliberately
            # BEFORE synthesize_answer below: the whole point is to not spend
            # the LLM on a query whose context we already know is empty.
            _check_search_failure_streak(consecutive_search_errors, str(e))
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
    # WARP-1406: ADR-003 specced a bare `LLMContextPrecision` metric, but NO
    # ragas release exports that name (0.2.x and 0.4.x both ship only the
    # WithReference / WithoutReference variants) — this import crashed every
    # run that reached evaluate(), invisibly, on every appliance. We score
    # precision against the goldens' expected_answer, so the WithReference
    # variant is the one the design intended (see goldens.yaml header).
    from ragas.metrics import (
        AnswerRelevancy,
        Faithfulness,
        FactualCorrectness,
        LLMContextPrecisionWithReference,
        LLMContextRecall,
    )

    judge_llm = make_judge_llm(judge)

    # AnswerRelevancy is the ONE metric that requires an EMBEDDINGS model,
    # and we only pass llm= to evaluate() — ragas falls back to OpenAI
    # embeddings via OPENAI_API_KEY for it. Appliances run judge=local with
    # no key (compose sets it empty), where that fallback either NaNs the
    # whole column or raises and kills the run, depending on the
    # langchain-openai version. Skip the metric explicitly in that
    # configuration and record the decision in the summary ("no guessing":
    # skipped_metrics is an explicit empty list when nothing was skipped).
    skip_answer_relevancy = judge == "local" and not os.environ.get(
        "OPENAI_API_KEY"
    )
    skipped_metrics: list[str] = (
        ["answer_relevancy"] if skip_answer_relevancy else []
    )
    if skip_answer_relevancy:
        print(
            "NOTICE: skipping answer_relevancy — judge=local with no "
            "OPENAI_API_KEY (the metric needs an embeddings model)",
            file=sys.stderr,
        )

    print("   evaluating...")
    result = evaluate(
        dataset=ds,
        metrics=[
            Faithfulness(),
            LLMContextRecall(),
            LLMContextPrecisionWithReference(),
            *([] if skip_answer_relevancy else [AnswerRelevancy()]),
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
        # Metrics deliberately not evaluated this run (see the
        # skip_answer_relevancy block above). Explicit empty list when
        # nothing was skipped — consumers never infer skips from absence.
        "skipped_metrics": skipped_metrics,
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
    # NaN-safe write: sanitize THEN dump with allow_nan=False, so any future
    # non-finite leak fails loudly here instead of writing bare NaN tokens
    # that crash the rag-eval service's listing endpoints.
    summary = _sanitize_nonfinite(summary)
    out_json.write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    print(f"\n   wrote {out_json}")

    out_md.write_text(_render_markdown(summary))
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

    `floor = max(0, min(p50 − 1.5 × IQR, min(samples) − FLOOR_MARGIN))` —
    the classic formula plus the WARP-1407 containment clamp. Each
    per-run sample is that run's `metrics.<m>.mean` — each run counts as
    one data point of the metric's central tendency, percentiles across
    runs. Envelopes are computed per-metric over the runs that carry a
    FINITE value for it (see _mean_sample); each envelope's `n` records
    that honest sample count.

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

    def _mean_sample(stats: Any) -> float | None:
        """`stats["mean"]` as a finite float, else None (sample excluded).

        Tolerates three shapes seen in real runs directories: the metric
        absent from a run entirely (stats is None — e.g. answer_relevancy
        skipped on keyless local-judge runs), a pre-sanitizer results file
        carrying bare NaN tokens (json.loads parses those to float("nan")),
        and a post-sanitizer file carrying null. None of these may poison
        the quantiles — they just don't contribute a sample.
        """
        if not isinstance(stats, dict):
            return None
        v = stats.get("mean")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return float(v) if math.isfinite(float(v)) else None

    def envelope(samples: list[float]) -> dict[str, float | int]:
        s = pd.Series(samples)
        p50 = float(s.quantile(0.5))
        p95 = float(s.quantile(0.95))
        # IQR = Q3 - Q1; well-defined for n>=2, zero for n=1.
        iqr = float(s.quantile(0.75) - s.quantile(0.25)) if len(s) > 1 else 0.0
        floor = p50 - 1.5 * iqr
        # WARP-1407 containment clamp: bootstrap runs execute back-to-back
        # and are CORRELATED samples — their IQR can collapse to ~0, which
        # degenerates the floor to ≈p50, and the first independent-session
        # run then "fails" on ordinary judge variance (observed live: a
        # precision envelope with iqr 0.006 from five same-session runs vs
        # a 0.30–0.43 spread across sessions). An envelope must at minimum
        # contain every sample that produced it: never let the floor exceed
        # the lowest observed sample minus a small margin, and keep it
        # non-negative (metric means live in [0, 1]).
        floor = max(0.0, min(floor, min(samples) - FLOOR_MARGIN))
        # `n` = runs that contributed a finite sample for THIS metric — the
        # honest per-metric count (skipped metrics and NaN'd judge runs make
        # it diverge from the top-level n_runs). Additive next to the
        # floor/p50/p95/iqr schema the gate consumes.
        return {
            "floor": floor,
            "p50": p50,
            "p95": p95,
            "iqr": iqr,
            "n": len(samples),
        }

    envelopes: dict[str, dict[str, float | int]] = {}
    for m in sorted(metric_keys):
        samples = [
            s
            for r in runs
            if (s := _mean_sample(r.get("metrics", {}).get(m))) is not None
        ]
        if samples:
            envelopes[m] = envelope(samples)

    # Per-class envelopes (WARP-437 `metrics_by_class`). Classes missing
    # from a given run just don't contribute samples for that run.
    class_keys: set[str] = set()
    for r in runs:
        class_keys.update(r.get("metrics_by_class", {}).keys())

    envelopes_by_class: dict[str, dict[str, dict[str, float | int]]] = {}
    for cls in sorted(class_keys):
        per_metric: dict[str, dict[str, float | int]] = {}
        for m in sorted(metric_keys):
            samples = [
                s
                for r in runs
                if (
                    s := _mean_sample(
                        r.get("metrics_by_class", {}).get(cls, {}).get(m)
                    )
                )
                is not None
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
        "_threshold_formula": (
            "floor = max(0, min(p50 − 1.5 × IQR, min(sample means) − "
            f"{FLOOR_MARGIN})), computed over N runs (WARP-1407 containment "
            "clamp)"
        ),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Same NaN-safe write contract as run(): baselines.json is read by the
    # rag-eval service's strict (allow_nan=False) serializer, so it must
    # never carry bare NaN tokens either.
    summary = _sanitize_nonfinite(summary)
    out_path.write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
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

    try:
        return run(
            api_url=args.api_url,
            variant=args.variant,
            limit=args.limit,
            judge=args.judge,
            out_json=out_json,
            out_md=out_md,
            repo_root=repo_root,
        )
    except SearchUnavailable as e:
        # WARP-1860: exit non-zero and write NO results pair. run_once()
        # turns this into CalledProcessError, whose `.output` tail carries
        # this message into the durable failed record — so the run shows up
        # as failed-with-a-reason instead of a successful wall of zeros.
        print(f"\n!! retrieval unavailable: {e}", file=sys.stderr)
        print(f"!! auth posture: {_describe_auth_posture()}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
