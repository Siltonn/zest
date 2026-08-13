import { Controller, Inject, Req, Res, Sse, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Redis } from "ioredis";
import { Observable } from "rxjs";
import { channelFor, parseEvent } from "@zest/core";
import { REDIS_SUB } from "../infra/redis.module.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

/**
 * The live channel.
 *
 * Work happens in the worker; results arrive here. Redis pub/sub carries domain
 * events across the process boundary, and this endpoint relays the ones
 * belonging to the caller's workspace. It is what makes the Pomelo feed light
 * up and the charts move while a fast-forward is running, instead of the user
 * having to refresh and wonder whether anything happened.
 */
@Controller()
@UseGuards(WorkspaceGuard)
export class EventsController {
  constructor(@Inject(REDIS_SUB) private readonly redis: Redis) {}

  @Sse("events")
  stream(@Req() req: AuthedRequest, @Res() res: Response): Observable<MessageEvent> {
    const channel = channelFor(req.workspaceId);

    return new Observable((subscriber) => {
      // Each connection gets its own subscriber: a client in subscribe mode
      // cannot issue other commands, so sharing one would break everything else.
      const connection = this.redis.duplicate();

      void connection.subscribe(channel).catch((error) => subscriber.error(error));

      connection.on("message", (_channel: string, raw: string) => {
        const event = parseEvent(raw);
        if (event) subscriber.next({ data: event } as MessageEvent);
      });

      // Some proxies drop an idle stream; a periodic comment keeps it open.
      const heartbeat = setInterval(() => {
        subscriber.next({ data: { type: "ping" } } as MessageEvent);
      }, 25_000);

      return () => {
        clearInterval(heartbeat);
        void connection.quit();
      };
    });
  }
}
