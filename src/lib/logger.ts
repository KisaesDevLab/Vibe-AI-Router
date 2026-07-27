import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logger. Redaction paths are configured BEFORE any AI traffic exists (Phase 0.10):
 * prompt bodies must never appear in logs — a hard product invariant. These paths cover the
 * envelope (`messages`), OpenAI-shaped responses (`choices`), Anthropic-shaped responses
 * (`content`), and credential material.
 */
export const REDACT_PATHS = [
  'req.body.messages',
  'req.body.tools',
  'res.body.choices',
  'res.body.content',
  'body.messages',
  'body.choices',
  'body.content',
  'messages',
  'choices',
  '*.messages',
  '*.choices',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

export function createLogger(
  level: string,
  pretty: boolean,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'vibe-ai-router' },
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
