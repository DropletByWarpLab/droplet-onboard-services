import type { Request, Response, NextFunction } from "express";
import pino from "pino";

const logger = pino({ name: "error-handler" });

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
  });
}
