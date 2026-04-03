/**
 * 降级路径专项测试
 *
 * 覆盖范围:
 * - Task 1A.1.5.4: Redis 连接失败时的自动降级
 * - Task 1A.1.5.4: 降级模式下的读写行为验证
 * - Task 1A.1.5.4: 降级期间的数据一致性保证
 * - Task 1A.1.5.4: enableDegradation=false 时的错误传播
 *
 * 测试策略:
 * - 使用无效的 Redis 配置触发连接失败
 * - 验证系统自动切换到 InMemoryStore fallback
 * - 确保降级模式下所有操作正常工作
 * - 测试禁止降级时的异常行为
 *
 * @module tests/memory/active/degradation.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActiveMemory } from '../../../packages/core/src/memory/active/activeMemory.js';
import type {
  IActiveMemory,
  ActiveMemoryConfig,
  WriteResult,
  ActiveMemoryHealthStatus,
} from '../../../packages/core/src/memory/active/activeMemory.js';
import { SourceType } from '../../../packages/core/src/memory/active/importanceEvaluator.js';

// ============================================================
// 测试常量
// ============================================================

/** 无效的 Redis 配置（用于触发连接失败） */
const INVALID_REDIS_CONFIG: ActiveMemoryConfig['redis'] = {
  host: '127.0.0.1', // localhost 但端口不可用
  port: 19999,       // 非标准端口，几乎不会有服务
};

// ============================================================
// 测试工具函数
// ============================================================

/** 创建使用无效 Redis 配置的 ActiveMemory（应自动降级）*/
async function createDegradedMemory(
  enableDegradation = true,
): Promise<IActiveMemory<string>> {
  const memory = new ActiveMemory<string>();

  try {
    await memory.initialize({
      redis: INVALID_REDIS_CONFIG,
      enableDegradation,
    });
  } catch (err) {
    // 如果禁用降级且 Redis 不可用，会抛出异常
    if (!enableDegradation) {
      throw err;
    }
  }

  return memory;
}

// ============================================================
// 测试套件 1: Redis 连接失败降级
// ============================================================

describe('降级路径 - Redis 连接失败', () => {
  let memory: IActiveMemory<string>;

  afterEach(async () => {
    if (memory) {
      try {
        await memory.destroy();
      } catch {
        // 忽略销毁错误
      }
    }
  });

  // ---- 1.1 自动降级不抛错 ----

  it('提供无效 host:port → initialize 不抛错（降级模式）', async () => {
    // 应该成功初始化（虽然 Redis 连接失败但允许降级）
    memory = await createDegradedMemory(true);

    // 不应该抛出异常
    expect(memory).toBeDefined();

    // 验证处于降级模式
    const health = memory.getHealthStatus();
    expect(health.mode).toBe('degraded');
  });

  it('降级模式下的健康状态正确', async () => {
    memory = await createDegradedMemory(true);

    const health: ActiveMemoryHealthStatus = memory.getHealthStatus();

    // 内存可用
    expect(health.memory).toBe(true);
    // Redis 不可用
    expect(health.redis).toBe(false);
    // 模式为降级
    expect(health.mode).toBe('degraded');
  });

  // ---- 1.2 禁止降级时抛错 ----

  it('enableDegradation=false + 无效 Redis → initialize 抛出异常', async () => {
    const memory = new ActiveMemory<string>();

    await expect(
      memory.initialize({
        redis: INVALID_REDIS_CONFIG,
        enableDegradation: false,
      })
    ).rejects.toThrow(); // 应该抛出连接错误
  });

  // ---- 1.3 状态信息反映降级状态 ----

  it('getStatus 反映降级状态', async () => {
    memory = await createDegradedMemory(true);

    const status = memory.getStatus();

    expect(status.mode).toBe('degraded');
    expect(status.redisCount).toBe(0); // 无 Redis 数据
  });
});

// ============================================================
// 测试套件 2: 降级模式下的读写行为
// ============================================================

describe('降级路径 - 读写行为验证', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createDegradedMemory(true);
  });

  afterEach(async () => {
    if (memory) {
      try {
        await memory.destroy();
      } catch {
        // 忽略
      }
    }
  });

  // ---- 2.1 降级后的写入只走内存Map ----

  it('降级后写入只走内存Map', async () => {
    const result: WriteResult = await memory.write('degraded-key', 'degraded-value');

    // 写入成功
    expect(result.success).toBe(true);

    // writtenTo 只包含 memory（不含 redis 或 both）
    expect(result.writtenTo).toEqual(['memory']);
    expect(result.writtenTo).not.toContain('redis');
    expect(result.writtenTo).not.toContain('both');

    // importance 评估仍然正常工作
    expect(typeof result.importanceScore).toBe('number');
    expect(result.importanceScore).toBeGreaterThanOrEqual(0);
  });

  // ---- 2.2 降级后的读取只从内存Map ----

  it('降级后读取只从内存Map', async () => {
    // 先写入
    await memory.write('read-test', 'readable-value');

    // 读取
    const value = await memory.read('read-test');

    // 正确返回
    expect(value).toBe('readable-value');
  });

  // ---- 2.3 批量写入在降级模式下正常工作 ----

  it('writeBatch 在降级模式下全部成功', async () => {
    const entries = [
      { key: 'batch-1', value: 'value-1' },
      { key: 'batch-2', value: 'value-2' },
      { key: 'batch-3', value: 'value-3' },
    ];

    const results = await memory.writeBatch(entries);

    // 全部成功
    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      expect(result.writtenTo).toEqual(['memory']);
    });

    // 全部可读
    expect(await memory.read('batch-1')).toBe('value-1');
    expect(await memory.read('batch-2')).toBe('value-2');
    expect(await memory.read('batch-3')).toBe('value-3');
  });

  // ---- 2.4 其他 CRUD 操作正常 ----

  it('exists/delete/clear/keys/size 在降级模式下正常', async () => {
    // exists
    expect(await memory.exists('new')).toBe(false);
    await memory.write('new', 'data');
    expect(await memory.exists('new')).toBe(true);

    // delete
    expect(await memory.delete('new')).toBe(true);
    expect(await memory.read('new')).toBeNull();

    // clear 和 keys
    await memory.write('k1', 'v1');
    await memory.write('k2', 'v2');
    expect(await memory.keys()).toHaveLength(2);
    await memory.clear();
    expect(await memory.keys()).toHaveLength(0);

    // size
    await memory.write('a', '1');
    await memory.write('b', '2');
    await memory.write('c', '3');
    expect(await memory.size()).toBe(3);
  });
});

// ============================================================
// 测试套件 3: 降级期间的数据一致性
// ============================================================

describe('降级路径 - 数据一致性验证', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createDegradedMemory(true);
  });

  afterEach(async () => {
    if (memory) {
      try {
        await memory.destroy();
      } catch {
        // 忽略
      }
    }
  });

  // ---- 3.1 先写入的数据在降级期间可读 ----

  it('降级模式下先写入的数据在降级期间可读', async () => {
    // 写入多个条目
    const testData = [
      { key: 'consistency-1', value: 'persistent-data-1' },
      { key: 'consistency-2', value: 'persistent-data-2' },
      { key: 'consistency-3', value: 'persistent-data-3' },
    ];

    for (const entry of testData) {
      await memory.write(entry.key, entry.value);
    }

    // 所有数据都可读
    for (const entry of testData) {
      const value = await memory.read(entry.key);
      expect(value).toBe(entry.value);
    }
  });

  // ---- 3.2 size() 返回正确数量 ----

  it('降级模式下 size() 返回正确数量', async () => {
    // 初始为空
    expect(await memory.size()).toBe(0);

    // 逐个添加并验证
    for (let i = 0; i < 10; i++) {
      await memory.write(`count-${i}`, `value-${i}`);
      expect(await memory.size()).toBe(i + 1);
    }

    // 删除部分后重新计数
    await memory.delete('count-5');
    expect(await memory.size()).toBe(9);
  });

  // ---- 3.3 多次更新保持一致性 ----

  it('多次更新同一 key 保持最终值一致', async () => {
    // 写入初始值
    await memory.write('update-key', 'version-1');
    expect(await memory.read('update-key')).toBe('version-1');

    // 多次更新
    await memory.write('update-key', 'version-2');
    expect(await memory.read('update-key')).toBe('version-2');

    await memory.write('update-key', 'version-3');
    expect(await memory.read('update-key')).toBe('version-3');

    await memory.write('update-key', 'final-version');
    expect(await memory.read('update-key')).toBe('final-version');
  });

  // ---- 3.4 并发写入的一致性 ----

  it('快速连续写入后数据完整', async () => {
    const count = 50;
    const writes = [];

    // 快速连续写入
    for (let i = 0; i < count; i++) {
      writes.push(memory.write(`concurrent-${i}`, `data-${i}`));
    }

    // 等待全部完成
    await Promise.all(writes);

    // 验证数量
    expect(await memory.size()).toBe(count);

    // 验证每个值都正确
    for (let i = 0; i < count; i++) {
      const value = await memory.read(`concurrent-${i}`);
      expect(value).toBe(`data-${i}`);
    }
  });

  // ---- 3.5 Importance 评估在降级模式下正常 ----

  it('Importance 评估在降级模式下不受影响', async () => {
    // 高重要性内容
    const highResult = await memory.write('important', 'CRITICAL BUG fix needed urgently', {
      sourceType: SourceType.USER_MANUAL,
    });

    expect(highResult.importanceScore).toBeGreaterThan(0);
    expect(highResult.success).toBe(true);

    // 低重要性内容
    const lowResult = await memory.write('trivial', 'just a log message', {
      sourceType: SourceType.SYSTEM_LOG,
    });

    expect(lowResult.importanceScore).toBeLessThan(highResult.importanceScore);
    expect(lowResult.success).toBe(true);
  });
});

// ============================================================
// 测试套件 4: 降级与正常模式对比
// ============================================================

describe('降级路径 - 模式对比', () => {
  it('纯内存模式与降级模式的行为一致', async () => {
    // 创建两个实例：一个纯内存，一个降级模式
    const pureMemory = new ActiveMemory<string>();
    await pureMemory.initialize(); // 无 Redis 配置

    const degradedMemory = new ActiveMemory<string>();
    await degradedMemory.initialize({
      redis: INVALID_REDIS_CONFIG, // 触发降级
      enableDegradation: true,
    });

    try {
      // 对两者执行相同操作
      const testKey = 'compare-key';
      const testValue = 'compare-value';

      // 写入
      const pureWrite = await pureMemory.write(testKey, testValue);
      const degrWrite = await degradedMemory.write(testKey, testValue);

      // 都成功
      expect(pureWrite.success).toBe(true);
      expect(degrWrite.success).toBe(true);

      // 读取
      expect(await pureMemory.read(testKey)).toBe(testValue);
      expect(await degradedMemory.read(testKey)).toBe(testValue);

      // 状态对比
      expect(pureMemory.getStatus().mode).toBe('degraded'); // 纯内存也是 degraded
      expect(degradedMemory.getStatus().mode).toBe('degraded');

      // 健康状态对比
      expect(pureMemory.getHealthStatus().memory).toBe(true);
      expect(degradedMemory.getHealthStatus().memory).toBe(true);
      expect(pureMemory.getHealthStatus().redis).toBe(false);
      expect(degradedMemory.getHealthStatus().redis).toBe(false);
    } finally {
      await pureMemory.destroy();
      await degradedMemory.destroy();
    }
  });
});

// ============================================================
// 测试套件 5: 边界情况和容错
// ============================================================

describe('降级路径 - 边界情况与容错', () => {
  it('降级模式下大量数据操作稳定', async () => {
    const memory = await createDegradedMemory(true);

    try {
      // 写入大量数据
      const largeCount = 500;
      for (let i = 0; i < largeCount; i++) {
        await memory.write(`large-${i}`, `x`.repeat(100)); // 每个 100 字符
      }

      // 验证数量
      expect(await memory.size()).toBe(largeCount);

      // 随机抽样验证
      const sampleIndices = [0, 100, 250, 499];
      for (const idx of sampleIndices) {
        const value = await memory.read(`large-${idx}`);
        expect(value).toBe('x'.repeat(100));
      }

      // 清空
      await memory.clear();
      expect(await memory.size()).toBe(0);
    } finally {
      await memory.destroy();
    }
  });

  it('降级模式下频繁创建销毁不泄漏', async () => {
    for (let round = 0; round < 10; round++) {
      const memory = await createDegradedMemory(true);

      // 每轮执行一些操作
      await memory.write(`round-${round}-key`, `round-${round}-value`);
      expect(await memory.read(`round-${round}-key`)).toBe(`round-${round}-value`);

      // 销毁
      await memory.destroy();
    }
    // 如果没有崩溃或内存问题，测试通过
  });

  it('降级模式下特殊字符和 Unicode 正确处理', async () => {
    const memory = await createDegradedMemory(true);

    try {
      // 特殊字符 key
      await memory.write('user:123:session:abc:def', 'special-chars-ok');
      expect(await memory.read('user:123:session:abc:def')).toBe('special-chars-ok');

      // Unicode 内容
      await memory.write('unicode', '中文测试 🎉 Emoji and 日本語');
      expect(await memory.read('unicode')).toBe('中文测试 🎉 Emoji and 日本語');

      // 长内容
      const longContent = 'y'.repeat(10000);
      await memory.write('long-content', longContent);
      expect(await memory.read('long-content')).toBe(longContent);
    } finally {
      await memory.destroy();
    }
  });
});
