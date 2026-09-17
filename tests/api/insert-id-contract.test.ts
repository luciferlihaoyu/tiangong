import { describe, expect, it } from "vitest";
import { getAffectedRows, getInsertId } from "../../api/lib/insert-id";

/**
 * 写入返回值契约。
 *
 * node:sqlite 适配器下，INSERT/UPDATE/DELETE 返回的是
 *   { changes, lastInsertRowid }
 * 而 mysql2 时代遗留代码读的是 `insertId` / `affectedRows`。
 * 读错字段的后果分两类，且都已在真实适配器上实测确认：
 *   1. 主键读成 NaN/0/undefined → 写入坏数据或整条链路失败；
 *   2. 受影响行数读成 NaN → `NaN !== 1` 恒真 → 守卫永远抛错
 *      （artifact-sealer 的封存、beidou 的状态变更就是这样 100% 失败的）。
 * 因此 getAffectedRows **绝不能返回 NaN**，这是本文件最关键的断言。
 */
describe("写入返回值契约", () => {
  describe("getInsertId", () => {
    it("读 node:sqlite 的真实形状 lastInsertRowid", () => {
      expect(getInsertId({ changes: 1, lastInsertRowid: 42 })).toBe(42);
    });

    it("兼容 mysql2 遗留形状 insertId", () => {
      expect(getInsertId({ insertId: 42, affectedRows: 1 })).toBe(42);
    });

    it("bigint 主键转成安全整数", () => {
      expect(getInsertId({ changes: 1, lastInsertRowid: 42n })).toBe(42);
    });

    it("无有效主键时返回 0（调用方按 0 判空，不得返回 NaN/undefined）", () => {
      expect(getInsertId({ changes: 1 })).toBe(0);
      expect(getInsertId(null)).toBe(0);
      expect(getInsertId(undefined)).toBe(0);
      expect(getInsertId({ changes: 1, lastInsertRowid: 0 })).toBe(0);
      expect(Number.isNaN(getInsertId({ changes: 1 }))).toBe(false);
    });
  });

  describe("getAffectedRows", () => {
    it("读 node:sqlite 的真实形状 changes", () => {
      expect(getAffectedRows({ changes: 1, lastInsertRowid: 7 })).toBe(1);
      expect(getAffectedRows({ changes: 0, lastInsertRowid: 7 })).toBe(0);
    });

    it("兼容 mysql2 遗留形状 affectedRows", () => {
      expect(getAffectedRows({ affectedRows: 1 })).toBe(1);
      expect(getAffectedRows({ affectedRows: 0 })).toBe(0);
    });

    it("形状无法识别时返回 0，绝不返回 NaN（否则 `!== 1` 守卫会恒真）", () => {
      expect(getAffectedRows({})).toBe(0);
      expect(getAffectedRows(null)).toBe(0);
      expect(getAffectedRows(undefined)).toBe(0);
      expect(Number.isNaN(getAffectedRows({}))).toBe(false);
      expect(Number.isNaN(getAffectedRows({ lastInsertRowid: 3 }))).toBe(false);
    });

    it("changes 优先于 affectedRows（同一结果里两者都在时以真实驱动为准）", () => {
      expect(getAffectedRows({ changes: 2, affectedRows: 99 })).toBe(2);
    });
  });
});
