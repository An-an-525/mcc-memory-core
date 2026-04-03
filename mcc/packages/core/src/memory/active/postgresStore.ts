/**
 * PostgreSQL 存储引擎
 *
 * 实现功能:
 * - 基于 PostgreSQL 的持久化存储
 * - 支持向量搜索（使用 pgvector 扩展）
 * - 与 RedisStore 对齐的 API
 * - 自动降级机制
 *
 * @module postgresStore
 * @description 实现 PostgreSQL 持久化存储，支持向量搜索
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type {
  PostgresConfig,
  IPostgresStore,
  WriteOptions,
  PostgresHealthStatus,
} from './types.js';
import {
  PostgresConnectionError,
  PostgresOperationError,
} from './types.js';
import logger from './logger.js';

// ============================================================
// PostgresStore 类
// ============================================================

export class PostgresStore<T = unknown> implements IPostgresStore<T> {
  /** PostgreSQL 连接池 */
  private pool: Pool;

  /** Drizzle ORM 实例 */
  private db: ReturnType<typeof drizzle>;

  /** 配置 */
  private config: Required<PostgresConfig>;

  /** 连接状态 */
  private connected = false;

  /** 运行模式 */
  private mode: 'normal' | 'degraded' = 'normal';

  /** 连续失败次数 */
  private consecutiveFailures = 0;

  /** 连续成功次数 */
  private consecutiveSuccesses = 0;

  /** 最后一次错误 */
  private lastError: Error | undefined;

  /** 键前缀 */
  private prefix = 'mcc:';

  /**
   * 构造函数
   *
   * @param config - PostgreSQL 配置
   */
  constructor(config: PostgresConfig) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      user: config.user,
      password: config.password,
      database: config.database,
      maxConnections: config.maxConnections || 20,
      connectionTimeoutMs: config.connectionTimeoutMs || 5000,
      enableDegradation: config.enableDegradation ?? true,
      degradationThreshold: config.degradationThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 3,
    };

    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      max: this.config.maxConnections,
      connectionTimeoutMillis: this.config.connectionTimeoutMs,
    });

    this.db = drizzle(this.pool);
  }

  // ============================================================
  // 连接管理
  // ============================================================

  /**
   * 建立 PostgreSQL 连接
   */
  async connect(): Promise<void> {
    try {
      await this.pool.connect();
      await this.ensureSchema();
      this.connected = true;
      this.mode = 'normal';
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;

      logger.info(
        { module: 'postgres-store', action: 'connect' },
        'PostgreSQL connected successfully',
      );
    } catch (error) {
      const err = error as Error;
      this.handleFailure(err);
      throw new PostgresConnectionError('Failed to connect to PostgreSQL', err);
    }
  }

  /**
   * 断开 PostgreSQL 连接
   */
  async disconnect(): Promise<void> {
    try {
      await this.pool.end();
      this.connected = false;
      this.mode = 'degraded';

      logger.info(
        { module: 'postgres-store', action: 'disconnect' },
        'PostgreSQL disconnected',
      );
    } catch (error) {
      const err = error as Error;
      logger.warn(
        { module: 'postgres-store', action: 'disconnect-error', error: err.message },
        'Error disconnecting from PostgreSQL',
      );
    }
  }

  /**
   * 当前是否已连接
   */
  isConnected(): boolean {
    return this.connected && this.mode === 'normal';
  }

  // ============================================================
  // 基础 CRUD
  // ============================================================

  /**
   * 写入一个条目
   */
  async write(key: string, value: T, options?: WriteOptions): Promise<void> {
    const prefixedKey = this.withPrefix(key);
    const now = new Date();
    const expiresAt = options?.ttl && options.ttl > 0
      ? new Date(now.getTime() + options.ttl)
      : null;

    try {
      const exists = await this.exists(key);
      if (exists && options?.skipIfExists) {
        return;
      }

      const valueJson = JSON.stringify(value);

      if (exists) {
        await this.pool.query(
          `UPDATE memory_entries SET value = $1, expires_at = $2, last_accessed_at = $3 WHERE key = $4`,
          [valueJson, expiresAt, now, prefixedKey]
        );
      } else {
        await this.pool.query(
          `INSERT INTO memory_entries (id, key, value, expires_at, last_accessed_at) VALUES ($1, $2, $3, $4, $5)`,
          [crypto.randomUUID(), prefixedKey, valueJson, expiresAt, now]
        );
      }

      this.handleSuccess();
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to write: ${err.message}`,
        'WRITE_FAILED',
        'write',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 读取一个条目
   */
  async read(key: string): Promise<T | null> {
    const prefixedKey = this.withPrefix(key);

    try {
      const result = await this.pool.query(
        `SELECT value FROM memory_entries WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [prefixedKey]
      );

      if (result.rows.length === 0) {
        this.handleSuccess();
        return null;
      }

      // 更新访问时间和计数
      await this.pool.query(
        `UPDATE memory_entries SET last_accessed_at = $1 WHERE key = $2`,
        [new Date(), prefixedKey]
      );

      const valueJson = result.rows[0].value;
      const value = JSON.parse(valueJson) as T;

      this.handleSuccess();
      return value;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to read: ${err.message}`,
        'READ_FAILED',
        'read',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 检查键是否存在
   */
  async exists(key: string): Promise<boolean> {
    const prefixedKey = this.withPrefix(key);

    try {
      const result = await this.pool.query(
        `SELECT 1 FROM memory_entries WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [prefixedKey]
      );

      this.handleSuccess();
      return result.rows.length > 0;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to check existence: ${err.message}`,
        'EXISTS_FAILED',
        'exists',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 删除一个条目
   */
  async delete(key: string): Promise<boolean> {
    const prefixedKey = this.withPrefix(key);

    try {
      const result = await this.pool.query(
        `DELETE FROM memory_entries WHERE key = $1`,
        [prefixedKey]
      );

      this.handleSuccess();
      return (result.rowCount || 0) > 0;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to delete: ${err.message}`,
        'DELETE_FAILED',
        'delete',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 清空所有条目
   */
  async clear(prefix?: string): Promise<void> {
    const prefixedPrefix = prefix ? this.withPrefix(prefix) : this.prefix;

    try {
      if (prefix) {
        await this.pool.query(
          `DELETE FROM memory_entries WHERE key LIKE $1`,
          [`${prefixedPrefix}%`]
        );
      } else {
        await this.pool.query(`DELETE FROM memory_entries`);
      }

      this.handleSuccess();
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to clear: ${err.message}`,
        'CLEAR_FAILED',
        'clear',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 获取所有匹配模式的键
   */
  async keys(pattern: string = '*'): Promise<string[]> {
    const prefixedPattern = this.withPrefix(pattern).replace('*', '%');

    try {
      const result = await this.pool.query(
        `SELECT key FROM memory_entries WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [prefixedPattern]
      );

      const keys = result.rows.map(row => this.withoutPrefix(row.key));

      this.handleSuccess();
      return keys;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to get keys: ${err.message}`,
        'KEYS_FAILED',
        'keys',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 获取存储的条目数量
   */
  async size(prefix?: string): Promise<number> {
    const prefixedPrefix = prefix ? this.withPrefix(prefix) : this.prefix;

    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) as count FROM memory_entries WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [`${prefixedPrefix}%`]
      );

      const count = parseInt(result.rows[0].count || '0', 10);

      this.handleSuccess();
      return count;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to get size: ${err.message}`,
        'SIZE_FAILED',
        'size',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  // ============================================================
  // TTL 管理
  // ============================================================

  /**
   * 设置过期时间
   */
  async setTTL(key: string, ttl: number): Promise<boolean> {
    const prefixedKey = this.withPrefix(key);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl) : null;

    try {
      const result = await this.pool.query(
        `UPDATE memory_entries SET expires_at = $1 WHERE key = $2`,
        [expiresAt, prefixedKey]
      );

      this.handleSuccess();
      return (result.rowCount || 0) > 0;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to set TTL: ${err.message}`,
        'SET_TTL_FAILED',
        'setTTL',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 获取剩余过期时间
   */
  async getTTL(key: string): Promise<number> {
    const prefixedKey = this.withPrefix(key);

    try {
      const result = await this.pool.query(
        `SELECT expires_at FROM memory_entries WHERE key = $1`,
        [prefixedKey]
      );

      if (result.rows.length === 0) {
        return -2; // 不存在
      }

      const expiresAt = result.rows[0].expires_at;
      if (!expiresAt) {
        return -1; // 永不过期
      }

      const now = new Date();
      const ttlMs = new Date(expiresAt).getTime() - now.getTime();

      this.handleSuccess();
      return Math.max(0, ttlMs);
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to get TTL: ${err.message}`,
        'GET_TTL_FAILED',
        'getTTL',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 移除过期时间
   */
  async removeTTL(key: string): Promise<boolean> {
    const prefixedKey = this.withPrefix(key);

    try {
      const result = await this.pool.query(
        `UPDATE memory_entries SET expires_at = NULL WHERE key = $1`,
        [prefixedKey]
      );

      this.handleSuccess();
      return (result.rowCount || 0) > 0;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to remove TTL: ${err.message}`,
        'REMOVE_TTL_FAILED',
        'removeTTL',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  // ============================================================
  // 向量搜索
  // ============================================================

  /**
   * 写入带嵌入向量的条目
   */
  async writeWithEmbedding(key: string, value: T, embedding: number[], options?: WriteOptions): Promise<void> {
    const prefixedKey = this.withPrefix(key);
    const now = new Date();
    const expiresAt = options?.ttl && options.ttl > 0
      ? new Date(now.getTime() + options.ttl)
      : null;

    try {
      const exists = await this.exists(key);
      if (exists && options?.skipIfExists) {
        return;
      }

      const valueJson = JSON.stringify(value);
      const embeddingStr = `[${embedding.join(',')}]`;

      if (exists) {
        await this.pool.query(
          `UPDATE memory_entries SET value = $1, embedding = $2, expires_at = $3, last_accessed_at = $4 WHERE key = $5`,
          [valueJson, embeddingStr, expiresAt, now, prefixedKey]
        );
      } else {
        await this.pool.query(
          `INSERT INTO memory_entries (id, key, value, embedding, expires_at, last_accessed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [crypto.randomUUID(), prefixedKey, valueJson, embeddingStr, expiresAt, now]
        );
      }

      this.handleSuccess();
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to write with embedding: ${err.message}`,
        'WRITE_EMBEDDING_FAILED',
        'writeWithEmbedding',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  /**
   * 搜索相似条目
   */
  async searchSimilar(embedding: number[], limit: number = 5, threshold: number = 0.7): Promise<Array<{ key: string; value: T; similarity: number }>> {
    try {
      const embeddingStr = `[${embedding.join(',')}]`;
      const result = await this.pool.query(
        `
        SELECT 
          key,
          value,
          1 - (embedding <=> $1) as similarity
        FROM 
          memory_entries
        WHERE 
          (expires_at IS NULL OR expires_at > NOW())
          AND 1 - (embedding <=> $1) > $2
        ORDER BY 
          similarity DESC
        LIMIT $3
        `,
        [embeddingStr, threshold, limit]
      );

      const results = result.rows.map(row => ({
        key: this.withoutPrefix(row.key),
        value: JSON.parse(row.value) as T,
        similarity: parseFloat(row.similarity),
      }));

      this.handleSuccess();
      return results;
    } catch (error) {
      const err = error as Error;
      const operationError = new PostgresOperationError(
        `Failed to search similar: ${err.message}`,
        'SEARCH_SIMILAR_FAILED',
        'searchSimilar',
        err
      );

      this.handleFailure(operationError);
      throw operationError;
    }
  }

  // ============================================================
  // 健康检查与状态
  // ============================================================

  /**
   * 执行健康检查
   */
  async ping(): Promise<boolean> {
    try {
      await this.db.execute('SELECT 1');
      this.handleSuccess();
      return true;
    } catch (error) {
      const err = error as Error;
      this.handleFailure(err);
      return false;
    }
  }

  /**
   * 获取当前运行模式
   */
  getMode(): 'normal' | 'degraded' {
    return this.mode;
  }

  /**
   * 获取详细健康状态
   */
  getHealthStatus(): PostgresHealthStatus {
    const status: any = {
      postgres: this.connected && this.mode === 'normal',
      fallback: this.config.enableDegradation || false,
      mode: this.mode,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
    };

    if (this.lastError) {
      status.lastError = this.lastError;
    }

    return status as PostgresHealthStatus;
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 确保表结构存在
   */
  private async ensureSchema(): Promise<void> {
    try {
      // 检查 pgvector 扩展
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

      // 创建表
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          embedding VECTOR(768),
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          last_accessed_at TIMESTAMP DEFAULT NOW() NOT NULL,
          access_count INTEGER DEFAULT 0 NOT NULL
        )
      `);

      // 创建索引
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_memory_entries_key ON memory_entries(key)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_memory_entries_expires_at ON memory_entries(expires_at)');
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding ON memory_entries USING ivfflat (embedding vector_cosine_ops)');
    } catch (error) {
      const err = error as Error;
      logger.warn(
        { module: 'postgres-store', action: 'ensure-schema-error', error: err.message },
        'Error ensuring schema',
      );
    }
  }

  /**
   * 处理成功
   */
  private handleSuccess(): void {
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.lastError = undefined;

    // 从降级模式恢复
    if (this.mode === 'degraded' && this.consecutiveSuccesses >= this.config.recoveryThreshold) {
      this.mode = 'normal';
      logger.info(
        { module: 'postgres-store', action: 'recovery' },
        'PostgreSQL recovered to normal mode',
      );
    }
  }

  /**
   * 处理失败
   */
  private handleFailure(error: Error): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.lastError = error;

    // 进入降级模式
    if (this.mode === 'normal' && this.consecutiveFailures >= this.config.degradationThreshold) {
      this.mode = 'degraded';
      logger.warn(
        { module: 'postgres-store', action: 'degradation', error: error.message },
        'PostgreSQL degraded to fallback mode',
      );
    }
  }

  /**
   * 添加键前缀
   */
  private withPrefix(key: string): string {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  /**
   * 移除键前缀
   */
  private withoutPrefix(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }
}
