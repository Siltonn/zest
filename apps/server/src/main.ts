import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadEnv, runsApi } from "./config.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule.forMode(env.MODE));

  app.enableShutdownHooks();
  app.enableCors({ origin: env.WEB_URL, credentials: true });

  // A worker-only process still binds a port so container health checks and
  // Bull Board have something to talk to; it just serves no domain routes.
  await app.listen(env.PORT);
  logger.log(
    `zest server listening on :${env.PORT} (MODE=${env.MODE}, api=${runsApi(env.MODE)})`,
  );
}

void bootstrap();
