#!/usr/bin/env node
/** Waits until Postgres and Redis accept TCP connections (used by `npm run setup`). */
import net from "node:net";

const targets = [
  { name: "postgres", host: "127.0.0.1", port: Number(process.env.PGPORT ?? 55432) },
  { name: "redis", host: "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 56379) },
];

const probe = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const deadline = Date.now() + 90_000;
for (const t of targets) {
  process.stdout.write(`waiting for ${t.name} on ${t.port} `);
  for (;;) {
    if (await probe(t.host, t.port)) {
      process.stdout.write(" ready\n");
      break;
    }
    if (Date.now() > deadline) {
      process.stdout.write("\n");
      console.error(`timed out waiting for ${t.name} (${t.host}:${t.port}).`);
      console.error("Is Docker running? Try: npm run infra:up");
      process.exit(1);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.log("infrastructure ready");
