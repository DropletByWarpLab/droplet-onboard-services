# =============================================================================
# Dummy Eaglesoft REST API box — test harness image
# =============================================================================
#
# A synthetic stand-in for the ASP.NET Web-API-2 service a real Eaglesoft box
# serves on HTTPS :9888. Runs the same server module the in-process test suite
# drives (`mock-server.mjs`), so what CI proves is what you get when you point a
# connector, a curl, or the orchestrator at this container.
#
# ⚠ TEST HARNESS ONLY. Never add this to docker/docker-compose.yml. It accepts
# dev credentials and exposes a /__control/* plane that makes it fail on demand.
#
# Node only — no SAP dependency, no license gate, and it builds on arm64 as
# happily as on x86_64 (unlike the direct-SQL track, which has no aarch64 SAP
# client at all).
FROM node:20-alpine

# openssl: the harness mints its own private CA at start-up so TLS verification
# can stay ON (Node has no X.509 signing API). curl: the HEALTHCHECK below.
RUN apk add --no-cache openssl curl

WORKDIR /harness

# The server is dependency-free (node: builtins only), so there is nothing to
# npm-install — copy the four modules it needs and run.
COPY mock-server.mjs fixture.mjs certs.mjs main.mjs ./

# Reachable from other containers on the harness network (the image default;
# the server module itself still defaults to loopback for in-process use).
ENV MOCK_ES_BIND=0.0.0.0 \
    MOCK_ES_PORT=9888

# Generated TLS material lives here. Mount it to read the CA cert out — the
# connector needs it to build its trusting dispatcher.
RUN mkdir -p /harness/.certs && chown -R node:node /harness
USER node

EXPOSE 9888

# /help is unauthenticated (it is the discovery page), so it doubles as the
# liveness probe. -k because the cert chains to the harness's own private CA.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsk https://127.0.0.1:9888/help > /dev/null || exit 1

CMD ["node", "main.mjs"]
