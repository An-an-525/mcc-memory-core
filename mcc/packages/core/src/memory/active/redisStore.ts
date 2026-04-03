/**
 * RedisStore - 基于 ioredis 的 Redis 存储引擎
 *
 * 实现功能:
 * - Task 1A.1.3.1: Redis 读写接口（String + Hash + List 模式）
 * - Task 1A.1.3.2: 降级备选逻辑（Redis 不可用时自动切换到 InMemoryStore）
 * - 连接管理与自动重连
 * - TTL 支持
 * - 健康检查与状态监控
 *
 * @module redisStore
 */

import Redis from 'ioredis';
import type {
  IRedisStore,
  RedisConfig,
  RedisHealthStatus,
  WriteOptions,
} from './types.js';
import logger from './logger.js';
import {
  RedisConnectionError,
  RedisOperationError,
} from './types.js';
import { InMemoryStore } from './inMemoryStore.js';
import { DEFAULT_TTL_MS } from './types.js';

// ============================================================
// 常量定义
// ============================================================

/** 默认降级触发阈值（连续失败次数） */
const DEFAULT_DEGRADATION_THRESHOLD = 3;

/** 默认恢复阈值（连续成功次数） */
const DEFAULT_RECOVERY_THRESHOLD = 3;

/** 默认 PING 超时阈值 (ms) */
const DEFAULT_PING_TIMEOUT_MS = 3000;

/** 熔断器状态类型 */
type CircuitState = 'closed' | 'open' | 'half-open';

/** Half-Open 冷却时间 (ms) - Open 状态后等待多久才允许探测请求 */
const DEFAULT_COOLDOWN_MS = 30_000;

/** Half-Open 状态下允许的探测请求数 - 连续成功多少次才恢复到 Closed */
const HALF_OPEN_PROBE_LIMIT = 3;

/** MCC 默认键命名空间前缀 */
const MCC_KEY_PREFIX = 'mcc:';

// ============================================================
// RedisStore 实现
// ============================================================

/**
 * 基于 ioredis 的 Redis 存储引擎
 *
 * 特性:
 * - 完整的 CRUD 操作（String/Hash/List）
 * - 自动降级到 InMemoryStore（Redis 故障时）
 * - 连接池管理与自动重连
 * - TTL 支持
 * - 健康检查与状态监控
 * - 函数式设计，避免深层继承
 *
 * @template T - 存储值类型
 * @implements IRedisStore<T>
 *
 * @example
 * ```typescript
 * const store = new RedisStore({ host: 'localhost', port: 6379 });
 * await store.connect();
 * await store.write('key', 'value');
 * const value = await store.read('key'); // => 'value'
 * ```
 */
export class RedisStore<T = unknown> implements IRedisStore<T> {
  /** Redis 客户端实例 */
  private redis: Redis | null = null;

  /** 配置 */
  private readonly config: {
    host: string;
    port: number;
    password: string | undefined;
    db: number;
    maxRetriesPerRequest: number;
    connectTimeout: number;
    commandTimeout: number;
    minPoolSize: number;
    maxPoolSize: number;
    enableDegradation: boolean;
    degradationThreshold: number;
    recoveryThreshold: number;
    pingTimeoutMs: number;
  };

  /** 降级 fallback (InMemoryStore) */
  private readonly fallback: InMemoryStore<T>;

  /** 当前模式 */
  private mode: 'normal' | 'degraded' = 'normal';

  /** 熔断器状态（三态：closed / open / half-open） */
  private circuitState: CircuitState = 'closed';

  /** 连续失败计数器 */
  private consecutiveFailures = 0;

  /** 连续成功计数器 */
  private consecutiveSuccesses = 0;

  /** Half-Open 状态下的探测请求成功计数 */
  private halfOpenProbeCount = 0;

  /** 进入 Open 状态的时间戳（用于 cooldown 计算） */
  private openedAt: number = 0;

  /** 最后一次错误 */
  private lastError: Error | undefined;

  /** 是否已连接 */
  private connected = false;

  /**
   * 创建 RedisStore 实例
   *
   * @param config - Redis 配置
   */
  constructor(config?: RedisConfig) {
    // 合并默认配置
    this.config = {
      host: config?.host ?? 'localhost',
      port: config?.port ?? 6379,
      password: config?.password,
      db: config?.db ?? 0,
      maxRetriesPerRequest: config?.maxRetriesPerRequest ?? 3,
      connectTimeout: config?.connectTimeout ?? 5000,
      commandTimeout: config?.commandTimeout ?? 3000,
      minPoolSize: config?.minPoolSize ?? 2,
      maxPoolSize: config?.maxPoolSize ?? 10,
      enableDegradation: config?.enableDegradation ?? true,
      degradationThreshold: config?.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD,
      recoveryThreshold: config?.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD,
      pingTimeoutMs: config?.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    };

    // 创建降级 fallback
    this.fallback = new InMemoryStore<T>({
      maxSize: 1000,
      defaultTtlMs: DEFAULT_TTL_MS,
    });

    logger.info(
      {
        module: 'redis-store',
        action: 'init',
        config: {
          host: this.config.host,
          port: this.config.port,
          db: this.config.db,
          enableDegradation: this.config.enableDegradation,
        },
      },
      'RedisStore initialized',
    );
  }

  // ---- 连接管理 ----

  /**
   * 建立 Redis 连接
   *
   * @throws {RedisConnectionError} 连接失败时抛出
   */
  async connect(): Promise<void> {
    if (this.connected && this.redis !== null) {
      logger.debug(
        { module: 'redis-store', action: 'connect-skipped' },
        'Already connected',
      );
      return;
    }

    try {
      // 创建 Redis 客户端
      this.redis = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db,
        maxRetriesPerRequest: this.config.maxRetriesPerRequest,
        connectTimeout: this.config.connectTimeout,
        lazyConnect: false,
        retryStrategy: (times) => {
          const delay = Math.min(times * 100, 3000);
          logger.debug(
            {
              module: 'redis-store',
              action: 'retry',
              attempt: times,
              delay,
            },
            'Redis connection retrying',
          );
          return delay;
        },
        // 连接池配置（ioredis 内置）
        enableReadyCheck: true,
        enableOfflineQueue: true,
      });

      // 监听连接事件
      this.redis.on('connect', () => {
        logger.info(
          { module: 'redis-store', action: 'connected' },
          'Redis connected',
        );
        this.connected = true;
        this.consecutiveSuccesses = 0;
      });

      this.redis.on('close', () => {
        logger.warn(
          { module: 'redis-store', action: 'disconnected' },
          'Redis connection closed',
        );
        this.connected = false;
        this.handleConnectionLoss();
      });

      this.redis.on('error', (err) => {
        logger.error(
          {
            module: 'redis-store',
            action: 'error',
            error: err.message,
          },
          'Redis error',
        );
        this.lastError = err;
      });

      // 等待连接就绪
      await this.redis.ping();

      logger.info(
        { module: 'redis-store', action: 'connect-success' },
        'Redis connection established',
      );
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error(String(err));
      this.lastError = error;
      throw new RedisConnectionError(
        `Failed to connect to Redis: ${error.message}`,
        'CONNECT_FAILED',
        error,
      );
    }
  }

  /**
   * 断开 Redis 连接
   */
  async disconnect(): Promise<void> {
    if (this.redis === null) {
      return;
    }

    try {
      await this.redis.quit();
      logger.info(
        { module: 'redis-store', action: 'disconnect' },
        'Redis disconnected gracefully',
      );
    } catch (err) {
      logger.warn(
        {
          module: 'redis-store',
          action: 'disconnect-error',
          error: err instanceof Error ? err.message : String(err),
        },
        'Error disconnecting Redis',
      );
    } finally {
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * 当前是否已连接
   *
   * @returns 是否已连接
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null && this.redis.status === 'ready';
  }

  // ---- 基础 CRUD (异步) ----

  private withPrefix(key: string): string {
    return `${MCC_KEY_PREFIX}${key}`;
  }

  /**
   * 写入一个条目
   *
   * @param key - 键名
   * @param value - 值
   * @param options - 写入选项
   */
  async write(
    key: string,
    value: T,
    options?: WriteOptions,
  ): Promise<void> {
    if (this.isInDegradedMode()) {
      // 降级模式：使用 InMemoryStore
      this.fallback.write(key, value, options);
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      const ttl = options?.ttl ?? DEFAULT_TTL_MS;

      if (options?.skipIfExists) {
        // 使用 SETNX 实现 skipIfExists
        const exists = await this.redis!.exists(this.withPrefix(key));
        if (exists > 0) {
          logger.debug(
            { module: 'redis-store', action: 'write-skipped', key },
            'Write skipped: key already exists and skipIfExists=true',
          );
          return;
        }
      }

      // 使用 SETEX 设置 TTL
      if (ttl > 0) {
        await this.redis!.setex(this.withPrefix(key), Math.floor(ttl / 1000), serialized);
      } else {
        await this.redis!.set(this.withPrefix(key), serialized);
      }

      this.recordSuccess();
      logger.debug(
        { module: 'redis-store', action: 'write', key, ttl },
        'Entry written to Redis',
      );
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        // 已降级：使用 fallback
        this.fallback.write(key, value, options);
        return;
      }
      throw new RedisOperationError(
        `Failed to write key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'WRITE_FAILED',
        'write',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 读取一个条目
   *
   * @param key - 键名
   * @returns 值，不存在返回 null
   */
  async read(key: string): Promise<T | null> {
    if (this.isInDegradedMode()) {
      // 降级模式：使用 InMemoryStore
      return this.fallback.read(key);
    }

    try {
      const value = await this.redis!.get(this.withPrefix(key));

      if (value === null) {
        return null;
      }

      try {
        const parsed = JSON.parse(value) as T;
        this.recordSuccess();
        return parsed;
      } catch (parseErr) {
        logger.error(
          {
            module: 'redis-store',
            action: 'parse-error',
            key,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          },
          'Failed to parse JSON value',
        );
        return null;
      }
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        // 已降级：使用 fallback
        return this.fallback.read(key);
      }
      throw new RedisOperationError(
        `Failed to read key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'READ_FAILED',
        'read',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 检查键是否存在
   *
   * @param key - 键名
   * @returns 是否存在
   */
  async exists(key: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      return this.fallback.exists(key);
    }

    try {
      const result = await this.redis!.exists(this.withPrefix(key));
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.exists(key);
      }
      throw new RedisOperationError(
        `Failed to check existence of key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'EXISTS_FAILED',
        'exists',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 删除一个条目
   *
   * @param key - 键名
   * @returns 是否成功删除
   */
  async delete(key: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      return this.fallback.delete(key);
    }

    try {
      const result = await this.redis!.del(this.withPrefix(key));
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.delete(key);
      }
      throw new RedisOperationError(
        `Failed to delete key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'DELETE_FAILED',
        'delete',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 清空所有条目
   *
   * @param prefix - 可选的前缀过滤（默认使用 MCC_KEY_PREFIX）
   */
  async clear(prefix?: string): Promise<void> {
    if (this.isInDegradedMode()) {
      this.fallback.clear();
      return;
    }

    try {
      const searchPrefix = prefix ?? MCC_KEY_PREFIX;
      const keysToDelete = await this.scanKeys(`${searchPrefix}*`);

      if (keysToDelete.length > 0) {
        // 分批删除（每批 500 个 key），避免单次 DEL 阻塞
        const BATCH_SIZE = 500;
        for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
          const batch = keysToDelete.slice(i, i + BATCH_SIZE);
          await this.redis!.del(...batch);
        }
      }

      this.recordSuccess();
      logger.info(
        { module: 'redis-store', action: 'clear', prefix: searchPrefix, count: keysToDelete.length },
        'Cleared Redis entries with prefix',
      );
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        this.fallback.clear();
        return;
      }
      throw new RedisOperationError(
        `Failed to clear Redis: ${err instanceof Error ? err.message : String(err)}`,
        'CLEAR_FAILED',
        'clear',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 获取所有匹配模式的键
   *
   * @param pattern - glob 模式
   * @returns 键数组
   */
  async keys(pattern = '*'): Promise<string[]> {
    if (this.isInDegradedMode()) {
      return this.fallback.keys();
    }

    try {
      const result = await this.scanKeys(`${MCC_KEY_PREFIX}${pattern}`);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.keys();
      }
      throw new RedisOperationError(
        `Failed to get keys: ${err instanceof Error ? err.message : String(err)}`,
        'KEYS_FAILED',
        'keys',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 获取当前存储的条目数
   *
   * @returns 条目数量
   */
  async size(): Promise<number> {
    if (this.isInDegradedMode()) {
      return this.fallback.size();
    }

    try {
      const result = await this.redis!.dbsize();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.size();
      }
      throw new RedisOperationError(
        `Failed to get size: ${err instanceof Error ? err.message : String(err)}`,
        'SIZE_FAILED',
        'size',
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ---- TTL 相关 ----

  /**
   * 设置指定 key 的 TTL
   *
   * @param key - 键名
   * @param ttlMs - 新的 TTL (毫秒)
   * @returns 是否设置成功
   */
  async setTTL(key: string, ttlMs: number): Promise<boolean> {
    if (this.isInDegradedMode()) {
      return this.fallback.setTTL(key, ttlMs);
    }

    try {
      const result = await this.redis!.expire(this.withPrefix(key), Math.floor(ttlMs / 1000));
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.setTTL(key, ttlMs);
      }
      throw new RedisOperationError(
        `Failed to set TTL for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'SET_TTL_FAILED',
        'setTTL',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 获取指定 key 的剩余 TTL
   *
   * @param key - 键名
   * @returns 剩余 TTL (毫秒)，不存在返回 null
   */
  async getTTL(key: string): Promise<number | null> {
    if (this.isInDegradedMode()) {
      return this.fallback.getTTL(key);
    }

    try {
      const ttlSec = await this.redis!.ttl(this.withPrefix(key));
      this.recordSuccess();

      if (ttlSec < 0) {
        // -1: 没有设置过期时间
        // -2: key 不存在
        return ttlSec === -1 ? 0 : null;
      }

      return ttlSec * 1000;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.getTTL(key);
      }
      throw new RedisOperationError(
        `Failed to get TTL for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'GET_TTL_FAILED',
        'getTTL',
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ---- Hash 操作 ----

  /**
   * 写入 Hash 字段
   *
   * @param key - Hash 键名
   * @param field - 字段名
   * @param value - 字段值
   */
  async hashWrite(
    key: string,
    field: string,
    value: unknown,
  ): Promise<void> {
    if (this.isInDegradedMode()) {
      // 降级模式：使用 String 存储 JSON
      const existing = this.fallback.read(key) as Record<string, unknown> | null;
      const hash = existing ?? {};
      hash[field] = value;
      this.fallback.write(key, hash as T);
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      await this.redis!.hset(this.withPrefix(key), field, serialized);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const existing = this.fallback.read(key) as Record<string, unknown> | null;
        const hash = existing ?? {};
        hash[field] = value;
        this.fallback.write(key, hash as T);
        return;
      }
      throw new RedisOperationError(
        `Failed to write hash field "${field}" in key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_WRITE_FAILED',
        'hashWrite',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 读取 Hash 字段
   *
   * @param key - Hash 键名
   * @param field - 字段名
   * @returns 字段值，不存在返回 null
   */
  async hashRead(
    key: string,
    field: string,
  ): Promise<unknown | null> {
    if (this.isInDegradedMode()) {
      const hash = this.fallback.read(key) as Record<string, unknown> | null;
      return hash?.[field] ?? null;
    }

    try {
      const value = await this.redis!.hget(this.withPrefix(key), field);
      if (value === null) {
        return null;
      }
      this.recordSuccess();
      return JSON.parse(value);
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const hash = this.fallback.read(key) as Record<string, unknown> | null;
        return hash?.[field] ?? null;
      }
      throw new RedisOperationError(
        `Failed to read hash field "${field}" in key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_READ_FAILED',
        'hashRead',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 读取 Hash 所有字段
   *
   * @param key - Hash 键名
   * @returns 字段-值映射
   */
  async hashReadAll(key: string): Promise<Record<string, unknown>> {
    if (this.isInDegradedMode()) {
      return (this.fallback.read(key) as Record<string, unknown>) ?? {};
    }

    try {
      const hash = await this.redis!.hgetall(this.withPrefix(key));
      this.recordSuccess();

      // 反序列化所有值
      const result: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(hash)) {
        try {
          result[field] = JSON.parse(value);
        } catch {
          result[field] = value;
        }
      }
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return (this.fallback.read(key) as Record<string, unknown>) ?? {};
      }
      throw new RedisOperationError(
        `Failed to read all hash fields in key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_READ_ALL_FAILED',
        'hashReadAll',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 删除 Hash 字段
   *
   * @param key - Hash 键名
   * @param field - 字段名
   * @returns 是否成功删除
   */
  async hashDelete(key: string, field: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      const hash = this.fallback.read(key) as Record<string, unknown> | null;
      if (hash && field in hash) {
        delete hash[field];
        this.fallback.write(key, hash as T);
        return true;
      }
      return false;
    }

    try {
      const result = await this.redis!.hdel(this.withPrefix(key), field);
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const hash = this.fallback.read(key) as Record<string, unknown> | null;
        if (hash && field in hash) {
          delete hash[field];
          this.fallback.write(key, hash as T);
          return true;
        }
        return false;
      }
      throw new RedisOperationError(
        `Failed to delete hash field "${field}" in key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_DELETE_FAILED',
        'hashDelete',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 删除整个 Hash
   *
   * @param key - Hash 键名
   * @returns 是否成功删除
   */
  async hashDeleteKey(key: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      return this.fallback.delete(key);
    }

    try {
      const result = await this.redis!.del(this.withPrefix(key));
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.delete(key);
      }
      throw new RedisOperationError(
        `Failed to delete hash key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_DELETE_KEY_FAILED',
        'hashDeleteKey',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 检查 Hash 中字段是否存在
   *
   * @param key - Hash 键名
   * @param field - 字段名
   * @returns 是否存在
   */
  async hashExists(key: string, field: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      const hash = this.fallback.read(key) as Record<string, unknown> | null;
      return hash !== null && field in hash;
    }

    try {
      const result = await this.redis!.hexists(this.withPrefix(key), field);
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const hash = this.fallback.read(key) as Record<string, unknown> | null;
        return hash !== null && field in hash;
      }
      throw new RedisOperationError(
        `Failed to check hash field "${field}" existence in key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'HASH_EXISTS_FAILED',
        'hashExists',
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ---- List 操作 ----

  /**
   * 向 List 左侧推入元素
   *
   * @param key - List 键名
   * @param value - 元素值
   * @returns 推入后 List 的长度
   */
  async listPushLeft(key: string, value: unknown): Promise<number> {
    if (this.isInDegradedMode()) {
      // 降级模式：使用数组模拟
      const existing = this.fallback.read(key) as unknown[] | null;
      const list = existing ?? [];
      list.unshift(value);
      this.fallback.write(key, list as T);
      return list.length;
    }

    try {
      const serialized = JSON.stringify(value);
      const result = await this.redis!.lpush(this.withPrefix(key), serialized);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const existing = this.fallback.read(key) as unknown[] | null;
        const list = existing ?? [];
        list.unshift(value);
        this.fallback.write(key, list as T);
        return list.length;
      }
      throw new RedisOperationError(
        `Failed to push left to list "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'LIST_PUSH_LEFT_FAILED',
        'listPushLeft',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 向 List 右侧推入元素
   *
   * @param key - List 键名
   * @param value - 元素值
   * @returns 推入后 List 的长度
   */
  async listPushRight(key: string, value: unknown): Promise<number> {
    if (this.isInDegradedMode()) {
      // 降级模式：使用数组模拟
      const existing = this.fallback.read(key) as unknown[] | null;
      const list = existing ?? [];
      list.push(value);
      this.fallback.write(key, list as T);
      return list.length;
    }

    try {
      const serialized = JSON.stringify(value);
      const result = await this.redis!.rpush(this.withPrefix(key), serialized);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const existing = this.fallback.read(key) as unknown[] | null;
        const list = existing ?? [];
        list.push(value);
        this.fallback.write(key, list as T);
        return list.length;
      }
      throw new RedisOperationError(
        `Failed to push right to list "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'LIST_PUSH_RIGHT_FAILED',
        'listPushRight',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 获取 List 范围内的元素
   *
   * @param key - List 键名
   * @param start - 起始索引
   * @param stop - 结束索引
   * @returns 元素数组
   */
  async listRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<unknown[]> {
    if (this.isInDegradedMode()) {
      const list = this.fallback.read(key) as unknown[] | null;
      if (!list) {
        return [];
      }
      // 处理负数索引
      const len = list.length;
      const normalizedStart = start < 0 ? Math.max(0, len + start) : start;
      const normalizedStop = stop < 0 ? Math.max(0, len + stop) : stop;
      return list.slice(normalizedStart, normalizedStop + 1);
    }

    try {
      const values = await this.redis!.lrange(this.withPrefix(key), start, stop);
      this.recordSuccess();
      return values.map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      });
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const list = this.fallback.read(key) as unknown[] | null;
        if (!list) {
          return [];
        }
        const len = list.length;
        const normalizedStart = start < 0 ? Math.max(0, len + start) : start;
        const normalizedStop = stop < 0 ? Math.max(0, len + stop) : stop;
        return list.slice(normalizedStart, normalizedStop + 1);
      }
      throw new RedisOperationError(
        `Failed to get range from list "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'LIST_RANGE_FAILED',
        'listRange',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 获取 List 长度
   *
   * @param key - List 键名
   * @returns List 长度
   */
  async listLength(key: string): Promise<number> {
    if (this.isInDegradedMode()) {
      const list = this.fallback.read(key) as unknown[] | null;
      return list?.length ?? 0;
    }

    try {
      const result = await this.redis!.llen(this.withPrefix(key));
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        const list = this.fallback.read(key) as unknown[] | null;
        return list?.length ?? 0;
      }
      throw new RedisOperationError(
        `Failed to get length of list "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'LIST_LENGTH_FAILED',
        'listLength',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 删除整个 List
   *
   * @param key - List 键名
   * @returns 是否成功删除
   */
  async listDeleteKey(key: string): Promise<boolean> {
    if (this.isInDegradedMode()) {
      return this.fallback.delete(key);
    }

    try {
      const result = await this.redis!.del(this.withPrefix(key));
      this.recordSuccess();
      return result > 0;
    } catch (err) {
      this.recordFailure(err);
      if (this.isInDegradedMode()) {
        return this.fallback.delete(key);
      }
      throw new RedisOperationError(
        `Failed to delete list key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        'LIST_DELETE_KEY_FAILED',
        'listDeleteKey',
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ---- 健康检查与状态 ----

  /**
   * 执行 PING 命令检查连通性
   *
   * @returns 是否正常响应
   */
  async ping(): Promise<boolean> {
    if (this.isInDegradedMode()) {
      // 降级模式下，只检查 fallback 是否可用
      return true;
    }

    if (this.redis === null || !this.connected) {
      return false;
    }

    try {
      const startTime = Date.now();
      const result = await this.redis.ping();
      const latency = Date.now() - startTime;

      // 检查是否超时
      if (latency > this.config.pingTimeoutMs) {
        logger.warn(
          {
            module: 'redis-store',
            action: 'ping-slow',
            latency,
            threshold: this.config.pingTimeoutMs,
          },
          'Redis PING response too slow',
        );
        this.recordFailure(new Error(`PING timeout: ${latency}ms`));
        return false;
      }

      this.recordSuccess();
      return result === 'PONG';
    } catch (err) {
      this.recordFailure(err);
      return false;
    }
  }

  /**
   * 获取当前运行模式
   *
   * @returns 'normal' 或 'degraded'
   */
  getMode(): 'normal' | 'degraded' {
    return this.mode;
  }

  /**
   * 获取详细健康状态
   *
   * @returns 包含各组件状态的对象
   */
  getHealthStatus(): RedisHealthStatus {
    const status: RedisHealthStatus = {
      redis: this.mode === 'normal' && this.isConnected(),
      fallback: true, // InMemoryStore 总是可用
      mode: this.mode,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
    };

    // 只在 lastError 存在时添加（满足 exactOptionalPropertyTypes）
    if (this.lastError !== undefined) {
      status.lastError = this.lastError;
    }

    return status;
  }

  // ---- 私有方法：降级逻辑 ----

  /**
   * 检查当前是否处于降级模式
   *
   * 使用独立方法避免 TypeScript 控制流分析的类型收窄问题
   * （recordFailure 可能改变 mode，但 TS 无法追踪这种副作用）
   *
   * @private
   */
  private isInDegradedMode(): boolean {
    if (this.mode !== 'degraded') {
      return false;
    }

    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= DEFAULT_COOLDOWN_MS) {
        this.circuitState = 'half-open';
        this.halfOpenProbeCount = 0;
        logger.info(
          { module: 'redis-store', action: 'half-open-enter', cooldownMs: elapsed },
          'Circuit breaker entering half-open state for probe requests',
        );
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * 记录成功操作
   *
   * @private
   */
  private recordSuccess(): void {
    this.consecutiveSuccesses += 1;

    if (this.circuitState === 'half-open') {
      this.halfOpenProbeCount += 1;
      if (this.halfOpenProbeCount >= HALF_OPEN_PROBE_LIMIT) {
        this.circuitState = 'closed';
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.halfOpenProbeCount = 0;
        void this.exitDegradedMode();
        return;
      }
    }

    if (this.circuitState === 'closed') {
      this.consecutiveFailures = 0;
      this.lastError = undefined;
    }

    if (
      this.mode === 'degraded' &&
      this.config.enableDegradation &&
      this.consecutiveSuccesses >= this.config.recoveryThreshold
    ) {
      this.exitDegradedMode();
    }
  }

  /**
   * 记录失败操作
   *
   * @private
   * @param err - 错误对象
   */
  private recordFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.lastError = err instanceof Error ? err : new Error(String(err));

    // 检查是否需要进入降级模式
    if (
      this.mode === 'normal' &&
      this.config.enableDegradation &&
      this.consecutiveFailures >= this.config.degradationThreshold
    ) {
      this.enterDegradedMode();
    }
  }

  /**
   * 进入降级模式
   *
   * @private
   */
  private enterDegradedMode(): void {
    const previousMode = this.mode;

    if (this.circuitState === 'closed') {
      this.circuitState = 'open';
      this.openedAt = Date.now();
    } else if (this.circuitState === 'half-open') {
      this.circuitState = 'open';
      this.openedAt = Date.now();
    }

    this.mode = 'degraded';
    this.halfOpenProbeCount = 0;

    logger.warn(
      {
        module: 'redis-store',
        action: 'enter-degraded',
        circuitState: this.circuitState,
        previousMode,
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.config.degradationThreshold,
        lastError: this.lastError?.message,
      },
      'Circuit breaker entered degraded mode',
    );
  }

  /**
   * 退出降级模式并同步 fallback 数据到 Redis
   *
   * @private
   */
  private async exitDegradedMode(): Promise<void> {
    const previousMode = this.mode;
    this.mode = 'normal';

    logger.info(
      {
        module: 'redis-store',
        action: 'exit-degraded',
        previousMode,
        consecutiveSuccesses: this.consecutiveSuccesses,
        threshold: this.config.recoveryThreshold,
      },
      'Redis degraded mode exited, syncing fallback data...',
    );

    try {
      await this.syncFallbackToRedis();
      logger.info(
        { module: 'redis-store', action: 'sync-fallback-complete' },
        'Fallback data synced to Redis successfully',
      );
    } catch (err) {
      logger.warn(
        {
          method: 'redis-store',
          action: 'sync-fallback-failed',
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to sync fallback data to Redis (non-critical, data remains in memory)',
      );
    }
  }

  /**
   * 将 fallback (InMemoryStore) 中的数据批量同步到 Redis
   *
   * @private
   */
  private async syncFallbackToRedis(): Promise<void> {
    const fallbackKeys = this.fallback.keys();

    if (fallbackKeys.length === 0) {
      return;
    }

    logger.info(
      {
        module: 'redis-store',
        action: 'sync-fallback-start',
        keyCount: fallbackKeys.length,
      },
      `Syncing ${fallbackKeys.length} fallback entries to Redis`,
    );

    let syncedCount = 0;
    let failedCount = 0;

    for (const key of fallbackKeys) {
      try {
        const value = this.fallback.read(key);
        if (value !== null) {
          const ttl = this.fallback.getTTL(key);
          await this.redis!.setex(
            this.withPrefix(key),
            ttl ? Math.floor(ttl / 1000) : Math.floor(DEFAULT_TTL_MS / 1000),
            JSON.stringify(value),
          );
          syncedCount++;
        }
      } catch {
        failedCount++;
      }
    }

    logger.info(
      {
        module: 'redis-store',
        action: 'sync-fallback-result',
        total: fallbackKeys.length,
        synced: syncedCount,
        failed: failedCount,
      },
      'Fallback sync completed',
    );
  }

  /**
   * 处理连接丢失
   *
   * @private
   */
  private handleConnectionLoss(): void {
    this.connected = false;
    this.recordFailure(new Error('Redis connection lost'));
  }

  /**
   * 使用 SCAN 命令迭代获取匹配模式的键（避免 KEYS 阻塞 Redis）
   *
   * @private
   * @param pattern - 匹配模式（如 'mcc:*'）
   * @param count - 每次 SCAN 返回的近似数量
   * @returns 匹配的键数组
   */
  private async scanKeys(pattern: string, count = 100): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, scannedKeys] = await this.redis!.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        count,
      );
      cursor = nextCursor;
      keys.push(...scannedKeys);
    } while (cursor !== '0');
    return keys;
  }
}

// ============================================================
// 导出
// ============================================================

export default RedisStore;
