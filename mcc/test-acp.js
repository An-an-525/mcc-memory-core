/**
 * ACP 协议测试脚本
 *
 * 测试 ACP 协议的通信功能
 *
 * @example
 * node test-acp.js
 */

const { ACPClient, EventType } = require('@mcc/core');

async function testACPClient() {
  console.log('=== ACP 协议测试 ===\n');

  // 创建 ACP 客户端实例
  const client = new ACPClient('http://localhost:44448', 'test-client');

  let testResults = [];

  function addTestResult(testName, success, message) {
    testResults.push({ testName, success, message });
    console.log(`${success ? '✅' : '❌'} ${testName}: ${message}`);
  }

  try {
    // 测试 1: 发现智能体
    console.log('测试 1: 发现智能体');
    try {
      const agents = await client.discoverAgents();
      addTestResult('发现智能体', true, `成功发现 ${agents.length} 个智能体`);
    } catch (error) {
      addTestResult('发现智能体', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 2: 获取智能体信息
    console.log('测试 2: 获取智能体信息');
    try {
      const agentInfo = await client.getAgentInfo('trae-agent');
      addTestResult('获取智能体信息', true, `成功获取 ${agentInfo.name} 的信息`);
    } catch (error) {
      addTestResult('获取智能体信息', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 3: 发送文本消息
    console.log('测试 3: 发送文本消息');
    try {
      const response = await client.sendTextMessage({
        text: '测试消息: ACP 协议通信测试',
        recipient: 'trae-agent'
      });
      addTestResult('发送文本消息', true, `成功收到响应: ${response.text.substring(0, 50)}...`);
    } catch (error) {
      addTestResult('发送文本消息', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 4: 发送事件通知
    console.log('测试 4: 发送事件通知');
    try {
      const response = await client.sendEvent(EventType.TEST, {
        test_data: 'test_value',
        timestamp: Date.now()
      });
      addTestResult('发送事件通知', true, `成功发送事件: ${response.eventId}`);
    } catch (error) {
      addTestResult('发送事件通知', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 5: 发送多条消息
    console.log('测试 5: 发送多条消息');
    try {
      const messages = [
        '第一条测试消息',
        '第二条测试消息',
        '第三条测试消息'
      ];

      for (const message of messages) {
        const response = await client.sendTextMessage({
          text: message,
          recipient: 'trae-agent'
        });
        console.log(`  发送: "${message}" -> 收到: "${response.text.substring(0, 50)}..."`);
      }
      addTestResult('发送多条消息', true, `成功发送 ${messages.length} 条消息`);
    } catch (error) {
      addTestResult('发送多条消息', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 6: 测试会话 ID
    console.log('测试 6: 测试会话 ID');
    try {
      const originalSessionId = client.getSessionId();
      console.log(`  原始会话 ID: ${originalSessionId}`);
      
      const newSessionId = `test_session_${Date.now()}`;
      client.setSessionId(newSessionId);
      console.log(`  新会话 ID: ${client.getSessionId()}`);
      
      addTestResult('测试会话 ID', true, '成功设置和获取会话 ID');
    } catch (error) {
      addTestResult('测试会话 ID', false, `失败: ${error.message}`);
    }
    console.log('');

    // 测试 7: 测试配置获取
    console.log('测试 7: 测试配置获取');
    try {
      const config = client.getConfig();
      console.log(`  服务器 URL: ${config.serverUrl}`);
      console.log(`  客户端 ID: ${config.clientId}`);
      console.log(`  超时时间: ${config.timeout}ms`);
      addTestResult('测试配置获取', true, '成功获取客户端配置');
    } catch (error) {
      addTestResult('测试配置获取', false, `失败: ${error.message}`);
    }
    console.log('');

  } catch (error) {
    console.error('测试过程中发生错误:', error);
  } finally {
    // 关闭客户端
    await client.close();

    // 显示测试结果
    console.log('=== 测试结果汇总 ===');
    const passedTests = testResults.filter(r => r.success).length;
    const totalTests = testResults.length;
    
    console.log(`通过: ${passedTests}/${totalTests}`);
    
    if (passedTests === totalTests) {
      console.log('🎉 所有测试通过！');
    } else {
      console.log('⚠️  部分测试失败');
      testResults.filter(r => !r.success).forEach(r => {
        console.log(`  ❌ ${r.testName}: ${r.message}`);
      });
    }
    
    console.log('');
    console.log('=== 测试完成 ===');
  }
}

// 运行测试
testACPClient().catch(console.error);