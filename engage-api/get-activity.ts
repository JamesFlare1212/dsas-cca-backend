// engage-api/get-activity.ts
import axios from 'axios';
import { readFile,writeFile,unlink } from 'fs/promises';
import { resolve } from 'path';
import { logger } from '../utils/logger';

// Define interfaces for our data structures
interface ActivityResponse {
  d: string;
  isError ? : boolean;
  [key: string]: any;
}

// Custom Error for Authentication
class AuthenticationError extends Error {
  status: number;

  constructor(message: string = "Authentication failed, cookie may be invalid.", status ? : number) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status || 0;
  }
}

// In Bun, we can use import.meta.dir instead of the Node.js __dirname approach
const COOKIE_FILE_PATH = resolve(import.meta.dir, 'nkcs-engage.cookie.txt');
let _inMemoryCookie: string | null = null;

// Cookie Cache Helper Functions
async function loadCachedCookie(): Promise < string | null > {
  if (_inMemoryCookie) {
    logger.debug("Using in-memory cached cookie.");
    return _inMemoryCookie;
  }
  try {
    const cookieFromFile = await readFile(COOKIE_FILE_PATH, 'utf8');
    if (cookieFromFile) {
      _inMemoryCookie = cookieFromFile;
      logger.debug("Loaded cookie from file cache.");
      return _inMemoryCookie;
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.debug("Cookie cache file not found. No cached cookie loaded.");
    } else {
      logger.warn("Error loading cookie from file:", err.message);
    }
  }
  return null;
}

async function saveCookieToCache(cookieString: string): Promise < void > {
  if (!cookieString) {
    logger.warn("Attempted to save an empty or null cookie. Aborting save.");
    return;
  }
  _inMemoryCookie = cookieString;
  try {
    await writeFile(COOKIE_FILE_PATH, cookieString, 'utf8');
    logger.debug("Cookie saved to file cache.");
  } catch (err: any) {
    logger.error("Error saving cookie to file:", err.message);
  }
}

async function clearCookieCache(): Promise < void > {
  _inMemoryCookie = null;
  try {
    await unlink(COOKIE_FILE_PATH);
    logger.debug("Cookie cache file deleted.");
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.error("Error deleting cookie file:", err.message);
    } else {
      logger.debug("Cookie cache file did not exist, no need to delete.");
    }
  }
}

async function testCookieValidity(cookieString: string): Promise < boolean > {
  if (!cookieString) return false;
  logger.debug("Testing cookie validity...");

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
      await axios.post(url, payload, {
        headers,
        timeout: 20000
      });

      logger.debug("Cookie test successful (API responded 2xx). Cookie is valid.");
      return true;
    } catch (error: any) {
      logger.warn(`Cookie validity test failed (attempt ${attempt}/${MAX_RETRIES}).`);
      if (error.response) {
        logger.warn(`Cookie test API response status: ${error.response.status}.`);
      } else {
        logger.warn(`Network/other error: ${error.message}`);
      }

      if (attempt >= MAX_RETRIES) {
        logger.warn("Max retries reached. Cookie is likely invalid or expired.");
        return false;
      }
    }
  }
  return false;
}

// Core API Interaction Functions
async function getSessionId(): Promise < string | null > {
  const url = 'https://engage.nkcswx.cn/Login.aspx';
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Bun DSAS-CCA get-activity Module)'
      }
    });
    const setCookieHeader = response.headers['set-cookie'];
    if (setCookieHeader && setCookieHeader.length > 0) {
      const sessionIdCookie = setCookieHeader.find(cookie => cookie.trim().startsWith('ASP.NET_SessionId='));
      if (sessionIdCookie) {
        logger.debug('ASP.NET_SessionId created');
        return sessionIdCookie.split(';')[0] || null; // Ensure a fallback to `null` if splitting fails
      }
      return null; // Explicitly return `null` if no cookie is found
    }
    logger.error("No ASP.NET_SessionId cookie found in Set-Cookie header.");
    return null;
  } catch (error: any) {
    logger.error(`Error in getSessionId: ${error.response ? `${error.response.status} - ${error.response.statusText}` : error.message}`);
    throw error;
  }
}

async function getMSAUTH(sessionId: string, userName: string, userPwd: string, templateFilePath: string): Promise < string | null > {
  const url = 'https://engage.nkcswx.cn/Login.aspx';
  try {
    let templateData = await readFile(templateFilePath, 'utf8');
    const postData = templateData
      .replace('{{USERNAME}}', userName)
      .replace('{{PASSWORD}}', userPwd);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionId,
      'User-Agent': 'Mozilla/5.0 (Bun DSAS-CCA get-activity Module)',
      'Referer': 'https://engage.nkcswx.cn/Login.aspx'
    };
    logger.debug('Getting .ASPXFORMSAUTH');
    const response = await axios.post(url, postData, {
      headers,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });
    const setCookieHeader = response.headers['set-cookie'];
    let formsAuthCookieValue = null;
    if (setCookieHeader && setCookieHeader.length > 0) {
      const aspxAuthCookies = setCookieHeader.filter(cookie => cookie.trim().startsWith('.ASPXFORMSAUTH='));
      if (aspxAuthCookies.length > 0) {
        for (let i = aspxAuthCookies.length - 1; i >= 0; i--) {
          const cookieCandidateParts = aspxAuthCookies[i].split(';');
          if (cookieCandidateParts.length > 0 && cookieCandidateParts[0] !== undefined) { // Explicit check
            const firstPart = cookieCandidateParts[0].trim();
            if (firstPart.length > '.ASPXFORMSAUTH='.length && firstPart.substring('.ASPXFORMSAUTH='.length).length > 0) {
              formsAuthCookieValue = firstPart;
              break;
            }
          }
        }
      }
    }
    if (formsAuthCookieValue) {
      logger.debug('.ASPXFORMSAUTH cookie obtained.');
      return formsAuthCookieValue;
    } else {
      logger.error("No valid .ASPXFORMSAUTH cookie found. Headers:", setCookieHeader || "none");
      return null;
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') logger.error(`Error: Template file '${templateFilePath}' not found.`);
    else logger.error(`Error in getMSAUTH: ${error.message}`);
    throw error;
  }
}

async function getCompleteCookies(userName: string, userPwd: string, templateFilePath: string): Promise < string > {
  logger.debug('Attempting to get complete cookie string (login process).');
  const sessionId = await getSessionId();
  if (!sessionId) throw new Error("Login failed: Could not obtain ASP.NET_SessionId.");

  const msAuth = await getMSAUTH(sessionId, userName, userPwd, templateFilePath);
  if (!msAuth) throw new Error("Login failed: Could not obtain .ASPXFORMSAUTH cookie.");

  return `${sessionId}; ${msAuth}`;
}

async function getActivityDetailsRaw(
  activityId: string,
  cookies: string,
  maxRetries: number = 3,
  timeoutMilliseconds: number = 20000
): Promise < string | null > {
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
 * @param templateFileName - Name of the login template file.
 * @param forceLogin - If true, bypasses cached cookie and forces a new login.
 * @returns The parsed JSON object of activity details, or null on failure.
 */
export async function fetchActivityData(
  activityId: string,
  userName: string,
  userPwd: string,
  templateFileName: string = "login_template.txt",
  forceLogin: boolean = false
): Promise < any | null > {
  let currentCookie = forceLogin ? null : await loadCachedCookie();

  if (forceLogin && currentCookie) {
    await clearCookieCache();
    currentCookie = null;
  }

  if (currentCookie) {
    const isValid = await testCookieValidity(currentCookie);
    if (!isValid) {
      logger.info("Cached cookie test failed or cookie expired. Clearing cache.");
      await clearCookieCache();
      currentCookie = null;
    } else {
      logger.info("Using valid cached cookie.");
    }
  }

  if (!currentCookie) {
    logger.info(forceLogin ? "Forcing new login." : "No valid cached cookie found or cache bypassed. Attempting login...");
    try {
      currentCookie = await getCompleteCookies(userName, userPwd, resolve(import.meta.dir, templateFileName));
      await saveCookieToCache(currentCookie);
    } catch (loginError) {
      logger.error(`Login process failed: ${(loginError as Error).message}`);
      return null;
    }
  }

  if (!currentCookie) {
    logger.error("Critical: No cookie available after login attempt. Cannot fetch activity data.");
    return null;
  }

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
      logger.warn(`Initial fetch failed with AuthenticationError (Status: ${error.status}). Cookie was likely invalid. Attempting re-login and one retry.`);
      await clearCookieCache();

      try {
        logger.info("Attempting re-login due to authentication failure...");
        currentCookie = await getCompleteCookies(userName, userPwd, resolve(import.meta.dir, templateFileName));
        await saveCookieToCache(currentCookie);

        logger.info("Re-login successful. Retrying request for activity details once...");
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

// Optionally
//export { clearCookieCache,testCookieValidity };