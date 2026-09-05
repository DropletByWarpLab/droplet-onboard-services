# Extraction eval — the canary that gates auto mode

WARP-2732, ADR-048.

## What this is

`AutoFilingSetting` carries a CHECK constraint:

```sql
CHECK ("mode" <> 'auto' OR ("canaryPassedAt" IS NOT NULL AND "canaryModel" IS NOT NULL))
```

Nothing in this repo can set those two columns except a passing run of this
suite. So auto mode is not gated by a promise, a review comment or a ticket
checkbox — it is gated by a database constraint whose only key is a
measurement taken on the box's own model.

## Why it is split in two

| file | runs where | proves |
|---|---|---|
| `score.py` + `test_score.py` | **CI, every PR** | the scorer's arithmetic, and that the goldens match the corpus |
| `extraction_runner.py` | **a box, by hand** | what the filing worker actually wrote |

No GitHub Actions lane can run a language model. `rag-tests.yml` is
`workflow_dispatch`-only, and its own e2e test states that the inference host
"is unreachable on a CI runner / a developer laptop".

That is not a gap to be papered over. A mocked canary that ran green in Actions
would be worse than none, because it would look like the gate had been
satisfied. So CI proves the **scorer** and a box proves the **extractor**, and
neither pretends to be the other.

> PR #2005 set itself the same unrun condition — a DMR grammar canary — and it
> has never been run. `baselines.json` here is deliberately empty rather than
> pre-filled with plausible numbers, so "never measured" is visible rather than
> disguised.

## The corpus

Twelve fixtures, all `[AUTHORED]`: each document was written to contain exactly
what its golden claims, so there is no gap between the corpus and the answer
key. `test_score.py` asserts that agreement on every PR.

| | count | what they are |
|---|---|---|
| business | 7 | invoice, quote, contract, engagement letter, three `.eml` |
| PHI decoys | 3 | a treatment note, a referral letter, an insurance claim |
| near-duplicates | 2 | one supplier, two spellings, one domain |

The decoys are written to be *genuinely clinical* rather than business
documents with a keyword sprinkled on them — a decoy that only trips the regex
proves the regex, not the design. `p03-insurance-claim` is the trap: it looks
exactly like an invoice, with line items and a total. A run that files it has
passed every business metric and failed the only one that matters.

The near-duplicate pair must produce **exactly one** customer. Two is the
duplicate the matcher exists to prevent; **zero is the matcher refusing a real
new customer**, which is the failure that looks like success on a
duplicate-detection metric.

Every hostname is under RFC 2606 `.example`. Not decoration: `egress-gate`
reads a value-shaped hostname anywhere in the repo as an unregistered outbound
destination.

## The floors are numbers, not an envelope

| metric | floor |
|---|---|
| company name exact | ≥ 0.90 |
| domain exact | ≥ 0.90 |
| money total exact (minor units, string compare) | ≥ 0.90 |
| JSON parse rate | ≥ 0.90 |
| duplicate pair | exactly 1 create |
| **PHI false negatives** | **0 — not a rate** |

The RAGAS suite next door derives floors as `p50 − 1.5·IQR`, and
`tests/retrieval-eval/ragas/baselines.json` records what that produces:

```json
"factual_correctness": { "floor": 0.0, "p50": 0.0, "iqr": 0.0, "n": 8 }
```

Eight runs, every one scoring zero, and the envelope pronounced a floor of zero
that every future zero clears. **A relative band cannot tell "stable and good"
from "stable and broken".** Anything recorded in `baselines.json` here may only
ever *raise* a floor.

## The breakers

Checked **before** the floors, because they are the states in which the floors
are meaningless:

- **zero proposals over the business corpus** — a run that extracted nothing
  has no wrong answers and would clear every floor. This is what a blanked
  service token (WARP-1860, fifteen green all-zero nightly runs) and one wrong
  DMR port (WARP-1870, every score meaningless, every run reporting success)
  both look like.
- **an empty corpus** — nothing seeded, nothing scored, nothing to say.
- **no PHI fixtures collected** — every PHI assertion is `count == 0`, which is
  trivially true over an empty list. A corpus that lost its decoys would
  otherwise report the strongest possible clean bill of health.

## Running it

On a bench box with `COMPOSE_PROFILES=…,eval`:

```bash
./scripts/seed-filing-fixtures.sh          # NC user, files:scan, wait for both stages
docker exec $(docker ps --format '{{.Names}}' | grep -m1 rag-eval) \
  python main.py run-once --suite extraction
```

Or through the orchestrator, which is **not** production-gated (unlike
`admin-retrieval-eval`, whose `NODE_ENV === "production"` 404 would make this
canary unreachable on every real appliance):

```
POST /api/admin/rag-eval/run-extraction     # owner/admin
```

**Target model: `gpt-oss:20b` on DMR** — what the bench box actually serves
(decision D11). GLM-4.7-Flash is the upgrade shortlist, not what is installed;
tuning prompts against a model no box runs proves nothing. When the model
changes, the canary re-runs and the floors are re-measured before `auto` is
offered again.

### Promoting a baseline

At least **three independent sessions**, not three back-to-back runs.
Correlated samples collapse the envelope, which is how the 0.0 floor happened.

### If everything reads `out_of_scope`

The folder allow-list does not include the seeded folder. That is filing
working correctly — widen the list before reading anything into the verdict.

### If nothing indexes at all

Check `ai.embedding.corpusModel` first. A box upgraded without
`scripts/rag-re-embed.sh` lands every new file `failed` **at the indexer**,
before filing ever sees it (WARP-2196), and filing then reports itself
perfectly healthy because it has nothing to do.
