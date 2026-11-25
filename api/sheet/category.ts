import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import {
  ISO_DATE_PATTERN,
  MAX_CATEGORY_NAME_LENGTH,
  MAX_SECTION_NAME_LENGTH,
  MAX_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_ID_LENGTH,
} from '../../lib/constants';
import { sendError } from '../../lib/errors';
import {
  addToActual,
  appendLogEntry,
  assertNotAlreadySaved,
  findMonthTab,
  loadSheetConfig,
  readSectionColumns,
  resolveColumns,
  SaveFlowError,
} from '../../lib/saveflow';
import { boxOf } from '../../lib/sheetedit';
import { insertCategoryRow } from '../../lib/sheeteditrun';
import { scanSection } from '../../lib/sheetlayout';
import { getSheetsForUser, listTabInfo, SheetsError } from '../../lib/sheets';

// The optional save half needs the full task-05 dedup key (id + amount +
// date + status — see lib/logtab.ts), so the four fields come together or
// not at all.
const bodySchema = z
  .object({
    section: z.string().trim().min(1).max(MAX_SECTION_NAME_LENGTH),
    name: z.string().trim().min(1).max(MAX_CATEGORY_NAME_LENGTH),
    budget: z.number().finite().gte(0).lte(MAX_TRANSACTION_AMOUNT).optional(),
    transactionId: z.string().trim().min(1).max(MAX_TRANSACTION_ID_LENGTH).optional(),
    amount: z.number().finite().gte(-MAX_TRANSACTION_AMOUNT).lte(MAX_TRANSACTION_AMOUNT).optional(),
    date: z.string().regex(ISO_DATE_PATTERN, 'date must be YYYY-MM-DD').optional(),
    status: z.enum(['booked', 'pending']).optional(),
  })
  .refine(
    (body) => {
      const saveFields = [body.transactionId, body.amount, body.date, body.status];
      return saveFields.every((f) => f === undefined) || saveFields.every((f) => f !== undefined);
    },
    { message: 'transactionId, amount, date and status must be provided together' },
  );

/**
 * POST — create a new category in the current month tab as a real row inside the
 * section box, inserted so every total grows to include it and no formula breaks
 * (lib/sheetedit.ts; refused with nothing changed when that can't be guaranteed).
 * Optionally categorizes a transaction to it in the same request. Write order:
 * dedup gate → new row → `_log` row → Actual cell, so a duplicate save leaves no
 * partial state and a crashed request can't double-count on retry.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
    }
    if (req.method !== 'POST') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const { section, name, budget, transactionId } = parsed.data;

    const config = await loadSheetConfig(user.userId);
    const columns = resolveColumns(config.columnMapping, section);
    if (budget !== undefined && columns.budgetCol === null) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No Budget column mapped for this section');
    }
    // Names the box scanners treat as structure would make the new row
    // invisible to every future save: a "Total…" prefix ends a box, a
    // section name starts one (see scanSection in lib/sheetlayout.ts).
    const lowerName = name.toLowerCase();
    const sectionNames = [section, ...columns.otherSections];
    if (/^total\b/i.test(name) || sectionNames.some((s) => s.trim().toLowerCase() === lowerName)) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Category name conflicts with the sheet structure');
    }

    const sheets = await getSheetsForUser(user.userId);
    const tabs = await listTabInfo(sheets, config.sheetId);
    const monthTab = findMonthTab(tabs);

    const { categoryColumn, actualColumn } = await readSectionColumns(
      sheets,
      config.sheetId,
      monthTab.title,
      columns,
    );
    const scan = scanSection(categoryColumn, section, columns.otherSections, actualColumn);
    if (!scan) {
      return sendError(
        res,
        404,
        'CATEGORY_NOT_FOUND',
        `No section "${section}" found in tab "${monthTab.title}"`,
      );
    }
    if (scan.categories.some((c) => c.name.toLowerCase() === lowerName)) {
      return sendError(
        res,
        409,
        'INVALID_REQUEST',
        `Category "${name}" already exists in section "${section}"`,
      );
    }
    // Dedup gate before any mutation: an already-saved transaction must not
    // leave an orphan category row behind.
    const save =
      transactionId !== undefined
        ? {
            transactionId,
            // Guaranteed by the schema refine; TS cannot see the coupling.
            amount: parsed.data.amount as number,
            date: parsed.data.date as string,
            status: parsed.data.status as 'booked' | 'pending',
          }
        : null;
    if (save) {
      await assertNotAlreadySaved(sheets, config.sheetId, tabs, {
        id: save.transactionId,
        amount: save.amount,
        date: save.date,
      });
    }

    const { row } = await insertCategoryRow(
      sheets,
      config.sheetId,
      boxOf(monthTab.title, section, columns, scan.categories),
      name,
      budget ?? null,
    );

    if (!save) {
      res.status(200).json({ tab: monthTab.title, row });
      return;
    }

    // `_log` first, then the Actual cell, so a crash between them can't
    // double-count on retry. The inserted row's Actual starts empty.
    const target = { row, cell: `${columns.actualCol}${row}`, currentActual: 0 };

    await appendLogEntry(sheets, config.sheetId, {
      transactionId: save.transactionId,
      section,
      category: name,
      amount: save.amount,
      date: save.date,
      status: save.status,
    });
    const newActual = await addToActual(sheets, config.sheetId, monthTab.title, target, save.amount);

    res.status(200).json({ tab: monthTab.title, row, cell: target.cell, newActual });
  } catch (err) {
    if (err instanceof SaveFlowError) {
      return sendError(res, err.status, err.code, err.message);
    }
    if (err instanceof SheetsError) {
      const status =
        err.code === 'GOOGLE_TOKEN_EXPIRED' ? 401 : err.code === 'SHEET_NOT_FOUND' ? 404 : 500;
      return sendError(res, status, err.code, err.message);
    }
    // SheetsError is sanitized by design; anything else is internal — log the
    // message only, never sheet contents or tokens.
    console.error('sheet/category failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not create the category');
  }
}
