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
    const gateway = await query('SELECT * FROM gateway_transactions');
    const settlements = await query('SELECT * FROM settlement_matches');

    // Run history isn't backed up, so outcomes are restored without their run_id
    const data = {
      ledger_records: ledger.rows,
      bank_transactions: bank.rows,
      gateway_transactions: gateway.rows,
      matches: matches.rows,
      exceptions: exceptions.rows,
      settlement_matches: settlements.rows,
      audit_log: audit.rows
    };

    const backupPath = path.join(__dirname, '..', 'database_backup.json');
    fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
    console.log(`Backup saved to ${backupPath}`);

    console.log('Clearing database for demo...');
    await query(`TRUNCATE audit_log, exceptions, matches, settlement_matches, gateway_transactions,
                 bank_transactions, ledger_records CASCADE`);
    console.log('Database cleared. Dashboard will show 0/0/0.');
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
