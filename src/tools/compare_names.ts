import stringSimilarity from 'string-similarity';

/**
 * Result from compare_names.
 */
export interface NameComparisonResult {
  name_a: string;
  name_b: string;
  similarity: number; // 0–1
}

/**
 * Returns a 0–1 string similarity score between two names.
 * Uses the Dice coefficient (via `string-similarity` package).
 *
 * Useful to disambiguate between multiple fuzzy candidates
 * when the reference or amount alone isn't decisive.
 *
 * @param nameA  First name  (e.g. ledger customer_name)
 * @param nameB  Second name (e.g. bank payer_name)
 * @returns Object with both names and the similarity score
 */
export function compareNames(nameA: string, nameB: string): NameComparisonResult {
  // Normalise to lowercase for fairer comparison
  const a = nameA.trim().toLowerCase();
  const b = nameB.trim().toLowerCase();

  const similarity = stringSimilarity.compareTwoStrings(a, b);

  return {
    name_a: nameA,
    name_b: nameB,
    similarity: Math.round(similarity * 1000) / 1000, // 3 decimal places
  };
}
