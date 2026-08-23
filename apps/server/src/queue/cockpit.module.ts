import { Module } from "@nestjs/common";
import type { AuthContext, AuthResult } from "bullmq-cockpit";
import { BullMQCockpitModule } from "bullmq-cockpit/nestjs";
import { AUTH, type Auth } from "../auth/auth.js";
import { cockpitReadonly, loadEnv } from "../config.js";
import { ALL_QUEUES } from "./queue.constants.js";
import { redisConnection } from "./queue.module.js";

/**
 * The queue dashboard at /admin/queues.
 *
 * Every unit of real work in Zest is a job, so this is where you find out why
 * a post did not publish — which beats reading logs, and is the first thing to
 * check when the loop appears stuck. On top of the job list it draws the
 * signals you actually page on: throughput, error rate, queue wait, and which
 * queues have no worker attached.
 *
 * Registered in every mode. A worker-only process has no API routes but still
 * has queues, and that is exactly the process you want to look at when the
 * loop is stuck.
 */
@Module({
  imports: [
    BullMQCockpitModule.forRootAsync({
      path: "/admin/queues",
      // Better Auth is global, so the token resolves without importing the module.
      inject: [AUTH],
      useFactory: (auth: Auth) => {
        const env = loadEnv();
        return {
          connection: redisConnection(),
          // Listed, not discovered by scanning Redis: the dashboard should show
          // the queues this deployment runs, not whatever else shares the server.
          queues: [...ALL_QUEUES],
          readonly: cockpitReadonly(env),
          auth: (ctx: AuthContext) => authorize(auth, env.DEMO_MODE, ctx),
        };
      },
    }),
  ],
})
export class CockpitModule {}

/**
 * The dashboard mounts as middleware, so Nest guards never run for its routes
 * — this hook is the whole gate. It accepts the same session the API does, so
 * signing into the app is all it takes.
 *
 * Demo mode waves everyone through because it already signs every API request
 * in as the seeded operator; gating this one page would add friction without
 * adding security, and boot already warns that a demo instance is an open door.
 */
async function authorize(
  auth: Auth,
  demoMode: boolean,
  ctx: AuthContext,
): Promise<AuthResult> {
  if (demoMode) return true;

  const headers = (ctx.req as { headers?: unknown } | undefined)?.headers;
  if (!headers) return false;

  const session = await auth.api.getSession({ headers: headers as Headers });
  if (!session?.user) return false;

  return {
    allowed: true,
    user: { id: session.user.id, name: session.user.name || undefined },
  };
}
