/**
 * Active Memory 模块 - 内存 Map 存储层 + Redis 存储层 + Session 管理 + 统一门面
 *
 * 本模块提供:
 * - InMemoryStore: 基于 JavaScript Map 的内存存储引擎（降级方案）
 * - RedisStore: 基于 ioredis 的 Redis 存储引擎（主存储 + 自动降级）
 * - SessionManager: Session 会话生命周期管理器
 * - ImportanceEvaluator: 重要性评估引擎（四因素加权模型）
 * - ActiveMemory: 统一门面（屏蔽双层存储细节）
 *
 * @module memory/active
 *
 * @example
 * ```typescript
 * import { InMemoryStore, RedisStore, SessionManager, ActiveMemory, ImportanceEvaluator } from '@mcc/core/memory/active';
 *
 * // 使用统一门面（推荐方式）
 * const memory = new ActiveMemory<string>();
 * await memory.initialize({ redis: { host: 'localhost', port: 6379 } });
 * await memory.write('key', 'value');
 * const value = await memory.read('key');
 *
 * // 使用底层存储（高级用法）
 * const memoryStore = new InMemoryStore({ maxSize: 500 });
 * memoryStore.write('key', 'value');
 *
 * // 使用 Redis 存储
 * const redisStore = new RedisStore({ host: 'localhost', port: 6379 });
 * await redisStore.connect();
 * await redisStore.write('key', 'value');
 *
 * // Session 管理
 * const sessionManager = new SessionManager(redisStore);
 * const session = await sessionManager.createSession();
 *
 * // Importance 评估
 * const evaluator = new ImportanceEvaluator();
 * const result = evaluator.evaluate('This is important', { sourceType: SourceType.USER_MANUAL });
 * ```
 */

// ---- 核心实现 ----

// 内存存储引擎 (Task 1A.1.2)
export { InMemoryStore, default as defaultInMemoryStore } from './inMemoryStore.js';

// Redis 存储引擎 (Task 1A.1.3.1 + Task 1A.1.3.2)
export { RedisStore, default as defaultRedisStore } from './redisStore.js';

// PostgreSQL 存储引擎 (Phase 1A.2)
export { PostgresStore } from './postgresStore.js';

// Session 管理器 (Task 1A.1.3.3)
export { SessionManager, default as defaultSessionManager } from './sessionContext.js';

// Importance 评估器 (Task 1A.1.4.4)
export {
  ImportanceEvaluator,
  default as defaultImportanceEvaluator,
} from './importanceEvaluator.js';

// Active Memory 统一门面 (Task 1A.1.4.1-1A.1.4.3)
export { ActiveMemory, default as defaultActiveMemory } from './activeMemory.js';

// ---- 类型导出 ----

// 内存存储相关类型
export type {
  IInMemoryStore,
  MemoryEntry,
  WriteOptions,
  InMemoryStoreConfig,
} from './types.js';

// Redis 存储相关类型
export type {
  IRedisStore,
  RedisConfig,
  RedisHealthStatus,
} from './types.js';

// PostgreSQL 存储相关类型
export type {
  IPostgresStore,
  PostgresConfig,
  PostgresHealthStatus,
  ThreeTierStoreConfig,
} from './types.js';

// Session 相关类型
export type {
  Session,
  SessionMessage,
  CreateMessageInput,
  ISessionManager,
} from './types.js';

// Active Memory 统一门面相关类型
export type {
  IActiveMemory,
  ActiveMemoryConfig,
  ActiveWriteOptions,
  WriteResult,
  ActiveMemoryStatus,
  ActiveMemoryHealthStatus,
} from './activeMemory.js';

// Importance 评估器相关类型
export type {
  SourceType,
  ImportanceLevel,
  ImportanceConfig,
  ImportanceResult,
  EvaluationContext,
  IImportanceEvaluator,
} from './importanceEvaluator.js';

// ---- 常量导出 ----

export {
  MAX_ACTIVE_MEMORY_SIZE,
  DEFAULT_TTL_MS,
  CLEANUP_INTERVAL_MS,
  HIGH_ACCESS_THRESHOLD,
} from './types.js';

// ---- 错误类型导出 ----

// 内存存储错误
export { MemoryStoreError } from './types.js';

// Redis 相关错误
export {
  RedisConnectionError,
  RedisOperationError,
  RedisDegradedError,
} from './types.js';

// PostgreSQL 相关错误
export {
  PostgresConnectionError,
  PostgresOperationError,
  PostgresDegradedError,
} from './types.js';
