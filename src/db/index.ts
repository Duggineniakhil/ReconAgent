import { Pool, PoolClient, QueryResult } from 'pg';
import config from '../config';

/**
 * PostgreSQL connection pool.
 * Uses the DATABASE_URL from environment / config.
 */
const pool = new Pool({
  connectionString: config.database.url,
});

// Log pool errors so they don't crash the process silently
pool.on('error', (err: Error) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

/**
 * Run a parameterized query against the pool.
 */
export async function query<T extends object = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (config.server.nodeEnv === 'development') {
    console.log('[DB] query', { text: text.substring(0, 80), duration: `${duration}ms`, rows: result.rowCount });
  }

  return result;
}

/**
 * Acquire a dedicated client from the pool (for transactions).
 * Caller MUST call client.release() when done.
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Test the database connection by running a simple query.
 * Returns true if the connection is healthy.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT NOW() AS current_time');
    console.log('[DB] Connection successful:', result.rows[0].current_time);
    return true;
  } catch (err) {
    const error = err as Error;
    console.error('[DB] Connection failed:', error.message);
    return false;
  }
}

/**
 * Gracefully shut down the pool (call on app exit).
 */
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('[DB] Connection pool closed.');
}

export default pool;
