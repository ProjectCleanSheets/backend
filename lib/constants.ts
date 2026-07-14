// Constants shared by more than one file. Single-use tuning values stay in
// the file they belong to (named, with a comment) — only values that define a
// cross-file contract live here, so a change in one place cannot silently
// disagree with its counterpart.

// --- Sheet layout ----------------------------------------------------------

// Default columns per CLAUDE.md (user-configurable via column_mapping):
// F = category names, G = Budget, H = Actual, I = Left (formula, never written).
export const DEFAULT_CATEGORY_COLUMN = 'F';
export const DEFAULT_BUDGET_COLUMN = 'G';
export const DEFAULT_ACTUAL_COLUMN = 'H';
export const DEFAULT_LEFT_COLUMN = 'I';

// Budget dashboards are small; one bounded scan covers the whole layout.
// Structure detection and the save endpoint's category scan share this depth
// so a category visible to one is always visible to the other.
export const SHEET_SCAN_MAX_ROWS = 300;

// --- Money -----------------------------------------------------------------

// Currency amounts are handled at 2 decimals everywhere: read-modify-write
// rounding and the _log dedup key must agree on precision.
export const AMOUNT_DECIMALS = 2;

// Sane bound for a single budget transaction (request validation). Sign is
// allowed so a refund can reduce an Actual total.
export const MAX_TRANSACTION_AMOUNT = 1_000_000;

// --- Request validation ----------------------------------------------------

// Google Sheet id as it appears in the sheet URL.
export const SHEET_ID_PATTERN = /^[a-zA-Z0-9_-]{20,100}$/;

// One- or two-letter column reference like "F" or "AA".
export const COLUMN_LETTER_PATTERN = /^[A-Z]{1,2}$/;

export const MAX_SECTION_NAME_LENGTH = 40;
export const MAX_CATEGORY_NAME_LENGTH = 100;
export const MAX_TAB_NAME_LENGTH = 100;
export const MAX_TRANSACTION_ID_LENGTH = 100;

// --- Time ------------------------------------------------------------------

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" — also the date prefix of an ISO timestamp.
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;
