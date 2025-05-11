// services/cache-manager.ts
import { config } from 'dotenv';
import pLimit from 'p-limit';
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

import type { ActivityData } from '../models/activity';

config();

// Environment configuration
const USERNAME = process.env.API_USERNAME;
const PASSWORD = process.env.API_PASSWORD;
const MIN_ACTIVITY_ID_SCAN = parseInt(process.env.MIN_ACTIVITY_ID_SCAN || '0', 10);
const MAX_ACTIVITY_ID_SCAN = parseInt(process.env.MAX_ACTIVITY_ID_SCAN || '9999', 10);
const CONCURRENT_API_CALLS = parseInt(process.env.CONCURRENT_API_CALLS || '10', 10);
const CLUB_UPDATE_INTERVAL_MINS = parseInt(process.env.CLUB_UPDATE_INTERVAL_MINS || '60', 10);
const STAFF_UPDATE_INTERVAL_MINS = parseInt(process.env.STAFF_UPDATE_INTERVAL_MINS || '60', 10);
const FIXED_STAFF_ACTIVITY_ID = process.env.FIXED_STAFF_ACTIVITY_ID;
const S3_IMAGE_PREFIX = (process.env.S3_PUBLIC_URL_PREFIX || 'files').replace(/\/$/, '');

// Limit concurrent API calls
const limit = pLimit(CONCURRENT_API_CALLS);

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
        
        const activityJson = await fetchActivityData(activityId, USERNAME, PASSWORD);
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
 * Initialize the club cache by scanning through all activity IDs
 */
export async function initializeClubCache(): Promise<void> {
    logger.info(`Starting initial club cache population from ID ${MIN_ACTIVITY_ID_SCAN} to ${MAX_ACTIVITY_ID_SCAN}`);
    const promises: Promise<void>[] = [];
    
    for (let i = MIN_ACTIVITY_ID_SCAN; i <= MAX_ACTIVITY_ID_SCAN; i++) {
        const activityId = String(i);
        promises.push(limit(async () => {
            const cachedData = await getActivityData(activityId);
            if (!cachedData || 
                Object.keys(cachedData).length === 0 || 
                !cachedData.lastCheck || 
                cachedData.error) {
                logger.debug(`Initializing cache for activity ID: ${activityId}`);
                await processAndCacheActivity(activityId);
            }
        }));
    }
    
    await Promise.all(promises);
    logger.info('Initial club cache population finished.');
}

/**
 * Update stale clubs in the cache
 */
export async function updateStaleClubs(): Promise<void> {
    logger.info('Starting stale club check...');
    const now = Date.now();
    const updateIntervalMs = CLUB_UPDATE_INTERVAL_MINS * 60 * 1000;
    const promises: Promise<void>[] = [];
    const activityKeys = await getAllActivityKeys();

    for (const key of activityKeys) {
        const activityId = key.substring(ACTIVITY_KEY_PREFIX.length);
        promises.push(limit(async () => {
            const cachedData = await getActivityData(activityId);
            
            if (cachedData && cachedData.lastCheck) {
                const lastCheckTime = new Date(cachedData.lastCheck).getTime();
                if ((now - lastCheckTime) > updateIntervalMs || cachedData.error) {
                    logger.info(`Activity ${activityId} is stale or had error. Updating...`);
                    await processAndCacheActivity(activityId);
                }
            } else if (!cachedData || Object.keys(cachedData).length === 0) {
                logger.info(`Activity ${activityId} not in cache or is empty object. Attempting to fetch...`);
                await processAndCacheActivity(activityId);
            }
        }));
    }
    
    await cleanupOrphanedS3Images();
    await Promise.all(promises);
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
