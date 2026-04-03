import pino from 'pino';

const logger = pino({
  level: process.env['MCC_LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] !== 'production'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
});

export default logger;
