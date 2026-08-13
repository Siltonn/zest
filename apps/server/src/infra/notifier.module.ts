import { Global, Module } from "@nestjs/common";
import { Notifier, createMailProvider } from "@zest/core";
import { loadEnv } from "../config.js";

export const NOTIFIER = Symbol("NOTIFIER");

@Global()
@Module({
  providers: [
    {
      provide: NOTIFIER,
      useFactory: () => {
        const env = loadEnv();
        return new Notifier({
          mailProvider: createMailProvider(env.MAIL_PROVIDER, {
            apiKey: env.RESEND_API_KEY,
            from: env.MAIL_FROM,
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          }),
          webUrl: env.WEB_URL,
        });
      },
    },
  ],
  exports: [NOTIFIER],
})
export class NotifierModule {}
