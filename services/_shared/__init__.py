# Shared Python helpers, copied into each Python service image at build
# time. We don't ship an internal PyPI; each Dockerfile does a `COPY
# services/_shared/fips_selftest.py /app/_shared/fips_selftest.py`.
