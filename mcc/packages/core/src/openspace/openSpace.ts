/**
 * OpenSpace 主类实现
 *
 * @module openSpace
 * @description 整合所有模块，提供统一的接口，是整个系统的入口点
 */

import { IOpenSpace, OpenSpaceConfig, SkillExecutionResult } from './types.js';
import { SkillManager } from './skillManager.js';
import { SelfEvolutionEngine } from './selfEvolutionEngine.js';
import { ExecutionSystem } from './executionSystem.js';
import { MonitorSystem } from './monitorSystem.js';
import { CloudSkillCommunity } from './cloudSkillCommunity.js';
import logger from '../memory/active/logger.js';

/**
 * OpenSpace 主类实现
 */
export class OpenSpace implements IOpenSpace {
  private skillManager: SkillManager;
  private selfEvolutionEngine: SelfEvolutionEngine;
  private executionSystem: ExecutionSystem;
  private monitorSystem: MonitorSystem;
  private cloudSkillCommunity: CloudSkillCommunity | null = null;
  private config: OpenSpaceConfig;
  private initialized = false;

  /**
   * 构造函数
   */
  constructor() {
    this.skillManager = new SkillManager();
    this.selfEvolutionEngine = new SelfEvolutionEngine(this.skillManager);
    this.executionSystem = new ExecutionSystem(this.skillManager);
    this.monitorSystem = new MonitorSystem(this.skillManager);
  }

  /**
   * 初始化
   */
  async initialize(config: OpenSpaceConfig): Promise<void> {
    if (this.initialized) {
      throw new Error('OpenSpace is already initialized');
    }

    this.config = config;

    // 初始化云端技能社区
    if (config.cloudCommunity?.enabled) {
      this.cloudSkillCommunity = new CloudSkillCommunity(
        this.skillManager,
        config.cloudCommunity.apiUrl,
        config.cloudCommunity.apiKey,
        config.cloudCommunity.syncInterval || 3600000
      );

      // 启动自动同步
      this.cloudSkillCommunity.startAutoSync();
    }

    this.initialized = true;

    logger.info(
      { module: 'openspace', action: 'initialize', config: JSON.stringify(config) },
      'OpenSpace initialized successfully'
    );
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    if (!this.initialized) {
      throw new Error('OpenSpace is not initialized');
    }

    // 停止云端技能社区的自动同步
    if (this.cloudSkillCommunity) {
      this.cloudSkillCommunity.destroy();
    }

    this.initialized = false;

    logger.info(
      { module: 'openspace', action: 'destroy' },
      'OpenSpace destroyed successfully'
    );
  }

  /**
   * 技能管理器
   */
  getSkillManager(): SkillManager {
    this.ensureInitialized();
    return this.skillManager;
  }

  /**
   * 自进化引擎
   */
  getSelfEvolutionEngine(): SelfEvolutionEngine {
    this.ensureInitialized();
    return this.selfEvolutionEngine;
  }

  /**
   * 执行系统
   */
  getExecutionSystem(): ExecutionSystem {
    this.ensureInitialized();
    return this.executionSystem;
  }

  /**
   * 监控系统
   */
  getMonitorSystem(): MonitorSystem {
    this.ensureInitialized();
    return this.monitorSystem;
  }

  /**
   * 云端技能社区
   */
  getCloudSkillCommunity(): CloudSkillCommunity | null {
    this.ensureInitialized();
    return this.cloudSkillCommunity;
  }

  /**
   * 执行任务
   */
  async executeTask(input: any, options?: {
    expectedOutput?: any;
    availableTools?: string[];
    budget?: {
      maxTokens: number;
      maxTime: number;
    };
  }): Promise<SkillExecutionResult> {
    this.ensureInitialized();

    const context = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      input,
      expectedOutput: options?.expectedOutput,
      availableTools: options?.availableTools || [],
      budget: options?.budget || {
        maxTokens: 1000,
        maxTime: 60000,
      },
      metadata: {},
    };

    logger.info(
      { module: 'openspace', action: 'execute-task', taskId: context.taskId },
      'Executing task'
    );

    const result = await this.executionSystem.executeTask(context);

    // 记录执行指标
    await this.monitorSystem.recordMetric({
      skillId: 'system',
      timestamp: Date.now(),
      successRate: result.success ? 1 : 0,
      averageExecutionTime: result.executionTime,
      errorRate: result.success ? 0 : 1,
      tokenUsage: result.tokenUsage || 0,
      healthScore: result.success ? 100 : 0,
    });

    logger.info(
      { module: 'openspace', action: 'execute-task-result', taskId: context.taskId, success: result.success },
      'Task execution completed'
    );

    return result;
  }

  /**
   * 获取健康状态
   */
  async getHealthStatus(): Promise<{
    overall: 'healthy' | 'degraded' | 'unhealthy';
    components: {
      skillManager: 'healthy' | 'degraded' | 'unhealthy';
      evolutionEngine: 'healthy' | 'degraded' | 'unhealthy';
      executionSystem: 'healthy' | 'degraded' | 'unhealthy';
      monitorSystem: 'healthy' | 'degraded' | 'unhealthy';
      cloudCommunity: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
    };
    skillCount: number;
    activeEvolutionTasks: number;
  }> {
    this.ensureInitialized();

    // 获取技能数量
    const skills = await this.skillManager.listSkills();
    const skillCount = skills.length;

    // 获取活跃的进化任务
    const evolutionTasks = await this.selfEvolutionEngine.listEvolutionTasks({ status: 'in_progress' });
    const activeEvolutionTasks = evolutionTasks.length;

    // 检查所有技能的健康状态
    const healthChecks = await this.monitorSystem.checkAllSkillsHealth();
    const unhealthySkills = healthChecks.filter(check => check.status === 'disabled').length;
    const degradedSkills = healthChecks.filter(check => check.status === 'degraded').length;

    // 计算整体健康状态
    let overall: 'healthy' | 'degraded' | 'unhealthy';
    if (unhealthySkills > 0) {
      overall = 'unhealthy';
    } else if (degradedSkills > 0) {
      overall = 'degraded';
    } else {
      overall = 'healthy';
    }

    // 组件健康状态
    const components = {
      skillManager: 'healthy',
      evolutionEngine: 'healthy',
      executionSystem: 'healthy',
      monitorSystem: 'healthy',
      cloudCommunity: this.cloudSkillCommunity ? 'healthy' : 'disabled',
    };

    logger.debug(
      { module: 'openspace', action: 'get-health-status', overall, skillCount, activeEvolutionTasks },
      'Health status retrieved'
    );

    return {
      overall,
      components,
      skillCount,
      activeEvolutionTasks,
    };
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('OpenSpace is not initialized');
    }
  }

  /**
   * 清理过期数据
   */
  async cleanup(): Promise<{
    evolutionTasks: number;
    executionRecords: number;
    metrics: number;
    healthChecks: number;
  }> {
    this.ensureInitialized();

    const evolutionTasks = await this.selfEvolutionEngine.cleanupTasks();
    const executionRecords = await this.executionSystem.cleanupRecords();
    const { metrics, healthChecks } = await this.monitorSystem.cleanupData();

    logger.info(
      { module: 'openspace', action: 'cleanup', evolutionTasks, executionRecords, metrics, healthChecks },
      'Cleanup completed'
    );

    return {
      evolutionTasks,
      executionRecords,
      metrics,
      healthChecks,
    };
  }
}

/**
 * 创建 OpenSpace 实例
 */
export function createOpenSpace(): OpenSpace {
  return new OpenSpace();
}