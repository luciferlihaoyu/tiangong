/**
 * Phase 1 Task 7: Pure formatting and parsing helpers for the metadata console.
 */

import { MEMBERSHIP_ROLES, type MembershipRole } from "./types";

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

export function parseLiteral<T extends string>(value: string, allowed: readonly T[]): T {
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`Invalid value: ${value}`);
  }
  return found;
}

export function parseMembershipRole(value: string): MembershipRole {
  return parseLiteral(value, MEMBERSHIP_ROLES);
}

export function formatDateTime(iso: Date | string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : String(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatMetadata(metadata: string | null | undefined): string {
  if (metadata === null || metadata === undefined || metadata === "") return "-";
  try {
    const parsed: unknown = JSON.parse(metadata);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return metadata;
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
