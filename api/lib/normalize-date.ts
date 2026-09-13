/**
 * 历史时间戳脏数据归一化（58669 年事故）
 *
 * 背景：drizzle sqlite 的 integer(mode:"timestamp").defaultNow() 默认值写的是
 * epoch 毫秒（julianday*86400000），但读取时 mapFromDriverValue 按秒处理
 * （value * 1000）——历史默认值写入的行全部偏 1000 倍，序列化后成年份
 * +58669 的 ISO 字符串。schema 已改 $defaultFn 根治新写入，这里兜底读取。
 *
 * 判据：getTime() > 1e14 ms（≈公元 5138 年）即为被多读 1000 倍的脏值。
 */
export function normalizeDbDate<T extends Date | string | number | null | undefined>(v: T): T {
  if (v === null || v === undefined) return v;
  let d: Date;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date(v);
  else {
    d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
  }
  if (d.getTime() > 1e14) {
    const fixed = new Date(d.getTime() / 1000);
    if (v instanceof Date) return fixed as T;
    if (typeof v === "number") return fixed.getTime() as T;
    return fixed.toISOString() as T;
  }
  return v;
}
