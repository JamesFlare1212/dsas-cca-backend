// index.ts
import express, { Request, Response } from 'express';
import { config } from 'dotenv';
import cors from 'cors';
import { fetchActivityData } from './engage-api/get-activity';
import { structActivityData } from './engage-api/struct-activity';
import { structStaffData } from './engage-api/struct-staff';
import {
  getActivityData,
  setActivityData,
  getStaffData,
  setStaffData,
  getRedisClient,
  getAllActivityKeys,
  ACTIVITY_KEY_PREFIX,
  closeRedisConnection
} from './services/redis-service';
import { uploadImageFromBase64 } from './services/s3-service';
import { extractBase64Image } from './utils/image-processor';
import {
  initializeClubCache,
  updateStaleClubs,
  initializeOrUpdateStaffCache,
  cleanupOrphanedS3Images
} from './services/cache-manager';
import { logger } from './utils/logger';
import type { ActivityData } from './models/activity'

// Define interfaces for our data structures
interface StaffData {
  lastCheck?: string;
  cache?: string;
  [key: string]: any;
}

interface ImageInfo {
  base64Content: string;
  format: string;
}

interface ProcessedActivityResult {
  data: ActivityData;
  status: number;
}

config();

const USERNAME = process.env.API_USERNAME;
const PASSWORD = process.env.API_PASSWORD;
const PORT = process.env.PORT || 3000;
const FIXED_STAFF_ACTIVITY_ID = process.env.FIXED_STAFF_ACTIVITY_ID;
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '*';
const CLUB_CHECK_INTERVAL_SECONDS = parseInt(process.env.CLUB_CHECK_INTERVAL_SECONDS || '300', 10);
const STAFF_CHECK_INTERVAL_SECONDS = parseInt(process.env.STAFF_CHECK_INTERVAL_SECONDS || '300', 10);

// CORS configuration
type CorsOptions = {
  origin: string | string[] | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void);
};

let corsOptions: CorsOptions;
if (allowedOriginsEnv === '*') {
  corsOptions = { origin: '*' };
} else {
  const originsArray = allowedOriginsEnv.split(',').map(origin => origin.trim());
  corsOptions = {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin || originsArray.indexOf(origin) !== -1 || originsArray.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  };
}

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

// Helper function to process activity data (fetch, struct, S3, cache) for API calls
async function fetchProcessAndStoreActivity(activityId: string): Promise<ProcessedActivityResult> {
  logger.info(`API call: Cache miss or forced fetch for activity ID: ${activityId}.`);
  const activityJson = await fetchActivityData(activityId, USERNAME as string, PASSWORD as string);

  if (!activityJson) {
    logger.warn(`API call: No data from engage API for activity ${activityId}. Caching as empty.`);
    const emptyData: ActivityData = { lastCheck: new Date().toISOString(), source: 'api-fetch-empty' };
    await setActivityData(activityId, emptyData);
    return { data: emptyData, status: 404 };
  }

  let structuredActivity = await structActivityData(activityJson);
  if (structuredActivity && structuredActivity.photo && 
    typeof structuredActivity.photo === 'string' && 
    structuredActivity.photo.startsWith('data:image')) {
    
    const imageInfo = extractBase64Image(structuredActivity.photo) as ImageInfo | null;
    if (imageInfo) {
      const s3Url = await uploadImageFromBase64(imageInfo.base64Content, imageInfo.format, activityId);
      if (s3Url) {
        structuredActivity.photo = s3Url;
      } else {
        logger.warn(`API call: Failed S3 upload for activity ${activityId}. Photo may be base64 or null.`);
      }
    }
  }
  structuredActivity.lastCheck = new Date().toISOString();
  await setActivityData(activityId, structuredActivity);
  return { data: structuredActivity, status: 200 };
}

// --- API Endpoints ---
app.get('/', (_req: Request, res: Response) => {
  res.send('Welcome to the DSAS CCA API!<br/>\
    GET /v1/activity/list<br/>\
    GET /v1/activity/list?category={categoryName}<br/>\
    GET /v1/activity/list?academicYear={YYYY/YYYY}<br/>\
    GET /v1/activity/list?grade={1-12}<br/>\
    GET /v1/activity/list?isStudentLed={true|false}<br/>\
    GET /v1/activity/category<br/>\
    GET /v1/activity/academicYear<br/>\
    GET /v1/activity/:activityId<br/>\
    GET /v1/staffs');
});

// Activity list endpoint with filtering capabilities
app.get('/v1/activity/list', async (req: Request, res: Response) => {
  try {
    const category       = req.query.category as string | undefined;
    const academicYear   = req.query.academicYear as string | undefined;
    const grade          = req.query.grade as string | undefined;
    const isStudentLedQ  = req.query.isStudentLed as string | undefined;

    /* ---------- validate query params ---------- */
    // academicYear (YYYY/YYYY)
    if (academicYear !== undefined) {
      const academicYearRegex = /^\d{4}\/\d{4}$/;
      if (!academicYearRegex.test(academicYear)) {
        return res.status(400).json({ error: 'Invalid academicYear format. Expected format: YYYY/YYYY' });
      }
    }
    // grade (1 – 12)
    let validGrade: number | null = null;
    if (grade !== undefined) {
      const parsedGrade = parseInt(grade, 10);
      if (isNaN(parsedGrade) || parsedGrade < 1 || parsedGrade > 12) {
        return res.status(400).json({ error: 'Invalid grade parameter. Must be a number between 1 and 12.' });
      }
      validGrade = parsedGrade;
    }
    // isStudentLed ("true" | "false")
    let isStudentLedFilter: boolean | null = null;
    if (isStudentLedQ !== undefined) {
      if (isStudentLedQ === 'true')  isStudentLedFilter = true;
      else if (isStudentLedQ === 'false') isStudentLedFilter = false;
      else {
        return res.status(400).json({ error: 'Invalid isStudentLed parameter. Must be "true" or "false".' });
      }
    }
    logger.info(`Request /v1/activity/list filters: ${JSON.stringify({ category, academicYear, grade: validGrade, isStudentLed: isStudentLedFilter })}`);

    /* ---------- fetch & cache ---------- */
    const activityKeys = await getAllActivityKeys();
    const clubList: Record<string, { name: string; photo: string }> = {};

    if (!activityKeys || activityKeys.length === 0) {
      logger.info('No activity keys found in Redis for list.');
      return res.json({});
    }

    const allActivities = await Promise.all(
      activityKeys.map(async k => getActivityData(k.substring(ACTIVITY_KEY_PREFIX.length)))
    );

    /* ---------- gather available filter values for validation ---------- */
    const availableCategories    = new Set<string>();
    const availableAcademicYears = new Set<string>();

    allActivities.forEach(a => {
      if (a && !a.error && a.source !== 'api-fetch-empty') {
        if (a.category)      availableCategories.add(a.category);
        if (a.academicYear)  availableAcademicYears.add(a.academicYear);
      }
    });

    if (category && !availableCategories.has(category)) {
      return res.status(400).json({ error: 'Invalid category parameter. Category not found.', availableCategories: [...availableCategories] });
    }
    if (academicYear && !availableAcademicYears.has(academicYear)) {
      return res.status(400).json({ error: 'Invalid academicYear parameter. Academic year not found.', availableAcademicYears: [...availableAcademicYears] });
    }

    /* ---------- apply filters ---------- */
    allActivities.forEach(a => {
      if (
        a &&
        a.id &&
        a.name &&
        !a.error &&
        a.source !== 'api-fetch-empty'
      ) {
        // category
        if (category && a.category !== category) return;
        // academicYear
        if (academicYear && a.academicYear !== academicYear) return;
        // grade
        if (validGrade !== null) {
          if (!a.grades || a.grades.min == null || a.grades.max == null) return;
          const minG = parseInt(a.grades.min, 10);
          const maxG = parseInt(a.grades.max, 10);
          if (isNaN(minG) || isNaN(maxG) || validGrade < minG || validGrade > maxG) return;
        }
        // isStudentLed
        if (isStudentLedFilter !== null) {
          // Treat missing value as false
          const led = a.isStudentLed ?? false;
          if (led !== isStudentLedFilter) return;
        }
        clubList[a.id] = { name: a.name, photo: a.photo || '' };
      }
    });
    logger.info(`Returning ${Object.keys(clubList).length} clubs after filtering.`);
    res.json(clubList);
  } catch (err) {
    logger.error('Error in /v1/activity/list endpoint:', err);
    res.status(500).json({ error: 'An internal server error occurred while generating activity list.' });
  }
});

// Category endpoint
app.get('/v1/activity/category', async (_req: Request, res: Response) => {
  try {
    logger.info('Request received for /v1/activity/category');
    const activityKeys = await getAllActivityKeys();
    const categoryMap: Record<string, number> = {};

    if (!activityKeys || activityKeys.length === 0) {
      logger.info('No activity keys found in Redis for categories.');
      return res.json({});
    }
    // Fetch all activity data in parallel
    const allActivityDataPromises = activityKeys.map(async (key) => {
      const activityId = key.substring(ACTIVITY_KEY_PREFIX.length);
      return getActivityData(activityId);
    });

    const allActivities = await Promise.all(allActivityDataPromises);

    allActivities.forEach((activityData: ActivityData | null) => {
      if (activityData && 
        activityData.category && 
        !activityData.error && 
        activityData.source !== 'api-fetch-empty') {
        if (categoryMap[activityData.category]) {
          categoryMap[activityData.category] = (categoryMap[activityData.category] ?? 0) + 1;
        } else {
          categoryMap[activityData.category] = 1;
        }
      }
    });

    logger.info(`Returning list of ${Object.keys(categoryMap).length} categories.`);
    res.json(categoryMap);
  } catch (error) {
    logger.error('Error in /v1/activity/category endpoint:', error);
    res.status(500).json({ error: 'An internal server error occurred while generating category list.' });
  }
});

// Academic Year endpoint
app.get('/v1/activity/academicYear', async (_req: Request, res: Response) => {
  try {
    logger.info('Request received for /v1/activity/academicYear');
    const activityKeys = await getAllActivityKeys();
    const academicYearMap: Record<string, number> = {};

    if (!activityKeys?.length) {
      logger.info('No activity keys found in Redis for academic years.');
      return res.json({});
    }
    // 1. Fetch all activity data in parallel
    const allActivities = await Promise.all(
      activityKeys.map(async (key) => {
        const activityId = key.substring(ACTIVITY_KEY_PREFIX.length);
        return getActivityData(activityId);
      })
    );
    // 2. Count activities per academic year
    allActivities.forEach((activityData: ActivityData | null) => {
      if (
        activityData &&
        activityData.academicYear &&
        !activityData.error &&
        activityData.source !== 'api-fetch-empty'
      ) {
        academicYearMap[activityData.academicYear] =
          (academicYearMap[activityData.academicYear] ?? 0) + 1;
      }
    });
    // 3. Sort the years in descending order (based on the start year)
    const sortedAcademicYearMap: Record<string, number> = Object.fromEntries(
      Object.entries(academicYearMap).sort(([yearA], [yearB]) => {
        const startA = parseInt(yearA.split('/')[0], 10);
        const startB = parseInt(yearB.split('/')[0], 10);
        return startB - startA;
      })
    );
    logger.info(
      `Returning list of ${Object.keys(sortedAcademicYearMap).length} academic years.`
    );
    res.json(sortedAcademicYearMap);
  } catch (error) {
    logger.error('Error in /v1/activity/academicYear endpoint:', error);
    res.status(500).json({
      error:
        'An internal server error occurred while generating academic year list.',
    });
  }
});

// Single activity endpoint
app.get('/v1/activity/:activityId', async (req: Request, res: Response) => {
  const { activityId } = req.params;

  if (!/^\d{1,4}$/.test(activityId)) {
    return res.status(400).json({ error: 'Invalid Activity ID format.' });
  }
  if (!USERNAME || !PASSWORD) {
    logger.error('API username or password not configured.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    let cachedActivity = await getActivityData(activityId);
    const isValidCacheEntry = cachedActivity &&
                 !cachedActivity.error &&
                 Object.keys(cachedActivity).filter(k => k !== 'lastCheck' && k !== 'cache' && k !== 'source').length > 0;

    if (isValidCacheEntry) {
      logger.info(`Cache HIT for activity ID: ${activityId}`);
      cachedActivity.cache = "HIT";
      return res.json(cachedActivity);
    }
    
    logger.info(`Cache MISS or stale/empty for activity ID: ${activityId}. Fetching...`);
    const { data: liveActivity, status } = await fetchProcessAndStoreActivity(activityId);

    liveActivity.cache = "MISS";
    if (status === 404 && Object.keys(liveActivity).filter(k => k !== 'lastCheck' && k !== 'cache' && k !== 'source').length === 0) {
      return res.status(404).json({ error: `Activity ${activityId} not found.`, ...liveActivity });
    }
    res.status(status).json(liveActivity);
  } catch (error) {
    logger.error(`Error in /v1/activity/${activityId} endpoint:`, error);
    res.status(500).json({ error: 'An internal server error occurred.', cache: "ERROR" });
  }
});

// Staff endpoint
app.get('/v1/staffs', async (_req: Request, res: Response) => {
  if (!USERNAME || !PASSWORD) {
    logger.error('API username or password not configured.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    let cachedStaffs = await getStaffData();
    if (cachedStaffs && cachedStaffs.lastCheck) {
      logger.info('Cache HIT for staffs.');
      cachedStaffs.cache = "HIT";
      return res.json(cachedStaffs);
    }

    logger.info('Cache MISS for staffs. Fetching from source.');
    const activityJson = await fetchActivityData(FIXED_STAFF_ACTIVITY_ID as string, USERNAME, PASSWORD);
    if (activityJson) {
      const staffMap = await structStaffData(activityJson);
      let staffObject: StaffData = Object.fromEntries(staffMap);
      staffObject.lastCheck = new Date().toISOString();
      staffObject.cache = "MISS";
      await setStaffData(staffObject);
      res.json(staffObject);
    } else {
      logger.error(`Could not retrieve base data for staffs (activity ID ${FIXED_STAFF_ACTIVITY_ID}).`);
      res.status(404).json({ error: `Could not retrieve base data for staff details.`, cache: "MISS" });
    }
  } catch (error) {
    logger.error('Error in /v1/staffs endpoint:', error);
    res.status(500).json({ error: 'An internal server error occurred while fetching staff data.', cache: "ERROR" });
  }
});

// Function to perform background initialization and periodic tasks
async function performBackgroundTasks(): Promise<void> {
  logger.info('Starting background initialization tasks...');
  try {
    await initializeClubCache();
    await initializeOrUpdateStaffCache(true);
    await cleanupOrphanedS3Images();
    
    logger.info(`Setting up periodic club cache updates every ${CLUB_CHECK_INTERVAL_SECONDS} seconds.`);
    setInterval(updateStaleClubs, CLUB_CHECK_INTERVAL_SECONDS * 1000);

    logger.info(`Setting up periodic staff cache updates every ${STAFF_CHECK_INTERVAL_SECONDS} seconds.`);
    setInterval(() => initializeOrUpdateStaffCache(false), STAFF_CHECK_INTERVAL_SECONDS * 1000);
    
    logger.info('Background initialization and periodic task setup complete.');
  } catch (error) {
    logger.error('Error during background initialization tasks:', error);
  }
}

// Start Server and Background Tasks
async function startServer(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    logger.error('Redis client is not initialized. Server cannot start. Check REDIS_URL.');
    process.exit(1);
  }

  try {
    // Test Redis connection with a simple command
    await redis.set('connection-test', 'ok');
    await redis.del('connection-test');
    logger.info('Redis connection confirmed.');

    app.listen(PORT, () => {
      logger.info(`Server is running on http://localhost:${PORT}`);
      logger.info(`Allowed CORS origins: ${allowedOriginsEnv === '*' ? 'All (*)' : allowedOriginsEnv}`);
      if (!USERNAME || !PASSWORD) {
        logger.warn('Warning: API_USERNAME or API_PASSWORD is not set.');
      }
    });

    performBackgroundTasks().catch(error => {
      logger.error('Unhandled error in performBackgroundTasks:', error);
    });

  } catch (err) {
    logger.error('Failed to connect to Redis or critical error during server startup. Server not started.', err);
    process.exit(1);
  }
}

// Bun's process event handlers
process.on('SIGINT', async () => {
  logger.info('Server shutting down (SIGINT)...');
  await closeRedisConnection();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Server shutting down (SIGTERM)...');
  await closeRedisConnection();
  process.exit(0);
});

// Start the server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app };