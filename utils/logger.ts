// ./utils/logger.ts
import { config } from 'dotenv';
config(); // Ensure .env variables are loaded

// Define log level type
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// Interface for the logger object
interface Logger {
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  info: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;

const levels: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel = levels[LOG_LEVEL] ?? levels.info;

const log = (level: LogLevel, ...args: any[]): void => {
  if (levels[level] <= currentLevel) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  }
};

export const logger: Logger = {
  error: (...args: any[]) => log('error', ...args),
  warn: (...args: any[]) => log('warn', ...args),
  info: (...args: any[]) => log('info', ...args),
  debug: (...args: any[]) => log('debug', ...args),
};

export default logger;