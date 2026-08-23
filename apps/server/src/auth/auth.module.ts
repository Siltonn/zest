import {
  All,
  Controller,
  Global,
  Inject,
  Module,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Database } from "@zest/db";
import { DATABASE } from "../infra/database.module.js";
import { AUTH, createAuth, type Auth } from "./auth.js";
import { McpAuthGuard } from "./mcp-auth.guard.js";
import { WorkspaceGuard } from "./workspace.guard.js";

/**
 * Better Auth ships a framework-agnostic fetch handler, so the whole
 * integration is one passthrough route.
 *
 * There used to be a consent gate here, redirecting `/mcp/authorize` through
 * the approval page by hand, because the old plugin issued a code the moment a
 * session existed. The OAuth provider behind `@better-auth/mcp` requires
 * consent by default — it checks `oauth_consents` and sends the browser to
 * `consentPage` when there is no matching grant — so the gate is the library's
 * job now.
 */
@Controller("api/auth")
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  @All("*path")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);

    // Express headers can repeat; flatten to the shape fetch expects.
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, value);
    }

    // Express already parsed the body, so it is re-encoded to match the
    // declared content type. JSON alone used to be enough; the OAuth token
    // endpoint (RFC 6749 §4.1.3) is form-encoded, and serializing a form as
    // JSON while the header still says urlencoded made Better Auth parse
    // garbage and refuse every token exchange.
    let body: string | undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      const contentType = req.headers["content-type"] ?? "";
      body =
        typeof req.body === "string"
          ? req.body
          : contentType.includes("application/x-www-form-urlencoded")
            ? new URLSearchParams(req.body as Record<string, string>).toString()
            : JSON.stringify(req.body ?? {});
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body,
    });

    const response = await this.auth.handler(request);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(await response.text());
  }
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Database) => createAuth(db),
      inject: [DATABASE],
    },
    WorkspaceGuard,
    McpAuthGuard,
  ],
  exports: [AUTH, WorkspaceGuard, McpAuthGuard],
})
export class AuthModule {}
