import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import {
  COLUMN_LETTER_PATTERN,
  MAX_SECTION_NAME_LENGTH,
  SHEET_ID_PATTERN,
} from '../../lib/constants';
import { sendError } from '../../lib/errors';
import { getSupabase } from '../../lib/supabase';

// Column mapping per section, e.g. { "Expenses": { "category_col": "F", "actual_col": "H" } }
const columnSchema = z.string().regex(COLUMN_LETTER_PATTERN, 'Column must be a letter like "F"');
const columnMappingSchema = z.record(
  z.string().min(1).max(MAX_SECTION_NAME_LENGTH),
  z.object({
    category_col: columnSchema,
    actual_col: columnSchema,
    budget_col: columnSchema.optional(),
    left_col: columnSchema.optional(),
  }),
);

const configUpdateSchema = z
  .object({
    sheetId: z.string().regex(SHEET_ID_PATTERN, 'Invalid Google Sheet ID'),
    columnMapping: columnMappingSchema,
  })
  .partial()
  .refine((body) => body.sheetId !== undefined || body.columnMapping !== undefined, {
    message: 'Provide sheetId and/or columnMapping',
  });

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid identity token');
    }

    if (req.method === 'GET') {
      return await getConfig(user.userId, res);
    }
    if (req.method === 'POST') {
      return await updateConfig(user.userId, req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
  } catch (err) {
    console.error('user/config failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not access user config');
  }
}

async function getConfig(userId: string, res: VercelResponse): Promise<void> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, column_mapping')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not load user config');
  }

  res.status(200).json({
    sheetId: data?.sheet_id ?? null,
    columnMapping: data?.column_mapping ?? null,
  });
}

async function updateConfig(userId: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = configUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.sheetId !== undefined) {
    update.sheet_id = parsed.data.sheetId;
  }
  if (parsed.data.columnMapping !== undefined) {
    update.column_mapping = parsed.data.columnMapping;
  }

  const { data, error } = await getSupabase()
    .from('users')
    .update(update)
    .eq('id', userId)
    .select('sheet_id, column_mapping')
    .single();
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not save user config');
  }

  res.status(200).json({
    sheetId: data.sheet_id ?? null,
    columnMapping: data.column_mapping ?? null,
  });
}
