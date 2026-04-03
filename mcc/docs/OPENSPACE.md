# OpenSpace 自进化引擎

## 项目概述

OpenSpace 是一个基于 MCC 记忆核心的自进化 AI Agent 引擎，旨在为 AI Agent 提供自动进化、技能管理和执行能力。

### 核心功能

- **自进化技能**：技能可自我修复、自我优化、从实际使用中学习
- **跨 Agent 共享**：一个 Agent 的改进可被所有 Agent 使用
- **成本降低**：减少 Token 使用量，提高执行效率
- **性能提升**：提高任务成功率和质量评分
- **云端协作**：支持技能的云端共享和同步

## 技术架构

### 核心模块

1. **SkillManager**：技能的生命周期管理，包括创建、更新、删除、搜索等操作
2. **SelfEvolutionEngine**：技能的自动进化，包括修复、衍生和捕获三种模式
3. **ExecutionSystem**：任务和技能的执行，包括两阶段执行策略
4. **MonitorSystem**：技能健康状态和性能指标的监控
5. **CloudSkillCommunity**：与云端的技能共享和同步

### 技术栈

- Node.js 20+ (ESM)
- TypeScript (strict mode)
- Pino 日志
- 可选：SQLite/PostgreSQL（技能存储）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 导入 OpenSpace

```typescript
import { createOpenSpace } from '@mcc/core/openspace';
```

### 3. 初始化 OpenSpace

```typescript
const openSpace = createOpenSpace();

await openSpace.initialize({
  evolution: {
    enabled: true,
    maxConcurrentTasks: 5,
    triggerThresholds: {
      successRate: 0.8,
      executionTime: 5000,
      errorRate: 0.2,
    },
  },
  execution: {
    maxRetries: 3,
    defaultBudget: {
      maxTokens: 1000,
      maxTime: 60000,
    },
  },
  monitoring: {
    enabled: true,
    checkInterval: 60000,
    healthScoreThreshold: 40,
  },
  cloudCommunity: {
    enabled: true,
    apiUrl: 'https://api.openspace.example.com',
    apiKey: 'your-api-key',
    syncInterval: 3600000,
  },
});
```

### 4. 创建技能

```typescript
const skill = await openSpace.getSkillManager().createSkill({
  name: 'Calculator',
  description: 'A simple calculator skill',
  type: 'utility',
  status: 'active',
  version: '1.0.0',
  tags: ['calculator', 'utility'],
  dependencies: [],
  implementation: `
    function calculate(operation, a, b) {
      switch (operation) {
        case 'add': return a + b;
        case 'subtract': return a - b;
        case 'multiply': return a * b;
        case 'divide': return a / b;
        default: throw new Error('Invalid operation');
      }
    }
  `,
  metadata: {},
});
```

### 5. 执行任务

```typescript
const result = await openSpace.executeTask({
  operation: 'add',
  a: 10,
  b: 20,
});

console.log(result);
// Output: { success: true, output: 30, executionTime: 10, tokenUsage: 50, steps: [...] }
```

### 6. 触发技能进化

```typescript
const evolutionTask = await openSpace.getSelfEvolutionEngine().triggerEvolution(
  skill.id,
  'fix',
  'tool_degradation'
);
```

### 7. 检查健康状态

```typescript
const healthStatus = await openSpace.getHealthStatus();
console.log(healthStatus);
// Output: { overall: 'healthy', components: {...}, skillCount: 1, activeEvolutionTasks: 0 }
```

## API 文档

### OpenSpace 主类

#### initialize(config: OpenSpaceConfig): Promise<void>
初始化 OpenSpace 实例。

#### executeTask(input: any, options?: ExecuteTaskOptions): Promise<SkillExecutionResult>
执行任务，返回执行结果。

#### getSkillManager(): SkillManager
获取技能管理器。

#### getSelfEvolutionEngine(): SelfEvolutionEngine
获取自进化引擎。

#### getExecutionSystem(): ExecutionSystem
获取执行系统。

#### getMonitorSystem(): MonitorSystem
获取监控系统。

#### getCloudSkillCommunity(): CloudSkillCommunity | null
获取云端技能社区。

#### getHealthStatus(): Promise<HealthStatus>
获取系统健康状态。

#### cleanup(): Promise<CleanupResult>
清理过期数据。

#### destroy(): Promise<void>
销毁 OpenSpace 实例。

### SkillManager

#### createSkill(skill: CreateSkillInput): Promise<Skill>
创建新技能。

#### getSkill(id: string): Promise<Skill | null>
获取技能。

#### updateSkill(id: string, updates: Partial<Skill>): Promise<Skill>
更新技能。

#### deleteSkill(id: string): Promise<boolean>
删除技能。

#### listSkills(filters?: SkillFilters): Promise<Skill[]>
列出技能。

#### searchSkills(query: string, limit?: number): Promise<Skill[]>
搜索技能。

#### getSkillVersions(skillId: string): Promise<SkillVersion[]>
获取技能版本。

#### rollbackSkillVersion(skillId: string, version: string): Promise<Skill>
回滚技能版本。

### SelfEvolutionEngine

#### triggerEvolution(skillId: string, mode: EvolutionMode, trigger: EvolutionTrigger, context?: any): Promise<EvolutionTask>
触发技能进化。

#### executeEvolutionTask(task: EvolutionTask): Promise<EvolutionTask>
执行进化任务。

#### getEvolutionTask(id: string): Promise<EvolutionTask | null>
获取进化任务。

#### listEvolutionTasks(filters?: EvolutionTaskFilters): Promise<EvolutionTask[]>
列出进化任务。

### ExecutionSystem

#### executeTask(context: ExecutionContext): Promise<SkillExecutionResult>
执行任务。

#### executeSkill(skillId: string, input: any, context: ExecutionContext): Promise<SkillExecutionResult>
执行技能。

#### getExecutionRecord(id: string): Promise<ExecutionRecord | null>
获取执行记录。

#### listExecutionRecords(filters?: ExecutionRecordFilters): Promise<ExecutionRecord[]>
列出执行记录。

### MonitorSystem

#### recordMetric(metric: MonitorMetric): Promise<void>
记录执行指标。

#### checkSkillHealth(skillId: string): Promise<HealthCheckResult>
检查技能健康状态。

#### checkAllSkillsHealth(): Promise<HealthCheckResult[]>
检查所有技能健康状态。

#### getSkillMetrics(skillId: string, timeRange?: TimeRange): Promise<MonitorMetric[]>
获取技能指标历史。

### CloudSkillCommunity

#### syncSkillsToCloud(skillIds?: string[]): Promise<number>
同步技能到云端。

#### syncSkillsFromCloud(filters?: SkillFilters): Promise<number>
从云端同步技能。

#### shareSkill(skillId: string, visibility?: Visibility): Promise<boolean>
共享技能。

#### downloadSkill(skillId: string): Promise<Skill | null>
下载技能。

#### searchCloudSkills(query: string, limit?: number): Promise<Skill[]>
搜索云端技能。

## 配置选项

### OpenSpaceConfig

```typescript
interface OpenSpaceConfig {
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
```

## 示例

### 完整示例

```typescript
import { createOpenSpace } from '@mcc/core/openspace';

async function main() {
  // 初始化 OpenSpace
  const openSpace = createOpenSpace();
  
  await openSpace.initialize({
    evolution: {
      enabled: true,
      maxConcurrentTasks: 5,
      triggerThresholds: {
        successRate: 0.8,
        executionTime: 5000,
        errorRate: 0.2,
      },
    },
    execution: {
      maxRetries: 3,
      defaultBudget: {
        maxTokens: 1000,
        maxTime: 60000,
      },
    },
    monitoring: {
      enabled: true,
      checkInterval: 60000,
      healthScoreThreshold: 40,
    },
  });

  // 创建技能
  const skill = await openSpace.getSkillManager().createSkill({
    name: 'Calculator',
    description: 'A simple calculator skill',
    type: 'utility',
    status: 'active',
    version: '1.0.0',
    tags: ['calculator', 'utility'],
    dependencies: [],
    implementation: `
      function calculate(operation, a, b) {
        switch (operation) {
          case 'add': return a + b;
          case 'subtract': return a - b;
          case 'multiply': return a * b;
          case 'divide': return a / b;
          default: throw new Error('Invalid operation');
        }
      }
    `,
    metadata: {},
  });

  // 执行任务
  const result = await openSpace.executeTask({
    operation: 'add',
    a: 10,
    b: 20,
  });

  console.log('Execution result:', result);

  // 检查健康状态
  const healthStatus = await openSpace.getHealthStatus();
  console.log('Health status:', healthStatus);

  // 清理
  await openSpace.cleanup();

  // 销毁
  await openSpace.destroy();
}

main().catch(console.error);
```

## 常见问题

### 1. 技能进化失败怎么办？

检查进化任务的状态和错误信息：

```typescript
const task = await openSpace.getSelfEvolutionEngine().getEvolutionTask(taskId);
console.log(task.result);
```

### 2. 如何提高技能执行效率？

- 优化技能实现代码
- 减少不必要的计算
- 使用缓存
- 调整执行预算

### 3. 如何共享技能到云端？

```typescript
await openSpace.getCloudSkillCommunity()?.shareSkill(skillId, 'public');
```

### 4. 如何监控技能健康状态？

```typescript
const healthCheck = await openSpace.getMonitorSystem().checkSkillHealth(skillId);
console.log(healthCheck);
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT