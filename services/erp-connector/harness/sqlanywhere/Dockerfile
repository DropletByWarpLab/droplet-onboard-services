# =============================================================================
# WARP-1106 — SQL Anywhere 17 mock image (TEMPLATE — supply SAP binaries)
# =============================================================================
# SQL Anywhere is proprietary; its binaries cannot be redistributed here. Get
# the free **SQL Anywhere 17 Developer Edition** for Linux x86_64 from SAP
# (account-gated download), place the tarball next to this Dockerfile as
# `sqla17-linux-x86_64.tar.gz`, then `docker compose build`.
#
# x86_64 ONLY — SAP ships no aarch64 client/engine (research §5).
FROM debian:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libaio1 unixodbc bash ca-certificates && rm -rf /var/lib/apt/lists/*

# --- Install SQL Anywhere from the SAP tarball you supply --------------------
# The Developer Edition ships an interactive/silent installer. The exact layout
# varies by download; adjust the extract + silent-install invocation to match.
COPY sqla17-linux-x86_64.tar.gz /tmp/sqla.tgz
RUN mkdir -p /opt/sqla-src && tar xzf /tmp/sqla.tgz -C /opt/sqla-src --strip-components=1 && \
    # TODO(adjust to your download): run the silent installer, e.g.
    #   /opt/sqla-src/setup -silent -install sqlany17 -installdir /opt/sqlanywhere17 ...
    #   and accept the SAP license per your organization's terms.
    rm -f /tmp/sqla.tgz

ENV SQLANY17=/opt/sqlanywhere17
ENV PATH="$SQLANY17/bin64:$PATH" \
    LD_LIBRARY_PATH="$SQLANY17/lib64"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 2638
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
