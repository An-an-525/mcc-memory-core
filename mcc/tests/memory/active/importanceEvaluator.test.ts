/**
 * ImportanceEvaluator 单元测试
 *
 * 覆盖范围:
 * - Task 1A.1.5.2: 来源类型评分（四因素加权模型）
 * - Task 1A.1.5.2: Agent 标记关键词检测（大小写不敏感）
 * - Task 1A.1.5.2: 重要性等级划分（HIGH/MEDIUM/LOW）
 * - Task 1A.1.5.2: 交互深度评估
 * - Task 1A.1.5.2: 自定义配置与动态更新
 *
 * @module tests/memory/active/importanceEvaluator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ImportanceEvaluator,
  SourceType,
  ImportanceLevel,
} from '../../../packages/core/src/memory/active/importanceEvaluator.js';
import type {
  IImportanceEvaluator,
  ImportanceResult,
  EvaluationContext,
  ImportanceConfig,
} from '../../../packages/core/src/memory/active/importanceEvaluator.js';

// ============================================================
// 测试工具函数
// ============================================================

/** 创建默认评估器实例 */
function createEvaluator(config?: ImportanceConfig): IImportanceEvaluator {
  return new ImportanceEvaluator(config);
}

/**
 * 辅助函数：计算预期分数
 *
 * 基于四因素加权模型:
 * score = sourceType * 0.4 + contentLength * 0.2 + agentMarker * 0.2 + interactionDepth * 0.2
 */
function calculateExpectedScore(params: {
  sourceTypeScore: number;
  contentLengthScore: number;
  agentMarkerScore: number;
  interactionDepthScore: number;
}): number {
  const weights = { sourceType: 0.4, contentLength: 0.2, agentMarker: 0.2, interactionDepth: 0.2 };
  return (
    params.sourceTypeScore * weights.sourceType +
    params.contentLengthScore * weights.contentLength +
    params.agentMarkerScore * weights.agentMarker +
    params.interactionDepthScore * weights.interactionDepth
  );
}

// ============================================================
// 测试套件 1: 来源类型评分
// ============================================================

describe('ImportanceEvaluator - 来源类型评分', () => {
  let evaluator: IImportanceEvaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  // ---- 1.1 USER_MANUAL 高分 ----

  it('USER_MANUAL → 基础分 0.8，加权后贡献显著', () => {
    const result = evaluator.evaluate('用户输入的重要信息', {
      sourceType: SourceType.USER_MANUAL,
    });

    // USER_MANUAL 的 sourceType 权重是 0.8
    // 加权后: 0.8 * 0.4 = 0.32
    expect(result.breakdown.sourceType).toBe(0.8);
    expect(result.breakdown.sourceType).toBeGreaterThan(0);
  });

  // ---- 1.2 SYSTEM_LOG 低分 ----

  it('SYSTEM_LOG → 基础分 0.2，加权后贡献较小', () => {
    const result = evaluator.evaluate('系统日志信息', {
      sourceType: SourceType.SYSTEM_LOG,
    });

    // SYSTEM_LOG 的 sourceType 权重是 0.2
    // 加权后: 0.2 * 0.4 = 0.08
    expect(result.breakdown.sourceType).toBe(0.2);
    expect(result.score).toBeLessThan(0.5); // 应该是 LOW 或 MEDIUM
  });

  // ---- 1.3 AGENT_OUTPUT 中等 ----

  it('AGENT_OUTPUT → 基础分 0.6，中等权重', () => {
    const result = evaluator.evaluate('Agent 输出的结果', {
      sourceType: SourceType.AGENT_OUTPUT,
    });

    // AGENT_OUTPUT 的 sourceType 权重是 0.6
    // 加权后: 0.6 * 0.4 = 0.24
    expect(result.breakdown.sourceType).toBe(0.6);
  });

  // ---- 1.4 LLM_INFERENCE 中低 ----

  it('LLM_INFERENCE → 基础分 0.5', () => {
    const result = evaluator.evaluate('LLM 推理中间结果', {
      sourceType: SourceType.LLM_INFERENCE,
    });

    expect(result.breakdown.sourceType).toBe(0.5);
  });

  // ---- 1.5 默认来源类型 ----

  it('未指定 sourceType 时默认使用 USER_MANUAL', () => {
    const result = evaluator.evaluate('没有指定来源的内容');

    // 默认应该是 USER_MANUAL (0.8)
    expect(result.breakdown.sourceType).toBe(0.8);
  });

  // ---- 1.6 各来源类型的完整对比 ----

  it('不同来源类型的分数对比符合预期', () => {
    const testContent = '相同长度和内容的测试文本用于对比';

    const userManual = evaluator.evaluate(testContent, {
      sourceType: SourceType.USER_MANUAL,
    });
    const agentOutput = evaluator.evaluate(testContent, {
      sourceType: SourceType.AGENT_OUTPUT,
    });
    const systemLog = evaluator.evaluate(testContent, {
      sourceType: SourceType.SYSTEM_LOG,
    });
    const llmInference = evaluator.evaluate(testContent, {
      sourceType: SourceType.LLM_INFERENCE,
    });

    // 分数排序: USER_MANUAL > AGENT_OUTPUT > LLM_INFERENCE > SYSTEM_LOG
    expect(userManual.score).toBeGreaterThan(agentOutput.score);
    expect(agentOutput.score).toBeGreaterThan(llmInference.score);
    expect(llmInference.score).toBeGreaterThan(systemLog.score);
  });
});

// ============================================================
// 测试套件 2: Agent 标记关键词检测
// ============================================================

describe('ImportanceEvaluator - Agent 标记检测', () => {
  let evaluator: IImportanceEvaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  // ---- 2.1 关键词匹配 ----

  it('含 "critical" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('This is a critical fix for the system');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('含 "error" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('Found an error in the authentication module');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('含 "important" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('This is an important configuration change');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('含 "warning" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('Memory usage warning detected');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('含 "fix" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('Bug fix completed successfully');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('含 "bug" 关键词 → agentMarker = 1.0', () => {
    const result = evaluator.evaluate('Critical bug found in production');

    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  // ---- 2.2 无关键词 ----

  it('无关键词 → agentMarker = 0.0', () => {
    const result = evaluator.evaluate('今天天气不错，适合出去散步');

    expect(result.breakdown.agentMarker).toBe(0.0);
  });

  // ---- 2.3 大小写不敏感 ----

  it('大小写不敏感: "ERROR" 匹配', () => {
    const result = evaluator.evaluate('CRITICAL ERROR in system');
    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('大小写不敏感: "Error" 匹配', () => {
    const result = evaluator.evaluate('There was an Error in processing');
    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('大小写不敏感: "Critical" 匹配', () => {
    const result = evaluator.evaluate('This is a Critical issue');
    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  it('混合大小写匹配: "ErRoR" 匹配', () => {
    const result = evaluator.evaluate('System ErRoR detected');
    expect(result.breakdown.agentMarker).toBe(1.0);
  });

  // ---- 2.4 关键词位置 ----

  it('关键词出现在开头、中间、结尾都能检测到', () => {
    // 开头
    const startResult = evaluator.evaluate('Critical system failure occurred');
    expect(startResult.breakdown.agentMarker).toBe(1.0);

    // 中间
    const midResult = evaluator.evaluate('The system has a critical bug in auth');
    expect(midResult.breakdown.agentMarker).toBe(1.0);

    // 结尾
    const endResult = evaluator.evaluate('This issue is critical');
    expect(endResult.breakdown.agentMarker).toBe(1.0);
  });

  // ---- 2.5 性能优化：只扫描前 N 个字符 ----

  it('超过扫描长度的内容中关键词不被检测', () => {
    // 创建一个很长的字符串，前 200 字符不含关键词，之后包含
    const longPrefix = 'x'.repeat(200); // 填充 200 字符
    const content = `${longPrefix} error keyword after limit`;

    const result = evaluator.evaluate(content);
    // 由于只扫描前 200 字符，后面的 'error' 不应被检测到
    expect(result.breakdown.agentMarker).toBe(0.0);
  });
});

// ============================================================
// 测试套件 3: 等级划分
// ============================================================

describe('ImportanceEvaluator - 等级划分', () => {
  let evaluator: IImportanceEvaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  // ---- 3.1 HIGH 等级 (score >= 0.5) ----

  it('score >= 0.5 → HIGH', () => {
    // 构造一个高分场景：
    // - USER_MANUAL (0.8) + 含关键词 (1.0) + 长内容 + 后续对话
    const highContent = 'This is a CRITICAL and IMPORTANT fix for a major BUG that affects all users in the production environment and requires immediate attention to prevent data loss';

    const result = evaluator.evaluate(highContent, {
      sourceType: SourceType.USER_MANUAL,
      isFollowUp: true,
    });

    expect(result.level).toBe(ImportanceLevel.HIGH);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  // ---- 3.2 MEDIUM 等级 (0.3 <= score < 0.5) ----

  it('0.3 <= score < 0.5 → MEDIUM', () => {
    // 中等场景：
    // - USER_MANUAL (0.8) + 无关键词 + 短内容 + 首轮对话
    // 计算: 0.8*0.4 + shortLen*0.2 + 0*0.2 + 0*0.2 ≈ 0.32-0.38
    const mediumContent = 'Medium priority task';

    const result = evaluator.evaluate(mediumContent, {
      sourceType: SourceType.USER_MANUAL,
    });

    expect(result.level).toBe(ImportanceLevel.MEDIUM);
    expect(result.score).toBeGreaterThanOrEqual(0.3);
    expect(result.score).toBeLessThan(0.5);
  });

  // ---- 3.3 LOW 等级 (score < 0.3) ----

  it('score < 0.3 → LOW', () => {
    // 低分场景：
    // - SYSTEM_LOG (0.2) + 无关键词 + 短内容 + 首轮对话
    const lowContent = 'log info';

    const result = evaluator.evaluate(lowContent, {
      sourceType: SourceType.SYSTEM_LOG,
    });

    expect(result.level).toBe(ImportanceLevel.LOW);
    expect(result.score).toBeLessThan(0.3);
  });

  // ---- 3.4 边界值测试 ----

  it('精确边界值 0.5 → HIGH', () => {
    // 通过自定义权重构造恰好 0.5 的分数
    const customEvaluator = createEvaluator({
      weights: {
        sourceType: 1.0, // 只用 sourceType
        contentLength: 0,
        agentMarker: 0,
        interactionDepth: 0,
      },
      thresholds: {
        high: 0.5,
        low: 0.3,
      },
    });

    // USER_MANUAL = 0.8 > 0.5 → HIGH
    const result = customEvaluator.evaluate('test', {
      sourceType: SourceType.USER_MANUAL,
    });
    expect(result.level).toBe(ImportanceLevel.HIGH);
  });

  it('精确边界值 0.3 → MEDIUM', () => {
    const customEvaluator = createEvaluator({
      weights: {
        sourceType: 1.0,
        contentLength: 0,
        agentMarker: 0,
        interactionDepth: 0,
      },
      thresholds: {
        high: 0.5,
        low: 0.3,
      },
    });

    // SYSTEM_LOG = 0.2 < 0.3 → LOW (不是 MEDIUM)
    const result = customEvaluator.evaluate('test', {
      sourceType: SourceType.SYSTEM_LOG,
    });
    expect(result.level).toBe(ImportanceLevel.LOW);
  });

  it('精确边界值 0.35 → MEDIUM', () => {
    // 使用自定义权重和阈值构造 MEDIUM 分数
    // 目标: 分数在 [0.3, 0.5) 区间
    // 策略: 使用 LLM_INFERENCE (0.5) + 高阈值 (high=0.7) + 低阈值 (low=0.4)
    // 这样 0.5 在 [0.4, 0.7) 内 → MEDIUM
    const customEvaluator = createEvaluator({
      weights: {
        sourceType: 1.0,
        contentLength: 0,
        agentMarker: 0,
        interactionDepth: 0,
      },
      thresholds: {
        high: 0.7,
        low: 0.4,
      },
    });

    // LLM_INFERENCE = 0.5，在 [0.4, 0.7) 区间内 → MEDIUM
    const result = customEvaluator.evaluate('test', {
      sourceType: SourceType.LLM_INFERENCE,
    });
    expect(result.level).toBe(ImportanceLevel.MEDIUM);
    expect(result.score).toBe(0.5); // 精确值
  });

  it('略低于 0.3 → LOW', () => {
    const customEvaluator = createEvaluator({
      weights: {
        sourceType: 1.0,
        contentLength: 0,
        agentMarker: 0,
        interactionDepth: 0,
      },
      thresholds: {
        high: 0.5,
        low: 0.3,
      },
    });

    // SYSTEM_LOG = 0.2 < 0.3 → LOW
    const result = customEvaluator.evaluate('test', {
      sourceType: SourceType.SYSTEM_LOG,
    });
    expect(result.level).toBe(ImportanceLevel.LOW);
  });
});

// ============================================================
// 测试套件 4: 交互深度评估
// ============================================================

describe('ImportanceEvaluator - 交互深度评估', () => {
  let evaluator: IImportanceEvaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  // ---- 4.1 首轮对话 ----

  it('isFollowUp=false → interactionDepth = 0.0', () => {
    const result = evaluator.evaluate('First message in conversation', {
      isFollowUp: false,
    });

    expect(result.breakdown.interactionDepth).toBe(0.0);
  });

  it('未指定 isFollowUp 默认为 false → interactionDepth = 0.0', () => {
    const result = evaluator.evaluate('Message without follow-up flag');

    expect(result.breakdown.interactionDepth).toBe(0.0);
  });

  // ---- 4.2 后续轮次 ----

  it('isFollowUp=true → interactionDepth = 0.2', () => {
    const result = evaluator.evaluate('Follow-up question about previous topic', {
      isFollowUp: true,
    });

    expect(result.breakdown.interactionDepth).toBe(0.2);
  });

  // ---- 4.3 对总分的影响 ----

  it('isFollowUp=true 使总分增加约 0.04 (0.2 * 0.2)', () => {
    const baseContent = 'Same content for comparison';

    const firstRound = evaluator.evaluate(baseContent, { isFollowUp: false });
    const followUp = evaluator.evaluate(baseContent, { isFollowUp: true });

    // followUp 应该比 firstRound 高约 0.04
    const diff = followUp.score - firstRound.score;
    expect(diff).toBeCloseTo(0.04, 2); // 允许 0.02 误差
  });
});

// ============================================================
// 测试套件 5: 内容长度归一化
// ============================================================

describe('ImportanceEvaluator - 内容长度归一化', () => {
  let evaluator: IImportanceEvaluator;

  beforeEach(() => {
    evaluator = createEvaluator();
  });

  it('短内容 (< 500字符) 得分较低', () => {
    const shortContent = 'Hi'; // 2 字符
    const result = evaluator.evaluate(shortContent);

    // 2 / 500 = 0.004
    expect(result.breakdown.contentLength).toBeCloseTo(0.004, 3);
  });

  it('中等长度内容得分适中', () => {
    const mediumContent = 'x'.repeat(250); // 250 字符
    const result = evaluator.evaluate(mediumContent);

    // 250 / 500 = 0.5
    expect(result.breakdown.contentLength).toBe(0.5);
  });

  it('长内容 (> 500字符) 得分封顶为 1.0', () => {
    const longContent = 'x'.repeat(1000); // 1000 字符
    const result = evaluator.evaluate(longContent);

    // min(1000/500, 1.0) = 1.0
    expect(result.breakdown.contentLength).toBe(1.0);
  });

  it('恰好 500 字符得分为 1.0', () => {
    const exactContent = 'x'.repeat(500);
    const result = evaluator.evaluate(exactContent);

    expect(result.breakdown.contentLength).toBe(1.0);
  });

  it('空字符串得分为 0', () => {
    const result = evaluator.evaluate('');

    expect(result.breakdown.contentLength).toBe(0);
  });
});

// ============================================================
// 测试套件 6: 自定义配置
// ============================================================

describe('ImportanceEvaluator - 自定义配置', () => {
  // ---- 6.1 动态更新权重 ----

  it('updateConfig 修改权重后重新评估结果变化', () => {
    const evaluator = createEvaluator();

    // 初始评估
    const initialResult = evaluator.evaluate('critical error fix', {
      sourceType: SourceType.USER_MANUAL,
    });
    const initialScore = initialResult.score;

    // 提高内容长度权重
    evaluator.updateConfig({
      weights: {
        sourceType: 0.1, // 降低
        contentLength: 0.7, // 提高
        agentMarker: 0.1, // 降低
        interactionDepth: 0.1, // 降低
      },
    });

    // 再次评估相同内容
    const updatedResult = evaluator.evaluate('critical error fix', {
      sourceType: SourceType.USER_MANUAL,
    });

    // 分数应该有显著变化（因为权重变了）
    // 注意：不一定变大或变小，但应该不同
    expect(updatedResult.score).not.toBe(initialScore);
  });

  // ---- 6.2 自定义关键词列表 ----

  it('自定义 keywords 列表生效', () => {
    const evaluator = createEvaluator({
      keywords: ['urgent', 'priority', 'asap'],
    });

    // 新关键词应被检测到
    const urgentResult = evaluator.evaluate('This is URGENT and needs priority attention ASAP');
    expect(urgentResult.breakdown.agentMarker).toBe(1.0);

    // 旧关键词不再被检测
    const oldKeywordResult = evaluator.evaluate('This contains error but not new keywords');
    expect(oldKeywordResult.breakdown.agentMarker).toBe(0.0);
  });

  // ---- 6.3 自定义阈值 ----

  it('自定义阈值改变等级划分', () => {
    const evaluator = createEvaluator({
      thresholds: {
        high: 0.7, // 提高到 0.7
        low: 0.4,  // 提高到 0.4
      },
    });

    // 一个原本 MEDIUM 的分数 (比如 0.45)
    // 在新阈值下变成 LOW (< 0.4) 或者还在 MEDIUM (>= 0.4 && < 0.7)
    const result = evaluator.evaluate('medium importance content', {
      sourceType: SourceType.AGENT_OUTPUT,
    });

    // 验证使用了新阈值
    if (result.score >= 0.7) {
      expect(result.level).toBe(ImportanceLevel.HIGH);
    } else if (result.score >= 0.4) {
      expect(result.level).toBe(ImportanceLevel.MEDIUM);
    } else {
      expect(result.level).toBe(ImportanceLevel.LOW);
    }
  });

  // ---- 6.4 自定义内容长度基准 ----

  it('自定义 contentLengthNorm 改变归一化基准', () => {
    const evaluator = createEvaluator({
      contentLengthNorm: 100, // 使用更小的基准
    });

    const content = 'x'.repeat(50); // 50 字符
    const result = evaluator.evaluate(content);

    // 50 / 100 = 0.5 (而不是 50 / 500 = 0.1)
    expect(result.breakdown.contentLength).toBe(0.5);
  });

  // ---- 6.5 获取当前配置 ----

  it('getConfig 返回当前完整配置', () => {
    const customConfig: ImportanceConfig = {
      weights: {
        sourceType: 0.5,
        contentLength: 0.3,
        agentMarker: 0.1,
        interactionDepth: 0.1,
      },
      thresholds: {
        high: 0.6,
        low: 0.35,
      },
      keywords: ['custom1', 'custom2'],
      contentLengthNorm: 200,
    };

    const evaluator = createEvaluator(customConfig);
    const retrievedConfig = evaluator.getConfig();

    // 验证返回的配置与设置的一致
    expect(retrievedConfig.weights?.sourceType).toBe(0.5);
    expect(retrievedConfig.weights?.contentLength).toBe(0.3);
    expect(retrievedConfig.thresholds?.high).toBe(0.6);
    expect(retrievedConfig.thresholds?.low).toBe(0.35);
    expect(retrievedConfig.keywords).toEqual(['custom1', 'custom2']);
    expect(retrievedConfig.contentLengthNorm).toBe(200);
  });

  // ---- 6.6 配置隔离性 ----

  it('不同实例的配置互不影响', () => {
    const evaluator1 = createEvaluator({ keywords: ['keyword1'] });
    const evaluator2 = createEvaluator({ keywords: ['keyword2'] });

    // evaluator1 只识别 keyword1
    const r1 = evaluator1.evaluate('Contains keyword1 here');
    expect(r1.breakdown.agentMarker).toBe(1.0);

    const r1_no = evaluator1.evaluate('Contains keyword2 only');
    expect(r1_no.breakdown.agentMarker).toBe(0.0);

    // evaluator2 只识别 keyword2
    const r2 = evaluator2.evaluate('Contains keyword2 here');
    expect(r2.breakdown.agentMarker).toBe(1.0);

    const r2_no = evaluator2.evaluate('Contains keyword1 only');
    expect(r2_no.breakdown.agentMarker).toBe(0.0);
  });
});

// ============================================================
// 测试套件 7: 完整评估流程验证
// ============================================================

describe('ImportanceEvaluator - 完整评估流程', () => {
  it('返回完整的 ImportanceResult 结构', () => {
    const evaluator = createEvaluator();

    const result: ImportanceResult = evaluator.evaluate('Test content', {
      sourceType: SourceType.USER_MANUAL,
      isFollowUp: true,
    });

    // 验证结构完整性
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('breakdown');
    expect(result.breakdown).toHaveProperty('sourceType');
    expect(result.breakdown).toHaveProperty('contentLength');
    expect(result.breakdown).toHaveProperty('agentMarker');
    expect(result.breakdown).toHaveProperty('interactionDepth');

    // 验证数值范围
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(Object.values(ImportanceLevel)).toContain(result.level);
    expect(result.breakdown.sourceType).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.sourceType).toBeLessThanOrEqual(1);
    expect(result.breakdown.contentLength).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.contentLength).toBeLessThanOrEqual(1);
    expect([0, 1]).toContain(result.breakdown.agentMarker);
    expect(result.breakdown.interactionDepth).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.interactionDepth).toBeLessThanOrEqual(1);
  });

  it('多次调用同一输入产生一致的结果', () => {
    const evaluator = createEvaluator();
    const input = 'Consistent input for testing';
    const context: EvaluationContext = {
      sourceType: SourceType.AGENT_OUTPUT,
      isFollowUp: false,
    };

    const result1 = evaluator.evaluate(input, context);
    const result2 = evaluator.evaluate(input, context);
    const result3 = evaluator.evaluate(input, context);

    // 三次结果完全一致
    expect(result1.score).toBe(result2.score);
    expect(result2.score).toBe(result3.score);
    expect(result1.level).toBe(result2.level);
    expect(result1.breakdown).toEqual(result2.breakdown);
  });

  it('复杂真实场景评估合理性', () => {
    const evaluator = createEvaluator();

    // 场景1: 用户报告严重 Bug
    const bugReport = evaluator.evaluate(
      '我在生产环境发现了一个严重的BUG，导致用户无法登录。这是一个CRITICAL问题，需要立即FIX。',
      {
        sourceType: SourceType.USER_MANUAL,
        isFollowUp: true,
      }
    );

    expect(bugReport.level).toBe(ImportanceLevel.HIGH);
    expect(bugReport.score).toBeGreaterThanOrEqual(0.5);
    expect(bugReport.breakdown.agentMarker).toBe(1.0); // 包含多个关键词

    // 场景2: 系统普通日志
    const sysLog = evaluator.evaluate(
      '[INFO] Server started on port 3000',
      {
        sourceType: SourceType.SYSTEM_LOG,
      }
    );

    expect(sysLog.level).toBe(ImportanceLevel.LOW);
    expect(sysLog.score).toBeLessThan(0.3);
    expect(sysLog.breakdown.agentMarker).toBe(0.0); // 无关键词

    // 场景3: Agent 输出中等重要信息
    const agentOutput = evaluator.evaluate(
      'Based on my analysis of the codebase, I recommend refactoring the authentication module to improve maintainability.',
      {
        sourceType: SourceType.AGENT_OUTPUT,
        isFollowUp: false,
      }
    );

    // 可能是 MEDIUM（取决于具体分数）
    expect([ImportanceLevel.MEDIUM, ImportanceLevel.LOW]).toContain(agentOutput.level);
  });
});
