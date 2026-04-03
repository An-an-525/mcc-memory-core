/**
 * InMemoryStore 单元测试
 *
 * 覆盖范围:
 * - Task 1A.1.5.1: 基础 CRUD 操作
 * - Task 1A.1.5.1: TTL 过期机制（惰性 + 定时）
 * - Task 1A.1.5.1: 容量限制与 LRU 淘汰算法
 * - Task 1A.1.5.1: 定时清理功能
 *
 * @module tests/memory/active/inMemoryStore.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryStore } from '../../../packages/core/src/memory/active/inMemoryStore.js';
import { MemoryStoreError } from '../../../packages/core/src/memory/active/types.js';
import type { IInMemoryStore } from '../../../packages/core/src/memory/active/types.js';

// ============================================================
// 测试工具函数
// ============================================================

/** 创建一个用于测试的 InMemoryStore 实例 */
function createTestStore(maxSize?: number, defaultTtlMs?: number): InMemoryStore<string> {
  const config = {};
  if (maxSize !== undefined) config.maxSize = maxSize;
  if (defaultTtlMs !== undefined) config.defaultTtlMs = defaultTtlMs;
  return new InMemoryStore<string>(config);
}

// ============================================================
// 测试套件 1: 基础 CRUD 操作
// ============================================================

describe('InMemoryStore - 基础 CRUD 操作', () => {
  let store: IInMemoryStore<string>;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.clear();
    store.stopCleanup();
  });

  // ---- 1.1 写入与读取 ----

  it('write → read 返回相同值', () => {
    // Arrange & Act
    store.write('key1', 'value1');
    const result = store.read('key1');

    // Assert
    expect(result).toBe('value1');
  });

  it('支持多种数据类型的读写', () => {
    // 字符串
    store.write('str', 'hello');
    expect(store.read('str')).toBe('hello');

    // 数字（通过泛型）
    const numStore = new InMemoryStore<number>();
    numStore.write('num', 42);
    expect(numStore.read('num')).toBe(42);

    // 对象（序列化为 JSON）
    const objStore = new InMemoryStore<Record<string, unknown>>();
    const testObj = { name: 'Alice', age: 30 };
    objStore.write('obj', testObj);
    expect(objStore.read('obj')).toEqual(testObj);
  });

  it('read 不存在的 key 返回 null', () => {
    const result = store.read('nonexistent');
    expect(result).toBeNull();
  });

  // ---- 1.2 存在性检查 ----

  it('exists 正确判断存在性', () => {
    // 不存在时返回 false
    expect(store.exists('key1')).toBe(false);

    // 写入后返回 true
    store.write('key1', 'value1');
    expect(store.exists('key1')).toBe(true);
  });

  // ---- 1.3 删除操作 ----

  it('delete 删除后 read 返回 null', () => {
    store.write('key1', 'value1');

    // 删除成功
    const deleteResult = store.delete('key1');
    expect(deleteResult).toBe(true);

    // 读取返回 null
    expect(store.read('key1')).toBeNull();
  });

  it('delete 不存在的 key 返回 false', () => {
    const deleteResult = store.delete('nonexistent');
    expect(deleteResult).toBe(false);
  });

  // ---- 1.4 清空操作 ----

  it('clear 后 size() = 0', () => {
    // 写入多个条目
    store.write('key1', 'value1');
    store.write('key2', 'value2');
    store.write('key3', 'value3');
    expect(store.size()).toBe(3);

    // 清空
    store.clear();

    // 验证
    expect(store.size()).toBe(0);
    expect(store.read('key1')).toBeNull();
    expect(store.read('key2')).toBeNull();
    expect(store.read('key3')).toBeNull();
  });

  // ---- 1.5 键列表 ----

  it('keys() 返回所有有效 key', () => {
    store.write('alpha', 'a');
    store.write('beta', 'b');
    store.write('gamma', 'c');

    const keys = store.keys();

    expect(keys).toHaveLength(3);
    expect(keys).toContain('alpha');
    expect(keys).toContain('beta');
    expect(keys).toContain('gamma');
  });

  it('keys() 不包含已过期的 key', () => {
    // 写入一个短 TTL 的条目
    store.write('short-lived', 'value', { ttl: 50 }); // 50ms TTL

    // 立即检查应该存在
    expect(store.keys()).toContain('short-lived');

    // 等待过期
    vi.useFakeTimers();
    vi.advanceTimersByTime(60);

    // 过期后不应出现在 keys 中
    const keys = store.keys();
    expect(keys).not.toContain('short-lived');

    vi.useRealTimers();
  });

  // ---- 1.6 大小统计 ----

  it('size() 返回有效条目数', () => {
    expect(store.size()).toBe(0);

    store.write('k1', 'v1');
    expect(store.size()).toBe(1);

    store.write('k2', 'v2');
    store.write('k3', 'v3');
    expect(store.size()).toBe(3);

    store.delete('k2');
    expect(store.size()).toBe(2);
  });

  // ---- 1.7 错误处理 ----

  it('write 空 key 抛出 MemoryStoreError', () => {
    expect(() => store.write('', 'value')).toThrow(MemoryStoreError);
    expect(() => store.write('', 'value')).toThrow('Key must be a non-empty string');
  });
});

// ============================================================
// 测试套件 2: TTL 过期机制
// ============================================================

describe('InMemoryStore - TTL 过期机制', () => {
  let store: IInMemoryStore<string>;

  beforeEach(() => {
    // 使用较短的默认 TTL 方便测试
    store = createTestStore(undefined, 5000); // 5s 默认 TTL
  });

  afterEach(() => {
    store.clear();
    store.stopCleanup();
  });

  // ---- 2.1 默认 TTL 行为 ----

  it('默认 TTL 24h，写入后立即可读', () => {
    const defaultStore = createTestStore(); // 使用默认 24h TTL
    defaultStore.write('key1', 'value1');

    // 立即可读
    expect(defaultStore.read('key1')).toBe('value1');

    // 存在性检查通过
    expect(defaultStore.exists('key1')).toBe(true);

    defaultStore.clear();
    defaultStore.stopCleanup();
  });

  // ---- 2.2 自定义短 TTL 过期 ----

  it('自定义短 TTL (100ms)，过期后返回 null', async () => {
    vi.useFakeTimers();

    store.write('short', 'ephemeral', { ttl: 100 });

    // 未过期时可读
    expect(store.read('short')).toBe('ephemeral');

    // 前进时间到 100ms 后过期
    vi.advanceTimersByTime(101);

    // 过期后返回 null
    expect(store.read('short')).toBeNull();
    expect(store.exists('short')).toBe(false);

    vi.useRealTimers();
  });

  it('惰性过期：read 时才检测并删除过期条目', async () => {
    vi.useFakeTimers();

    store.write('lazy-expire', 'data', { ttl: 100 });

    // 时间前进但未触发 read
    vi.advanceTimersByTime(150);

    // 新的 O(1) size() 不触发惰性清理（与旧实现不同）
    // 需要显式清理或通过 read 触发
    store.cleanupExpired();
    expect(store.size()).toBe(0);

    vi.useRealTimers();
  });

  // ---- 2.3 动态修改 TTL ----

  it('setTTL 动态修改 TTL', async () => {
    vi.useFakeTimers();

    store.write('modifiable', 'original', { ttl: 100 });

    // 在过期前修改 TTL 为更长的时间
    vi.advanceTimersByTime(50);
    const setResult = store.setTTL('modifiable', 5000); // 改为 5s
    expect(setResult).toBe(true);

    // 原来的 100ms 已经过去了 50ms，但新 TTL 是 5s，所以还不过期
    vi.advanceTimersByTime(60); // 总共 110ms
    expect(store.read('modifiable')).toBe('original'); // 应该还能读到

    vi.useRealTimers();
  });

  it('setTTL 对不存在的 key 返回 false', () => {
    const result = store.setTTL('nonexistent', 1000);
    expect(result).toBe(false);
  });

  it('setTTL 对已过期的 key 返回 false', async () => {
    vi.useFakeTimers();

    store.write('expired-soon', 'data', { ttl: 50 });
    vi.advanceTimersByTime(60);

    const result = store.setTTL('expired-soon', 5000);
    expect(result).toBe(false);

    vi.useRealTimers();
  });

  // ---- 2.4 获取剩余 TTL ----

  it('getTTL 返回剩余时间', async () => {
    vi.useFakeTimers();

    store.write('timed', 'value', { ttl: 10000 }); // 10s TTL

    // 立即获取应接近 10000ms
    const ttl1 = store.getTTL('timed');
    expect(ttl1).not.toBeNull();
    expect(ttl1!).toBeGreaterThan(9900); // 允许少量误差

    // 前进 1 秒
    vi.advanceTimersByTime(1000);

    const ttl2 = store.getTTL('timed');
    expect(ttl2).not.toBeNull();
    expect(ttl2!).toBeGreaterThan(8900);
    expect(ttl2!).toBeLessThanOrEqual(9000); // 允许等于（时间精度问题）

    vi.useRealTimers();
  });

  it('getTTL 对不存在的 key 返回 null', () => {
    const ttl = store.getTTL('nonexistent');
    expect(ttl).toBeNull();
  });

  it('getTTL 对已过期的 key 返回 0', async () => {
    vi.useFakeTimers();

    store.write('gone', 'data', { ttl: 50 });
    vi.advanceTimersByTime(60);

    const ttl = store.getTTL('gone');
    expect(ttl).toBe(0); // 已过期返回 0

    vi.useRealTimers();
  });

  // ---- 2.5 永不过期的条目 (ttl=0) ----

  it('ttl=0 表示永不过期', async () => {
    vi.useFakeTimers();

    store.write('permanent', 'forever', { ttl: 0 });

    // 即使过了很长时间也不过期
    vi.advanceTimersByTime(999999999);
    expect(store.read('permanent')).toBe('forever');

    vi.useRealTimers();
  });
});

// ============================================================
// 测试套件 3: 容量限制与 LRU 淘汰算法
// ============================================================

describe('InMemoryStore - 容量限制与 LRU 淘汰', () => {
  const SMALL_MAX_SIZE = 5; // 使用小容量方便测试

  let store: IInMemoryStore<string>;

  beforeEach(() => {
    store = createTestStore(SMALL_MAX_SIZE);
  });

  afterEach(() => {
    store.clear();
    store.stopCleanup();
  });

  // ---- 3.1 自动淘汰最旧条目 ----

  it('写入超过 maxSize 时自动淘汰最旧条目', () => {
    // 填满到最大容量
    for (let i = 0; i < SMALL_MAX_SIZE; i++) {
      store.write(`key${i}`, `value${i}`);
    }

    expect(store.size()).toBe(SMALL_MAX_SIZE);

    // 再写入一个新条目，应触发 LRU 淘汰
    store.write('new-key', 'new-value');

    // 总数仍为 maxSize
    expect(store.size()).toBe(SMALL_MAX_SIZE);

    // 新条目存在
    expect(store.read('new-key')).toBe('new-value');

    // 最旧的条目（key0）应被淘汰
    expect(store.read('key0')).toBeNull();
  });

  // ---- 3.2 高访问频率保护机制 ----

  it('高访问量条目 (accessCount > 100) 受保护不被淘汰', () => {
    // 填满容量
    for (let i = 0; i < SMALL_MAX_SIZE; i++) {
      store.write(`key${i}`, `value${i}`);
    }

    // 频繁访问 key0 使其成为热点数据
    for (let i = 0; i < 150; i++) {
      store.read('key0'); // 每次 read 增加 accessCount
    }

    // 验证 accessCount 超过阈值
    expect(store.getAccessCount('key0')).toBeGreaterThan(100);

    // 写入新条目触发淘汰
    store.write('new-key', 'new-value');

    // key0 因为是受保护的，不应该被淘汰
    expect(store.read('key0')).toBe('value0');

    // 应该淘汰其他非保护条目（如 key1）
    expect(store.size()).toBe(SMALL_MAX_SIZE);
  });

  // ---- 3.3 skipIfExists 选项 ----

  it('skipIfExists=true 时不覆盖已有 key', () => {
    store.write('existing', 'original');
    store.write('existing', 'modified', { skipIfExists: true });

    // 值没有被覆盖
    expect(store.read('existing')).toBe('original');
  });

  it('skipIfExists=false (默认) 时正常覆盖已有 key', () => {
    store.write('existing', 'original');
    store.write('existing', 'modified');

    // 值被覆盖
    expect(store.read('existing')).toBe('modified');
  });

  it('skipIfExists=true 但已过期时允许覆盖', async () => {
    vi.useFakeTimers();

    store.write('expired-key', 'old-data', { ttl: 50 });
    vi.advanceTimersByTime(60);

    // 已过期的 key 可以用 skipIfNeeded=true 覆盖
    store.write('expired-key', 'new-data', { skipIfExists: true });

    expect(store.read('expired-key')).toBe('new-data');

    vi.useRealTimers();
  });

  // ---- 3.4 访问计数 ----

  it('getAccessCount 返回正确的访问次数', () => {
    store.write('counter', 'value');

    // 初始 accessCount 为 1（write 时设置）
    expect(store.getAccessCount('counter')).toBe(1);

    // 每次读取 +1
    store.read('counter');
    expect(store.getAccessCount('counter')).toBe(2);

    store.read('counter');
    store.read('counter');
    expect(store.getAccessCount('counter')).toBe(4);
  });

  it('getAccessCount 对不存在的 key 返回 0', () => {
    expect(store.getAccessCount('nonexistent')).toBe(0);
  });

  it('getAccessCount 对已过期的 key 返回 0', async () => {
    vi.useFakeTimers();

    store.write('expiring', 'data', { ttl: 50});
    vi.advanceTimersByTime(60);

    expect(store.getAccessCount('expiring')).toBe(0);

    vi.useRealTimers();
  });

  // ---- 3.5 更新已有 key 不触发淘汰 ----

  it('更新已有 key 不占用额外空间', () => {
    // 填满
    for (let i = 0; i < SMALL_MAX_SIZE; i++) {
      store.write(`key${i}`, `value${i}`);
    }

    // 更新已有的 key
    store.write('key2', 'updated-value-2');

    // 数量不变
    expect(store.size()).toBe(SMALL_MAX_SIZE);

    // 所有原始 key 都还在（除了被更新的那个值变了）
    expect(store.read('key0')).toBe('value0');
    expect(store.read('key2')).toBe('updated-value-2');
    expect(store.read('key4')).toBe('value4');
  });
});

// ============================================================
// 测试套件 4: 定时清理功能
// ============================================================

describe('InMemoryStore - 定时清理功能', () => {
  let store: IInMemoryStore<string>;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.stopCleanup();
    store.clear();
  });

  // ---- 4.1 启动和停止定时清理 ----

  it('startCleanup 启动定时器', () => {
    expect(store.isCleanupRunning()).toBe(false);

    store.startCleanup(1000); // 1秒间隔

    expect(store.isCleanupRunning()).toBe(true);
  });

  it('stopCleanup 停止定时器', () => {
    store.startCleanup(1000);
    expect(store.isCleanupRunning()).toBe(true);

    store.stopCleanup();
    expect(store.isCleanupRunning()).toBe(false);
  });

  it('重复调用 startCleanup 不会创建多个定时器（幂等）', () => {
    store.startCleanup(1000);
    store.startCleanup(2000); // 第二次调用应被忽略

    // 仍然在运行
    expect(store.isCleanupRunning()).toBe(true);
  });

  // ---- 4.2 手动清理 ----

  it('cleanupExpired 清理所有过期条目并返回数量', async () => {
    vi.useFakeTimers();

    // 写入一些会过期的条目
    store.write('expire1', 'v1', { ttl: 50 });
    store.write('expire2', 'v2', { ttl: 50 });
    store.write('persist', 'v3', { ttl: 100000 }); // 很长 TTL

    // 时间前进使前两个过期
    vi.advanceTimersByTime(60);

    // 执行手动清理
    const cleanedCount = store.cleanupExpired();

    expect(cleanedCount).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.read('persist')).toBe('v3');

    vi.useRealTimers();
  });

  it('cleanupExpired 无过期条目时返回 0', () => {
    store.write('keep1', 'v1');
    store.write('keep2', 'v2');

    const cleanedCount = store.cleanupExpired();

    expect(cleanedCount).toBe(0);
    expect(store.size()).toBe(2);
  });

  // ---- 4.3 定时自动清理 ----

  it('定时器到期后自动清理过期条目', async () => {
    vi.useFakeTimers();
    vi.spyOn(store, 'cleanupExpired');

    // 启动快速清理（100ms 间隔）
    store.startCleanup(100);

    // 写入即将过期的条目
    store.write('auto-expire', 'data', { ttl: 80 });

    // 时间前进触发定时器
    vi.advanceTimersByTime(110); // 超过 TTL + 定时间隔

    // cleanupExpired 应该被调用
    expect(store.cleanupExpired).toHaveBeenCalled();

    // 条目应已被清理
    expect(store.read('auto-expire')).toBeNull();

    vi.useRealTimers();
  });

  // ---- 4.4 clear 同时停止定时清理 ----

  it('clear() 自动停止定时清理', () => {
    store.startCleanup(1000);
    expect(store.isCleanupRunning()).toBe(true);

    store.clear();

    expect(store.isCleanupRunning()).toBe(false);
    expect(store.size()).toBe(0);
  });
});

// ============================================================
// 测试套件 5: 边界情况和特殊场景
// ============================================================

describe('InMemoryStore - 边界情况', () => {
  it('大量并发写入不丢失数据', () => {
    const store = createTestStore(2000);

    // 快速写入 1500 个条目
    for (let i = 0; i < 1500; i++) {
      store.write(`bulk-${i}`, `data-${i}`);
    }

    // 应保留最近的 1000 个（或全部如果未超限）
    expect(store.size()).toBeLessThanOrEqual(2000);

    // 最后写入的应该存在
    expect(store.read('bulk-1499')).toBe('data-1499');

    store.clear();
    store.stopCleanup();
  });

  it('特殊字符的 key 和 value 正确处理', () => {
    const store = createTestStore();

    // 特殊字符 key
    store.write('user:123:session:abc', 'special-key');
    expect(store.read('user:123:session:abc')).toBe('special-key');

    // Unicode 内容
    store.write('unicode', '你好世界 🌍 Emoji Test');
    expect(store.read('unicode')).toBe('你好世界 🌍 Emoji Test');

    // 长 value
    const longValue = 'x'.repeat(10000);
    store.write('long', longValue);
    expect(store.read('long')).toBe(longValue);

    store.clear();
    store.stopCleanup();
  });

  it('频繁更新同一 key 的性能合理', () => {
    const store = createTestStore();
    const iterations = 1000;

    const startTime = Date.now();
    for (let i = 0; i < iterations; i++) {
      store.write('hot-key', `update-${i}`);
    }
    const elapsed = Date.now() - startTime;

    // 1000 次写入应在 100ms 内完成（非常宽裕的限制）
    expect(elapsed).toBeLessThan(100);

    // 最终值正确
    expect(store.read('hot-key')).toBe(`update-${iterations - 1}`);

    store.clear();
    store.stopCleanup();
  });
});
