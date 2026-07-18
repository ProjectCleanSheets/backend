import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import { MAX_TAB_NAME_LENGTH, SHEET_SCAN_MAX_ROWS } from '../../lib/constants';
import { sendError } from '../../lib/errors';
import {
  findMonthTab,
  loadSheetConfig,
  resolveColumns,
  roundAmount,
  SaveFlowError,
  type SectionColumns,
} from '../../lib/saveflow';
import {
  type CellValue,
  getSheetsForUser,
  listTabInfo,
  readRanges,
  scanSection,
  SheetsError,
} from '../../lib/sheets';

// Unlike structure.ts (which runs during onboarding), this endpoint reads the
// sheet id from the caller's stored config — only `tab` comes from the query.
const querySchema = z.object({
  tab: z.string().min(1).max(MAX_TAB_NAME_LENGTH).optional(),
});

interface BudgetCategory {
  name: string;
  budget: number | null;
  actual: number | null;
}

interface BudgetTotals {
  budget: number;
  actual: number;
}

interface BudgetSection {
  name: string;
  categories: BudgetCategory[];
  totals: BudgetTotals;
}

export interface ResolvedSection {
  name: string;
  columns: SectionColumns;
}

/**
 * GET — budget overview for one month tab: every mapped section with its
 * categories' Budget/Actual values, per-section totals, and grand totals for
 * the iOS "Spent this month" card. Sections come from the stored column
 * mapping (not structure detection) so the screen shows exactly the
 * categories a save can write to — and summary boxes the user never mapped
 * (e.g. Cash flow) cannot double-count the totals.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'GET') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid query');
    }

    const config = await loadSheetConfig(user.googleId);
    const sheets = await getSheetsForUser(user.googleId);

    const resolved: ResolvedSection[] = Object.keys(config.columnMapping).map((name) => ({
      name,
      columns: resolveColumns(config.columnMapping, name),
    }));

    // An explicit tab is used as-is (an unknown one fails the read below with
    // SHEET_NOT_FOUND); omitted, it defaults to the current month's tab. The
    // no-mapping corner never reads, so the tab must be checked here instead.
    let tab = parsed.data.tab;
    if (tab === undefined || resolved.length === 0) {
      const tabs = await listTabInfo(sheets, config.sheetId);
      if (tab === undefined) {
        tab = findMonthTab(tabs).title;
      } else {
        const wanted = tab.trim().toLowerCase();
        if (!tabs.some((t) => t.title.trim().toLowerCase() === wanted)) {
          throw new SheetsError('SHEET_NOT_FOUND', 'Sheet or tab not found, or not accessible to this Google account');
        }
      }
    }

    if (resolved.length === 0) {
      res.status(200).json({ tab, sections: [], totals: { budget: 0, actual: 0 } });
      return;
    }

    // One batchGet covers every mapped column; letters are used verbatim so
    // the read works for any column the mapping validation allows.
    const uniqueColumns = [
      ...new Set(
        resolved.flatMap(({ columns }) =>
          [columns.categoryCol, columns.budgetCol, columns.actualCol].filter(
            (col): col is string => col !== null,
          ),
        ),
      ),
    ];
    const values = await readRanges(
      sheets,
      config.sheetId,
      tab,
      uniqueColumns.map((col) => `${col}1:${col}${SHEET_SCAN_MAX_ROWS}`),
    );
    const columnData = new Map<string, CellValue[][]>();
    uniqueColumns.forEach((col, i) => columnData.set(col, values[i] ?? []));

    res.status(200).json({ tab, ...buildBudgetOverview(resolved, columnData) });
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
    console.error('sheet/budget failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not read the budget overview');
  }
}

// The grand totals feed the "Spent this month" card (US-06): money going out
// this month vs the money budgeted for it. Every mapped section counts as an
// expense section except Income — inflows are not spending.
function isExpenseSection(name: string): boolean {
  return name.trim().toLowerCase() !== 'income';
}

function numberOrNull(cell: CellValue | undefined): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

/**
 * Assembles the response from single-column reads (keyed by column letter,
 * index 0 = row 1). Sections scan exactly like the save flow (same box
 * bounds); a mapped section missing from this tab is skipped, not an error —
 * older month tabs may predate a section. Blank or non-numeric Budget/Actual
 * cells stay null per category and count as 0 in totals.
 *
 * Exported so the assembly logic can be exercised directly; Vercel only
 * routes the default export.
 */
export function buildBudgetOverview(
  resolved: ResolvedSection[],
  columnData: Map<string, CellValue[][]>,
): { sections: BudgetSection[]; totals: BudgetTotals } {
  const sections: BudgetSection[] = [];
  for (const { name, columns } of resolved) {
    // The Actual column doubles as the title disambiguator: without it, a
    // summary row labeled like a section (Cash flow's "Income" line) would
    // anchor the scan on the wrong box.
    const scan = scanSection(
      columnData.get(columns.categoryCol) ?? [],
      name,
      columns.otherSections,
      columnData.get(columns.actualCol),
    );
    if (!scan) {
      continue;
    }
    const categories: BudgetCategory[] = scan.categories.map(({ row, name: categoryName }) => ({
      name: categoryName,
      budget:
        columns.budgetCol === null
          ? null
          : numberOrNull(columnData.get(columns.budgetCol)?.[row - 1]?.[0]),
      actual: numberOrNull(columnData.get(columns.actualCol)?.[row - 1]?.[0]),
    }));
    sections.push({
      name,
      categories,
      totals: {
        budget: roundAmount(categories.reduce((sum, c) => sum + (c.budget ?? 0), 0)),
        actual: roundAmount(categories.reduce((sum, c) => sum + (c.actual ?? 0), 0)),
      },
    });
  }

  const expenseSections = sections.filter((section) => isExpenseSection(section.name));
  return {
    sections,
    totals: {
      budget: roundAmount(expenseSections.reduce((sum, s) => sum + s.totals.budget, 0)),
      actual: roundAmount(expenseSections.reduce((sum, s) => sum + s.totals.actual, 0)),
    },
  };
}
