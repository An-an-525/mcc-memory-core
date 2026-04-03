/**
 * ACP 服务器实现
 *
 * @module acp
 * @description 实现 ACP (Agent Communication Protocol) 服务器，用于处理本地 Trae 的请求
 */

import { Hono } from 'hono';
import { 
  ACPMessage, 
  ACPEvent, 
  AgentInfo, 
  MessageType, 
  EventType, 
  AgentStatus, 
  TextMessageRequest, 
  TextMessageResponse, 
  EventNotificationRequest, 
  EventNotificationResponse, 
  AgentDiscoveryResponse, 
  AgentInfoResponse
} from '@mcc/core/communication/acp/types.js';
import logger from '../core/src/memory/active/logger.js';

/**
 * ACP 服务器
 */
export class ACPServer {
  private app: Hono;
  private agents: Map<string, AgentInfo> = new Map();
  private eventHandlers: Map<EventType, Array<(event: ACPEvent) => void>> = new Map();

  /**
   * 构造函数
   */
  constructor() {
    this.app = new Hono();
    this.initializeRoutes();
    this.initializeAgents();
  }

  /**
   * 初始化路由
   */
  private initializeRoutes() {
    // 发送完整的 ACP 消息
    this.app.post('/acp/message', this.handleMessage.bind(this));

    // 发送文本消息
    this.app.post('/acp/message/text', this.handleTextMessage.bind(this));

    // 发送事件通知
    this.app.post('/acp/event', this.handleEvent.bind(this));

    // 发现智能体
    this.app.get('/acp/discovery', this.handleDiscovery.bind(this));

    // 获取智能体信息
    this.app.get('/acp/agent/info', this.handleAgentInfo.bind(this));
  }

  /**
   * 初始化智能体
   */
  private initializeAgents() {
    // 添加本地 Trae 智能体
    this.agents.set('trae-agent', {
      id: 'trae-agent',
      name: 'Local Trae',
      description: '本地 Trae 智能体',
      status: AgentStatus.ONLINE,
      version: '1.0.0',
      supportedMessageTypes: [MessageType.TEXT, MessageType.JSON],
      supportedEventTypes: [
        EventType.TASK_STARTED,
        EventType.TASK_COMPLETED,
        EventType.TASK_FAILED,
        EventType.AGENT_CONNECTED,
        EventType.AGENT_DISCONNECTED,
        EventType.MESSAGE_RECEIVED,
        EventType.ERROR,
        EventType.WARNING,
        EventType.INFO,
      ],
      capabilities: ['chat', 'task_execution', 'code_generation', 'knowledge_retrieval'],
      lastActive: Date.now(),
      metadata: {
        platform: 'local',
        language: 'Chinese',
        timezone: 'Asia/Shanghai',
      },
    });

    // 添加 MCC 智能体
    this.agents.set('mcc-agent', {
      id: 'mcc-agent',
      name: 'MCC Agent',
      description: 'MCC 记忆核心智能体',
      status: AgentStatus.ONLINE,
      version: '1.0.0',
      supportedMessageTypes: [MessageType.TEXT, MessageType.JSON],
      supportedEventTypes: [
        EventType.TASK_STARTED,
        EventType.TASK_COMPLETED,
        EventType.TASK_FAILED,
        EventType.AGENT_CONNECTED,
        EventType.AGENT_DISCONNECTED,
        EventType.MESSAGE_RECEIVED,
        EventType.ERROR,
        EventType.WARNING,
        EventType.INFO,
      ],
      capabilities: ['memory_management', 'skill_evolution', 'task_execution'],
      lastActive: Date.now(),
      metadata: {
        platform: 'local',
        language: 'Chinese',
        timezone: 'Asia/Shanghai',
      },
    });
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `acp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 处理完整的 ACP 消息
   */
  private async handleMessage(c: any) {
    try {
      const message: ACPMessage = await c.req.json();
      
      logger.debug(
        { module: 'acp-server', action: 'handle-message', sender: message.sender, recipient: message.recipient },
        'Received ACP message'
      );

      // 验证消息
      if (!message.id || !message.sender || !message.recipient || !message.content) {
        return c.json({
          id: this.generateId(),
          requestId: message.id,
          status: 'error',
          error: 'Invalid message format',
          timestamp: Date.now(),
        }, 400);
      }

      // 处理消息
      const response = {
        id: this.generateId(),
        requestId: message.id,
        status: 'success',
        data: {
          message: 'Message received',
          receivedAt: Date.now(),
        },
        timestamp: Date.now(),
      };

      logger.debug(
        { module: 'acp-server', action: 'handle-message-success', messageId: message.id },
        'ACP message processed successfully'
      );

      return c.json(response);
    } catch (error) {
      logger.error(
        { module: 'acp-server', action: 'handle-message-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to process ACP message'
      );
      return c.json({
        id: this.generateId(),
        status: 'error',
        error: 'Internal server error',
        timestamp: Date.now(),
      }, 500);
    }
  }

  /**
   * 处理文本消息
   */
  private async handleTextMessage(c: any) {
    try {
      const request: TextMessageRequest = await c.req.json();
      
      logger.debug(
        { module: 'acp-server', action: 'handle-text-message', text: request.text },
        'Received text message'
      );

      // 验证请求
      if (!request.text) {
        return c.json({
          error: 'Text is required',
        }, 400);
      }

      // 生成响应
      const response: TextMessageResponse = {
        text: `你好！我是本地Trae，很高兴与你交流。你刚才说：${request.text}`,
        sender: 'trae-agent',
        sessionId: request.sessionId,
        metadata: request.metadata,
      };

      logger.debug(
        { module: 'acp-server', action: 'handle-text-message-success', responseText: response.text },
        'Text message processed successfully'
      );

      return c.json(response);
    } catch (error) {
      logger.error(
        { module: 'acp-server', action: 'handle-text-message-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to process text message'
      );
      return c.json({
        error: 'Internal server error',
      }, 500);
    }
  }

  /**
   * 处理事件通知
   */
  private async handleEvent(c: any) {
    try {
      const request: EventNotificationRequest = await c.req.json();
      
      logger.debug(
        { module: 'acp-server', action: 'handle-event', eventType: request.type },
        'Received event notification'
      );

      // 验证请求
      if (!request.type) {
        return c.json({
          error: 'Event type is required',
        }, 400);
      }

      // 创建事件
      const event: ACPEvent = {
        id: this.generateId(),
        type: request.type,
        sender: 'mcc-agent',
        data: request.data,
        timestamp: Date.now(),
        sessionId: request.sessionId,
      };

      // 触发事件处理器
      this.triggerEventHandlers(event);

      // 生成响应
      const response: EventNotificationResponse = {
        success: true,
        message: 'Event received',
        eventId: event.id,
      };

      logger.debug(
        { module: 'acp-server', action: 'handle-event-success', eventId: event.id },
        'Event notification processed successfully'
      );

      return c.json(response);
    } catch (error) {
      logger.error(
        { module: 'acp-server', action: 'handle-event-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to process event notification'
      );
      return c.json({
        error: 'Internal server error',
      }, 500);
    }
  }

  /**
   * 处理智能体发现
   */
  private async handleDiscovery(c: any) {
    try {
      const agents = Array.from(this.agents.values());
      
      logger.debug(
        { module: 'acp-server', action: 'handle-discovery', agentCount: agents.length },
        'Processing agent discovery request'
      );

      const response: AgentDiscoveryResponse = {
        agents,
        total: agents.length,
        timestamp: Date.now(),
      };

      logger.debug(
        { module: 'acp-server', action: 'handle-discovery-success', agentCount: agents.length },
        'Agent discovery processed successfully'
      );

      return c.json(response);
    } catch (error) {
      logger.error(
        { module: 'acp-server', action: 'handle-discovery-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to process agent discovery request'
      );
      return c.json({
        error: 'Internal server error',
      }, 500);
    }
  }

  /**
   * 处理智能体信息请求
   */
  private async handleAgentInfo(c: any) {
    try {
      const agentId = c.req.query('agentId');
      
      logger.debug(
        { module: 'acp-server', action: 'handle-agent-info', agentId },
        'Processing agent info request'
      );

      if (!agentId) {
        return c.json({
          error: 'Agent ID is required',
        }, 400);
      }

      const agent = this.agents.get(agentId);
      if (!agent) {
        return c.json({
          error: 'Agent not found',
        }, 404);
      }

      const response: AgentInfoResponse = {
        agent,
        timestamp: Date.now(),
      };

      logger.debug(
        { module: 'acp-server', action: 'handle-agent-info-success', agentName: agent.name },
        'Agent info processed successfully'
      );

      return c.json(response);
    } catch (error) {
      logger.error(
        { module: 'acp-server', action: 'handle-agent-info-error', error: error instanceof Error ? error.message : String(error) },
        'Failed to process agent info request'
      );
      return c.json({
        error: 'Internal server error',
      }, 500);
    }
  }

  /**
   * 触发事件处理器
   */
  private triggerEventHandlers(event: ACPEvent) {
    const handlers = this.eventHandlers.get(event.type) || [];
    handlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        logger.error(
          { module: 'acp-server', action: 'trigger-event-handler-error', eventType: event.type, error: error instanceof Error ? error.message : String(error) },
          'Failed to trigger event handler'
        );
      }
    });
  }

  /**
   * 注册事件处理器
   */
  registerEventHandler(type: EventType, handler: (event: ACPEvent) => void): void {
    const handlers = this.eventHandlers.get(type) || [];
    handlers.push(handler);
    this.eventHandlers.set(type, handlers);
    
    logger.debug(
      { module: 'acp-server', action: 'register-event-handler', eventType: type },
      'Event handler registered'
    );
  }

  /**
   * 移除事件处理器
   */
  removeEventHandler(type: EventType, handler: (event: ACPEvent) => void): void {
    const handlers = this.eventHandlers.get(type) || [];
    const filteredHandlers = handlers.filter(h => h !== handler);
    this.eventHandlers.set(type, filteredHandlers);
    
    logger.debug(
      { module: 'acp-server', action: 'remove-event-handler', eventType: type },
      'Event handler removed'
    );
  }

  /**
   * 添加智能体
   */
  addAgent(agent: AgentInfo): void {
    this.agents.set(agent.id, agent);
    
    logger.debug(
      { module: 'acp-server', action: 'add-agent', agentId: agent.id, agentName: agent.name },
      'Agent added'
    );
  }

  /**
   * 更新智能体
   */
  updateAgent(agentId: string, updates: Partial<AgentInfo>): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      this.agents.set(agentId, { ...agent, ...updates });
      
      logger.debug(
        { module: 'acp-server', action: 'update-agent', agentId },
        'Agent updated'
      );
    }
  }

  /**
   * 移除智能体
   */
  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    
    logger.debug(
      { module: 'acp-server', action: 'remove-agent', agentId },
      'Agent removed'
    );
  }

  /**
   * 获取 Hono 应用实例
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * 获取所有智能体
   */
  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取智能体
   */
  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }
}

/**
 * 创建 ACP 服务器实例
 */
export function createACPServer(): ACPServer {
  return new ACPServer();
}