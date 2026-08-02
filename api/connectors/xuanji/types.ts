import { z } from "zod";
import { TraceIdSchema } from "../../contracts/platform";

export const XuanjiTraceSchema = z.object({
  traceId: TraceIdSchema,
  taskId: z.string().min(1).max(64),
  agentId: z.string().min(1).max(100),
  originSystem: z.literal("tiangong"),
});

const TagsSchema = z.array(z.string().min(1).max(100));

const SearchFiltersSchema = z.object({
  project: z.string().min(1).max(200).optional(),
  tags: TagsSchema.optional(),
  types: z.array(z.string().min(1).max(100)).optional(),
});

export const SearchContextRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  mode: z.enum(["keyword", "vector", "hybrid"]),
  limit: z.number().int().positive().max(50),
  filters: SearchFiltersSchema.optional(),
  trace: XuanjiTraceSchema,
});

export const SearchContextResponseSchema = z.object({
  results: z.array(z.object({
    kind: z.string().min(1).max(100),
    documentId: z.number().int().positive(),
    chunkId: z.number().int().positive(),
    title: z.string().min(1).max(500),
    snippet: z.string().min(1).max(5000),
    score: z.number(),
    source: z.string().min(1).max(100),
  })),
  graphHints: z.array(z.object({
    nodeId: z.number().int().positive(),
    title: z.string().min(1).max(255),
    type: z.string().min(1).max(100),
  })),
  memoryDigest: z.string().max(10000),
});

const TaskSnapshotSchema = z.object({
  taskId: z.string().min(1).max(64),
  traceId: TraceIdSchema,
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  status: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100),
});

const MemoryDecisionSchema = z.object({
  title: z.string().min(1).max(255),
  reason: z.string().min(1).max(2000),
});

const MemoryArtifactSchema = z.object({
  type: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  artifactRef: z.string().min(1).max(500),
});

const TaskMemorySchema = z.object({
  project: z.string().min(1).max(200),
  title: z.string().min(1).max(255),
  summary: z.string().min(1).max(5000),
  contentMarkdown: z.string().min(1),
  tags: TagsSchema,
  decisions: z.array(MemoryDecisionSchema),
  artifacts: z.array(MemoryArtifactSchema),
});

export const WriteTaskMemoryRequestSchema = z.object({
  task: TaskSnapshotSchema,
  memory: TaskMemorySchema,
  trace: XuanjiTraceSchema,
});

export const WriteTaskMemoryResponseSchema = z.object({
  documentId: z.number().int().positive(),
  nodeIds: z.array(z.number().int().positive()),
  edgeIds: z.array(z.number().int().positive()),
  chunkCount: z.number().int().nonnegative(),
  vectorized: z.boolean(),
});

const ArtifactLinkSchema = z.object({
  artifactRef: z.string().min(1).max(500),
  downloadUrl: z.string().url().max(1000).optional(),
  mimeType: z.string().min(1).max(100).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  size: z.number().int().nonnegative().optional(),
});

export const LinkArtifactRequestSchema = z.object({
  documentId: z.number().int().positive(),
  artifact: ArtifactLinkSchema,
  trace: XuanjiTraceSchema,
});

export const LinkArtifactResponseSchema = z.object({
  linked: z.boolean(),
  nodeId: z.number().int().positive(),
  edgeId: z.number().int().positive(),
});

export const GetMemoryDigestRequestSchema = z.object({
  project: z.string().min(1).max(200),
  scope: z.string().min(1).max(200),
  maxTokens: z.number().int().positive().max(100000),
  trace: XuanjiTraceSchema,
});

export const GetMemoryDigestResponseSchema = z.object({
  digest: z.string().max(20000),
  keyDecisions: z.array(z.string().min(1).max(2000)),
  openRisks: z.array(z.string().min(1).max(2000)),
  sourceDocumentIds: z.array(z.number().int().positive()),
});

const IngestionSourceSchema = z.object({
  kind: z.string().min(1).max(100),
  path: z.string().min(1).max(1000).optional(),
  dataSourceId: z.string().min(1).max(255).optional(),
  url: z.string().url().max(1000).optional(),
  artifactRef: z.string().min(1).max(500).optional(),
});

const IngestionOptionsSchema = z.object({
  project: z.string().min(1).max(200),
  tags: TagsSchema,
  vectorize: z.boolean(),
  discoverRelations: z.boolean(),
});

export const StartIngestionRequestSchema = z.object({
  sourceType: z.enum(["file", "directory", "datasource", "external"]),
  source: IngestionSourceSchema,
  options: IngestionOptionsSchema,
  trace: XuanjiTraceSchema,
});

export const StartIngestionResponseSchema = z.object({
  jobId: z.number().int().positive(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  itemCount: z.number().int().nonnegative(),
});

export type XuanjiTrace = Readonly<z.infer<typeof XuanjiTraceSchema>>;
export type SearchContextRequest = Readonly<z.infer<typeof SearchContextRequestSchema>>;
export type SearchContextResponse = Readonly<z.infer<typeof SearchContextResponseSchema>>;
export type WriteTaskMemoryRequest = Readonly<z.infer<typeof WriteTaskMemoryRequestSchema>>;
export type WriteTaskMemoryResponse = Readonly<z.infer<typeof WriteTaskMemoryResponseSchema>>;
export type LinkArtifactRequest = Readonly<z.infer<typeof LinkArtifactRequestSchema>>;
export type LinkArtifactResponse = Readonly<z.infer<typeof LinkArtifactResponseSchema>>;
export type GetMemoryDigestRequest = Readonly<z.infer<typeof GetMemoryDigestRequestSchema>>;
export type GetMemoryDigestResponse = Readonly<z.infer<typeof GetMemoryDigestResponseSchema>>;
export type StartIngestionRequest = Readonly<z.infer<typeof StartIngestionRequestSchema>>;
export type StartIngestionResponse = Readonly<z.infer<typeof StartIngestionResponseSchema>>;
