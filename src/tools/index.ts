/**
 * Agent investigation tools — barrel export.
 */
export { findExactCandidates } from './find_exact_candidates';
export type { ExactCandidate } from './find_exact_candidates';

export { findFuzzyCandidates } from './find_fuzzy_candidates';
export type { FuzzyCandidate } from './find_fuzzy_candidates';

export { compareNames } from './compare_names';
export type { NameComparisonResult } from './compare_names';

export { checkDuplicateRef } from './check_duplicate_ref';
export type { DuplicateRefResult } from './check_duplicate_ref';
