import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import {
  ISO_DATE_PATTERN,
  MAX_CATEGORY_NAME_LENGTH,
  MAX_SECTION_NAME_LENGTH,
  MAX_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_ID_LENGTH,
  SHEET_SCAN_MAX_ROWS,
} from '../../lib/constants';
import { sendError } from '../../lib/errors';
import {
  appendLogEntry,
  assertNotAlreadySaved,
  findMonthTab,
  loadSheetConfig,
  resolveColumns,
  roundAmount,
  SaveFlowError,
} from '../../lib/saveflow';
import {
  getSheetsForUser,
  listTabInfo,
  readRanges,
  scanSection,
  SheetsError,
  writeCell,
} from '../../lib/sheets';

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
 * POST — create a new category in the current month tab by writing into the
 * section box's first free row (boxes keep spare formatted rows above their
 * Total — nothing is inserted or shifted); optionally categorize a
 * transaction to it in the same request (US-03 AC-3: "+ New Category").
 * Write order for crash-safety: dedup gate → name/budget → `_log` row →
 * Actual cell, so a duplicate save leaves no partial state and a crashed
 * request can never double-count on retry (spec §7b).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
    }
    if (req.method !== 'POST') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const { section, name, budget, transactionId } = parsed.data;

    const config = await loadSheetConfig(user.googleId);
    const columns = resolveColumns(config.columnMapping, section);
    if (budget !== undefined && columns.budgetCol === null) {
      return sendError(res, 400, 'INVALID_REQUEST', 'No Budget column mapped for this section');
    }
    // Names the box scanners treat as structure would make the new row
    // invisible to every future save: a "Total…" prefix ends a box, a
    // section name starts one (see scanSection in lib/sheets.ts).
    const lowerName = name.toLowerCase();
    const sectionNames = [section, ...columns.otherSections];
    if (/^total\b/i.test(name) || sectionNames.some((s) => s.trim().toLowerCase() === lowerName)) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Category name conflicts with the sheet structure');
    }

    const sheets = await getSheetsForUser(user.googleId);
    const tabs = await listTabInfo(sheets, config.sheetId);
    const monthTab = findMonthTab(tabs);

    // Category and Actual columns in one batchGet; the Actual column keeps a
    // summary row labeled like a section (Cash flow's "Income" line) from
    // anchoring the scan on the wrong box (task 14).
    const [column = [], actualColumn = []] = await readRanges(sheets, config.sheetId, monthTab.title, [
      `${columns.categoryCol}1:${columns.categoryCol}${SHEET_SCAN_MAX_ROWS}`,
      `${columns.actualCol}1:${columns.actualCol}${SHEET_SCAN_MAX_ROWS}`,
    ]);
    const scan = scanSection(column, section, columns.otherSections, actualColumn);
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
    if (scan.freeRow === null) {
      return sendError(
        res,
        409,
        'INVALID_REQUEST',
        `No empty row in section "${section}" — add a row above the section's Total in the sheet first`,
      );
    }
    const row = scan.freeRow;

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

    await writeCell(sheets, config.sheetId, monthTab.title, `${columns.categoryCol}${row}`, name);
    if (budget !== undefined && columns.budgetCol !== null) {
      await writeCell(sheets, config.sheetId, monthTab.title, `${columns.budgetCol}${row}`, budget);
    }

    if (!save) {
      res.status(200).json({ tab: monthTab.title, row });
      return;
    }

    // Task-05 ordering: `_log` first (crash-safety), then the Actual cell.
    // The row was blank in the category column, but its Actual cell may hold
    // a leftover value — read-modify-write like the save endpoint does. The
    // value comes from the batchGet above; the name/budget writes since then
    // never touch the Actual column.
    const cell = `${columns.actualCol}${row}`;
    const actualValue = actualColumn[row - 1]?.[0];
    const currentActual =
      typeof actualValue === 'number' && Number.isFinite(actualValue) ? actualValue : 0;

    await appendLogEntry(sheets, config.sheetId, {
      transactionId: save.transactionId,
      section,
      category: name,
      amount: save.amount,
      date: save.date,
      status: save.status,
    });
    const newActual = roundAmount(currentActual + save.amount);
    await writeCell(sheets, config.sheetId, monthTab.title, cell, newActual);

    res.status(200).json({ tab: monthTab.title, row, cell, newActual });
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
