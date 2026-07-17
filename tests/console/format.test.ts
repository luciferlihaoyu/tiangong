import { describe, it, expect } from "vitest";
import {
  formatDateTime,
  formatBytes,
  formatMetadata,
  parseLiteral,
  parseMembershipRole,
} from "../../src/pages/console/format";
import { MEMBERSHIP_ROLES, CONNECTOR_TYPES } from "../../src/pages/console/types";

describe("Console format helpers", () => {
  describe("formatDateTime", () => {
    it("formats a Date object", () => {
      const d = new Date(2026, 6, 17, 8, 30, 0);
      expect(formatDateTime(d)).toBe("2026-07-17 08:30");
    });

    it("formats an ISO string to a local date-time shape", () => {
      const result = formatDateTime("2026-07-17T08:30:00.000Z");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it("returns the input for invalid dates", () => {
      expect(formatDateTime("not-a-date")).toBe("not-a-date");
    });
  });

  describe("formatBytes", () => {
    it("returns dash for null", () => {
      expect(formatBytes(null)).toBe("-");
    });

    it("formats bytes", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1024 * 1024 * 5)).toBe("5.00 MB");
    });

    it("returns dash for negative", () => {
      expect(formatBytes(-1)).toBe("-");
    });
  });

  describe("parseLiteral", () => {
    it("parses a known value from an allowed set", () => {
      expect(parseLiteral("s3", CONNECTOR_TYPES)).toBe("s3");
    });

    it("throws for unknown values", () => {
      expect(() => parseLiteral("ftp", CONNECTOR_TYPES)).toThrow("Invalid value: ftp");
    });
  });

  describe("parseMembershipRole", () => {
    it("parses a known role", () => {
      expect(parseMembershipRole("admin")).toBe("admin");
      expect(MEMBERSHIP_ROLES).toContain(parseMembershipRole("viewer"));
    });

    it("throws for unknown roles", () => {
      expect(() => parseMembershipRole("superuser")).toThrow("Invalid value: superuser");
    });
  });

  describe("formatMetadata", () => {
    it("returns dash for null, undefined, or empty", () => {
      expect(formatMetadata(null)).toBe("-");
      expect(formatMetadata(undefined)).toBe("-");
      expect(formatMetadata("")).toBe("-");
    });

    it("pretty-prints a JSON metadata string", () => {
      expect(formatMetadata(JSON.stringify({ name: "x", changed: ["a"] }))).toContain('"name": "x"');
    });

    it("returns raw string for invalid JSON", () => {
      expect(formatMetadata("not json")).toBe("not json");
    });
  });
});
