// engage-api/get-activity.ts
import axios from 'axios';
import { logger } from '../utils/logger';
import {
  loginWithPlaywright,
  ensureSingleLogin,
  loadCachedCookies,
  saveCookiesToCache,
  clearCookieCache,
  getCachedCookieString
} from '../services/playwright-auth';

// Define interfaces for our data structures
interface ActivityResponse {
  d: string;
  isError?: boolean;
  [key: string]: any;
}

// Custom Error for Authentication
class AuthenticationError extends Error {
  status: number;

  constructor(message: string = "Authentication failed, cookie may be invalid.", status?: number) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status || 0;
  }
}

/**
 * Test cookie validity by calling API
 */
async function testCookieValidityWithApi(cookieString: string): Promise<boolean> {
  if (!cookieString) return false;
  logger.debug('Testing cookie validity via API...');

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      const url = 'https://engage.nkcswx.cn/Services/ActivitiesService.asmx/GetActivityDetails';
      const headers = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Bun DSAS-CCA get-activity Module)',
      };
      const payload = {
        "activityID": "3350"
      };

      logger.debug(`Attempt ${attempt}/${MAX_RETRIES}`);
      const response = await axios.post(url, payload, {
        headers,
        timeout: 20000
      });

      // Check for 4xx errors (auth failures)
      if (response.status >= 400 && response.status < 500) {
        logger.warn(`Cookie test returned ${response.status}, likely invalid`);
        return false;
      }

      logger.debug('Cookie test successful (API responded 2xx). Cookie is valid.');
      return true;
    } catch (error: any) {
      logger.warn(`Cookie validity test failed (attempt ${attempt}/${MAX_RETRIES}).`);
      if (error.response) {
        // 4xx = auth failure (immediate fail)
        if (error.response.status >= 400 && error.response.status < 500) {
          logger.warn(`Cookie test API response status: ${error.response.status} (auth error)`);
          return false;
        }
        // 5xx = server error (retry with delay)
        logger.warn(`Cookie test API response status: ${error.response.status} (server error, retrying...)`);
      } else {
        // No response (000 status, network error, timeout)
        logger.warn(`Network/timeout error: ${error.message} (retrying...)`);
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  
  logger.warn('Max retries reached. Cookie is likely invalid or expired.');
  return false;
}

/**
 * Get complete cookies using Playwright with single login lock
 */
async function getCompleteCookies(userName: string, userPwd: string): Promise<string> {
  logger.info('Attempting to get complete cookie string using Playwright login...');
  
  const cookies = await ensureSingleLogin(userName, userPwd);
  
  if (!cookies || cookies.length === 0) {
    throw new Error("Login failed: Could not obtain cookies.");
  }

  const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  return cookieString;
}

/**
 * Get activity details from API
 */
async function getActivityDetailsRaw(
  activityId: string,
  cookies: string,
  maxRetries: number = 3,
  timeoutMilliseconds: number = 20000
): Promise<string | null> {
  const url = 'https://engage.nkcswx.cn/Services/ActivitiesService.asmx/GetActivityDetails';
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cookie': cookies,
    'User-Agent': 'Mozilla/5.0 (Bun DSAS-CCA get-activity Module)',
    'X-Requested-With': 'XMLHttpRequest'
  };
  const payload = {
    "activityID": String(activityId)
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers,
        timeout: timeoutMilliseconds,
        responseType: 'text'
      });
      const outerData = JSON.parse(response.data);
      if (outerData && typeof outerData.d === 'string') {
        const innerData = JSON.parse(outerData.d);
        if (innerData.isError) {
          logger.warn(`API reported isError:true for activity ${activityId}.`);
          return null;
        }
        return response.data;
      } else {
        logger.error(`Unexpected API response structure for activity ${activityId}.`);
      }
    } catch (error: any) {
      // Check if response status is in 4xx range (400-499) to trigger auth error
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        logger.warn(`Authentication error (${error.response.status}) while fetching activity ${activityId}. Cookie may be invalid.`);
        throw new AuthenticationError(`Received ${error.response.status} for activity ${activityId}`, error.response.status);
      }
      logger.error(`Attempt ${attempt + 1}/${maxRetries} for activity ${activityId} failed: ${error.message}`);

      if (error.response) {
        logger.error(`Status: ${error.response.status}, Data (getActivityDetailsRaw): ${ String(error.response.data).slice(0,100)}...`);
      }
      if (attempt === maxRetries - 1) {
        logger.error(`All ${maxRetries} retries failed for activity ${activityId}.`);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * Main exported function. Handles cookie caching, validation, re-authentication, and fetches activity details.
 * @param activityId - The ID of the activity to fetch.
 * @param userName - URL-encoded username.
 * @param userPwd - URL-encoded password.
 * @param forceLogin - If true, bypasses cached cookie and forces a new login.
 * @returns The parsed JSON object of activity details, or null on failure.
 */
export async function fetchActivityData(
  activityId: string,
  userName: string,
  userPwd: string,
  forceLogin: boolean = false
): Promise<any | null> {
  let currentCookie = forceLogin ? null : await getCachedCookieString();

  if (forceLogin && currentCookie) {
    logger.info('Forcing new login. Clearing cached cookie.');
    await clearCookieCache();
    currentCookie = null;
  }

  // Optimization: Skip pre-validation, directly request data
  // Only validate/re-login when we get 4xx error (fail-fast strategy)
  if (!currentCookie) {
    logger.info('No cached cookie found. Attempting login...');
    try {
      currentCookie = await getCompleteCookies(userName, userPwd);
      
      const cookies = await loadCachedCookies();
      if (cookies) {
        await saveCookiesToCache(cookies);
      }
    } catch (loginError) {
      logger.error(`Login process failed: ${(loginError as Error).message}`);
      return null;
    }
  }

  if (!currentCookie) {
    logger.error('Critical: No cookie available after login attempt. Cannot fetch activity data.');
    return null;
  }

  logger.debug('Using cached cookie for API request.');
  
  try {
    const rawActivityDetailsString = await getActivityDetailsRaw(activityId, currentCookie);
    if (rawActivityDetailsString) {
      const parsedOuter = JSON.parse(rawActivityDetailsString);
      return JSON.parse(parsedOuter.d);
    }
    logger.warn(`No data returned from getActivityDetailsRaw for activity ${activityId}, but no authentication error was thrown.`);
    return null;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      // Cookie returned 4xx, now validate and re-login
      logger.warn(`API returned 4xx error (Status: ${error.status}). Cookie may be invalid. Attempting re-login and retry.`);
      await clearCookieCache();

      try {
        logger.info('Attempting re-login due to authentication failure...');
        currentCookie = await getCompleteCookies(userName, userPwd);
        
        const cookies = await loadCachedCookies();
        if (cookies) {
          await saveCookiesToCache(cookies);
        }

        logger.info('Re-login successful. Retrying request for activity details...');
        const rawActivityDetailsStringRetry = await getActivityDetailsRaw(activityId, currentCookie);
        if (rawActivityDetailsStringRetry) {
          const parsedOuterRetry = JSON.parse(rawActivityDetailsStringRetry);
          return JSON.parse(parsedOuterRetry.d);
        }
        logger.warn(`Still no details for activity ${activityId} after re-login and retry.`);
        return null;
      } catch (retryLoginOrFetchError) {
        logger.error(`Error during re-login or retry fetch for activity ${activityId}: ${(retryLoginOrFetchError as Error).message}`);
        return null;
      }
    } else {
      logger.error(`Failed to fetch activity data for ${activityId} due to non-authentication error: ${(error as Error).message}`);
      return null;
    }
  }
}
