# /data
Synthetic dataset produced by `npm run generate-data` (fixed seed, reproducible):

- `ledger_records.csv`: 70 invoices
- `bank_transactions.csv`: 75 bank / payment-gateway transactions
- `ground_truth.json`: the expected outcome per invoice, used by `/api/metrics`

`POST /api/ingest` loads the CSVs into Postgres. Point `DATA_DIR` elsewhere to use a different folder.

`samples/` holds a small Tally-style invoice export and an HDFC-style bank statement for trying **Upload CSVs**. They include a rounding difference, a withdrawal row to skip, and an unpaid invoice.
