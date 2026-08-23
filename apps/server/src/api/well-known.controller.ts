import { Controller, Get, Header, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AUTH, type Auth } from "../auth/auth.js";

/**
 * OAuth discovery documents, at the root where clients look for them.
 *
 * An MCP client that gets a 401 from `/mcp` follows the `WWW-Authenticate`
 * header to the protected-resource metadata (RFC 9728), reads which
 * authorization server backs it, fetches that server's metadata (RFC 8414),
 * registers itself (RFC 7591), and runs the code + PKCE flow — no manual
 * client configuration anywhere. Better Auth generates both documents; these
 * routes put them where clients probe, since the plugin serves them relative
 * to its own base path under `/api/auth`.
 *
 * The path-suffixed variants exist because RFC 8414 and RFC 9728 tell a client
 * to build the metadata URL by inserting the well-known segment between the
 * host and the path — for a resource at `/mcp` that is
 * `/.well-known/oauth-protected-resource/mcp`, and for an issuer at
 * `/api/auth` it is `/.well-known/oauth-authorization-server/api/auth`. Same
 * document at every spelling.
 *
 * These are public by design: metadata is discovery, not data. They also carry
 * an open CORS header, because a client may fetch them from a browser on some
 * other origin, and the server's normal CORS policy admits only the web app.
 */
@Controller(".well-known")
export class WellKnownController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  /**
   * Protected-resource metadata has no `auth.api` method — the MCP plugin
   * serves it from a request hook that matches the root path — so this hands
   * the request to the auth handler unchanged and returns what comes back.
   */
  @Get(["oauth-protected-resource", "oauth-protected-resource/mcp"])
  async protectedResource(@Req() req: Request, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const response = await this.auth.handler(new Request(url, { method: "GET" }));
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    allowAnyOrigin(res);
    res.send(await response.text());
  }

  @Get([
    "oauth-authorization-server",
    "oauth-authorization-server/mcp",
    "oauth-authorization-server/api/auth",
  ])
  @Header("Cache-Control", "public, max-age=300")
  @Header("Access-Control-Allow-Origin", "*")
  async authorizationServer() {
    return this.auth.api.getOAuthServerConfig();
  }

  /** Some clients probe OpenID discovery before OAuth discovery. */
  @Get("openid-configuration")
  @Header("Cache-Control", "public, max-age=300")
  @Header("Access-Control-Allow-Origin", "*")
  async openIdConfiguration() {
    return this.auth.api.getOpenIdConfig();
  }
}

function allowAnyOrigin(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
}
