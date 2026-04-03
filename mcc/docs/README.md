# MCC Memory Core

Memory Core Autonomous AI Agent Control Platform (MCC) - Phase 1A

## 项目概述

MCC 是一个记忆核心自治 AI Agent 控制平台，旨在为 AI Agent 提供持久化、高效的记忆管理系统。

### 核心功能

- **三层存储架构**：内存 Map → Redis → PostgreSQL
- **向量搜索**：支持基于 pgvector 的相似度查询
- **灵活的读写策略**：层级读取和并行读取
- **自动降级机制**：确保系统在不同存储层故障时仍能运行
- **完整的错误处理**：提供详细的错误信息和健康检查

## 技术栈

- Node.js 20+ (ESM)
- Hono
- Drizzle ORM
- PostgreSQL 16+ (pgvector)
- Redis
- TypeScript (strict mode)
- Pino 日志

## 项目结构

```
mcc/
├── packages/
│   ├── core/         # 核心内存管理库
│   ├── server/       # 服务器实现
│   └── gui-web/      # Web 界面（待实现）
├── tests/            # 测试文件
├── docs/             # 文档
└── docker-compose.yml # Docker 配置
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动基础设施

```bash
docker-compose up -d
```

### 3. 构建项目

```bash
pnpm build
```

### 4. 启动服务器

```bash
pnpm dev:server
```

## 存储架构

### 三层存储

1. **内存 Map**：最快的存储，适用于频繁访问的数据
2. **Redis**：分布式缓存，提供会话级持久化
3. **PostgreSQL**：持久化存储，支持向量搜索

### 读写策略

- **写入策略**：
  - `all`：同时写入三层
  - `cascade`：内存 → Redis → PostgreSQL

- **读取策略**：
  - `hierarchical`：内存 → Redis → PostgreSQL
  - `parallel`：同时查询三层

## API 文档

### ActiveMemory 接口

```typescript
// 初始化
const memory = new ActiveMemory<string>();
await memory.initialize({
  maxMemorySize: 1000,
  defaultTtlMs: 3600000, // 1 hour
  enableDegradation: true,
  writeStrategy: 'all',
  readStrategy: 'hierarchical',
  vectorSearchThreshold: 0.7,
});

// 写入
await memory.write('key', 'value');

// 读取
const value = await memory.read('key');

// 写入带向量嵌入
await memory.writeWithEmbedding('key', 'value', [0.1, 0.2, 0.3]);

// 搜索相似
const results = await memory.searchSimilar([0.1, 0.2, 0.3], 5, 0.7);
```

## 测试

```bash
pnpm test
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT