/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    // In dev mode (outside Docker), proxy API calls to local services
    if (process.env.NODE_ENV === "development") {
      return [
        {
          source: "/api/:path*",
          destination: "http://localhost:3000/api/:path*",
        },
        {
          source: "/ai/:path*",
          destination: "http://localhost:8000/ai/:path*",
        },
      ];
    }
    return [];
  },
};

module.exports = nextConfig;
