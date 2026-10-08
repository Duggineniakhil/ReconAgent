# /data
Synthetic dataset produced by `npm run generate-data` (fixed seed, reproducible):

- `ledger_records.csv`: 85 invoices (70 paid by bank transfer, 15 through Razorpay)
- `bank_transactions.csv`: 78 bank transactions, including 3 Razorpay settlement credits
- `ground_truth.json`: the expected outcome per invoice, used by `/api/metrics`
- `razorpay_recon.json`: Razorpay settlement recon report for the 15 invoices paid online (API format: paise, unix timestamps)
- `settlement_truth.json`: expected outcome per Razorpay settlement (matched / mismatch / missing)

`POST /api/ingest` loads the CSVs into Postgres. Point `DATA_DIR` elsewhere to use a different folder.

`samples/` holds a small Tally-style invoice export and an HDFC-style bank statement for trying **Upload CSVs**. They include a rounding difference, a withdrawal row to skip, and an unpaid invoice.
