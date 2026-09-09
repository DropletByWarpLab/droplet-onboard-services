const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@droplet/auth-policy"],
  // Monorepo: tell Next where the workspace root is so the standalone
  // file-trace walks up to the hoisted node_modules instead of stopping
  // at apps/web-dashboard. Top-level since Next 15 (it lived under
  // `experimental` in 14.2; Next 15 ignores unknown experimental keys, so
  // leaving it there would silently flatten the standalone layout that
  // apps/web-dashboard/Dockerfile's COPY paths depend on).
  outputFileTracingRoot: path.join(__dirname, "../../"),
  webpack: (config) => {
    // `@droplet/auth-policy` is authored for NodeNext (the orchestrator
    // consumes it), so its barrel uses explicit `.js` import extensions
    // (`./password.js`, `./userid.js`, …). vitest/tsx resolve those to the
    // `.ts` sources natively, but `next build`'s webpack does not and fails
    // with "Can't resolve './password.zod.js'". Map `.js` → `.ts`/`.tsx`
    // first so the transpiled package resolves. (transpilePackages above
    // tells Next to compile the package's TS sources at all.)
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    // WARP-2490 — `import guide from "…/stripe.md?raw"` returns the file's
    // TEXT, inlined into the bundle at build time.
    //
    // `?raw` rather than a bare `.md` rule because vitest (vite) supports
    // that query natively, so ONE import specifier works under both
    // bundlers. A bare `.md` rule would need a matching vite plugin, i.e. a
    // second place to keep in agreement.
    //
    // This is what keeps the customer setup guides readable on a box with no
    // internet path to us: the markdown ships inside the JS, so the page
    // prerenders static with no runtime filesystem read and nothing to fetch.
    config.module.rules.push({
      resourceQuery: /^\?raw$/,
      type: "asset/source",
    });
    return config;
  },
  async rewrites() {
    // In dev mode (outside Docker), proxy API calls to local services.
    // Docker dev (docker/docker-compose.dev.yml) sets the *_INTERNAL_URL
    // envs so the Next.js server-side rewrite resolves to the orchestrator
    // container by service name instead of localhost (which would point at
    // the dashboard container itself).
    if (process.env.NODE_ENV === "development") {
      const orchestratorUrl =
        process.env.ORCHESTRATOR_INTERNAL_URL || "http://localhost:3000";
      const aiGatewayUrl =
        process.env.AI_GATEWAY_INTERNAL_URL || "http://localhost:8000";
      return [
        {
          source: "/api/:path*",
          destination: `${orchestratorUrl}/api/:path*`,
        },
        {
          source: "/ai/:path*",
          destination: `${aiGatewayUrl}/ai/:path*`,
        },
      ];
    }
    return [];
  },
};

module.exports = nextConfig;
