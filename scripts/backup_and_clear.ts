import { query } from '../src/db';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  try {
    console.log('Fetching data...');
    const ledger = await query('SELECT * FROM ledger_records');
    const bank = await query('SELECT * FROM bank_transactions');
    const matches = await query('SELECT * FROM matches');
    const exceptions = await query('SELECT * FROM exceptions');
    const audit = await query('SELECT * FROM audit_log');

    const data = {
      ledger_records: ledger.rows,
      bank_transactions: bank.rows,
      matches: matches.rows,
      exceptions: exceptions.rows,
      audit_log: audit.rows
    };

    const backupPath = path.join(__dirname, '..', 'database_backup.json');
    fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
    console.log(`Backup saved to ${backupPath}`);

    console.log('Clearing database for demo...');
    await query('TRUNCATE TABLE audit_log CASCADE');
    await query('TRUNCATE TABLE matches CASCADE');
    await query('TRUNCATE TABLE exceptions CASCADE');
    await query('TRUNCATE TABLE bank_transactions CASCADE');
    await query('TRUNCATE TABLE ledger_records CASCADE');
    console.log('Database cleared. Dashboard will show 0/0/0.');
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
