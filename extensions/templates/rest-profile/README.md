# rest-profile

A **connector draft**, not an extension (WARP-2899, ADR-056 §5.2). It drafts an
ADR-046 REST vendor profile, its setup guide, its egress entry and its ADR-042
rows for Warp Lab to review. Nothing on this box loads a draft or dials the
vendor: the draft is data in the store, exported by an owner, and becomes a
connector only through a Warp Lab pull request.

## For the run

The sandbox has no network. Every vendor fact (host, header, paths, plan, cost,
scopes, expiry) comes from the person's goal. A fact nobody has checked against
the vendor's own documentation stays empty, and renders as `TODO(verify)`.

1. Fill **one file**, `connector-draft.json`:
   - `provider` — the lowercase id (`acme-crm`); `displayName` — how people name it.
   - `baseUrl` — either `{ "kind": "static", "origin": ... }` with `https`, two
     slashes and the API host and nothing else; or, for a host that differs per
     customer account, `{ "kind": "dynamic", "configField": "companyDomain",
     "allowedSuffixes": [".vendor.example"], "allowedHosts": [],
     "hostShape": "the customer's own subdomain under the vendor's domain" }`.
     A dynamic draft carries **no URL anywhere**: describe the host in words.
   - `auth` — the literal header name and value, with `{{token}}` where the
     credential goes (`"Bearer {{token}}"`, or just `"{{token}}"`).
   - `probePath` — the cheapest authenticated read, e.g. `/v1/me`.
   - `datasets` — each maps vendor fields onto one canonical dataset's columns
     (`vocabulary.json` lists them; the required ones must be mapped).
   - `egress`, `credential`, `guide` — prose for the review. Leave unknowns empty.
2. `npm run build` — renders the draft's files, or prints what is wrong.
3. `npm test` — checks the draft and the rendered files agree.
4. `workspace_propose` — tags the draft. No extension manifest is written.
   It makes the same checks as `npm test` and refuses while any fails. Edit
   `connector-draft.json`, never a rendered file: a profile that is not what
   `npm run build` wrote, or that dials a host the draft does not name, is
   refused.

## For the owner

Export the workspace from the Workshop (owner or admin): a git bundle holding
the `work` branch and the proposal tag. On a machine with the repo:

```
git fetch <file>.bundle work:draft/<provider>
```

`DRAFT-CHECKLIST.md` lists what the pull request still needs.
