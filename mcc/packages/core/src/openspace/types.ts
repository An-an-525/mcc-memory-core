/**
 * OpenSpace 自进化引擎类型定义
 *
 * @module types
 * @description 定义 OpenSpace 自进化引擎的核心类型和接口
 */

// ============================================================
// 技能相关类型
// ============================================================

/**
 * 技能状态
 */
export enum SkillStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  DEGRADED = 'degraded',
  PENDING = 'pending',
}

/**
 * 技能类型
 */
export enum SkillType {
  EXECUTOR = 'executor',
  PLANNER = 'planner',
  RESEARCHER = 'researcher',
  SPECIALIST = 'specialist',
  UTILITY = 'utility',
}

/**
 * 技能执行结果
 */
export interface SkillExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  executionTime: number;
  tokenUsage?: number;
  steps: Array<{
    action: string;
    result: string;
    timestamp: number;
  }>;
}

/**
 * 技能定义
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  status: SkillStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
  author?: string;
  tags: string[];
  dependencies: string[];
  implementation: string; // 技能实现代码
  metadata: Record<string, any>;
  performance: {
    successRate: number;
    averageExecutionTime: number;
    totalExecutions: number;
    lastExecution: number;
  };
}

/**
 * 技能版本
 */
export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  implementation: string;
  createdAt: number;
  author?: string;
  reason: string; // 版本变更原因
}

// ============================================================
// 进化相关类型
// ============================================================

/**
 * 进化模式
 */
export enum EvolutionMode {
  FIX = 'fix', // 技能失效时自动修复
  DERIVED = 'derived', // 从已有技能衍生增强版本
  CAPTURED = 'captured', // 从成功执行中提取新技能
}

/**
 * 进化触发器
 */
export enum EvolutionTrigger {
  POST_EXECUTION = 'post_execution', // 任务结束后分析
  TOOL_DEGRADATION = 'tool_degradation', // 工具成功率下降
  METRIC_MONITOR = 'metric_monitor', // 周期性扫描技能健康指标
}

/**
 * 进化任务
 */
export interface EvolutionTask {
  id: string;
  skillId: string;
  mode: EvolutionMode;
  trigger: EvolutionTrigger;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: {
    success: boolean;
    newVersion?: string;
    message?: string;
  };
}

// ============================================================
// 执行相关类型
// ============================================================

/**
 * 执行阶段
 */
export enum ExecutionPhase {
  PHASE_1 = 'phase_1', // 用匹配到的技能指导执行
  PHASE_2 = 'phase_2', // 失败后以完整预算纯工具重新执行
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  taskId: string;
  input: any;
  expectedOutput?: any;
  availableTools: string[];
  budget?: {
    maxTokens: number;
    maxTime: number;
  };
  metadata: Record<string, any>;
}

/**
 * 执行记录
 */
export interface ExecutionRecord {
  id: string;
  taskId: string;
  skillId?: string;
  phase: ExecutionPhase;
  input: any;
  output: any;
  success: boolean;
  error?: string;
  startTime: number;
  endTime: number;
  tokenUsage: number;
  steps: Array<{
    action: string;
    tool: string;
    input: any;
    output: any;
    timestamp: number;
  }>;
}

// ============================================================
// 监控相关类型
// ============================================================

/**
 * 监控指标
 */
export interface MonitorMetric {
  skillId: string;
  timestamp: number;
  successRate: number;
  averageExecutionTime: number;
  errorRate: number;
  tokenUsage: number;
  healthScore: number; // 0-100
}

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  skillId: string;
  status: SkillStatus;
  healthScore: number;
  issues: Array<{
    type: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    recommendation: string;
  }>;
  timestamp: number;
}

// ============================================================
// 配置相关类型
// ============================================================

/**
 * OpenSpace 配置
 */
export interface OpenSpaceConfig {
  /** 技能存储配置 */
  skillStorage?: {
    type: 'sqlite' | 'postgres';
    connection?: any;
    path?: string; // SQLite 路径
  };
  /** 进化配置 */
  evolution?: {
    enabled: boolean;
    maxConcurrentTasks: number;
    triggerThresholds: {
      successRate: number; // 低于此值触发进化
      executionTime: number; // 高于此值触发进化
      errorRate: number; // 高于此值触发进化
    };
  };
  /** 执行配置 */
  execution?: {
    maxRetries: number;
    defaultBudget: {
      maxTokens: number;
      maxTime: number;
    };
  };
  /** 监控配置 */
  monitoring?: {
    enabled: boolean;
    checkInterval: number; // 检查间隔（毫秒）
    healthScoreThreshold: number; // 健康分数阈值
  };
  /** 云端技能社区配置 */
  cloudCommunity?: {
    enabled: boolean;
    apiUrl: string;
    apiKey?: string;
    syncInterval: number; // 同步间隔（毫秒）
  };
}

// ============================================================
// 接口定义
// ============================================================

/**
 * 技能管理器接口
 */
export interface ISkillManager {
  /**
   * 创建技能
   */
  createSkill(skill: Omit<Skill, 'id' | 'createdAt' | 'updatedAt' | 'performance'>): Promise<Skill>;
  
  /**
   * 获取技能
   */
  getSkill(id: string): Promise<Skill | null>;
  
  /**
   * 更新技能
   */
  updateSkill(id: string, updates: Partial<Skill>): Promise<Skill>;
  
  /**
   * 删除技能
   */
  deleteSkill(id: string): Promise<boolean>;
  
  /**
   * 列出技能
   */
  listSkills(filters?: {
    type?: SkillType;
    status?: SkillStatus;
    tags?: string[];
  }): Promise<Skill[]>;
  
  /**
   * 搜索技能
   */
  searchSkills(query: string, limit?: number): Promise<Skill[]>;
  
  /**
   * 获取技能版本
   */
  getSkillVersions(skillId: string): Promise<SkillVersion[]>;
  
  /**
   * 回滚技能版本
   */
  rollbackSkillVersion(skillId: string, version: string): Promise<Skill>;
}

/**
 * 自进化引擎接口
 */
export interface ISelfEvolutionEngine {
  /**
   * 触发进化
   */
  triggerEvolution(
    skillId: string,
    mode: EvolutionMode,
    trigger: EvolutionTrigger,
    context?: any
  ): Promise<EvolutionTask>;
  
  /**
   * 执行进化任务
   */
  executeEvolutionTask(task: EvolutionTask): Promise<EvolutionTask>;
  
  /**
   * 获取进化任务
   */
  getEvolutionTask(id: string): Promise<EvolutionTask | null>;
  
  /**
   * 列出进化任务
   */
  listEvolutionTasks(filters?: {
    skillId?: string;
    status?: EvolutionTask['status'];
  }): Promise<EvolutionTask[]>;
}

/**
 * 执行系统接口
 */
export interface IExecutionSystem {
  /**
   * 执行任务
   */
  executeTask(context: ExecutionContext): Promise<SkillExecutionResult>;
  
  /**
   * 执行技能
   */
  executeSkill(
    skillId: string,
    input: any,
    context: ExecutionContext
  ): Promise<SkillExecutionResult>;
  
  /**
   * 获取执行记录
   */
  getExecutionRecord(id: string): Promise<ExecutionRecord | null>;
  
  /**
   * 列出执行记录
   */
  listExecutionRecords(filters?: {
    taskId?: string;
    skillId?: string;
    success?: boolean;
  }): Promise<ExecutionRecord[]>;
}

/**
 * 监控系统接口
 */
export interface IMonitorSystem {
  /**
   * 记录执行指标
   */
  recordMetric(metric: MonitorMetric): Promise<void>;
  
  /**
   * 检查技能健康状态
   */
  checkSkillHealth(skillId: string): Promise<HealthCheckResult>;
  
  /**
   * 检查所有技能健康状态
   */
  checkAllSkillsHealth(): Promise<HealthCheckResult[]>;
  
  /**
   * 获取技能指标历史
   */
  getSkillMetrics(skillId: string, timeRange?: {
    start: number;
    end: number;
  }): Promise<MonitorMetric[]>;
}

/**
 * 云端技能社区接口
 */
export interface ICloudSkillCommunity {
  /**
   * 同步技能到云端
   */
  syncSkillsToCloud(skillIds?: string[]): Promise<number>;
  
  /**
   * 从云端同步技能
   */
  syncSkillsFromCloud(filters?: {
    type?: SkillType;
    tags?: string[];
  }): Promise<number>;
  
  /**
   * 共享技能
   */
  shareSkill(skillId: string, visibility?: 'public' | 'private' | 'team'): Promise<boolean>;
  
  /**
   * 下载技能
   */
  downloadSkill(skillId: string): Promise<Skill | null>;
  
  /**
   * 搜索云端技能
   */
  searchCloudSkills(query: string, limit?: number): Promise<Skill[]>;
}

/**
 * OpenSpace 主接口
 */
export interface IOpenSpace {
  /**
   * 初始化
   */
  initialize(config: OpenSpaceConfig): Promise<void>;
  
  /**
   * 销毁
   */
  destroy(): Promise<void>;
  
  /**
   * 技能管理器
   */
  getSkillManager(): ISkillManager;
  
  /**
   * 自进化引擎
   */
  getSelfEvolutionEngine(): ISelfEvolutionEngine;
  
  /**
   * 执行系统
   */
  getExecutionSystem(): IExecutionSystem;
  
  /**
   * 监控系统
   */
  getMonitorSystem(): IMonitorSystem;
  
  /**
   * 云端技能社区
   */
  getCloudSkillCommunity(): ICloudSkillCommunity | null;
  
  /**
   * 执行任务
   */
  executeTask(input: any, options?: {
    expectedOutput?: any;
    availableTools?: string[];
    budget?: {
      maxTokens: number;
      maxTime: number;
    };
  }): Promise<SkillExecutionResult>;
  
  /**
   * 获取健康状态
   */
  getHealthStatus(): Promise<{
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
  }>;
}