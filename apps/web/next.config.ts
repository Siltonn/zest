import type { NextConfig } from "next";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:4000";

const config: NextConfig = {
  // Self-host target: a plain `node server.js` in a container, no platform
  // specific features anywhere in this app.
  output: "standalone",
  async rewrites() {
    // Same-origin proxy to the NestJS backend, so the browser never deals with
    // CORS and cookies ride along on API calls.
    return [
      { source: "/api/v1/:path*", destination: `${serverUrl}/api/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${serverUrl}/api/auth/:path*` },
      { source: "/events", destination: `${serverUrl}/events` },
    ];
  },
};

export default config;
