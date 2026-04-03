/**
 * ActiveMemory - Active Memory 统一门面
 *
 * 实现功能:
 * - Task 1A.1.4.1: 统一 API 骨架（屏蔽 InMemoryStore 和 RedisStore 双层细节）
 * - Task 1A.1.4.2: 写入流程（双写策略：内存Map + Redis）
 * - Task 1A.1.4.3: 读取流程（Redis优先 + 回写机制）
 *
 * 核心设计原则:
 * - 对外提供统一接口，内部管理双层存储
 * - 降级透明化：Redis 故障时自动切换到纯内存模式
 * - 最终一致性：写入不要求强一致，接受短暂不一致
 * - 性能优先：读取路径优化，回写异步不阻塞
 *
 * @module activeMemory
 */

import logger from './logger.js';
import type {
  IInMemoryStore,
  IRedisStore,
  IPostgresStore,
  WriteOptions,
} from './types.js';
import { InMemoryStore } from './inMemoryStore.js';
import { RedisStore } from './redisStore.js';
import { PostgresStore } from './postgresStore.js';
import {
  MAX_ACTIVE_MEMORY_SIZE,
  DEFAULT_TTL_MS,
} from './types.js';
import type {
  ImportanceEvaluator,
  ImportanceResult,
  SourceType,
  ImportanceLevel,
  EvaluationContext,
} from './importanceEvaluator.js';
import { ImportanceEvaluator as DefaultImportanceEvaluator } from './importanceEvaluator.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * Active Memory 配置接口
 *
 * 用于初始化 ActiveMemory 实例的配置参数。
 */
export interface ActiveMemoryConfig {
  /** Redis 连接配置（可选，不配置则使用纯内存模式） */
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
  /** PostgreSQL 连接配置（可选，不配置则不使用持久化层） */
  postgres?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** 最大内存条目数，默认 MAX_ACTIVE_MEMORY_SIZE (1000) */
  maxMemorySize?: number;
  /** 默认 TTL (ms)，默认 DEFAULT_TTL_MS (24h) */
  defaultTtlMs?: number;
  /** 是否启用降级（Redis/PostgreSQL 不可用时切换到内存模式），默认 true */
  enableDegradation?: boolean;
  /** 写入策略: 'all' (同时写入三层) | 'cascade' (内存→Redis→PostgreSQL) */
  writeStrategy?: 'all' | 'cascade';
  /** 读取策略: 'hierarchical' (内存→Redis→PostgreSQL) | 'parallel' (同时查询) */
  readStrategy?: 'hierarchical' | 'parallel';
  /** 向量搜索阈值，默认 0.7 */
  vectorSearchThreshold?: number;
}

/**
 * Active Memory 写入选项
 *
 * 扩展基础 WriteOptions，增加 importance 评估相关的参数。
 */
export interface ActiveWriteOptions extends WriteOptions {
  /** 来源类型（用于 importance 评估） */
  sourceType?: SourceType;
  /** 手动覆写 importance 值 (0-1)，设置后跳过自动评估 */
  importanceOverride?: number;
}

/**
 * 写入结果
 *
 * 每次写入操作返回的详细信息。
 */
export interface WriteResult {
  /** 写入的键名 */
  key: string;
  /** 是否成功（至少写入了一层） */
  success: boolean;
  /** 重要性等级 */
  importance: ImportanceLevel;
  /** 重要性评分 (0-1) */
  importanceScore: number;
  /** 成功写入的目标层 */
  writtenTo: ('memory' | 'redis' | 'both' | 'postgres')[];
  /** 错误信息（如有） */
  error?: Error;
}

/**
 * Active Memory 状态信息
 *
 * 提供当前运行状态的快照。
 */
export interface ActiveMemoryStatus {
  /** 当前运行模式 */
  mode: 'normal' | 'degraded';
  /** 内存 Map 中的条目数 */
  memoryCount: number;
  /** Redis 中的条目数（如果可用） */
  redisCount: number;
  /** PostgreSQL 中的条目数（如果可用） */
  postgresCount: number;
  /** 总有效条目数 */
  totalSize: number;
  /** 运行时长 (ms) */
  uptime: number;
}

/**
 * Active Memory 健康状态
 *
 * 提供各组件的健康检查结果。
 */
export interface ActiveMemoryHealthStatus {
  /** 内存 Map 是否可用 */
  memory: boolean;
  /** Redis 是否可用 */
  redis: boolean;
  /** PostgreSQL 是否可用 */
  postgres: boolean;
  /** 当前运行模式 */
  mode: 'normal' | 'degraded';
  /** 最后一次错误（如有） */
  lastError?: Error;
}

/**
 * IActiveMemory 接口
 *
 * Active Memory 的统一公共 API。
 * 屏蔽底层存储细节，对外提供一致的内存访问接口。
 *
 * @template T - 存储值类型
 */
export interface IActiveMemory<T = unknown> {
  // ---- 初始化与连接 ----

  /**
   * 初始化 Active Memory
   *
   * 如果配置了 Redis，会自动建立连接。
   * 无论 Redis 是否可用，初始化都会成功（降级模式）。
   *
   * @param config - 可选的配置参数
   */
  initialize(config?: ActiveMemoryConfig): Promise<void>;

  /**
   * 销毁 Active Memory
   *
   * 清空所有数据，断开 Redis 连接，释放资源。
   */
  destroy(): Promise<void>;

  // ---- 核心读写（统一 API）----

  /**
   * 写入一个条目（双写策略）
   *
   * 写入流程:
   * 1. 计算 importance（调用 importanceEvaluator）
   * 2. 写入内存 Map (同步, ~0ms)
   * 3. 写入 Redis (异步, ~2-5ms)
   * 4. 返回 WriteResult
   *
   * @param key - 键名
   * @param value - 值
   * @param options - 写入选项
   * @returns 写入结果
   */
  write(key: string, value: T, options?: ActiveWriteOptions): Promise<WriteResult>;

  /**
   * 读取一个条目（Redis 优先）
   *
   * 读取流程:
   * 1. 尝试从 Redis 读取
   * 2. Redis Miss → 从内存 Map 读取
   * 3. 内存命中 → 异步触发"回写 Redis"
   *
   * @param key - 键名
   * @returns 值，不存在返回 null
   */
  read(key: string): Promise<T | null>;

  /**
   * 检查键是否存在
   *
   * @param key - 键名
   * @returns 是否存在
   */
  exists(key: string): Promise<boolean>;

  /**
   * 删除一个条目
   *
   * @param key - 键名
   * @returns 是否成功删除
   */
  delete(key: string): Promise<boolean>;

  /**
   * 清空所有条目
   */
  clear(): Promise<void>;

  /**
   * 获取所有有效的键
   *
   * @returns 键数组
   */
  keys(): Promise<string[]>;

  /**
   * 获取当前有效条目数
   *
   * @returns 条目数量
   */
  size(): Promise<number>;

  // ---- 批量操作 ----

  /**
   * 批量写入
   *
   * @param entries - 要写入的条目数组
   * @returns 每个条目的写入结果数组
   */
  writeBatch(
    entries: Array<{ key: string; value: T; options?: ActiveWriteOptions }>,
  ): Promise<WriteResult[]>;

  // ---- 状态查询 ----

  /**
   * 获取运行状态
   *
   * @returns 状态信息
   */
  getStatus(): ActiveMemoryStatus;

  /**
   * 获取健康状态
   *
   * @returns 健康状态
   */
  getHealthStatus(): ActiveMemoryHealthStatus;

  /**
   * 写入带向量嵌入的条目
   */
  writeWithEmbedding(key: string, value: T, embedding: number[], options?: ActiveWriteOptions): Promise<WriteResult>;

  /**
   * 搜索相似的条目
   */
  searchSimilar(embedding: number[], limit?: number, threshold?: number): Promise<Array<{ key: string; value: T; similarity: number }>>;
}

// ============================================================
// ActiveMemory 实现
// ============================================================

/**
 * Active Memory 统一门面
 *
 * 管理内存 Map 和 Redis 双层存储，提供统一的读写接口。
 * 自动处理降级、双写、回写等复杂逻辑。
 *
 * 特性:
 * - 双写策略：每次写入同时写内存和 Redis
 * - Redis 优先读取：读时优先查 Redis，Miss 再查内存
 * - 异步回写：内存命中但 Redis miss 时后台修复
 * - 降级透明：Redis 故障时自动切换到纯内存模式
 * - Importance 评估：自动评估每条数据的重要性
 *
 * @template T - 存储值类型
 * @implements IActiveMemory<T>
 *
 * @example
 * ```typescript
 * const memory = new ActiveMemory<string>();
 *
 * // 初始化（带 Redis）
 * await memory.initialize({
 *   redis: { host: 'localhost', port: 6379 },
 *   maxMemorySize: 500,
 * });
 *
 * // 写入数据
 * const result = await memory.write('user:1', 'Alice', {
 *   sourceType: SourceType.USER_MANUAL,
 * });
 * console.log(result.importance); // => 'high'
 *
 * // 读取数据
 * const value = await memory.read('user:1');
 * console.log(value); // => 'Alice'
 *
 * // 销毁
 * await memory.destroy();
 * ```
 */
export class ActiveMemory<T = unknown> implements IActiveMemory<T> {
  /** 内存 Map 存储层 */
  private memoryStore: IInMemoryStore<T>;

  /** Redis 存储层（可能为 null） */
  private redisStore: IRedisStore<T> | null = null;

  /** PostgreSQL 存储层（可能为 null） */
  private postgresStore: IPostgresStore<T> | null = null;

  /** 重要性评估器 */
  private importanceEvaluator: ImportanceEvaluator;

  /** 配置 */
  private config: {
    redis: ActiveMemoryConfig['redis'];
    postgres: ActiveMemoryConfig['postgres'];
    maxMemorySize: number;
    defaultTtlMs: number;
    enableDegradation: boolean;
    writeStrategy: 'all' | 'cascade';
    readStrategy: 'hierarchical' | 'parallel';
    vectorSearchThreshold: number;
  };

  /** 是否已初始化 */
  private initialized = false;

  /** 启动时间戳 */
  private startTime: number = 0;

  /** 最后一次错误 */
  private lastError: Error | undefined;

  /** 正在执行回写的键集合（防止并发重复回写） */
  private rewritingKeys = new Set<string>();

  /**
   * 创建 ActiveMemory 实例
   *
   * @param evaluator - 自定义的重要性评估器（可选，使用默认实现）
   */
  constructor(evaluator?: ImportanceEvaluator) {
    // 创建内存存储层（始终存在，作为降级方案）
    this.memoryStore = new InMemoryStore<T>();

    // 使用自定义或默认的 importance 评估器
    this.importanceEvaluator = evaluator ?? new DefaultImportanceEvaluator();

    // 默认配置（会在 initialize 时更新）
    this.config = {
      redis: undefined,
      postgres: undefined,
      maxMemorySize: MAX_ACTIVE_MEMORY_SIZE,
      defaultTtlMs: DEFAULT_TTL_MS,
      enableDegradation: true,
      writeStrategy: 'all',
      readStrategy: 'hierarchical',
      vectorSearchThreshold: 0.7,
    };
  }

  // ---- Task 1A.1.4.1: 初始化与连接 ----

  /**
   * 初始化 Active Memory
   *
   * 执行流程:
   * 1. 应用配置参数
   * 2. 如果配置了 Redis，尝试建立连接
   * 3. 启动内存存储层的定时清理
   * 4. 记录启动时间
   *
   * 关键设计：
   * - Redis 连接失败不会导致初始化失败（降级模式）
   * - 即使没有 Redis，系统也能正常工作（纯内存模式）
   *
   * @param config - 可选的配置参数
   */
  async initialize(config?: ActiveMemoryConfig): Promise<void> {
    if (this.initialized) {
      logger.warn(
        { module: 'active-memory', action: 'initialize-skipped' },
        'ActiveMemory already initialized',
      );
      return;
    }

    // 应用配置
    if (config) {
      this.config = {
        redis: config.redis,
        postgres: config.postgres,
        maxMemorySize: config.maxMemorySize ?? MAX_ACTIVE_MEMORY_SIZE,
        defaultTtlMs: config.defaultTtlMs ?? DEFAULT_TTL_MS,
        enableDegradation: config.enableDegradation ?? true,
        writeStrategy: config.writeStrategy ?? 'all',
        readStrategy: config.readStrategy ?? 'hierarchical',
        vectorSearchThreshold: config.vectorSearchThreshold ?? 0.7,
      };

      // 重建内存存储层以应用新配置（maxSize / defaultTtlMs）
      if (this.memoryStore) {
        this.memoryStore.stopCleanup();
        this.memoryStore.clear();
      }
      this.memoryStore = new InMemoryStore<T>({
        maxSize: this.config.maxMemorySize,
        defaultTtlMs: this.config.defaultTtlMs,
      });

      logger.info(
        {
          module: 'active-memory',
          action: 'reconfigure',
          maxMemorySize: this.config.maxMemorySize,
          defaultTtlMs: this.config.defaultTtlMs,
          writeStrategy: this.config.writeStrategy,
          readStrategy: this.config.readStrategy,
        },
        'InMemoryStore reconfigured with new settings',
      );
    }

    // 初始化 Redis（如果配置了）
    if (this.config.redis) {
      try {
        const redisConfig: Record<string, unknown> = {
          host: this.config.redis.host,
          port: this.config.redis.port,
          enableDegradation: this.config.enableDegradation,
        };

        // 只在 password 存在时添加
        if (this.config.redis.password !== undefined) {
          redisConfig.password = this.config.redis.password;
        }

        // 只在 db 存在时添加
        if (this.config.redis.db !== undefined) {
          redisConfig.db = this.config.redis.db;
        }

        this.redisStore = new RedisStore<T>(redisConfig as import('./types.js').RedisConfig);

        await this.redisStore.connect();

        logger.info(
          {
            module: 'active-memory',
            action: 'initialize',
            redisConfig: {
              host: this.config.redis.host,
              port: this.config.redis.port,
              db: this.config.redis.db,
            },
          },
          'ActiveMemory initialized with Redis backend',
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.lastError = error;

        logger.error(
          {
            module: 'active-memory',
            action: 'initialize-error',
            error: error.message,
          },
          `Failed to initialize Redis, running in degraded mode: ${error.message}`,
        );

        // Redis 初始化失败，使用纯内存模式
        this.redisStore = null;

        if (!this.config.enableDegradation) {
          throw error; // 不允许降级则抛出异常
        }

        logger.warn(
          { module: 'active-memory', action: 'degraded-mode' },
          'Running in degraded mode (memory only)',
        );
      }
    } else {
      logger.info(
        { module: 'active-memory', action: 'initialize' },
        'ActiveMemory initialized in memory-only mode',
      );
    }

    // 初始化 PostgreSQL（如果配置了）
    if (this.config.postgres) {
      try {
        const postgresConfig: import('./types.js').PostgresConfig = {
          host: this.config.postgres.host,
          port: this.config.postgres.port,
          user: this.config.postgres.user,
          password: this.config.postgres.password,
          database: this.config.postgres.database,
          enableDegradation: this.config.enableDegradation,
        };

        this.postgresStore = new PostgresStore<T>(postgresConfig);

        await this.postgresStore.connect();

        logger.info(
          {
            module: 'active-memory',
            action: 'initialize',
            postgresConfig: {
              host: this.config.postgres.host,
              port: this.config.postgres.port,
              database: this.config.postgres.database,
            },
          },
          'ActiveMemory initialized with PostgreSQL backend',
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.lastError = error;

        logger.error(
          {
            module: 'active-memory',
            action: 'initialize-error',
            error: error.message,
          },
          `Failed to initialize PostgreSQL, running without persistence: ${error.message}`,
        );

        // PostgreSQL 初始化失败，不使用持久化层
        this.postgresStore = null;

        if (!this.config.enableDegradation) {
          throw error; // 不允许降级则抛出异常
        }

        logger.warn(
          { module: 'active-memory', action: 'persistence-disabled' },
          'Running without persistence layer',
        );
      }
    } else {
      logger.info(
        { module: 'active-memory', action: 'initialize' },
        'ActiveMemory initialized without persistence layer',
      );
    }

    // 启动内存存储层的定时清理
    this.memoryStore.startCleanup();

    // 记录启动时间
    this.startTime = Date.now();
    this.initialized = true;

    logger.info(
      {
        module: 'active-memory',
        action: 'initialized',
        mode: this.getMode(),
        maxMemorySize: this.config.maxMemorySize,
        defaultTtlMs: this.config.defaultTtlMs,
      },
      'ActiveMemory ready',
    );
  }

  /**
   * 销毁 Active Memory
   *
   * 执行流程:
   * 1. 清空所有数据（内存 + Redis）
   * 2. 断开 Redis 连接
   * 3. 停止定时清理
   * 4. 重置状态
   */
  async destroy(): Promise<void> {
    logger.info(
      { module: 'active-memory', action: 'destroy' },
      'Destroying ActiveMemory...',
    );

    try {
      // 清空内存
      this.memoryStore.clear();
      this.memoryStore.stopCleanup();

      // 清空并断开 Redis
      if (this.redisStore) {
        try {
          await this.redisStore.clear();
          await this.redisStore.disconnect();
        } catch (err) {
          logger.warn(
            {
              module: 'active-memory',
              action: 'destroy-error',
              error: err instanceof Error ? err.message : String(err),
            },
            'Error during Redis cleanup',
          );
        }
        this.redisStore = null;
      }

      // 清空并断开 PostgreSQL
      if (this.postgresStore) {
        try {
          await this.postgresStore.clear();
          await this.postgresStore.disconnect();
        } catch (err) {
          logger.warn(
            {
              module: 'active-memory',
              action: 'destroy-error',
              error: err instanceof Error ? err.message : String(err),
            },
            'Error during PostgreSQL cleanup',
          );
        }
        this.postgresStore = null;
      }

      // 重置状态
      this.initialized = false;
      this.startTime = 0;
      this.lastError = undefined;

      logger.info(
        { module: 'active-memory', action: 'destroyed' },
        'ActiveMemory destroyed successfully',
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        {
          module: 'active-memory',
          action: 'destroy-failed',
          error: error.message,
        },
        'Failed to destroy ActiveMemory',
      );
      throw error;
    }
  }

  // ---- Task 1A.1.4.2: 写入流程（双写策略）----

  /**
   * 写入一个条目（双写策略）
   *
   * 写入流程:
   * ```
   * write(key, value, options)
   *     ↓
   * 1. 计算 importance（调用 importanceEvaluator）
   *    ↓
   * 2. 写入内存Map (InMemoryStore.write) — 同步，~0ms
   *    ↓
   * 3. 写入 Redis (RedisStore.write) — 异步，~2-5ms
   *    ├─ 成功 → 标记 writtenTo: ['memory', 'redis']
   *    └─ 失败/降级模式 → 标记 writtenTo: ['memory']，记录 warning 日志
   *    ↓
   * 4. 返回 WriteResult { success, importance, writtenTo }
   * ```
   *
   * 关键设计决策:
   * - 步骤2和3顺序执行（先写内存再写Redis）
   * - 步骤3失败时不回滚步骤2（最终一致性）
   * - 所有写入操作记录 Pino debug 日志
   *
   * @param key - 键名（非空字符串）
   * @param value - 存储的值
   * @param options - 写入选项（含 sourceType 和 importanceOverride）
   * @returns 写入结果（含 importance 评估和写入目标）
   *
   * @throws {Error} 未初始化时抛出
   *
   * @example
   * ```typescript
   * // 基础写入
   * const result = await memory.write('key1', 'value1');
   *
   * // 带 sourceType 的写入
   * const result2 = await memory.write('key2', 'critical fix', {
   *   sourceType: SourceType.USER_MANUAL,
   *   ttl: 3600000, // 1小时 TTL
   * });
   *
   * // 手动指定 importance
   * const result3 = await memory.write('key3', 'data', {
   *   importanceOverride: 0.9,
   * });
   * ```
   */
  async write(
    key: string,
    value: T,
    options?: ActiveWriteOptions,
  ): Promise<WriteResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    let importanceResult: ImportanceResult;

    // ---- Step 1: 计算 importance ----
    if (options?.importanceOverride !== undefined) {
      // 手动覆写 importance
      const score = Math.min(1, Math.max(0, options.importanceOverride));
      importanceResult = {
        score,
        level: this.scoreToLevel(score),
        breakdown: {
          sourceType: 0,
          contentLength: 0,
          agentMarker: 0,
          interactionDepth: 0,
        },
      };
    } else {
      // 自动评估 importance
      const evalContext: EvaluationContext = {};

      // 只在 sourceType 存在时添加
      if (options?.sourceType !== undefined) {
        evalContext.sourceType = options.sourceType;
      }

      // 将 value 转为字符串进行评估
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      importanceResult = this.importanceEvaluator.evaluate(valueStr, evalContext);
    }

    const writtenTo: ('memory' | 'redis' | 'both')[] = [];
    let writeError: Error | undefined;

    // ---- Step 2: 写入内存 Map（同步）----
    try {
      const memoryOptions: WriteOptions = {
        ttl: options?.ttl ?? this.config.defaultTtlMs,
      };

      // 只在 skipIfExists 存在时添加
      if (options?.skipIfExists !== undefined) {
        memoryOptions.skipIfExists = options.skipIfExists;
      }

      this.memoryStore.write(key, value, memoryOptions);
      writtenTo.push('memory');

      logger.debug(
        {
          module: 'active-memory',
          action: 'write-memory',
          key,
          importanceScore: importanceResult.score,
          importanceLevel: importanceResult.level,
          latency: Date.now() - startTime,
        },
        'Entry written to memory store',
      );
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err));

      logger.error(
        {
          module: 'active-memory',
          action: 'write-memory-error',
          key,
          error: writeError.message,
        },
        'Failed to write to memory store',
      );

      // 内存写入失败是致命错误，直接返回
      return {
        key,
        success: false,
        importance: importanceResult.level,
        importanceScore: importanceResult.score,
        writtenTo: [],
        error: writeError,
      };
    }

    // ---- Step 3: 写入 Redis（异步）----
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisOptions: WriteOptions = {
          ttl: options?.ttl ?? this.config.defaultTtlMs,
        };

        // 只在 skipIfExists 存在时添加
        if (options?.skipIfExists !== undefined) {
          redisOptions.skipIfExists = options.skipIfExists;
        }

        await this.redisStore.write(key, value, redisOptions);

        if (writtenTo.length === 1) {
          // 只有内存也成功了才标记为 both
          writtenTo[0] = 'both'; // 替换 'memory' 为 'both'
        } else {
          writtenTo.push('redis');
        }

        logger.debug(
          {
            module: 'active-memory',
            action: 'write-redis',
            key,
            importanceScore: importanceResult.score,
            latency: Date.now() - startTime,
          },
          'Entry written to Redis',
        );
      } catch (err) {
        const redisError = err instanceof Error ? err : new Error(String(err));
        this.lastError = redisError;

        logger.warn(
          {
            module: 'active-memory',
            action: 'write-redis-error',
            key,
            error: redisError.message,
            writtenTo: ['memory'], // 只写入了内存
          },
          `Failed to write to Redis (memory write succeeded): ${redisError.message}`,
        );

        // Redis 失败不影响整体结果（内存已成功）
        // writtenTo 保持为 ['memory']，表示部分成功
      }
    } else if (this.redisStore && !this.isRedisAvailable()) {
      // Redis 存在但不可用（降级模式）
      logger.debug(
        {
          module: 'active-memory',
          action: 'write-degraded',
          key,
          mode: this.redisStore.getMode(),
        },
        'Redis unavailable, writing to memory only',
      );
    }

    // ---- Step 4: 写入 PostgreSQL（异步）----
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        const postgresOptions: WriteOptions = {
          ttl: options?.ttl ?? this.config.defaultTtlMs,
        };

        // 只在 skipIfExists 存在时添加
        if (options?.skipIfExists !== undefined) {
          postgresOptions.skipIfExists = options.skipIfExists;
        }

        await this.postgresStore.write(key, value, postgresOptions);

        // 标记写入 PostgreSQL
        if (writtenTo.includes('both')) {
          // 内存和 Redis 都成功了
          // 保持 'both'，因为 PostgreSQL 是持久化层
        } else if (writtenTo.includes('memory') || writtenTo.includes('redis')) {
          // 至少有一层成功
          // 保持现有标记
        }

        logger.debug(
          {
            module: 'active-memory',
            action: 'write-postgres',
            key,
            importanceScore: importanceResult.score,
            latency: Date.now() - startTime,
          },
          'Entry written to PostgreSQL',
        );
      } catch (err) {
        const postgresError = err instanceof Error ? err : new Error(String(err));
        this.lastError = postgresError;

        logger.warn(
          {
            module: 'active-memory',
            action: 'write-postgres-error',
            key,
            error: postgresError.message,
            writtenTo,
          },
          `Failed to write to PostgreSQL (some writes succeeded): ${postgresError.message}`,
        );

        // PostgreSQL 失败不影响整体结果（内存/Redis 已成功）
      }
    } else if (this.postgresStore && !this.isPostgresAvailable()) {
      // PostgreSQL 存在但不可用（降级模式）
      logger.debug(
        {
          module: 'active-memory',
          action: 'write-persistence-degraded',
          key,
          mode: this.postgresStore.getMode(),
        },
        'PostgreSQL unavailable, writing to memory/Redis only',
      );
    }

    // ---- Step 4: 构建返回结果 ----
    const totalLatency = Date.now() - startTime;
    const success = writtenTo.length > 0;

    const result: WriteResult = {
      key,
      success,
      importance: importanceResult.level,
      importanceScore: importanceResult.score,
      writtenTo: writtenTo as ('memory' | 'redis' | 'both')[],
      ...(writeError ? { error: writeError } : {}),
    };

    logger.debug(
      {
        module: 'active-memory',
        action: 'write-complete',
        key,
        success,
        importanceLevel: result.importance,
        importanceScore: result.importanceScore,
        writtenTo: result.writtenTo,
        latency: totalLatency,
      },
      'Write operation completed',
    );

    return result;
  }

  // ---- Task 1A.1.4.3: 读取流程（Redis 优先）----

  /**
   * 读取一个条目（Redis 优先策略）
   *
   * 读取流程:
   * ```
   * read(key)
   *     ↓
   * 1. 尝试从 Redis 读取 (RedisStore.read)
   *    ├─ Hit → 更新访问元数据 → 返回 value
   *    └─ Miss/错误 → 进入步骤2
   *        ↓
   * 2. 从内存Map读取 (InMemoryStore.read)
   *    ├─ Hit → 异步触发"回写Redis"（后台尝试修复不一致）→ 返回 value
   *    └− Miss → 返回 null
   * ```
   *
   * 关键设计决策:
   * - Redis 优先：利用 Redis 的高性能和网络共享能力
   * - 回写机制：检测到不一致时后台修复，不阻塞读取
   * - 降级模式：直接跳过 Redis，只用内存 Map
   *
   * @param key - 键名
   * @returns 存储的值，不存在返回 null
   *
   * @throws {Error} 未初始化时抛出
   *
   * @example
   * ```typescript
   * const value = await memory.read('user:1');
   * if (value) {
   *   console.log(value); // => 'Alice'
   * }
   * ```
   */
  async read(key: string): Promise<T | null> {
    this.ensureInitialized();

    const startTime = Date.now();

    // ---- 分层读取策略 ----
    if (this.config.readStrategy === 'hierarchical') {
      return this.readHierarchical(key, startTime);
    } else {
      return this.readParallel(key, startTime);
    }
  }

  /**
   * 分层读取（内存 → Redis → PostgreSQL）
   */
  private async readHierarchical(key: string, startTime: number): Promise<T | null> {
    // Step 1: 从内存读取
    const memoryValue = this.memoryStore.read(key);
    if (memoryValue !== null) {
      logger.debug(
        {
          module: 'active-memory',
          action: 'read-memory-hit',
          key,
          strategy: 'hierarchical',
          latency: Date.now() - startTime,
        },
        'Read hit from memory',
      );
      return memoryValue;
    }

    // Step 2: 从 Redis 读取
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisValue = await this.redisStore.read(key);
        if (redisValue !== null) {
          // Redis Hit：同步更新内存 Map 的访问元数据
          this.memoryStore.read(key); // 触发 accessCount++

          logger.debug(
            {
              module: 'active-memory',
              action: 'read-redis-hit',
              key,
              strategy: 'hierarchical',
              latency: Date.now() - startTime,
            },
            'Read hit from Redis',
          );
          return redisValue;
        }
      } catch (err) {
        const redisError = err instanceof Error ? err : new Error(String(err));
        this.lastError = redisError;

        logger.warn(
          {
            module: 'active-memory',
            action: 'read-redis-error',
            key,
            error: redisError.message,
          },
          `Redis read failed, falling back to PostgreSQL: ${redisError.message}`,
        );
      }
    }

    // Step 3: 从 PostgreSQL 读取
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        const postgresValue = await this.postgresStore.read(key);
        if (postgresValue !== null) {
          // PostgreSQL Hit：异步回写到内存和 Redis
          this.scheduleRewriteToRedis(key, postgresValue);

          logger.debug(
            {
              module: 'active-memory',
              action: 'read-postgres-hit',
              key,
              strategy: 'hierarchical',
              latency: Date.now() - startTime,
            },
            'Read hit from PostgreSQL, scheduled async rewrite to memory/Redis',
          );
          return postgresValue;
        }
      } catch (err) {
        const postgresError = err instanceof Error ? err : new Error(String(err));
        this.lastError = postgresError;

        logger.warn(
          {
            module: 'active-memory',
            action: 'read-postgres-error',
            key,
            error: postgresError.message,
          },
          `PostgreSQL read failed: ${postgresError.message}`,
        );
      }
    }

    // 全部 Miss
    logger.debug(
      {
        module: 'active-memory',
        action: 'read-miss',
        key,
        strategy: 'hierarchical',
        latency: Date.now() - startTime,
      },
      'Read miss (not found in any layer)',
    );

    return null;
  }

  /**
   * 并行读取（同时查询三层）
   */
  private async readParallel(key: string, startTime: number): Promise<T | null> {
    const promises: Array<Promise<T | null>> = [];

    // 内存读取（同步转换为 Promise）
    promises.push(
      Promise.resolve().then(() => {
        const value = this.memoryStore.read(key);
        if (value !== null) {
          logger.debug(
            {
              module: 'active-memory',
              action: 'read-memory-hit',
              key,
              strategy: 'parallel',
            },
            'Parallel read hit from memory',
          );
        }
        return value;
      }),
    );

    // Redis 读取
    if (this.redisStore && this.isRedisAvailable()) {
      promises.push(
        this.redisStore.read(key).catch((err) => {
          const redisError = err instanceof Error ? err : new Error(String(err));
          this.lastError = redisError;
          logger.warn(
            {
              module: 'active-memory',
              action: 'read-redis-error',
              key,
              error: redisError.message,
            },
            `Parallel Redis read failed: ${redisError.message}`,
          );
          return null;
        }),
      );
    }

    // PostgreSQL 读取
    if (this.postgresStore && this.isPostgresAvailable()) {
      promises.push(
        this.postgresStore.read(key).catch((err) => {
          const postgresError = err instanceof Error ? err : new Error(String(err));
          this.lastError = postgresError;
          logger.warn(
            {
              module: 'active-memory',
              action: 'read-postgres-error',
              key,
              error: postgresError.message,
            },
            `Parallel PostgreSQL read failed: ${postgresError.message}`,
          );
          return null;
        }),
      );
    }

    // 等待所有读取完成
    const results = await Promise.all(promises);

    // 优先返回内存结果，然后是 Redis，最后是 PostgreSQL
    const value = results.find((v) => v !== null) || null;

    if (value !== null) {
      // 确保所有层都有最新数据
      this.scheduleRewriteToRedis(key, value);

      logger.debug(
        {
          module: 'active-memory',
          action: 'read-parallel-hit',
          key,
          strategy: 'parallel',
          latency: Date.now() - startTime,
        },
        'Parallel read hit',
      );
    } else {
      logger.debug(
        {
          module: 'active-memory',
          action: 'read-miss',
          key,
          strategy: 'parallel',
          latency: Date.now() - startTime,
        },
        'Parallel read miss (not found in any layer)',
      );
    }

    return value;
  }

  /**
   * 检查键是否存在
   *
   * @param key - 键名
   * @returns 是否存在
   */
  async exists(key: string): Promise<boolean> {
    this.ensureInitialized();

    // 优先检查 Redis
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisExists = await this.redisStore.exists(key);
        if (redisExists) {
          return true;
        }
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'exists-redis-error',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Redis exists check failed, falling back to memory',
        );
      }
    }

    // 回退到内存
    return this.memoryStore.exists(key);
  }

  /**
   * 删除一个条目
   *
   * 同时从内存、Redis 和 PostgreSQL 删除（如果可用）。
   * 任一删除失败不影响其他层的结果。
   *
   * @param key - 键名
   * @returns 是否至少在一层删除成功
   */
  async delete(key: string): Promise<boolean> {
    this.ensureInitialized();

    let memoryDeleted = false;
    let redisDeleted = false;
    let postgresDeleted = false;

    // 删除内存
    try {
      memoryDeleted = this.memoryStore.delete(key);
    } catch (err) {
      logger.error(
        {
          module: 'active-memory',
          action: 'delete-memory-error',
          key,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to delete from memory',
      );
    }

    // 删除 Redis
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        redisDeleted = await this.redisStore.delete(key);
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'delete-redis-error',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to delete from Redis',
        );
      }
    }

    // 删除 PostgreSQL
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        postgresDeleted = await this.postgresStore.delete(key);
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'delete-postgres-error',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to delete from PostgreSQL',
        );
      }
    }

    const success = memoryDeleted || redisDeleted || postgresDeleted;

    logger.debug(
      {
        module: 'active-memory',
        action: 'delete',
        key,
        success,
        memoryDeleted,
        redisDeleted,
        postgresDeleted,
      },
      'Delete operation completed',
    );

    return success;
  }

  /**
   * 清空所有条目
   *
   * 同时清空内存、Redis 和 PostgreSQL。
   */
  async clear(): Promise<void> {
    this.ensureInitialized();

    // 清空内存
    this.memoryStore.clear();

    // 清空 Redis
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        await this.redisStore.clear();
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'clear-redis-error',
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to clear Redis',
        );
      }
    }

    // 清空 PostgreSQL
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        await this.postgresStore.clear();
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'clear-postgres-error',
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to clear PostgreSQL',
        );
      }
    }

    logger.info(
      { module: 'active-memory', action: 'clear' },
      'All entries cleared',
    );
  }

  /**
   * 写入带向量嵌入的条目
   */
  async writeWithEmbedding(
    key: string,
    value: T,
    embedding: number[],
    options?: ActiveWriteOptions,
  ): Promise<WriteResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    let importanceResult: ImportanceResult;

    // ---- Step 1: 计算 importance ----
    if (options?.importanceOverride !== undefined) {
      // 手动覆写 importance
      const score = Math.min(1, Math.max(0, options.importanceOverride));
      importanceResult = {
        score,
        level: this.scoreToLevel(score),
        breakdown: {
          sourceType: 0,
          contentLength: 0,
          agentMarker: 0,
          interactionDepth: 0,
        },
      };
    } else {
      // 自动评估 importance
      const evalContext: EvaluationContext = {};

      // 只在 sourceType 存在时添加
      if (options?.sourceType !== undefined) {
        evalContext.sourceType = options.sourceType;
      }

      // 将 value 转为字符串进行评估
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      importanceResult = this.importanceEvaluator.evaluate(valueStr, evalContext);
    }

    const writtenTo: ('memory' | 'redis' | 'postgres')[] = [];
    let writeError: Error | undefined;

    // ---- Step 2: 写入内存 Map（同步）----
    try {
      const memoryOptions: WriteOptions = {
        ttl: options?.ttl ?? this.config.defaultTtlMs,
      };

      // 只在 skipIfExists 存在时添加
      if (options?.skipIfExists !== undefined) {
        memoryOptions.skipIfExists = options.skipIfExists;
      }

      this.memoryStore.write(key, value, memoryOptions);
      writtenTo.push('memory');

      logger.debug(
        {
          module: 'active-memory',
          action: 'write-memory',
          key,
          importanceScore: importanceResult.score,
          importanceLevel: importanceResult.level,
          latency: Date.now() - startTime,
        },
        'Entry written to memory store',
      );
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err));

      logger.error(
        {
          module: 'active-memory',
          action: 'write-memory-error',
          key,
          error: writeError.message,
        },
        'Failed to write to memory store',
      );

      // 内存写入失败是致命错误，直接返回
      return {
        key,
        success: false,
        importance: importanceResult.level,
        importanceScore: importanceResult.score,
        writtenTo: [],
        error: writeError,
      };
    }

    // ---- Step 3: 写入 Redis（异步）----
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisOptions: WriteOptions = {
          ttl: options?.ttl ?? this.config.defaultTtlMs,
        };

        // 只在 skipIfExists 存在时添加
        if (options?.skipIfExists !== undefined) {
          redisOptions.skipIfExists = options.skipIfExists;
        }

        await this.redisStore.write(key, value, redisOptions);
        writtenTo.push('redis');

        logger.debug(
          {
            module: 'active-memory',
            action: 'write-redis',
            key,
            importanceScore: importanceResult.score,
            importanceLevel: importanceResult.level,
            latency: Date.now() - startTime,
          },
          'Entry written to Redis store',
        );
      } catch (err) {
        const redisError = err instanceof Error ? err : new Error(String(err));

        logger.warn(
          {
            module: 'active-memory',
            action: 'write-redis-error',
            key,
            error: redisError.message,
          },
          'Failed to write to Redis store',
        );

        // Redis 写入失败不影响整体结果
      }
    }

    // ---- Step 4: 写入 PostgreSQL（异步）----
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        const postgresOptions: WriteOptions = {
          ttl: options?.ttl ?? this.config.defaultTtlMs,
        };

        // 只在 skipIfExists 存在时添加
        if (options?.skipIfExists !== undefined) {
          postgresOptions.skipIfExists = options.skipIfExists;
        }

        await this.postgresStore.writeWithEmbedding(key, value, embedding, postgresOptions);
        writtenTo.push('postgres');

        logger.debug(
          {
            module: 'active-memory',
            action: 'write-postgres',
            key,
            importanceScore: importanceResult.score,
            importanceLevel: importanceResult.level,
            latency: Date.now() - startTime,
          },
          'Entry written to PostgreSQL store',
        );
      } catch (err) {
        const postgresError = err instanceof Error ? err : new Error(String(err));

        logger.warn(
          {
            module: 'active-memory',
            action: 'write-postgres-error',
            key,
            error: postgresError.message,
          },
          'Failed to write to PostgreSQL store',
        );

        // PostgreSQL 写入失败不影响整体结果
      }
    }

    const result: WriteResult = {
      key,
      success: writtenTo.length > 0,
      importance: importanceResult.level,
      importanceScore: importanceResult.score,
      writtenTo,
    };

    if (writeError) {
      result.error = writeError;
    }

    return result;
  }

  /**
   * 搜索相似的条目
   */
  async searchSimilar(
    embedding: number[],
    limit: number = 5,
    threshold: number = 0.7,
  ): Promise<Array<{ key: string; value: T; similarity: number }>> {
    this.ensureInitialized();

    const startTime = Date.now();
    const results: Array<{ key: string; value: T; similarity: number }> = [];

    // 搜索 PostgreSQL（如果可用）
    if (this.postgresStore && this.isPostgresAvailable()) {
      try {
        const postgresResults = await this.postgresStore.searchSimilar(embedding, limit, threshold);
        results.push(...postgresResults);
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'search-postgres-error',
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to search similar in PostgreSQL',
        );
      }
    }

    // 按相似度排序并限制结果数量
    results.sort((a, b) => b.similarity - a.similarity);
    const finalResults = results.slice(0, limit);

    logger.debug(
      {
        module: 'active-memory',
        action: 'search-similar',
        embeddingLength: embedding.length,
        limit,
        threshold,
        resultCount: finalResults.length,
        latency: Date.now() - startTime,
      },
      'Similarity search completed',
    );

    return finalResults;
  }

  /**
   * 获取所有有效的键
   *
   * 合并内存和 Redis 的键列表（去重）。
   *
   * @returns 去重后的键数组
   */
  async keys(): Promise<string[]> {
    this.ensureInitialized();

    const memoryKeys = this.memoryStore.keys();
    let allKeys = new Set(memoryKeys);

    // 合并 Redis 的键
    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisKeys = await this.redisStore.keys();
        for (const key of redisKeys) {
          allKeys.add(key);
        }
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'keys-redis-error',
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to get keys from Redis, returning memory keys only',
        );
      }
    }

    return Array.from(allKeys);
  }

  /**
   * 获取当前有效条目数
   *
   * 取两层中较大的值（近似总数）。
   *
   * @returns 条目数量
   */
  async size(): Promise<number> {
    this.ensureInitialized();

    const memorySize = this.memoryStore.size();

    if (this.redisStore && this.isRedisAvailable()) {
      try {
        const redisSize = await this.redisStore.size();
        // 返回较大值（因为可能有延迟同步）
        return Math.max(memorySize, redisSize);
      } catch (err) {
        logger.warn(
          {
            module: 'active-memory',
            action: 'size-redis-error',
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to get size from Redis, returning memory size',
        );
      }
    }

    return memorySize;
  }

  // ---- 批量操作 ----

  /**
   * 批量写入
   *
   * 并行执行多个写入操作，返回每个操作的结果。
   *
   * @param entries - 要写入的条目数组
   * @returns 每个条目的写入结果数组（与输入顺序对应）
   */
  async writeBatch(
    entries: Array<{ key: string; value: T; options?: ActiveWriteOptions }>,
  ): Promise<WriteResult[]> {
    this.ensureInitialized();

    // 并行执行所有写入
    const results = await Promise.all(
      entries.map((entry) => this.write(entry.key, entry.value, entry.options)),
    );

    logger.info(
      {
        module: 'active-memory',
        action: 'write-batch',
        count: entries.length,
        successCount: results.filter((r) => r.success).length,
      },
      'Batch write completed',
    );

    return results;
  }

  // ---- 状态查询 ----

  /**
   * 获取运行状态
   *
   * @returns 状态快照
   */
  getStatus(): ActiveMemoryStatus {
    const memoryCount = this.memoryStore.size();
    let redisCount = 0;
    let postgresCount = 0;

    if (this.redisStore) {
      // 注意：这里是同步方法，无法 await redisStore.size()
      // 返回近似值或 0（需要异步获取准确值时可调用 size()）
      redisCount = 0; // 占位符，实际应通过异步方法获取
    }

    if (this.postgresStore) {
      // 注意：这里是同步方法，无法 await postgresStore.size()
      postgresCount = 0; // 占位符，实际应通过异步方法获取
    }

    return {
      mode: this.getMode(),
      memoryCount,
      redisCount,
      postgresCount,
      totalSize: memoryCount, // 近似值
      uptime: this.initialized ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * 获取健康状态
   *
   * @returns 健康状态
   */
  getHealthStatus(): ActiveMemoryHealthStatus {
    const status: ActiveMemoryHealthStatus = {
      memory: true, // 内存总是可用
      redis: this.redisStore ? this.isRedisAvailable() : false,
      postgres: this.postgresStore ? this.isPostgresAvailable() : false,
      mode: this.getMode(),
    };

    if (this.lastError !== undefined) {
      status.lastError = this.lastError;
    }

    return status;
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 确保已初始化
   *
   * @private
   * @throws {Error} 未初始化时抛出
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ActiveMemory not initialized. Call initialize() first.');
    }
  }

  /**
   * 获取当前运行模式
   *
   * @returns 'normal' 或 'degraded'
   * @private
   */
  private getMode(): 'normal' | 'degraded' {
    if (!this.redisStore) {
      return 'degraded'; // 无 Redis 配置视为降级模式
    }
    return this.redisStore.getMode();
  }

  /**
   * 检查 Redis 是否可用
   *
   * @returns 是否可用
   * @private
   */
  private isRedisAvailable(): boolean {
    if (!this.redisStore) {
      return false;
    }

    // 检查是否在正常模式且已连接
    return (
      this.redisStore.getMode() === 'normal' &&
      this.redisStore.isConnected()
    );
  }

  /**
   * 检查 PostgreSQL 是否可用
   *
   * @returns 是否可用
   * @private
   */
  private isPostgresAvailable(): boolean {
    if (!this.postgresStore) {
      return false;
    }

    // 检查是否在正常模式且已连接
    return (
      this.postgresStore.getMode() === 'normal' &&
      this.postgresStore.isConnected()
    );
  }

  /**
   * 异步调度回写到 Redis
   *
   * 当从内存读取到数据但 Redis 中没有时，
   * 后台尝试将数据写回 Redis 以修复不一致。
   *
   * 使用 queueMicrotask 不阻塞当前执行流程。
   * 回写失败仅记录日志，不影响读取结果。
   *
   * @param key - 键名
   * @param value - 值
   * @private
   */
  private scheduleRewriteToRedis(key: string, value: T): void {
    if (!this.redisStore || !this.isRedisAvailable()) {
      return;
    }

    if (this.rewritingKeys.has(key)) {
      logger.debug(
        { module: 'active-memory', action: 'rewrite-dedup', key },
        'Rewrite skipped: key is already being rewritten',
      );
      return;
    }

    this.rewritingKeys.add(key);

    queueMicrotask(async () => {
      try {
        const existing = await this.redisStore!.read(key);
        if (existing !== null) {
          logger.debug(
            { module: 'active-memory', action: 'rewrite-skipped', key, reason: 'already-exists' },
            'Rewrite skipped: key already exists in Redis',
          );
          return;
        }

        await this.redisStore!.write(key, value, {
          ttl: this.config.defaultTtlMs,
        });

        logger.debug(
          { module: 'active-memory', action: 'rewrite-success', key },
          'Async rewrite to Redis completed',
        );
      } catch (err) {
        logger.debug(
          {
            module: 'active-memory',
            action: 'rewrite-failed',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Async rewrite to Redis failed (non-critical)',
        );
      } finally {
        this.rewritingKeys.delete(key);
      }
    });
  }

  /**
   * 将分数转换为重要性等级
   *
   * @param score - 0-1 的分数
   * @returns 重要性等级
   * @private
   */
  private scoreToLevel(score: number): ImportanceLevel {
    // 导入 ImportanceLevel 的判断逻辑（避免循环依赖）
    // 这里使用硬编码阈值，与 ImportanceEvaluator 保持一致
    if (score >= 0.5) {
      return 'high' as ImportanceLevel;
    } else if (score >= 0.3) {
      return 'medium' as ImportanceLevel;
    } else {
      return 'low' as ImportanceLevel;
    }
  }
}

// ============================================================
// 导出
// ============================================================

export default ActiveMemory;
