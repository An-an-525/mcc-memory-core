/**
 * ACP 协议演示脚本
 *
 * 演示如何使用 ACP 协议与本地 Trae 进行通信
 *
 * @example
 * node examples/acp-demo.js
 */

const { ACPClient, EventType } = require('@mcc/core');

async function main() {
  console.log('=== ACP 协议演示 ===\n');

  // 创建 ACP 客户端实例
  const client = new ACPClient('http://localhost:44448', 'mcc-agent');

  try {
    // 1. 发现智能体
    console.log('1. 发现智能体...');
    const agents = await client.discoverAgents();
    console.log('发现的智能体:');
    agents.forEach(agent => {
      console.log(`  - ${agent.name} (${agent.id}) - ${agent.status}`);
    });
    console.log('');

    // 2. 获取智能体信息
    console.log('2. 获取本地 Trae 智能体信息...');
    const traeInfo = await client.getAgentInfo('trae-agent');
    console.log('本地 Trae 智能体信息:');
    console.log(`  名称: ${traeInfo.name}`);
    console.log(`  描述: ${traeInfo.description}`);
    console.log(`  状态: ${traeInfo.status}`);
    console.log(`  版本: ${traeInfo.version}`);
    console.log(`  能力: ${traeInfo.capabilities.join(', ')}`);
    console.log('');

    // 3. 发送文本消息
    console.log('3. 发送文本消息...');
    const messageResponse = await client.sendTextMessage({
      text: '你好，本地Trae！我是 MCC 智能体。',
      recipient: 'trae-agent'
    });
    console.log('收到响应:');
    console.log(`  ${messageResponse.text}`);
    console.log('');

    // 4. 发送事件通知
    console.log('4. 发送事件通知...');
    const eventResponse = await client.sendEvent(EventType.TASK_STARTED, {
      task_id: 'task_123',
      description: '开始执行 ACP 演示任务',
      agent_id: 'mcc-agent'
    });
    console.log('事件发送结果:');
    console.log(`  成功: ${eventResponse.success}`);
    console.log(`  消息: ${eventResponse.message}`);
    console.log(`  事件 ID: ${eventResponse.eventId}`);
    console.log('');

    // 5. 再次发送文本消息
    console.log('5. 发送第二条文本消息...');
    const secondMessageResponse = await client.sendTextMessage({
      text: 'ACP 协议通信测试成功！',
      recipient: 'trae-agent'
    });
    console.log('收到响应:');
    console.log(`  ${secondMessageResponse.text}`);
    console.log('');

    console.log('=== 演示完成 ===');
    console.log('ACP 协议通信功能正常工作！');

  } catch (error) {
    console.error('演示过程中发生错误:', error);
  } finally {
    // 关闭客户端
    await client.close();
  }
}

// 运行演示
main().catch(console.error);