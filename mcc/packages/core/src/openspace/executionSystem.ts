/**
 * 执行系统实现
 *
 * @module executionSystem
 * @description 实现任务和技能的执行，包括两阶段执行策略
 */

import { IExecutionSystem, ExecutionContext, ExecutionPhase, ExecutionRecord, SkillExecutionResult } from './types.js';
import { SkillManager } from './skillManager.js';
import logger from '../memory/active/logger.js';

/**
 * 执行系统实现
 */
export class ExecutionSystem implements IExecutionSystem {
  private skillManager: SkillManager;
  private executionRecords: Map<string, ExecutionRecord> = new Map();
  private nextRecordId = 1;

  /**
   * 构造函数
   */
  constructor(skillManager: SkillManager) {
    this.skillManager = skillManager;
  }

  /**
   * 执行任务
   */
  async executeTask(context: ExecutionContext): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    let tokenUsage = 0;
    const steps: Array<{
      action: string;
      result: string;
      timestamp: number;
    }> = [];

    try {
      // Phase 1: 用匹配到的技能指导执行
      const phase1Result = await this.executePhase1(context);
      steps.push(...phase1Result.steps);
      tokenUsage += phase1Result.tokenUsage || 0;

      if (phase1Result.success) {
        // 记录执行
        await this.recordExecution({
          taskId: context.taskId,
          phase: ExecutionPhase.PHASE_1,
          input: context.input,
          output: phase1Result.output,
          success: true,
          startTime,
          endTime: Date.now(),
          tokenUsage,
          steps: phase1Result.steps.map(step => ({
            action: step.action,
            tool: 'skill',
            input: context.input,
            output: step.result,
            timestamp: step.timestamp,
          })),
        });

        return {
          success: true,
          output: phase1Result.output,
          executionTime: Date.now() - startTime,
          tokenUsage,
          steps,
        };
      } else {
        // Phase 2: 失败后以完整预算纯工具重新执行
        const phase2Result = await this.executePhase2(context);
        steps.push(...phase2Result.steps);
        tokenUsage += phase2Result.tokenUsage || 0;

        // 记录执行
        await this.recordExecution({
          taskId: context.taskId,
          phase: ExecutionPhase.PHASE_2,
          input: context.input,
          output: phase2Result.output,
          success: phase2Result.success,
          error: phase2Result.error,
          startTime,
          endTime: Date.now(),
          tokenUsage,
          steps: phase2Result.steps.map(step => ({
            action: step.action,
            tool: 'tool',
            input: context.input,
            output: step.result,
            timestamp: step.timestamp,
          })),
        });

        return {
          success: phase2Result.success,
          output: phase2Result.output,
          error: phase2Result.error,
          executionTime: Date.now() - startTime,
          tokenUsage,
          steps,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 记录执行
      await this.recordExecution({
        taskId: context.taskId,
        phase: ExecutionPhase.PHASE_1,
        input: context.input,
        output: null,
        success: false,
        error: errorMessage,
        startTime,
        endTime: Date.now(),
        tokenUsage,
        steps: [{
          action: 'error',
          tool: 'system',
          input: context.input,
          output: errorMessage,
          timestamp: Date.now(),
        }],
      });

      return {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
        tokenUsage,
        steps: [{
          action: 'error',
          result: errorMessage,
          timestamp: Date.now(),
        }],
      };
    }
  }

  /**
   * 执行技能
   */
  async executeSkill(
    skillId: string,
    input: any,
    context: ExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const steps: Array<{
      action: string;
      result: string;
      timestamp: number;
    }> = [];

    try {
      const skill = await this.skillManager.getSkill(skillId);
      if (!skill) {
        throw new Error(`Skill with id ${skillId} not found`);
      }

      // 模拟技能执行
      // 实际实现中，这里应该执行技能的实现代码
      steps.push({
        action: 'execute-skill',
        result: `Executing skill ${skill.name}`,
        timestamp: Date.now(),
      });

      // 模拟执行结果
      const output = `Result from skill ${skill.name}: ${JSON.stringify(input)}`;

      steps.push({
        action: 'skill-result',
        result: output,
        timestamp: Date.now(),
      });

      // 更新技能性能指标
      await this.skillManager.updateSkillPerformance(
        skillId,
        true,
        Date.now() - startTime,
        100 // 模拟 token 使用量
      );

      return {
        success: true,
        output,
        executionTime: Date.now() - startTime,
        tokenUsage: 100,
        steps,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 更新技能性能指标
      await this.skillManager.updateSkillPerformance(
        skillId,
        false,
        Date.now() - startTime,
        50 // 模拟 token 使用量
      );

      return {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
        tokenUsage: 50,
        steps: [{
          action: 'error',
          result: errorMessage,
          timestamp: Date.now(),
        }],
      };
    }
  }

  /**
   * 获取执行记录
   */
  async getExecutionRecord(id: string): Promise<ExecutionRecord | null> {
    return this.executionRecords.get(id) || null;
  }

  /**
   * 列出执行记录
   */
  async listExecutionRecords(filters?: {
    taskId?: string;
    skillId?: string;
    success?: boolean;
  }): Promise<ExecutionRecord[]> {
    let records = Array.from(this.executionRecords.values());

    if (filters) {
      if (filters.taskId) {
        records = records.filter(record => record.taskId === filters.taskId);
      }
      if (filters.skillId) {
        records = records.filter(record => record.skillId === filters.skillId);
      }
      if (filters.success !== undefined) {
        records = records.filter(record => record.success === filters.success);
      }
    }

    return records;
  }

  /**
   * 执行第一阶段
   */
  private async executePhase1(context: ExecutionContext): Promise<SkillExecutionResult> {
    logger.debug(
      { module: 'openspace', action: 'execute-phase1', taskId: context.taskId },
      'Executing Phase 1'
    );

    // 这里实现第一阶段执行逻辑
    // 例如：根据输入匹配合适的技能，然后执行
    const steps: Array<{
      action: string;
      result: string;
      timestamp: number;
    }> = [];

    steps.push({
      action: 'phase1-start',
      result: 'Starting Phase 1 execution',
      timestamp: Date.now(),
    });

    // 模拟技能匹配和执行
    // 实际实现中，这里应该根据输入匹配合适的技能，然后执行
    steps.push({
      action: 'skill-matching',
      result: 'Matching skills for input',
      timestamp: Date.now(),
    });

    steps.push({
      action: 'skill-execution',
      result: 'Executing matched skill',
      timestamp: Date.now(),
    });

    // 模拟成功结果
    return {
      success: true,
      output: `Phase 1 result for task ${context.taskId}`,
      executionTime: 100,
      tokenUsage: 200,
      steps,
    };
  }

  /**
   * 执行第二阶段
   */
  private async executePhase2(context: ExecutionContext): Promise<SkillExecutionResult> {
    logger.debug(
      { module: 'openspace', action: 'execute-phase2', taskId: context.taskId },
      'Executing Phase 2'
    );

    // 这里实现第二阶段执行逻辑
    // 例如：使用纯工具重新执行任务
    const steps: Array<{
      action: string;
      result: string;
      timestamp: number;
    }> = [];

    steps.push({
      action: 'phase2-start',
      result: 'Starting Phase 2 execution',
      timestamp: Date.now(),
    });

    // 模拟工具执行
    // 实际实现中，这里应该使用纯工具重新执行任务
    steps.push({
      action: 'tool-execution',
      result: 'Executing with pure tools',
      timestamp: Date.now(),
    });

    // 模拟成功结果
    return {
      success: true,
      output: `Phase 2 result for task ${context.taskId}`,
      executionTime: 200,
      tokenUsage: 400,
      steps,
    };
  }

  /**
   * 记录执行
   */
  private async recordExecution(record: Omit<ExecutionRecord, 'id'>): Promise<ExecutionRecord> {
    const id = `execution_${this.nextRecordId++}`;
    const newRecord: ExecutionRecord = {
      ...record,
      id,
    };

    this.executionRecords.set(id, newRecord);

    logger.debug(
      { module: 'openspace', action: 'record-execution', recordId: id, taskId: record.taskId },
      'Execution recorded'
    );

    return newRecord;
  }

  /**
   * 清理过期记录
   */
  async cleanupRecords(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    for (const [recordId, record] of this.executionRecords.entries()) {
      if (now - record.startTime > maxAgeMs) {
        this.executionRecords.delete(recordId);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.info(
        { module: 'openspace', action: 'cleanup-records', deletedCount },
        'Cleaned up expired execution records'
      );
    }

    return deletedCount;
  }
}