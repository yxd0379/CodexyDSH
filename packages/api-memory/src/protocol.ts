/** Owned memory method descriptors on the fixed platform Remote protocol. */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

const memory_edit_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_edit_parameter_1Schema = () => z.object({
  'path': z.string().readonly(),
  'content': z.string().readonly(),
  'expectedRevision': z.intersection(z.string(), z.unknown()).readonly(),
});
const memory_edit_resultSchema = () => z.intersection(z.string(), z.unknown());
const memory_list_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_list_parameter_1Schema = () => z.object({
  'path': z.string().readonly().optional(),
  'cursor': z.string().readonly().optional(),
  'max_results': z.number().readonly().optional(),
});
const memory_list_resultSchema = () => z.object({
  'path': z.union([z.literal(null), z.string()]).readonly(),
  'entries': z.array(z.object({
  'path': z.string().readonly(),
  'entry_type': z.union([z.literal("file"), z.literal("directory")]).readonly(),
})).readonly(),
  'next_cursor': z.union([z.literal(null), z.string()]).readonly(),
  'truncated': z.boolean().readonly(),
});
const memory_read_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_read_parameter_1Schema = () => z.object({
  'path': z.string().readonly(),
  'line_offset': z.number().readonly().optional(),
  'max_lines': z.number().readonly().optional(),
});
const memory_read_resultSchema = () => z.object({
  'path': z.string().readonly(),
  'start_line_number': z.number().readonly(),
  'content': z.string().readonly(),
  'truncated': z.boolean().readonly(),
  'revision': z.intersection(z.string(), z.unknown()).readonly(),
});
const memory_refresh_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_refresh_resultSchema = () => z.object({
  'extracted': z.number().readonly(),
  'skipped': z.number().readonly(),
  'consolidated': z.boolean().readonly(),
  'revision': z.intersection(z.string(), z.unknown()).readonly().optional(),
});
const memory_search_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_search_parameter_1Schema = () => z.object({
  'queries': z.array(z.string()).readonly(),
  'match_mode': z.union([z.object({
  'type': z.union([z.literal("any"), z.literal("all_on_same_line")]).readonly(),
}), z.object({
  'type': z.literal("all_within_lines").readonly(),
  'line_count': z.number().readonly(),
})]).readonly().optional(),
  'path': z.string().readonly().optional(),
  'cursor': z.string().readonly().optional(),
  'context_lines': z.number().readonly().optional(),
  'case_sensitive': z.boolean().readonly().optional(),
  'normalized': z.boolean().readonly().optional(),
  'max_results': z.number().readonly().optional(),
});
const memory_search_resultSchema = () => z.object({
  'queries': z.array(z.string()).readonly(),
  'match_mode': z.union([z.object({
  'type': z.union([z.literal("any"), z.literal("all_on_same_line")]).readonly(),
}), z.object({
  'type': z.literal("all_within_lines").readonly(),
  'line_count': z.number().readonly(),
})]).readonly(),
  'path': z.union([z.literal(null), z.string()]).readonly(),
  'matches': z.array(z.object({
  'path': z.string().readonly(),
  'match_line_number': z.number().readonly(),
  'content_start_line_number': z.number().readonly(),
  'content': z.string().readonly(),
  'matched_queries': z.array(z.string()).readonly(),
})).readonly(),
  'next_cursor': z.union([z.literal(null), z.string()]).readonly(),
  'truncated': z.boolean().readonly(),
});
const memory_snapshot_parameter_0Schema = () => z.intersection(z.string(), z.unknown());
const memory_snapshot_resultSchema = () => z.object({
  'root': z.string().readonly(),
  'version': z.union([z.literal("v1"), z.literal("v2")]).readonly(),
  'summary': z.string().readonly(),
  'running': z.boolean().readonly(),
  'revision': z.intersection(z.string(), z.unknown()).readonly().optional(),
  'updatedAt': z.number().readonly().optional(),
  'lastError': z.string().readonly().optional(),
});

/** Strict codecs for the product's methods; shared by Host and Client. */
export const invocations: readonly InvocationDescriptor[] = [
    {
      id: '@codexydsh/api-memory#memory/edit',
      service: 'memoryController',
      namespace: 'memory',
      method: 'edit',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_edit_parameter_0Schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@codexydsh/memory/types#MemoryEditRequest',
            create: memory_edit_parameter_1Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemoryRevision',
        create: memory_edit_resultSchema,
      },
    },
    {
      id: '@codexydsh/api-memory#memory/list',
      service: 'memoryController',
      namespace: 'memory',
      method: 'list',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_list_parameter_0Schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@codexydsh/memory/types#MemoryListRequest',
            create: memory_list_parameter_1Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemoryList',
        create: memory_list_resultSchema,
      },
    },
    {
      id: '@codexydsh/api-memory#memory/read',
      service: 'memoryController',
      namespace: 'memory',
      method: 'read',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_read_parameter_0Schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@codexydsh/memory/types#MemoryReadRequest',
            create: memory_read_parameter_1Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemoryRead',
        create: memory_read_resultSchema,
      },
    },
    {
      id: '@codexydsh/api-memory#memory/refresh',
      service: 'memoryController',
      namespace: 'memory',
      method: 'refresh',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_refresh_parameter_0Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemoryRefreshResult',
        create: memory_refresh_resultSchema,
      },
    },
    {
      id: '@codexydsh/api-memory#memory/search',
      service: 'memoryController',
      namespace: 'memory',
      method: 'search',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_search_parameter_0Schema,
          },
        },
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@codexydsh/memory/types#MemorySearchRequest',
            create: memory_search_parameter_1Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemorySearch',
        create: memory_search_resultSchema,
      },
    },
    {
      id: '@codexydsh/api-memory#memory/snapshot',
      service: 'memoryController',
      namespace: 'memory',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      scope: {
        context: 'agent',
        wire: 'agentId',
      },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          source: 'lookup',
          lookup: 'agent',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
            create: memory_snapshot_parameter_0Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/memory/types#MemorySnapshot',
        create: memory_snapshot_resultSchema,
      },
    },
  ]
