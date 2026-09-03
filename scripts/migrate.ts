/**
 * Standalone migration runner.
 * Usage: npx tsx scripts/migrate.ts
 *
 * Creates all ReconAgent tables in the database specified by DATABASE_URL.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */
import { testConnection, closePool } from '../src/db';
import { runMigration } from '../src/db/migration';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  ReconAgent — Database Migration Runner');
  console.log('═══════════════════════════════════════════\n');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('\n✗ Cannot connect to database. Check your DATABASE_URL in .env');
    process.exit(1);
  }

  await runMigration();

  console.log('\n✓ Migration completed successfully.\n');
  await closePool();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
