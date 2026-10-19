import type {
  MarketEntry,
  MarketEntryInput,
  MarketEntryPatch,
  MarketCategory,
} from '@tipme/contracts';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { marketEntries } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const view = (row: typeof marketEntries.$inferSelect): MarketEntry => ({
  id: row.id,
  observedOn: row.observedOn,
  category: row.category as MarketCategory,
  name: row.name,
  metric: row.metric,
  value: row.value === null ? null : Number(row.value),
  text: row.text,
  sourceUrl: row.sourceUrl,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

/** Records one outside observation (permission `market.edit`, audited). */
export function addMarketEntry(
  db: Database,
  input: { entry: MarketEntryInput; staffUserId: string },
): Promise<MarketEntry> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(marketEntries)
        .values({
          id: newId(),
          ...input.entry,
          value: input.entry.value ?? null,
          text: input.entry.text ?? null,
          note: input.entry.note ?? null,
          createdBy: input.staffUserId,
        })
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'market.added',
        permission: 'market.edit',
        subjectType: 'market_entry',
        subjectId: row!.id,
      });
      return view(row!);
    }),
  );
}

async function change(
  db: Database,
  input: {
    id: string;
    staffUserId: string;
    set: Partial<typeof marketEntries.$inferInsert>;
    action: 'market.updated' | 'market.archived';
  },
): Promise<MarketEntry> {
  if (!UUID.test(input.id)) throw new OperationError('MARKET_ENTRY_NOT_FOUND');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(marketEntries)
      .set(input.set)
      .where(
        and(eq(marketEntries.id, input.id), isNull(marketEntries.archivedAt)),
      )
      .returning();
    if (!row) throw new OperationError('MARKET_ENTRY_NOT_FOUND');
    await recordAudit(tx, {
      staffUserId: input.staffUserId,
      action: input.action,
      permission: 'market.edit',
      subjectType: 'market_entry',
      subjectId: input.id,
    });
    return view(row);
  });
}

export function updateMarketEntry(
  db: Database,
  input: { id: string; patch: MarketEntryPatch; staffUserId: string },
): Promise<MarketEntry> {
  return guarded(() =>
    change(db, {
      id: input.id,
      staffUserId: input.staffUserId,
      set: input.patch,
      action: 'market.updated',
    }),
  );
}

/** Hides an entry from lists and charts; it is kept for the record. */
export function archiveMarketEntry(
  db: Database,
  input: { id: string; staffUserId: string },
): Promise<MarketEntry> {
  return guarded(() =>
    change(db, {
      id: input.id,
      staffUserId: input.staffUserId,
      set: { archivedAt: new Date() },
      action: 'market.archived',
    }),
  );
}

/** Current entries, newest observation first. */
export function listMarketEntries(
  db: Database,
  input: { category?: MarketCategory; name?: string },
): Promise<MarketEntry[]> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(marketEntries)
      .where(
        and(
          isNull(marketEntries.archivedAt),
          input.category
            ? eq(marketEntries.category, input.category)
            : undefined,
          input.name ? eq(marketEntries.name, input.name) : undefined,
        ),
      )
      .orderBy(desc(marketEntries.observedOn), desc(marketEntries.id))
      .limit(500);
    return rows.map(view);
  });
}

/** One name's metric over time, oldest first (for the chart). */
export function marketSeries(
  db: Database,
  input: { name: string; metric: string },
): Promise<{ observedOn: string; value: number }[]> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(marketEntries)
      .where(
        and(
          isNull(marketEntries.archivedAt),
          eq(marketEntries.name, input.name),
          eq(marketEntries.metric, input.metric),
        ),
      )
      .orderBy(asc(marketEntries.observedOn), asc(marketEntries.id));
    return rows
      .filter((row) => row.value !== null)
      .map((row) => ({ observedOn: row.observedOn, value: Number(row.value) }));
  });
}
