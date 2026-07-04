# Make the FIPS build-time gate required-to-merge (WARP-316)

The build-time FIPS gate already runs in **`.github/workflows/docker-build.yml`**:
every shipped image's Dockerfile `RUN`s `docker/fips/install-fips-provider.sh`,
which runs the module KATs (`openssl fipsinstall`), a positive probe (provider
active @ 3.0.9, base+fips both active, SHA-256 works), and a negative probe
(MD5 rejected). Any failure `exit 1`s the docker build, failing the matrix, which
fails the stable fan-in check **`docker-build ok`** (job id `docker-build-ok`).

What's missing is making that check **required to merge**. Branch protection is
owned by **WARP-968/969** — this repo/PR does **NOT** mutate it. Below are the
exact commands for the branch-protection owner to run.

> **The check name to require is the string `docker-build ok`** — the
> `docker-build-ok` job's `name:`, NOT the job id. Branch protection matches the
> check-run *name*.

## Option A — repository ruleset (modern GitHub, preferred)

The ruleset JSON is checked in at
[`fips-ci-gate-required.ruleset.json`](fips-ci-gate-required.ruleset.json):

```jsonc
{
  "name": "require-docker-build-fips-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "docker-build ok" } ]
      } }
  ]
}
```

Apply it:

```bash
gh api -X POST repos/DropletByWarpLab/droplet-onboard-services/rulesets \
  --input docs/security/fips-ci-gate-required.ruleset.json

# verify it landed:
gh api repos/DropletByWarpLab/droplet-onboard-services/rulesets --jq '.[].name'
```

`strict_required_status_checks_policy: true` requires branches to be up to date
with `main` before merging (the check must have run against the latest base).
Drop it to `false` if that friction isn't wanted.

## Option B — classic branch protection (if the repo still uses it)

```bash
gh api -X PATCH \
  repos/DropletByWarpLab/droplet-onboard-services/branches/main/protection/required_status_checks \
  -f 'checks[][context]=docker-build ok'
```

## Notes

- Do **not** require the matrix `build ${{ matrix.image }}` jobs directly — the
  image set is dynamic (path-filtered), so a check that doesn't run on a given PR
  would block it forever. `docker-build ok` is the stable fan-in that is always
  present and green iff `detect` + all triggered builds succeed.
- The sabotage proof (`tests/fips-sabotage.test.sh`, run by the `fips-sabotage`
  job in `test-fips.yml`) demonstrates the gate is not a no-op; it is a
  *capability* proof and is intentionally NOT part of this required check
  (keeping the required set to the one stable fan-in).
