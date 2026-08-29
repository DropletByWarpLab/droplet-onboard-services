# WARP-2480 fixture — the `#` half of the comment-only rule. Every forbidden
# mention below is prose on a `#`-prefixed line, so the lint must drop them all
# from the candidate set before the escape-comment check.
#
# Expected: zero violations, and no `fips:allowed:` escape in this file.
#
#     digest = hashlib.md5(payload)          # what we deliberately do NOT do
#     digest = hashlib.new("md5", payload)   # nor this spelling
import hashlib


def fingerprint(payload: bytes) -> str:
    #   indented `#` prefix: hashlib.md5( raises on a FIPS box, so we use
    #   SHA-256, which the validated provider approves.
    return hashlib.sha256(payload).hexdigest()
