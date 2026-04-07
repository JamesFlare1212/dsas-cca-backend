// services/redis-service.ts
import { RedisClient } from "bun";
import { config } from 'dotenv';
import { logger } from '../utils/logger';

config();

export const ACTIVITY_KEY_PREFIX = 'activity:'; // Exported for use in cache-manager
const STAFF_KEY = 'staffs:all';

// Cache TTL configuration (in seconds)
const ACTIVITY_CACHE_TTL = parseInt(process.env.ACTIVITY_CACHE_TTL || '86400', 10); // Default: 24 hours
const STAFF_CACHE_TTL = parseInt(process.env.STAFF_CACHE_TTL || '86400', 10); // Default: 24 hours
const ERROR_CACHE_TTL = parseInt(process.env.ERROR_CACHE_TTL || '3600', 10); // Default: 1 hour for errors

// Always create a new client instance with .env config
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redisClient: RedisClient | null = null;

try {
  redisClient = new RedisClient(redisUrl);
  logger.info('Redis client initialized. Connection will be established on first command.');
} catch (error) {
  logger.error('Failed to initialize Redis client:', error);
}

/**
 * Gets activity data from Redis.
 * @param activityId - The activity ID to fetch
 * @returns Parsed JSON object or null if not found/error
 */
export async function getActivityData(activityId: string): Promise<any | null> {
  if (!redisClient) {
    logger.warn('Redis client not available, skipping getActivityData');
    return null;
  }
  try {
    const data = await redisClient.get(`${ACTIVITY_KEY_PREFIX}${activityId}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error(`Error getting activity ${activityId} from Redis:`, err);
    return null;
  }
}

/**
 * Sets activity data in Redis with TTL.
 * @param activityId - The activity ID to set
 * @param data - The activity data object
 * @param ttl - Optional TTL in seconds (defaults to ACTIVITY_CACHE_TTL, or ERROR_CACHE_TTL if data has error)
 */
export async function setActivityData(activityId: string, data: any, ttl?: number): Promise<void> {
  if (!redisClient) {
    logger.warn('Redis client not available, skipping setActivityData');
    return;
  }
  try {
    // Use shorter TTL for error states to allow retry
    const expiration = data?.error ? ERROR_CACHE_TTL : (ttl || ACTIVITY_CACHE_TTL);
    // Bun's RedisClient doesn't have setEx, use raw SETEX command
    await redisClient.send('SETEX', [
      `${ACTIVITY_KEY_PREFIX}${activityId}`,
      String(expiration),
      JSON.stringify(data)
    ]);
  } catch (err) {
    logger.error(`Error setting activity ${activityId} in Redis:`, err);
  }
}

/**
 * Gets staff data from Redis.
 * @returns Parsed JSON object or null if not found/error
 */
export async function getStaffData(): Promise<any | null> {
  if (!redisClient) {
    logger.warn('Redis client not available, skipping getStaffData');
    return null;
  }
  try {
    const data = await redisClient.get(STAFF_KEY);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('Error getting staff data from Redis:', err);
    return null;
  }
}

/**
 * Sets staff data in Redis with TTL.
 * @param data - The staff data object
 * @param ttl - Optional TTL in seconds (defaults to STAFF_CACHE_TTL)
 */
export async function setStaffData(data: any, ttl?: number): Promise<void> {
  if (!redisClient) {
    logger.warn('Redis client not available, skipping setStaffData');
    return;
  }
  try {
    const expiration = ttl || STAFF_CACHE_TTL;
    // Use raw SETEX command for TTL support
    await redisClient.send('SETEX', [
      STAFF_KEY,
      String(expiration),
      JSON.stringify(data)
    ]);
  } catch (err) {
    logger.error('Error setting staff data in Redis:', err);
  }
}

/**
 * Gets all activity keys from Redis.
 * This can be resource-intensive on large datasets. Use with caution.
 * @returns An array of keys
 */
export async function getAllActivityKeys(): Promise<string[]> {
  if (!redisClient) {
    logger.warn('Redis client not available, skipping getAllActivityKeys');
    return [];
  }
  try {
    // Using raw SCAN command since Bun's RedisClient doesn't have a scan method
    const keys: string[] = [];
    let cursor = '0';
    let iteration = 0;
    const MAX_ITERATIONS = 1000; // Safety limit to prevent infinite loops
    
    do {
      iteration++;
      // Use send method to execute raw Redis commands
      const result = await redisClient.send('SCAN', [
        cursor, 
        'MATCH', 
        `${ACTIVITY_KEY_PREFIX}*`, 
        'COUNT', 
        '100'
      ]);
      
      // Force convert to string to ensure type consistency (Bun may return Buffer)
      cursor = String(result[0] ?? '0');
      const foundKeys = result[1] || [];
      
      logger.debug(`SCAN iteration ${iteration}: cursor=${cursor}, found ${foundKeys.length} keys, total=${keys.length + foundKeys.length}`);
      
      // Add the found keys to our array
      keys.push(...foundKeys);
      
      // Prevent infinite loop
      if (iteration >= MAX_ITERATIONS) {
        logger.warn(`SCAN reached max iterations (${MAX_ITERATIONS}). May have incomplete results.`);
        break;
      }
      
    } while (cursor !== '0');
    
    logger.info(`Found ${keys.length} activity keys in Redis after ${iteration} SCAN iterations.`);
    return keys;
  } catch (err) {
    logger.error('Error getting all activity keys from Redis using SCAN:', err);
    return []; // Return empty array on error
  }
}

/**
 * Gets the Redis client instance.
 * @returns The Redis client or null if not initialized
 */
export function getRedisClient(): RedisClient | null {
  return redisClient;
}

/**
 * Closes the Redis connection.
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    redisClient.close();
    logger.info('Redis connection closed.');
  }
}
