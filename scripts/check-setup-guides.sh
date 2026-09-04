#!/usr/bin/env bash
#
# check-setup-guides.sh — WARP-2351.
#
# Fails when the customer-facing cloud/SaaS setup guides under
# docs/integrations/ stop being complete, stop being true, or stop resolving.
#
# WHY THIS EXISTS
# ---------------
# Every cloud connector under WARP-2214 depends on the customer creating a
# credential in a vendor console Warp Lab does not control and cannot script.
# The audience is an SMB *without an IT department*, so an undocumented or
# quietly-softened click-path is the connector being unusable — not a docs
# nit. Following the repo's standing convention (check-schema-drift.sh,
# check-agent-api-sync.mjs, build.mjs --check): anything that can silently
# diverge gets an explicit gate, not trust.
#
# The three silent divergences, and the check that closes each:
#
#   1. A new cloud provider ships with no guide.
#      -> COVERAGE. Every provider in CLOUD_PROVIDERS must have
#         docs/integrations/<id>.md, and SETUP.md's cloud index (§3.3) must
#         list exactly that set — checked in BOTH directions, so adding a
#         provider to one place and forgetting the other goes red.
#
#   2. A guide loses a required section, or a load-bearing fact gets softened
#      by a well-meaning copy pass or a merge.
#      -> SECTIONS + ORDER + FACT PINS. The six sections are the shape every
#         guide promises. The pins are the commercially load-bearing strings:
#         dollar amounts, country lists, key prefixes, the super-admin
#         requirement. They exist SPECIFICALLY so that editing the specifics
#         away cannot pass review silently.
#
#   3. A link rots.
#      -> LINKS. Every relative markdown link under docs/integrations/ is
#         resolved against the tree. Checking link *text* rather than the
#         resolved path would pass a near-miss like `stripe-setup.md`, which
#         is exactly the failure this is for.
#
#   3b. A link's PATH resolves but its #fragment does not.
#      -> FRAGMENTS. Every `file.md#anchor` target is resolved against the
#         target file's headings, using the same GitHub slug rule the
#         dashboard route uses to mint heading ids (shared fixture:
#         scripts/fixtures/heading-slug-cases.tsv). Path-only checking was
#         green for months over `SETUP.md` §8 on a file with seven sections
#         (WARP-2498).
#
#   4. A guide ships that the box cannot serve.
#      -> ROUTE. `/help/integrations/<id>` renders the guide from a bundled
#         `?raw` import (WARP-2490). The import list is hand-written — a
#         static import is the only kind a bundler can inline — so a new
#         guide can pass checks 1-3 and still be unreachable from the tile
#         and the connect wizard that link to it.
#
# WHERE THE FACTS COME FROM
# -------------------------
# CLOUD_PROVIDERS and the pins below are pinned to the per-vendor table in
# ADR-042 §2 (customer-supplied credentials), which is the single source of
# truth for credential shape, plan tier, cost and expiry. Do not edit a pin to
# make this script pass — if a vendor fact genuinely changed, change ADR-042
# and the guide first, then this script, in that order and in the same PR.
#
# CI
# --
# Runs as a step of ci.yml's `detect` job. `detect` is the one job that runs
# on EVERY pull request and every main push, and ci-summary requires it to
# succeed — so this reports under the required check with no new leg, no new
# matrix entry, no `paths:` widening and no new `pull_request:` trigger. A
# docs-only PR runs no other leg at all, which is precisely the PR this gate
# has to catch, so it cannot live inside a path-filtered suite.
#
# USAGE
# -----
#   scripts/check-setup-guides.sh
#
# Exit 0 when every check passes, 1 on any failure. Every failure names the
# offending provider or file and which check failed.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCS_DIR="docs/integrations"
SETUP_MD="$DOCS_DIR/SETUP.md"
SHARED_PAGE="$DOCS_DIR/credential-handling.md"

# The cloud/SaaS providers that must each have a customer setup guide.
# Source of truth: ADR-042 §2. Space-separated (bash 3.2 — macOS ships
# 3.2.57 and has no associative arrays; keep this script 3.2-compatible).
CLOUD_PROVIDERS="stripe hubspot mailchimp shopify xero atlassian"

# The six sections every vendor guide must carry, as exact H2 headings.
# Dropping any one of them is the mutation this list exists to catch.
REQUIRED_SECTIONS="## Plan prerequisite
## Cost
## Click-path
## Scopes and permissions
## Rotation and expiry
## Revocation"

fail=0
note() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; fail=1; }
ok()   { printf '\033[32m  OK\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# slugify <heading-text> — GitHub's heading-slug rule (WARP-2498).
#
# Byte-for-byte the same rule as `headingSlug()` in
# apps/web-dashboard/src/lib/integration-guides.ts, which gives the rendered
# guide pages their heading ids. If the two drift, this script starts passing
# links a browser cannot follow — so they are not trusted to agree, they are
# CHECKED against scripts/fixtures/heading-slug-cases.tsv below.
#
# ASCII classes (`a-z0-9_`), not `[:alnum:]`: JavaScript's `\w` is ASCII-only
# and `[:alnum:]` is locale-dependent, so the two would part company on the
# first accented heading. Each whitespace character becomes ONE hyphen — the
# em dash in "Track B — a cloud service" leaves two spaces behind, and the
# anchor really is `b--a`.
slugify() {
  # `printf '%s\n'`, not `%s`: BSD sed preserves the absence of a trailing
  # newline, so a newline-less slugify makes `... | while read; do slugify;
  # done` concatenate every heading into one line — which reads as "no heading
  # matched" and fails every anchor. Command substitution strips the newline
  # again for single-value callers, so this costs them nothing.
  printf '%s\n' "$1" \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | tr 'A-Z' 'a-z' \
    | sed 's/[^a-z0-9_[:space:]-]//g' \
    | sed 's/[[:space:]]/-/g'
}

# fact_pins <provider> — emits one literal string per line that MUST appear
# verbatim in that provider's guide.
#
# These are not style preferences. Each one is a commercial or contractual
# fact a customer acts on: what they will be charged, whether they can connect
# at all, which credential the box will refuse, and who has to create it.
#
# shellcheck disable=SC2016  # the '$105' / '$5 USD' pins are literal prices,
#                            # deliberately unexpanded.
fact_pins() {
  case "$1" in
    stripe)
      # The prefix contract is contractual, not stylistic (ADR-042 §4): the
      # box must refuse ^sk_. A guide that does not name both accepted
      # prefixes cannot explain the refusal the customer is about to hit.
      printf '%s\n' 'rk_live' 'rk_test' 'sk_live' '^rk_(live|test)_'
      ;;
    shopify)
      # The Grow-plan gate decides whether customer PII is reachable AT ALL.
      # Both prices, because the decision is the delta between them. The date
      # pins the removal of admin-created custom apps — a guide written from
      # pre-2026 memory describes a screen that no longer exists.
      printf '%s\n' 'Grow' '$105' '$39' 'client secret' '2026-01-01'
      ;;
    xero)
      # Availability is a pre-sale qualification gate, not a troubleshooting
      # entry: a customer outside these four countries cannot connect at all.
      # All three currencies verbatim (never converted), plus the
      # per-organisation multiplier that turns $5 into $20 for four entities.
      #
      # Deliberately NOT pinned: any connection-limit figure. Xero's own live
      # documentation gives three different numbers (5 / 25 / 50) and the
      # contradiction is unresolved — see the correction comment on WARP-2383.
      # ADR-042 makes no connection-limit claim and neither may the guide.
      printf '%s\n' 'AU, NZ, UK and US' '$10 AUD' '£5' '$5 USD' 'per organisation'
      ;;
    hubspot)
      # The private app dies if its creating super admin later loses that
      # role. Softening "must be a super admin" to "should ideally be an
      # admin" is the exact copy-pass mutation this pin blocks.
      printf '%s\n' 'super admin'
      ;;
    mailchimp)
      # The datacenter suffix selects the API host, so the key must be pasted
      # whole; and the key is full account access with no scope model, which
      # is the one place we cannot claim minimal access.
      printf '%s\n' '-us14' 'full account access'
      ;;
    atlassian)
      # Four facts a customer acts on, and every one of them is a way the
      # setup fails for a reason Droplet cannot fix (WARP-2316):
      #  - 365 days is a HARD stop with no grace period and no auto-renewal.
      #    It is the only connector on this list with an expiry the customer
      #    must diary, and softening it produces a silent outage a year later.
      #  - The Rovo MCP server toggle is an ORG ADMIN action in a console the
      #    person doing the setup often cannot open. Naming the exact screen
      #    is the difference between a one-minute ask and a support ticket.
      #  - The Free plan cannot connect at all — a pre-sale qualification
      #    gate, like Shopify's Grow plan and Xero's four countries.
      #  - The IP allowlist, not the domain allowlist, is the Atlassian
      #    control that governs this. Getting that backwards presents as a
      #    network timeout rather than as a permission error, which is why
      #    the distinction has to survive a copy pass.
      printf '%s\n' '365 days' 'Rovo MCP server' 'Free plan' 'IP allowlist'
      ;;
    *)
      : # no pins declared for this provider
      ;;
  esac
}

# --- 1. Coverage ------------------------------------------------------------
# Every cloud provider has a guide, and SETUP.md's index lists exactly the
# same set. Checked both ways so a one-sided edit cannot pass.

hdr "coverage — one guide per cloud provider"

if [ ! -f "$SETUP_MD" ]; then
  note "$SETUP_MD is missing — the cloud index lives there"
fi
if [ ! -f "$SHARED_PAGE" ]; then
  note "$SHARED_PAGE is missing — every vendor guide links to it"
fi

for provider in $CLOUD_PROVIDERS; do
  guide="$DOCS_DIR/$provider.md"
  if [ ! -f "$guide" ]; then
    note "provider '$provider' has no setup guide at $guide"
    continue
  fi
  ok "$provider -> $guide"

  # The index in SETUP.md must route the reader to it. Match the resolved
  # link target, not the vendor's name in prose.
  if [ -f "$SETUP_MD" ] && ! grep -qF "($provider.md)" "$SETUP_MD"; then
    note "provider '$provider' is not linked from $SETUP_MD (expected a relative link to $provider.md)"
  fi
done

# Reverse direction: a guide linked from SETUP.md that is not a declared
# cloud provider means CLOUD_PROVIDERS above went stale.
if [ -f "$SETUP_MD" ]; then
  linked=$(grep -oE '\(([a-z0-9-]+)\.md\)' "$SETUP_MD" \
    | tr -d '()' | sed 's/\.md$//' | sort -u)
  for target in $linked; do
    case " $CLOUD_PROVIDERS " in
      *" $target "*) continue ;;
    esac
    # Non-vendor pages SETUP.md legitimately links to.
    case "$target" in
      README|SETUP|ADD-A-PROVIDER|eaglesoft|export-drop|credential-handling) continue ;;
    esac
    note "$SETUP_MD links to '$target.md', which is not in CLOUD_PROVIDERS — add it there (and to ADR-042 §2) or drop the link"
  done
fi

# --- 2. Required sections, and the order the qualification gates need -------

hdr "sections — all six present in every guide"

for provider in $CLOUD_PROVIDERS; do
  guide="$DOCS_DIR/$provider.md"
  [ -f "$guide" ] || continue

  missing=""
  while IFS= read -r section; do
    [ -n "$section" ] || continue
    if ! grep -qxF "$section" "$guide"; then
      missing="$missing
    $section"
    fi
  done <<EOF
$REQUIRED_SECTIONS
EOF

  if [ -n "$missing" ]; then
    note "$guide is missing required section(s):$missing"
  else
    ok "$guide — six sections present"
  fi

  # A plan tier or a monthly charge discovered AFTER the click-path is a
  # wasted setup. WARP-2311 / WARP-2315 make the ordering an AC.
  prereq_line=$(grep -nxF '## Plan prerequisite' "$guide" | head -1 | cut -d: -f1 || true)
  cost_line=$(grep -nxF '## Cost' "$guide" | head -1 | cut -d: -f1 || true)
  path_line=$(grep -nxF '## Click-path' "$guide" | head -1 | cut -d: -f1 || true)
  if [ -n "$prereq_line" ] && [ -n "$cost_line" ] && [ -n "$path_line" ]; then
    if [ "$prereq_line" -ge "$path_line" ]; then
      note "$guide — '## Plan prerequisite' (line $prereq_line) must come BEFORE '## Click-path' (line $path_line)"
    fi
    if [ "$cost_line" -ge "$path_line" ]; then
      note "$guide — '## Cost' (line $cost_line) must come BEFORE '## Click-path' (line $path_line)"
    fi
  fi

  # Every guide links the one shared credential page rather than paraphrasing
  # it into five versions that drift (WARP-2307).
  if ! grep -qF "(credential-handling.md)" "$guide"; then
    note "$guide does not link credential-handling.md"
  fi

  # A dated sources line makes staleness visible instead of assumed. Vendor
  # consoles change without notice and three of these five changed in 2026.
  if ! grep -qE 'Sources checked [0-9]{4}-[0-9]{2}-[0-9]{2}' "$guide"; then
    note "$guide has no 'Sources checked YYYY-MM-DD' line"
  fi
done

# --- 3. Fact pins ----------------------------------------------------------
# The specifics a well-meaning copy pass would round off.

hdr "fact pins — the load-bearing specifics"

for provider in $CLOUD_PROVIDERS; do
  guide="$DOCS_DIR/$provider.md"
  [ -f "$guide" ] || continue

  pins=$(fact_pins "$provider")
  [ -n "$pins" ] || continue

  while IFS= read -r pin; do
    [ -n "$pin" ] || continue
    if grep -qF -- "$pin" "$guide"; then
      ok "$provider pins '$pin'"
    else
      note "$guide no longer states '$pin' — this fact is load-bearing; see ADR-042 §2 before changing it"
    fi
  done <<EOF
$pins
EOF
done

# --- 4. Link integrity -----------------------------------------------------
# Resolve every relative markdown link under docs/integrations/ against the
# tree. Text-only checking would pass a near-miss filename and is not enough.

hdr "slug rule — this script and the dashboard route agree"

# The fragment check below is only as good as `slugify`, and the dashboard's
# `headingSlug()` has to produce the SAME id or the anchors this script blesses
# will not exist in the rendered page. One fixture, two readers: the
# TypeScript side runs it in `integration-guides.test.ts`.
SLUG_FIXTURE="scripts/fixtures/heading-slug-cases.tsv"
if [ ! -f "$SLUG_FIXTURE" ]; then
  note "$SLUG_FIXTURE is missing — the slug rule is then unchecked on both sides"
else
  slug_cases=0
  while IFS="	" read -r heading expected; do
    case "$heading" in ""|"#"*) continue ;; esac
    [ -n "$expected" ] || continue
    actual=$(slugify "$heading")
    slug_cases=$((slug_cases + 1))
    if [ "$actual" != "$expected" ]; then
      note "slugify '$heading' -> '$actual', fixture expects '$expected'"
    fi
  done < "$SLUG_FIXTURE"
  ok "$slug_cases slug case(s) match $SLUG_FIXTURE"
fi

hdr "links — every relative link under $DOCS_DIR resolves"

link_count=0
anchor_count=0
for md in "$DOCS_DIR"/*.md; do
  [ -f "$md" ] || continue
  dir=$(dirname "$md")

  # Pull out ](target) pairs, drop absolute URLs, anchors and mailto.
  targets=$(grep -oE '\]\([^)]+\)' "$md" | sed 's/^](//; s/)$//' || true)
  for target in $targets; do
    case "$target" in
      http://*|https://*|mailto:*|"#"*) continue ;;
    esac
    # Strip a trailing #anchor — the file is what has to exist.
    path=${target%%#*}
    [ -n "$path" ] || continue
    link_count=$((link_count + 1))
    if [ ! -e "$dir/$path" ]; then
      note "$md links to '$target', which does not resolve (looked for $dir/$path)"
      continue
    fi

    # …and then the FRAGMENT, which this script never used to look at
    # (WARP-2498). `vendor-setup-template.md` cited `SETUP.md` §8 while
    # SETUP.md had seven sections, and every run was green over it: the file
    # existed, so the link "resolved". A dead fragment drops the reader at the
    # top of a 20,000-word page with no sign anything went wrong — and on the
    # box the same anchor is a real in-app link (WARP-2490), not just a
    # GitHub convenience.
    anchor=${target#*#}
    [ "$anchor" != "$target" ] || continue
    [ -n "$anchor" ] || continue
    anchor_count=$((anchor_count + 1))
    heading_slugs=$(grep -E '^#{1,6}[[:space:]]+' "$dir/$path" \
      | sed -E 's/^#{1,6}[[:space:]]+//' \
      | while IFS= read -r heading; do slugify "$heading"; done)
    if ! printf '%s\n' "$heading_slugs" | grep -Fxq "$anchor"; then
      note "$md links to '$target', but $path has no heading whose id is '#$anchor'"
    fi
  done
done
ok "checked $link_count relative link(s), $anchor_count of them with a #fragment"

# --- 5. The guide is REACHABLE from the box --------------------------------
#
# WARP-2490. A guide that exists in git but is not bundled into the dashboard
# is unreachable on the appliance: the tile and the connect wizard render a
# `setupGuideHref` and the owner lands on a 404. That is the same class of
# failure as a missing guide, and until this check existed nothing caught it —
# checks 1-4 all pass on a file no route serves.
#
# Two things must hold, and the second is the one that rots: the route exists,
# and every cloud guide is in the bundle's static import list. `?raw` imports
# are the only kind a bundler can inline, so the list is hand-written and will
# be forgotten. `integration-guides.test.ts` asserts the reverse direction
# (bundle == directory) at vitest time; this is the cheap docs-PR-time half,
# and `detect` is the one job that runs on every PR.

hdr "route — every cloud guide is bundled into the dashboard"

GUIDE_ROUTE="apps/web-dashboard/src/app/help/integrations/[provider]/page.tsx"
GUIDE_BUNDLE="apps/web-dashboard/src/lib/integration-guides.ts"

if [ ! -f "$GUIDE_ROUTE" ]; then
  note "the guide route is missing ($GUIDE_ROUTE) — every setupGuideHref is a 404"
else
  ok "route present ($GUIDE_ROUTE)"
fi

if [ ! -f "$GUIDE_BUNDLE" ]; then
  note "the guide bundle is missing ($GUIDE_BUNDLE)"
else
  for provider in $CLOUD_PROVIDERS; do
    if grep -q "docs/integrations/$provider.md?raw" "$GUIDE_BUNDLE"; then
      ok "$provider is bundled, reachable at /help/integrations/$provider"
    else
      note "$provider has a guide but is not imported in $GUIDE_BUNDLE — the link would 404 on the box"
    fi
  done
fi

# --- Verdict ---------------------------------------------------------------

printf '\n'
if [ "$fail" -ne 0 ]; then
  printf '\033[31mcheck-setup-guides: FAILED\033[0m — see the FAIL lines above.\n' >&2
  exit 1
fi
provider_count=0
for provider in $CLOUD_PROVIDERS; do
  provider_count=$((provider_count + 1))
done
printf '\033[32mcheck-setup-guides: OK\033[0m — %s provider guide(s), six sections each, pins intact, %s links resolve (%s with a #fragment).\n' \
  "$provider_count" "$link_count" "$anchor_count"
