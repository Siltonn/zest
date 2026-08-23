import { Controller, Get, Header, Inject } from "@nestjs/common";
import { AUTH, type Auth } from "../auth/auth.js";

/**
 * OAuth discovery documents, at the root where clients look for them.
 *
 * An MCP client that gets a 401 from `/mcp` follows the `WWW-Authenticate`
 * header to the protected-resource metadata (RFC 9728), reads which
 * authorization server backs it, fetches that server's metadata (RFC 8414),
 * registers itself (RFC 7591), and runs the code + PKCE flow — no manual
 * client configuration anywhere. Better Auth's `mcp` plugin generates the
 * documents; these routes put them at the well-known paths, since the plugin
 * itself lives under `/api/auth`.
 *
 * The path-suffixed variants (`…/mcp`) exist because RFC 9728 tells a client
 * to derive the metadata URL by inserting the well-known segment into the
 * resource URL — for a resource at `/mcp`, that is
 * `/.well-known/oauth-protected-resource/mcp`. Same document either way.
 *
 * These are public by design: metadata is discovery, not data.
 */
@Controller(".well-known")
export class WellKnownController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  @Get(["oauth-protected-resource", "oauth-protected-resource/mcp"])
  @Header("Cache-Control", "public, max-age=300")
  async protectedResource() {
    return this.auth.api.getMCPProtectedResource();
  }

  @Get([
    "oauth-authorization-server",
    "oauth-authorization-server/mcp",
    // Some clients probe OpenID discovery before OAuth discovery; the document
    // is a superset of what they need, so serve it there too.
    "openid-configuration",
  ])
  @Header("Cache-Control", "public, max-age=300")
  async authorizationServer() {
    return this.auth.api.getMcpOAuthConfig();
  }
}
