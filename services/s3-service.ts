// services/s3-service.ts
import { S3Client } from "bun";
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
import sharp from 'sharp';
import { logger } from '../utils/logger';
import { decodeBase64Image } from '../utils/image-processor';

config();

// S3 configuration
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const PUBLIC_URL_FILE_PREFIX = (process.env.S3_PUBLIC_URL_PREFIX || 'files').replace(/\/$/, '');

// Initialize S3 client
let s3Client: S3Client | null = null;

if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && BUCKET_NAME) {
    try {
        s3Client = new S3Client({
            accessKeyId: S3_ACCESS_KEY_ID,
            secretAccessKey: S3_SECRET_ACCESS_KEY,
            bucket: BUCKET_NAME,
            endpoint: S3_ENDPOINT,
            region: S3_REGION
        });
        logger.info('S3 client initialized successfully.');
    } catch (error) {
        logger.error('Failed to initialize S3 client:', error);
    }
} else {
    logger.warn('S3 client configuration is incomplete. S3 operations will be disabled.');
}

/**
 * Uploads an image from a base64 string to S3, converting it to AVIF format.
 * @param base64Data - The base64 content (without the data URI prefix)
 * @param originalFormat - The image format (e.g., 'png', 'jpeg')
 * @param activityId - The activity ID, used for naming
 * @returns The public URL of the uploaded image or null on error
 */
export async function uploadImageFromBase64(
    base64Data: string, 
    originalFormat: string, 
    activityId: string
): Promise<string | null> {
    if (!s3Client) {
        logger.warn('S3 client not configured. Cannot upload image.');
        return null;
    }
    if (!base64Data || !originalFormat || !activityId) {
        logger.error('S3 Upload: Missing base64Data, originalFormat, or activityId');
        return null;
    }

    try {
        // First decode the base64 image
        const imageBuffer = decodeBase64Image(base64Data);
        
        // Convert to AVIF format with quality 80 using Sharp
        const avifBuffer = await sharp(imageBuffer)
            .avif({ 
                quality: 80,
                // You can add more AVIF options here if needed
                // lossless: false,
                // effort: 4,
            })
            .toBuffer();
        
        // Use .avif extension for the object key
        const objectKey = `${PUBLIC_URL_FILE_PREFIX}/activity-${activityId}-${uuidv4()}.avif`;
        
        // Using Bun's S3Client file API
        const s3File = s3Client.file(objectKey);
        
        await s3File.write(avifBuffer, {
            type: 'image/avif',
            acl: 'public-read'
        });
        
        const publicUrl = constructS3Url(objectKey);
        logger.info(`Image uploaded to S3 as AVIF: ${publicUrl}`);
        return publicUrl;
    } catch (error) {
        logger.error(`S3 Upload Error for activity ${activityId}:`, error);
        return null;
    }
}

/**
 * Lists all objects in the S3 bucket under a specific prefix.
 * @param prefix - The prefix to filter objects by
 * @returns A list of object keys
 */
export async function listS3Objects(prefix: string): Promise<string[]> {
    if (!s3Client) {
        logger.warn('S3 client not configured. Cannot list objects.');
        return [];
    }
    
    logger.debug(`Listing objects from S3 with prefix: "${prefix}"`);
    
    try {
        const objectKeys: string[] = [];
        let isTruncated = true;
        let startAfter: string | undefined;
        
        while (isTruncated) {
            // Use Bun's list method with pagination
            const result = await s3Client.list({
                prefix,
                startAfter,
                maxKeys: 1000
            });
            
            if (result.contents) {
                // Add keys to our array, filtering out "directories"
                result.contents.forEach(item => {
                    if (item.key && !item.key.endsWith('/')) {
                        objectKeys.push(item.key);
                    }
                });
                
                // Get the last key for pagination
                if (result.contents?.length > 0) {
                    startAfter = result.contents[result.contents.length - 1]?.key;
                }
            }
            
            isTruncated = result.isTruncated || false;
            
            // Safety check to prevent infinite loops
            if (result.contents?.length === 0) {
                break;
            }
        }
        
        logger.info(`Listed ${objectKeys.length} object keys from S3 with prefix "${prefix}"`);
        return objectKeys;
    } catch (error) {
        logger.error(`S3 ListObjects Error with prefix "${prefix}":`, error);
        return [];
    }
}

/**
 * Deletes multiple objects from S3.
 * @param objectKeysArray - Array of object keys to delete
 * @returns True if successful or partially successful, false on major error
 */
export async function deleteS3Objects(objectKeysArray: string[]): Promise<boolean> {
    if (!s3Client) {
        logger.warn('S3 client not configured. Cannot delete objects.');
        return false;
    }
    if (!objectKeysArray || objectKeysArray.length === 0) {
        logger.info('No objects to delete from S3.');
        return true;
    }

    try {
        // With Bun's S3Client, we need to delete objects one by one
        // Process in batches of 100 for better performance
        const BATCH_SIZE = 100;
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < objectKeysArray.length; i += BATCH_SIZE) {
            const batch = objectKeysArray.slice(i, i + BATCH_SIZE);
            
            // Process batch in parallel
            const results = await Promise.allSettled(
                batch.map(key => s3Client!.delete(key))
            );
            
            // Count successes and failures
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    successCount++;
                } else {
                    errorCount++;
                    logger.error(`Failed to delete object: ${result.reason}`);
                }
            }
        }
        
        logger.info(`Deleted ${successCount} objects from S3. Failed: ${errorCount}`);
        return errorCount === 0; // True if all succeeded
    } catch (error) {
        logger.error('S3 DeleteObjects Error:', error);
        return false;
    }
}

/**
 * Constructs the public S3 URL for an object key.
 * @param objectKey - The key of the object in S3
 * @returns The full public URL
 */
export function constructS3Url(objectKey: string): string {
    if (!S3_ENDPOINT || !BUCKET_NAME) {
        return '';
    }
    
    // Ensure S3_ENDPOINT does not end with a slash
    const s3Base = S3_ENDPOINT.replace(/\/$/, '');
    // Ensure BUCKET_NAME does not start or end with a slash
    const bucket = BUCKET_NAME.replace(/^\//, '').replace(/\/$/, '');
    // Ensure objectKey does not start with a slash
    const key = objectKey.replace(/^\//, '');
    
    return `${s3Base}/${bucket}/${key}`;
}