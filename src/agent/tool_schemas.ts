import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';

/**
 * Tool schemas for the ReconAgent — adapted from spec section 5
 * for Google Gemini function calling format.
 */
export const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'find_exact_candidates',
    description:
      'Search bank transactions for an exact match on payment reference/UTR and amount. Use this first for every record.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reference: { type: SchemaType.STRING, description: 'Payment reference or UTR' },
        amount: { type: SchemaType.NUMBER, description: 'Transaction amount' },
      },
      required: ['reference', 'amount'],
    },
  },
  {
    name: 'find_fuzzy_candidates',
    description:
      'Search bank transactions within a tolerance window: amount +/- 1%, date +/- 3 days. Returns up to 5 candidates ranked by proximity. Use when find_exact_candidates returns nothing.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        amount: { type: SchemaType.NUMBER, description: 'Target amount' },
        date: { type: SchemaType.STRING, description: 'Target date (YYYY-MM-DD)' },
        customer_name: { type: SchemaType.STRING, description: 'Customer name for context' },
      },
      required: ['amount', 'date'],
    },
  },
  {
    name: 'compare_names',
    description:
      'Returns a 0-1 string similarity score between two names. Use to disambiguate between multiple fuzzy candidates.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name_a: { type: SchemaType.STRING, description: 'First name' },
        name_b: { type: SchemaType.STRING, description: 'Second name' },
      },
      required: ['name_a', 'name_b'],
    },
  },
  {
    name: 'check_duplicate_ref',
    description:
      'Checks whether a given payment reference/UTR appears more than once across all bank transactions. Always call this before committing a match.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reference: { type: SchemaType.STRING, description: 'Payment reference to check' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'find_gateway_payments',
    description:
      'Search Razorpay payments (from the settlement report) for an invoice paid online: by order receipt / notes when a receipt is given, and by amount +/- 1% and payment date +/- 3 days. Use when the invoice has no direct bank match: online payments reach the bank only as one settlement credit net of fees.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        amount: { type: SchemaType.NUMBER, description: 'Invoice amount (gateway payments carry the gross amount)' },
        date: { type: SchemaType.STRING, description: 'Invoice date (YYYY-MM-DD)' },
        receipt: { type: SchemaType.STRING, description: 'Invoice ID to look for in order_receipt and notes' },
      },
      required: ['amount', 'date'],
    },
  },
  {
    name: 'explain_bank_credit',
    description:
      'Explains a bank credit: if it is a payment gateway settlement (e.g. from RAZORPAY), lists the payments, refunds and fees it pays out. Use when a bank candidate looks like a gateway payout; a settlement credit covers many invoices and must never be matched to a single invoice.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        bank_txn_id: { type: SchemaType.STRING, description: 'Bank transaction ID (e.g. TXN-00076)' },
      },
      required: ['bank_txn_id'],
    },
  },
  {
    name: 'commit_match',
    description:
      'TERMINAL ACTION. Finalizes a match between the ledger record and either a bank transaction (bank_txn_id) or a Razorpay payment (gateway_entity_id). Provide exactly one of the two.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        bank_txn_id: { type: SchemaType.STRING, description: 'Bank transaction ID to match (direct bank receipts)' },
        gateway_entity_id: { type: SchemaType.STRING, description: 'Razorpay payment ID to match (pay_...), for invoices paid online' },
        confidence: { type: SchemaType.NUMBER, description: 'Confidence score 0-1' },
        method: {
          type: SchemaType.STRING,
          description: 'Match method: exact, fuzzy, or reasoned',
          format: 'enum',
          enum: ['exact', 'fuzzy', 'reasoned'],
        },
        reasoning: { type: SchemaType.STRING, description: 'Plain-language explanation' },
      },
      required: ['confidence', 'method', 'reasoning'],
    },
  },
  {
    name: 'flag_exception',
    description:
      'TERMINAL ACTION. Escalates this record to a human reviewer instead of matching it.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reason: {
          type: SchemaType.STRING,
          description: 'Exception reason category',
          format: 'enum',
          enum: [
            'no_candidate',
            'ambiguous_candidates',
            'duplicate_reference',
            'unexplained_discrepancy',
          ],
        },
        best_candidate_id: {
          type: SchemaType.STRING,
          description: 'Best candidate bank txn ID or Razorpay payment ID if any, or empty string if none',
        },
        reasoning: { type: SchemaType.STRING, description: 'Plain-language explanation' },
      },
      required: ['reason', 'reasoning'],
    },
  },
];
