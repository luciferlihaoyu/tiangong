import { z, type ZodType } from "zod";
import {
  GetMemoryDigestRequestSchema,
  GetMemoryDigestResponseSchema,
  LinkArtifactRequestSchema,
  LinkArtifactResponseSchema,
  SearchContextRequestSchema,
  SearchContextResponseSchema,
  StartIngestionRequestSchema,
  StartIngestionResponseSchema,
  WriteTaskMemoryRequestSchema,
  WriteTaskMemoryResponseSchema,
  type GetMemoryDigestRequest,
  type GetMemoryDigestResponse,
  type LinkArtifactRequest,
  type LinkArtifactResponse,
  type SearchContextRequest,
  type SearchContextResponse,
  type StartIngestionRequest,
  type StartIngestionResponse,
  type WriteTaskMemoryRequest,
  type WriteTaskMemoryResponse,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
export type FetchImplementation = typeof fetch;
export type XuanjiConnectorMethod =
  | "searchContext"
  | "writeTaskMemory"
  | "linkArtifact"
  | "getMemoryDigest"
  | "startIngestion";
export type XuanjiConnectorErrorCode = "http_error" | "network_error" | "invalid_response";

export type XuanjiConnectorClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
}>;

type XuanjiConnectorErrorParams = Readonly<{
  code: XuanjiConnectorErrorCode;
  message: string;
  status?: number;
  cause?: unknown;
}>;

type AbortRequest = Readonly<{
  signal: AbortSignal;
  cleanup: () => void;
}>;

const FetchImplementationSchema = z.custom<FetchImplementation>(
  (value) => typeof value === "function"
);

const XuanjiConnectorClientConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  fetchImpl: FetchImplementationSchema.optional(),
});

export class XuanjiConnectorError extends Error {
  readonly name = "XuanjiConnectorError";
  readonly code: XuanjiConnectorErrorCode;
  readonly status?: number;

  constructor(params: XuanjiConnectorErrorParams) {
    super(params.message, { cause: params.cause });
    this.code = params.code;
    this.status = params.status;
  }
}

export class XuanjiConnectorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(config: XuanjiConnectorClientConfig) {
    const parsed = XuanjiConnectorClientConfigSchema.parse(config);
    this.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
    this.apiKey = parsed.apiKey;
    this.timeoutMs = parsed.timeoutMs;
    this.fetchImpl = parsed.fetchImpl ?? fetch;
  }

  searchContext(input: SearchContextRequest): Promise<SearchContextResponse> {
    return this.post(
      "searchContext",
      SearchContextRequestSchema.parse(input),
      SearchContextResponseSchema
    );
  }

  writeTaskMemory(input: WriteTaskMemoryRequest): Promise<WriteTaskMemoryResponse> {
    return this.post(
      "writeTaskMemory",
      WriteTaskMemoryRequestSchema.parse(input),
      WriteTaskMemoryResponseSchema
    );
  }

  linkArtifact(input: LinkArtifactRequest): Promise<LinkArtifactResponse> {
    return this.post(
      "linkArtifact",
      LinkArtifactRequestSchema.parse(input),
      LinkArtifactResponseSchema
    );
  }

  getMemoryDigest(input: GetMemoryDigestRequest): Promise<GetMemoryDigestResponse> {
    return this.post(
      "getMemoryDigest",
      GetMemoryDigestRequestSchema.parse(input),
      GetMemoryDigestResponseSchema
    );
  }

  startIngestion(input: StartIngestionRequest): Promise<StartIngestionResponse> {
    return this.post(
      "startIngestion",
      StartIngestionRequestSchema.parse(input),
      StartIngestionResponseSchema
    );
  }

  private async post<ResponseData>(
    methodName: XuanjiConnectorMethod,
    input: unknown,
    responseSchema: ZodType<ResponseData>
  ): Promise<ResponseData> {
    const abortRequest = this.createAbortRequest();
    const url = `${this.baseUrl}/api/connector.${methodName}`;

    try {
      const response = await this.executeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(input),
        signal: abortRequest.signal,
      }, methodName);

      if (!response.ok) {
        throw new XuanjiConnectorError({
          code: "http_error",
          status: response.status,
          message: `Xuanji ${methodName} failed with HTTP ${response.status}`,
        });
      }

      const payload = await this.readJson(response, methodName);
      return this.unwrapTrpcData(payload, responseSchema, methodName);
    } finally {
      abortRequest.cleanup();
    }
  }

  private async executeFetch(
    url: string,
    init: RequestInit,
    methodName: XuanjiConnectorMethod
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof Error) {
        throw new XuanjiConnectorError({
          code: "network_error",
          message: `Xuanji ${methodName} request failed: ${error.message}`,
          cause: error,
        });
      }
      throw new XuanjiConnectorError({
        code: "network_error",
        message: `Xuanji ${methodName} request failed`,
        cause: error,
      });
    }
  }

  private async readJson(response: Response, methodName: XuanjiConnectorMethod): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw new XuanjiConnectorError({
          code: "invalid_response",
          status: response.status,
          message: `Xuanji ${methodName} returned invalid JSON`,
          cause: error,
        });
      }
      throw new XuanjiConnectorError({
        code: "invalid_response",
        status: response.status,
        message: `Xuanji ${methodName} returned invalid JSON`,
        cause: error,
      });
    }
  }

  private unwrapTrpcData<ResponseData>(
    payload: unknown,
    responseSchema: ZodType<ResponseData>,
    methodName: XuanjiConnectorMethod
  ): ResponseData {
    try {
      return z.object({
        result: z.object({
          data: responseSchema,
        }),
      }).parse(payload).result.data;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new XuanjiConnectorError({
          code: "invalid_response",
          message: `Xuanji ${methodName} returned an invalid tRPC envelope`,
          cause: error,
        });
      }
      throw error;
    }
  }

  private createAbortRequest(): AbortRequest {
    if (typeof AbortSignal.timeout === "function") {
      return {
        signal: AbortSignal.timeout(this.timeoutMs),
        cleanup: () => undefined,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timeout),
    };
  }
}
