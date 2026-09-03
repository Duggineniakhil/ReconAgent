import 'dotenv/config';
import { query, closePool } from './src/db';
import { reconcileRecord } from './src/agent/loop';

async function run() {
  const cases = ['INV-2026-0068', 'INV-2026-0069', 'INV-2026-0070'];
  for (const c of cases) {
    console.log('Testing', c);
    const res = await query('SELECT id FROM ledger_records WHERE invoice_id = $1', [c]);
    if (res.rows.length) {
        const r = await reconcileRecord(res.rows[0].id);
        console.log(c, '=>', r.outcome, r.exception_reason || r.method);
        console.log('Trace length:', r.trace.length);
        console.log('Checked duplicate ref?', r.trace.some(t => t.tool_name === 'check_duplicate_ref'));
    }
  }
}
run().then(() => {
    closePool();
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
