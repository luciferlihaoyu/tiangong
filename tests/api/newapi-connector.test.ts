import { describe, expect, it } from "vitest";

import { NewApiClient, NewApiConnectorError } from "../../api/connectors/newapi/client";
import { createNewApiClient } from "../../api/connectors/newapi/service";
import {
  getUsageSummaryOutputSchema,
  listAvailableModelsOutputSchema,
} from "../../api/connectors/newapi/types";

type FetchCall = Readonly<{
  url: string;
  init: RequestInit | undefined;
}>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchMock(responses: readonly Response[]): Readonly<{
  calls: readonly FetchCall[];
  fetchImpl: typeof fetch;
}> {
  const calls: FetchCall[] = [];
  const pendingResponses = [...responses];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: fetchInputToString(input), init });
    const response = pendingResponses.shift();
    return response ?? jsonResponse({ data: [] });
  };
  return { calls, fetchImpl };
}

function fetchInputToString(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function createRejectingFetch(error: Error): typeof fetch {
  return async () => {
    throw error;
  };
}

function createClient(fetchImpl: typeof fetch): NewApiClient {
  return new NewApiClient({
    baseUrl: "https://newapi.example",
    adminToken: "secret-token",
    fetchImpl,
    timeoutMs: 10_000,
  });
}

function firstCall(calls: readonly FetchCall[]): FetchCall {
  const call = calls[0];
  if (!call) {
    throw new Error("expected fetch to be called");
  }
  return call;
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

async function expectConnectorError(action: () => Promise<unknown>): Promise<NewApiConnectorError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof NewApiConnectorError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected NewApiConnectorError");
}

describe("New API connector", () => {
  it("sends bearer admin token and query parameters when listing models", async () => {
    // Given
    const mockFetch = createFetchMock([jsonResponse({ data: [] })]);
    const client = createClient(mockFetch.fetchImpl);

    // When
    const result = await client.listAvailableModels({
      agentId: "opencode:main",
      taskType: "coding_task",
    });

    // Then
    const call = firstCall(mockFetch.calls);
    expect(result).toEqual([]);
    expect(call.url).toBe("https://newapi.example/api/models?agentId=opencode%3Amain&taskType=coding_task");
    expect(authorizationHeader(call.init)).toBe("Bearer secret-token");
  });

  it.each([
    { name: "raw array", body: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai", group: "default", enabled: true }] },
    { name: "data envelope", body: { data: [{ id: "claude", name: "Claude", provider: "anthropic", group: "paid", enabled: true }] } },
    { name: "nested result data envelope", body: { result: { data: [{ id: "kimi", name: "Kimi", provider: "moonshot", group: "cn", enabled: false }] } } },
  ])("unwraps $name response shapes", async ({ body }) => {
    // Given
    const client = createClient(createFetchMock([jsonResponse(body)]).fetchImpl);

    // When
    const models = await client.listAvailableModels();

    // Then
    expect(models).toHaveLength(1);
    expect(models[0]?.id).not.toBe("");
  });

  it.each([401, 500])("maps HTTP %s responses to typed connector errors", async (status) => {
    // Given
    const client = createClient(createFetchMock([jsonResponse({ error: "failed" }, status)]).fetchImpl);

    // When
    const error = await expectConnectorError(() => client.listModelChannels());

    // Then
    expect(error.code).toBe("http_error");
    expect(error.status).toBe(status);
    expect(error.message).toContain(String(status));
  });

  it("maps network rejections to typed connector errors", async () => {
    // Given
    const client = createClient(createRejectingFetch(new Error("socket closed")));

    // When
    const error = await expectConnectorError(() => client.getChannelHealth());

    // Then
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("socket closed");
  });

  it("returns null from the service factory when New API is unconfigured", () => {
    // Given
    const env = {};

    // When
    const client = createNewApiClient({ env });

    // Then
    expect(client).toBeNull();
  });

  it("defaults missing output fields while tolerating unknown JSON fields", () => {
    // Given
    const rawModels = [{ id: "model-a", unexpected: "ignored" }];
    const rawUsage = { byModel: [{ model: "model-a", extra: true }], ignored: "value" };

    // When
    const models = listAvailableModelsOutputSchema.parse(rawModels);
    const usage = getUsageSummaryOutputSchema.parse(rawUsage);

    // Then
    expect(models).toEqual([{ id: "model-a", name: "", provider: "", group: "", enabled: false }]);
    expect(usage).toEqual({
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      callCount: 0,
      costCents: 0,
      byModel: [
        {
          model: "model-a",
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          callCount: 0,
          costCents: 0,
        },
      ],
    });
  });
});
