import "reflect-metadata";
import { join, resolve } from "node:path";
import express from "express";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { closeDatabase, createDatabase, migrateToLatest } from "@zest/db";
import { AppModule } from "./app.module.js";
import { loadEnv, runsApi } from "./config.js";
import { mountBullBoard } from "./queue/bull-board.js";
import { DomainErrorFilter } from "./api/domain-error.filter.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger("Bootstrap");

  /*
   * Migrate before the app is constructed, not after.
   *
   * Nest instantiates repeatable-job registrars and the webhook dispatcher as
   * it builds the module graph, and those query immediately. Migrating after
   * that means the first tick can hit a table the migration is still creating —
   * so the schema is settled before anything is allowed to look at it.
   *
   * A failure here aborts the boot on purpose. A server that starts on a schema
   * it does not match will fail later, somewhere less obvious, on whichever
   * code path runs first.
   */
  if (env.AUTO_MIGRATE) {
    const db = createDatabase(env.DATABASE_URL, { max: 1 });
    try {
      await migrateToLatest(db, { logger: (m) => logger.log(`migrate: ${m}`) });
      logger.log("migrate: schema is up to date");
    } catch (error) {
      logger.error(`migrate: failed — ${(error as Error).message}`);
      throw error;
    } finally {
      await closeDatabase(db);
    }
  }

  const app = await NestFactory.create(AppModule.forMode(env.MODE));

  app.enableShutdownHooks();
  app.enableCors({ origin: env.WEB_URL, credentials: true });

  // A domain rule rejecting a request should read as a 400 with the reason,
  // not a 500 that says nothing.
  app.useGlobalFilters(new DomainErrorFilter());

  // Uploaded images are served straight off disk — no CDN, no bucket.
  app.use("/media", express.static(resolve(env.MEDIA_DIR), { maxAge: "1y" }));

  // The queue dashboard needs the producers, which exist in every mode.
  mountBullBoard(app);

  // A worker-only process still binds a port so container health checks and
  // Bull Board have something to talk to; it just serves no domain routes.
  await app.listen(env.PORT);
  logger.log(
    `zest server listening on :${env.PORT} (MODE=${env.MODE}, api=${runsApi(env.MODE)})`,
  );

  // Loud on purpose. Demo mode is what makes a fresh clone clickable, and it is
  // also an open door — worth one line in the log rather than a surprise later.
  if (env.DEMO_MODE && runsApi(env.MODE)) {
    logger.warn(
      "DEMO_MODE is on: every browser/REST request is signed in as the seeded operator and needs no credentials. (/mcp is the exception — it always requires an API key or OAuth.) Set DEMO_MODE=false before exposing this instance.",
    );
  }
}

void bootstrap();
