/**
 * 技能管理器实现
 *
 * @module skillManager
 * @description 实现技能的生命周期管理，包括创建、更新、删除、搜索等操作
 */

import { ISkillManager, Skill, SkillVersion, SkillType, SkillStatus } from './types.js';
import logger from '../memory/active/logger.js';

/**
 * 技能管理器实现
 */
export class SkillManager implements ISkillManager {
  private skills: Map<string, Skill> = new Map();
  private skillVersions: Map<string, SkillVersion[]> = new Map();
  private nextSkillId = 1;
  private nextVersionId = 1;

  /**
   * 创建技能
   */
  async createSkill(
    skill: Omit<Skill, 'id' | 'createdAt' | 'updatedAt' | 'performance'>
  ): Promise<Skill> {
    const id = `skill_${this.nextSkillId++}`;
    const now = Date.now();
    
    const newSkill: Skill = {
      ...skill,
      id,
      createdAt: now,
      updatedAt: now,
      performance: {
        successRate: 0,
        averageExecutionTime: 0,
        totalExecutions: 0,
        lastExecution: 0,
      },
    };

    this.skills.set(id, newSkill);
    this.skillVersions.set(id, []);

    logger.info(
      { module: 'openspace', action: 'create-skill', skillId: id, skillName: skill.name },
      'Skill created successfully'
    );

    return newSkill;
  }

  /**
   * 获取技能
   */
  async getSkill(id: string): Promise<Skill | null> {
    const skill = this.skills.get(id);
    if (!skill) {
      logger.debug(
        { module: 'openspace', action: 'get-skill', skillId: id },
        'Skill not found'
      );
      return null;
    }
    return skill;
  }

  /**
   * 更新技能
   */
  async updateSkill(id: string, updates: Partial<Skill>): Promise<Skill> {
    const skill = this.skills.get(id);
    if (!skill) {
      throw new Error(`Skill with id ${id} not found`);
    }

    const updatedSkill: Skill = {
      ...skill,
      ...updates,
      updatedAt: Date.now(),
    };

    this.skills.set(id, updatedSkill);

    logger.info(
      { module: 'openspace', action: 'update-skill', skillId: id },
      'Skill updated successfully'
    );

    return updatedSkill;
  }

  /**
   * 删除技能
   */
  async deleteSkill(id: string): Promise<boolean> {
    const result = this.skills.delete(id);
    if (result) {
      this.skillVersions.delete(id);
      logger.info(
        { module: 'openspace', action: 'delete-skill', skillId: id },
        'Skill deleted successfully'
      );
    }
    return result;
  }

  /**
   * 列出技能
   */
  async listSkills(filters?: {
    type?: SkillType;
    status?: SkillStatus;
    tags?: string[];
  }): Promise<Skill[]> {
    let skills = Array.from(this.skills.values());

    if (filters) {
      if (filters.type) {
        skills = skills.filter(skill => skill.type === filters.type);
      }
      if (filters.status) {
        skills = skills.filter(skill => skill.status === filters.status);
      }
      if (filters.tags && filters.tags.length > 0) {
        skills = skills.filter(skill => 
          filters.tags!.some(tag => skill.tags.includes(tag))
        );
      }
    }

    return skills;
  }

  /**
   * 搜索技能
   */
  async searchSkills(query: string, limit: number = 10): Promise<Skill[]> {
    const lowerQuery = query.toLowerCase();
    const skills = Array.from(this.skills.values())
      .filter(skill => 
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
      )
      .slice(0, limit);

    return skills;
  }

  /**
   * 获取技能版本
   */
  async getSkillVersions(skillId: string): Promise<SkillVersion[]> {
    const versions = this.skillVersions.get(skillId) || [];
    return versions;
  }

  /**
   * 回滚技能版本
   */
  async rollbackSkillVersion(skillId: string, version: string): Promise<Skill> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill with id ${skillId} not found`);
    }

    const versions = this.skillVersions.get(skillId) || [];
    const targetVersion = versions.find(v => v.version === version);
    if (!targetVersion) {
      throw new Error(`Version ${version} not found for skill ${skillId}`);
    }

    const updatedSkill: Skill = {
      ...skill,
      implementation: targetVersion.implementation,
      version: targetVersion.version,
      updatedAt: Date.now(),
    };

    this.skills.set(skillId, updatedSkill);

    logger.info(
      { module: 'openspace', action: 'rollback-skill-version', skillId, version },
      'Skill version rolled back successfully'
    );

    return updatedSkill;
  }

  /**
   * 保存技能版本
   */
  async saveSkillVersion(skillId: string, implementation: string, reason: string, author?: string): Promise<SkillVersion> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill with id ${skillId} not found`);
    }

    const versionParts = skill.version.split('.').map(Number);
    versionParts[2] = (versionParts[2] || 0) + 1;
    const newVersion = versionParts.join('.');

    const version: SkillVersion = {
      id: `version_${this.nextVersionId++}`,
      skillId,
      version: newVersion,
      implementation,
      createdAt: Date.now(),
      author,
      reason,
    };

    const versions = this.skillVersions.get(skillId) || [];
    versions.push(version);
    this.skillVersions.set(skillId, versions);

    // 更新技能版本
    await this.updateSkill(skillId, { version: newVersion, implementation });

    logger.info(
      { module: 'openspace', action: 'save-skill-version', skillId, version: newVersion },
      'Skill version saved successfully'
    );

    return version;
  }

  /**
   * 更新技能性能指标
   */
  async updateSkillPerformance(skillId: string, success: boolean, executionTime: number, tokenUsage?: number): Promise<void> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return;
    }

    const performance = skill.performance;
    const totalExecutions = performance.totalExecutions + 1;
    const successRate = (performance.successRate * performance.totalExecutions + (success ? 1 : 0)) / totalExecutions;
    const averageExecutionTime = (performance.averageExecutionTime * performance.totalExecutions + executionTime) / totalExecutions;

    await this.updateSkill(skillId, {
      performance: {
        ...performance,
        successRate,
        averageExecutionTime,
        totalExecutions,
        lastExecution: Date.now(),
      },
    });
  }
}