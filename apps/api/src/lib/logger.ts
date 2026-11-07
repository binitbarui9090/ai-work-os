import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.isTest ? "silent" : env.LOG_LEVEL,
  base: undefined,
  transport: env.isDevelopment
    ? { target: "pino/file", options: { destination: 1 } }
    : undefined,
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "password",
      "newPassword",
      "currentPassword",
      "accessToken",
      "refreshToken",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
