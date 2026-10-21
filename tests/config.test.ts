import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';

const credentials = { API_USERNAME: 'test-user', API_PASSWORD: 'private-value' };
describe('configuration', () => {
  test('has explicit compatible defaults and strict boolean conversion', () => {
    const config = loadConfig({
      ...credentials,
      SCHEDULER_ENABLED: 'false',
      API_CREDENTIALS_URL_ENCODED: 'false',
    });
    expect(config.SCHEDULER_ENABLED).toBe(false);
    expect(config.API_CREDENTIALS_URL_ENCODED).toBe(false);
    expect(config.activityFreshMs).toBe(360 * 60000);
    expect(config.REDIS_KEY_PREFIX).toBe('dsas:v2');
  });
  test.each(['0', 'NaN', '1.1', '-4', '99999'])('rejects invalid PORT %s', (PORT) => {
    expect(() => loadConfig({ ...credentials, PORT })).toThrow('PORT');
  });
  test('rejects wrong scan bounds and unsafe concurrency', () => {
    expect(() =>
      loadConfig({ ...credentials, MIN_ACTIVITY_ID_SCAN: '100', MAX_ACTIVITY_ID_SCAN: '10' }),
    ).toThrow('MAX_ACTIVITY_ID_SCAN');
    expect(() => loadConfig({ ...credentials, CONCURRENT_API_CALLS: '0' })).toThrow(
      'CONCURRENT_API_CALLS',
    );
    expect(() => loadConfig({ ...credentials, SCHEDULER_ENABLED: 'falsey' })).toThrow(
      'SCHEDULER_ENABLED',
    );
  });
  test('does not expose secrets when reporting invalid configuration', () => {
    try {
      loadConfig({ ...credentials, PORT: 'bad' });
      throw new Error('expected config failure');
    } catch (error) {
      expect(String(error)).toContain('PORT');
      expect(String(error)).not.toContain(credentials.API_PASSWORD);
    }
  });
  test('requires coherent S3 configuration and exact CORS origins', () => {
    expect(() => loadConfig({ ...credentials, S3_ACCESS_KEY_ID: 'private-key' })).toThrow(
      'S3_BUCKET_NAME',
    );
    expect(() =>
      loadConfig({ ...credentials, ALLOWED_ORIGINS: 'https://example.com/path' }),
    ).toThrow('ALLOWED_ORIGINS');
    expect(
      loadConfig({ ...credentials, ALLOWED_ORIGINS: 'https://example.com, http://localhost:5173' })
        .allowedOrigins,
    ).toEqual(['https://example.com', 'http://localhost:5173']);
  });

  test('rejects unsupported protocols and embedded URL credentials before startup', () => {
    expect(() => loadConfig({ ...credentials, API_BASE_URL: 'ftp://example.test' })).toThrow(
      'API_BASE_URL',
    );
    expect(() =>
      loadConfig({ ...credentials, API_BASE_URL: 'https://user:secret@example.test' }),
    ).toThrow('API_BASE_URL');
    expect(() => loadConfig({ ...credentials, S3_ENDPOINT: 'file:///tmp' })).toThrow('S3_ENDPOINT');
  });
});
