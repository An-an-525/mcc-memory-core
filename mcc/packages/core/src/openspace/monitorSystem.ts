/**
 * 监控系统实现
 *
 * @module monitorSystem
 * @description 实现技能健康状态和性能指标的监控
 */

import { IMonitorSystem, MonitorMetric, HealthCheckResult, SkillStatus } from './types.js';
import { SkillManager } from './skillManager.js';
import logger from '../memory/active/logger.js';

/**
 * 监控系统实现
 */
export class MonitorSystem implements IMonitorSystem {
  private skillManager: SkillManager;
  private metrics: Map<string, MonitorMetric[]> = new Map();
  private healthChecks: Map<string, HealthCheckResult[]> = new Map();

  /**
   * 构造函数
   */
  constructor(skillManager: SkillManager) {
    this.skillManager = skillManager;
  }

  /**
   * 记录执行指标
   */
  async recordMetric(metric: MonitorMetric): Promise<void> {
    const skillMetrics = this.metrics.get(metric.skillId) || [];
    skillMetrics.push(metric);
    
    // 只保留最近 100 个指标
    if (skillMetrics.length > 100) {
      skillMetrics.shift();
    }

    this.metrics.set(metric.skillId, skillMetrics);

    logger.debug(
      { module: 'openspace', action: 'record-metric', skillId: metric.skillId, healthScore: metric.healthScore },
      'Metric recorded'
    );
  }

  /**
   * 检查技能健康状态
   */
  async checkSkillHealth(skillId: string): Promise<HealthCheckResult> {
    const skill = await this.skillManager.getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill with id ${skillId} not found`);
    }

    const metrics = this.metrics.get(skillId) || [];
    const healthScore = this.calculateHealthScore(skill, metrics);
    const issues = this.detectIssues(skill, metrics);

    let status: SkillStatus;
    if (healthScore >= 80) {
      status = SkillStatus.ACTIVE;
    } else if (healthScore >= 40) {
      status = SkillStatus.DEGRADED;
    } else {
      status = SkillStatus.DISABLED;
    }

    const healthCheck: HealthCheckResult = {
      skillId,
      status,
      healthScore,
      issues,
      timestamp: Date.now(),
    };

    const skillHealthChecks = this.healthChecks.get(skillId) || [];
    skillHealthChecks.push(healthCheck);
    
    // 只保留最近 50 个健康检查结果
    if (skillHealthChecks.length > 50) {
      skillHealthChecks.shift();
    }

    this.healthChecks.set(skillId, skillHealthChecks);

    logger.debug(
      { module: 'openspace', action: 'check-skill-health', skillId, healthScore, status },
      'Skill health checked'
    );

    return healthCheck;
  }

  /**
   * 检查所有技能健康状态
   */
  async checkAllSkillsHealth(): Promise<HealthCheckResult[]> {
    const skills = await this.skillManager.listSkills();
    const healthChecks: HealthCheckResult[] = [];

    for (const skill of skills) {
      try {
        const healthCheck = await this.checkSkillHealth(skill.id);
        healthChecks.push(healthCheck);
      } catch (error) {
        logger.error(
          { module: 'openspace', action: 'check-skill-health-error', skillId: skill.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to check skill health'
        );
      }
    }

    return healthChecks;
  }

  /**
   * 获取技能指标历史
   */
  async getSkillMetrics(skillId: string, timeRange?: {
    start: number;
    end: number;
  }): Promise<MonitorMetric[]> {
    const metrics = this.metrics.get(skillId) || [];

    if (timeRange) {
      return metrics.filter(metric => 
        metric.timestamp >= timeRange.start && metric.timestamp <= timeRange.end
      );
    }

    return metrics;
  }

  /**
   * 计算健康分数
   */
  private calculateHealthScore(skill: any, metrics: MonitorMetric[]): number {
    if (metrics.length === 0) {
      return 100; // 新技能默认健康分数
    }

    // 取最近的 10 个指标
    const recentMetrics = metrics.slice(-10);
    
    // 计算平均成功率
    const avgSuccessRate = recentMetrics.reduce((sum, metric) => sum + metric.successRate, 0) / recentMetrics.length;
    
    // 计算平均执行时间（毫秒）
    const avgExecutionTime = recentMetrics.reduce((sum, metric) => sum + metric.averageExecutionTime, 0) / recentMetrics.length;
    
    // 计算平均错误率
    const avgErrorRate = recentMetrics.reduce((sum, metric) => sum + metric.errorRate, 0) / recentMetrics.length;
    
    // 计算平均 token 使用量
    const avgTokenUsage = recentMetrics.reduce((sum, metric) => sum + metric.tokenUsage, 0) / recentMetrics.length;

    // 计算健康分数
    // 成功率权重 40%
    // 执行时间权重 20%
    // 错误率权重 20%
    // token 使用量权重 20%
    let healthScore = 0;

    // 成功率得分（0-40）
    healthScore += avgSuccessRate * 40;

    // 执行时间得分（0-20）
    // 执行时间越短越好，假设 1000ms 为满分，超过 5000ms 为 0
    const executionTimeScore = Math.max(0, 20 - (avgExecutionTime / 5000) * 20);
    healthScore += executionTimeScore;

    // 错误率得分（0-20）
    // 错误率越低越好
    healthScore += (1 - avgErrorRate) * 20;

    // token 使用量得分（0-20）
    // token 使用量越低越好，假设 100 为满分，超过 1000 为 0
    const tokenUsageScore = Math.max(0, 20 - (avgTokenUsage / 1000) * 20);
    healthScore += tokenUsageScore;

    return Math.min(100, Math.max(0, healthScore));
  }

  /**
   * 检测问题
   */
  private detectIssues(skill: any, metrics: MonitorMetric[]): Array<{
    type: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    recommendation: string;
  }> {
    const issues: Array<{
      type: string;
      severity: 'low' | 'medium' | 'high';
      message: string;
      recommendation: string;
    }> = [];

    if (metrics.length === 0) {
      return issues;
    }

    // 取最近的 5 个指标
    const recentMetrics = metrics.slice(-5);
    
    // 计算平均成功率
    const avgSuccessRate = recentMetrics.reduce((sum, metric) => sum + metric.successRate, 0) / recentMetrics.length;
    
    // 计算平均执行时间
    const avgExecutionTime = recentMetrics.reduce((sum, metric) => sum + metric.averageExecutionTime, 0) / recentMetrics.length;
    
    // 计算平均错误率
    const avgErrorRate = recentMetrics.reduce((sum, metric) => sum + metric.errorRate, 0) / recentMetrics.length;
    
    // 计算平均 token 使用量
    const avgTokenUsage = recentMetrics.reduce((sum, metric) => sum + metric.tokenUsage, 0) / recentMetrics.length;

    // 检查成功率
    if (avgSuccessRate < 0.8) {
      issues.push({
        type: 'success-rate',
        severity: avgSuccessRate < 0.5 ? 'high' : 'medium',
        message: `Success rate is low: ${(avgSuccessRate * 100).toFixed(2)}%`,
        recommendation: 'Consider triggering evolution to fix the skill',
      });
    }

    // 检查执行时间
    if (avgExecutionTime > 3000) {
      issues.push({
        type: 'execution-time',
        severity: avgExecutionTime > 5000 ? 'high' : 'medium',
        message: `Execution time is high: ${avgExecutionTime.toFixed(2)}ms`,
        recommendation: 'Optimize the skill implementation to reduce execution time',
      });
    }

    // 检查错误率
    if (avgErrorRate > 0.2) {
      issues.push({
        type: 'error-rate',
        severity: avgErrorRate > 0.5 ? 'high' : 'medium',
        message: `Error rate is high: ${(avgErrorRate * 100).toFixed(2)}%`,
        recommendation: 'Identify and fix the root cause of errors',
      });
    }

    // 检查 token 使用量
    if (avgTokenUsage > 500) {
      issues.push({
        type: 'token-usage',
        severity: avgTokenUsage > 1000 ? 'high' : 'low',
        message: `Token usage is high: ${avgTokenUsage.toFixed(2)}`,
        recommendation: 'Optimize the skill to reduce token usage',
      });
    }

    return issues;
  }

  /**
   * 清理过期数据
   */
  async cleanupData(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<{ metrics: number; healthChecks: number }> {
    const now = Date.now();
    let deletedMetrics = 0;
    let deletedHealthChecks = 0;

    // 清理过期指标
    for (const [skillId, skillMetrics] of this.metrics.entries()) {
      const filteredMetrics = skillMetrics.filter(metric => now - metric.timestamp <= maxAgeMs);
      if (filteredMetrics.length < skillMetrics.length) {
        deletedMetrics += skillMetrics.length - filteredMetrics.length;
        this.metrics.set(skillId, filteredMetrics);
      }
    }

    // 清理过期健康检查
    for (const [skillId, skillHealthChecks] of this.healthChecks.entries()) {
      const filteredHealthChecks = skillHealthChecks.filter(check => now - check.timestamp <= maxAgeMs);
      if (filteredHealthChecks.length < skillHealthChecks.length) {
        deletedHealthChecks += skillHealthChecks.length - filteredHealthChecks.length;
        this.healthChecks.set(skillId, filteredHealthChecks);
      }
    }

    if (deletedMetrics > 0 || deletedHealthChecks > 0) {
      logger.info(
        { module: 'openspace', action: 'cleanup-data', deletedMetrics, deletedHealthChecks },
        'Cleaned up expired monitoring data'
      );
    }

    return { metrics: deletedMetrics, healthChecks: deletedHealthChecks };
  }
}