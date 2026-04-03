/**
 * ACP 协议类型定义
 *
 * @module types
 * @description 定义 ACP (Agent Communication Protocol) 协议的核心类型
 */

// ============================================================
// 消息类型
// ============================================================

/**
 * 消息类型
 */
export enum MessageType {
  TEXT = 'text',
  JSON = 'json',
  BINARY = 'binary',
  ERROR = 'error',
}

/**
 * 消息优先级
 */
export enum MessagePriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * ACP 消息
 */
export interface ACPMessage {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: MessageType;
  /** 发送者 ID */
  sender: string;
  /** 接收者 ID */
  recipient: string;
  /** 消息内容 */
  content: any;
  /** 消息优先级 */
  priority?: MessagePriority;
  /** 时间戳 */
  timestamp: number;
  /** 会话 ID */
  sessionId?: string;
  /** 元数据 */
  metadata?: Record<string, any>;
}

// ============================================================
// 请求类型
// ============================================================

/**
 * 请求类型
 */
export enum RequestType {
  SEND_MESSAGE = 'send_message',
  GET_AGENT_INFO = 'get_agent_info',
  DISCOVER_AGENTS = 'discover_agents',
  SUBSCRIBE_EVENTS = 'subscribe_events',
  UNSUBSCRIBE_EVENTS = 'unsubscribe_events',
}

/**
 * ACP 请求
 */
export interface ACPRequest {
  /** 请求 ID */
  id: string;
  /** 请求类型 */
  type: RequestType;
  /** 发送者 ID */
  sender: string;
  /** 请求数据 */
  data: any;
  /** 时间戳 */
  timestamp: number;
  /** 会话 ID */
  sessionId?: string;
}

// ============================================================
// 响应类型
// ============================================================

/**
 * 响应状态
 */
export enum ResponseStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  PENDING = 'pending',
}

/**
 * ACP 响应
 */
export interface ACPResponse {
  /** 响应 ID */
  id: string;
  /** 对应的请求 ID */
  requestId: string;
  /** 响应状态 */
  status: ResponseStatus;
  /** 响应数据 */
  data?: any;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
  /** 会话 ID */
  sessionId?: string;
}

// ============================================================
// 事件类型
// ============================================================

/**
 * 事件类型
 */
export enum EventType {
  TASK_STARTED = 'task_started',
  TASK_COMPLETED = 'task_completed',
  TASK_FAILED = 'task_failed',
  AGENT_CONNECTED = 'agent_connected',
  AGENT_DISCONNECTED = 'agent_disconnected',
  MESSAGE_RECEIVED = 'message_received',
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
}

/**
 * ACP 事件
 */
export interface ACPEvent {
  /** 事件 ID */
  id: string;
  /** 事件类型 */
  type: EventType;
  /** 发送者 ID */
  sender: string;
  /** 事件数据 */
  data: any;
  /** 时间戳 */
  timestamp: number;
  /** 会话 ID */
  sessionId?: string;
}

// ============================================================
// 智能体类型
// ============================================================

/**
 * 智能体状态
 */
export enum AgentStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  BUSY = 'busy',
  AWAY = 'away',
}

/**
 * 智能体信息
 */
export interface AgentInfo {
  /** 智能体 ID */
  id: string;
  /** 智能体名称 */
  name: string;
  /** 智能体描述 */
  description: string;
  /** 智能体状态 */
  status: AgentStatus;
  /** 智能体版本 */
  version: string;
  /** 支持的消息类型 */
  supportedMessageTypes: MessageType[];
  /** 支持的事件类型 */
  supportedEventTypes: EventType[];
  /** 能力列表 */
  capabilities: string[];
  /** 最后活跃时间 */
  lastActive?: number;
  /** 元数据 */
  metadata?: Record<string, any>;
}

// ============================================================
// 会话类型
// ============================================================

/**
 * 会话状态
 */
export enum SessionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  CLOSED = 'closed',
}

/**
 * 会话信息
 */
export interface SessionInfo {
  /** 会话 ID */
  id: string;
  /** 会话状态 */
  status: SessionStatus;
  /** 参与者列表 */
  participants: string[];
  /** 创建时间 */
  createdAt: number;
  /** 最后活动时间 */
  lastActive: number;
  /** 元数据 */
  metadata?: Record<string, any>;
}

// ============================================================
// 错误类型
// ============================================================

/**
 * ACP 错误
 */
export class ACPError extends Error {
  code: string;
  data?: any;

  constructor(message: string, code: string, data?: any) {
    super(message);
    this.name = 'ACPError';
    this.code = code;
    this.data = data;
  }
}

// ============================================================
// 客户端配置类型
// ============================================================

/**
 * ACP 客户端配置
 */
export interface ACPClientConfig {
  /** 服务器 URL */
  serverUrl: string;
  /** 客户端 ID */
  clientId: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 重试次数 */
  retryCount?: number;
  /** 重试间隔（毫秒） */
  retryInterval?: number;
  /** 是否启用 SSL */
  secure?: boolean;
}

// ============================================================
// 服务器配置类型
// ============================================================

/**
 * ACP 服务器配置
 */
export interface ACPServerConfig {
  /** 服务器端口 */
  port?: number;
  /** 服务器主机 */
  host?: string;
  /** 是否启用 SSL */
  secure?: boolean;
  /** 最大消息大小 */
  maxMessageSize?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
}

// ============================================================
// 实用工具类型
// ============================================================

/**
 * 文本消息请求
 */
export interface TextMessageRequest {
  text: string;
  recipient?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
}

/**
 * 文本消息响应
 */
export interface TextMessageResponse {
  text: string;
  sender: string;
  sessionId?: string;
  metadata?: Record<string, any>;
}

/**
 * 事件通知请求
 */
export interface EventNotificationRequest {
  type: EventType;
  data: any;
  sessionId?: string;
  metadata?: Record<string, any>;
}

/**
 * 事件通知响应
 */
export interface EventNotificationResponse {
  success: boolean;
  message: string;
  eventId: string;
}

/**
 * 智能体发现响应
 */
export interface AgentDiscoveryResponse {
  agents: AgentInfo[];
  total: number;
  timestamp: number;
}

/**
 * 智能体信息响应
 */
export interface AgentInfoResponse {
  agent: AgentInfo;
  timestamp: number;
}