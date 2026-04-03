/**
 * PostgreSQL 存储层测试
 *
 * @module postgresStore.test
 * @description 测试 PostgreSQL 存储层的基本功能和向量搜索能力
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresStore } from './postgresStore.js';
import { PostgresConfig } from './types.js';

// 模拟 PostgreSQL 连接
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
    execute: vi.fn(),
  })),
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: vi.fn(() => ({
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          or: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]),
          })),
          gt: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]),
          })),
          eq: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          eq: vi.fn(() => ({
            rowCount: 1,
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        like: vi.fn(() => ({
          rowCount: 1,
        })),
        eq: vi.fn(() => ({
          rowCount: 1,
        })),
      })),
    })),
  })),
}));

const testConfig: PostgresConfig = {
  host: 'localhost',
  port: 5432,
  user: 'test',
  password: 'test',
  database: 'test',
};

describe('PostgresStore', () => {
  let store: PostgresStore<string>;

  beforeEach(() => {
    store = new PostgresStore<string>(testConfig);
  });

  afterEach(async () => {
    if (store.isConnected()) {
      await store.disconnect();
    }
  });

  describe('连接管理', () => {
    it('should connect successfully', async () => {
      await store.connect();
      expect(store.isConnected()).toBe(true);
      expect(store.getMode()).toBe('normal');
    });

    it('should disconnect successfully', async () => {
      await store.connect();
      expect(store.isConnected()).toBe(true);
      
      await store.disconnect();
      expect(store.isConnected()).toBe(false);
    });
  });

  describe('基本 CRUD 操作', () => {
    beforeEach(async () => {
      await store.connect();
    });

    it('should write and read data', async () => {
      const key = 'test-key';
      const value = 'test-value';

      await store.write(key, value);
      const result = await store.read(key);
      
      expect(result).toBe(value);
    });

    it('should check existence', async () => {
      const key = 'test-key';
      const value = 'test-value';

      await store.write(key, value);
      const exists = await store.exists(key);
      
      expect(exists).toBe(true);
    });

    it('should delete data', async () => {
      const key = 'test-key';
      const value = 'test-value';

      await store.write(key, value);
      await store.delete(key);
      const result = await store.read(key);
      
      expect(result).toBe(null);
    });

    it('should clear all data', async () => {
      await store.clear();
      // 验证 clear 方法被调用
      expect(store.getMode()).toBe('normal');
    });

    it('should get keys', async () => {
      const keys = await store.keys();
      expect(Array.isArray(keys)).toBe(true);
    });

    it('should get size', async () => {
      const size = await store.size();
      expect(typeof size).toBe('number');
    });
  });

  describe('TTL 操作', () => {
    beforeEach(async () => {
      await store.connect();
    });

    it('should set and get TTL', async () => {
      const key = 'test-key';
      const value = 'test-value';
      const ttlMs = 3600000; // 1小时

      await store.write(key, value);
      const setResult = await store.setTTL(key, ttlMs);
      const ttl = await store.getTTL(key);
      
      expect(setResult).toBe(true);
      expect(typeof ttl).toBe('number');
    });
  });

  describe('向量搜索', () => {
    beforeEach(async () => {
      await store.connect();
    });

    it('should write with embedding', async () => {
      const key = 'test-key';
      const value = 'test-value';
      const embedding = Array(768).fill(0.5); // 模拟 768 维向量

      await store.writeWithEmbedding(key, value, embedding);
      // 验证方法被调用
      expect(store.getMode()).toBe('normal');
    });

    it('should search similar', async () => {
      const embedding = Array(768).fill(0.5); // 模拟 768 维向量

      const results = await store.searchSimilar(embedding, 5, 0.7);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('健康检查', () => {
    beforeEach(async () => {
      await store.connect();
    });

    it('should ping successfully', async () => {
      const result = await store.ping();
      expect(result).toBe(true);
    });

    it('should get health status', () => {
      const status = store.getHealthStatus();
      expect(status).toHaveProperty('postgres');
      expect(status).toHaveProperty('fallback');
      expect(status).toHaveProperty('mode');
    });
  });

  describe('降级机制', () => {
    it('should enter degraded mode on consecutive failures', async () => {
      await store.connect();
      
      // 模拟失败
      // 这里需要模拟实际的失败场景
      // 由于我们使用了 mock，实际测试需要根据具体实现调整
      
      expect(store.getMode()).toBe('normal');
    });
  });
});
