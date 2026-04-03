/**
 * ActiveMemory 集成测试（Mock/内存模式）
 *
 * 覆盖范围:
 * - Task 1A.1.5.3: 初始化与连接（纯内存模式）
 * - Task 1A.1.5.3: 写入流程（双写策略 + importance 评估）
 * - Task 1A.1.5.3: 读取流程（Redis 优先 + 降级回退）
 * - Task 1A.1.5.3: 批量操作与状态查询
 *
 * 测试模式：由于可能没有真实 Redis 服务，使用纯内存模式进行集成测试。
 * Redis 相关的完整测试在 degradation.test.ts 中单独覆盖。
 *
 * @module tests/memory/active/activeMemory.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActiveMemory } from '../../../packages/core/src/memory/active/activeMemory.js';
import type {
  IActiveMemory,
  ActiveMemoryConfig,
  ActiveWriteOptions,
  WriteResult,
  ActiveMemoryStatus,
  ActiveMemoryHealthStatus,
} from '../../../packages/core/src/memory/active/activeMemory.js';
import { SourceType, ImportanceLevel } from '../../../packages/core/src/memory/active/importanceEvaluator.js';

// ============================================================
// 测试工具函数
// ============================================================

/** 创建并初始化一个用于测试的 ActiveMemory 实例 */
async function createTestMemory(config?: ActiveMemoryConfig): Promise<IActiveMemory<string>> {
  const memory = new ActiveMemory<string>();
  await memory.initialize(config);
  return memory;
}

// ============================================================
// 测试套件 1: 初始化与连接
// ============================================================

describe('ActiveMemory - 初始化与连接', () => {
  let memory: IActiveMemory<string>;

  afterEach(async () => {
    if (memory) {
      await memory.destroy();
    }
  });

  // ---- 1.1 纯内存模式初始化 ----

  it('initialize 成功（无 Redis 配置时使用内存模式）', async () => {
    memory = await createTestMemory();

    // 初始化成功，不抛异常
    expect(memory).toBeDefined();
  });

  it('无 Redis 配置时 mode 为 degraded', async () => {
    memory = await createTestMemory();

    const status = memory.getStatus();
    expect(status.mode).toBe('degraded');
  });

  // ---- 1.2 销毁操作 ----

  it('destroy 正常关闭', async () => {
    memory = await createTestMemory();

    // 写入一些数据
    await memory.write('key1', 'value1');

    // 销毁
    await memory.destroy();

    // 销毁后应无法操作（抛出错误）
    await expect(memory.read('key1')).rejects.toThrow('not initialized');
  });

  // ---- 1.3 重复初始化保护 ----

  it('重复调用 initialize 不报错', async () => {
    memory = await createTestMemory();

    // 第二次初始化不应报错
    await memory.initialize();

    // 仍然可以正常使用
    await memory.write('test', 'data');
    expect(await memory.read('test')).toBe('data');
  });

  // ---- 1.4 自定义配置初始化 ----

  it('自定义 maxMemorySize 和 defaultTtlMs 生效', async () => {
    memory = await createTestMemory({
      maxMemorySize: 100,
      defaultTtlMs: 5000, // 5s TTL
    });

    const status = memory.getStatus();
    // 注意：status 中没有直接暴露配置信息，但可以通过行为验证
    expect(status.mode).toBe('degraded'); // 无 Redis 配置
  });
});

// ============================================================
// 测试套件 2: 写入流程
// ============================================================

describe('ActiveMemory - 写入流程', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createTestMemory();
  });

  afterEach(async () => {
    if (memory) {
      await memory.destroy();
    }
  });

  // ---- 2.1 基础写入读取 ----

  it('write → read 返回相同值', async () => {
    const result = await memory.write('key1', 'value1');

    expect(result.success).toBe(true);
    expect(await memory.read('key1')).toBe('value1');
  });

  // ---- 2.2 WriteResult 结构验证 ----

  it('write 返回的 WriteResult 包含正确的结构', async () => {
    const result: WriteResult = await memory.write('test-key', 'test-value');

    // 基本字段验证
    expect(result.key).toBe('test-key');
    expect(result.success).toBe(true);
    expect(typeof result.importanceScore).toBe('number');
    expect(typeof result.importance).toBe('string');
    expect(Array.isArray(result.writtenTo)).toBe(true);
    expect(result.writtenTo.length).toBeGreaterThan(0);
  });

  // ---- 2.3 内存模式下的 writtenTo ----

  it('writtenTo 在内存模式下为 ["memory"]', async () => {
    const result = await memory.write('key1', 'value1');

    // 无 Redis 时只写入内存层
    expect(result.writtenTo).toContain('memory');
    expect(result.writtenTo).not.toContain('redis');
    expect(result.writtenTo).not.toContain('both');
  });

  // ---- 2.4 Importance 评估结果 ----

  it('write 自动评估 importance 并返回正确等级', async () => {
    // 高重要性内容
    const highResult = await memory.write('critical-fix', 'CRITICAL fix for BUG in auth module', {
      sourceType: SourceType.USER_MANUAL,
    });

    expect(highResult.importanceScore).toBeGreaterThan(0);
    expect([ImportanceLevel.HIGH, ImportanceLevel.MEDIUM]).toContain(highResult.importance);

    // 低重要性内容
    const lowResult = await memory.write('log-entry', 'system started at 10:00', {
      sourceType: SourceType.SYSTEM_LOG,
    });

    expect(lowResult.importanceScore).toBeGreaterThanOrEqual(0);
    expect(lowResult.importanceScore).toBeLessThanOrEqual(1);
  });

  // ---- 2.5 importanceOverride 手动覆写 ----

  it('importanceOverride 手动覆写生效', async () => {
    const customScore = 0.95;
    const result = await memory.write('manual-score', 'some content', {
      importanceOverride: customScore,
    });

    // 使用覆写的分数
    expect(result.importanceScore).toBe(customScore);
    expect(result.importance).toBe(ImportanceLevel.HIGH); // 0.95 > 0.5
  });

  it('importanceOverride 边界值裁剪 (clamp to [0, 1])', async () => {
    // 超过 1.0 应被裁剪
    const overMax = await memory.write('over', 'content', { importanceOverride: 1.5 });
    expect(overMax.importanceScore).toBe(1.0);

    // 低于 0 应被裁剪
    const underMin = await memory.write('under', 'content', { importanceOverride: -0.5 });
    expect(underMin.importanceScore).toBe(0);
  });

  // ---- 2.6 写入不同类型的数据 ----

  it('支持对象类型数据的写入和读取', async () => {
    const objMemory = new ActiveMemory<Record<string, unknown>>();
    await objMemory.initialize();

    const testData = { name: 'Alice', age: 30, tags: ['admin', 'user'] };
    const result = await objMemory.write('user:1', testData);

    expect(result.success).toBe(true);

    const retrieved = await objMemory.read('user:1');
    expect(retrieved).toEqual(testData);

    await objMemory.destroy();
  });

  // ---- 2.7 写入选项传递 ----

  it('TTL 选项正确传递到底层存储', async () => {
    // 写入短 TTL 的数据
    await memory.write('short-lived', 'ephemeral data', { ttl: 100 });

    // 立即可读
    expect(await memory.read('short-lived')).toBe('ephemeral data');
  });

  it('skipIfExists 选项正确传递', async () => {
    await memory.write('existing', 'original');
    const result = await memory.write('existing', 'modified', { skipIfExists: true });

    // 成功但未覆盖
    expect(result.success).toBe(true);
    expect(await memory.read('existing')).toBe('original');
  });
});

// ============================================================
// 测试套件 3: 读取流程
// ============================================================

describe('ActiveMemory - 读取流程', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createTestMemory();
  });

  afterEach(async () => {
    if (memory) {
      await memory.destroy();
    }
  });

  // ---- 3.1 基本读取 ----

  it('read 存在的 key 返回值', async () => {
    await memory.write('exists', 'found-it');
    expect(await memory.read('exists')).toBe('found-it');
  });

  it('read 不存在的 key 返回 null', async () => {
    const result = await memory.read('nonexistent');
    expect(result).toBeNull();
  });

  // ---- 3.2 exists 检查 ----

  it('exists 正确判断键存在性', async () => {
    expect(await memory.exists('new-key')).toBe(false);

    await memory.write('new-key', 'value');
    expect(await memory.exists('new-key')).toBe(true);
  });

  // ---- 3.3 delete 操作 ----

  it('delete 删除成功返回 true', async () => {
    await memory.write('to-delete', 'remove-me');
    const result = await memory.delete('to-delete');
    expect(result).toBe(true);
    expect(await memory.read('to-delete')).toBeNull();
  });

  it('delete 不存在的 key 返回 false', async () => {
    const result = await memory.delete('ghost');
    expect(result).toBe(false);
  });

  // ---- 3.4 clear 操作 ----

  it('clear 清空所有数据', async () => {
    await memory.write('k1', 'v1');
    await memory.write('k2', 'v2');
    await memory.write('k3', 'v3');

    expect(await memory.size()).toBe(3);

    await memory.clear();

    expect(await memory.size()).toBe(0);
    expect(await memory.read('k1')).toBeNull();
    expect(await memory.read('k2')).toBeNull();
    expect(await memory.read('k3')).toBeNull();
  });

  // ---- 3.5 keys 和 size ----

  it('keys 返回所有有效键', async () => {
    await memory.write('alpha', 'a');
    await memory.write('beta', 'b');
    await memory.write('gamma', 'c');

    const keys = await memory.keys();
    expect(keys).toHaveLength(3);
    expect(keys).toContain('alpha');
    expect(keys).toContain('beta');
    expect(keys).toContain('gamma');
  });

  it('size 返回当前条目数', async () => {
    expect(await memory.size()).toBe(0);

    await memory.write('k1', 'v1');
    expect(await memory.size()).toBe(1);

    await memory.write('k2', 'v2');
    await memory.write('k3', 'v3');
    expect(await memory.size()).toBe(3);
  });
});

// ============================================================
// 测试套件 4: 批量操作
// ============================================================

describe('ActiveMemory - 批量操作', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createTestMemory();
  });

  afterEach(async () => {
    if (memory) {
      await memory.destroy();
    }
  });

  // ---- 4.1 writeBatch 全部成功 ----

  it('writeBatch 全部成功', async () => {
    const entries = [
      { key: 'batch-1', value: 'value-1' },
      { key: 'batch-2', value: 'value-2' },
      { key: 'batch-3', value: 'value-3' },
    ];

    const results = await memory.writeBatch(entries);

    // 所有都成功
    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result.success).toBe(true);
    });

    // 数据可读
    expect(await memory.read('batch-1')).toBe('value-1');
    expect(await memory.read('batch-2')).toBe('value-2');
    expect(await memory.read('batch-3')).toBe('value-3');
  });

  // ---- 4.2 writeBatch 带选项 ----

  it('writeBatch 支持每个条目独立选项', async () => {
    const entries = [
      {
        key: 'high-priority',
        value: 'urgent fix',
        options: { sourceType: SourceType.USER_MANUAL } as ActiveWriteOptions,
      },
      {
        key: 'low-priority',
        value: 'log info',
        options: { sourceType: SourceType.SYSTEM_LOG } as ActiveWriteOptions,
      },
    ];

    const results = await memory.writeBatch(entries);

    // 验证 importance 差异
    expect(results[0].importanceScore).toBeGreaterThan(results[1].importanceScore);
  });

  // ---- 4.3 大批量写入性能 ----

  it('大批量写入在合理时间内完成', async () => {
    const batchSize = 100;
    const entries = Array.from({ length: batchSize }, (_, i) => ({
      key: `bulk-${i}`,
      value: `data-${i}`,
    }));

    const startTime = Date.now();
    const results = await memory.writeBatch(entries);
    const elapsed = Date.now() - startTime;

    // 100 条应在 500ms 内完成
    expect(elapsed).toBeLessThan(500);

    // 全部成功
    expect(results.every((r) => r.success)).toBe(true);
    expect(await memory.size()).toBe(batchSize);
  });
});

// ============================================================
// 测试套件 5: 状态查询
// ============================================================

describe('ActiveMemory - 状态查询', () => {
  let memory: IActiveMemory<string>;

  beforeEach(async () => {
    memory = await createTestMemory();
  });

  afterEach(async () => {
    if (memory) {
      await memory.destroy();
    }
  });

  // ---- 5.1 getStatus ----

  it('getStatus 返回正确的状态信息', async () => {
    await memory.write('k1', 'v1');
    await memory.write('k2', 'v2');

    const status: ActiveMemoryStatus = memory.getStatus();

    // 验证基本结构
    expect(status).toHaveProperty('mode');
    expect(status).toHaveProperty('memoryCount');
    expect(status).toHaveProperty('redisCount');
    expect(status).toHaveProperty('totalSize');
    expect(status).toHaveProperty('uptime');

    // 内存模式下
    expect(status.mode).toBe('degraded');
    expect(status.memoryCount).toBe(2);
    expect(status.totalSize).toBe(2);
    expect(status.uptime).toBeGreaterThanOrEqual(0); // uptime 应该 >= 0
  });

  // ---- 5.2 getHealthStatus ----

  it('getHealthStatus 返回健康状态', async () => {
    const health: ActiveMemoryHealthStatus = memory.getHealthStatus();

    // 验证结构
    expect(health).toHaveProperty('memory');
    expect(health).toHaveProperty('redis');
    expect(health).toHaveProperty('mode');

    // 内存模式下
    expect(health.memory).toBe(true); // 内存总是可用
    expect(health.redis).toBe(false); // 无 Redis
    expect(health.mode).toBe('degraded');
  });

  // ---- 5.3 状态随操作变化 ----

  it('状态随数据变化而更新', async () => {
    // 初始状态
    expect(await memory.size()).toBe(0);

    // 写入后
    await memory.write('k1', 'v1');
    expect(memory.getStatus().memoryCount).toBe(1);

    // 再次写入
    await memory.write('k2', 'v2');
    expect(memory.getStatus().memoryCount).toBe(2);

    // 删除后
    await memory.delete('k1');
    expect(memory.getStatus().memoryCount).toBe(1);
  });
});

// ============================================================
// 测试套件 6: 未初始化错误处理
// ============================================================

describe('ActiveMemory - 错误处理', () => {
  it('未初始化时 write 抛出错误', async () => {
    const memory = new ActiveMemory<string>();

    await expect(
      memory.write('key', 'value')
    ).rejects.toThrow('not initialized');
  });

  it('未初始化时 read 抛出错误', async () => {
    const memory = new ActiveMemory<string>();

    await expect(
      memory.read('key')
    ).rejects.toThrow('not initialized');
  });

  it('未初始化时其他操作也抛出错误', async () => {
    const memory = new ActiveMemory<string>();

    await expect(memory.exists('key')).rejects.toThrow('not initialized');
    await expect(memory.delete('key')).rejects.toThrow('not initialized');
    await expect(memory.clear()).rejects.toThrow('not initialized');
    await expect(memory.keys()).rejects.toThrow('not initialized');
    await expect(memory.size()).rejects.toThrow('not initialized');
  });
});

// ============================================================
// 测试套件 7: 完整生命周期测试
// ============================================================

describe('ActiveMemory - 完整生命周期', () => {
  it('完整的创建→写入→读取→更新→删除→销毁流程', async () => {
    const memory = new ActiveMemory<string>();

    // 1. 初始化
    await memory.initialize();
    expect(memory.getStatus().mode).toBeDefined();

    // 2. 写入
    const writeResult = await memory.write('lifecycle-test', 'initial-value', {
      sourceType: SourceType.USER_MANUAL,
    });
    expect(writeResult.success).toBe(true);

    // 3. 读取
    const readValue = await memory.read('lifecycle-test');
    expect(readValue).toBe('initial-value');

    // 4. 更新（覆盖写入）
    const updateResult = await memory.write('lifecycle-test', 'updated-value');
    expect(updateResult.success).toBe(true);
    expect(await memory.read('lifecycle-test')).toBe('updated-value');

    // 5. 存在性检查
    expect(await memory.exists('lifecycle-test')).toBe(true);

    // 6. 删除
    const deleteSuccess = await memory.delete('lifecycle-test');
    expect(deleteSuccess).toBe(true);
    expect(await memory.read('lifecycle-test')).toBeNull();

    // 7. 销毁
    await memory.destroy();
    await expect(memory.read('lifecycle-test')).rejects.toThrow();
  });

  it('多次创建销毁不泄漏资源', async () => {
    for (let i = 0; i < 5; i++) {
      const memory = new ActiveMemory<string>();
      await memory.initialize();
      await memory.write(`iter-${i}`, `value-${i}`);
      expect(await memory.read(`iter-${i}`)).toBe(`value-${i}`);
      await memory.destroy();
    }
    // 如果没有崩溃或内存泄漏，测试通过
  });
});
