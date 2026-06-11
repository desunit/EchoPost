import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  app.get("/health/db", async (_req, reply) => {
    try {
      app.services.db.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch (err: any) {
      return reply.code(503).send({ status: "error", message: err.message });
    }
  });

  app.get("/health/jobs", async (_req, reply) => {
    const counts = app.services.worker.queue.counts();
    const backlog = (counts.pending ?? 0) + (counts.running ?? 0);
    const dead = counts.dead ?? 0;
    const healthy = backlog < 500 && dead < 50;
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", counts });
  });
}
