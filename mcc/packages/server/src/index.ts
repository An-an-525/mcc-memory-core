import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ActiveMemory } from '../../core/src/memory/active/index.js';

const app = new Hono();

// 初始化 ActiveMemory
const memory = new ActiveMemory<string>();

// 初始化 ActiveMemory
memory.initialize({
  maxMemorySize: 1000,
  defaultTtlMs: 3600000, // 1 hour
  enableDegradation: true,
  writeStrategy: 'all',
  readStrategy: 'hierarchical',
  vectorSearchThreshold: 0.7,
}).then(() => {
  console.log('ActiveMemory initialized successfully');
}).catch((error) => {
  console.error('Failed to initialize ActiveMemory:', error);
});

app.get('/', (c) => {
  return c.text('MCC Server is running!');
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// 内存存储接口
app.post('/memory', async (c) => {
  try {
    const { key, value, ttl } = await c.req.json();
    if (!key || !value) {
      return c.json({ error: 'key and value are required' }, 400);
    }
    await memory.write(key, value, { ttl });
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.get('/memory/:key', async (c) => {
  try {
    const key = c.req.param('key');
    const value = await memory.read(key);
    if (value === null) {
      return c.json({ error: 'Key not found' }, 404);
    }
    return c.json({ key, value });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.delete('/memory/:key', async (c) => {
  try {
    const key = c.req.param('key');
    const success = await memory.delete(key);
    return c.json({ success });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.get('/memory', async (c) => {
  try {
    const keys = await memory.keys();
    return c.json({ keys });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.get('/memory/size', async (c) => {
  try {
    const size = await memory.size();
    return c.json({ size });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

const port = 44448;
console.log(`Server running on http://localhost:${port}`);
serve({ 
  fetch: app.fetch, 
  port 
});
