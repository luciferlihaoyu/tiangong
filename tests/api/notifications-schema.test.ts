import { describe, it, expect } from "vitest";
import { notifications } from "@db/schema";
import { getTableColumns } from "drizzle-orm";

describe("notifications schema (NC-1)", () => {
  it("exports expected columns with correct types", () => {
    const cols = getTableColumns(notifications);
    expect(cols.id).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.type).toBeDefined();
    expect(cols.taskId).toBeDefined();
    expect(cols.title).toBeDefined();
    expect(cols.body).toBeDefined();
    expect(cols.metadata).toBeDefined();
    expect(cols.readAt).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  it("type enum is a MySQL enum with 6 values", () => {
    const typeCol = notifications.type;
    // drizzle mysqlEnum 暴露 enumValues 数组
    const enumValues = (typeCol as unknown as { enumValues?: string[] }).enumValues;
    expect([...enumValues].sort()).toEqual([
      "budget_exhausted",
      "lesson_recorded",
      "task_approved",
      "task_completed",
      "task_failed",
      "task_rejected",
    ]);
  });
});
