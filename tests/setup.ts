/**
 * Test setup: set env vars FIRST, then mock database and external dependencies
 * so tests never touch production data.
 */

// Set test environment variables BEFORE any imports
process.env.NODE_ENV = "test";
process.env.APP_SECRET = "test-secret-key-for-vitest";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "admin";
process.env.DATABASE_URL = "mysql://test:test@localhost:3306/test_db";

import { vi, beforeAll, afterAll } from "vitest";

// Mock local-auth-router to break circular dependency (middleware <-> local-auth-router)
// This prevents the "Cannot read properties of undefined (reading 'input')" error
vi.mock("../api/local-auth-router", () => ({
  verifyToken: vi.fn(async () => null),
  localAuthRouter: {
    login: vi.fn(),
    register: vi.fn(),
    me: vi.fn(),
    changePassword: vi.fn(),
  },
}));

// Mock the database connection module
vi.mock("../api/queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test without mock override");
  }),
}));

// Mock ws-manager to avoid WebSocket connections
vi.mock("../api/ws-manager", () => ({
  wsManager: {
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    broadcastToDashboard: vi.fn(),
    broadcastAgentUpdate: vi.fn(),
    broadcastTaskUpdate: vi.fn(),
    broadcastMessage: vi.fn(),
    isOnline: vi.fn(() => false),
    connect: vi.fn(),
    disconnect: vi.fn(),
    registerDashboard: vi.fn(),
    unregisterDashboard: vi.fn(),
    getOnlineAgents: vi.fn(() => []),
  },
}));

// Mock collaboration-events
vi.mock("../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));

// Mock password lib
vi.mock("../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});
