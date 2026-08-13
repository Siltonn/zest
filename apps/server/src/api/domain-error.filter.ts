import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { InvalidTransitionError } from "@zest/core";

/**
 * Domain rules rejecting a request are a client error, not a crash.
 *
 * `transition` throws when an action does not apply to a post's current state —
 * asking for changes on something already published, retrying what never
 * failed. Uncaught, every one of those surfaced as a 500 "Internal server
 * error", which tells the caller nothing and looks like the server broke. The
 * message the state machine already writes is the useful part, so it goes back
 * as a 400.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof InvalidTransitionError) {
      response.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: exception.message,
      });
      return;
    }

    // Anything else genuinely is a server fault: log it with the stack, and do
    // not leak the internals to the caller.
    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(500).json({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Something went wrong on our side.",
    });
  }
}
