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
import { WorkspaceGuard } from "./workspace.guard.js";

/**
 * Better Auth ships a framework-agnostic fetch handler, so the whole
 * integration is one passthrough route.
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

    const request = new Request(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body ?? {}),
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
  ],
  exports: [AUTH, WorkspaceGuard],
})
export class AuthModule {}
