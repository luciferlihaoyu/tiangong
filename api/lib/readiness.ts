/**
 * 就绪状态（readiness）——「现在能不能接单」的唯一判定源（Phase B §2）。
 *
 * 背景：原来只有 `/health`，而它只调用 getDb()——只能证明"SQLite 连接能打开"，
 * **证明不了迁移和执行器就绪**。于是迁移失败或补列失败时，进程照常启动、
 * 照常认领任务并把任务派给 Agent，故障被推迟到运行时才爆（例如 no such column）。
 *
 * 契约：
 *   - 四个关键环节（迁移 / schema 对齐 / 任务执行器 / 事件派发）全部就绪才算 ready；
 *   - **未跑完就是未就绪**（fail-closed）：宁可不接单，也不能接了一半才发现库不对；
 *   - 可选集成（MySQL 导入、GitHub、外部同步等）失败只记 degraded，不翻转 ready。
 *
 * 与 liveness 的区别：readiness=false 不会让进程被判定为"死了"（那会触发重启，
 * 反而更糟），它只作用于 **不接单**：认领入口拒绝发任务、派发循环不再派发。
 */
export type ReadinessComponent = "migration" | "schema" | "executor" | "outbox";

export interface ReadinessCheck {
  ok: boolean;
  detail?: string;
}

export interface ReadinessSnapshot {
  ready: boolean;
  checks: Record<ReadinessComponent, ReadinessCheck>;
  /** 为什么不能接单（可读原因，供 /ready 与日志使用） */
  reasons: string[];
  /** 可选集成降级记录（不影响 ready） */
  degraded: string[];
}

export interface ReadinessStore {
  /** 清空评估（重启流程/测试隔离用） */
  reset(): void;
  recordMigration(ok: boolean, detail?: string): void;
  /** 补列被跳过的列 = schema 与 db/schema.ts 不一致，运行时必然报错 */
  recordSchemaDrift(skipped: ReadonlyArray<{ table: string; column: string; reason?: string }>): void;
  recordExecutor(ok: boolean, detail?: string): void;
  recordOutbox(ok: boolean, detail?: string): void;
  recordDegraded(component: string, detail: string): void;
  snapshot(): ReadinessSnapshot;
  isReady(): boolean;
}

const LABELS: Record<ReadinessComponent, string> = {
  migration: "数据库迁移",
  schema: "schema 对齐",
  executor: "任务执行器",
  outbox: "事件派发",
};

const COMPONENTS = Object.keys(LABELS) as ReadinessComponent[];

export function createReadinessStore(): ReadinessStore {
  let checks: Partial<Record<ReadinessComponent, ReadinessCheck>> = {};
  let degraded: string[] = [];

  function set(component: ReadinessComponent, ok: boolean, detail?: string): void {
    checks[component] = detail === undefined ? { ok } : { ok, detail };
  }

  const store: ReadinessStore = {
    reset() {
      checks = {};
      degraded = [];
    },
    recordMigration(ok, detail) {
      set("migration", ok, detail);
    },
    recordSchemaDrift(skipped) {
      if (skipped.length === 0) {
        set("schema", true);
        return;
      }
      const list = skipped.map((s) => `${s.table}.${s.column}（${s.reason ?? "无法补列"}）`).join("；");
      set("schema", false, `schema 与 db/schema.ts 不一致，运行时会报 no such column：${list}`);
    },
    recordExecutor(ok, detail) {
      set("executor", ok, detail);
    },
    recordOutbox(ok, detail) {
      set("outbox", ok, detail);
    },
    recordDegraded(component, detail) {
      degraded.push(`${component}: ${detail}`);
    },
    snapshot() {
      const out = {} as Record<ReadinessComponent, ReadinessCheck>;
      const reasons: string[] = [];
      for (const component of COMPONENTS) {
        const check = checks[component];
        if (!check) {
          out[component] = { ok: false };
          reasons.push(`${LABELS[component]}尚未完成`);
          continue;
        }
        out[component] = check;
        if (!check.ok) {
          reasons.push(check.detail ? `${LABELS[component]}失败：${check.detail}` : `${LABELS[component]}未就绪`);
        }
      }
      return { ready: reasons.length === 0, checks: out, reasons, degraded: [...degraded] };
    },
    isReady() {
      return store.snapshot().ready;
    },
  };

  return store;
}

/** 进程级单例：boot 写入，认领/派发闸门读取 */
export const readiness: ReadinessStore = createReadinessStore();

/** 便捷判定（闸门用） */
export function isReady(): boolean {
  return readiness.isReady();
}

/** 便捷读取当前快照（/health、/ready 端点用） */
export function getReadiness(): ReadinessSnapshot {
  return readiness.snapshot();
}
