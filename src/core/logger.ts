import pino from 'pino';

export type { Logger } from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        'password',
        'cookie',
        'cookies',
        'authorization',
        'secretAccessKey',
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    serializers: { err: pino.stdSerializers.err },
  });
}
