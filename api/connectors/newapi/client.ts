import type { ZodType } from "zod";

import {
  getChannelHealthOutputSchema,
  getModelPolicyInputSchema,
  getModelPolicyOutputSchema,
  getUsageSummaryInputSchema,
  getUsageSummaryOutputSchema,
  listAvailableModelsInputSchema,
  listAvailableModelsOutputSchema,
  listModelChannelsOutputSchema,
} from "./types";
import type {
  GetChannelHealthOutput,
  GetModelPolicyInput,
  GetModelPolicyOutput,
  GetUsageSummaryInput,
  GetUsageSummaryOutput,
  ListAvailableModelsInput,
  ListAvailableModelsOutput,
  ListModelChannelsOutput,
} from "./types";

export type NewApiConnectorErrorCode = "http_error" | "network_error" | "invalid_response";

export type NewApiConnectorErrorInput = Readonly<{
  code: NewApiConnectorErrorCode;
  message: string;
  status?: number;
  cause?: unknown;
}>;

export class NewApiConnectorError extends Error {
  readonly code: NewApiConnectorErrorCode;
  readonly status?: number;

  constructor(input: NewApiConnectorErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "NewApiConnectorError";
    this.code = input.code;
    this.status = input.status;
  }
}

export type NewApiClientConfig = Readonly<{
  baseUrl: string;
  adminToken: string;
  basePath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

type QueryValue = string | number | boolean | undefined;
type QueryParams = Readonly<Record<string, QueryValue>>;

const defaultBasePath = "/api/";
const defaultTimeoutMs = 15_000;

export class NewApiClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: NewApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.basePath = config.basePath ?? defaultBasePath;
    this.adminToken = config.adminToken;
    this.timeoutMs = normalizeTimeoutMs(config.timeoutMs);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async listAvailableModels(input: ListAvailableModelsInput = {}): Promise<ListAvailableModelsOutput> {
    const parsed = listAvailableModelsInputSchema.parse(input);
    return this.get("models", listAvailableModelsOutputSchema, parsed);
  }

  async listModelChannels(): Promise<ListModelChannelsOutput> {
    return this.get("channels", listModelChannelsOutputSchema);
  }

  async getUsageSummary(input: GetUsageSummaryInput = {}): Promise<GetUsageSummaryOutput> {
    const parsed = getUsageSummaryInputSchema.parse(input);
    return this.get("usage", getUsageSummaryOutputSchema, parsed);
  }

  async getChannelHealth(): Promise<GetChannelHealthOutput> {
    return this.get("channels/health", getChannelHealthOutputSchema);
  }

  async getModelPolicy(input: GetModelPolicyInput): Promise<GetModelPolicyOutput> {
    const parsed = getModelPolicyInputSchema.parse(input);
    return this.get("models/policy", getModelPolicyOutputSchema, { agentId: parsed.agentId });
  }

  private async get<Output>(path: string, outputSchema: ZodType<Output>, query: QueryParams = {}): Promise<Output> {
    const url = this.buildUrl(path, query);
    const response = await this.fetchResponse(url);
    const body = await parseResponseBody(response);
    const parsed = outputSchema.safeParse(unwrapEnvelope(body));
    if (!parsed.success) {
      throw new NewApiConnectorError({
        code: "invalid_response",
        message: "New API returned an invalid response",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async fetchResponse(url: URL): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.adminToken}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new NewApiConnectorError({
        code: "network_error",
        message: `New API request failed: ${message}`,
        cause: error,
      });
    }

    if (!response.ok) {
      throw new NewApiConnectorError({
        code: "http_error",
        message: `New API request failed with status ${response.status}`,
        status: response.status,
      });
    }
    return response;
  }

  private buildUrl(path: string, query: QueryParams): URL {
    const url = new URL(this.baseUrl);
    const pathParts = [url.pathname, this.basePath, path]
      .map((part) => part.replace(/^\/+|\/+$/gu, ""))
      .filter((part) => part.length > 0);
    url.pathname = `/${pathParts.join("/")}`;
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return defaultTimeoutMs;
  }
  return Math.trunc(timeoutMs);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new NewApiConnectorError({
      code: "invalid_response",
      message: "New API returned non-JSON response body",
      cause: error,
    });
  }
}

function unwrapEnvelope(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  const result = body.result;
  if (isRecord(result) && "data" in result) {
    return result.data;
  }
  if ("data" in body) {
    return body.data;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
