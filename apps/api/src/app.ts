/** Express application assembly. Exported separately so tests can mount it. */
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/context.js";
import { logger } from "./lib/logger.js";
import { apiRoutes } from "./routes.js";

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, trust the first proxy so client IPs and
  // `secure` cookie detection work.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // The API serves JSON only; CSP belongs to whatever serves the web app.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin and server-to-server requests send no Origin header.
        if (!origin) return callback(null, true);
        if (origin === env.WEB_ORIGIN) return callback(null, true);
        // Vite may serve on 127.0.0.1 while WEB_ORIGIN says localhost.
        if (env.isDevelopment && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      exposedHeaders: ["x-request-id", "X-RateLimit-Remaining", "Retry-After"],
    }),
  );

  app.use(
    express.json({
      limit: "2mb",
      // The GitHub webhook signature covers the exact bytes GitHub sent, so
      // the raw body is retained on that path only.
      verify: (req, _res, buf) => {
        if (req.url?.includes("/integrations/github/webhook")) {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(cookieParser());
  app.use(requestContext());

  if (!env.isTest) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        const ms = Date.now() - started;
        const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "debug";
        logger[level](
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms,
            requestId: req.ctx?.requestId,
            userId: req.ctx?.user?.id,
          },
          "request",
        );
      });
      next();
    });
  }

  app.use("/api", apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
