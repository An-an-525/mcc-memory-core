/**
 * InMemoryStore - 基于 Doubly Linked List + HashMap 的 O(1) LRU 内存存储引擎
 *
 * 实现功能:
 * - Task 1A.1.2.1: 内存 Map 存储层基础结构
 * - Task 1A.1.2.2: write/read/delete/clear/keys/size 等基础接口
 * - Task 1A.1.2.3: TTL 过期自动清理（惰性清理 + 定时清理）
 * - Task 1A.1.4: 容量超限时 LRU 淘汰最旧条目（O(1) 双向链表实现）
 *
 * @module inMemoryStore
 */

import logger from './logger.js';
import type {
  IInMemoryStore,
  InMemoryStoreConfig,
  MemoryEntry,
  WriteOptions,
} from './types.js';
import { MemoryStoreError } from './types.js';
import {
  MAX_ACTIVE_MEMORY_SIZE,
  DEFAULT_TTL_MS,
  CLEANUP_INTERVAL_MS,
  HIGH_ACCESS_THRESHOLD,
} from './types.js';

// ============================================================
// 辅助函数
// ============================================================

function isExpired<T>(entry: MemoryEntry<T>, now: number): boolean {
  return entry.ttl > 0 && now - entry.createdAt >= entry.ttl;
}

function getRemainingTTL<T>(entry: MemoryEntry<T>, now: number): number {
  if (entry.ttl === 0) {
    return 0;
  }
  const remaining = entry.ttl - (now - entry.createdAt);
  return remaining > 0 ? remaining : 0;
}

// ============================================================
// LRU 双向链表节点
// ============================================================

interface LRUNode<T> {
  key: string;
  entry: MemoryEntry<T>;
  prev: LRUNode<T> | null;
  next: LRUNode<T> | null;
}

// ============================================================
// InMemoryStore 实现
// ============================================================

export class InMemoryStore<T = unknown> implements IInMemoryStore<T> {
  /** HashMap: key -> 链表节点 (O(1) 查找) */
  private readonly map: Map<string, LRUNode<T>>;

  /** 双向链表头节点 (MRU 端 - 最近访问) */
  private head: LRUNode<T> | null;

  /** 双向链表尾节点 (LRU 端 - 最久未访问) */
  private tail: LRUNode<T> | null;

  /** 原子计数器，替代 keys().length 的 O(n) 扫描 */
  private _size: number;

  /** 最大容量 */
  private readonly maxSize: number;

  /** 默认 TTL (ms) */
  private readonly defaultTtlMs: number;

  /** 定时清理 timer 引用 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: InMemoryStoreConfig) {
    this.map = new Map();
    this.head = null;
    this.tail = null;
    this._size = 0;
    this.maxSize = config?.maxSize ?? MAX_ACTIVE_MEMORY_SIZE;
    this.defaultTtlMs = config?.defaultTtlMs ?? DEFAULT_TTL_MS;

    logger.info(
      {
        module: 'in-memory-store',
        action: 'init',
        maxSize: this.maxSize,
        defaultTtlMs: this.defaultTtlMs,
      },
      'InMemoryStore initialized',
    );
  }

  // ---- 链表操作 (私有, O(1)) ----

  /**
   * 将节点插入到链表头部 (成为新的 MRU)
   */
  private addToFront(node: LRUNode<T>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head !== null) {
      this.head.prev = node;
    }

    this.head = node;

    if (this.tail === null) {
      this.tail = node;
    }
  }

  /**
   * 将已存在的节点移动到头部 (访问时调用)
   */
  private moveToFront(node: LRUNode<T>): void {
    if (node === this.head) {
      return;
    }

    this.removeNode(node);
    this.addToFront(node);
  }

  /**
   * 从链表中摘除节点 (不删除 map 条目)
   */
  private removeNode(node: LRUNode<T>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }

  // ---- Task 1A.1.2.2: 基础 CRUD 接口 ----

  write(key: string, value: T, options?: WriteOptions): void {
    if (!key || key.length === 0) {
      throw new MemoryStoreError('Key must be a non-empty string', 'INVALID_KEY');
    }

    const now = Date.now();

    // 如果 key 已存在且要求跳过 → 直接返回
    if (options?.skipIfExists && this.map.has(key)) {
      const existing = this.map.get(key)!;
      if (!isExpired(existing.entry, now)) {
        logger.debug(
          { module: 'in-memory-store', action: 'write-skipped', key },
          'Write skipped: key already exists and skipIfExists=true',
        );
        return;
      }
      // 已过期 → 允许覆盖（先删除旧条目）
      this.removeNode(existing);
      this.map.delete(key);
      this._size -= 1;
    }

    // 如果 key 已存在 → 更新值并移到头部
    if (this.map.has(key)) {
      const existingNode = this.map.get(key)!;
      const ttl = options?.ttl ?? this.defaultTtlMs;
      existingNode.entry = {
        value,
        createdAt: now,
        ttl,
        accessCount: 1,
        lastAccessedAt: now,
      };
      this.moveToFront(existingNode);

      logger.debug(
        {
          module: 'in-memory-store',
          action: 'write-update',
          key,
          ttl,
          currentSize: this._size,
          maxSize: this.maxSize,
        },
        'Entry updated and moved to front',
      );
      return;
    }

    // 容量检查：如果已满 → LRU 淘汰
    if (this._size >= this.maxSize) {
      this.evictLRU(now);
    }

    // 构建新条目并插入到头部
    const ttl = options?.ttl ?? this.defaultTtlMs;
    const entry: MemoryEntry<T> = {
      value,
      createdAt: now,
      ttl,
      accessCount: 1,
      lastAccessedAt: now,
    };

    const node: LRUNode<T> = { key, entry, prev: null, next: null };
    this.map.set(key, node);
    this.addToFront(node);
    this._size += 1;

    logger.debug(
      {
        module: 'in-memory-store',
        action: 'write',
        key,
        ttl,
        currentSize: this._size,
        maxSize: this.maxSize,
      },
      'Entry written',
    );
  }

  read(key: string): T | null {
    const now = Date.now();
    const node = this.map.get(key);

    if (!node) {
      return null;
    }

    // 惰性过期检查
    if (isExpired(node.entry, now)) {
      this.removeNode(node);
      this.map.delete(key);
      this._size -= 1;
      logger.debug(
        { module: 'in-memory-store', action: 'lazy-expire', key },
        'Entry expired on read (lazy cleanup)',
      );
      return null;
    }

    // 更新访问元数据并移到头部
    node.entry.lastAccessedAt = now;
    node.entry.accessCount += 1;
    this.moveToFront(node);

    return node.entry.value;
  }

  exists(key: string): boolean {
    const now = Date.now();
    const node = this.map.get(key);

    if (!node) {
      return false;
    }

    // 惰性过期检查
    if (isExpired(node.entry, now)) {
      this.removeNode(node);
      this.map.delete(key);
      this._size -= 1;
      return false;
    }

    return true;
  }

  delete(key: string): boolean {
    const node = this.map.get(key);

    if (!node) {
      return false;
    }

    this.removeNode(node);
    this.map.delete(key);
    this._size -= 1;

    logger.debug(
      { module: 'in-memory-store', action: 'delete', key },
      'Entry deleted',
    );

    return true;
  }

  clear(): void {
    const previousSize = this._size;
    this.map.clear();
    this.head = null;
    this.tail = null;
    this._size = 0;

    if (this.cleanupTimer !== null) {
      this.stopCleanup();
    }

    logger.info(
      { module: 'in-memory-store', action: 'clear', clearedCount: previousSize },
      'All entries cleared',
    );
  }

  keys(): string[] {
    const now = Date.now();
    const validKeys: string[] = [];
    const toDelete: LRUNode<T>[] = [];

    for (const [key, node] of this.map) {
      if (!isExpired(node.entry, now)) {
        validKeys.push(key);
      } else {
        toDelete.push(node);
      }
    }

    // 批量删除过期条目
    for (const node of toDelete) {
      this.removeNode(node);
      this.map.delete(node.key);
      this._size -= 1;
    }

    return validKeys;
  }

  size(): number {
    return this._size;
  }

  // ---- Task 1A.1.2.3: TTL 相关接口 ----

  setTTL(key: string, ttlMs: number): boolean {
    const node = this.map.get(key);

    if (!node) {
      return false;
    }

    const now = Date.now();

    if (isExpired(node.entry, now)) {
      this.removeNode(node);
      this.map.delete(key);
      this._size -= 1;
      return false;
    }

    node.entry.ttl = ttlMs;

    logger.debug(
      {
        module: 'in-memory-store',
        action: 'set-ttl',
        key,
        newTtl: ttlMs,
      },
      'TTL updated',
    );

    return true;
  }

  getTTL(key: string): number | null {
    const node = this.map.get(key);

    if (!node) {
      return null;
    }

    const now = Date.now();

    if (isExpired(node.entry, now)) {
      this.removeNode(node);
      this.map.delete(key);
      this._size -= 1;
      return 0;
    }

    return getRemainingTTL(node.entry, now);
  }

  // ---- 统计相关 ----

  getAccessCount(key: string): number {
    const node = this.map.get(key);

    if (!node) {
      return 0;
    }

    const now = Date.now();

    if (isExpired(node.entry, now)) {
      this.removeNode(node);
      this.map.delete(key);
      this._size -= 1;
      return 0;
    }

    return node.entry.accessCount;
  }

  // ---- Task 1A.1.2.3: 维护操作 ----

  cleanupExpired(): number {
    const now = Date.now();
    let cleanedCount = 0;
    const toDelete: LRUNode<T>[] = [];

    for (const [, node] of this.map) {
      if (isExpired(node.entry, now)) {
        toDelete.push(node);
      }
    }

    for (const node of toDelete) {
      this.removeNode(node);
      this.map.delete(node.key);
      this._size -= 1;
      cleanedCount += 1;
    }

    if (cleanedCount > 0) {
      logger.info(
        {
          module: 'in-memory-store',
          action: 'cleanup-expired',
          cleanedCount,
          remainingSize: this._size,
        },
        'Expired entries cleaned up',
      );
    }

    return cleanedCount;
  }

  // ---- Task 1A.1.2.3: 定时清理控制 ----

  startCleanup(intervalMs?: number): void {
    if (this.cleanupTimer !== null) {
      logger.warn(
        { module: 'in-memory-store', action: 'startCleanup-skipped' },
        'Cleanup timer already running',
      );
      return;
    }

    const interval = intervalMs ?? CLEANUP_INTERVAL_MS;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, interval);

    if (typeof this.cleanupTimer === 'object' && this.cleanupTimer !== null) {
      this.cleanupTimer.unref();
    }

    logger.info(
      {
        module: 'in-memory-store',
        action: 'start-cleanup',
        intervalMs: interval,
      },
      'Periodic cleanup started',
    );
  }

  stopCleanup(): void {
    if (this.cleanupTimer === null) {
      return;
    }

    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;

    logger.info(
      { module: 'in-memory-store', action: 'stop-cleanup' },
      'Periodic cleanup stopped',
    );
  }

  isCleanupRunning(): boolean {
    return this.cleanupTimer !== null;
  }

  // ---- Task 1A.1.4: LRU 淘汰算法 (O(1)) ----

  /**
   * LRU 淘汰最久未被访问的条目
   *
   * 从 tail (LRU 端) 开始向前扫描，
   * 跳过高访问频率的受保护节点，
   * 找到第一个可淘汰的节点进行 O(1) 删除。
   *
   * @param now - 当前时间戳（用于日志）
   * @private
   */
  private evictLRU(now: number): void {
    const MAX_EVICT_SCAN = 10;
    let current = this.tail;
    let scanned = 0;

    while (current !== null && scanned < MAX_EVICT_SCAN) {
      if (current.entry.accessCount <= HIGH_ACCESS_THRESHOLD) {
        break;
      }
      current = current.prev;
      scanned++;
    }

    if (current === null || scanned >= MAX_EVICT_SCAN) {
      current = this.tail;
      if (scanned >= MAX_EVICT_SCAN) {
        logger.warn(
          { module: 'in-memory-store', action: 'evict-scan-limit', scanned },
          'LRU eviction hit scan limit, forcing tail eviction',
        );
      }
    }

    if (current !== null) {
      const evictedKey = current.key;
      const evictedEntry = current.entry;

      this.removeNode(current);
      this.map.delete(evictedKey);
      this._size -= 1;

      logger.warn(
        {
          module: 'in-memory-store',
          action: 'lru-evict',
          evictedKey,
          evictedEntryAge: now - evictedEntry.createdAt,
          evictedAccessCount: evictedEntry.accessCount,
          lastAccessedAgo: now - evictedEntry.lastAccessedAt,
          currentSize: this._size,
          maxSize: this.maxSize,
        },
        'LRU eviction: entry evicted due to capacity limit',
      );
    }
  }
}

// ============================================================
// 导出
// ============================================================

export default InMemoryStore;
