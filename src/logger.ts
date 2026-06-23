import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr.
// The unhandledRejection handler is installed in src/index.ts after channels
// are connected, because it needs to be able to re-init the Telegram channel
// (the May 14 incident: a grammy getUpdates 409 took down polling for 6 days
// because the handler here only logged and never recovered).
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
