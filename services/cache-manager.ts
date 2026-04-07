// services/cache-manager.ts
import { config } from 'dotenv';
import { fetchActivityData } from '../engage-api/get-activity';
import { structActivityData } from '../engage-api/struct-activity';
import { structStaffData } from '../engage-api/struct-staff';
import {
  getActivityData,
  setActivityData,
  getStaffData,
  setStaffData,
  getAllActivityKeys,
  ACTIVITY_KEY_PREFIX
} from './redis-service';
import { uploadImageFromBase64, listS3Objects, deleteS3Objects, constructS3Url } from './s3-service';
import { extractBase64Image } from '../utils/image-processor';
import { logger } from '../utils/logger';
import { BatchProcessor, executeWithConcurrencyAndProgress } from '../utils/semaphore';

import type { ActivityData } from '../models/activity';

config();

// Environment configuration
const USERNAME = process.env.API_USERNAME;
const PASSWORD = process.env.API_PASSWORD;
const MIN_ACTIVITY_ID_SCAN = parseInt(process.env.MIN_ACTIVITY_ID_SCAN || '0', 10);
const MAX_ACTIVITY_ID_SCAN = parseInt(process.env.MAX_ACTIVITY_ID_SCAN || '9999', 10);
const CLUB_UPDATE_INTERVAL_MINS = parseInt(process.env.CLUB_UPDATE_INTERVAL_MINS || '60', 10);
const STAFF_UPDATE_INTERVAL_MINS = parseInt(process.env.STAFF_UPDATE_INTERVAL_MINS || '60', 10);
const FIXED_STAFF_ACTIVITY_ID = process.env.FIXED_STAFF_ACTIVITY_ID;
const S3_IMAGE_PREFIX = (process.env.S3_PUBLIC_URL_PREFIX || 'files').replace(/\/$/, '');

// Crawler concurrency configuration
const CONCURRENT_API_CALLS = parseInt(process.env.CONCURRENT_API_CALLS || '8', 10);
const CRAWLER_REQUEST_TIMEOUT_MS = parseInt(process.env.CRAWLER_REQUEST_TIMEOUT_MS || '25000', 10);
const CRAWLER_MAX_RETRIES = parseInt(process.env.CRAWLER_MAX_RETRIES || '3', 10);
const CRAWLER_RETRY_DELAY_MS = parseInt(process.env.CRAWLER_RETRY_DELAY_MS || '1000', 10);

// Module-level counter for skipped activities (reset at start of each scan)
let skippedCount = 0;

/**
 * Process and cache a single activity
 * @param activityId - The activity ID to process
 * @returns The processed activity data
 */
async function processAndCacheActivity(activityId: string): Promise<ActivityData> {
  logger.debug(`Processing activity ID: ${activityId}`);
  try {
    if (!USERNAME || !PASSWORD) {
      throw new Error('API username or password not configured');
    }
    
    // Add timeout protection for the entire fetch operation
    logger.debug(`Fetching activity data for ID: ${activityId}`);
    const activityJson = await Promise.race([
      fetchActivityData(activityId, USERNAME, PASSWORD, false),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout fetching activity ${activityId} after ${CRAWLER_REQUEST_TIMEOUT_MS}ms`)), CRAWLER_REQUEST_TIMEOUT_MS + 5000)
      )
    ]);
    let structuredActivity: ActivityData;

    if (!activityJson) {
      logger.info(`No data found for activity ID ${activityId} from engage API. Caching as empty.`);
      structuredActivity = { 
        lastCheck: new Date().toISOString(), 
        source: 'api-fetch-empty' 
      };
    } else {
      structuredActivity = await structActivityData(activityJson);
      if (structuredActivity && structuredActivity.photo && 
        typeof structuredActivity.photo === 'string' && 
        structuredActivity.photo.startsWith('data:image')) {
        
        const imageInfo = extractBase64Image(structuredActivity.photo);
        if (imageInfo) {
          const s3Url = await uploadImageFromBase64(
            imageInfo.base64Content, 
            imageInfo.format, 
            activityId
          );
          
          if (s3Url) {
            structuredActivity.photo = s3Url;
          } else {
            logger.warn(`Failed S3 upload for activity ${activityId}. Photo may be base64 or null.`);
          }
        }
      }
    }
    structuredActivity.lastCheck = new Date().toISOString();
    await setActivityData(activityId, structuredActivity);
    return structuredActivity;
  } catch (error) {
    logger.error(`Error processing activity ID ${activityId}:`, error);
    const errorData: ActivityData = { 
      lastCheck: new Date().toISOString(), 
      error: "Failed to fetch or process" 
    };
    await setActivityData(activityId, errorData);
    return errorData;
  }
}

/**
 * Process a single activity for initialization
 * @param activityId - The activity ID to process
 */
async function processSingleActivity(activityId: string): Promise<void> {
  const cachedData = await getActivityData(activityId);
  
  if (!cachedData || 
    Object.keys(cachedData).length === 0 || 
    !cachedData.lastCheck || 
    cachedData.error) {
    
    logger.debug(`Initializing cache for activity ID: ${activityId}`);
    await processAndCacheActivity(activityId);
  } else {
    skippedCount++;
  }
}

/**
 * Initialize the club cache by scanning through all activity IDs
 * Processed concurrently with controlled parallelism
 */
export async function initializeClubCache(): Promise<void> {
  logger.info(`Starting initial club cache population from ID ${MIN_ACTIVITY_ID_SCAN} to ${MAX_ACTIVITY_ID_SCAN}`);
  logger.info(`Concurrency: ${CONCURRENT_API_CALLS} parallel requests`);
  
  const totalIds = MAX_ACTIVITY_ID_SCAN - MIN_ACTIVITY_ID_SCAN + 1;
  let successCount = 0;
  let errorCount = 0;
  skippedCount = 0; // Reset for this run
  
  // Generate array of activity IDs
  const activityIds = Array.from(
    { length: totalIds },
    (_, i) => String(MIN_ACTIVITY_ID_SCAN + i)
  );
  
  // Create batch processor with concurrency control
  const processor = new BatchProcessor(
    async (activityId: string) => {
      await processSingleActivity(activityId);
      return activityId;
    },
    CONCURRENT_API_CALLS,
    {
      onError: (error, activityId) => {
        errorCount++;
        logger.error(`Error processing activity ID ${activityId}:`, error);
      },
      onProgress: (completed, total) => {
        if (completed % 100 === 0 || completed === total) {
          const mem = process.memoryUsage();
          logger.info(`Progress: ${completed}/${total} (${Math.round(completed/total*100)}%) - Success: ${successCount}, Skipped: ${skippedCount}, Errors: ${errorCount} | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB | Concurrent: ${CONCURRENT_API_CALLS}`);
        }
      }
    }
  );
  
  // Process all activities concurrently
  const results = await processor.process(activityIds);
  successCount = results.length;
  
  logger.info(`Initial club cache population finished.`);
  logger.info(`Summary: Total: ${totalIds}, Processed: ${activityIds.length}, Success: ${successCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
}

/**
 * Update stale clubs in the cache
 * Processed concurrently with controlled parallelism
 */
export async function updateStaleClubs(): Promise<void> {
  logger.info('Starting stale club check...');
  logger.info(`Concurrency: ${CONCURRENT_API_CALLS} parallel requests`);
  const now = Date.now();
  const updateIntervalMs = CLUB_UPDATE_INTERVAL_MINS * 60 * 1000;
  const activityKeys = await getAllActivityKeys();
  
  // Identify stale activities
  const staleActivityIds: string[] = [];
  for (const key of activityKeys) {
    const activityId = key.substring(ACTIVITY_KEY_PREFIX.length);
    const cachedData = await getActivityData(activityId);
    
    const needsUpdate = !cachedData || 
                       Object.keys(cachedData).length === 0 ||
                       (!cachedData.lastCheck && !cachedData.error) ||
                       (cachedData.lastCheck && (now - new Date(cachedData.lastCheck).getTime()) > updateIntervalMs) ||
                       cachedData.error;
    
    if (needsUpdate) {
      staleActivityIds.push(activityId);
    }
  }
  
  if (staleActivityIds.length === 0) {
    logger.info('No stale activities found. Skipping update.');
    await cleanupOrphanedS3Images();
    logger.info('Stale club check finished.');
    return;
  }
  
  logger.info(`Found ${staleActivityIds.length} stale activities to update.`);
  
  // Create batch processor for concurrent updates
  const processor = new BatchProcessor(
    async (activityId: string) => {
      logger.debug(`Updating stale activity ${activityId}`);
      await processAndCacheActivity(activityId);
      return activityId;
    },
    CONCURRENT_API_CALLS,
    {
      onError: (error, activityId) => {
        logger.error(`Error updating stale activity ${activityId}:`, error);
      },
      onProgress: (completed, total) => {
        if (completed % 10 === 0 || completed === total) {
          logger.info(`Update progress: ${completed}/${total} (${Math.round(completed/total*100)}%)`);
        }
      }
    }
  );
  
  // Process stale activities concurrently
  await processor.process(staleActivityIds);
  
  await cleanupOrphanedS3Images();
  
  logger.info('Stale club check finished.');
}

/**
 * Initialize or update the staff cache
 * @param forceUpdate - Force an update regardless of staleness
 */
export async function initializeOrUpdateStaffCache(forceUpdate: boolean = false): Promise<void> {
  logger.info('Starting staff cache check/update...');
  try {
    const cachedStaffData = await getStaffData();
    const now = Date.now();
    const updateIntervalMs = STAFF_UPDATE_INTERVAL_MINS * 60 * 1000;
    let needsUpdate = forceUpdate;

    if (!cachedStaffData || !cachedStaffData.lastCheck) {
      needsUpdate = true;
    } else {
      const lastCheckTime = new Date(cachedStaffData.lastCheck).getTime();
      if ((now - lastCheckTime) > updateIntervalMs) {
        needsUpdate = true;
      }
    }

    if (needsUpdate && USERNAME && PASSWORD && FIXED_STAFF_ACTIVITY_ID) {
      logger.info('Staff data needs update. Fetching...');
      const activityJson = await fetchActivityData(FIXED_STAFF_ACTIVITY_ID, USERNAME, PASSWORD);
      
      if (activityJson) {
        const staffMap = await structStaffData(activityJson);
        const staffObject = Object.fromEntries(staffMap);
        staffObject.lastCheck = new Date().toISOString();
        await setStaffData(staffObject);
        logger.info('Staff data updated and cached.');
      } else {
        logger.warn(`Could not retrieve base data for staff (activity ID ${FIXED_STAFF_ACTIVITY_ID}).`);
        if (cachedStaffData && cachedStaffData.lastCheck) {
          cachedStaffData.lastCheck = new Date().toISOString();
          await setStaffData(cachedStaffData);
        }
      }
    } else {
      logger.info('Staff data is up-to-date.');
    }
  } catch (error) {
    logger.error('Error initializing or updating staff cache:', error);
  }
}

/**
 * Clean up orphaned S3 images
 */
export async function cleanupOrphanedS3Images(): Promise<void> {
  logger.info('Starting S3 orphan image cleanup...');
  const s3ObjectListPrefix = S3_IMAGE_PREFIX ? `${S3_IMAGE_PREFIX}/` : '';

  try {
    const referencedS3Urls = new Set<string>();
    const allActivityRedisKeys = await getAllActivityKeys();
    const S3_ENDPOINT = process.env.S3_ENDPOINT;

    for (const redisKey of allActivityRedisKeys) {
      const activityId = redisKey.substring(ACTIVITY_KEY_PREFIX.length);
      const activityData = await getActivityData(activityId);
      
      if (activityData && 
        typeof activityData.photo === 'string' && 
        activityData.photo.startsWith('http') && 
        S3_ENDPOINT && 
        activityData.photo.startsWith(S3_ENDPOINT)) {
        referencedS3Urls.add(activityData.photo);
      }
    }
    
    logger.info(`Found ${referencedS3Urls.size} unique S3 URLs referenced in Redis.`);

    const s3ObjectKeys = await listS3Objects(s3ObjectListPrefix);
    if (!s3ObjectKeys || s3ObjectKeys.length === 0) {
      logger.info(`No images found in S3 under prefix "${s3ObjectListPrefix}". Nothing to clean up.`);
      return;
    }
    
    logger.debug(`Found ${s3ObjectKeys.length} objects in S3 under prefix "${s3ObjectListPrefix}".`);

    const orphanedObjectKeys: string[] = [];
    for (const objectKey of s3ObjectKeys) {
      const s3Url = constructS3Url(objectKey);
      if (s3Url && !referencedS3Urls.has(s3Url)) {
        orphanedObjectKeys.push(objectKey);
      }
    }

    if (orphanedObjectKeys.length > 0) {
      logger.info(`Found ${orphanedObjectKeys.length} orphaned S3 objects to delete. Submitting deletion...`);
      await deleteS3Objects(orphanedObjectKeys);
    } else {
      logger.info('No orphaned S3 images found after comparison.');
    }

    logger.info('S3 orphan image cleanup finished.');
  } catch (error) {
    logger.error('Error during S3 orphan image cleanup:', error);
  }
}
