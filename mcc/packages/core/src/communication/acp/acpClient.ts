/**
 * ACP 客户端实现
 *
 * @module acpClient
 * @description 实现 ACP (Agent Communication Protocol) 客户端，用于与本地 Trae 通信
 */

import { 
  ACPClientConfig, 
  ACPMessage, 
  ACPRequest, 
  ACPResponse, 
  ACPEvent, 
  MessageType, 
  RequestType, 
  EventType, 
  ResponseStatus, 
  AgentInfo, 
  TextMessageRequest, 
  TextMessageResponse, 
  EventNotificationRequest, 
  EventNotificationResponse, 
  AgentDiscoveryResponse, 
  AgentInfoResponse,
  ACPError
} from './types.js';
import logger from '../../memory/active/logger.js';

/**
 * ACP 客户端实现
 */
export class ACPClient {
  private config: ACPClientConfig;
  private sessionId: string;

  /**
   * 构造函数
   */
  constructor(serverUrl: string, clientId: string, config?: Partial<ACPClientConfig>) {
    this.config = {
      serverUrl,
      clientId,
      timeout: config?.timeout || 30000,
      retryCount: config?.retryCount || 3,
      retryInterval: config?.retryInterval || 1000,
      secure: config?.secure || false,
    };
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${this.config.clientId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 发送 HTTP 请求
   */
  private async sendHttpRequest(endpoint: string, method: string, data?: any): Promise<any> {
    const url = `${this.config.serverUrl}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-ACP-Client-Id': this.config.clientId,
        'X-ACP-Session-Id': this.sessionId,
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    let retries = 0;
    while (retries <= this.config.retryCount!) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        return result;
      } catch (error) {
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new ACPError('Request timeout', 'TIMEOUT');
          }
        }

        retries++;
        if (retries > this.config.retryCount!) {
          throw new ACPError(
            `Failed to send request after ${this.config.retryCount} retries`,
            'NETWORK_ERROR',
            { error: error instanceof Error ? error.message : String(error) }
          );
        }

        await new Promise(resolve => setTimeout(resolve, this.config.retryInterval!));
      }
    }

    throw new ACPError('Failed to send request', 'UNKNOWN_ERROR');
  }

  /**
   * 发送完整的 ACP 消息
   */
  async sendMessage(message: ACPMessage): Promise<ACPResponse> {
    try {
      logger.debug(
        { module: 'acp-client', action: 'send-message', recipient: message.recipient },
        'Sending ACP message'
      );

      const response = await this.sendHttpRequest('/acp/message', 'POST', message);

      logger.debug(
        { module: 'acp-client', action: 'send-message-success', messageId: message.id },
        'ACP message sent successfully'
      );

      return response;
    } catch (error) {
      logger.error(
        { module: 'acp-client', action: 'send-message-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to send ACP message'
      );
      throw error;
    }
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(request: TextMessageRequest): Promise<TextMessageResponse> {
    try {
      logger.debug(
        { module: 'acp-client', action: 'send-text-message', text: request.text },
        'Sending text message'
      );

      const response = await this.sendHttpRequest('/acp/message/text', 'POST', request);

      logger.debug(
        { module: 'acp-client', action: 'send-text-message-success', responseText: response.text },
        'Text message sent successfully'
      );

      return response;
    } catch (error) {
      logger.error(
        { module: 'acp-client', action: 'send-text-message-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to send text message'
      );
      throw error;
    }
  }

  /**
   * 发送事件通知
   */
  async sendEvent(type: EventType, data: any, options?: {
    sessionId?: string;
    metadata?: Record<string, any>;
  }): Promise<EventNotificationResponse> {
    try {
      const request: EventNotificationRequest = {
        type,
        data,
        sessionId: options?.sessionId || this.sessionId,
        metadata: options?.metadata,
      };

      logger.debug(
        { module: 'acp-client', action: 'send-event', eventType: type },
        'Sending event notification'
      );

      const response = await this.sendHttpRequest('/acp/event', 'POST', request);

      logger.debug(
        { module: 'acp-client', action: 'send-event-success', eventId: response.eventId },
        'Event notification sent successfully'
      );

      return response;
    } catch (error) {
      logger.error(
        { module: 'acp-client', action: 'send-event-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to send event notification'
      );
      throw error;
    }
  }

  /**
   * 发现智能体
   */
  async discoverAgents(): Promise<AgentInfo[]> {
    try {
      logger.debug(
        { module: 'acp-client', action: 'discover-agents' },
        'Discovering agents'
      );

      const response = await this.sendHttpRequest('/acp/discovery', 'GET');

      logger.debug(
        { module: 'acp-client', action: 'discover-agents-success', agentCount: response.agents.length },
        'Agents discovered successfully'
      );

      return response.agents;
    } catch (error) {
      logger.error(
        { module: 'acp-client', action: 'discover-agents-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to discover agents'
      );
      throw error;
    }
  }

  /**
   * 获取智能体信息
   */
  async getAgentInfo(agentId: string): Promise<AgentInfo> {
    try {
      logger.debug(
        { module: 'acp-client', action: 'get-agent-info', agentId },
        'Getting agent info'
      );

      const response = await this.sendHttpRequest(`/acp/agent/info?agentId=${encodeURIComponent(agentId)}`, 'GET');

      logger.debug(
        { module: 'acp-client', action: 'get-agent-info-success', agentName: response.agent.name },
        'Agent info retrieved successfully'
      );

      return response.agent;
    } catch (error) {
      logger.error(
        { module: 'acp-client', action: 'get-agent-info-error', agentId, error: error instanceof Error ? error.message : String(error) },
        'Failed to get agent info'
      );
      throw error;
    }
  }

  /**
   * 设置会话 ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    logger.debug(
      { module: 'acp-client', action: 'set-session-id', sessionId },
      'Session ID set'
    );
  }

  /**
   * 获取会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取客户端配置
   */
  getConfig(): ACPClientConfig {
    return { ...this.config };
  }

  /**
   * 关闭客户端
   */
  async close(): Promise<void> {
    // 清理资源
    logger.debug(
      { module: 'acp-client', action: 'close' },
      'ACPClient closed'
    );
  }
}

/**
 * 创建 ACP 客户端实例
 */
export function createACPClient(serverUrl: string, clientId: string, config?: Partial<ACPClientConfig>): ACPClient {
  return new ACPClient(serverUrl, clientId, config);
}