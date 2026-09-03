import express, { Request, Response } from 'express';
import config from './config';
import { testConnection, closePool } from './db';
import { runMigration } from './db/migration';

const app = express();

import cors from 'cors';
import { apiRouter } from './routes/api';

// ── Middleware ─────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Start server ──────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Test DB connection
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[Server] Cannot start — database connection failed.');
    process.exit(1);
  }

  // Run schema migration
  await runMigration();

  // Start listening
  app.listen(config.server.port, () => {
    console.log(`[Server] ReconAgent API running on http://localhost:${config.server.port}`);
    console.log(`[Server] Environment: ${config.server.nodeEnv}`);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('[Server] Fatal error during startup:', err);
  process.exit(1);
});

export default app;
