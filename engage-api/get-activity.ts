// engage-api/get-activity.ts
import axios from 'axios';
import { logger } from '../utils/logger';
import {
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
 * Only returns data on HTTP 200. Returns null on any error (5xx, timeout, etc.)
 */
async function getActivityDetailsRaw(
  activityId: string,
  cookies: string,
  maxRetries: number = 3,
  timeoutMilliseconds: number = 10000
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
      logger.debug(`Attempt ${attempt + 1}/${maxRetries} for activity ${activityId} - Sending POST request to ${url}`);
      const response = await axios.post(url, payload, {
        headers,
        timeout: timeoutMilliseconds,
        responseType: 'text',
        // Add additional timeout safety
        maxRedirects: 5
      });
      
      // CRITICAL: Only accept HTTP 200. Reject all other status codes including 5xx
      if (response.status !== 200) {
        logger.error(`Non-200 status ${response.status} for activity ${activityId}. NOT updating cache to preserve local data.`);
        
        // IMPORTANT: Only 500 is cookie expiration. Other 5xx (502/503/504) are real server outages.
        // The backend returns 500 when cookie is expired but session not yet invalidated.
        // It takes several hours before it returns 401/403.
        // 502/503/504 are real server errors (bad gateway, service unavailable, gateway timeout)
        if (response.status === 500) {
          logger.warn(`Server error 500 - this is cookie expiration. Throwing AuthenticationError to trigger immediate re-login.`);
          throw new AuthenticationError(`Received 500 for activity ${activityId} - expired cookie`, 500);
        } else if (response.status >= 500 && response.status < 600) {
          // Real server outage (502/503/504), preserve cache and don't re-login
          logger.error(`Real server outage ${response.status} - preserving local cache, not re-login.`);
        }
        
        // Return null immediately on non-200 errors
        return null;
      }
      
      logger.debug(`Attempt ${attempt + 1}/${maxRetries} for activity ${activityId} - Received response status ${response.status}`);
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
      
      // Only treat 401 (Unauthorized) and 403 (Forbidden) as authentication errors
      // 404 (Not Found) is valid - activity doesn't exist
      // Other 4xx/5xx errors should not trigger re-authentication
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        logger.warn(`Authentication error (${error.response.status}) while fetching activity ${activityId}. Cookie may be invalid.`);
        throw new AuthenticationError(`Received ${error.response.status} for activity ${activityId}`, error.response.status);
      }
      logger.error(`Attempt ${attempt + 1}/${maxRetries} for activity ${activityId} failed: ${error.message}`);

      if (error.response) {
        logger.error(`Status: ${error.response.status}, Data (getActivityDetailsRaw): ${ String(error.response.data).slice(0,100)}...`);
        // IMPORTANT: Only 500 is cookie expiration. Other 5xx (502/503/504) are real server outages.
        // The backend returns 500 when cookie is expired but session not yet invalidated.
        // 502/503/504 are real server errors (bad gateway, service unavailable, gateway timeout)
        if (error.response.status === 500) {
          logger.warn(`Server error 500 - this is cookie expiration. Throwing AuthenticationError to trigger immediate re-login.`);
          throw new AuthenticationError(`Received 500 for activity ${activityId} - expired cookie`, 500);
        } else if (error.response.status >= 500 && error.response.status < 600) {
          // Real server outage (502/503/504), preserve cache and don't re-login
          logger.error(`Real server outage ${error.response.status} - preserving local cache, not re-login.`);
        }
      }
      if (attempt === maxRetries - 1) {
        logger.error(`All ${maxRetries} retries failed for activity ${activityId}.`);
        // Don't throw on network/timeout errors, just return null to preserve cache
        return null;
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
  forceLogin: boolean = false,
): Promise<any | null> {
  let currentCookie = forceLogin ? null : await getCachedCookieString();

  if (forceLogin && currentCookie) {
    logger.info('Forcing new login. Clearing cached cookie.');
    await clearCookieCache();
    currentCookie = null;
  }

  // Optimization: Skip pre-validation, directly request data
  // Only validate/re-login when we get 4xx error OR after 5xx (backend may be in degraded state)
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
    logger.debug(`Calling getActivityDetailsRaw for activity ${activityId}...`);
    const rawActivityDetailsString = await getActivityDetailsRaw(activityId, currentCookie);
    logger.debug(`getActivityDetailsRaw returned for activity ${activityId}`);
    if (rawActivityDetailsString) {
      const parsedOuter = JSON.parse(rawActivityDetailsString);
      return JSON.parse(parsedOuter.d);
    }
    // Check if this was a 5xx error and set flag for cookie validation
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
