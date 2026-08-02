import { describe, expect, it } from "vitest";

import { buildSeedAgents, type SeedAgent } from "../../db/seed";

const expectedAgentIds = [
  "tiangong-manager",
  "openclaw:research",
  "openclaw:writing",
  "openclaw:media-image",
  "openclaw:media-video",
  "openclaw:data",
  "openclaw:strategy",
  "openclaw:qa",
  "openclaw:coordinator",
  "openclaw:coding-analysis",
  "opencode:main",
] as const;

const allowedSources = ["system", "openclaw", "opencode"] as const;

const requiredCardKeys = [
  "kind",
  "displayName",
  "source",
  "capabilities",
  "modelPolicyRef",
  "knowledgePolicyRef",
  "artifactPolicyRef",
  "permissions",
] as const;

const requiredPermissionKeys = [
  "canExecuteCode",
  "canAccessFiles",
  "canCallExternalNetwork",
  "canWriteGithub",
  "canDeployZeabur",
  "canSendExternalMessage",
] as const;

type ExpectedAgentId = (typeof expectedAgentIds)[number];
type AllowedSource = (typeof allowedSources)[number];

type SeedAgentCard = {
  readonly kind: string;
  readonly displayName: string;
  readonly source: AllowedSource;
  readonly capabilities: readonly string[];
  readonly modelPolicyRef: string;
  readonly knowledgePolicyRef: string;
  readonly artifactPolicyRef: string;
  readonly permissions: {
    readonly canExecuteCode: boolean;
    readonly canAccessFiles: boolean;
    readonly canCallExternalNetwork: boolean;
    readonly canWriteGithub: boolean;
    readonly canDeployZeabur: boolean;
    readonly canSendExternalMessage: boolean;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedSource(value: unknown): value is AllowedSource {
  return typeof value === "string" && allowedSources.some((source) => source === value);
}

function isExpectedAgentId(agentId: string): agentId is ExpectedAgentId {
  return expectedAgentIds.some((expectedAgentId) => expectedAgentId === agentId);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasBooleanPermissions(value: unknown): value is SeedAgentCard["permissions"] {
  if (!isRecord(value)) {
    return false;
  }

  return requiredPermissionKeys.every((permissionKey) => typeof value[permissionKey] === "boolean");
}

function isSeedAgentCard(value: unknown): value is SeedAgentCard {
  if (!isRecord(value)) {
    return false;
  }

  return requiredCardKeys.every((key) => Object.hasOwn(value, key))
    && typeof value["kind"] === "string"
    && typeof value["displayName"] === "string"
    && isAllowedSource(value["source"])
    && isStringArray(value["capabilities"])
    && typeof value["modelPolicyRef"] === "string"
    && typeof value["knowledgePolicyRef"] === "string"
    && typeof value["artifactPolicyRef"] === "string"
    && hasBooleanPermissions(value["permissions"]);
}

function parseAgentCard(agent: SeedAgent): SeedAgentCard {
  const parsed: unknown = JSON.parse(agent.agentCard ?? "null");
  if (!isSeedAgentCard(parsed)) {
    throw new TypeError(`Invalid agentCard for ${agent.agentId}`);
  }
  return parsed;
}

function getExpectedSeedAgents(): SeedAgent[] {
  return buildSeedAgents().filter((agent) => isExpectedAgentId(agent.agentId));
}

describe("Agent capability seed", () => {
  it("lists all expected capability agents without duplicate agentIds", () => {
    // Given
    const seedAgents = buildSeedAgents();

    // When
    const agentIds = seedAgents.map((agent) => agent.agentId);
    const uniqueAgentIds = new Set(agentIds);

    // Then
    expect(uniqueAgentIds.size).toBe(agentIds.length);
    for (const expectedAgentId of expectedAgentIds) {
      expect(agentIds).toContain(expectedAgentId);
    }
  });

  it("defines complete agentCards for every expected capability agent", () => {
    // Given
    const expectedSeedAgents = getExpectedSeedAgents();

    // When
    const cards = expectedSeedAgents.map((agent) => ({ agent, card: parseAgentCard(agent) }));

    // Then
    expect(cards).toHaveLength(expectedAgentIds.length);
    for (const { agent, card } of cards) {
      for (const key of requiredCardKeys) {
        expect(Object.hasOwn(card, key)).toBe(true);
      }
      for (const permissionKey of requiredPermissionKeys) {
        expect(Object.hasOwn(card.permissions, permissionKey)).toBe(true);
      }
      expect(agent.capabilities).toBe(JSON.stringify(card.capabilities));
    }
  });

  it("uses routable sources for the seed capability agents", () => {
    // Given
    const expectedSeedAgents = getExpectedSeedAgents();

    // When
    const sources = expectedSeedAgents.map((agent) => agent.source);

    // Then
    expect(expectedSeedAgents).toHaveLength(expectedAgentIds.length);
    for (const source of sources) {
      expect(isAllowedSource(source)).toBe(true);
    }
  });

  it("applies constrained permissions to manager and opencode agents", () => {
    // Given
    const cardsByAgentId = new Map(
      getExpectedSeedAgents().map((agent) => [agent.agentId, parseAgentCard(agent)])
    );

    // When
    const managerCard = cardsByAgentId.get("tiangong-manager");
    const opencodeCard = cardsByAgentId.get("opencode:main");

    // Then
    expect(managerCard?.permissions.canWriteGithub).toBe(false);
    expect(managerCard?.permissions.canDeployZeabur).toBe(false);
    expect(opencodeCard?.permissions.canExecuteCode).toBe(true);
  });
});
