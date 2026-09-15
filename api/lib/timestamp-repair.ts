/**
 * 时间戳存量脏数据修复（58669 年事故的数据侧收尾）
 *
 * 背景：drizzle sqlite 的 integer(mode:"timestamp").defaultNow() 默认值写 epoch
 * 毫秒，但读取按秒 ×1000，序列化后成年份 +58669。schema 已改 $defaultFn 根治
 * 新写入、读取侧有 normalizeDbDate 兜底显示，但**库里历史行仍是毫秒值**——
 * 任何没接归一化的读取面（mailbox / events / usage / audit / 导出 / SQL 直查）
 * 都会看到错误时间。本模块做一次性数据修复。
 *
 * 列发现：从 drizzle schema 自动枚举 columnType === "SQLiteTimestamp" 且
 * mode === "timestamp"（秒语义）的列；mode === "timestamp_ms" 的列本就该存
 * 毫秒，不碰。
 *
 * 判据与幂等：值 > 1e11（按秒读是公元 5138 年）即为被写错的毫秒值；除以 1000
 * 后必然 < 1e11，重复执行不会二次除。全程只改这一处，不加迁移、不动 schema。
 */
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@db/schema";

/** 秒语义时间戳的合理上界（公元 5138 年）；超过即认为是被写成毫秒的脏值 */
const DIRTY_THRESHOLD = 1e11;

/** 只需要 all()（SELECT）与 run()（UPDATE）两个能力的 drizzle 句柄 */
export interface TimestampRepairDb {
  all: (query: unknown) => unknown;
  run: (query: unknown) => unknown;
}

export interface TimestampColumn {
  table: string;
  column: string;
}

export interface TimestampScanRow extends TimestampColumn {
  /** 该列中疑似毫秒脏值的行数 */
  dirty: number;
  /** 修复后的时间样本（人类可读），无脏值时为空 */
  samples: string[];
}

/** 从 drizzle schema 枚举所有「秒语义」timestamp 列。 */
export function listTimestampColumns(): TimestampColumn[] {
  const out: TimestampColumn[] = [];
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      // 非表导出（类型、常量等）→ 跳过
      continue;
    }
    for (const col of cfg.columns) {
      const mode = (col as unknown as { mode?: string }).mode;
      if (col.columnType === "SQLiteTimestamp" && mode === "timestamp") {
        out.push({ table: cfg.name, column: col.name });
      }
    }
  }
  return out;
}

/** 扫描：只读，统计每个列里有多少行需要修复。 */
export async function scanTimestampRepair(
  db: TimestampRepairDb
): Promise<{ rows: TimestampScanRow[]; totalDirty: number; scannedColumns: number }> {
  const columns = listTimestampColumns();
  const rows: TimestampScanRow[] = [];
  let totalDirty = 0;

  for (const { table, column } of columns) {
    try {
      const countRes = (await db.all(
        sql.raw(
          `SELECT COUNT(*) AS c FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" > ${DIRTY_THRESHOLD}`
        )
      )) as unknown as Array<{ c?: number | bigint }>;
      const dirty = Number(countRes?.[0]?.c ?? 0);
      if (dirty === 0) continue;

      const sampleRes = (await db.all(
        sql.raw(
          `SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" > ${DIRTY_THRESHOLD} LIMIT 3`
        )
      )) as unknown as Array<{ v?: number | bigint }>;
      const samples = (sampleRes ?? []).map((r) =>
        new Date(Math.floor(Number(r.v ?? 0) / 1000) * 1000).toISOString()
      );

      rows.push({ table, column, dirty, samples });
      totalDirty += dirty;
    } catch (error) {
      // 表/列在旧库中可能不存在（schema 演进），跳过不阻断整体扫描
      console.warn(
        `[timestamp-repair] scan skip ${table}.${column}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { rows, totalDirty, scannedColumns: columns.length };
}

/** 应用修复：把毫秒脏值除以 1000 落回秒（幂等，见文件头）。 */
export async function applyTimestampRepair(
  db: TimestampRepairDb
): Promise<{ rows: Array<TimestampColumn & { updated: number }>; totalUpdated: number }> {
  const scan = await scanTimestampRepair(db);
  const rows: Array<TimestampColumn & { updated: number }> = [];
  let totalUpdated = 0;

  for (const row of scan.rows) {
    try {
      const res = (await db.run(
        sql.raw(
          `UPDATE "${row.table}" SET "${row.column}" = CAST("${row.column}" / 1000 AS INTEGER) ` +
            `WHERE "${row.column}" IS NOT NULL AND "${row.column}" > ${DIRTY_THRESHOLD}`
        )
      )) as unknown as { changes?: number };
      const updated = Number(res?.changes ?? row.dirty);
      rows.push({ table: row.table, column: row.column, updated });
      totalUpdated += updated;
    } catch (error) {
      console.warn(
        `[timestamp-repair] apply failed ${row.table}.${row.column}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { rows, totalUpdated };
}
