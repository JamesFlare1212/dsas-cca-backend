import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/core/logger.ts';
import { CookieAuth } from '../src/upstream/auth.ts';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const auth = new CookieAuth(
  {
    baseUrl: config.API_BASE_URL,
    username: config.API_USERNAME,
    password: config.API_PASSWORD,
    cookiePath: join(config.DATA_DIR, 'cookies.json'),
    loginTimeoutMs: config.AUTH_LOGIN_TIMEOUT_MS,
    authCooldownMs: config.AUTH_FAILURE_COOLDOWN_MS,
    credentialsEncoded: config.API_CREDENTIALS_URL_ENCODED,
  },
  logger,
);
try {
  await auth.getCookies();
  logger.info('Authenticated session is cached in DATA_DIR.');
} finally {
  await auth.close();
}
