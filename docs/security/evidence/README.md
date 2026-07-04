# Encryption-verification evidence bundles (WARP-966)

Evidence bundles produced by `scripts/host/droplet-verify-encryption.sh` live
**on-box** under `/var/lib/droplet/verify/<UTC-timestamp>/`. They are **never
committed** to this repository — they contain host-specific detail and raw packet
captures.

## Bundle layout

```
report.json          machine-readable evidence (schema droplet-encryption-evidence/v1)
report.md            human-readable acceptance evidence
evidence/<check>/…   raw captures per check (luksDump excerpts, psql stderr,
                     s_client transcripts, mount maps, capture.pcap, …)
manifest.sha256      sha256 of every bundle file (sorted, stable)
manifest.sig         ECDSA-P256-SHA256 over manifest.sha256 (device-identity TPM)
device-id-cert.pem   verifier cert (copied from /var/lib/droplet/tpm/)
```

## Hash chain

Three nested links make each bundle tamper-evident:

1. Each check's evidence files are hashed into `report.json` (`evidence_sha256`).
2. `manifest.sha256` covers **every** bundle file (including `report.json`).
3. `manifest.sig` signs `manifest.sha256` (the signature is necessarily outside
   the manifest it signs).

Across time, `report.json` records the **previous run's** manifest hash
(`prev_manifest_sha256`, `"genesis"` on the first run), so successive runs form a
chain — the progression from all-FAIL to all-PASS as the encryption tickets land
is itself acceptance evidence.

## What gets linked from Jira

Attach to **WARP-966** and link from epic **WARP-957**:

- `report.md` — the human-readable summary + release-blocker list
- `report.json` — the machine-readable record
- `manifest.sha256`, `manifest.sig`, `device-id-cert.pem` — the signature set

The **pcap (`evidence/transit.pcap.canary/capture.pcap`) stays on-box** unless a
specific finding needs it. `report.json` records only secret variable *names* and
match counts, never values — no secret ever enters the report.

## Retention

Bundles are small (minus the pcap) and are **kept** — the chain is the point.
Automatic pruning is explicitly out of scope; if space is tight, delete the
`capture.pcap` inside old bundles first (it is the only large artifact) rather
than removing whole bundles and breaking the chain.
