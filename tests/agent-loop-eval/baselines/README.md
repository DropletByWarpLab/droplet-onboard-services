# Baselines

One file per bench-box run (WARP-3899): the `evaluate.py` **summary** as JSON, no
per-case rows, about 2 KB. `bench-box.sh` writes it with `--baseline-out`; commit
it by hand after a run you want to compare against.

- Name: `<UTC date>-<label>-<sha7>.json`. The label is the one given to
  `bench-box.sh`, the sha is the checkout's commit (`unknown` for a `git archive`
  checkout).
- Raw runs (`runs/*.jsonl`, `runs/history.jsonl`) never go here: they are large
  and box-local.
- A file carries pass^k, pass rate and pass^k with Wilson 95% intervals (overall
  and per category), metric p50/p95, label counts and `fails_excluding_harness`.
- Comparing two runs needs the raw files, not these: `evaluate.py --compare A.jsonl
  B.jsonl`. A baseline is the record of what a run scored, and the input a future
  promotion gate (stage to main) will read.
