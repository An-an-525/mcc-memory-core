/**
 * ImportanceEvaluator - 重要性评估引擎
 *
 * 实现功能:
 * - Task 1A.1.4.4: 四因素加权重要性评估（来源类型 + 内容长度 + Agent 标记 + 交互深度）
 * - 可配置的权重和阈值
 * - 关键词检测机制
 *
 * @module importanceEvaluator
 */

// ============================================================
// 类型定义
// ============================================================

/**
 * 来源类型枚举
 *
 * 定义数据来源的分类，用于重要性评估的来源类型因素。
 */
export enum SourceType {
  /** 用户手动输入 (权重: 0.8) */
  USER_MANUAL = 'user_manual',
  /** Agent 输出 (权重: 0.6) */
  AGENT_OUTPUT = 'agent_output',
  /** 系统日志 (权重: 0.2) */
  SYSTEM_LOG = 'system_log',
  /** LLM 推理中间结果 (权重: 0.5) */
  LLM_INFERENCE = 'llm_inference',
}

/** 默认来源类型权重映射 */
const DEFAULT_SOURCE_TYPE_WEIGHTS: Record<SourceType, number> = {
  [SourceType.USER_MANUAL]: 0.8,
  [SourceType.AGENT_OUTPUT]: 0.6,
  [SourceType.SYSTEM_LOG]: 0.2,
  [SourceType.LLM_INFERENCE]: 0.5,
};

/**
 * 重要性等级枚举
 *
 * 基于评分阈值划分三个等级：
 * - HIGH: > 0.5 (高重要性)
 * - MEDIUM: 0.3 - 0.5 (中等重要性)
 * - LOW: < 0.3 (低重要性)
 */
export enum ImportanceLevel {
  /** 高重要性 (> 0.5) */
  HIGH = 'high',
  /** 中等重要性 (0.3 - 0.5) */
  MEDIUM = 'medium',
  /** 低重要性 (< 0.3) */
  LOW = 'low',
}

/**
 * Importance 配置接口
 *
 * 用于自定义评估器的行为参数。
 */
export interface ImportanceConfig {
  /** 各因素的权重配置（总和应为 1.0） */
  weights?: {
    /** 来源类型权重，默认 0.4 */
    sourceType?: number;
    /** 内容长度权重，默认 0.2 */
    contentLength?: number;
    /** Agent 标记权重，默认 0.2 */
    agentMarker?: number;
    /** 交互深度权重，默认 0.2 */
    interactionDepth?: number;
  };
  /** 等级划分阈值 */
  thresholds?: {
    /** HIGH 等级最低分，默认 0.5 */
    high?: number;
    /** LOW 等级最高分，默认 0.3 */
    low?: number;
  };
  /** Agent 标记关键词列表（默认: important, critical, error, warning, fix, bug） */
  keywords?: string[];
  /** 内容长度归一化基准值（字符数），默认 500 */
  contentLengthNorm?: number;
}

/**
 * 重要性评估结果
 *
 * 包含总分、等级和各因素的详细分解。
 */
export interface ImportanceResult {
  /** 加权总分 (0-1) */
  score: number;
  /** 重要性等级 */
  level: ImportanceLevel;
  /** 各因素得分分解 */
  breakdown: {
    /** 来源类型得分 (0-1) */
    sourceType: number;
    /** 内容长度得分 (0-1) */
    contentLength: number;
    /** Agent 标记得分 (0-1 或 0/1) */
    agentMarker: number;
    /** 交互深度得分 (0-1) */
    interactionDepth: number;
  };
}

/**
 * 评估上下文
 *
 * 提供额外的上下文信息用于更准确的重要性评估。
 */
export interface EvaluationContext {
  /** 来源类型，默认 USER_MANUAL */
  sourceType?: SourceType;
  /** 是否是多轮对话的后续轮次 */
  isFollowUp?: boolean;
  /** 自定义关键词列表（覆盖全局配置） */
  customKeywords?: string[];
}

/**
 * IImportanceEvaluator 接口
 *
 * 重要性评估器的公共 API。
 */
export interface IImportanceEvaluator {
  /**
   * 评估内容的重要性
   *
   * @param value - 要评估的内容字符串
   * @param context - 可选的评估上下文
   * @returns 重要性评估结果
   */
  evaluate(value: string, context?: EvaluationContext): ImportanceResult;

  /**
   * 更新配置
   *
   * @param config - 部分配置更新
   */
  updateConfig(config: Partial<ImportanceConfig>): void;

  /**
   * 获取当前配置
   *
   * @returns 当前完整配置
   */
  getConfig(): ImportanceConfig;
}

// ============================================================
// 默认常量
// ============================================================

/** 默认 Agent 标记关键词列表 */
const DEFAULT_KEYWORDS = [
  'important',
  'critical',
  'error',
  'warning',
  'fix',
  'bug',
] as const;

/** 默认高阈值 */
const DEFAULT_HIGH_THRESHOLD = 0.5;

/** 默认低阈值 */
const DEFAULT_LOW_THRESHOLD = 0.3;

/** 默认内容长度归一化基准 */
const DEFAULT_CONTENT_LENGTH_NORM = 500;

/** 默认权重配置 */
const DEFAULT_WEIGHTS = {
  sourceType: 0.4,
  contentLength: 0.2,
  agentMarker: 0.2,
  interactionDepth: 0.2,
} as const;

/** 关键词扫描的最大字符数（性能优化） */
const KEYWORD_SCAN_MAX_CHARS = 200;

// ============================================================
// ImportanceEvaluator 实现
// ============================================================

/**
 * 重要性评估器
 *
 * 使用四因素加权模型评估内存条目的重要性：
 *
 * | 因素         | 权重  | 评分逻辑                          | 分值范围 |
 * |--------------|-------|-----------------------------------|----------|
 * | 来源类型     | 40%   | source_type 映射                  | 0-1      |
 * | 内容长度     | 20%   | min(content_len/500, 1.0) 归一化   | 0-1      |
 * | Agent 标记   | 20%   | 含关键字=1.0, 否则=0.0            | 0/1      |
 * | 交互深度     | 20%   | 多轮对话后续轮次+0.2              | 0-1      |
 *
 * @implements IImportanceEvaluator
 *
 * @example
 * ```typescript
 * const evaluator = new ImportanceEvaluator();
 *
 * // 评估用户输入
 * const result = evaluator.evaluate('This is an important fix for the bug', {
 *   sourceType: SourceType.USER_MANUAL,
 * });
 * console.log(result.score);    // => 0.72 (示例值)
 * console.log(result.level);   // => 'high'
 * console.log(result.breakdown);
 * // => { sourceType: 0.8, contentLength: 0.09, agentMarker: 1.0, interactionDepth: 0.0 }
 * ```
 */
export class ImportanceEvaluator implements IImportanceEvaluator {
  /** 当前配置 */
  private config: ImportanceConfig;

  /** 当前生效的关键词列表 */
  private keywords: readonly string[];

  /**
   * 创建 ImportanceEvaluator 实例
   *
   * @param config - 初始配置（可选）
   */
  constructor(config?: ImportanceConfig) {
    this.config = {
      weights: { ...DEFAULT_WEIGHTS, ...config?.weights },
      thresholds: {
        high: config?.thresholds?.high ?? DEFAULT_HIGH_THRESHOLD,
        low: config?.thresholds?.low ?? DEFAULT_LOW_THRESHOLD,
      },
      keywords: config?.keywords ?? [...DEFAULT_KEYWORDS],
      contentLengthNorm: config?.contentLengthNorm ?? DEFAULT_CONTENT_LENGTH_NORM,
    };

    // 初始化关键词列表（冻结以防止外部修改）
    this.keywords = Object.freeze([...(this.config.keywords ?? DEFAULT_KEYWORDS)]);
  }

  /**
   * 评估内容的重要性
   *
   * 计算流程:
   * 1. 计算来源类型得分 (sourceType score)
   * 2. 计算内容长度得分 (content length score)
   * 3. 检测 Agent 标记关键词 (agent marker detection)
   * 4. 计算交互深度得分 (interaction depth score)
   * 5. 加权求和得到最终分数
   * 6. 根据阈值确定重要性等级
   *
   * @param value - 要评估的内容字符串
   * @param context - 可选的评估上下文
   * @returns 重要性评估结果（含详细分解）
   *
   * @example
   * ```typescript
   * // 基础用法
   * const result = evaluator.evaluate('Fix critical error in auth module');
   *
   * // 带上下文
   * const result2 = evaluator.evaluate('User feedback about performance', {
   *   sourceType: SourceType.USER_MANUAL,
   *   isFollowUp: true,
   * });
   * ```
   */
  evaluate(value: string, context?: EvaluationContext): ImportanceResult {
    // ---- Step 1: 计算来源类型得分 ----
    const sourceTypeScore = this.evaluateSourceType(context?.sourceType);

    // ---- Step 2: 计算内容长度得分 ----
    const contentLengthScore = this.evaluateContentLength(value);

    // ---- Step 3: 检测 Agent 标记关键词 ----
    const agentMarkerScore = this.detectAgentMarkers(value, context?.customKeywords);

    // ---- Step 4: 计算交互深度得分 ----
    const interactionDepthScore = this.evaluateInteractionDepth(context?.isFollowUp);

    // ---- Step 5: 加权求和 ----
    const weights = this.config.weights ?? DEFAULT_WEIGHTS;
    const weightedScore =
      sourceTypeScore * (weights.sourceType ?? DEFAULT_WEIGHTS.sourceType) +
      contentLengthScore * (weights.contentLength ?? DEFAULT_WEIGHTS.contentLength) +
      agentMarkerScore * (weights.agentMarker ?? DEFAULT_WEIGHTS.agentMarker) +
      interactionDepthScore * (weights.interactionDepth ?? DEFAULT_WEIGHTS.interactionDepth);

    // 四舍五入到 4 位小数（避免浮点精度问题）
    const score = Math.round(weightedScore * 10000) / 10000;

    // ---- Step 6: 确定重要性等级 ----
    const level = this.determineLevel(score);

    return {
      score,
      level,
      breakdown: {
        sourceType: Math.round(sourceTypeScore * 10000) / 10000,
        contentLength: Math.round(contentLengthScore * 10000) / 10000,
        agentMarker: agentMarkerScore,
        interactionDepth: Math.round(interactionDepthScore * 10000) / 10000,
      },
    };
  }

  /**
   * 更新配置
   *
   * 支持部分更新，未提供的字段保持不变。
   * 更新后会重新冻结关键词列表。
   *
   * @param config - 部分配置更新
   *
   * @example
   * ```typescript
   * evaluator.updateConfig({
   *   thresholds: { high: 0.6, low: 0.4 },
   *   keywords: ['urgent', 'priority'],
   * });
   * ```
   */
  updateConfig(config: Partial<ImportanceConfig>): void {
    // 合并权重配置
    if (config.weights) {
      this.config.weights = {
        ...this.config.weights,
        ...config.weights,
      };
    }

    // 合并阈值配置
    if (config.thresholds) {
      this.config.thresholds = {
        ...this.config.thresholds,
        ...config.thresholds,
      };
    }

    // 更新关键词列表
    if (config.keywords !== undefined) {
      this.config.keywords = config.keywords;
      this.keywords = Object.freeze([...config.keywords]);
    }

    // 更新内容长度基准
    if (config.contentLengthNorm !== undefined) {
      this.config.contentLengthNorm = config.contentLengthNorm;
    }
  }

  /**
   * 获取当前配置
   *
   * @returns 当前完整配置的深拷贝
   */
  getConfig(): ImportanceConfig {
    return {
      weights: { ...this.config.weights },
      thresholds: { ...this.config.thresholds },
      keywords: [...this.keywords],
      contentLengthNorm: this.config.contentLengthNorm ?? DEFAULT_CONTENT_LENGTH_NORM,
    };
  }

  // ============================================================
  // 私有方法：各因素评估逻辑
  // ============================================================

  /**
   * 评估来源类型因素
   *
   * 根据 SourceType 映射表返回预定义的得分。
   *
   * @param sourceType - 来源类型（可选，默认 USER_MANUAL）
   * @returns 得分 (0-1)
   * @private
   */
  private evaluateSourceType(sourceType?: SourceType): number {
    const type = sourceType ?? SourceType.USER_MANUAL;
    return DEFAULT_SOURCE_TYPE_WEIGHTS[type] ?? DEFAULT_SOURCE_TYPE_WEIGHTS[SourceType.USER_MANUAL];
  }

  /**
   * 评估内容长度因素
   *
   * 使用 min(len/norm, 1.0) 归一化公式。
   * 较长的内容通常包含更多信息，因此得分更高。
   *
   * @param value - 内容字符串
   * @returns 归一化得分 (0-1)
   * @private
   */
  private evaluateContentLength(value: string): number {
    const norm = this.config.contentLengthNorm ?? DEFAULT_CONTENT_LENGTH_NORM;
    const len = value.length;
    return Math.min(len / norm, 1.0);
  }

  /**
   * 检测 Agent 标记关键词
   *
   * 扫描内容前 N 个字符（默认 200），检测是否包含预定义的关键词。
   * 大小写不敏感。只要匹配到任意一个关键词即返回 1.0。
   *
   * @param value - 内容字符串
   * @param customKeywords - 自定义关键词列表（可选，覆盖全局配置）
   * @returns 1.0 (检测到) 或 0.0 (未检测到)
   * @private
   */
  private detectAgentMarkers(
    value: string,
    customKeywords?: string[],
  ): number {
    // 使用自定义关键词或全局配置
    const keywords = customKeywords ?? this.keywords;

    if (keywords.length === 0) {
      return 0.0;
    }

    // 只扫描前 N 个字符（性能优化）
    const scanText = value.slice(0, KEYWORD_SCAN_MAX_CHARS).toLowerCase();

    // 检查是否包含任意一个关键词
    for (const keyword of keywords) {
      if (scanText.includes(keyword.toLowerCase())) {
        return 1.0;
      }
    }

    return 0.0;
  }

  /**
   * 评估交互深度因素
   *
   * 多轮对话的后续轮次会获得额外加分，
   * 表示该信息是对话延续的重要上下文。
   *
   * 评分规则:
   * - 首轮对话: 0.0
   * - 后续轮次: 0.2 (每轮递增，上限 1.0)
   *
   * @param isFollowUp - 是否是后续轮次
   * @returns 得分 (0-1)
   * @private
   */
  private evaluateInteractionDepth(isFollowUp?: boolean): number {
    if (isFollowUp) {
      return 0.2; // 后续轮次基础加分
    }
    return 0.0; // 首轮对话无加分
  }

  /**
   * 根据分数确定重要性等级
   *
   * 使用配置的阈值进行分级：
   * - score >= high threshold → HIGH
   * - score >= low threshold → MEDIUM
   * - score < low threshold → LOW
   *
   * @param score - 加权总分 (0-1)
   * @returns 重要性等级
   * @private
   */
  private determineLevel(score: number): ImportanceLevel {
    const thresholds = this.config.thresholds ?? {};
    const highThreshold = thresholds.high ?? DEFAULT_HIGH_THRESHOLD;
    const lowThreshold = thresholds.low ?? DEFAULT_LOW_THRESHOLD;

    if (score >= highThreshold) {
      return ImportanceLevel.HIGH;
    } else if (score >= lowThreshold) {
      return ImportanceLevel.MEDIUM;
    } else {
      return ImportanceLevel.LOW;
    }
  }
}

// ============================================================
// 导出
// ============================================================

export default ImportanceEvaluator;
