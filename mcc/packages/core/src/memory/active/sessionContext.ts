/**
 * SessionContext - Session 会话生命周期管理
 *
 * 实现功能:
 * - Task 1A.1.3.3: Session CRUD 操作
 * - Session 消息管理
 * - 过期会话自动清理
 * - 基于 Redis 的持久化存储（支持降级到 InMemoryStore）
 *
 * @module sessionContext
 */

import { randomUUID } from 'node:crypto';
import logger from './logger.js';
import type {
  IRedisStore,
  ISessionManager,
  Session,
  SessionMessage,
  CreateMessageInput,
  WriteOptions,
} from './types.js';
import { DEFAULT_TTL_MS } from './types.js';

// ============================================================
// 常量定义
// ============================================================

/** Session 键前缀 */
const SESSION_KEY_PREFIX = 'session:';

/** 消息列表键后缀 */
const MESSAGES_LIST_SUFFIX = ':messages';

/** 消息索引键前缀 */
const MSG_INDEX_PREFIX = ':msg:';

// ============================================================
// 辅助函数
// ============================================================

/**
 * 生成 Session 存储键名
 *
 * @param sessionId - 会话 ID
 * @returns Redis 键名
 */
function getSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * 生成消息列表键名
 *
 * @param sessionId - 会话 ID
 * @returns Redis List 键名
 */
function getMessagesKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}${MESSAGES_LIST_SUFFIX}`;
}

/**
 * 生成消息索引键名
 *
 * @param sessionId - 会话 ID
 * @param msgId - 消息 ID
 * @returns Redis Hash 键名
 */
function getMessageIndexKey(sessionId: string, msgId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}${MSG_INDEX_PREFIX}${msgId}`;
}

/**
 * 创建新的 Session 对象
 *
 * @param metadata - 可选元数据
 * @returns 新的 Session 实例
 */
function createNewSession(metadata?: Record<string, unknown>): Session {
  const now = Date.now();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    ttl: DEFAULT_TTL_MS,
    status: 'active',
    metadata: metadata ?? {},
  };
}

/**
 * 创建新的 SessionMessage 对象
 *
 * @param sessionId - 会话 ID
 * @param input - 消息输入
 * @returns 新的 SessionMessage 实例
 */
function createNewMessage(
  sessionId: string,
  input: CreateMessageInput,
): SessionMessage {
  return {
    id: randomUUID(),
    sessionId,
    role: input.role,
    content: input.content,
    timestamp: Date.now(),
    metadata: input.metadata ?? {},
  };
}

// ============================================================
// SessionManager 实现
// ============================================================

/**
 * Session 管理器
 *
 * 基于 IRedisStore 实现 Session 生命周期和消息存储。
 * 支持降级模式：当 Redis 不可用时，通过 IRedisStore 内部的降级机制
 * 自动切换到 InMemoryStore，调用方无需感知。
 *
 * 存储策略:
 * - Session 元数据: Redis String (`session:{id}`)
 * - Session 消息: Redis List (`session:{id}:messages`)
 * - 消息索引: Redis Hash (`session:{id}:msg:{msgId}`)
 *
 * @implements ISessionManager
 *
 * @example
 * ```typescript
 * const redisStore = new RedisStore();
 * await redisStore.connect();
 * const sessionManager = new SessionManager(redisStore);
 *
 * const session = await sessionManager.createSession({ userId: '123' });
 * const message = await sessionManager.addMessage(session.id, {
 *   role: 'user',
 *   content: 'Hello!',
 * });
 * ```
 */
export class SessionManager implements ISessionManager {
  /** 底层存储引擎 */
  private readonly store: IRedisStore;

  /**
   * 创建 SessionManager 实例
   *
   * @param store - Redis 存储引擎实例
   */
  constructor(store: IRedisStore) {
    this.store = store;
    logger.info(
      { module: 'session-manager', action: 'init' },
      'SessionManager initialized',
    );
  }

  // ---- Session CRUD ----

  /**
   * 创建新会话
   *
   * 生成唯一 UUID 作为会话 ID，设置默认 TTL 和状态。
   *
   * @param metadata - 可选的自定义元数据
   * @returns 新创建的 Session 对象
   *
   * @example
   * ```typescript
   * const session = await manager.createSession({
   *   userId: 'user-123',
   *   agentType: 'planner',
   * });
   * console.log(session.id); // => 'uuid-string'
   * ```
   */
  async createSession(
    metadata?: Record<string, unknown>,
  ): Promise<Session> {
    const session = createNewSession(metadata);

    // 存储到 Redis String
    await this.store.write(getSessionKey(session.id), session, {
      ttl: session.ttl,
    });

    logger.info(
      {
        module: 'session-manager',
        action: 'create-session',
        sessionId: session.id,
        metadata,
      },
      'Session created',
    );

    return session;
  }

  /**
   * 获取指定会话
   *
   * 从 Redis 读取并反序列化 Session 对象。
   * 如果会话已过期或不存在返回 null。
   *
   * @param sessionId - 会话 ID
   * @returns Session 对象，不存在返回 null
   */
  async getSession(sessionId: string): Promise<Session | null> {
    try {
      const value = await this.store.read(getSessionKey(sessionId));

      if (!value) {
        return null;
      }

      // 类型断言：确保读取的是 Session 类型
      const session = value as Session;

      logger.debug(
        { module: 'session-manager', action: 'get-session', sessionId },
        'Session retrieved',
      );

      return session;
    } catch (err) {
      logger.error(
        {
          module: 'session-manager',
          action: 'get-session-error',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to get session',
      );
      return null;
    }
  }

  /**
   * 更新会话信息
   *
   * 部分更新 Session 字段（不能更新 id 和 createdAt）。
   * 自动更新 updatedAt 时间戳。
   *
   * @param sessionId - 会话 ID
   * @param updates - 要更新的字段
   *
   * @example
   * ```typescript
   * await manager.updateSession('uuid', {
   *   status: 'closed',
   *   metadata: { ...existingMeta, closedAt: Date.now() },
   * });
   * ```
   */
  async updateSession(
    sessionId: string,
    updates: Partial<Omit<Session, 'id' | 'createdAt'>>,
  ): Promise<void> {
    const existing = await this.getSession(sessionId);

    if (!existing) {
      logger.warn(
        { module: 'session-manager', action: 'update-session-not-found', sessionId },
        'Cannot update: session not found',
      );
      return;
    }

    // 合并更新
    const updated: Session = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    // 写回存储
    const writeOptions: WriteOptions = {};
    if (existing.ttl > 0) {
      writeOptions.ttl = existing.ttl;
    }
    await this.store.write(getSessionKey(sessionId), updated, writeOptions);

    logger.info(
      {
        module: 'session-manager',
        action: 'update-session',
        sessionId,
        updatedFields: Object.keys(updates),
      },
      'Session updated',
    );
  }

  /**
   * 关闭会话
   *
   * 将状态设置为 'closed'。
   *
   * @param sessionId - 会话 ID
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { status: 'closed' });

    logger.info(
      { module: 'session-manager', action: 'close-session', sessionId },
      'Session closed',
    );
  }

  // ---- 消息管理 ----

  /**
   * 向会话添加一条消息
   *
   * 同时写入消息列表和消息索引。
   * 使用 Redis List 保持消息顺序，使用 Hash 建立索引便于查询。
   *
   * @param sessionId - 会话 ID
   * @param message - 消息内容
   * @returns 完整的 SessionMessage 对象（含生成的 id 和 timestamp）
   *
   * @example
   * ```typescript
   * const message = await manager.addMessage('session-id', {
   *   role: 'agent',
   *   content: 'I can help you with that.',
   * });
   * ```
   */
  async addMessage(
    sessionId: string,
    message: CreateMessageInput,
  ): Promise<SessionMessage> {
    // 验证会话存在且活跃
    const session = await this.getSession(sessionId);
    if (!session || session.status === 'closed') {
      throw new Error(
        `Cannot add message to ${!session ? 'non-existent' : 'closed'} session`,
      );
    }

    // 创建新消息对象
    const newMessage = createNewMessage(sessionId, message);

    // 写入消息列表（List 右侧推入，保持时间顺序）
    const messagesKey = getMessagesKey(sessionId);
    await this.store.listPushRight(messagesKey, newMessage);

    // 写入消息索引（Hash，用于快速查找单条消息）
    const indexKey = getMessageIndexKey(sessionId, newMessage.id);
    await this.store.hashWrite(indexKey, 'data', newMessage);

    // 更新会话的 updatedAt
    await this.updateSession(sessionId, {});

    logger.debug(
      {
        module: 'session-manager',
        action: 'add-message',
        sessionId,
        messageId: newMessage.id,
        role: message.role,
      },
      'Message added to session',
    );

    return newMessage;
  }

  /**
   * 获取会话的消息列表
   *
   * 按 timestamp 正序排列（从旧到新）。
   * 支持 limit 参数限制返回数量。
   *
   * @param sessionId - 会话 ID
   * @param limit - 最大返回条数，不传则返回全部
   * @returns 消息数组
   */
  async getMessages(
    sessionId: string,
    limit?: number,
  ): Promise<SessionMessage[]> {
    const messagesKey = getMessagesKey(sessionId);
    const listLength = await this.store.listLength(messagesKey);

    if (listLength === 0) {
      return [];
    }

    // 计算范围：获取最新的 N 条消息
    let start = 0;
    let stop = -1; // 表示到最后

    if (limit && limit < listLength) {
      // 只取最新的 limit 条
      start = Math.max(0, listLength - limit);
      stop = -1;
    }

    const values = await this.store.listRange(messagesKey, start, stop);

    // 反序列化并过滤有效消息
    const messages: SessionMessage[] = [];
    for (const value of values) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        'role' in value &&
        'content' in value
      ) {
        messages.push(value as SessionMessage);
      }
    }

    logger.debug(
      {
        module: 'session-manager',
        action: 'get-messages',
        sessionId,
        count: messages.length,
        total: listLength,
        limit,
      },
      'Messages retrieved from session',
    );

    return messages;
  }

  /**
   * 获取会话最后一条消息
   *
   * 高效实现：只读取 List 最后一个元素，不需要加载整个列表。
   *
   * @param sessionId - 会话 ID
   * @returns 最后一条消息，没有则返回 null
   */
  async getLastMessage(sessionId: string): Promise<SessionMessage | null> {
    const messagesKey = getMessagesKey(sessionId);
    const listLength = await this.store.listLength(messagesKey);

    if (listLength === 0) {
      return null;
    }

    // 只取最后一个元素
    const values = await this.store.listRange(messagesKey, -1, -1);

    if (values.length === 0) {
      return null;
    }

    const lastValue = values[0];
    if (
      typeof lastValue === 'object' &&
      lastValue !== null &&
      'id' in lastValue &&
      'role' in lastValue &&
      'content' in lastValue
    ) {
      return lastValue as SessionMessage;
    }

    return null;
  }

  async getMessageById(
    sessionId: string,
    messageId: string,
  ): Promise<SessionMessage | null> {
    const indexKey = getMessageIndexKey(sessionId, messageId);
    const value = await this.store.hashRead(indexKey, 'data');

    if (!value) {
      return null;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      'role' in value &&
      'content' in value
    ) {
      return value as SessionMessage;
    }

    return null;
  }

  // ---- 查询 ----

  /**
   * 获取所有活跃会话
   *
   * 扫描所有 session:* 键，筛选 status='active' 的会话。
   *
   * @returns 活跃 Session 数组
   */
  async getActiveSessions(): Promise<Session[]> {
    const allKeys = await this.store.keys(`${SESSION_KEY_PREFIX}*`);

    // 排除消息列表键和消息索引键
    const sessionKeys = allKeys.filter((key) => {
      return !key.includes(MESSAGES_LIST_SUFFIX) && !key.includes(MSG_INDEX_PREFIX);
    });

    const activeSessions: Session[] = [];

    for (const key of sessionKeys) {
      try {
        const value = await this.store.read(key);
        if (value) {
          const session = value as Session;
          if (session.status === 'active') {
            activeSessions.push(session);
          }
        }
      } catch (err) {
        logger.warn(
          {
            module: 'session-manager',
            action: 'get-active-sessions-read-error',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to read session key during scan',
        );
      }
    }

    logger.debug(
      {
        module: 'session-manager',
        action: 'get-active-sessions',
        count: activeSessions.length,
      },
      'Active sessions retrieved',
    );

    return activeSessions;
  }

  /**
   * 获取所有过期会话
   *
   * 扫描所有 session:* 键，检查 TTL 是否已过期。
   * 注意：Redis 会自动删除过期的 key，所以这里主要检查
   * 降级模式下 InMemoryStore 中可能残留的过期会话。
   *
   * @returns 过期 Session 数组
   */
  async getExpiredSessions(): Promise<Session[]> {
    const allKeys = await this.store.keys(`${SESSION_KEY_PREFIX}*`);

    // 排除消息列表键和消息索引键
    const sessionKeys = allKeys.filter((key) => {
      return !key.includes(MESSAGES_LIST_SUFFIX) && !key.includes(MSG_INDEX_PREFIX);
    });

    const now = Date.now();
    const expiredSessions: Session[] = [];

    for (const key of sessionKeys) {
      try {
        const value = await this.store.read(key);
        if (value) {
          const session = value as Session;
          // 检查是否过期：createdAt + ttl < now
          if (session.ttl > 0 && session.createdAt + session.ttl < now) {
            expiredSessions.push(session);
          } else if (session.status === 'expired') {
            expiredSessions.push(session);
          }
        }
      } catch (err) {
        logger.warn(
          {
            module: 'session-manager',
            action: 'get-expired-sessions-read-error',
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to read session key during expiration check',
        );
      }
    }

    logger.debug(
      {
        module: 'session-manager',
        action: 'get-expired-sessions',
        count: expiredSessions.length,
      },
      'Expired sessions found',
    );

    return expiredSessions;
  }

  // ---- 清理 ----

  /**
   * 清理过期会话及其消息
   *
   * 删除所有过期会话的:
   * - Session 元数据 (String)
   * - 消息列表 (List)
   * - 消息索引 (Hash)
   *
   * @returns 清理的会话数量
   */
  async cleanupExpiredSessions(): Promise<number> {
    const expiredSessions = await this.getExpiredSessions();
    let cleanedCount = 0;

    for (const session of expiredSessions) {
      try {
        // 删除 Session 元数据
        const sessionDeleted = await this.store.delete(getSessionKey(session.id));
        if (sessionDeleted) {
          cleanedCount += 1;
        }

        // 删除消息列表
        await this.store.listDeleteKey(getMessagesKey(session.id));

        // 清理该 session 的所有消息索引
        const msgListKeys = await this.store.keys(`${getSessionKey(session.id)}${MSG_INDEX_PREFIX}*`);
        for (const msgIdxKey of msgListKeys) {
          await this.store.delete(msgIdxKey);
        }
      } catch (err) {
        logger.error(
          {
            module: 'session-manager',
            action: 'cleanup-expired-session-error',
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to clean up expired session',
        );
      }
    }

    if (cleanedCount > 0) {
      logger.info(
        {
          module: 'session-manager',
          action: 'cleanup-expired-sessions',
          cleanedCount,
        },
        'Expired sessions cleaned up',
      );
    }

    return cleanedCount;
  }
}

// ============================================================
// 导出
// ============================================================

export default SessionManager;
