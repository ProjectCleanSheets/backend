import type { VercelResponse } from '@vercel/node';

export type ErrorCode =
  | 'SHEET_WRITE_FAILED'
  | 'SHEET_NOT_FOUND'
  | 'BANK_TOKEN_EXPIRED'
  | 'GOOGLE_TOKEN_EXPIRED'
  | 'SUPABASE_ERROR'
  | 'CATEGORY_NOT_FOUND'
  | 'INVALID_REQUEST';

// Every error response carries a machine-readable code and a human-readable message
// — never stack traces or internals (see Error Responses in CLAUDE.md).
export function sendError(
  res: VercelResponse,
  status: number,
  code: ErrorCode,
  message: string,
): void {
  res.status(status).json({ code, message });
}
