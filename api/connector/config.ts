/**
 * Connector non-secret config and endpoint validator.
 *
 * Rejects JSON-unsafe values and any key that appears to hold credentials or
 * secrets. Credentials must be stored in the Secret Vault and referenced by
 * `secretRefId`; they must never be placed in the plain `config` column.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export type SafeConfigValue =
  | string
  | number
  | boolean
  | null
  | SafeConfigValue[]
  | { [key: string]: SafeConfigValue };

export const safeConfigValueSchema: z.ZodType<SafeConfigValue> = z.custom<SafeConfigValue>(
  (val) => {
    try {
      validateValue(val);
      return true;
    } catch {
      return false;
    }
  }
);

export const safeConfigSchema = z.record(z.string(), safeConfigValueSchema);

const FORBIDDEN_KEY_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "secretaccesskey",
  "secret_access_key",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "authorization",
  "bearer",
];

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(value);
}

function validateValue(value: unknown): SafeConfigValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!isFiniteNumber(value)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Connector config contains a non-JSON-safe value",
      });
    }
    return value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Connector config contains a non-JSON-safe value",
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => validateValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, SafeConfigValue> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isForbiddenKey(key)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Connector config contains a forbidden credential-like key",
        });
      }
      result[key] = validateValue(val);
    }
    return result;
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Connector config contains a non-JSON-safe value",
  });
}

export function validateSafeConfig(config: unknown): string | null {
  if (config === null || config === undefined) return null;
  const validated = validateValue(config);
  return JSON.stringify(validated);
}

export function validateSafeEndpoint(
  endpoint: string | null | undefined
): string | null {
  if (endpoint === null || endpoint === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Connector endpoint is not a valid URL",
    });
  }
  if (parsed.username || parsed.password) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Connector endpoint must not contain credentials",
    });
  }
  const queryKeys = Array.from(parsed.searchParams.keys());
  if (queryKeys.some(isForbiddenKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Connector endpoint contains a forbidden credential-like query parameter",
    });
  }
  return endpoint;
}
