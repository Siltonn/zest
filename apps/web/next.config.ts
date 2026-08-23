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
      // Pomelo's API is proxied under /api/pomelo because /pomelo itself is a
      // page in this app — the network's own feed.
      { source: "/api/pomelo/:path*", destination: `${serverUrl}/pomelo/:path*` },
      // Uploaded images too. Without this the browser is sent straight at the
      // server for media and nothing else, so a deployment that keeps the
      // server internal — the natural shape, since everything above is proxied
      // — renders every picture as a broken link.
      { source: "/media/:path*", destination: `${serverUrl}/media/:path*` },
      // The MCP endpoint and the OAuth discovery documents MCP clients read.
      // Claude connects to <public-url>/mcp; a 401 there points at
      // /.well-known/oauth-protected-resource, which names the authorization
      // server, whose endpoints live under /api/auth (proxied above). Keeping
      // the server internal therefore requires all three to ride this proxy.
      { source: "/mcp", destination: `${serverUrl}/mcp` },
      { source: "/.well-known/:path*", destination: `${serverUrl}/.well-known/:path*` },
    ];
  },
};

export default config;
