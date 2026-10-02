# Dev set (not built yet)

The place for cases grown from real box conversations, kept apart from
`../regression/` (the frozen 66) so the baseline stays comparable while this
set changes freely.

- Same case schema as `build_cases.py` (see its docstring); one `*.jsonl` per
  source or theme. Run with `run.mts --cases cases/dev/<file>.jsonl`.
- Anonymise before committing: no customer names, emails, file paths, IDs or
  message text copied verbatim. Rewrite into the fixture world in `world.mts`
  (its contacts, docs and work items), so the case still runs.
- Not in the selftest or CI; scored on the bench box like the regression set.
- Moving a case into `regression/` changes the baseline, so it is its own
  deliberate PR (and `build_cases.py`'s count of 66 changes with it).
